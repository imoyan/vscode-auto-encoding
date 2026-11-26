import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import {
  protectedConversionSession,
  conversionSelectionBackupBytes,
  assessEncodingConversion,
  bytesEqual,
  looksLikeBinary,
} from "./conversionCore.js";
import { LAST_BACKUP_KEY, PROTECTED_BACKUP_KEY } from "./conversionBackup.js";
import { isDirty, hashBytes } from "./conversionResources.js";
import { ENCODINGS, encodingInfo } from "./rules.js";
import { readPinnedLocalFile } from "./pinnedLocalFile.js";
import { resolveRealDirectory, resolveRealPathWithin } from "./localPathSafety.js";
import {
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_SCAN_EXCLUDE,
  configuredFileSizeLimit,
  configuredScanFileLimit,
} from "./fileLimits.js";
import {
  classifyEncoding,
  classifyLineEndings,
  detectUtf16Signal,
  isAsciiCompatibleEncoding,
  type EncodingClassification,
  type LineEndingClassification,
} from "./scanCore.js";
import { compileGlob } from "./boundedGlob.js";
import { DirectoryScanCursor } from "./directoryScanCursor.js";
import { isManualEncodingOverride } from "./editorEncoding.js";
import { rankDecodedCandidates } from "./candidatePreview.js";

const AUTO_SOURCE = "auto";
function skipReasonLabel(
  reason: "cancelled" | "binary" | "unchanged" | "sourceMismatch" | "targetMismatch",
): string {
  switch (reason) {
    case "cancelled":
      return t("Cancelled");
    case "binary":
      return t("Excluded as binary");
    case "unchanged":
      return t("No conversion needed (unchanged)");
    case "sourceMismatch":
      return t("Source encoding mismatch or unsupported");
    case "targetMismatch":
      return t("Characters unrepresentable in target encoding or conversion failed");
  }
}

const vscodeCodec = {
  decode: async (bytes: Uint8Array, encoding: string): Promise<string> =>
    vscode.workspace.decode(bytes, { encoding }),
  encode: async (text: string, encoding: string): Promise<Uint8Array> =>
    vscode.workspace.encode(text, { encoding }),
};

export interface ConversionCandidate extends vscode.QuickPickItem {
  readonly needsConfirmation: boolean;
  readonly uri: vscode.Uri;
  readonly writeUri: vscode.Uri;
  readonly relativePath: string;
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
  readonly originalHash: string;
  readonly originalSize: number;
  readonly originalIdentity: string;
  readonly maxSize: number;
  readonly conversionRootRealPath: string;
  readonly workspaceRootRealPath: string;
}

export interface ConversionSelection {
  readonly selected: readonly ConversionCandidate[];
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
  readonly targetLineEnding?: "lf" | "crlf";
}

interface ConversionPreset extends vscode.QuickPickItem {
  readonly targetEncoding?: string;
  readonly targetLineEnding?: "lf" | "crlf";
}

interface FolderScanResult {
  readonly candidates: ConversionCandidate[];
  readonly excluded: vscode.QuickPickItem[];
  readonly ambiguousCount: number;
  readonly cancelled: boolean;
  readonly exceededLimit: boolean;
}

/** Handles candidate inspection and confirmation only. Pre-write re-validation and writing are handled by ConversionManager. */
export async function selectConversion(
  context: vscode.ExtensionContext,
  expectedEncodingFor: (uri: vscode.Uri) => string | undefined,
  configurationFor: (scope: vscode.ConfigurationScope) => vscode.WorkspaceConfiguration,
  suppliedUri?: vscode.Uri,
  suppliedTargetEncoding?: string,
  scope: "folder" | "file" = "folder",
): Promise<ConversionSelection | undefined> {
  const fileUri =
    scope === "file"
      ? (suppliedUri ??
        vscode.window.activeTextEditor?.document.uri ??
        (
          await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: t("Select a file to convert and save"),
          })
        )?.[0])
      : undefined;
  if (scope === "file") {
    if (!fileUri) return undefined;
    if (fileUri.scheme !== "file") {
      void vscode.window.showErrorMessage(t("Please select a saved local file."));
      return undefined;
    }
    if (isDirty(fileUri)) {
      void vscode.window.showWarningMessage(
        t("This file has unsaved changes. Please save the file before converting its encoding."),
      );
      return undefined;
    }
    try {
      if ((await vscode.workspace.fs.stat(fileUri)).type !== vscode.FileType.File) {
        throw new Error("not a regular file");
      }
    } catch {
      void vscode.window.showErrorMessage(
        t("Could not read the selected file. Please select a saved regular file."),
      );
      return undefined;
    }
  }
  const folderUri = fileUri
    ? vscode.Uri.file(path.dirname(fileUri.fsPath))
    : await pickFolder(suppliedUri);
  if (!folderUri) {
    return undefined;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(t("Please select a folder inside an open workspace."));
    return undefined;
  }
  if (folderUri.scheme !== "file" || workspaceFolder.uri.scheme !== "file") {
    void vscode.window.showErrorMessage(t("File conversion is only available in local workspaces."));
    return undefined;
  }
  const workspaceRootRealPath = await resolveRealDirectory(workspaceFolder.uri.fsPath);
  const folderRealPath = workspaceRootRealPath
    ? await resolveRealPathWithin(workspaceRootRealPath, folderUri.fsPath)
    : undefined;
  if (!workspaceRootRealPath || !folderRealPath) {
    void vscode.window.showErrorMessage(
      t("Cannot convert because the selected folder resolves outside the workspace."),
    );
    return undefined;
  }
  const config = configurationFor(workspaceFolder.uri);
  const maxFileSize = configuredFileSizeLimit(config.get<number>("maxFileSizeKB", 5120));

  if (fileUri) {
    return selectSingleFileConversion({
      context,
      fileUri,
      folderUri,
      folderRealPath,
      workspaceRootRealPath,
      maxFileSize,
      expectedEncodingFor,
      suppliedTargetEncoding,
    });
  }

  if (!(await confirmProtectedBackup(context))) {
    return undefined;
  }

  const probeUri = vscode.Uri.joinPath(folderUri, "__auto_encoding_probe__.txt");
  const ruleTarget = suppliedTargetEncoding ?? expectedEncodingFor(probeUri)?.toLowerCase();
  const preset = suppliedTargetEncoding
    ? { targetEncoding: suppliedTargetEncoding, targetLineEnding: undefined }
    : await pickConversionPreset({ ruleEncoding: ruleTarget });
  if (!preset) {
    return undefined;
  }

  const requestedTarget = preset.targetEncoding;
  const targetLineEnding = preset.targetLineEnding;
  const maxFiles = configuredScanFileLimit(
    config.get<number>("maxScanFiles", DEFAULT_MAX_SCAN_FILES),
  );
  const exclude = config.get<string>("conversionExclude", DEFAULT_SCAN_EXCLUDE);
  const exclusion = compileGlob(exclude);

  let selectedSource: string = AUTO_SOURCE;
  let scanResult = await scanFolderConversionCandidates({
    folderUri,
    folderRealPath,
    workspaceRootRealPath,
    maxFiles,
    maxFileSize,
    exclusion,
    selectedSource,
    requestedTarget,
    targetLineEnding,
    expectedEncodingFor,
  });

  if (scanResult.cancelled) return undefined;
  if (scanResult.exceededLimit) {
    void vscode.window.showErrorMessage(
      t("The folder contains more than {0} files. Please narrow down the target folder.", maxFiles),
    );
    return undefined;
  }

  if (scanResult.candidates.length === 0 && scanResult.ambiguousCount > 0) {
    const manualSource = await pickFolderSourceEncoding(
      t("Select Current Encoding"),
      targetLineEnding ? undefined : requestedTarget,
      t("Some files could not be uniquely identified automatically. Please select the source encoding."),
    );
    if (!manualSource) return undefined;
    selectedSource = manualSource;
    scanResult = await scanFolderConversionCandidates({
      folderUri,
      folderRealPath,
      workspaceRootRealPath,
      maxFiles,
      maxFileSize,
      exclusion,
      selectedSource,
      requestedTarget,
      targetLineEnding,
      expectedEncodingFor,
    });
    if (scanResult.cancelled) return undefined;
  } else if (scanResult.excluded.length > 0) {
    const viewExcludedAction = t("View Excluded Reasons");
    const manualSourceAction = t("Specify Source Encoding & Rescan");
    const actions =
      scanResult.ambiguousCount > 0 && selectedSource === AUTO_SOURCE
        ? [viewExcludedAction, manualSourceAction]
        : [viewExcludedAction];
    const choice = await vscode.window.showInformationMessage(
      t(
        "Conversion candidates: {0} / Excluded: {1}. Files matching the exclusion glob are not listed.",
        scanResult.candidates.length,
        scanResult.excluded.length,
      ),
      ...actions,
    );
    if (choice === viewExcludedAction) {
      await vscode.window.showQuickPick(scanResult.excluded, {
        title: t("Excluded Files and Reasons (Read-only)"),
        matchOnDescription: true,
        placeHolder: t("Nothing is converted from this list. Close to proceed to candidate selection."),
      });
    } else if (choice === manualSourceAction) {
      const manualSource = await pickFolderSourceEncoding(
        t("Select Current Encoding"),
        targetLineEnding ? undefined : requestedTarget,
        t("Rescan the folder using the selected source encoding."),
      );
      if (!manualSource) return undefined;
      selectedSource = manualSource;
      scanResult = await scanFolderConversionCandidates({
        folderUri,
        folderRealPath,
        workspaceRootRealPath,
        maxFiles,
        maxFileSize,
        exclusion,
        selectedSource,
        requestedTarget,
        targetLineEnding,
        expectedEncodingFor,
      });
      if (scanResult.cancelled) return undefined;
    }
  }

  const candidates = scanResult.candidates;
  if (candidates.length === 0) {
    if (scanResult.excluded.length === 0) {
      void vscode.window.showInformationMessage(
        t("No files found to inspect. Please check the target folder and exclusion settings."),
      );
    }
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(candidates, {
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: t("Select only the files you want to convert"),
    title: t(
      "Conversion candidates: {0} ({1} requiring review are unchecked)",
      candidates.length,
      candidates.filter((candidate) => candidate.needsConfirmation).length,
    ),
  });
  if (!selected || selected.length === 0) {
    return undefined;
  }

  const backupBytes = conversionSelectionBackupBytes(
    selected.map((candidate) => candidate.originalSize),
  );
  if (backupBytes === undefined) {
    void vscode.window.showErrorMessage(
      t("Backup size for selected files exceeds 512 MiB. Please convert smaller batches."),
    );
    return undefined;
  }

  const targetEncoding = requestedTarget ?? selectedSource;
  const eolPart = targetLineEnding
    ? t("EOL → {0}", targetLineEnding.toUpperCase())
    : t("Keep EOL");
  const conversionDescription =
    selectedSource === AUTO_SOURCE
      ? (requestedTarget
          ? t("Auto-detect → {0}", encodingInfo(requestedTarget).label)
          : t("Auto-detect (keep encoding)")) + ` / ${eolPart}`
      : `${encodingInfo(selectedSource).label} → ${encodingInfo(targetEncoding).label} / ${eolPart}`;

  const backupNotice = replacingBackupNotice(context);
  const needsConfirmationCount = selected.filter((candidate) => candidate.needsConfirmation).length;
  const confirmAction = t("Convert");
  const confirm = await vscode.window.showWarningMessage(
    t("Convert {0} file(s)? {1}.", selected.length, conversionDescription) +
      (needsConfirmationCount > 0
        ? ` ${t("{0} file(s) have uncertain encoding detection.", needsConfirmationCount)}`
        : "") +
      ` ${t("Original data ({0}) will be backed up locally.", formatByteSize(backupBytes))}` +
      backupNotice,
    { modal: true },
    confirmAction,
  );
  if (confirm !== confirmAction) {
    return undefined;
  }
  return { selected, sourceEncoding: selectedSource, targetEncoding, targetLineEnding };
}

async function scanFolderConversionCandidates(options: {
  readonly folderUri: vscode.Uri;
  readonly folderRealPath: string;
  readonly workspaceRootRealPath: string;
  readonly maxFiles: number;
  readonly maxFileSize: number;
  readonly exclusion: ReturnType<typeof compileGlob>;
  readonly selectedSource: string;
  readonly requestedTarget?: string;
  readonly targetLineEnding?: "lf" | "crlf";
  readonly expectedEncodingFor: (uri: vscode.Uri) => string | undefined;
}): Promise<FolderScanResult> {
  const {
    folderUri,
    folderRealPath,
    workspaceRootRealPath,
    maxFiles,
    maxFileSize,
    exclusion,
    selectedSource,
    requestedTarget,
    targetLineEnding,
    expectedEncodingFor,
  } = options;
  const convertingEncoding = Boolean(requestedTarget);
  const excluded: vscode.QuickPickItem[] = [];
  let ambiguousCount = 0;
  const recordExcluded = (uri: vscode.Uri, reason: string): void => {
    excluded.push({
      label: path.relative(folderUri.fsPath, uri.fsPath).replaceAll(path.sep, "/"),
      description: reason,
    });
  };
  const scanTitle =
    selectedSource === AUTO_SOURCE
      ? t("Scanning files with auto-detection")
      : t("Scanning files as {0}", encodingInfo(selectedSource).label);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: scanTitle,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: t("Listing target files") });
      let uris: readonly vscode.Uri[];
      try {
        const cursor = new DirectoryScanCursor(folderUri.fsPath, (candidate, directory) => {
          const relative = path.relative(folderUri.fsPath, candidate).replaceAll(path.sep, "/");
          return exclusion.match(relative) || (directory && exclusion.match(`${relative}/`));
        });
        const foundUris: vscode.Uri[] = [];
        try {
          while (foundUris.length <= maxFiles && !token.isCancellationRequested) {
            const page = await cursor.peek(
              Math.min(500, maxFiles + 1 - foundUris.length),
              () => token.isCancellationRequested,
            );
            if (page.unreadable.length) throw new Error(t("Could not read target folder."));
            foundUris.push(...page.paths.map((name) => vscode.Uri.file(name)));
            cursor.commit(page.paths.length);
            if (page.complete) break;
          }
          uris = foundUris;
        } finally {
          await cursor.dispose();
        }
      } catch (error) {
        if (token.isCancellationRequested) {
          return { candidates: [], excluded, ambiguousCount, cancelled: true, exceededLimit: false };
        }
        throw error;
      }
      if (token.isCancellationRequested) {
        return { candidates: [], excluded, ambiguousCount, cancelled: true, exceededLimit: false };
      }
      if (uris.length > maxFiles) {
        return { candidates: [], excluded, ambiguousCount, cancelled: false, exceededLimit: true };
      }
      const found: ConversionCandidate[] = [];
      for (const [index, uri] of uris.entries()) {
        if (token.isCancellationRequested) break;
        progress.report({
          increment: uris.length === 0 ? 100 : 100 / uris.length,
          message: `${index + 1}/${uris.length}`,
        });
        const resolvedPath = await resolveRealPathWithin(folderRealPath, uri.fsPath);
        if (!resolvedPath) {
          recordExcluded(uri, t("Outside target scope or path could not be verified"));
          continue;
        }
        const writeUri = vscode.Uri.file(resolvedPath);
        if (isDirty(uri, writeUri)) {
          recordExcluded(uri, t("Has unsaved changes"));
          continue;
        }
        const fileRuleEncoding = expectedEncodingFor(uri);
        if (convertingEncoding && fileRuleEncoding && requestedTarget && fileRuleEncoding !== requestedTarget) {
          recordExcluded(uri, t("A different encoding rule applies"));
          continue;
        }
        try {
          const info = await vscode.workspace.fs.stat(writeUri);
          if (info.size > maxFileSize) {
            recordExcluded(uri, t("Exceeds file size limit"));
            continue;
          }
          const read = await readPinnedLocalFile(
            workspaceRootRealPath,
            writeUri.fsPath,
            maxFileSize,
            () => isDirty(uri, writeUri) || token.isCancellationRequested,
          );
          if (!read) {
            recordExcluded(uri, t("Unchecked (modifying or unreadable)"));
            continue;
          }
          const original = read.bytes;
          let fileSourceEncoding: string;
          let needsConfirmation = false;
          if (selectedSource === AUTO_SOURCE) {
            const autoClassification = await classifyEncoding(original, "utf8", vscodeCodec, {
              allowNonCanonicalShiftJis: true,
              isCancellationRequested: () => token.isCancellationRequested,
            });
            if (token.isCancellationRequested) break;
            const resolved = await resolveAutoSourceEncoding(original, autoClassification, {
              convertingEncoding,
              fileRuleEncoding,
              manualOverride: false,
              allowRuleDisambiguation: true,
              isCancellationRequested: () => token.isCancellationRequested,
            });
            if (resolved.kind === "binary") {
              recordExcluded(uri, skipReasonLabel("binary"));
              continue;
            }
            if (resolved.kind === "ambiguous") {
              ambiguousCount += 1;
              recordExcluded(uri, t("Encoding could not be uniquely identified"));
              continue;
            }
            fileSourceEncoding = resolved.encoding;
          } else {
            fileSourceEncoding = selectedSource;
          }
          const fileTargetEncoding = requestedTarget ?? fileSourceEncoding;
          const assessment = await assessEncodingConversion(
            original,
            fileSourceEncoding,
            fileTargetEncoding,
            vscodeCodec,
            () => token.isCancellationRequested,
            targetLineEnding,
          );
          if (assessment.kind === "skipped") {
            recordExcluded(uri, skipReasonLabel(assessment.reason));
            continue;
          }
          const prepared = assessment.prepared;
          if (selectedSource !== AUTO_SOURCE) {
            const useAllEncodings =
              selectedSource === "windows1252" || selectedSource === "iso88591";
            const classification = await classifyEncoding(original, selectedSource, vscodeCodec, {
              isCancellationRequested: () => token.isCancellationRequested,
              allowNonCanonicalShiftJis: true,
              ...(useAllEncodings
                ? {
                    alternativeEncodings: ENCODINGS.map((encoding) => encoding.id).filter(
                      (encoding) => encoding !== selectedSource,
                    ),
                  }
                : {}),
            });
            needsConfirmation =
              classification.kind !== "match" && classification.kind !== "ascii";
          }
          const beforeEol = classifyLineEndings(original, fileSourceEncoding);
          const eolLabel = formatLineEndingSummary(beforeEol);
          const relativePath = path
            .relative(folderUri.fsPath, uri.fsPath)
            .replaceAll(path.sep, "/");
          found.push({
            uri,
            writeUri,
            relativePath,
            sourceEncoding: fileSourceEncoding,
            targetEncoding: fileTargetEncoding,
            originalHash: hashBytes(original),
            originalSize: original.byteLength,
            originalIdentity: read.identity,
            maxSize: maxFileSize,
            conversionRootRealPath: folderRealPath,
            workspaceRootRealPath,
            needsConfirmation,
            label: relativePath,
            description: `${needsConfirmation ? `${t("Review required (uncertain encoding)")} · ` : ""}${encodingInfo(fileSourceEncoding).label} → ${encodingInfo(fileTargetEncoding).label} / ${eolLabel} → ${targetLineEnding?.toUpperCase() ?? eolLabel}`,
            detail: previewText(prepared.text),
            picked: !needsConfirmation,
          });
        } catch {
          recordExcluded(uri, t("Failed to read or inspect"));
        }
      }
      return {
        candidates: found,
        excluded,
        ambiguousCount,
        cancelled: token.isCancellationRequested,
        exceededLimit: false,
      };
    },
  );
}

async function selectSingleFileConversion(options: {
  readonly context: vscode.ExtensionContext;
  readonly fileUri: vscode.Uri;
  readonly folderUri: vscode.Uri;
  readonly folderRealPath: string;
  readonly workspaceRootRealPath: string;
  readonly maxFileSize: number;
  readonly expectedEncodingFor: (uri: vscode.Uri) => string | undefined;
  readonly suppliedTargetEncoding?: string;
}): Promise<ConversionSelection | undefined> {
  const {
    context,
    fileUri,
    folderUri,
    folderRealPath,
    workspaceRootRealPath,
    maxFileSize,
    expectedEncodingFor,
    suppliedTargetEncoding,
  } = options;
  const basename = path.basename(fileUri.fsPath);
  const resolvedPath = await resolveRealPathWithin(folderRealPath, fileUri.fsPath);
  if (!resolvedPath) {
    void vscode.window.showInformationMessage(
      t("{0}: Outside target scope or path could not be verified", basename),
    );
    return undefined;
  }
  const writeUri = vscode.Uri.file(resolvedPath);
  if (isDirty(fileUri, writeUri)) {
    void vscode.window.showWarningMessage(
      t("This file has unsaved changes. Please save the file before converting its encoding."),
    );
    return undefined;
  }
  let original: Uint8Array;
  let originalIdentity: string;
  try {
    const info = await vscode.workspace.fs.stat(writeUri);
    if (info.size > maxFileSize) {
      void vscode.window.showInformationMessage(t("{0}: Exceeds file size limit", basename));
      return undefined;
    }
    const read = await readPinnedLocalFile(
      workspaceRootRealPath,
      writeUri.fsPath,
      maxFileSize,
      () => isDirty(fileUri, writeUri),
    );
    if (!read) {
      void vscode.window.showInformationMessage(
        t("{0}: Unchecked (modifying or unreadable)", basename),
      );
      return undefined;
    }
    original = read.bytes;
    originalIdentity = read.identity;
  } catch {
    void vscode.window.showInformationMessage(t("{0}: Failed to read or inspect", basename));
    return undefined;
  }

  const classification = await classifyEncoding(original, "utf8", vscodeCodec, {
    allowNonCanonicalShiftJis: true,
  });
  if (classification.kind === "skip") {
    void vscode.window.showInformationMessage(`${basename}: ${skipReasonLabel("binary")}`);
    return undefined;
  }
  if (!(await confirmProtectedBackup(context))) {
    return undefined;
  }

  const openDocEncoding = findOpenDocumentEncoding(fileUri, writeUri);
  const manualOverride = isManualEncodingOverride(fileUri) || isManualEncodingOverride(writeUri);
  const fileRuleEncoding = expectedEncodingFor(fileUri)?.toLowerCase();

  let targetLineEnding: "lf" | "crlf" | undefined;
  let requestedTarget: string | undefined;

  if (suppliedTargetEncoding) {
    requestedTarget = suppliedTargetEncoding;
  } else {
    const currentEolLabel = formatLineEndingSummary(
      classifyLineEndings(original, detectUtf16Signal(original)),
    );
    const previewAuto = await resolveAutoSourceEncoding(original, classification, {
      convertingEncoding: true,
      fileRuleEncoding,
      openDocEncoding,
      manualOverride,
      allowRuleDisambiguation: false,
      isCancellationRequested: () => false,
    });
    const currentEncodingHint =
      previewAuto.kind === "resolved" ? previewAuto.encoding : undefined;
    const preset = await pickConversionPreset({
      ruleEncoding: fileRuleEncoding,
      currentEncodingHint,
      currentEolLabel,
    });
    if (!preset) return undefined;
    requestedTarget = preset.targetEncoding;
    targetLineEnding = preset.targetLineEnding;
  }

  const convertingEncoding = Boolean(requestedTarget);
  const autoResolved = await resolveAutoSourceEncoding(original, classification, {
    convertingEncoding,
    fileRuleEncoding,
    openDocEncoding,
    manualOverride,
    allowRuleDisambiguation: false,
    isCancellationRequested: () => false,
  });
  let sourceEncoding: string | undefined;
  if (autoResolved.kind === "resolved") {
    sourceEncoding = autoResolved.encoding;
  } else if (autoResolved.kind === "ambiguous") {
    const picked = await pickSingleSourceEncoding(original, classification, {
      fileRuleEncoding,
      openDocEncoding,
      manualOverride,
    });
    if (picked.noneAvailable) {
      void vscode.window.showInformationMessage(`${basename}: ${skipReasonLabel("sourceMismatch")}`);
      return undefined;
    }
    sourceEncoding = picked.encoding;
  }
  if (!sourceEncoding) {
    return undefined;
  }

  const targetEncoding = requestedTarget ?? sourceEncoding;
  const assessment = await assessEncodingConversion(
    original,
    sourceEncoding,
    targetEncoding,
    vscodeCodec,
    undefined,
    targetLineEnding,
  );
  if (assessment.kind === "skipped") {
    void vscode.window.showInformationMessage(`${basename}: ${skipReasonLabel(assessment.reason)}`);
    return undefined;
  }

  const beforeEol = classifyLineEndings(original, sourceEncoding);
  const eolLabel = formatLineEndingSummary(beforeEol);
  const relativePath = path.relative(folderUri.fsPath, fileUri.fsPath).replaceAll(path.sep, "/");
  const candidate: ConversionCandidate = {
    uri: fileUri,
    writeUri,
    relativePath,
    sourceEncoding,
    targetEncoding,
    originalHash: hashBytes(original),
    originalSize: original.byteLength,
    originalIdentity,
    maxSize: maxFileSize,
    conversionRootRealPath: folderRealPath,
    workspaceRootRealPath,
    needsConfirmation: false,
    label: relativePath,
    description: `${encodingInfo(sourceEncoding).label} → ${encodingInfo(targetEncoding).label} / ${eolLabel} → ${targetLineEnding?.toUpperCase() ?? eolLabel}`,
    detail: previewText(assessment.prepared.text),
    picked: true,
  };

  const backupBytes = conversionSelectionBackupBytes([candidate.originalSize]);
  if (backupBytes === undefined) {
    void vscode.window.showErrorMessage(
      t("Backup size for selected files exceeds 512 MiB. Please convert smaller batches."),
    );
    return undefined;
  }

  return { selected: [candidate], sourceEncoding, targetEncoding, targetLineEnding };
}

const COMMON_ENCODING_IDS = new Set(["utf8", "utf8bom", "shiftjis", "eucjp"]);

async function pickConversionPreset(options: {
  readonly ruleEncoding?: string;
  readonly currentEncodingHint?: string;
  readonly currentEolLabel?: string;
}): Promise<ConversionPreset | undefined> {
  const { ruleEncoding, currentEncodingHint, currentEolLabel } = options;
  const eolNote = currentEolLabel
    ? t("Keep EOL (current: {0})", currentEolLabel)
    : t("Keep EOL");

  const makeEncodingItem = (encoding: (typeof ENCODINGS)[number]): ConversionPreset => {
    const tags: string[] = [encoding.id, eolNote];
    if (encoding.id === ruleEncoding) tags.push(t("Rule target"));
    if (encoding.id === currentEncodingHint) tags.push(t("Current encoding"));
    return {
      label: encoding.label,
      description: tags.join(" · "),
      targetEncoding: encoding.id,
    };
  };

  // Hide "current encoding + keep EOL" for single files to avoid no-op choices.
  const eligible = ENCODINGS.filter((encoding) => encoding.id !== currentEncodingHint);
  const commonEncodings = [
    ...eligible.filter((encoding) => encoding.id === ruleEncoding),
    ...eligible.filter(
      (encoding) => encoding.id !== ruleEncoding && COMMON_ENCODING_IDS.has(encoding.id),
    ),
  ];
  const secondaryEncodings = eligible.filter(
    (encoding) => encoding.id !== ruleEncoding && !COMMON_ENCODING_IDS.has(encoding.id),
  );

  const items: ConversionPreset[] = commonEncodings.map(makeEncodingItem);

  const comboTargets = [
    "utf8",
    "shiftjis",
    ...(ruleEncoding && ruleEncoding !== "utf8" && ruleEncoding !== "shiftjis"
      ? [ruleEncoding]
      : []),
  ];
  for (const id of comboTargets) {
    const info = encodingInfo(id);
    items.push(
      {
        label: `${info.label} + LF`,
        description: t("{0} · Convert encoding and line endings", id),
        targetEncoding: id,
        targetLineEnding: "lf",
      },
      {
        label: `${info.label} + CRLF`,
        description: t("{0} · Convert encoding and line endings", id),
        targetEncoding: id,
        targetLineEnding: "crlf",
      },
    );
  }

  items.push(
    {
      label: t("Line endings only → LF"),
      description: t("Keep current encoding"),
      targetLineEnding: "lf",
    },
    {
      label: t("Line endings only → CRLF"),
      description: t("Keep current encoding"),
      targetLineEnding: "crlf",
    },
    ...secondaryEncodings.map(makeEncodingItem),
  );

  const placeHolder = currentEncodingHint
    ? currentEolLabel
      ? t("Current: {0} / {1} — Select target format", encodingInfo(currentEncodingHint).label, currentEolLabel)
      : t("Current: {0} — Select target format", encodingInfo(currentEncodingHint).label)
    : t("Select target encoding or line ending");

  return vscode.window.showQuickPick(items, {
    title: t("Select Target Format"),
    placeHolder,
  });
}

async function confirmProtectedBackup(context: vscode.ExtensionContext): Promise<boolean> {
  const previousSession = protectedConversionSession(
    context.workspaceState.get<unknown>(LAST_BACKUP_KEY),
    context.workspaceState.get<unknown>(PROTECTED_BACKUP_KEY),
  );
  if (!previousSession) {
    return true;
  }
  const protectedUri = vscode.Uri.parse(previousSession);
  const keepAction = t("Keep Backup and Continue");
  const proceed = await vscode.window.showWarningMessage(
    t(
      "The previous restore is incomplete. It will no longer be the automatic Undo target, but do you want to keep the backup at {0} and continue?",
      protectedUri.fsPath,
    ),
    { modal: true },
    keepAction,
  );
  return proceed === keepAction;
}

function replacingBackupNotice(context: vscode.ExtensionContext): string {
  const storedBackup = context.workspaceState.get<unknown>(LAST_BACKUP_KEY);
  const replacingBackup =
    typeof storedBackup === "string" &&
    storedBackup.length > 0 &&
    storedBackup !== context.workspaceState.get<unknown>(PROTECTED_BACKUP_KEY);
  return replacingBackup
    ? ` ${t("Once the new conversion succeeds, the previous backup will be deleted and cannot be undone.")}`
    : "";
}

function findOpenDocumentEncoding(uri: vscode.Uri, writeUri: vscode.Uri): string | undefined {
  const keys = new Set([uri.toString(), writeUri.toString()]);
  return vscode.workspace.textDocuments
    .find((document) => !document.isClosed && keys.has(document.uri.toString()))
    ?.encoding?.toLowerCase();
}

async function isLosslessRoundTrip(
  bytes: Uint8Array,
  encoding: string,
  isCancellationRequested: () => boolean,
): Promise<{ readonly valid: boolean; readonly text?: string }> {
  if (isCancellationRequested()) return { valid: false };
  try {
    const text = await vscodeCodec.decode(bytes, encoding);
    if (isCancellationRequested()) return { valid: false };
    if (looksLikeBinary(text)) return { valid: false };
    const encoded = await vscodeCodec.encode(text, encoding);
    if (isCancellationRequested()) return { valid: false };
    if (bytesEqual(bytes, encoded)) {
      return { valid: true, text };
    }
    if (encoding === "shiftjis" && !text.includes("\uFFFD")) {
      try {
        if (new TextDecoder("shift_jis", { fatal: true }).decode(bytes) === text) {
          return { valid: true, text };
        }
      } catch {
        // Invalid Shift JIS bytes fall through to invalid.
      }
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

async function resolveAutoSourceEncoding(
  bytes: Uint8Array,
  classification: EncodingClassification,
  options: {
    readonly convertingEncoding: boolean;
    readonly fileRuleEncoding?: string;
    readonly openDocEncoding?: string;
    readonly manualOverride: boolean;
    readonly allowRuleDisambiguation: boolean;
    readonly isCancellationRequested: () => boolean;
  },
): Promise<
  | { readonly kind: "resolved"; readonly encoding: string }
  | { readonly kind: "binary" }
  | { readonly kind: "ambiguous" }
> {
  if (classification.kind === "skip") {
    return { kind: "binary" };
  }
  const ruleEncoding = options.fileRuleEncoding?.toLowerCase();
  const openEncoding = options.openDocEncoding?.toLowerCase();
  if (classification.kind === "ascii") {
    if (!options.convertingEncoding && ruleEncoding && isAsciiCompatibleEncoding(ruleEncoding)) {
      return { kind: "resolved", encoding: ruleEncoding };
    }
    if (openEncoding && isAsciiCompatibleEncoding(openEncoding)) {
      return { kind: "resolved", encoding: openEncoding };
    }
    return { kind: "resolved", encoding: "utf8" };
  }
  if (
    (classification.kind === "match" || classification.kind === "mismatch") &&
    classification.detectedEncoding
  ) {
    const detected = classification.detectedEncoding.toLowerCase();
    if (detected === "shiftjis" || detected === "eucjp") {
      const western =
        options.manualOverride && (openEncoding === "windows1252" || openEncoding === "iso88591")
          ? openEncoding
          : ruleEncoding === "windows1252" || ruleEncoding === "iso88591"
            ? ruleEncoding
            : undefined;
      if (
        western &&
        (await isLosslessRoundTrip(bytes, western, options.isCancellationRequested)).valid
      ) {
        if (options.allowRuleDisambiguation && !options.convertingEncoding && ruleEncoding) {
          const ruleRoundTrip = await isLosslessRoundTrip(
            bytes,
            ruleEncoding,
            options.isCancellationRequested,
          );
          if (ruleRoundTrip.valid) {
            return { kind: "resolved", encoding: ruleEncoding };
          }
        }
        return { kind: "ambiguous" };
      }
    }
    return { kind: "resolved", encoding: detected };
  }
  if (options.allowRuleDisambiguation && !options.convertingEncoding && ruleEncoding) {
    const ruleRoundTrip = await isLosslessRoundTrip(
      bytes,
      ruleEncoding,
      options.isCancellationRequested,
    );
    if (ruleRoundTrip.valid) {
      return { kind: "resolved", encoding: ruleEncoding };
    }
  }
  return { kind: "ambiguous" };
}

async function pickSingleSourceEncoding(
  bytes: Uint8Array,
  classification: EncodingClassification,
  options: {
    readonly fileRuleEncoding?: string;
    readonly openDocEncoding?: string;
    readonly manualOverride: boolean;
  },
): Promise<{ readonly encoding?: string; readonly noneAvailable?: boolean }> {
  const utf16Signal = detectUtf16Signal(bytes);
  const ruleEncoding = options.fileRuleEncoding?.toLowerCase();
  const openEncoding = options.openDocEncoding?.toLowerCase();
  const relevantUtf16 = new Set(
    [utf16Signal, ruleEncoding, openEncoding].filter((value): value is string => !!value),
  );
  const candidateResults = new Map<string, string>();
  for (const entry of ENCODINGS) {
    if ((entry.id === "utf16le" || entry.id === "utf16be") && !relevantUtf16.has(entry.id)) {
      continue;
    }
    const roundTrip = await isLosslessRoundTrip(bytes, entry.id, () => false);
    if (roundTrip.valid && roundTrip.text !== undefined) {
      candidateResults.set(entry.id, roundTrip.text);
    }
  }
  if (candidateResults.size === 0) {
    return { noneAvailable: true };
  }
  const classificationSet = new Set<string>([
    ...(classification.detectedEncoding ? [classification.detectedEncoding.toLowerCase()] : []),
    ...(classification.candidates?.map((id) => id.toLowerCase()) ?? []),
  ]);
  const ranked = rankDecodedCandidates(
    [...candidateResults.entries()].map(([encoding, text]) => ({ encoding, text })),
  );
  const rankedById = new Map(ranked.map((entry) => [entry.encoding, entry]));
  const rankedOrder = ranked.map((entry) => entry.encoding);
  const preferredOrder: string[] = [];
  if (
    openEncoding &&
    (options.manualOverride || openEncoding !== "utf8") &&
    candidateResults.has(openEncoding)
  ) {
    preferredOrder.push(openEncoding);
  }
  if (ruleEncoding && candidateResults.has(ruleEncoding)) {
    preferredOrder.push(ruleEncoding);
  }
  for (const id of rankedOrder) {
    if (classificationSet.has(id)) {
      preferredOrder.push(id);
    }
  }
  for (const id of rankedOrder) {
    preferredOrder.push(id);
  }
  const orderedIds = [...new Set(preferredOrder)];
  const items = orderedIds.map((id) => {
    const info = rankedById.get(id);
    const tags: string[] = [id];
    if (info?.likely) tags.push(t("Likely"));
    if (classificationSet.has(id)) tags.push(t("Candidate"));
    if (id === openEncoding) tags.push(t("Current view"));
    if (id === ruleEncoding) tags.push(t("Rule target"));
    return {
      label: encodingInfo(id).label,
      description: tags.join(" · "),
      detail: info?.preview ?? previewText(candidateResults.get(id)!),
      encoding: id,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: t("Select Current Encoding"),
    placeHolder: t(
      "Check the preview and select the encoding that reads the saved file correctly.",
    ),
  });
  return { encoding: picked?.encoding };
}

async function pickFolderSourceEncoding(
  title: string,
  excludedEncoding?: string,
  placeHolder?: string,
): Promise<string | undefined> {
  const items = [
    {
      label: t("Auto-detect (uniquely identifiable files only)"),
      description: t("auto · BOM, UTF-8, UTF-16, unambiguous Shift JIS / EUC-JP"),
      encoding: AUTO_SOURCE,
    },
    ...ENCODINGS.filter((encoding) => encoding.id !== excludedEncoding).map((encoding) => ({
      label: encoding.label,
      description: encoding.id,
      encoding: encoding.id,
    })),
  ];
  const choice = await vscode.window.showQuickPick(items, { title, placeHolder });
  return choice?.encoding;
}

function formatLineEndingSummary(classification: LineEndingClassification): string {
  if (classification.kind === "mixed") {
    return classification.styles.map((style) => style.toUpperCase()).join("+");
  }
  return classification.kind === "none" ? t("No EOL") : classification.kind.toUpperCase();
}

async function pickFolder(suppliedUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (suppliedUri) {
    return suppliedUri;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: t("Convert Files"),
    title: t("Select a folder to convert"),
  });
  return selected?.[0];
}

function previewText(text: string): string {
  const sample = text.slice(0, 4096);
  const sanitized = Array.from(sample, (character) => {
    const code = character.charCodeAt(0);
    const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    return control ? "\uFFFD" : character;
  }).join("");
  const compact = sanitized.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact || t("(empty text)");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
