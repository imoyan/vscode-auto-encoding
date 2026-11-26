import * as path from "node:path";
import * as vscode from "vscode";
import {
  EncodingRule,
  findMatchingRule,
  sanitizeAutoDetectEncodings,
  sanitizeRules,
} from "./rules.js";
import { clearGlobCache, compileGlob, ConfigurationLimitError } from "./boundedGlob.js";
import { t } from "./l10n.js";

export const CONFIGURATION_SECTION = "autoEncoding";
export const RULES_SETTING = "rules";

// VS Code returns fresh configuration objects. Cache by workspace URI until its
// configuration or folder membership changes, rather than by array identity.
const settings = new Map<string, Map<string, unknown>>();
let limitNotified = false;

export function clearWorkspaceRuleCache(): void {
  settings.clear();
  clearGlobCache();
  limitNotified = false;
}

export function notifyConfigurationLimit(error: unknown): error is ConfigurationLimitError {
  if (!(error instanceof ConfigurationLimitError)) return false;
  if (!limitNotified) {
    limitNotified = true;
    void vscode.window.showErrorMessage(
      t("Auto Encoding settings or path exceeded the evaluation limit. Reduce the number, length, or glob complexity of your rules."),
    );
  }
  return true;
}

function cachedSetting<T>(
  folder: vscode.WorkspaceFolder,
  setting: string,
  parse: (value: unknown) => T,
): T {
  const key = folder.uri.toString();
  let cache = settings.get(key);
  if (!cache) {
    cache = new Map();
    settings.set(key, cache);
  }
  if (!cache.has(setting)) {
    try {
      cache.set(setting, parse(configurationFor(folder.uri).get<unknown>(setting)));
    } catch (error) {
      if (!(error instanceof ConfigurationLimitError)) throw error;
      cache.set(setting, error);
      notifyConfigurationLimit(error);
    }
  }
  const value = cache.get(setting);
  if (value instanceof Error) throw value;
  return value as T;
}

export interface RuleMatch {
  readonly folder: vscode.WorkspaceFolder;
  readonly relativePath: string;
  readonly rule: EncodingRule;
  readonly index: number;
}

export function configurationFor(scope: vscode.ConfigurationScope): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, scope);
}

/** Returns the configured candidate encodings for automatic detection in the given scope. */
export function getAutoDetectEncodings(scope: vscode.ConfigurationScope): readonly string[] {
  return sanitizeAutoDetectEncodings(configurationFor(scope).get<unknown>("autoDetectEncodings"));
}

export function getRules(folder: vscode.WorkspaceFolder, fresh = false): readonly EncodingRule[] {
  if (fresh) settings.get(folder.uri.toString())?.delete(RULES_SETTING);
  return cachedSetting(folder, RULES_SETTING, (value) =>
    Object.freeze(sanitizeRules(value).map((rule) => Object.freeze(rule))),
  );
}

export function getExclusion(
  folder: vscode.WorkspaceFolder,
  fallback: string,
): ReturnType<typeof compileGlob> {
  return cachedSetting(folder, "conversionExclude", (value) =>
    compileGlob(value === undefined ? fallback : value),
  );
}

export function relativePathFor(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string {
  return path.relative(folder.uri.fsPath, uri.fsPath).replaceAll(path.sep, "/");
}

export function fileUriForResource(uri: vscode.Uri): vscode.Uri {
  return uri.scheme !== "git"
    ? uri
    : vscode.Uri.file(uri.fsPath || uri.path).with({ fragment: "", query: "" });
}

export function resolveRule(uri: vscode.Uri): RuleMatch | undefined {
  if (uri.scheme === "untitled" || uri.path.length === 0) {
    return undefined;
  }
  const fileUri = fileUriForResource(uri);
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (!folder) {
    return undefined;
  }
  const relativePath = relativePathFor(fileUri, folder);
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return undefined;
  }
  const matched = findMatchingRule(getRules(folder), relativePath);
  return matched ? { folder, relativePath, ...matched } : undefined;
}
