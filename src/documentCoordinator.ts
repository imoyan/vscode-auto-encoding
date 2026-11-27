// Serialized document encoding verification, auto-reopen orchestration, diagnostics, and status updates.

import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import {
  ISO2022JP_ENCODING,
  encodingInfo,
  isReopenableEncoding,
  isSupportedEncoding,
} from "./rules.js";
import {
  clearWorkspaceRuleCache,
  configurationFor,
  notifyConfigurationLimit,
  resolveRule,
} from "./workspaceRules.js";
import {
  activeComparisonDocument,
  alignActiveComparison,
  autoReopenWithDetectedEncoding,
  clearAutoReopenFailure,
  clearCleanFileEncodingInspections,
  clearEncodingDetectionCache,
  clearFileEncodingInspection,
  currentFileInspection,
  diagnosticFor,
  disposeClosedDocumentState,
  type FileEncodingInspection,
  forgetManualEncoding,
  hasAutoReopenFailed,
  inspectActiveFile,
  inspectFileDocument,
  isDocumentEncodingMatch,
  isInAutoAlignedComparison,
  isManualEncodingOverride,
  isOpeningDocument,
  markAutoReopenFailed,
  reopenDocumentWithDetectedEncoding,
  reopenWithExpectedEncoding,
  UNCONFIRMED_RULE_MESSAGE,
  updateStatus,
  waitForOpeningDocument,
} from "./editorEncoding.js";

interface QueuedCheck {
  readonly document: vscode.TextDocument;
  readonly allowOpenWarning: boolean;
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return (vscode.workspace.textDocuments ?? []).find(
    (entry) => entry.uri.toString() === uri.toString(),
  );
}

function isVisibleDocument(document: vscode.TextDocument): boolean {
  const key = document.uri.toString();
  if (vscode.window.activeTextEditor?.document.uri.toString() === key) return true;
  return (vscode.window.visibleTextEditors ?? []).some(
    (editor) => editor.document.uri.toString() === key,
  );
}

function documentBasename(document: vscode.TextDocument): string {
  return path.basename(document.fileName || document.uri.fsPath || document.uri.path);
}

/** Coordinates per-document encoding checks, auto-reopen, diagnostics, and status bar updates. */
export class DocumentCoordinator {
  public readonly diagnostics: vscode.DiagnosticCollection;
  public readonly status: vscode.StatusBarItem;
  private readonly diagnosticUris = new Set<string>();
  private readonly pendingOperationUris = new Map<string, vscode.Uri>();
  private readonly reopening = new Set<string>();
  private readonly warned = new Map<string, string>();
  private readonly activeDocumentChecks = new Map<string, Promise<void>>();
  private readonly pendingDocumentChecks = new Map<string, QueuedCheck>();

  public constructor() {
    this.diagnostics = vscode.languages.createDiagnosticCollection("autoEncoding");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "autoEncoding.inspectActiveFile";
  }

  public registerOperationTarget(uri: vscode.Uri): void {
    forgetManualEncoding(uri);
    this.warned.delete(uri.toString());
    this.pendingOperationUris.set(uri.toString(), uri);
  }

  public refreshOperationDocuments(): void {
    const targets = [...this.pendingOperationUris.values()];
    this.pendingOperationUris.clear();
    for (const uri of targets) {
      this.refreshOpenDocumentState(uri);
    }
  }

  public markFilesChanged(
    uri: vscode.Uri,
    options: { deleted?: boolean; recheckOpenDocument?: boolean } = {},
  ): void {
    clearEncodingDetectionCache(uri);
    clearAutoReopenFailure(uri);
    const openDoc = findOpenDocument(uri);
    if (!openDoc?.isDirty) {
      clearFileEncodingInspection(uri);
      if (options.deleted) {
        this.warned.delete(uri.toString());
      }
    }
    if (
      options.recheckOpenDocument !== false &&
      openDoc &&
      !openDoc.isDirty &&
      (isVisibleDocument(openDoc) || this.hasDiagnostic(openDoc.uri))
    ) {
      void this.ensureExpectedEncoding(openDoc, { forceQueue: true });
    }
  }

  public updateDocumentState(document: vscode.TextDocument): void {
    if (document.isClosed) {
      this.clearDocumentDiagnostic(document.uri);
      return;
    }
    if (isVisibleDocument(document) || this.hasDiagnostic(document.uri)) {
      const diagnostic = diagnosticFor(document);
      this.setDocumentDiagnostic(document.uri, diagnostic);
    }
    const activeStatusDoc = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
    if (activeStatusDoc?.uri.toString() === document.uri.toString()) {
      updateStatus(this.status, document);
    }
  }

  public async alignThenRefreshStatus(): Promise<void> {
    try {
      await alignActiveComparison();
      const active = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
      if (active && !active.isClosed) {
        this.updateDocumentState(active);
      } else if (!vscode.window.activeTextEditor) {
        this.status.hide();
      }
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
    }
  }

  public async ensureExpectedEncoding(
    document: vscode.TextDocument,
    options?: { forceQueue?: boolean; allowOpenWarning?: boolean },
  ): Promise<void> {
    try {
      await this.runSerializedDocumentCheck(
        document,
        (target, allowOpenWarning) => this.ensureExpectedEncodingUnchecked(target, allowOpenWarning),
        options,
      );
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
      this.clearDocumentDiagnostic(document.uri);
      if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
        this.status.text = t("Check Encoding Rules");
        this.status.show();
      }
    }
  }

  public handleActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    try {
      if (editor) {
        this.updateDocumentState(editor.document);
        void this.ensureExpectedEncoding(editor.document);
      } else {
        const comparisonDoc = activeComparisonDocument();
        if (comparisonDoc && !comparisonDoc.isClosed) {
          updateStatus(this.status, comparisonDoc);
        } else {
          this.status.hide();
        }
      }
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
    }
  }

  public handleDocumentClosed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.clearDocumentDiagnostic(document.uri);
    if (isOpeningDocument(document.uri)) {
      void waitForOpeningDocument(document.uri).then(() => {
        if (this.reopening.has(key) || isOpeningDocument(document.uri)) return;
        const openAfter = findOpenDocument(document.uri);
        if (!openAfter || openAfter.isClosed) {
          this.cleanupClosedDocument(document.uri);
        }
      });
    } else if (!this.reopening.has(key)) {
      this.cleanupClosedDocument(document.uri);
    }
    try {
      const active = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
      if (!active || active.isClosed) {
        this.status.backgroundColor = undefined;
        this.status.hide();
      }
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
    }
  }

  public handleDocumentSaved(document: vscode.TextDocument): void {
    clearFileEncodingInspection(document.uri);
    clearAutoReopenFailure(document.uri);
    this.markFilesChanged(document.uri, { recheckOpenDocument: false });
    if (isVisibleDocument(document) || this.hasDiagnostic(document.uri)) {
      void this.ensureExpectedEncoding(document, { forceQueue: true });
    }
  }

  public resetForEnvironmentChange(refreshActiveStatus: boolean): void {
    clearWorkspaceRuleCache();
    clearEncodingDetectionCache();
    clearCleanFileEncodingInspections();
    clearAutoReopenFailure();
    this.warned.clear();
    if (refreshActiveStatus) {
      const active = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
      if (active && !active.isClosed) {
        try {
          this.updateDocumentState(active);
        } catch (error) {
          if (!notifyConfigurationLimit(error)) throw error;
        }
      }
    }
    (vscode.workspace.textDocuments ?? []).forEach(
      (document) => void this.ensureExpectedEncoding(document, { forceQueue: true }),
    );
  }

  private hasDiagnostic(uri: vscode.Uri): boolean {
    return typeof this.diagnostics.has === "function"
      ? this.diagnostics.has(uri)
      : this.diagnosticUris.has(uri.toString());
  }

  private setDocumentDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic | undefined): void {
    const key = uri.toString();
    if (diagnostic) {
      this.diagnosticUris.add(key);
      this.diagnostics.set(uri, [diagnostic]);
    } else {
      this.diagnosticUris.delete(key);
      this.diagnostics.delete(uri);
    }
  }

  private clearDocumentDiagnostic(uri: vscode.Uri): void {
    this.diagnosticUris.delete(uri.toString());
    this.diagnostics.delete(uri);
  }

  private cleanupClosedDocument(uri: vscode.Uri): void {
    const key = uri.toString();
    this.clearDocumentDiagnostic(uri);
    this.pendingDocumentChecks.delete(key);
    this.warned.delete(key);
    disposeClosedDocumentState(uri);
  }

  private refreshOpenDocumentState(uri: vscode.Uri): void {
    const openDoc = findOpenDocument(uri);
    if (!openDoc || openDoc.isDirty) return;
    if (isVisibleDocument(openDoc) || this.hasDiagnostic(openDoc.uri)) {
      void this.ensureExpectedEncoding(openDoc, { forceQueue: true });
    }
  }

  private async runSerializedDocumentCheck(
    document: vscode.TextDocument,
    action: (
      target: vscode.TextDocument,
      allowOpenWarning: boolean,
    ) => Promise<(() => Promise<void>) | undefined>,
    options: { forceQueue?: boolean; allowOpenWarning?: boolean } = {},
  ): Promise<void> {
    const key = document.uri.toString();
    const forceQueue = options.forceQueue === true;
    const allowOpenWarning = options.allowOpenWarning !== false;
    if (!forceQueue && (this.reopening.has(key) || isOpeningDocument(document.uri))) return;
    if (this.activeDocumentChecks.has(key)) {
      const existing = this.pendingDocumentChecks.get(key);
      this.pendingDocumentChecks.set(key, {
        document,
        allowOpenWarning: existing ? existing.allowOpenWarning || allowOpenWarning : allowOpenWarning,
      });
      await this.activeDocumentChecks.get(key);
      return;
    }
    while (forceQueue && !this.reopening.has(key) && isOpeningDocument(document.uri)) {
      await waitForOpeningDocument(document.uri);
    }
    if (this.activeDocumentChecks.has(key)) {
      const latest = findOpenDocument(document.uri) ?? document;
      const existing = this.pendingDocumentChecks.get(key);
      this.pendingDocumentChecks.set(key, {
        document: latest,
        allowOpenWarning: existing ? existing.allowOpenWarning || allowOpenWarning : allowOpenWarning,
      });
      await this.activeDocumentChecks.get(key);
      return;
    }
    const toasts: Array<() => Promise<void>> = [];
    const run = (async () => {
      let current: QueuedCheck | undefined = {
        document: findOpenDocument(document.uri) ?? document,
        allowOpenWarning,
      };
      while (current) {
        this.pendingDocumentChecks.delete(key);
        const toast = await action(current.document, current.allowOpenWarning);
        if (toast) toasts.push(toast);
        const queued = this.pendingDocumentChecks.get(key);
        current = queued
          ? {
              document: findOpenDocument(queued.document.uri) ?? queued.document,
              allowOpenWarning: queued.allowOpenWarning,
            }
          : undefined;
      }
    })().finally(() => {
      this.activeDocumentChecks.delete(key);
    });
    this.activeDocumentChecks.set(key, run);
    try {
      await run;
    } finally {
      await Promise.allSettled(toasts.map((fn) => fn()));
    }
  }

  private async ensureExpectedEncodingUnchecked(
    document: vscode.TextDocument,
    allowOpenWarning = true,
    depth = 0,
  ): Promise<(() => Promise<void>) | undefined> {
    if (document.isClosed) {
      this.clearDocumentDiagnostic(document.uri);
      return undefined;
    }
    // Git comparisons keep the expected encoding on both sides (display only, nothing is saved).
    if (
      document.uri.scheme === "git" ||
      isInAutoAlignedComparison(document) ||
      document.uri.scheme !== "file"
    ) {
      await alignActiveComparison(document.uri);
      const currentDoc = findOpenDocument(document.uri) ?? document;
      this.updateDocumentState(currentDoc);
      return undefined;
    }
    if (!isVisibleDocument(document)) {
      this.updateDocumentState(document);
      return undefined;
    }

    const key = document.uri.toString();
    let currentDoc = document;
    let match = resolveRule(currentDoc.uri);
    let inspection: FileEncodingInspection | undefined;
    let skipNormalInspection = false;
    if (match && !isDocumentEncodingMatch(currentDoc, match)) {
      this.updateDocumentState(currentDoc);
      if (this.reopening.has(key) || isOpeningDocument(currentDoc.uri)) {
        return undefined;
      }
      if (isManualEncodingOverride(currentDoc.uri)) {
        if (!currentDoc.isDirty && isVisibleDocument(currentDoc)) {
          await inspectFileDocument(currentDoc);
          currentDoc = findOpenDocument(document.uri) ?? currentDoc;
          if (currentDoc.isClosed) {
            this.clearDocumentDiagnostic(currentDoc.uri);
            return undefined;
          }
          this.updateDocumentState(currentDoc);
        }
        return undefined;
      }

      let ruleInspection: FileEncodingInspection | undefined;
      const initialVersion = currentDoc.version;
      if (!currentDoc.isDirty) {
        ruleInspection = await inspectFileDocument(currentDoc);
        currentDoc = findOpenDocument(document.uri) ?? currentDoc;
        if (currentDoc.isClosed) {
          this.clearDocumentDiagnostic(currentDoc.uri);
          return undefined;
        }
        if (
          !isVisibleDocument(currentDoc) ||
          this.reopening.has(key) ||
          isOpeningDocument(currentDoc.uri) ||
          isManualEncodingOverride(currentDoc.uri)
        ) {
          this.updateDocumentState(currentDoc);
          return undefined;
        }
        match = resolveRule(currentDoc.uri);
        if (!match || isDocumentEncodingMatch(currentDoc, match)) {
          return depth < 1
            ? this.ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
            : undefined;
        }
        this.updateDocumentState(currentDoc);
        ruleInspection = currentFileInspection(currentDoc) ?? ruleInspection;
      } else {
        ruleInspection = currentFileInspection(currentDoc);
      }

      if (ruleInspection?.ruleConfirmed === true) {
        const initialConfig = configurationFor(match.folder);
        const targetEncoding = match.rule.encoding;
        if (
          initialConfig.get("autoReopen", true) &&
          !currentDoc.isDirty &&
          currentDoc.version === initialVersion &&
          !hasAutoReopenFailed(currentDoc.uri, targetEncoding)
        ) {
          const reopened = await this.reopenForRule(currentDoc, targetEncoding, key);
          if (reopened === "handled") return undefined;
          if (reopened) currentDoc = reopened;
        }

        currentDoc = findOpenDocument(document.uri) ?? currentDoc;
        if (currentDoc.isClosed) {
          this.clearDocumentDiagnostic(currentDoc.uri);
          return undefined;
        }
        if (!isVisibleDocument(currentDoc) || isManualEncodingOverride(currentDoc.uri)) {
          this.updateDocumentState(currentDoc);
          return undefined;
        }
        match = resolveRule(currentDoc.uri);
        if (!match || isDocumentEncodingMatch(currentDoc, match)) {
          return depth < 1
            ? this.ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
            : undefined;
        }
        const latestRuleInspection = currentFileInspection(currentDoc) ?? ruleInspection;
        if (!currentDoc.isDirty && latestRuleInspection?.ruleConfirmed !== true) {
          return depth < 1
            ? this.ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
            : undefined;
        }
        this.updateDocumentState(currentDoc);
        return this.buildRuleMismatchToast(currentDoc, match, allowOpenWarning, key);
      }

      if (
        !currentDoc.isDirty &&
        ruleInspection?.ruleConfirmed === false &&
        ruleInspection.status !== "ok"
      ) {
        inspection = ruleInspection;
        skipNormalInspection = true;
      } else {
        return this.buildUnconfirmedRuleToast(currentDoc, match, allowOpenWarning, key);
      }
    }

    if (!skipNormalInspection) {
      if (
        !isVisibleDocument(currentDoc) ||
        this.reopening.has(key) ||
        isOpeningDocument(currentDoc.uri)
      ) {
        this.updateDocumentState(currentDoc);
        return undefined;
      }
      inspection = await inspectFileDocument(currentDoc);
      currentDoc = findOpenDocument(document.uri) ?? currentDoc;
      if (currentDoc.isClosed) {
        this.clearDocumentDiagnostic(currentDoc.uri);
        return undefined;
      }
      if (
        !isVisibleDocument(currentDoc) ||
        this.reopening.has(key) ||
        isOpeningDocument(currentDoc.uri)
      ) {
        this.updateDocumentState(currentDoc);
        return undefined;
      }
      const latestMatchAfterInspect = resolveRule(currentDoc.uri);
      if (
        latestMatchAfterInspect &&
        !isDocumentEncodingMatch(currentDoc, latestMatchAfterInspect) &&
        inspection?.ruleConfirmed !== false
      ) {
        return depth < 1
          ? this.ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
          : undefined;
      }
      this.updateDocumentState(currentDoc);
      if (!inspection || inspection.status === "ok") {
        if (inspection?.status === "ok") this.warned.delete(key);
        return undefined;
      }
      if (isManualEncodingOverride(currentDoc.uri)) {
        return undefined;
      }

      const latestFolder = vscode.workspace.getWorkspaceFolder?.(currentDoc.uri);
      const config = configurationFor(latestMatchAfterInspect?.folder ?? latestFolder ?? currentDoc.uri);
      const canAutoReopenDetected =
        inspection.status === "detectedMismatch" ||
        (inspection.status === "candidateMismatch" && inspection.basis === "guessed");
      if (
        !latestMatchAfterInspect &&
        canAutoReopenDetected &&
        inspection.detectedEncoding &&
        isReopenableEncoding(inspection.detectedEncoding) &&
        config.get("autoReopen", true) &&
        !currentDoc.isDirty &&
        !hasAutoReopenFailed(currentDoc.uri, inspection.detectedEncoding)
      ) {
        const reopened = await this.reopenForDetected(
          currentDoc,
          inspection.detectedEncoding,
          inspection.basis === "guessed" ? "guessed" : "detected",
          key,
        );
        if (reopened) return undefined;
      }

      currentDoc = findOpenDocument(document.uri) ?? currentDoc;
      if (currentDoc.isClosed) {
        this.clearDocumentDiagnostic(currentDoc.uri);
        return undefined;
      }
      this.updateDocumentState(currentDoc);
      if (!isVisibleDocument(currentDoc) || isManualEncodingOverride(currentDoc.uri)) {
        return undefined;
      }
    }

    const afterMatch = resolveRule(currentDoc.uri);
    const afterInspection = currentFileInspection(currentDoc) ?? inspection;
    if (
      afterMatch &&
      !isDocumentEncodingMatch(currentDoc, afterMatch) &&
      afterInspection?.ruleConfirmed !== false
    ) {
      return depth < 1
        ? this.ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
        : undefined;
    }
    if (!afterInspection || afterInspection.status === "ok") {
      if (afterInspection?.status === "ok") this.warned.delete(key);
      return undefined;
    }
    return this.buildInspectionMismatchToast(
      currentDoc,
      afterMatch,
      afterInspection,
      allowOpenWarning,
      key,
    );
  }

  private async reopenForRule(
    currentDoc: vscode.TextDocument,
    targetEncoding: string,
    key: string,
  ): Promise<vscode.TextDocument | "handled" | undefined> {
    this.reopening.add(key);
    const previousEncoding = currentDoc.encoding;
    let updatedDoc: vscode.TextDocument | undefined;
    try {
      const reopened = await vscode.workspace.openTextDocument(currentDoc.uri, {
        encoding: targetEncoding,
      });
      updatedDoc = reopened;
      if (reopened.isClosed) {
        this.clearDocumentDiagnostic(reopened.uri);
        return "handled";
      }
      if (
        reopened.encoding.toLowerCase() !== targetEncoding.toLowerCase() ||
        reopened.encoding.toLowerCase() === previousEncoding.toLowerCase()
      ) {
        markAutoReopenFailed(reopened.uri, targetEncoding);
        return updatedDoc;
      }
      clearFileEncodingInspection(reopened.uri);
      clearAutoReopenFailure(reopened.uri);
      if (isVisibleDocument(reopened)) await inspectFileDocument(reopened);
      if (reopened.isClosed) {
        this.clearDocumentDiagnostic(reopened.uri);
        return "handled";
      }
      this.warned.delete(key);
      this.updateDocumentState(reopened);
      return "handled";
    } catch {
      markAutoReopenFailed(currentDoc.uri, targetEncoding);
      console.error("Auto Encoding: Failed to reopen document.");
      return updatedDoc;
    } finally {
      this.reopening.delete(key);
      const openAfter = findOpenDocument(currentDoc.uri);
      if (!openAfter || openAfter.isClosed) {
        this.cleanupClosedDocument(currentDoc.uri);
      }
    }
  }

  private async reopenForDetected(
    currentDoc: vscode.TextDocument,
    detectedEncoding: string,
    basis: "detected" | "guessed",
    key: string,
  ): Promise<boolean> {
    this.reopening.add(key);
    try {
      const reopened = await autoReopenWithDetectedEncoding(currentDoc, detectedEncoding, basis);
      if (!reopened) return false;
      if (reopened.isClosed) {
        this.cleanupClosedDocument(reopened.uri);
        return true;
      }
      this.warned.delete(key);
      this.updateDocumentState(reopened);
      return true;
    } catch {
      console.error("Auto Encoding: Failed to reopen document.");
      return false;
    } finally {
      this.reopening.delete(key);
      const openAfter = findOpenDocument(currentDoc.uri);
      if (!openAfter || openAfter.isClosed) {
        this.cleanupClosedDocument(currentDoc.uri);
      }
    }
  }

  private buildRuleMismatchToast(
    currentDoc: vscode.TextDocument,
    match: NonNullable<ReturnType<typeof resolveRule>>,
    allowOpenWarning: boolean,
    key: string,
  ): (() => Promise<void>) | undefined {
    const config = configurationFor(match.folder);
    if (!allowOpenWarning || currentDoc.isDirty || !config.get("warnOnOpen", true)) {
      return undefined;
    }
    const warningKey = `${currentDoc.encoding.toLowerCase()}:${match.rule.encoding.toLowerCase()}`;
    if (this.warned.get(key) === warningKey) {
      return undefined;
    }
    this.warned.set(key, warningKey);
    const action = t("Reopen with Expected Encoding");
    const notice = vscode.window.showWarningMessage(
      t(
        "{0} is open as {1}. The configured encoding rule is {2}.",
        documentBasename(currentDoc),
        encodingInfo(currentDoc.encoding).label,
        encodingInfo(match.rule.encoding).label,
      ),
      action,
    );
    return async () => {
      if ((await notice) !== action) return;
      const targetDoc = findOpenDocument(currentDoc.uri) ?? currentDoc;
      if (targetDoc.isClosed) return;
      const latestMatch = resolveRule(targetDoc.uri);
      if (!latestMatch || isDocumentEncodingMatch(targetDoc, latestMatch)) {
        this.warned.delete(key);
        this.updateDocumentState(targetDoc);
        return;
      }
      await reopenWithExpectedEncoding(targetDoc, latestMatch);
      const updatedDoc = findOpenDocument(currentDoc.uri) ?? targetDoc;
      if (updatedDoc.isClosed) {
        this.clearDocumentDiagnostic(updatedDoc.uri);
        return;
      }
      if (
        currentFileInspection(updatedDoc)?.status === "ok" &&
        isDocumentEncodingMatch(updatedDoc, latestMatch)
      ) {
        this.warned.delete(key);
      }
      this.updateDocumentState(updatedDoc);
    };
  }

  private buildUnconfirmedRuleToast(
    currentDoc: vscode.TextDocument,
    match: NonNullable<ReturnType<typeof resolveRule>>,
    allowOpenWarning: boolean,
    key: string,
  ): (() => Promise<void>) | undefined {
    const config = configurationFor(match.folder);
    if (!allowOpenWarning || currentDoc.isDirty || !config.get("warnOnOpen", true)) {
      return undefined;
    }
    const warningKey = `unconfirmed:${currentDoc.encoding.toLowerCase()}:${match.rule.encoding.toLowerCase()}`;
    if (this.warned.get(key) === warningKey) {
      return undefined;
    }
    this.warned.set(key, warningKey);
    const targetRuleEncoding = match.rule.encoding;
    const convertAction = isSupportedEncoding(targetRuleEncoding)
      ? t("Convert to {0} and Save", encodingInfo(targetRuleEncoding).label)
      : undefined;
    const message = `${documentBasename(currentDoc)}: ${UNCONFIRMED_RULE_MESSAGE}`;
    const notice = convertAction
      ? vscode.window.showWarningMessage(message, convertAction)
      : vscode.window.showWarningMessage(message);
    return async () => {
      if (!convertAction || (await notice) !== convertAction) return;
      const targetDoc = findOpenDocument(currentDoc.uri) ?? currentDoc;
      if (targetDoc.isClosed) return;
      const latestMatch = resolveRule(targetDoc.uri);
      if (!latestMatch || isDocumentEncodingMatch(targetDoc, latestMatch)) {
        this.warned.delete(key);
        this.updateDocumentState(targetDoc);
        return;
      }
      await vscode.commands.executeCommand(
        "autoEncoding.convertFile",
        targetDoc.uri,
        latestMatch.rule.encoding,
      );
    };
  }

  private buildInspectionMismatchToast(
    currentDoc: vscode.TextDocument,
    afterMatch: ReturnType<typeof resolveRule>,
    afterInspection: FileEncodingInspection,
    allowOpenWarning: boolean,
    key: string,
  ): (() => Promise<void>) | undefined {
    const afterFolder = vscode.workspace.getWorkspaceFolder?.(currentDoc.uri);
    const afterConfig = configurationFor(afterMatch?.folder ?? afterFolder ?? currentDoc.uri);
    if (!allowOpenWarning || currentDoc.isDirty || !afterConfig.get("warnOnOpen", true)) {
      return undefined;
    }
    const warningKey = `${currentDoc.encoding.toLowerCase()}:${afterMatch?.rule.encoding.toLowerCase() ?? ""}:${afterInspection.ruleConfirmed ?? ""}:${afterInspection.status}:${afterInspection.detectedEncoding?.toLowerCase() ?? ""}:${afterInspection.candidates?.join(",") ?? ""}`;
    if (this.warned.get(key) === warningKey) {
      return undefined;
    }
    this.warned.set(key, warningKey);

    const filename = documentBasename(currentDoc);
    const currentLabel = encodingInfo(currentDoc.encoding).label;
    const ruleMismatchedOnNotice = !!afterMatch && !isDocumentEncodingMatch(currentDoc, afterMatch);
    const expectedRuleLabel = afterMatch ? encodingInfo(afterMatch.rule.encoding).label : undefined;

    if (afterInspection.status === "detectedMismatch" && afterInspection.detectedEncoding) {
      const detectedEncoding = afterInspection.detectedEncoding;
      const detectedLabel = encodingInfo(detectedEncoding).label;
      if (detectedEncoding.toLowerCase() === ISO2022JP_ENCODING) {
        const convertAction = t("Convert to UTF-8, etc. and Save");
        const message = t(
          "{0} is {1}. VS Code does not open this encoding natively; you can convert and save it as UTF-8, Shift JIS, etc.",
          filename,
          detectedLabel,
        );
        const notice = vscode.window.showWarningMessage(message, convertAction);
        return async () => {
          if ((await notice) !== convertAction) return;
          const targetDoc = findOpenDocument(currentDoc.uri) ?? currentDoc;
          if (targetDoc.isClosed) return;
          await vscode.commands.executeCommand("autoEncoding.convertFile", targetDoc.uri);
        };
      }
      const action = t("Reopen as {0}", detectedLabel);
      const message = afterMatch
        ? ruleMismatchedOnNotice
          ? t(
              "{0} is open as {1} (rule: {2}), but its saved bytes appear to be {3}.",
              filename,
              currentLabel,
              expectedRuleLabel!,
              detectedLabel,
            )
          : t(
              "{0} is open with the configured encoding {1}, but its saved bytes appear to be {2}.",
              filename,
              currentLabel,
              detectedLabel,
            )
        : t(
            "{0} is open as {1}, but its saved bytes appear to be {2}.",
            filename,
            currentLabel,
            detectedLabel,
          );
      const notice = vscode.window.showWarningMessage(message, action);
      return async () => {
        if ((await notice) !== action) return;
        const targetDoc = findOpenDocument(currentDoc.uri) ?? currentDoc;
        if (targetDoc.isClosed) return;
        if (targetDoc.isDirty) {
          await reopenDocumentWithDetectedEncoding(targetDoc, detectedEncoding, Boolean(afterMatch));
          return;
        }
        clearEncodingDetectionCache(targetDoc.uri);
        clearFileEncodingInspection(targetDoc.uri);
        const latestMatch = resolveRule(targetDoc.uri);
        const latestInspection = await inspectFileDocument(targetDoc);
        const latestDoc = findOpenDocument(currentDoc.uri) ?? targetDoc;
        if (latestDoc.isClosed) {
          this.clearDocumentDiagnostic(latestDoc.uri);
          return;
        }
        if (
          !latestInspection ||
          latestInspection.status !== "detectedMismatch" ||
          latestInspection.detectedEncoding?.toLowerCase() !== detectedEncoding.toLowerCase()
        ) {
          this.warned.delete(key);
          this.updateDocumentState(latestDoc);
          if (
            isVisibleDocument(latestDoc) &&
            (latestInspection?.status !== "ok" ||
              (latestMatch && !isDocumentEncodingMatch(latestDoc, latestMatch)))
          ) {
            void this.ensureExpectedEncoding(latestDoc, { forceQueue: true });
          }
          return;
        }
        const reopened = await reopenDocumentWithDetectedEncoding(
          latestDoc,
          detectedEncoding,
          Boolean(latestMatch),
        );
        const updatedDoc = reopened ?? findOpenDocument(currentDoc.uri) ?? latestDoc;
        if (updatedDoc.isClosed) {
          this.clearDocumentDiagnostic(updatedDoc.uri);
          return;
        }
        this.updateDocumentState(updatedDoc);
      };
    }

    // Do not show a toast for ambiguous files with multiple candidates; surface quietly in the status bar.
    if (afterInspection.status === "candidateMismatch") {
      return undefined;
    }

    const action = t("Inspect and Reopen");
    const message = afterMatch
      ? ruleMismatchedOnNotice
        ? t(
            "{0} could not be decoded without loss using either the current encoding ({1}) or the configured rule ({2}).",
            filename,
            currentLabel,
            expectedRuleLabel!,
          )
        : t(
            "{0} could not be decoded without loss using the configured encoding ({1}).",
            filename,
            currentLabel,
          )
      : t(
          "{0} could not be decoded without loss using the current encoding ({1}).",
          filename,
          currentLabel,
        );
    const notice = vscode.window.showWarningMessage(message, action);
    return async () => {
      if ((await notice) !== action) return;
      const targetDoc = findOpenDocument(currentDoc.uri) ?? currentDoc;
      if (targetDoc.isClosed) return;
      if (
        vscode.window.activeTextEditor?.document.uri.toString() !== targetDoc.uri.toString() &&
        typeof vscode.window.showTextDocument === "function"
      ) {
        await vscode.window.showTextDocument(targetDoc, { preserveFocus: false });
      }
      const activeDoc = findOpenDocument(currentDoc.uri) ?? targetDoc;
      if (activeDoc.isClosed) {
        this.clearDocumentDiagnostic(activeDoc.uri);
        return;
      }
      await inspectActiveFile();
      const updatedDoc = findOpenDocument(currentDoc.uri) ?? activeDoc;
      if (updatedDoc.isClosed) {
        this.clearDocumentDiagnostic(updatedDoc.uri);
        return;
      }
      if (currentFileInspection(updatedDoc)?.status === "ok") {
        this.warned.delete(key);
      }
      this.updateDocumentState(updatedDoc);
    };
  }
}
