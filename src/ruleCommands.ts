import * as path from "node:path";
import * as vscode from "vscode";
import type { SerialTaskQueue } from "./coalescingTask.js";
import { t } from "./l10n.js";
import {
  ENCODINGS,
  encodingInfo,
  findFileRegistration,
  findFolderRegistration,
  patternForFile,
  patternForFolder,
  sanitizeRules,
} from "./rules.js";
import type { EncodingDecorationProvider } from "./ruleDecorations.js";
import {
  RULES_SETTING,
  configurationFor,
  fileUriForResource,
  getRules,
  relativePathFor,
} from "./workspaceRules.js";

function detectCurrentEncoding(
  suppliedUri: vscode.Uri,
  targetUri: vscode.Uri,
  fileOnly: boolean,
): string | undefined {
  const docs = vscode.workspace.textDocuments ?? [];
  const direct =
    docs.find((entry) => entry.uri.toString() === suppliedUri.toString()) ??
    docs.find((entry) => entry.uri.toString() === targetUri.toString());
  if (direct) return direct.encoding;
  const active = vscode.window.activeTextEditor?.document;
  if (!active) return undefined;
  const activeFile = fileUriForResource(active.uri);
  if (fileOnly) return activeFile.toString() === targetUri.toString() ? active.encoding : undefined;
  const inside = path.relative(targetUri.fsPath, activeFile.fsPath);
  return inside !== ".." && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside)
    ? active.encoding
    : undefined;
}

let configuring = false;

export async function configureFolder(
  uri: vscode.Uri | undefined,
  decorations: EncodingDecorationProvider,
  queue: SerialTaskQueue,
  fileOnly = false,
): Promise<boolean> {
  if (configuring) return false;
  configuring = true;
  try {
    return await configureTarget(uri, decorations, queue, fileOnly);
  } finally {
    configuring = false;
  }
}

interface RuleChoice extends vscode.QuickPickItem {
  readonly action: "set" | "remove";
  readonly encoding?: string;
}

async function configureTarget(
  suppliedUri: vscode.Uri | undefined,
  decorationProvider: EncodingDecorationProvider,
  settingsQueue: SerialTaskQueue,
  fileOnly = false,
): Promise<boolean> {
  let uri = suppliedUri;
  if (!uri) {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: fileOnly,
      canSelectFolders: !fileOnly,
      canSelectMany: false,
      openLabel: t("Set Encoding"),
      title: fileOnly ? t("Select a file to configure") : t("Select a folder to configure"),
    });
    uri = selected?.[0];
  }
  if (!uri) {
    return false;
  }

  if (fileOnly && uri.scheme !== "git") {
    try {
      if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.File) throw new Error();
    } catch {
      void vscode.window.showErrorMessage(t("Please select a regular file."));
      return false;
    }
  }
  const targetUri = fileUriForResource(uri);
  const folder = vscode.workspace.getWorkspaceFolder(targetUri);
  if (!folder) {
    void vscode.window.showErrorMessage(t("Please select a folder inside an open workspace."));
    return false;
  }
  const relativePath = path.relative(folder.uri.fsPath, targetUri.fsPath);
  const normalizedRelativePath = relativePathFor(targetUri, folder);
  if (
    normalizedRelativePath === ".." ||
    normalizedRelativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    void vscode.window.showErrorMessage(t("Cannot configure a folder outside the workspace."));
    return false;
  }
  if (fileOnly && normalizedRelativePath.length === 0) {
    void vscode.window.showErrorMessage(t("Please select a regular file."));
    return false;
  }

  const existingRules = getRules(folder);
  const registered = fileOnly
    ? findFileRegistration(existingRules, normalizedRelativePath)
    : findFolderRegistration(existingRules, normalizedRelativePath);
  const preferred = registered?.encoding ?? detectCurrentEncoding(uri, targetUri, fileOnly);
  const ordered =
    preferred && ENCODINGS.some((encoding) => encoding.id === preferred)
      ? [
          ENCODINGS.find((encoding) => encoding.id === preferred)!,
          ...ENCODINGS.filter((encoding) => encoding.id !== preferred),
        ]
      : ENCODINGS;

  const items: RuleChoice[] = ordered.map((encoding) => ({
    action: "set",
    label: encoding.label,
    description:
      encoding.id === preferred
        ? registered
          ? t("{0} · Current rule", encoding.id)
          : t("{0} · Current encoding", encoding.id)
        : encoding.id,
    encoding: encoding.id,
  }));
  if (registered) {
    items.push({
      action: "remove",
      label: fileOnly
        ? t("$(trash) Remove encoding rule for this file")
        : t("$(trash) Remove encoding rule for this folder"),
      description: t("Current rule: {0}", encodingInfo(registered.encoding).label),
    });
  }

  const targetDisplayName = relativePath || folder.name;
  const choice = await vscode.window.showQuickPick(items, {
    title: registered
      ? t("Encoding for {0} (Rule: {1})", targetDisplayName, encodingInfo(registered.encoding).label)
      : t("Encoding for {0}", targetDisplayName),
    placeHolder: fileOnly
      ? t("Select the encoding to apply only to this file")
      : t("Select the encoding to use for files under this folder"),
  });
  if (!choice) {
    return false;
  }

  const pattern = fileOnly ? patternForFile(relativePath) : patternForFolder(relativePath);
  if (choice.action === "remove") {
    await settingsQueue.run(async () => {
      const currentRules = getRules(folder, true);
      const nextRules = [...currentRules];
      const existingRule = fileOnly
        ? findFileRegistration(currentRules, normalizedRelativePath)
        : findFolderRegistration(currentRules, normalizedRelativePath);
      const existingIndex = existingRule ? nextRules.indexOf(existingRule) : -1;
      if (existingIndex >= 0) {
        nextRules.splice(existingIndex, 1);
        sanitizeRules(nextRules);
        await configurationFor(folder.uri).update(
          RULES_SETTING,
          nextRules,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      }
    });
    decorationProvider.refresh();
    void vscode.window.showInformationMessage(
      fileOnly
        ? t("Removed encoding rule for {0}.", targetDisplayName)
        : t("Removed encoding rule under {0}.", targetDisplayName),
    );
    return true;
  }

  const selectedEncoding = choice.encoding!;
  await settingsQueue.run(async () => {
    const currentRules = getRules(folder, true);
    const nextRules = [...currentRules];
    const existingRule = fileOnly
      ? findFileRegistration(currentRules, normalizedRelativePath)
      : findFolderRegistration(currentRules, normalizedRelativePath);
    const existing = existingRule ? nextRules.indexOf(existingRule) : -1;
    if (existing < 0) nextRules.unshift({ pattern, encoding: selectedEncoding });
    else nextRules[existing] = { ...nextRules[existing]!, encoding: selectedEncoding };
    sanitizeRules(nextRules);
    await configurationFor(folder.uri).update(
      RULES_SETTING,
      nextRules,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  });
  decorationProvider.refresh();
  void vscode.window.showInformationMessage(
    fileOnly
      ? t("Registered {0} as {1}.", targetDisplayName, choice.label)
      : t("Registered files under {0} as {1}.", targetDisplayName, choice.label),
  );
  return true;
}
