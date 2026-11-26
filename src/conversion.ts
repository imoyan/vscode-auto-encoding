import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import {
  ConversionOperationGate,
  ConversionTargetWriteError,
  conversionBackupDisposition,
  protectedConversionSession,
  writeConversionIfCurrent,
} from "./conversionCore.js";
import {
  LAST_BACKUP_KEY,
  PROTECTED_BACKUP_KEY,
  type BackupRecord,
  activeConversionState,
  isConversionBackupSession,
  pruneEmptyWindowBackups,
  writeJsonAtomic,
  deleteIfPresent,
  deleteStoredBackupSession,
} from "./conversionBackup.js";
import { selectConversion, type ConversionCandidate } from "./conversionSelection.js";
import { restoreLastConversion } from "./conversionRecovery.js";
import { prepareConversion, isDirty, hashBytes, reopenCleanDocument } from "./conversionResources.js";
import { encodingInfo } from "./rules.js";
import { PinnedLocalFile } from "./pinnedLocalFile.js";
import { resolveRealPathWithin, resolveStandaloneRegularFile } from "./localPathSafety.js";

interface ConversionCounts {
  converted: number;
  skippedChanged: number;
  skippedDirty: number;
  failed: number;
}

interface ConversionCompletion {
  readonly message: string;
  readonly backupSession: string;
  readonly converted: boolean;
  readonly recoveryRequiredPaths: readonly string[];
  readonly backupManagementFailed: boolean;
  readonly pointerRollbackFailed: boolean;
}

interface ConversionRunResult {
  readonly counts: ConversionCounts;
  readonly backupSession: string;
  readonly recoveryRequiredPaths: readonly string[];
  readonly backupManagementFailed: boolean;
  readonly pointerRollbackFailed: boolean;
}

interface PointerRollback {
  readonly state: vscode.Memento;
  readonly failedSession: string;
  readonly previousSession: string | undefined;
  readonly protectedPreviousSession: string | undefined;
}

export class ConversionManager {
  private readonly operationGate = new ConversionOperationGate();
  private pendingPointerRollback: PointerRollback | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly expectedEncodingFor: (uri: vscode.Uri) => string | undefined,
    private readonly configurationFor: (
      scope: vscode.ConfigurationScope,
    ) => vscode.WorkspaceConfiguration,
    private readonly onFilesChanged: () => void = () => undefined,
    private readonly onFileTouched: (uri: vscode.Uri) => void = () => undefined,
  ) {}

  public async notifyProtectedConversion(): Promise<void> {
    const state = activeConversionState(this.context);
    const stored = protectedConversionSession(
      state.get<unknown>(LAST_BACKUP_KEY),
      state.get<unknown>(PROTECTED_BACKUP_KEY),
    );
    if (!stored) {
      return;
    }
    let sessionUri: vscode.Uri;
    try {
      sessionUri = vscode.Uri.parse(stored);
    } catch {
      void vscode.window.showWarningMessage(
        t("The previous conversion may not have completed, and the backup location could not be verified."),
      );
      return;
    }
    if (!(await isConversionBackupSession(this.context.globalStorageUri, sessionUri))) {
      void vscode.window.showWarningMessage(
        t("The previous conversion may not have completed, and the backup location is invalid."),
      );
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(sessionUri);
      if (stat.type !== vscode.FileType.Directory) {
        throw new Error("not a directory");
      }
    } catch {
      void vscode.window.showWarningMessage(
        t("The previous conversion may not have completed, and the backup at {0} could not be accessed.", sessionUri.fsPath),
      );
      return;
    }
    const action = t("Review Restore");
    const selected = await vscode.window.showWarningMessage(
      t("The previous conversion may not have completed. Backup: {0}", sessionUri.fsPath),
      action,
    );
    if (selected === action) {
      await this.undoBackupSession(stored);
    }
  }

  public async convertFolder(
    suppliedUri?: vscode.Uri,
    suppliedTargetEncoding?: string,
  ): Promise<boolean> {
    return this.convert(suppliedUri, suppliedTargetEncoding, "folder");
  }

  public async convertFile(
    uri?: vscode.Uri,
    suppliedTargetEncoding?: string,
  ): Promise<boolean> {
    return this.convert(uri, suppliedTargetEncoding, "file");
  }

  private async convert(
    suppliedUri: vscode.Uri | undefined,
    suppliedTargetEncoding: string | undefined,
    scope: "folder" | "file",
  ): Promise<boolean> {
    const completion = await this.runExclusive(
      () => this.convertExclusive(suppliedUri, suppliedTargetEncoding, scope),
    );
    if (!completion) {
      return false;
    }
    if (completion.pointerRollbackFailed) {
      const action = t("Undo");
      const expectedSession = this.undoTarget();
      const warning = expectedSession
        ? vscode.window.showWarningMessage(completion.message, action)
        : vscode.window.showWarningMessage(completion.message);
      void warning.then(
        (result) => {
          if (result === action && expectedSession) {
            void this.undoBackupSession(expectedSession);
          }
        },
        () => undefined,
      );
      return false;
    }
    const action =
      completion.recoveryRequiredPaths.length > 0
        ? t("Try Restoring from Backup")
        : t("Undo");
    const notification =
      completion.recoveryRequiredPaths.length > 0
        ? vscode.window.showWarningMessage(
            `${completion.message}\n\n` +
              t(
                "{0} failed both writing and immediate recovery. Backup data is preserved at {1}.",
                completion.recoveryRequiredPaths.join(", "),
                vscode.Uri.parse(completion.backupSession).fsPath,
              ),
            { modal: true },
            action,
          )
        : completion.backupManagementFailed
          ? vscode.window.showWarningMessage(completion.message, action)
          : vscode.window.showInformationMessage(completion.message, action);
    void notification.then(
      (result) => {
        if (result === action) {
          void this.undoBackupSession(completion.backupSession);
        }
      },
      () => undefined,
    );
    return completion.converted;
  }

  private async convertExclusive(
    suppliedUri: vscode.Uri | undefined,
    suppliedTargetEncoding: string | undefined,
    scope: "folder" | "file",
  ): Promise<ConversionCompletion | undefined> {
    const selection = await selectConversion(
      this.context,
      (uri) => this.expectedEncodingFor(uri),
      (cfgScope) => this.configurationFor(cfgScope),
      suppliedUri,
      suppliedTargetEncoding,
      scope,
    );
    if (!selection) return undefined;
    const { selected, targetEncoding, targetLineEnding } = selection;
    const conversion = await this.performConversion(
      selected,
      targetEncoding,
      targetLineEnding,
    );
    const counts = conversion.counts;
    if (
      counts.converted === 0 &&
      conversion.recoveryRequiredPaths.length === 0 &&
      conversion.pointerRollbackFailed
    ) {
      const previous = this.pendingPointerRollback?.previousSession;
      return {
        message:
          t(
            "Conversion failed. Changed: {0}, Unsaved: {1}, Failed: {2}. Could not save backup metadata.",
            counts.skippedChanged,
            counts.skippedDirty,
            counts.failed,
          ) +
          (previous
            ? ` ${t("Undo will target the previous conversion. Previous backup is preserved at {0}.", vscode.Uri.parse(previous).fsPath)}`
            : ""),
        backupSession: conversion.backupSession,
        converted: false,
        recoveryRequiredPaths: [],
        backupManagementFailed: true,
        pointerRollbackFailed: true,
      };
    }
    if (counts.converted === 0 && conversion.recoveryRequiredPaths.length === 0) {
      void vscode.window.showWarningMessage(
        t(
          "Conversion failed. Changed: {0}, Unsaved: {1}, Failed: {2}.",
          counts.skippedChanged,
          counts.skippedDirty,
          counts.failed,
        ),
      );
      return undefined;
    }
    this.onFilesChanged();
    const convertedSummary =
      targetEncoding === "auto" && targetLineEnding
        ? t(
            "Converted line endings to {0} in {1} file(s).",
            targetLineEnding.toUpperCase(),
            counts.converted,
          )
        : targetLineEnding
          ? t(
              "Converted {0} file(s) to {1} ({2}).",
              counts.converted,
              encodingInfo(targetEncoding).label,
              targetLineEnding.toUpperCase(),
            )
          : t(
              "Converted {0} file(s) to {1}.",
              counts.converted,
              encodingInfo(targetEncoding).label,
            );
    return {
      message:
        convertedSummary +
        skippedSummary(counts) +
        (conversion.backupManagementFailed
          ? ` ${t("Could not save backup metadata. Backup data is preserved; please verify restore target.")}`
          : ""),
      backupSession: conversion.backupSession,
      converted: counts.converted > 0,
      recoveryRequiredPaths: conversion.recoveryRequiredPaths,
      backupManagementFailed: conversion.backupManagementFailed,
      pointerRollbackFailed: false,
    };
  }

  public async undoLastConversion(): Promise<boolean> {
    return (
      (await this.runExclusive(async () => {
        await this.repairPendingPointerRollback();
        const state = activeConversionState(this.context);
        return restoreLastConversion(
          this.context,
          () => this.onFilesChanged(),
          this.undoTarget(state) ?? null,
          (uri) => this.onFileTouched(uri),
          undefined,
          state,
        );
      })) ?? false
    );
  }

  private async undoBackupSession(expectedSession: string): Promise<boolean> {
    return (
      (await this.runExclusive(async () => {
        await this.repairPendingPointerRollback();
        const state = activeConversionState(this.context);
        if (this.undoTarget(state) !== expectedSession) {
          void vscode.window.showInformationMessage(
            t("Another conversion occurred after this notification, so the older conversion was not undone."),
          );
          return false;
        }
        return restoreLastConversion(
          this.context,
          () => this.onFilesChanged(),
          expectedSession,
          (uri) => this.onFileTouched(uri),
          undefined,
          state,
        );
      })) ?? false
    );
  }

  private undoTarget(
    state: vscode.Memento = activeConversionState(this.context),
  ): string | undefined {
    const last = state.get<string>(LAST_BACKUP_KEY);
    const pending = this.pendingPointerRollback;
    return pending && pending.state === state && last === pending.failedSession
      ? pending.previousSession
      : last;
  }

  private async repairPendingPointerRollback(): Promise<void> {
    if (this.pendingPointerRollback) {
      await this.rollbackPointers(this.pendingPointerRollback);
    }
  }

  private async rollbackPointers(rollback: PointerRollback): Promise<boolean> {
    const { state } = rollback;
    let saved = true;
    if (state.get<string>(LAST_BACKUP_KEY) === rollback.failedSession) {
      try {
        await state.update(LAST_BACKUP_KEY, rollback.previousSession);
      } catch {
        saved = false;
      }
    }
    const last = state.get<string>(LAST_BACKUP_KEY);
    const protectedTarget =
      last === rollback.failedSession || last === rollback.previousSession
        ? rollback.protectedPreviousSession
        : undefined;
    const protectedNow = state.get<string>(PROTECTED_BACKUP_KEY);
    if (
      (protectedNow === rollback.failedSession || protectedNow === undefined) &&
      protectedNow !== protectedTarget
    ) {
      try {
        await state.update(PROTECTED_BACKUP_KEY, protectedTarget);
      } catch {
        saved = false;
      }
    }
    const referenced =
      state.get<string>(LAST_BACKUP_KEY) === rollback.failedSession ||
      state.get<string>(PROTECTED_BACKUP_KEY) === rollback.failedSession;
    this.pendingPointerRollback = saved && !referenced ? undefined : rollback;
    if (!referenced) {
      try {
        await deleteStoredBackupSession(this.context.globalStorageUri, rollback.failedSession);
      } catch {
        // An unreferenced empty session is only leftover storage.
      }
    }
    return saved && !referenced;
  }

  private async performConversion(
    candidates: readonly ConversionCandidate[],
    targetEncoding: string,
    targetLineEnding?: "lf" | "crlf",
  ): Promise<ConversionRunResult> {
    await this.repairPendingPointerRollback();
    const state = activeConversionState(this.context);
    const stuck =
      this.pendingPointerRollback &&
      this.pendingPointerRollback.state === state &&
      state.get<string>(LAST_BACKUP_KEY) === this.pendingPointerRollback.failedSession
        ? this.pendingPointerRollback
        : undefined;
    const previousSession = stuck
      ? stuck.previousSession
      : state.get<string>(LAST_BACKUP_KEY);
    const protectedPreviousSession = stuck
      ? stuck.protectedPreviousSession
      : state.get<string>(PROTECTED_BACKUP_KEY);
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const sessionUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      "conversion-backups",
      `${timestamp}-${randomUUID()}`,
    );
    await vscode.workspace.fs.createDirectory(sessionUri);
    if (!(await isConversionBackupSession(this.context.globalStorageUri, sessionUri))) {
      throw new Error(t("Could not safely verify the backup location. Conversion was not started."));
    }
    let backupRegistered = false;
    let recoveryRequired = false;
    const recoveryRequiredPaths: string[] = [];

    const progressTitle =
      targetEncoding === "auto"
        ? t("Converting line endings ({0})", targetLineEnding?.toUpperCase() ?? "")
        : t("Converting to {0}", encodingInfo(targetEncoding).label);
    const counts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: progressTitle,
        cancellable: false,
      },
      async (progress) => {
        const counts: ConversionCounts = {
          converted: 0,
          skippedChanged: 0,
          skippedDirty: 0,
          failed: 0,
        };
        for (const [index, candidate] of candidates.entries()) {
          progress.report({
            increment: candidates.length === 0 ? 100 : 100 / candidates.length,
            message: `${index + 1}/${candidates.length} ${candidate.relativePath}`,
          });
          if (isDirty(candidate.uri, candidate.writeUri)) {
            counts.skippedDirty += 1;
            continue;
          }
          let file: PinnedLocalFile | undefined;
          try {
            if (!(await candidatePathIsCurrent(candidate))) {
              counts.skippedChanged += 1;
              continue;
            }
            file = await PinnedLocalFile.open(
              candidate.workspaceRootRealPath,
              candidate.writeUri.fsPath,
              candidate.maxSize,
              true,
            );
            const read = file?.read;
            if (
              !file ||
              !read ||
              read.identity !== candidate.originalIdentity ||
              isDirty(candidate.uri, candidate.writeUri) ||
              read.contentHash !== candidate.originalHash
            ) {
              counts.skippedChanged += 1;
              continue;
            }
            const original = read.bytes;
            const prepared = await prepareConversion(
              original,
              candidate.sourceEncoding,
              candidate.targetEncoding,
              undefined,
              targetLineEnding,
            );
            if (!prepared) {
              counts.skippedChanged += 1;
              continue;
            }
            if (isDirty(candidate.uri, candidate.writeUri) || !(await file.isCurrent())) {
              counts.skippedChanged += 1;
              continue;
            }
            const serial = String(index + 1).padStart(6, "0");
            const backupFile = `${serial}.bin`;
            const backupUri = vscode.Uri.joinPath(sessionUri, backupFile);
            const recordUri = vscode.Uri.joinPath(sessionUri, `${serial}.json`);
            const record: BackupRecord = {
              version: 1,
              originalUri: candidate.uri.toString(),
              resolvedUri: candidate.writeUri.toString(),
              conversionRootUri: vscode.Uri.file(candidate.conversionRootRealPath).toString(),
              ...(candidate.standalone
                ? { standalone: true }
                : {
                    workspaceRootUri: vscode.Uri.file(candidate.workspaceRootRealPath).toString(),
                  }),
              relativePath: candidate.relativePath,
              backupFile,
              originalHash: candidate.originalHash,
              convertedHash: hashBytes(prepared.converted),
              originalSize: original.byteLength,
              convertedSize: prepared.converted.byteLength,
              recoveryRequired: false,
              sourceEncoding: candidate.sourceEncoding,
              targetEncoding: candidate.targetEncoding,
            };
            const written = await writeConversionIfCurrent({
              writeBackup: async () => vscode.workspace.fs.writeFile(backupUri, original),
              writeRecord: async () => writeJsonAtomic(recordUri, record),
              isCurrent: async () =>
                (await candidatePathIsCurrent(candidate)) &&
                !isDirty(candidate.uri, candidate.writeUri) &&
                (await file!.isCurrent()),
              registerBackup: async () => {
                if (!backupRegistered) {
                  await state.update(LAST_BACKUP_KEY, sessionUri.toString());
                  backupRegistered = true;
                }
              },
              markTargetStarted: async () => {
                await state.update(PROTECTED_BACKUP_KEY, sessionUri.toString());
                await writeJsonAtomic(recordUri, { ...record, recoveryRequired: true });
              },
              writeTarget: async () => file!.writeConverted(prepared.converted),
              recoverTarget: async () => {
                throw new Error("Retaining backup because immediate recovery cannot be guaranteed safely.");
              },
              markTargetCompleted: async () => {
                await writeJsonAtomic(recordUri, record);
                if (state.get<string>(PROTECTED_BACKUP_KEY) === sessionUri.toString()) {
                  await state.update(PROTECTED_BACKUP_KEY, undefined);
                }
              },
              cleanupBackup: async () => {
                await deleteIfPresent(recordUri);
                await deleteIfPresent(backupUri);
              },
            });
            if (!written) {
              counts.skippedChanged += 1;
              continue;
            }
            this.onFileTouched(candidate.uri);
            await reopenCleanDocument(candidate.uri, candidate.targetEncoding);
            counts.converted += 1;
          } catch (error) {
            if (error instanceof ConversionTargetWriteError && error.recoveryFailed) {
              recoveryRequired = true;
              recoveryRequiredPaths.push(candidate.relativePath);
              counts.failed += 1;
              break;
            }
            counts.failed += 1;
          } finally {
            await file?.dispose();
          }
        }
        return counts;
      },
    );
    let backupManagementFailed = false;
    let pointerRollbackFailed = false;
    try {
      const disposition = conversionBackupDisposition(
        counts.converted,
        recoveryRequired,
        backupRegistered,
      );
      if (disposition === "keepNewAndDeletePrevious") {
        if (previousSession !== protectedPreviousSession) {
          await deleteStoredBackupSession(this.context.globalStorageUri, previousSession);
        }
        await pruneEmptyWindowBackups(this.context);
      } else if (disposition === "restorePreviousAndDeleteNew") {
        pointerRollbackFailed = !(await this.rollbackPointers({
          state,
          failedSession: sessionUri.toString(),
          previousSession,
          protectedPreviousSession,
        }));
      } else if (disposition === "deleteUnusedNew") {
        await deleteStoredBackupSession(this.context.globalStorageUri, sessionUri.toString());
      }
      if (recoveryRequired) {
        await state.update(PROTECTED_BACKUP_KEY, sessionUri.toString());
      } else if (counts.converted > 0 && protectedPreviousSession === previousSession) {
        await state.update(PROTECTED_BACKUP_KEY, undefined);
      }
    } catch {
      backupManagementFailed = true;
    }
    return {
      counts,
      backupSession: sessionUri.toString(),
      recoveryRequiredPaths,
      backupManagementFailed,
      pointerRollbackFailed,
    };
  }

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const release = this.operationGate.enter();
    if (!release) {
      void vscode.window.showInformationMessage(
        t("An encoding conversion or restore is already in progress. Please wait until it finishes."),
      );
      return undefined;
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function candidatePathIsCurrent(candidate: ConversionCandidate): Promise<boolean> {
  if (candidate.standalone) {
    const resolved = await resolveStandaloneRegularFile(candidate.uri.fsPath);
    return (
      resolved !== undefined &&
      resolved.parentRealPath === candidate.conversionRootRealPath &&
      resolved.fileRealPath === candidate.writeUri.fsPath
    );
  }
  return (
    (await resolveRealPathWithin(candidate.conversionRootRealPath, candidate.uri.fsPath)) ===
    candidate.writeUri.fsPath
  );
}

function skippedSummary(counts: ConversionCounts): string {
  const messages: string[] = [];
  if (counts.skippedChanged > 0) {
    messages.push(t("changed {0}", counts.skippedChanged));
  }
  if (counts.skippedDirty > 0) {
    messages.push(t("unsaved {0}", counts.skippedDirty));
  }
  if (counts.failed > 0) {
    messages.push(t("failed {0}", counts.failed));
  }
  return messages.length > 0 ? ` ${t("Skipped: {0}.", messages.join(", "))}` : "";
}
