// Single-file conversion inspection, source disambiguation, and confirmation flow.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { conversionSelectionBackupBytes, assessEncodingConversion } from "./conversionCore.js";
import { activeConversionState } from "./conversionBackup.js";
import { isDirty, hashBytes } from "./conversionResources.js";
import { encodingInfo } from "./rules.js";
import { readPinnedLocalFile } from "./pinnedLocalFile.js";
import { resolveRealPathWithin } from "./localPathSafety.js";
import { classifyEncoding, classifyLineEndings, detectUtf16Signal } from "./scanCore.js";
import { isManualEncodingOverride } from "./editorEncoding.js";
import {
  type ConversionCandidate,
  type ConversionSelection,
  confirmProtectedBackup,
  decodeSourcePreview,
  findOpenDocumentEncoding,
  formatByteSize,
  formatLineEndingSummary,
  pickConversionPreset,
  pickSingleSourceEncoding,
  previewText,
  replacingBackupNotice,
  resolveAutoSourceEncoding,
  skipReasonLabel,
  vscodeCodec,
} from "./conversionPrompts.js";

/** Inspects a single local file and builds a confirmed conversion selection. */
export async function selectSingleFileConversion(options: {
  readonly context: vscode.ExtensionContext;
  readonly fileUri: vscode.Uri;
  readonly folderUri: vscode.Uri;
  readonly folderRealPath: string;
  readonly workspaceRootRealPath: string;
  readonly resolvedWritePath?: string;
  readonly standalone?: boolean;
  readonly maxFileSize: number;
  readonly autoDetectEncodings: readonly string[];
  readonly expectedEncodingFor: (uri: vscode.Uri) => string | undefined;
  readonly suppliedTargetEncoding?: string;
}): Promise<ConversionSelection | undefined> {
  const {
    context,
    fileUri,
    folderUri,
    folderRealPath,
    workspaceRootRealPath,
    resolvedWritePath,
    standalone = false,
    maxFileSize,
    autoDetectEncodings,
    expectedEncodingFor,
    suppliedTargetEncoding,
  } = options;
  const basename = path.basename(fileUri.fsPath);
  const resolvedPath =
    resolvedWritePath ?? (await resolveRealPathWithin(folderRealPath, fileUri.fsPath));
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
    alternativeEncodings: autoDetectEncodings,
    allowNonCanonicalShiftJis: true,
  });
  if (classification.kind === "skip") {
    void vscode.window.showInformationMessage(`${basename}: ${skipReasonLabel("binary")}`);
    return undefined;
  }
  const state = activeConversionState(context);
  if (!(await confirmProtectedBackup(state))) {
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
    const currentEolLabel = formatLineEndingSummary(
      classifyLineEndings(original, currentEncodingHint ?? detectUtf16Signal(original)),
    );
    const sourcePreview = await decodeSourcePreview(original, currentEncodingHint);
    const preset = await pickConversionPreset({
      ruleEncoding: fileRuleEncoding,
      currentEncodingHint,
      currentEolLabel,
      sourcePreview,
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
  const needsConfirmation = autoResolved.kind === "ambiguous";
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
    ...(standalone ? { standalone: true } : {}),
    needsConfirmation,
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

  if (needsConfirmation) {
    const eolPart = targetLineEnding
      ? t("EOL → {0}", targetLineEnding.toUpperCase())
      : t("Keep EOL");
    const conversionDescription = `${encodingInfo(sourceEncoding).label} → ${encodingInfo(targetEncoding).label} / ${eolPart}`;
    const backupNotice = replacingBackupNotice(state);
    const confirmAction = t("Convert");
    const confirm = await vscode.window.showWarningMessage(
      t("Convert {0} file(s)? {1}.", 1, conversionDescription) +
        ` ${t("{0} file(s) have uncertain encoding detection.", 1)}` +
        ` ${t("Original data ({0}) will be backed up locally.", formatByteSize(backupBytes))}` +
        backupNotice,
      { modal: true },
      confirmAction,
    );
    if (confirm !== confirmAction) {
      return undefined;
    }
  }

  return { selected: [candidate], sourceEncoding, targetEncoding, targetLineEnding };
}
