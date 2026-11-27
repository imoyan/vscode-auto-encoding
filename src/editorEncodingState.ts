// Shared editor encoding state, caches, active tab/comparison discovery, and formatting helpers.

import * as vscode from "vscode";
import { t } from "./l10n.js";
import { type EncodingClassification } from "./scanCore.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { encodingInfo } from "./rules.js";
import {
  type RuleMatch,
  resolveRule,
  configurationFor,
  fileUriForResource,
} from "./workspaceRules.js";

export interface ComparisonInput {
  original: vscode.Uri;
  modified: vscode.Uri;
}

export interface ActiveComparison extends ComparisonInput {
  label?: string;
  preview: boolean;
  multiDiff?: boolean;
}

export interface ActiveSingleGit {
  uri: vscode.Uri;
  preview: boolean;
}

export type EncodingBasis = "rule" | "ruleFallback" | "openFile" | "detected" | "guessed";

export interface SideResolution {
  readonly encoding?: string;
  readonly basis?: EncodingBasis;
  readonly match?: RuleMatch;
  readonly actualMismatch?: boolean;
  readonly keepCurrentEncoding?: boolean;
  readonly candidates?: readonly string[];
  readonly ascii?: boolean;
  readonly empty?: boolean;
}

export interface FileEncodingInspection {
  readonly documentEncoding: string;
  readonly match?: RuleMatch;
  readonly ruleConfirmed?: boolean;
  readonly status: "ok" | "detectedMismatch" | "candidateMismatch" | "decodeLoss";
  readonly detectedEncoding?: string;
  readonly candidates?: readonly string[];
  readonly basis?: EncodingBasis;
  readonly initialHadReplacementCharacter: boolean;
  readonly initialReplacementCharacterCount: number;
}

export type StatusBarVisibility = "relevant" | "compact" | "always";

export interface ResourceBytes {
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  readonly statToken?: string;
  readonly stillCurrent?: () => Promise<boolean>;
}

export interface InspectedBytes {
  readonly classification: EncodingClassification;
  readonly empty: boolean;
  readonly replacementCharacterCount?: number;
  readonly likelyEncoding?: string;
  readonly likelyEquivalentEncodings?: readonly string[];
}

export const MAX_MULTI_DIFF_ENTRIES = 64;
const MAX_MULTI_DIFF_SCAN = 4096;
export const MAX_CACHE_ENTRIES = 128;
export const CACHE_TTL_MS = 60_000;

export const UNCONFIRMED_RULE_MESSAGE = t(
  "Saved bytes could not be confirmed against the configured encoding rule; keeping the current encoding.",
);
export const DIRTY_MESSAGE = t(
  "Cannot reopen while there are unsaved changes. Save or back up your changes before changing the encoding.",
);

export const byteClassificationCache = new Map<
  string,
  {
    readonly fingerprint: string;
    readonly statToken?: string;
    readonly expiresAt: number;
    readonly classification: EncodingClassification;
    readonly empty: boolean;
    readonly replacementCharacterCount?: number;
    readonly likelyEncoding?: string;
    readonly likelyEquivalentEncodings?: readonly string[];
  }
>();
export const resolvedSides = new Map<
  string,
  { readonly resolution: SideResolution; readonly updatedAt: number }
>();
export const inspectedFileDocuments = new Map<string, FileEncodingInspection>();
export const activeInspectionInvalidators = new Map<string, Set<() => void>>();
export const autoDetectedUris = new Map<string, string>();
export const guessedUris = new Map<string, string>();
export const failedAutoReopens = new Map<string, Set<string>>();
export const openingDocuments = new Set<string>();
const openingPromises = new Map<
  string,
  { readonly promise: Promise<void>; readonly resolve: () => void }
>();
// Sides the user deliberately reopened on their own (e.g. to inspect a conversion commit).
export const manualSides = new Set<string>();
export const pendingAlignHints = new Map<string, vscode.Uri>();

export function isReopenableScheme(scheme: string): boolean {
  return scheme === "file" || scheme === "git";
}

function isUriLike(value: unknown): value is vscode.Uri {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as vscode.Uri).scheme === "string" &&
      typeof (value as vscode.Uri).toString === "function",
  );
}

function extractMultiDiffInputs(input: unknown): readonly ComparisonInput[] | undefined {
  if (!input || typeof input !== "object" || !("textDiffs" in input)) return undefined;
  const raw = (input as { textDiffs?: unknown }).textDiffs;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const diffs: ComparisonInput[] = [];
  for (const entry of raw) {
    if (diffs.length >= MAX_MULTI_DIFF_SCAN) break;
    if (
      entry &&
      typeof entry === "object" &&
      isUriLike((entry as { original?: unknown }).original) &&
      isUriLike((entry as { modified?: unknown }).modified)
    ) {
      diffs.push({
        original: (entry as { original: vscode.Uri }).original,
        modified: (entry as { modified: vscode.Uri }).modified,
      });
    }
  }
  return diffs.length > 0 ? diffs : undefined;
}

export function sameEncoding(left?: string, right?: string): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

function invalidateInspectionsForKey(key: string): void {
  const invalidators = activeInspectionInvalidators.get(key);
  if (!invalidators) return;
  for (const invalidate of invalidators) invalidate();
}

function invalidateAllInspections(): void {
  for (const invalidators of activeInspectionInvalidators.values()) {
    for (const invalidate of invalidators) invalidate();
  }
}

export function markAutoReopenFailed(uri: vscode.Uri, targetEncoding: string): void {
  const key = uri.toString();
  let targets = failedAutoReopens.get(key);
  if (!targets) {
    if (failedAutoReopens.size >= MAX_CACHE_ENTRIES) {
      const oldest = failedAutoReopens.keys().next().value;
      if (oldest !== undefined) failedAutoReopens.delete(oldest);
    }
    targets = new Set<string>();
    failedAutoReopens.set(key, targets);
  }
  targets.add(targetEncoding.toLowerCase());
}

export function hasAutoReopenFailed(uri: vscode.Uri, targetEncoding: string): boolean {
  return failedAutoReopens.get(uri.toString())?.has(targetEncoding.toLowerCase()) === true;
}

export function clearAutoReopenFailure(uri?: vscode.Uri): void {
  if (!uri) {
    failedAutoReopens.clear();
    return;
  }
  failedAutoReopens.delete(uri.toString());
}

export function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  else if (map.size >= MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function clearFileEncodingInspection(uri?: vscode.Uri): void {
  if (!uri) {
    inspectedFileDocuments.clear();
    invalidateAllInspections();
    return;
  }
  const key = uri.toString();
  inspectedFileDocuments.delete(key);
  invalidateInspectionsForKey(key);
}

export function clearCleanFileEncodingInspections(): void {
  const dirtyUris = new Set(
    (vscode.workspace.textDocuments ?? [])
      .filter((doc) => doc.isDirty)
      .map((doc) => doc.uri.toString()),
  );
  for (const key of [...inspectedFileDocuments.keys()]) {
    if (!dirtyUris.has(key)) {
      inspectedFileDocuments.delete(key);
    }
  }
  for (const key of [...activeInspectionInvalidators.keys()]) {
    if (!dirtyUris.has(key)) {
      invalidateInspectionsForKey(key);
    }
  }
}

export function clearEncodingDetectionCache(uri?: vscode.Uri): void {
  if (!uri) {
    byteClassificationCache.clear();
    resolvedSides.clear();
    return;
  }
  const targets = new Set([uri.toString(), fileUriForResource(uri).toString()]);
  for (const key of [...byteClassificationCache.keys()]) {
    for (const target of targets) {
      if (key.startsWith(`${target}::`)) byteClassificationCache.delete(key);
    }
  }
  for (const target of targets) resolvedSides.delete(target);
}

export function beginOpeningDocument(key: string): boolean {
  if (openingDocuments.has(key)) return false;
  openingDocuments.add(key);
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  openingPromises.set(key, { promise, resolve });
  return true;
}

export function endOpeningDocument(key: string): void {
  openingDocuments.delete(key);
  const entry = openingPromises.get(key);
  if (entry) {
    openingPromises.delete(key);
    entry.resolve();
  }
}

export function isOpeningDocument(uri: vscode.Uri): boolean {
  return openingDocuments.has(uri.toString());
}

export async function waitForOpeningDocument(uri: vscode.Uri): Promise<void> {
  const entry = openingPromises.get(uri.toString());
  if (entry) await entry.promise;
}

export function isManualEncodingOverride(uri: vscode.Uri): boolean {
  return manualSides.has(uri.toString());
}

export function forgetManualEncoding(uri: vscode.Uri): void {
  const key = uri.toString();
  manualSides.delete(key);
  autoDetectedUris.delete(key);
  guessedUris.delete(key);
  clearAutoReopenFailure(uri);
  clearEncodingDetectionCache(uri);
  clearFileEncodingInspection(uri);
}

/** Disposes per-URI caches and session state for a closed document without touching sibling working-file baselines. */
export function disposeClosedDocumentState(uri: vscode.Uri): void {
  const key = uri.toString();
  manualSides.delete(key);
  autoDetectedUris.delete(key);
  guessedUris.delete(key);
  failedAutoReopens.delete(key);
  pendingAlignHints.delete(key);
  resolvedSides.delete(key);
  for (const cacheKey of [...byteClassificationCache.keys()]) {
    if (cacheKey.startsWith(`${key}::`)) {
      byteClassificationCache.delete(cacheKey);
    }
  }
  clearFileEncodingInspection(uri);
}

function isActiveTabPlainTextFor(tab: vscode.Tab | undefined, activeUri: string | undefined): boolean {
  if (!tab || !activeUri) return false;
  const input = tab.input;
  if (vscode.TabInputText && input instanceof vscode.TabInputText) {
    return input.uri.toString() === activeUri;
  }
  return false;
}

function candidateActiveTabs(): readonly vscode.Tab[] {
  const tabs: vscode.Tab[] = [];
  const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  if (activeTab) tabs.push(activeTab);
  for (const group of vscode.window.tabGroups?.all ?? []) {
    if (group.activeTab && group.activeTab !== activeTab) {
      tabs.push(group.activeTab);
    }
  }
  return tabs;
}

function multiDiffComparisonsForTab(tab: vscode.Tab | undefined): readonly ActiveComparison[] {
  const diffs = extractMultiDiffInputs(tab?.input);
  if (!diffs) return [];
  return diffs.map((diff) => ({
    original: diff.original,
    modified: diff.modified,
    label: tab?.label,
    preview: tab?.isPreview === true,
    multiDiff: true,
  }));
}

function isActiveTabSingleDiffFor(tab: vscode.Tab | undefined, activeUri: string | undefined): boolean {
  if (!tab || !activeUri) return false;
  const input = tab.input;
  if (vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff) {
    return input.original.toString() === activeUri || input.modified.toString() === activeUri;
  }
  return false;
}

export function activeMultiDiffComparisons(): readonly ActiveComparison[] {
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const tabs = candidateActiveTabs();
  if (isActiveTabPlainTextFor(tabs[0], activeUri) || isActiveTabSingleDiffFor(tabs[0], activeUri)) {
    return [];
  }
  if (activeUri) {
    for (const tab of tabs) {
      const diffs = multiDiffComparisonsForTab(tab);
      if (
        diffs.some(
          (diff) => diff.original.toString() === activeUri || diff.modified.toString() === activeUri,
        )
      ) {
        return diffs;
      }
    }
  }
  return multiDiffComparisonsForTab(tabs[0]);
}

export function activeComparison(): ActiveComparison | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const tabs = candidateActiveTabs();
  if (isActiveTabPlainTextFor(tabs[0], activeUri)) return undefined;
  if (activeUri) {
    for (const tab of tabs) {
      const input = tab.input;
      if (vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff) {
        if (input.original.toString() === activeUri || input.modified.toString() === activeUri) {
          return {
            original: input.original,
            modified: input.modified,
            label: tab.label,
            preview: tab.isPreview === true,
          };
        }
      }
      const multiDiffs = multiDiffComparisonsForTab(tab);
      const focused = multiDiffs.find(
        (diff) => diff.original.toString() === activeUri || diff.modified.toString() === activeUri,
      );
      if (focused) return focused;
    }
  }
  const primaryTab = tabs[0];
  const primaryInput = primaryTab?.input;
  if (primaryTab && vscode.TabInputTextDiff && primaryInput instanceof vscode.TabInputTextDiff) {
    return {
      original: primaryInput.original,
      modified: primaryInput.modified,
      label: primaryTab.label,
      preview: primaryTab.isPreview === true,
    };
  }
  const multiDiffs = multiDiffComparisonsForTab(primaryTab);
  if (multiDiffs.length === 0) return undefined;
  const visibleUris = new Set(
    (vscode.window.visibleTextEditors ?? []).map((editor) => editor.document.uri.toString()),
  );
  const visible = multiDiffs.find(
    (diff) => visibleUris.has(diff.original.toString()) || visibleUris.has(diff.modified.toString()),
  );
  if (visible) return visible;
  const loaded = multiDiffs.find((diff) =>
    Boolean(findDocument(diff.modified) ?? findDocument(diff.original)),
  );
  return loaded ?? multiDiffs[0];
}

export function activeComparisonDocument(): vscode.TextDocument | undefined {
  const comparison = activeComparison();
  if (!comparison) return undefined;
  return findDocument(comparison.modified) ?? findDocument(comparison.original);
}

export function activeSingleGit(): ActiveSingleGit | undefined {
  if (activeComparison()) return undefined;
  const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  if (tab) {
    const input = tab.input;
    if (vscode.TabInputText && input instanceof vscode.TabInputText) {
      return input.uri.scheme === "git" ? { uri: input.uri, preview: tab.isPreview === true } : undefined;
    }
    if (input && typeof input === "object" && "uri" in input) {
      const candidate = (input as { uri?: vscode.Uri }).uri;
      return candidate?.scheme === "git"
        ? { uri: candidate, preview: tab.isPreview === true }
        : undefined;
    }
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document;
  return active?.uri.scheme === "git" ? { uri: active.uri, preview: false } : undefined;
}

export function findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return (vscode.workspace.textDocuments ?? []).find(
    (entry) => entry.uri.toString() === uri.toString(),
  );
}

export function involves(comparison: ComparisonInput, document: vscode.TextDocument): boolean {
  return [comparison.original, comparison.modified].some(
    (uri) => uri.toString() === document.uri.toString(),
  );
}

function comparisonEncoding(uri: vscode.Uri): string {
  const document = findDocument(uri);
  return document ? encodingInfo(document.encoding).label : t("Loading...");
}

export function comparisonLabel(input: ComparisonInput): string {
  const leftSide =
    input.original.scheme === "git"
      ? t("Git")
      : input.original.scheme === "file"
        ? t("Original")
        : t("Original (Virtual)");
  const rightSide =
    input.modified.scheme === "git"
      ? t("Git")
      : input.modified.scheme === "file"
        ? t("Working")
        : t("Modified (Virtual)");
  return t(
    "Left ({0}): {1} / Right ({2}): {3}",
    leftSide,
    comparisonEncoding(input.original),
    rightSide,
    comparisonEncoding(input.modified),
  );
}

export function sideName(input: ComparisonInput, side: "original" | "modified"): string {
  if (side === "original") {
    if (input.original.scheme === "git") return t("Left side (Git)");
    if (input.original.scheme === "file") return t("Left side (Original)");
    return t("Left side (Original, Virtual)");
  }
  if (input.modified.scheme === "git") return t("Right side (Git)");
  if (input.modified.scheme === "file") return t("Right side (Working)");
  return t("Right side (Modified, Virtual)");
}

function isTextDocumentLike(target: vscode.Uri | vscode.TextDocument): target is vscode.TextDocument {
  return "uri" in target;
}

export function effectiveDefaultFilesEncoding(target: vscode.Uri | vscode.TextDocument): string {
  const uri = isTextDocumentLike(target)
    ? fileUriForResource(target.uri)
    : fileUriForResource(target);
  const languageId =
    isTextDocumentLike(target) &&
    typeof target.languageId === "string" &&
    target.languageId.length > 0
      ? target.languageId
      : undefined;
  const scope: vscode.ConfigurationScope = languageId ? { uri, languageId } : uri;
  const configured = vscode.workspace
    .getConfiguration?.("files", scope)
    ?.get<string>("encoding", "utf8");
  return typeof configured === "string" && configured.length > 0 ? configured : "utf8";
}

export function effectiveStatusBarVisibility(uri: vscode.Uri): StatusBarVisibility {
  const scopeUri = fileUriForResource(uri);
  const folder = vscode.workspace.getWorkspaceFolder?.(scopeUri);
  const raw = configurationFor(folder ?? scopeUri).get<unknown>("statusBarVisibility", "relevant");
  if (raw === "compact" || raw === "always") {
    return raw;
  }
  return "relevant";
}

export function storedOpenEncodingBasis(
  key: string,
  encoding: string,
  fallback: "openFile" | "detected" = "openFile",
): EncodingBasis {
  if (manualSides.has(key)) return "openFile";
  if (sameEncoding(guessedUris.get(key), encoding)) return "guessed";
  if (sameEncoding(autoDetectedUris.get(key), encoding)) return "detected";
  return fallback;
}

export function syncPreferredResolution(
  uri: vscode.Uri,
  counterpartUri?: vscode.Uri,
): { encoding: string; basis: EncodingBasis; match?: RuleMatch } | undefined {
  const match = resolveRule(uri);
  if (match) return { encoding: match.rule.encoding, basis: "rule", match };
  if (counterpartUri && uri.scheme === "git") {
    const otherMatch = resolveRule(counterpartUri);
    if (otherMatch) {
      return { encoding: otherMatch.rule.encoding, basis: "ruleFallback", match: otherMatch };
    }
  }
  const candidates =
    uri.scheme === "git"
      ? [uri, ...(counterpartUri ? [counterpartUri] : [])]
      : uri.scheme === "file"
        ? [uri]
        : [];
  for (const candidate of candidates) {
    const fileUri = fileUriForResource(candidate);
    const open = findDocument(fileUri);
    if (!open || open.uri.scheme !== "file") continue;
    const fallback = effectiveDefaultFilesEncoding(open);
    if (!sameEncoding(open.encoding, fallback)) {
      return {
        encoding: open.encoding,
        basis: storedOpenEncodingBasis(open.uri.toString(), open.encoding),
      };
    }
  }
  return undefined;
}

export function maxResourceBytes(uri: vscode.Uri): number {
  const raw = configurationFor(fileUriForResource(uri)).get<number>("maxFileSizeKB", 5120);
  return typeof configuredFileSizeLimit === "function"
    ? configuredFileSizeLimit(raw)
    : 5 * 1024 * 1024;
}

export function countReplacementCharacters(text: string): number {
  let count = 0;
  let index = text.indexOf("\uFFFD");
  while (index !== -1) {
    count += 1;
    index = text.indexOf("\uFFFD", index + 1);
  }
  return count;
}

export function isDocumentEncodingMatch(document: vscode.TextDocument, match: RuleMatch): boolean {
  return sameEncoding(document.encoding, match.rule.encoding);
}

export function uniqueCandidates(resolutions: readonly SideResolution[]): string[] {
  return [
    ...new Set(resolutions.flatMap((res) => (!res.encoding && res.candidates ? res.candidates : []))),
  ];
}
