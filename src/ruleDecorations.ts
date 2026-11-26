import * as vscode from "vscode";
import { t } from "./l10n.js";
import { encodingInfo, findFolderRegistration } from "./rules.js";
import {
  configurationFor,
  fileUriForResource,
  getRules,
  notifyConfigurationLimit,
  relativePathFor,
  resolveRule,
} from "./workspaceRules.js";

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
    if (!folder || !configurationFor(folder.uri).get<boolean>("showExplorerBadges", true)) {
      return undefined;
    }
    const match = resolveRule(uri);
    const fileDecoration: vscode.FileDecoration | undefined = match
      ? {
          badge: encodingInfo(match.rule.encoding).badge,
          color: new vscode.ThemeColor("charts.blue"),
          tooltip: t(
            "Expected encoding: {0}\nRule source: {1} / {2}",
            encodingInfo(match.rule.encoding).label,
            folder.name,
            match.rule.pattern,
          ),
        }
      : undefined;
    if (uri.scheme !== "file") return fileDecoration;
    const registration = findFolderRegistration(getRules(folder), relativePathFor(uri, folder));
    if (!registration) return fileDecoration;
    const info = encodingInfo(registration.encoding);
    return vscode.workspace.fs.stat(uri).then(
      (entry) => {
        if (token?.isCancellationRequested) return undefined;
        if (!(entry.type & vscode.FileType.Directory)) return fileDecoration;
        return {
          badge: info.badge,
          color: new vscode.ThemeColor("charts.blue"),
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
