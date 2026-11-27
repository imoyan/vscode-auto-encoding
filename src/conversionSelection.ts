// Entry point for single-file and folder encoding/EOL conversion selection and confirmation.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { conversionSelectionBackupBytes } from "./conversionCore.js";
import { activeConversionState } from "./conversionBackup.js";
import { isDirty } from "./conversionResources.js";
import { encodingInfo, sanitizeAutoDetectEncodings } from "./rules.js";
import {
  resolveRealDirectory,
  resolveRealPathWithin,
  resolveStandaloneRegularFile,
} from "./localPathSafety.js";
import {
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_SCAN_EXCLUDE,
  configuredFileSizeLimit,
  configuredScanFileLimit,
} from "./fileLimits.js";
import { compileGlob } from "./boundedGlob.js";
import {
  AUTO_SOURCE,
  type ConversionCandidate,
  type ConversionSelection,
  confirmProtectedBackup,
  formatByteSize,
  pickConversionPreset,
  pickFolder,
  pickFolderSourceEncoding,
  replacingBackupNotice,
} from "./conversionPrompts.js";
import { scanFolderConversionCandidates } from "./conversionFolderScan.js";
import { selectSingleFileConversion } from "./conversionSingleFile.js";

export type { ConversionCandidate, ConversionSelection };

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
    const fileWorkspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!fileWorkspaceFolder) {
      const standaloneFile = await resolveStandaloneRegularFile(fileUri.fsPath);
      if (!standaloneFile) {
        void vscode.window.showInformationMessage(
          t("{0}: Outside target scope or path could not be verified", path.basename(fileUri.fsPath)),
        );
        return undefined;
      }
      const standaloneConfig = configurationFor(fileUri);
      const standaloneMaxFileSize = configuredFileSizeLimit(
        standaloneConfig.get<number>("maxFileSizeKB", 5120),
      );
      const standaloneAutoDetect = sanitizeAutoDetectEncodings(
        standaloneConfig.get<unknown>("autoDetectEncodings"),
      );
      return selectSingleFileConversion({
        context,
        fileUri,
        folderUri: vscode.Uri.file(path.dirname(fileUri.fsPath)),
        folderRealPath: standaloneFile.parentRealPath,
        workspaceRootRealPath: standaloneFile.parentRealPath,
        resolvedWritePath: standaloneFile.fileRealPath,
        standalone: true,
        maxFileSize: standaloneMaxFileSize,
        autoDetectEncodings: standaloneAutoDetect,
        expectedEncodingFor,
        suppliedTargetEncoding,
      });
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
  const autoDetectEncodings = sanitizeAutoDetectEncodings(
    config.get<unknown>("autoDetectEncodings"),
  );

  if (fileUri) {
    return selectSingleFileConversion({
      context,
      fileUri,
      folderUri,
      folderRealPath,
      workspaceRootRealPath,
      maxFileSize,
      autoDetectEncodings,
      expectedEncodingFor,
      suppliedTargetEncoding,
    });
  }

  const state = activeConversionState(context);
  if (!(await confirmProtectedBackup(state))) {
    return undefined;
  }

  const probeUri = vscode.Uri.joinPath(folderUri, "__auto_encoding_probe__");
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
    autoDetectEncodings,
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
      Boolean(requestedTarget),
    );
    if (!manualSource) return undefined;
    selectedSource = manualSource;
    scanResult = await scanFolderConversionCandidates({
      folderUri,
      folderRealPath,
      workspaceRootRealPath,
      maxFiles,
      maxFileSize,
      autoDetectEncodings,
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
        Boolean(requestedTarget),
      );
      if (!manualSource) return undefined;
      selectedSource = manualSource;
      scanResult = await scanFolderConversionCandidates({
        folderUri,
        folderRealPath,
        workspaceRootRealPath,
        maxFiles,
        maxFileSize,
        autoDetectEncodings,
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

  const backupNotice = replacingBackupNotice(state);
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
