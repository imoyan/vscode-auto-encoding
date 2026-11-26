import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { SerialTaskQueue } from "./coalescingTask.js";
import { ConversionManager } from "./conversion.js";
import { encodingInfo, isSupportedEncoding } from "./rules.js";
import {
  CONFIGURATION_SECTION,
  clearWorkspaceRuleCache,
  configurationFor,
  notifyConfigurationLimit,
  resolveRule,
} from "./workspaceRules.js";
import { EncodingDecorationProvider } from "./ruleDecorations.js";
import {
  activeComparisonDocument,
  alignActiveComparison,
  autoReopenWithDetectedEncoding,
  clearAutoReopenFailure,
  clearCleanFileEncodingInspections,
  clearEncodingDetectionCache,
  clearFileEncodingInspection,
  countReplacementCharacters,
  currentFileInspection,
  diagnosticFor,
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
import { configureFolder } from "./ruleCommands.js";

export function activate(context: vscode.ExtensionContext): void {
  const pendingOperationUris = new Map<string, vscode.Uri>();
  const decorationProvider = new EncodingDecorationProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection("autoEncoding");
  const diagnosticUris = new Set<string>();
  const hasDiagnostic = (uri: vscode.Uri): boolean =>
    typeof diagnostics.has === "function" ? diagnostics.has(uri) : diagnosticUris.has(uri.toString());
  const setDocumentDiagnostic = (uri: vscode.Uri, diagnostic: vscode.Diagnostic | undefined): void => {
    const key = uri.toString();
    if (diagnostic) {
      diagnosticUris.add(key);
      diagnostics.set(uri, [diagnostic]);
    } else {
      diagnosticUris.delete(key);
      diagnostics.delete(uri);
    }
  };
  const clearDocumentDiagnostic = (uri: vscode.Uri): void => {
    diagnosticUris.delete(uri.toString());
    diagnostics.delete(uri);
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = "autoEncoding.inspectActiveFile";
  const reopening = new Set<string>();
  const warned = new Map<string, string>();
  let refreshOperationDocuments = (): void => undefined;

  const conversionManager = new ConversionManager(
    context,
    (uri) => resolveRule(uri)?.rule.encoding,
    (scope) => configurationFor(scope),
    () => refreshOperationDocuments(),
    (uri) => {
      forgetManualEncoding(uri);
      warned.delete(uri.toString());
      pendingOperationUris.set(uri.toString(), uri);
    },
  );

  const settingsQueue = new SerialTaskQueue();

  const findOpenDocument = (uri: vscode.Uri): vscode.TextDocument | undefined =>
    (vscode.workspace.textDocuments ?? []).find((entry) => entry.uri.toString() === uri.toString());
  const isVisibleDocument = (document: vscode.TextDocument): boolean => {
    const key = document.uri.toString();
    if (vscode.window.activeTextEditor?.document.uri.toString() === key) return true;
    return (vscode.window.visibleTextEditors ?? []).some(
      (editor) => editor.document.uri.toString() === key,
    );
  };
  const documentBasename = (document: vscode.TextDocument): string =>
    path.basename(document.fileName || document.uri.fsPath || document.uri.path);

  const files = vscode.workspace.createFileSystemWatcher("**/*");
  const markFilesChanged = (
    uri: vscode.Uri,
    options: { deleted?: boolean; recheckOpenDocument?: boolean } = {},
  ): void => {
    clearEncodingDetectionCache(uri);
    clearAutoReopenFailure(uri);
    const openDoc = findOpenDocument(uri);
    if (!openDoc?.isDirty) {
      clearFileEncodingInspection(uri);
      if (options.deleted) {
        warned.delete(uri.toString());
      }
    }
    if (
      options.recheckOpenDocument !== false &&
      openDoc &&
      !openDoc.isDirty &&
      (isVisibleDocument(openDoc) || hasDiagnostic(openDoc.uri))
    ) {
      void ensureExpectedEncoding(openDoc, { forceQueue: true });
    }
  };
  context.subscriptions.push(
    files,
    files.onDidChange((uri) => markFilesChanged(uri)),
    files.onDidCreate((uri) => markFilesChanged(uri)),
    files.onDidDelete((uri) => markFilesChanged(uri, { deleted: true })),
  );

  const updateDocumentState = (document: vscode.TextDocument): void => {
    if (document.isClosed) {
      clearDocumentDiagnostic(document.uri);
      return;
    }
    if (isVisibleDocument(document) || hasDiagnostic(document.uri)) {
      const diagnostic = diagnosticFor(document);
      setDocumentDiagnostic(document.uri, diagnostic);
    }
    const activeStatusDoc = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
    if (activeStatusDoc?.uri.toString() === document.uri.toString()) {
      updateStatus(status, document);
    }
  };

  interface QueuedCheck {
    readonly document: vscode.TextDocument;
    readonly allowOpenWarning: boolean;
  }
  const activeDocumentChecks = new Map<string, Promise<void>>();
  const pendingDocumentChecks = new Map<string, QueuedCheck>();

  const runSerializedDocumentCheck = async (
    document: vscode.TextDocument,
    action: (
      target: vscode.TextDocument,
      allowOpenWarning: boolean,
    ) => Promise<(() => Promise<void>) | undefined>,
    options: { forceQueue?: boolean; allowOpenWarning?: boolean } = {},
  ): Promise<void> => {
    const key = document.uri.toString();
    const forceQueue = options.forceQueue === true;
    const allowOpenWarning = options.allowOpenWarning !== false;
    if (!forceQueue && (reopening.has(key) || isOpeningDocument(document.uri))) return;
    if (activeDocumentChecks.has(key)) {
      const existing = pendingDocumentChecks.get(key);
      pendingDocumentChecks.set(key, {
        document,
        allowOpenWarning: existing ? existing.allowOpenWarning || allowOpenWarning : allowOpenWarning,
      });
      await activeDocumentChecks.get(key);
      return;
    }
    while (forceQueue && !reopening.has(key) && isOpeningDocument(document.uri)) {
      await waitForOpeningDocument(document.uri);
    }
    if (activeDocumentChecks.has(key)) {
      const latest = findOpenDocument(document.uri) ?? document;
      const existing = pendingDocumentChecks.get(key);
      pendingDocumentChecks.set(key, {
        document: latest,
        allowOpenWarning: existing ? existing.allowOpenWarning || allowOpenWarning : allowOpenWarning,
      });
      await activeDocumentChecks.get(key);
      return;
    }
    const toasts: Array<() => Promise<void>> = [];
    const run = (async () => {
      let current: QueuedCheck | undefined = {
        document: findOpenDocument(document.uri) ?? document,
        allowOpenWarning,
      };
      while (current) {
        pendingDocumentChecks.delete(key);
        const toast = await action(current.document, current.allowOpenWarning);
        if (toast) toasts.push(toast);
        const queued = pendingDocumentChecks.get(key);
        current = queued
          ? {
              document: findOpenDocument(queued.document.uri) ?? queued.document,
              allowOpenWarning: queued.allowOpenWarning,
            }
          : undefined;
      }
    })().finally(() => {
      activeDocumentChecks.delete(key);
    });
    activeDocumentChecks.set(key, run);
    try {
      await run;
    } finally {
      await Promise.allSettled(toasts.map((fn) => fn()));
    }
  };

  const ensureExpectedEncodingUnchecked = async (
    document: vscode.TextDocument,
    allowOpenWarning = true,
    depth = 0,
  ): Promise<(() => Promise<void>) | undefined> => {
    if (document.isClosed) {
      clearDocumentDiagnostic(document.uri);
      return undefined;
    }
    // Git comparisons keep the expected encoding on both sides (display only, nothing is saved).
    if (
      document.uri.scheme === "git" ||
      isInAutoAlignedComparison(document) ||
      document.uri.scheme !== "file"
    ) {
      await alignActiveComparison();
      const currentDoc = findOpenDocument(document.uri) ?? document;
      updateDocumentState(currentDoc);
      return undefined;
    }
    if (!isVisibleDocument(document)) {
      updateDocumentState(document);
      return undefined;
    }

    const key = document.uri.toString();
    let currentDoc = document;
    let match = resolveRule(currentDoc.uri);
    let inspection: FileEncodingInspection | undefined;
    let skipNormalInspection = false;
    if (match && !isDocumentEncodingMatch(currentDoc, match)) {
      updateDocumentState(currentDoc);
      if (reopening.has(key) || isOpeningDocument(currentDoc.uri)) {
        return undefined;
      }
      if (isManualEncodingOverride(currentDoc.uri)) {
        if (!currentDoc.isDirty && isVisibleDocument(currentDoc)) {
          await inspectFileDocument(currentDoc);
          currentDoc = findOpenDocument(document.uri) ?? currentDoc;
          if (currentDoc.isClosed) {
            clearDocumentDiagnostic(currentDoc.uri);
            return undefined;
          }
          updateDocumentState(currentDoc);
        }
        return undefined;
      }

      let ruleInspection: FileEncodingInspection | undefined;
      const initialVersion = currentDoc.version;
      if (!currentDoc.isDirty) {
        ruleInspection = await inspectFileDocument(currentDoc);
        currentDoc = findOpenDocument(document.uri) ?? currentDoc;
        if (currentDoc.isClosed) {
          clearDocumentDiagnostic(currentDoc.uri);
          return undefined;
        }
        if (
          !isVisibleDocument(currentDoc) ||
          reopening.has(key) ||
          isOpeningDocument(currentDoc.uri) ||
          isManualEncodingOverride(currentDoc.uri)
        ) {
          updateDocumentState(currentDoc);
          return undefined;
        }
        match = resolveRule(currentDoc.uri);
        if (!match || isDocumentEncodingMatch(currentDoc, match)) {
          return depth < 1
            ? ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
            : undefined;
        }
        updateDocumentState(currentDoc);
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
          reopening.add(key);
          const previousEncoding = currentDoc.encoding;
          try {
            const reopened = await vscode.workspace.openTextDocument(currentDoc.uri, {
              encoding: targetEncoding,
            });
            currentDoc = reopened;
            if (reopened.isClosed) {
              clearDocumentDiagnostic(reopened.uri);
              return undefined;
            }
            if (
              reopened.encoding.toLowerCase() !== targetEncoding.toLowerCase() ||
              reopened.encoding.toLowerCase() === previousEncoding.toLowerCase()
            ) {
              markAutoReopenFailed(reopened.uri, targetEncoding);
            } else {
              clearFileEncodingInspection(reopened.uri);
              clearAutoReopenFailure(reopened.uri);
              if (isVisibleDocument(reopened)) await inspectFileDocument(reopened);
              if (reopened.isClosed) {
                clearDocumentDiagnostic(reopened.uri);
                return undefined;
              }
              warned.delete(key);
              updateDocumentState(reopened);
              return undefined;
            }
          } catch {
            markAutoReopenFailed(currentDoc.uri, targetEncoding);
            console.error("Auto Encoding: Failed to reopen document.");
          } finally {
            reopening.delete(key);
          }
        }

        currentDoc = findOpenDocument(document.uri) ?? currentDoc;
        if (currentDoc.isClosed) {
          clearDocumentDiagnostic(currentDoc.uri);
          return undefined;
        }
        if (!isVisibleDocument(currentDoc) || isManualEncodingOverride(currentDoc.uri)) {
          updateDocumentState(currentDoc);
          return undefined;
        }
        match = resolveRule(currentDoc.uri);
        if (!match || isDocumentEncodingMatch(currentDoc, match)) {
          return depth < 1
            ? ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
            : undefined;
        }
        const latestRuleInspection = currentFileInspection(currentDoc) ?? ruleInspection;
        if (!currentDoc.isDirty && latestRuleInspection?.ruleConfirmed !== true) {
          return depth < 1
            ? ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
            : undefined;
        }
        updateDocumentState(currentDoc);

        const config = configurationFor(match.folder);
        if (!allowOpenWarning || currentDoc.isDirty || !config.get("warnOnOpen", true)) {
          return undefined;
        }
        const warningKey = `${currentDoc.encoding.toLowerCase()}:${match.rule.encoding.toLowerCase()}`;
        if (warned.get(key) === warningKey) {
          return undefined;
        }
        warned.set(key, warningKey);
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
          if ((await notice) === action) {
            const targetDoc = findOpenDocument(document.uri) ?? currentDoc;
            if (targetDoc.isClosed) return;
            const latestMatch = resolveRule(targetDoc.uri);
            if (!latestMatch || isDocumentEncodingMatch(targetDoc, latestMatch)) {
              warned.delete(key);
              updateDocumentState(targetDoc);
              return;
            }
            await reopenWithExpectedEncoding(targetDoc, latestMatch);
            const updatedDoc = findOpenDocument(document.uri) ?? targetDoc;
            if (updatedDoc.isClosed) {
              clearDocumentDiagnostic(updatedDoc.uri);
              return;
            }
            if (
              currentFileInspection(updatedDoc)?.status === "ok" &&
              isDocumentEncodingMatch(updatedDoc, latestMatch)
            ) {
              warned.delete(key);
            }
            updateDocumentState(updatedDoc);
          }
        };
      }

      if (
        !currentDoc.isDirty &&
        ruleInspection?.ruleConfirmed === false &&
        ruleInspection.status !== "ok"
      ) {
        inspection = ruleInspection;
        skipNormalInspection = true;
      } else {
        const config = configurationFor(match.folder);
        if (!allowOpenWarning || currentDoc.isDirty || !config.get("warnOnOpen", true)) {
          return undefined;
        }
        const warningKey = `unconfirmed:${currentDoc.encoding.toLowerCase()}:${match.rule.encoding.toLowerCase()}`;
        if (warned.get(key) === warningKey) {
          return undefined;
        }
        warned.set(key, warningKey);
        const message = `${documentBasename(currentDoc)}: ${UNCONFIRMED_RULE_MESSAGE}`;
        return async () => {
          await vscode.window.showWarningMessage(message);
        };
      }
    }

    if (!skipNormalInspection) {
      if (
        !isVisibleDocument(currentDoc) ||
        reopening.has(key) ||
        isOpeningDocument(currentDoc.uri)
      ) {
        updateDocumentState(currentDoc);
        return undefined;
      }
      inspection = await inspectFileDocument(currentDoc);
      currentDoc = findOpenDocument(document.uri) ?? currentDoc;
      if (currentDoc.isClosed) {
        clearDocumentDiagnostic(currentDoc.uri);
        return undefined;
      }
      if (
        !isVisibleDocument(currentDoc) ||
        reopening.has(key) ||
        isOpeningDocument(currentDoc.uri)
      ) {
        updateDocumentState(currentDoc);
        return undefined;
      }
      const latestMatchAfterInspect = resolveRule(currentDoc.uri);
      if (
        latestMatchAfterInspect &&
        !isDocumentEncodingMatch(currentDoc, latestMatchAfterInspect) &&
        inspection?.ruleConfirmed !== false
      ) {
        return depth < 1
          ? ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
          : undefined;
      }
      updateDocumentState(currentDoc);
      if (!inspection || inspection.status === "ok") {
        if (inspection?.status === "ok") warned.delete(key);
        return undefined;
      }
      if (isManualEncodingOverride(currentDoc.uri)) {
        return undefined;
      }

      const latestFolder = vscode.workspace.getWorkspaceFolder?.(currentDoc.uri);
      const config = configurationFor(latestMatchAfterInspect?.folder ?? latestFolder ?? currentDoc.uri);
      if (
        !latestMatchAfterInspect &&
        inspection.status === "detectedMismatch" &&
        inspection.detectedEncoding &&
        config.get("autoReopen", true) &&
        !currentDoc.isDirty &&
        !hasAutoReopenFailed(currentDoc.uri, inspection.detectedEncoding)
      ) {
        reopening.add(key);
        try {
          const reopened = await autoReopenWithDetectedEncoding(
            currentDoc,
            inspection.detectedEncoding,
          );
          if (reopened) {
            if (reopened.isClosed) {
              clearDocumentDiagnostic(reopened.uri);
              return undefined;
            }
            warned.delete(key);
            updateDocumentState(reopened);
            return undefined;
          }
        } catch {
          console.error("Auto Encoding: Failed to reopen document.");
        } finally {
          reopening.delete(key);
        }
      }

      currentDoc = findOpenDocument(document.uri) ?? currentDoc;
      if (currentDoc.isClosed) {
        clearDocumentDiagnostic(currentDoc.uri);
        return undefined;
      }
      updateDocumentState(currentDoc);
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
        ? ensureExpectedEncodingUnchecked(currentDoc, allowOpenWarning, depth + 1)
        : undefined;
    }
    if (!afterInspection || afterInspection.status === "ok") {
      if (afterInspection?.status === "ok") warned.delete(key);
      return undefined;
    }
    const afterFolder = vscode.workspace.getWorkspaceFolder?.(currentDoc.uri);
    const afterConfig = configurationFor(afterMatch?.folder ?? afterFolder ?? currentDoc.uri);
    if (!allowOpenWarning || currentDoc.isDirty || !afterConfig.get("warnOnOpen", true)) {
      return undefined;
    }
    const warningKey = `${currentDoc.encoding.toLowerCase()}:${afterMatch?.rule.encoding.toLowerCase() ?? ""}:${afterInspection.ruleConfirmed ?? ""}:${afterInspection.status}:${afterInspection.detectedEncoding?.toLowerCase() ?? ""}:${afterInspection.candidates?.join(",") ?? ""}`;
    if (warned.get(key) === warningKey) {
      return undefined;
    }
    warned.set(key, warningKey);

    const filename = documentBasename(currentDoc);
    const currentLabel = encodingInfo(currentDoc.encoding).label;
    const ruleMismatchedOnNotice = !!afterMatch && !isDocumentEncodingMatch(currentDoc, afterMatch);
    const expectedRuleLabel = afterMatch ? encodingInfo(afterMatch.rule.encoding).label : undefined;
    if (afterInspection.status === "detectedMismatch" && afterInspection.detectedEncoding) {
      const detectedEncoding = afterInspection.detectedEncoding;
      const detectedLabel = encodingInfo(detectedEncoding).label;
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
        if ((await notice) === action) {
          const targetDoc = findOpenDocument(document.uri) ?? currentDoc;
          if (targetDoc.isClosed) return;
          if (targetDoc.isDirty) {
            await reopenDocumentWithDetectedEncoding(targetDoc, detectedEncoding, Boolean(afterMatch));
            return;
          }
          clearEncodingDetectionCache(targetDoc.uri);
          clearFileEncodingInspection(targetDoc.uri);
          const latestMatch = resolveRule(targetDoc.uri);
          const latestInspection = await inspectFileDocument(targetDoc);
          const latestDoc = findOpenDocument(document.uri) ?? targetDoc;
          if (latestDoc.isClosed) {
            clearDocumentDiagnostic(latestDoc.uri);
            return;
          }
          if (
            !latestInspection ||
            latestInspection.status !== "detectedMismatch" ||
            latestInspection.detectedEncoding?.toLowerCase() !== detectedEncoding.toLowerCase()
          ) {
            warned.delete(key);
            updateDocumentState(latestDoc);
            if (
              isVisibleDocument(latestDoc) &&
              (latestInspection?.status !== "ok" ||
                (latestMatch && !isDocumentEncodingMatch(latestDoc, latestMatch)))
            ) {
              void ensureExpectedEncoding(latestDoc, { forceQueue: true });
            }
            return;
          }
          const reopened = await reopenDocumentWithDetectedEncoding(
            latestDoc,
            detectedEncoding,
            Boolean(latestMatch),
          );
          const updatedDoc = reopened ?? findOpenDocument(document.uri) ?? latestDoc;
          if (updatedDoc.isClosed) {
            clearDocumentDiagnostic(updatedDoc.uri);
            return;
          }
          updateDocumentState(updatedDoc);
        }
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
      if ((await notice) === action) {
        const targetDoc = findOpenDocument(document.uri) ?? currentDoc;
        if (targetDoc.isClosed) return;
        if (
          vscode.window.activeTextEditor?.document.uri.toString() !== targetDoc.uri.toString() &&
          typeof vscode.window.showTextDocument === "function"
        ) {
          await vscode.window.showTextDocument(targetDoc, { preserveFocus: false });
        }
        const activeDoc = findOpenDocument(document.uri) ?? targetDoc;
        if (activeDoc.isClosed) {
          clearDocumentDiagnostic(activeDoc.uri);
          return;
        }
        await inspectActiveFile();
        const updatedDoc = findOpenDocument(document.uri) ?? activeDoc;
        if (updatedDoc.isClosed) {
          clearDocumentDiagnostic(updatedDoc.uri);
          return;
        }
        if (currentFileInspection(updatedDoc)?.status === "ok") {
          warned.delete(key);
        }
        updateDocumentState(updatedDoc);
      }
    };
  };

  const alignThenRefreshStatus = async (): Promise<void> => {
    try {
      await alignActiveComparison();
      const active = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
      if (active && !active.isClosed) {
        updateDocumentState(active);
      } else if (!vscode.window.activeTextEditor) {
        status.hide();
      }
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
    }
  };

  const ensureExpectedEncoding = async (
    document: vscode.TextDocument,
    options?: { forceQueue?: boolean; allowOpenWarning?: boolean },
  ): Promise<void> => {
    try {
      await runSerializedDocumentCheck(document, ensureExpectedEncodingUnchecked, options);
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
      clearDocumentDiagnostic(document.uri);
      if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
        status.text = t("Check Encoding Rules");
        status.show();
      }
    }
  };

  const refreshOpenDocumentState = (uri: vscode.Uri): void => {
    const openDoc = findOpenDocument(uri);
    if (!openDoc || openDoc.isDirty) return;
    if (isVisibleDocument(openDoc) || hasDiagnostic(openDoc.uri)) {
      void ensureExpectedEncoding(openDoc, { forceQueue: true });
    }
  };
  refreshOperationDocuments = (): void => {
    const targets = [...pendingOperationUris.values()];
    pendingOperationUris.clear();
    for (const uri of targets) {
      refreshOpenDocumentState(uri);
    }
  };

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
    diagnostics,
    status,
    vscode.commands.registerCommand("autoEncoding.configureFolder", async (uri?: vscode.Uri) =>
      configureFolder(uri, decorationProvider, settingsQueue),
    ),
    vscode.commands.registerCommand("autoEncoding.configureFile", async (uri?: vscode.Uri) =>
      configureFolder(uri, decorationProvider, settingsQueue, true),
    ),
    vscode.commands.registerCommand("autoEncoding.inspectActiveFile", async () => {
      await inspectActiveFile();
      const active = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
      if (active && !active.isClosed) updateDocumentState(active);
    }),
    vscode.commands.registerCommand(
      "autoEncoding.convertFile",
      (uri?: vscode.Uri, targetEncoding?: unknown) =>
        conversionManager.convertFile(
          uri,
          typeof targetEncoding === "string" && isSupportedEncoding(targetEncoding)
            ? targetEncoding
            : undefined,
        ),
    ),
    vscode.commands.registerCommand("autoEncoding.convertFolder", async (uri?: vscode.Uri) =>
      conversionManager.convertFolder(uri),
    ),
    vscode.commands.registerCommand("autoEncoding.undoLastConversion", async () =>
      conversionManager.undoLastConversion(),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void ensureExpectedEncoding(editor.document);
      } else {
        const comparisonDoc = activeComparisonDocument();
        if (comparisonDoc && !comparisonDoc.isClosed) {
          updateStatus(status, comparisonDoc);
        } else {
          status.hide();
        }
      }
    }),
    ...(vscode.window.onDidChangeVisibleTextEditors
      ? [
          vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) void ensureExpectedEncoding(editor.document);
          }),
        ]
      : []),
    ...[
      vscode.window.tabGroups?.onDidChangeTabs,
      vscode.window.tabGroups?.onDidChangeTabGroups,
    ].flatMap((event) => (event ? [event(() => void alignThenRefreshStatus())] : [])),
    vscode.workspace.onDidOpenTextDocument((document) => void ensureExpectedEncoding(document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) {
        markFilesChanged(event.document.uri, { recheckOpenDocument: false });
      }
      void ensureExpectedEncoding(event.document, {
        forceQueue: true,
        allowOpenWarning: !event.document.isDirty,
      });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      clearDocumentDiagnostic(document.uri);
      if (reopening.has(key) || isOpeningDocument(document.uri)) {
        return;
      }
      warned.delete(key);
      forgetManualEncoding(document.uri);
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      try {
        const { document } = event;
        if (document.uri.scheme !== "file") return;
        const folder = vscode.workspace.getWorkspaceFolder?.(document.uri);
        const match = resolveRule(document.uri);
        const config = configurationFor(match?.folder ?? folder ?? document.uri);
        const warnOnSave = config.get("warnOnSave", true);
        const filename = documentBasename(document);
        const details: string[] = [];
        const ruleMismatched = !!match && !isDocumentEncodingMatch(document, match);
        if ((warnOnSave || config.get("enforceOnSave", false)) && ruleMismatched) {
          details.push(
            t(
              "{0} is open as {1}, while the configured encoding rule is {2}.",
              filename,
              encodingInfo(document.encoding).label,
              encodingInfo(match.rule.encoding).label,
            ),
          );
        }
        const inspection = currentFileInspection(document);
        if (
          warnOnSave &&
          (!ruleMismatched || inspection?.ruleConfirmed === false) &&
          inspection &&
          inspection.status !== "ok"
        ) {
          const currentLabel = encodingInfo(document.encoding).label;
          if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
            details.push(
              t(
                "The current encoding of {0} ({1}) may differ from its saved bytes ({2}).",
                filename,
                currentLabel,
                encodingInfo(inspection.detectedEncoding).label,
              ),
            );
          } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
            details.push(
              t(
                "Saving {0} while its encoding is still ambiguous (candidates: {1}).",
                filename,
                inspection.candidates.map((id) => encodingInfo(id).label).join(" / "),
              ),
            );
          } else {
            details.push(
              t(
                "Saving {0} while it could not be decoded without loss in {1}.",
                filename,
                currentLabel,
              ),
            );
          }
        }
        const maxTextLength = configuredFileSizeLimit(config.get<number>("maxFileSizeKB", 5120));
        const documentLength =
          typeof document.lineAt === "function" &&
          typeof document.offsetAt === "function" &&
          typeof document.lineCount === "number" &&
          document.lineCount > 0
            ? document.offsetAt(document.lineAt(document.lineCount - 1).range.end)
            : document.getText().length;
        const rawText = warnOnSave && documentLength <= maxTextLength ? document.getText() : undefined;
        const text =
          rawText !== undefined && Buffer.byteLength(rawText, "utf8") <= maxTextLength
            ? rawText
            : undefined;
        const shouldWarnReplacement =
          text !== undefined &&
          text.includes("\uFFFD") &&
          (match
            ? true
            : !(inspection?.status === "ok" && inspection.initialHadReplacementCharacter) ||
              countReplacementCharacters(text) > inspection.initialReplacementCharacterCount);
        if (shouldWarnReplacement) {
          details.push(
            t("{0} contains replacement characters (U+FFFD). Please verify the original content.", filename),
          );
        }
        if (details.length > 0) {
          void vscode.window.showErrorMessage(t("Save warning: {0}", details.join(" ")));
        }
      } catch (error) {
        if (!notifyConfigurationLimit(error)) throw error;
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      clearFileEncodingInspection(document.uri);
      clearAutoReopenFailure(document.uri);
      markFilesChanged(document.uri, { recheckOpenDocument: false });
      if (isVisibleDocument(document) || hasDiagnostic(document.uri)) {
        void ensureExpectedEncoding(document, { forceQueue: true });
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
        clearWorkspaceRuleCache();
        clearEncodingDetectionCache();
        clearCleanFileEncodingInspections();
        clearAutoReopenFailure();
        warned.clear();
        decorationProvider.refresh();
        (vscode.workspace.textDocuments ?? []).forEach((document) =>
          void ensureExpectedEncoding(document, { forceQueue: true }),
        );
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearWorkspaceRuleCache();
      clearEncodingDetectionCache();
      clearCleanFileEncodingInspections();
      clearAutoReopenFailure();
      warned.clear();
      decorationProvider.refresh();
      (vscode.workspace.textDocuments ?? []).forEach((document) =>
        void ensureExpectedEncoding(document, { forceQueue: true }),
      );
    }),
  );

  void conversionManager.notifyProtectedConversion().then(undefined, () => undefined);

  vscode.workspace.textDocuments.forEach((document) => void ensureExpectedEncoding(document));
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    try {
      updateStatus(status, activeDocument);
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
    }
  }
}

export function deactivate(): void {}
