// Extension activation entry point wiring commands, watchers, and editor lifecycle events.

import * as vscode from "vscode";
import { SerialTaskQueue } from "./coalescingTask.js";
import { ConversionManager } from "./conversion.js";
import { isSupportedEncoding } from "./rules.js";
import {
  CONFIGURATION_SECTION,
  configurationFor,
  notifyConfigurationLimit,
  resolveRule,
} from "./workspaceRules.js";
import { EncodingDecorationProvider } from "./ruleDecorations.js";
import {
  activeComparisonDocument,
  inspectActiveFile,
  updateStatus,
} from "./editorEncoding.js";
import { configureFolder } from "./ruleCommands.js";
import { DocumentCoordinator } from "./documentCoordinator.js";
import { handleWillSaveWarning } from "./saveWarning.js";

export function activate(context: vscode.ExtensionContext): void {
  context.globalState?.setKeysForSync?.([]);
  const decorationProvider = new EncodingDecorationProvider();
  const coordinator = new DocumentCoordinator();
  const settingsQueue = new SerialTaskQueue();

  const conversionManager = new ConversionManager(
    context,
    (uri) => resolveRule(uri)?.rule.encoding,
    (scope) => configurationFor(scope),
    () => coordinator.refreshOperationDocuments(),
    (uri) => coordinator.registerOperationTarget(uri),
  );

  const files = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(
    files,
    files.onDidChange((uri) => coordinator.markFilesChanged(uri)),
    files.onDidCreate((uri) => coordinator.markFilesChanged(uri)),
    files.onDidDelete((uri) => coordinator.markFilesChanged(uri, { deleted: true })),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    coordinator.diagnostics,
    coordinator.status,
    vscode.commands.registerCommand("autoEncoding.configureFolder", async (uri?: vscode.Uri) =>
      configureFolder(uri, decorationProvider, settingsQueue),
    ),
    vscode.commands.registerCommand("autoEncoding.configureFile", async (uri?: vscode.Uri) =>
      configureFolder(uri, decorationProvider, settingsQueue, true),
    ),
    vscode.commands.registerCommand("autoEncoding.inspectActiveFile", async () => {
      await inspectActiveFile();
      const active = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
      if (active && !active.isClosed) coordinator.updateDocumentState(active);
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
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      coordinator.handleActiveEditorChanged(editor),
    ),
    ...(vscode.window.onDidChangeVisibleTextEditors
      ? [
          vscode.window.onDidChangeVisibleTextEditors((editors) => {
            for (const editor of editors) void coordinator.ensureExpectedEncoding(editor.document);
          }),
        ]
      : []),
    ...[
      vscode.window.tabGroups?.onDidChangeTabs,
      vscode.window.tabGroups?.onDidChangeTabGroups,
    ].flatMap((event) => (event ? [event(() => void coordinator.alignThenRefreshStatus())] : [])),
    vscode.workspace.onDidOpenTextDocument(
      (document) => void coordinator.ensureExpectedEncoding(document),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) {
        coordinator.markFilesChanged(event.document.uri, { recheckOpenDocument: false });
      }
      void coordinator.ensureExpectedEncoding(event.document, {
        forceQueue: true,
        allowOpenWarning: !event.document.isDirty,
      });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => coordinator.handleDocumentClosed(document)),
    vscode.workspace.onWillSaveTextDocument((event) => handleWillSaveWarning(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => coordinator.handleDocumentSaved(document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(CONFIGURATION_SECTION) ||
        event.affectsConfiguration("files.encoding")
      ) {
        decorationProvider.refresh();
        coordinator.resetForEnvironmentChange(true);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      decorationProvider.refresh();
      coordinator.resetForEnvironmentChange(false);
    }),
  );

  void conversionManager.notifyProtectedConversion().then(undefined, () => undefined);

  vscode.workspace.textDocuments.forEach(
    (document) => void coordinator.ensureExpectedEncoding(document),
  );
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    try {
      updateStatus(coordinator.status, activeDocument);
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
    }
  }
}

export function deactivate(): void {}
