// Explorer file and folder badge decorations for encoding rules without overriding Git colors.

import * as vscode from "vscode";
import { t } from "./l10n.js";
import { encodingInfo, findFolderRegistration, findMatchingRule } from "./rules.js";
import {
  configurationFor,
  fileUriForResource,
  getRules,
  notifyConfigurationLimit,
  relativePathFor,
  resolveRule,
} from "./workspaceRules.js";

export type ExplorerBadgesMode = "boundaries" | "all" | "none";

function effectiveExplorerBadgesMode(folderUri: vscode.Uri): ExplorerBadgesMode {
  const configured = configurationFor(folderUri).get<unknown>("explorerBadges", "boundaries");
  if (configured === "boundaries" || configured === "all" || configured === "none") {
    return configured;
  }
  return "boundaries";
}

function isBoundaryFileMatch(
  rules: ReturnType<typeof getRules>,
  relativePath: string,
  matchedIndex: number,
): boolean {
  const slashIndex = relativePath.lastIndexOf("/");
  const parentDir = slashIndex >= 0 ? relativePath.slice(0, slashIndex) : "";
  const probePath = parentDir
    ? `${parentDir}/__auto_encoding_probe__`
    : "__auto_encoding_probe__";
  const parentMatch = findMatchingRule(rules, probePath);
  return matchedIndex !== parentMatch?.index;
}

/** Provides 2-letter Explorer encoding badges according to `autoEncoding.explorerBadges`. */
export class EncodingDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.emitter.event;

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public provideFileDecoration(
    uri: vscode.Uri,
    token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    try {
      return this.provideFileDecorationUnchecked(uri, token);
    } catch (error) {
      if (!notifyConfigurationLimit(error)) throw error;
      return undefined;
    }
  }

  private provideFileDecorationUnchecked(
    uri: vscode.Uri,
    token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== "file" && uri.scheme !== "git") {
      return undefined;
    }
    const fileUri = fileUriForResource(uri);
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      return undefined;
    }
    const mode = effectiveExplorerBadgesMode(folder.uri);
    if (mode === "none") {
      return undefined;
    }
    const rules = getRules(folder);
    const match = resolveRule(uri);
    const showFileBadge =
      match !== undefined &&
      (mode === "all" || isBoundaryFileMatch(rules, match.relativePath, match.index));
    const fileDecoration: vscode.FileDecoration | undefined = showFileBadge
      ? {
          badge: encodingInfo(match.rule.encoding).badge,
          tooltip: t(
            "Expected encoding: {0}\nRule source: {1} / {2}",
            encodingInfo(match.rule.encoding).label,
            folder.name,
            match.rule.pattern,
          ),
        }
      : undefined;
    if (uri.scheme !== "file") return fileDecoration;
    const registration = findFolderRegistration(rules, relativePathFor(uri, folder));
    if (!registration) return fileDecoration;
    const info = encodingInfo(registration.encoding);
    return vscode.workspace.fs.stat(uri).then(
      (entry) => {
        if (token?.isCancellationRequested) return undefined;
        if (!(entry.type & vscode.FileType.Directory)) return fileDecoration;
        return {
          badge: info.badge,
          tooltip: t(
            "Folder rule: {0}\nTarget: {1} / {2}\nEach file uses the highest-priority matching rule.",
            info.label,
            folder.name,
            registration.pattern,
          ),
        };
      },
      () => fileDecoration,
    );
  }
}
