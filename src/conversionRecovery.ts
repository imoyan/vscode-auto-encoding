import * as vscode from "vscode";
import { t } from "./l10n.js";
import { conversionBackupReadLimit } from "./conversionCore.js";
import {
  LAST_BACKUP_KEY,
  PROTECTED_BACKUP_KEY,
  type BackupRecord,
  activeConversionState,
  isConversionBackupSession,
  readBackupRecord,
  readBackupResource,
  deleteStoredBackupSession,
  writeJsonAtomic,
} from "./conversionBackup.js";
import { isDirty, hashBytes, reopenCleanDocument } from "./conversionResources.js";
import { PinnedLocalFile, readPinnedLocalFile } from "./pinnedLocalFile.js";
import {
  resolveRealDirectory,
  resolveRealPathWithin,
  resolveStandaloneRegularFile,
} from "./localPathSafety.js";

const LEGACY_BACKUP_LIMIT = 100 * 1024 * 1024;
const LEGACY_CONVERTED_LIMIT = 320 * 1024 * 1024;

interface ResolvedRecoveryTarget {
  readonly rootRealPath?: string;
  readonly conversionRootRealPath?: string;
  readonly resolvedUri?: vscode.Uri;
  readonly standalone: boolean;
  readonly manualRecoveryRequired: boolean;
}

/** Called inside ConversionManager's exclusive gate shared by conversion and restore. */
export async function restoreLastConversion(
  context: vscode.ExtensionContext,
  onFilesChanged: () => void,
  stored?: string | null,
  onFileTouched: (uri: vscode.Uri) => void = () => undefined,
  backup = { lastKey: LAST_BACKUP_KEY, protectedKey: PROTECTED_BACKUP_KEY, protectSkipped: true },
  state: vscode.Memento = activeConversionState(context),
): Promise<boolean> {
  const { lastKey, protectedKey } = backup;
  const sessionString = stored === undefined ? state.get<string>(lastKey) : stored;
  if (!sessionString) {
    void vscode.window.showInformationMessage(t("No previous conversion to undo in this workspace."));
    return false;
  }
  const sessionUri = vscode.Uri.parse(sessionString);
  if (!(await isConversionBackupSession(context.globalStorageUri, sessionUri))) {
    void vscode.window.showErrorMessage(t("Invalid conversion backup location."));
    return false;
  }
  const undoAction = t("Undo");
  const confirm = await vscode.window.showWarningMessage(
    t("Undo the last conversion. Files modified after conversion will be skipped and not overwritten."),
    { modal: true },
    undoAction,
  );
  if (confirm !== undoAction) {
    return false;
  }

  let restored = 0;
  let alreadyRestored = 0;
  let skipped = 0;
  let failed = 0;
  let manualRecoveryRequired = false;
  let recordCount = 0;
  try {
    const entries = await vscode.workspace.fs.readDirectory(sessionUri);
    const recordNames = entries
      .filter(([name, type]) => type === vscode.FileType.File && /^\d+\.json$/.test(name))
      .map(([name]) => name)
      .sort();
    recordCount = recordNames.length;
    for (const recordName of recordNames) {
      let file: PinnedLocalFile | undefined;
      try {
        const record = await readBackupRecord(vscode.Uri.joinPath(sessionUri, recordName));
        if (!record || !/^\d+\.bin$/.test(record.backupFile)) {
          failed += 1;
          continue;
        }
        const originalUri = vscode.Uri.parse(record.originalUri);
        if (originalUri.scheme !== "file") {
          skipped += 1;
          continue;
        }
        const target = await resolveRecoveryTarget(record, originalUri);
        const { rootRealPath, conversionRootRealPath, resolvedUri } = target;
        if (target.manualRecoveryRequired) {
          failed += 1;
          manualRecoveryRequired = true;
          continue;
        }
        if (
          !rootRealPath ||
          !conversionRootRealPath ||
          !resolvedUri ||
          (record.resolvedUri !== undefined && record.resolvedUri !== resolvedUri.toString()) ||
          isDirty(originalUri, resolvedUri)
        ) {
          skipped += 1;
          continue;
        }
        const maxSize = conversionBackupReadLimit(
          record.originalSize,
          record.convertedSize,
          LEGACY_CONVERTED_LIMIT,
        );
        const current = await readPinnedLocalFile(
          rootRealPath,
          resolvedUri.fsPath,
          maxSize,
        );
        if (!current || isDirty(originalUri, resolvedUri)) {
          skipped += 1;
          continue;
        }
        const currentHash = hashBytes(current.bytes);
        if (currentHash === record.originalHash) {
          alreadyRestored += 1;
          continue;
        }
        if (currentHash !== record.convertedHash && !record.recoveryRequired) {
          skipped += 1;
          continue;
        }
        if (currentHash !== record.convertedHash && record.recoveryRequired) {
          const restoreAction = t("Restore from Backup");
          const recovery = await vscode.window.showWarningMessage(
            t(
              "{0} may not have finished writing during the previous conversion or restore. Replace the current contents with the backed-up original data?",
              record.relativePath,
            ),
            { modal: true },
            restoreAction,
          );
          if (recovery !== restoreAction) {
            skipped += 1;
            continue;
          }
        }
        const backupBytes = await readVerifiedBackup(sessionUri, record);
        if (!backupBytes) {
          failed += 1;
          continue;
        }
        file = await PinnedLocalFile.open(
          rootRealPath,
          resolvedUri.fsPath,
          maxSize,
          true,
        );
        if (
          !file ||
          file.read.identity !== current.identity ||
          file.read.contentHash !== current.contentHash ||
          isDirty(originalUri, resolvedUri)
        ) {
          skipped += 1;
          continue;
        }
        const recordUri = vscode.Uri.joinPath(sessionUri, recordName);
        const previousProtection = state.get<string>(protectedKey);
        let writeMayHaveStarted = false;
        try {
          await state.update(protectedKey, sessionString);
          await writeJsonAtomic(recordUri, { ...record, recoveryRequired: true });
          if (
            isDirty(originalUri, resolvedUri) ||
            !(await recoveryTargetPathIsCurrent(target, originalUri, resolvedUri)) ||
            !(await file.isCurrent()) ||
            isDirty(originalUri, resolvedUri)
          ) {
            skipped += 1;
            continue;
          }
          writeMayHaveStarted = true;
          if (!(await file.writeConverted(backupBytes))) {
            writeMayHaveStarted = false;
            skipped += 1;
            continue;
          }
        } finally {
          if (!writeMayHaveStarted) {
            await writeJsonAtomic(recordUri, record);
            await state.update(protectedKey, previousProtection);
          }
        }
        onFileTouched(originalUri);
        await reopenCleanDocument(originalUri, record.sourceEncoding);
        restored += 1;
      } catch {
        failed += 1;
      } finally {
        await file?.dispose();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(t("Failed to read conversion backup: {0}", message));
    return false;
  }

  if (recordCount > 0 && restored + alreadyRestored === recordCount) {
    await state.update(lastKey, undefined);
    if (state.get<string>(protectedKey) === sessionString) {
      await state.update(protectedKey, undefined);
    }
    await deleteStoredBackupSession(context.globalStorageUri, sessionUri.toString());
  } else if (recordCount > 0 && backup.protectSkipped) {
    await state.update(protectedKey, sessionString);
  }
  if (manualRecoveryRequired) {
    void vscode.window.showErrorMessage(
      t(
        "Some files could not be automatically restored safely. Backup data is preserved at {0}.",
        sessionUri.fsPath,
      ),
    );
  }
  const summaryParts = [t("Restored {0} file(s).", restored)];
  if (alreadyRestored > 0) summaryParts.push(t("Already restored: {0}.", alreadyRestored));
  if (skipped > 0) summaryParts.push(t("Skipped (modified or unsaved): {0}.", skipped));
  if (failed > 0) summaryParts.push(t("Failed: {0}.", failed));
  void vscode.window.showInformationMessage(summaryParts.join(" "));
  if (restored > 0) {
    onFilesChanged();
  }
  return restored > 0;
}

async function resolveRecoveryTarget(
  record: BackupRecord,
  originalUri: vscode.Uri,
): Promise<ResolvedRecoveryTarget> {
  if (record.standalone) {
    if (!record.conversionRootUri || !record.resolvedUri) {
      return { standalone: true, manualRecoveryRequired: false };
    }
    const storedRoot = vscode.Uri.parse(record.conversionRootUri);
    const conversionRootRealPath =
      storedRoot.scheme === "file" ? await resolveRealDirectory(storedRoot.fsPath) : undefined;
    if (!conversionRootRealPath) {
      return { standalone: true, manualRecoveryRequired: false };
    }
    const standaloneFile = await resolveStandaloneRegularFile(originalUri.fsPath);
    if (!standaloneFile || standaloneFile.parentRealPath !== conversionRootRealPath) {
      return {
        rootRealPath: conversionRootRealPath,
        conversionRootRealPath,
        standalone: true,
        manualRecoveryRequired: true,
      };
    }
    return {
      rootRealPath: conversionRootRealPath,
      conversionRootRealPath,
      resolvedUri: vscode.Uri.file(standaloneFile.fileRealPath),
      standalone: true,
      manualRecoveryRequired: false,
    };
  }

  const workspaceRootRealPath = await resolveOpenWorkspaceRoot(record, originalUri);
  const storedConversionRoot = record.conversionRootUri
    ? vscode.Uri.parse(record.conversionRootUri)
    : undefined;
  const conversionRootRealPath =
    workspaceRootRealPath && storedConversionRoot
      ? storedConversionRoot.scheme === "file"
        ? await resolveRealPathWithin(workspaceRootRealPath, storedConversionRoot.fsPath)
        : undefined
      : workspaceRootRealPath;
  const resolvedPath = conversionRootRealPath
    ? await resolveRealPathWithin(conversionRootRealPath, originalUri.fsPath)
    : undefined;
  const resolvedUri = resolvedPath ? vscode.Uri.file(resolvedPath) : undefined;
  return {
    rootRealPath: workspaceRootRealPath,
    conversionRootRealPath,
    resolvedUri,
    standalone: false,
    manualRecoveryRequired: Boolean(
      workspaceRootRealPath && conversionRootRealPath && !resolvedUri,
    ),
  };
}

async function recoveryTargetPathIsCurrent(
  target: ResolvedRecoveryTarget,
  originalUri: vscode.Uri,
  resolvedUri: vscode.Uri,
): Promise<boolean> {
  if (!target.conversionRootRealPath) {
    return false;
  }
  if (target.standalone) {
    const resolved = await resolveStandaloneRegularFile(originalUri.fsPath);
    return (
      resolved !== undefined &&
      resolved.parentRealPath === target.conversionRootRealPath &&
      resolved.fileRealPath === resolvedUri.fsPath
    );
  }
  return (
    (await resolveRealPathWithin(target.conversionRootRealPath, originalUri.fsPath)) ===
    resolvedUri.fsPath
  );
}

async function resolveOpenWorkspaceRoot(
  record: BackupRecord,
  originalUri: vscode.Uri,
): Promise<string | undefined> {
  if (!record.workspaceRootUri) {
    const currentOwner = vscode.workspace.getWorkspaceFolder(originalUri);
    return currentOwner?.uri.scheme === "file"
      ? resolveRealDirectory(currentOwner.uri.fsPath)
      : undefined;
  }
  const storedRoot = vscode.Uri.parse(record.workspaceRootUri);
  if (storedRoot.scheme !== "file") {
    return undefined;
  }
  const storedRealPath = await resolveRealDirectory(storedRoot.fsPath);
  if (!storedRealPath) {
    return undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (
      folder.uri.scheme === "file" &&
      (await resolveRealDirectory(folder.uri.fsPath)) === storedRealPath
    ) {
      return storedRealPath;
    }
  }
  return undefined;
}

async function readVerifiedBackup(
  sessionUri: vscode.Uri,
  record: BackupRecord,
): Promise<Uint8Array | undefined> {
  const backup = await readBackupResource(
    vscode.Uri.joinPath(sessionUri, record.backupFile),
    record.originalSize ?? LEGACY_BACKUP_LIMIT,
  );
  return backup && hashBytes(backup.bytes) === record.originalHash
    ? backup.bytes
    : undefined;
}
