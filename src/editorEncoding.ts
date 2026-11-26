import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "./l10n.js";
import { rankDecodedCandidates, type RankedEncodingCandidate } from "./candidatePreview.js";
import { classifyEncoding, classifyTextLineEndings, classifyLineEndings, type EncodingClassification } from "./scanCore.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import { ENCODINGS, encodingInfo } from "./rules.js";
import { RuleMatch, resolveRule, configurationFor, fileUriForResource, clearWorkspaceRuleCache } from "./workspaceRules.js";

interface ComparisonInput { original: vscode.Uri; modified: vscode.Uri }
interface ActiveComparison extends ComparisonInput { label?: string; preview: boolean; multiDiff?: boolean }
interface ActiveSingleGit { uri: vscode.Uri; preview: boolean }

const MAX_MULTI_DIFF_ENTRIES = 64;
const MAX_MULTI_DIFF_SCAN = 4096;

function isReopenableScheme(scheme: string): boolean {
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

type EncodingBasis = "rule" | "ruleFallback" | "openFile" | "detected";

interface SideResolution {
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

const MAX_CACHE_ENTRIES = 128;
const CACHE_TTL_MS = 60_000;
const ASCII_COMPATIBLE = new Set(["utf8", "shiftjis", "eucjp", "windows1252", "iso88591"]);

const byteClassificationCache = new Map<string, {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly classification: EncodingClassification;
  readonly empty: boolean;
  readonly replacementCharacterCount?: number;
}>();
const resolvedSides = new Map<string, { readonly resolution: SideResolution; readonly updatedAt: number }>();
const inspectedFileDocuments = new Map<string, FileEncodingInspection>();
const activeInspectionInvalidators = new Map<string, Set<() => void>>();
const autoDetectedUris = new Map<string, string>();
const failedAutoReopens = new Map<string, Set<string>>();

function sameEncoding(left?: string, right?: string): boolean {
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

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
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

function activeMultiDiffComparisons(): readonly ActiveComparison[] {
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const tabs = candidateActiveTabs();
  if (isActiveTabPlainTextFor(tabs[0], activeUri) || isActiveTabSingleDiffFor(tabs[0], activeUri)) return [];
  if (activeUri) {
    for (const tab of tabs) {
      const diffs = multiDiffComparisonsForTab(tab);
      if (diffs.some((diff) => diff.original.toString() === activeUri || diff.modified.toString() === activeUri)) {
        return diffs;
      }
    }
  }
  return multiDiffComparisonsForTab(tabs[0]);
}

function activeComparison(): ActiveComparison | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
  const tabs = candidateActiveTabs();
  if (isActiveTabPlainTextFor(tabs[0], activeUri)) return undefined;
  if (activeUri) {
    for (const tab of tabs) {
      const input = tab.input;
      if (vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff) {
        if (input.original.toString() === activeUri || input.modified.toString() === activeUri) {
          return { original: input.original, modified: input.modified, label: tab.label, preview: tab.isPreview === true };
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
    return { original: primaryInput.original, modified: primaryInput.modified, label: primaryTab.label, preview: primaryTab.isPreview === true };
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
  const loaded = multiDiffs.find((diff) => Boolean(findDocument(diff.modified) ?? findDocument(diff.original)));
  return loaded ?? multiDiffs[0];
}

export function activeComparisonDocument(): vscode.TextDocument | undefined {
  const comparison = activeComparison();
  if (!comparison) return undefined;
  return findDocument(comparison.modified) ?? findDocument(comparison.original);
}

function activeSingleGit(): ActiveSingleGit | undefined {
  if (activeComparison()) return undefined;
  const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  if (tab) {
    const input = tab.input;
    if (vscode.TabInputText && input instanceof vscode.TabInputText) {
      return input.uri.scheme === "git" ? { uri: input.uri, preview: tab.isPreview === true } : undefined;
    }
    if (input && typeof input === "object" && "uri" in input) {
      const candidate = (input as { uri?: vscode.Uri }).uri;
      return candidate?.scheme === "git" ? { uri: candidate, preview: tab.isPreview === true } : undefined;
    }
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document;
  return active?.uri.scheme === "git" ? { uri: active.uri, preview: false } : undefined;
}

function findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return (vscode.workspace.textDocuments ?? []).find((entry) => entry.uri.toString() === uri.toString());
}

function comparisonEncoding(uri: vscode.Uri): string {
  const document = findDocument(uri);
  return document ? encodingInfo(document.encoding).label : t("Loading...");
}

function comparisonLabel(input: ComparisonInput): string {
  const leftSide = input.original.scheme === "git"
    ? t("Git")
    : input.original.scheme === "file"
      ? t("Original")
      : t("Original (Virtual)");
  const rightSide = input.modified.scheme === "git"
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

function sideName(input: ComparisonInput, side: "original" | "modified"): string {
  if (side === "original") {
    if (input.original.scheme === "git") return t("Left side (Git)");
    if (input.original.scheme === "file") return t("Left side (Original)");
    return t("Left side (Original, Virtual)");
  }
  if (input.modified.scheme === "git") return t("Right side (Git)");
  if (input.modified.scheme === "file") return t("Right side (Working)");
  return t("Right side (Modified, Virtual)");
}

function syncPreferredResolution(uri: vscode.Uri, counterpartUri?: vscode.Uri): { encoding: string; basis: EncodingBasis; match?: RuleMatch } | undefined {
  const match = resolveRule(uri);
  if (match) return { encoding: match.rule.encoding, basis: "rule", match };
  if (counterpartUri && uri.scheme === "git") {
    const otherMatch = resolveRule(counterpartUri);
    if (otherMatch) return { encoding: otherMatch.rule.encoding, basis: "ruleFallback", match: otherMatch };
  }
  const candidates = uri.scheme === "git"
    ? [uri, ...(counterpartUri ? [counterpartUri] : [])]
    : uri.scheme === "file"
      ? [uri]
      : [];
  for (const candidate of candidates) {
    const fileUri = fileUriForResource(candidate);
    const open = findDocument(fileUri);
    if (!open || open.uri.scheme !== "file") continue;
    const fallback = vscode.workspace.getConfiguration("files", fileUri).get<string>("encoding", "utf8");
    if (!sameEncoding(open.encoding, fallback)) {
      const autoDetected = sameEncoding(autoDetectedUris.get(open.uri.toString()), open.encoding);
      return { encoding: open.encoding, basis: autoDetected ? "detected" : "openFile" };
    }
  }
  return undefined;
}

function maxResourceBytes(uri: vscode.Uri): number {
  const raw = configurationFor(fileUriForResource(uri)).get<number>("maxFileSizeKB", 5120);
  return typeof configuredFileSizeLimit === "function" ? configuredFileSizeLimit(raw) : 5 * 1024 * 1024;
}

interface ResourceBytes {
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  readonly stillCurrent?: () => Promise<boolean>;
}

async function readResourceBytes(
  uri: vscode.Uri,
  maxSize: number,
  isInvalid: () => boolean = () => !!findDocument(uri)?.isDirty,
): Promise<ResourceBytes | undefined> {
  try {
    if (uri.scheme === "file") {
      if (typeof readStableResource !== "function" || typeof resourceStillMatchesRead !== "function") return undefined;
      const read = await readStableResource(uri, maxSize, isInvalid);
      if (!read) return undefined;
      return {
        bytes: read.bytes,
        fingerprint: `file:${read.localFile?.contentHash ?? `${read.mtime}:${read.size}`}`,
        stillCurrent: () => resourceStillMatchesRead(uri, maxSize, read, isInvalid),
      };
    }
    if (uri.scheme === "git") {
      const fsApi = vscode.workspace.fs;
      if (!fsApi?.readFile) return undefined;
      const stat = fsApi.stat ? await fsApi.stat(uri) : undefined;
      const fileType = vscode.FileType?.File ?? 1;
      if (stat && ((stat.type !== undefined && stat.type !== fileType) || stat.size > maxSize)) return undefined;
      const bytes = await fsApi.readFile(uri);
      if (bytes.byteLength > maxSize) return undefined;
      const version = findDocument(uri)?.version ?? 0;
      return { bytes, fingerprint: `git:${uri.query}:${stat?.mtime ?? 0}:${bytes.byteLength}:v${version}` };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function countReplacementCharactersInBytes(bytes: Uint8Array, encoding: string): Promise<number> {
  if (typeof vscode.workspace.decode !== "function") return 1;
  const normalized = encoding.toLowerCase();
  const bomLength = normalized === "utf8bom" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const decodeEncoding = normalized === "utf8bom" ? "utf8" : normalized;
  try {
    const text = await vscode.workspace.decode(bytes.subarray(bomLength), { encoding: decodeEncoding });
    return countReplacementCharacters(text);
  } catch {
    return 1;
  }
}

async function inspectUriBytes(
  uri: vscode.Uri,
  expectedEncoding: string,
  isInvalid?: () => boolean,
): Promise<{ classification: EncodingClassification; empty: boolean; replacementCharacterCount?: number } | undefined> {
  if (typeof classifyEncoding !== "function" ||
    typeof vscode.workspace.decode !== "function" ||
    typeof vscode.workspace.encode !== "function") {
    return undefined;
  }
  const read = await readResourceBytes(uri, maxResourceBytes(uri), isInvalid);
  if (!read) return undefined;
  const cacheKey = `${uri.toString()}::${expectedEncoding}`;
  const now = Date.now();
  const cached = byteClassificationCache.get(cacheKey);
  if (cached && cached.fingerprint === read.fingerprint && cached.expiresAt > now) {
    return !read.stillCurrent || await read.stillCurrent()
      ? {
          classification: cached.classification,
          empty: cached.empty,
          replacementCharacterCount: cached.replacementCharacterCount,
        }
      : undefined;
  }
  try {
    const classification = await classifyEncoding(read.bytes, expectedEncoding, {
      decode: async (bytes, encoding) => vscode.workspace.decode(bytes, { encoding }),
      encode: async (text, encoding) => vscode.workspace.encode(text, { encoding }),
    }, { allowNonCanonicalShiftJis: true });
    const replacementCharacterCount = classification.replacementCharacterEncoding
      ? await countReplacementCharactersInBytes(read.bytes, classification.replacementCharacterEncoding)
      : undefined;
    if (read.stillCurrent && !(await read.stillCurrent())) return undefined;
    const empty = read.bytes.byteLength === 0;
    setBounded(byteClassificationCache, cacheKey, {
      fingerprint: read.fingerprint,
      expiresAt: now + CACHE_TTL_MS,
      classification,
      empty,
      replacementCharacterCount,
    });
    return { classification, empty, replacementCharacterCount };
  } catch {
    return undefined;
  }
}

function compatibleWithAscii(encoding: string, empty: boolean): boolean {
  const normalized = encoding.toLowerCase();
  return empty || ASCII_COMPATIBLE.has(normalized) || normalized === "utf8bom";
}

async function classifySide(uri: vscode.Uri, counterpartUri?: vscode.Uri): Promise<SideResolution> {
  const directMatch = resolveRule(uri);
  const preferred = syncPreferredResolution(uri, counterpartUri);
  const inspected = await inspectUriBytes(uri, preferred?.encoding ?? "utf8");
  if (uri.scheme === "file" && directMatch) return resolveWorkingFileRule(directMatch, inspected);
  if (!inspected) {
    return preferred
      ? { encoding: preferred.encoding, basis: preferred.basis, match: directMatch ?? preferred.match }
      : { match: directMatch };
  }
  const { classification, empty } = inspected;
  if (classification.kind === "skip") {
    return { match: directMatch ?? preferred?.match };
  }
  if (preferred) {
    const confirmed = classification.kind === "match" ||
      (classification.kind === "ascii" && compatibleWithAscii(preferred.encoding, empty)) ||
      (classification.kind === "ambiguous" && classification.candidates?.includes(preferred.encoding) === true);
    if (confirmed) {
      return {
        encoding: preferred.encoding,
        basis: preferred.basis,
        match: directMatch ?? preferred.match,
        ascii: classification.kind === "ascii",
        empty,
      };
    }
    if (classification.kind === "mismatch" && classification.detectedEncoding) {
      return {
        encoding: classification.detectedEncoding,
        basis: "detected",
        match: directMatch ?? preferred.match,
        actualMismatch: true,
      };
    }
    if (classification.kind === "ambiguous") {
      return { candidates: classification.candidates, match: directMatch ?? preferred.match, actualMismatch: true };
    }
    return { encoding: preferred.encoding, basis: preferred.basis, match: directMatch ?? preferred.match };
  }
  if (classification.kind === "ascii") return { ascii: true, empty };
  if ((classification.kind === "match" || classification.kind === "mismatch") && classification.detectedEncoding) {
    return { encoding: classification.detectedEncoding, basis: "detected" };
  }
  if (classification.kind === "ambiguous") return { candidates: classification.candidates };
  return {};
}

function resolveWorkingFileRule(
  match: RuleMatch,
  inspected: { classification: EncodingClassification; empty: boolean } | undefined,
): SideResolution {
  const encoding = match.rule.encoding;
  const classification = inspected?.classification;
  if (classification?.kind === "match" ||
      (classification?.kind === "ascii" && compatibleWithAscii(encoding, inspected?.empty === true))) {
    return { encoding, basis: "rule", match };
  }
  if (classification?.kind === "mismatch" && classification.detectedEncoding) {
    return { encoding: classification.detectedEncoding, basis: "detected", match, actualMismatch: true };
  }
  return { match, keepCurrentEncoding: true, candidates: classification?.candidates };
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

function storeFileInspection(key: string, inspection: FileEncodingInspection): FileEncodingInspection {
  setBounded(inspectedFileDocuments, key, inspection);
  return inspection;
}

function replacementCountIfMatched(
  inspected: { readonly classification: EncodingClassification; readonly replacementCharacterCount?: number },
  encoding: string,
): { readonly has: boolean; readonly count: number } {
  if (inspected.classification.replacementCharacterEncoding?.toLowerCase() !== encoding.toLowerCase()) {
    return { has: false, count: 0 };
  }
  const count = inspected.replacementCharacterCount ?? 1;
  return { has: count > 0, count };
}

type InspectedBytes = {
  readonly classification: EncodingClassification;
  readonly empty: boolean;
  readonly replacementCharacterCount?: number;
};

async function evaluateDocumentBytes(
  document: vscode.TextDocument,
  docEncoding: string,
  key: string,
  isInvalid: () => boolean,
  stillValid: () => boolean,
  preloadedUtf8?: InspectedBytes,
): Promise<Omit<FileEncodingInspection, "match" | "ruleConfirmed"> | undefined> {
  const isManual = manualSides.has(key);
  if (isManual && docEncoding !== "utf8") {
    const current = await inspectUriBytes(document.uri, docEncoding, isInvalid);
    if (!stillValid() || !current || current.classification.kind === "skip") return undefined;
    if (
      current.classification.kind === "match" ||
      (current.classification.kind === "ascii" && (current.empty || ASCII_COMPATIBLE.has(docEncoding))) ||
      (current.classification.kind === "ambiguous" &&
        current.classification.candidates?.some((candidate) => candidate.toLowerCase() === docEncoding) === true)
    ) {
      const replacement = replacementCountIfMatched(current, docEncoding);
      return {
        documentEncoding: docEncoding,
        status: "ok",
        detectedEncoding: current.classification.kind === "ascii" ? undefined : docEncoding,
        basis: "openFile",
        initialHadReplacementCharacter: replacement.has,
        initialReplacementCharacterCount: replacement.count,
      };
    }
  }

  const inspected = preloadedUtf8 ?? await inspectUriBytes(document.uri, "utf8", isInvalid);
  if (!stillValid() || !inspected || inspected.classification.kind === "skip") {
    return undefined;
  }
  const { classification, empty } = inspected;

  if (classification.kind === "ascii") {
    if (empty || ASCII_COMPATIBLE.has(docEncoding)) {
      return {
        documentEncoding: docEncoding,
        status: "ok",
        initialHadReplacementCharacter: false,
        initialReplacementCharacterCount: 0,
      };
    }
    return {
      documentEncoding: docEncoding,
      status: "detectedMismatch",
      detectedEncoding: "utf8",
      initialHadReplacementCharacter: false,
      initialReplacementCharacterCount: 0,
    };
  }

  if ((classification.kind === "match" || classification.kind === "mismatch") && classification.detectedEncoding) {
    const detected = classification.detectedEncoding.toLowerCase();
    if (docEncoding === detected) {
      const replacement = replacementCountIfMatched(inspected, detected);
      const basis: EncodingBasis | undefined = isManual
        ? "openFile"
        : autoDetectedUris.get(key)?.toLowerCase() === docEncoding || docEncoding !== "utf8"
          ? "detected"
          : undefined;
      return {
        documentEncoding: docEncoding,
        status: "ok",
        detectedEncoding: detected,
        basis,
        initialHadReplacementCharacter: replacement.has,
        initialReplacementCharacterCount: replacement.count,
      };
    }
    if (detected === "utf8" && (docEncoding === "shiftjis" || docEncoding === "eucjp")) {
      const current = await inspectUriBytes(document.uri, docEncoding, isInvalid);
      if (!stillValid()) return undefined;
      if (current?.classification.kind === "ambiguous" && current.classification.candidates?.some((c) => c.toLowerCase() === docEncoding)) {
        const replacement = replacementCountIfMatched(current, docEncoding);
        return {
          documentEncoding: docEncoding,
          status: "ok",
          detectedEncoding: docEncoding,
          basis: isManual ? "openFile" : autoDetectedUris.get(key)?.toLowerCase() === docEncoding ? "detected" : "openFile",
          initialHadReplacementCharacter: replacement.has,
          initialReplacementCharacterCount: replacement.count,
        };
      }
    }
    return {
      documentEncoding: docEncoding,
      status: "detectedMismatch",
      detectedEncoding: detected,
      initialHadReplacementCharacter: false,
      initialReplacementCharacterCount: 0,
    };
  }

  if (classification.kind === "ambiguous" && classification.candidates?.length) {
    if (classification.candidates.some((candidate) => candidate.toLowerCase() === docEncoding)) {
      const replacement = replacementCountIfMatched(inspected, docEncoding);
      return {
        documentEncoding: docEncoding,
        status: "ok",
        detectedEncoding: docEncoding,
        basis: isManual
          ? "openFile"
          : autoDetectedUris.get(key)?.toLowerCase() === docEncoding
            ? "detected"
            : "openFile",
        initialHadReplacementCharacter: replacement.has,
        initialReplacementCharacterCount: replacement.count,
      };
    }
    return {
      documentEncoding: docEncoding,
      status: "candidateMismatch",
      candidates: classification.candidates,
      initialHadReplacementCharacter: false,
      initialReplacementCharacterCount: 0,
    };
  }

  if (docEncoding !== "utf8") {
    const current = await inspectUriBytes(document.uri, docEncoding, isInvalid);
    if (!stillValid()) return undefined;
    if (
      current?.classification.kind === "match" ||
      (current?.classification.kind === "ambiguous" &&
        current.classification.candidates?.some((candidate) => candidate.toLowerCase() === docEncoding))
    ) {
      const replacement = replacementCountIfMatched(current, docEncoding);
      return {
        documentEncoding: docEncoding,
        status: "ok",
        detectedEncoding: docEncoding,
        basis: isManual ? "openFile" : "detected",
        initialHadReplacementCharacter: replacement.has,
        initialReplacementCharacterCount: replacement.count,
      };
    }
  }

  return {
    documentEncoding: docEncoding,
    status: "decodeLoss",
    initialHadReplacementCharacter: false,
    initialReplacementCharacterCount: 0,
  };
}

/**
 * Inspects the saved bytes of a local workspace file against the active editor encoding and rule.
 * Returns any preserved session state while dirty without touching disk.
 */
export async function inspectFileDocument(document: vscode.TextDocument): Promise<FileEncodingInspection | undefined> {
  if (document.isClosed || document.uri.scheme !== "file") {
    return undefined;
  }
  const key = document.uri.toString();
  if (document.isDirty) {
    return inspectedFileDocuments.get(key);
  }
  const docEncoding = document.encoding.toLowerCase();
  const match = resolveRule(document.uri);
  const expectedRuleEncoding = match?.rule.encoding.toLowerCase();
  let invalidated = false;
  const markInvalid = (): void => { invalidated = true; };
  let invalidators = activeInspectionInvalidators.get(key);
  if (!invalidators) {
    invalidators = new Set();
    activeInspectionInvalidators.set(key, invalidators);
  }
  invalidators.add(markInvalid);
  const stillValid = (): boolean =>
    !invalidated &&
    !document.isClosed &&
    document.encoding.toLowerCase() === docEncoding &&
    resolveRule(document.uri)?.rule.encoding.toLowerCase() === expectedRuleEncoding;
  const isInvalid = (): boolean => !stillValid();

  try {
    if (!match || !expectedRuleEncoding) {
      const evaluated = await evaluateDocumentBytes(document, docEncoding, key, isInvalid, stillValid);
      if (!stillValid()) return inspectedFileDocuments.get(key);
      if (!evaluated) {
        inspectedFileDocuments.delete(key);
        return undefined;
      }
      return storeFileInspection(key, evaluated);
    }

    const inspected = await inspectUriBytes(document.uri, expectedRuleEncoding, isInvalid);
    if (!stillValid()) {
      return inspectedFileDocuments.get(key);
    }
    if (!inspected || inspected.classification.kind === "skip") {
      inspectedFileDocuments.delete(key);
      return undefined;
    }
    const { classification, empty } = inspected;

    const uniquelyMatchesRule =
      classification.kind === "match" ||
      (classification.kind === "ascii" && compatibleWithAscii(expectedRuleEncoding, empty));
    const ambiguousIncludesRule =
      classification.kind === "ambiguous" &&
      classification.candidates?.some((c) => c.toLowerCase() === expectedRuleEncoding) === true;
    if (uniquelyMatchesRule || (docEncoding === expectedRuleEncoding && ambiguousIncludesRule)) {
      if (docEncoding === expectedRuleEncoding) {
        const replacement = replacementCountIfMatched(inspected, expectedRuleEncoding);
        return storeFileInspection(key, {
          documentEncoding: docEncoding,
          match,
          ruleConfirmed: true,
          status: "ok",
          basis: "rule",
          initialHadReplacementCharacter: replacement.has,
          initialReplacementCharacterCount: replacement.count,
        });
      }
      let docCompatible =
        (classification.kind === "ascii" && (empty || ASCII_COMPATIBLE.has(docEncoding))) ||
        (classification.kind === "ambiguous" && classification.candidates?.some((c) => c.toLowerCase() === docEncoding) === true);
      if (!docCompatible && manualSides.has(key) && docEncoding !== "utf8") {
        const current = await inspectUriBytes(document.uri, docEncoding, isInvalid);
        if (!stillValid()) return inspectedFileDocuments.get(key);
        docCompatible = Boolean(
          current && (
            current.classification.kind === "match" ||
            (current.classification.kind === "ascii" && (current.empty || ASCII_COMPATIBLE.has(docEncoding))) ||
            (current.classification.kind === "ambiguous" &&
              current.classification.candidates?.some((c) => c.toLowerCase() === docEncoding) === true)
          ),
        );
      }
      if (docCompatible) {
        return storeFileInspection(key, {
          documentEncoding: docEncoding,
          match,
          ruleConfirmed: true,
          status: "ok",
          basis: manualSides.has(key) ? "openFile" : "rule",
          initialHadReplacementCharacter: false,
          initialReplacementCharacterCount: 0,
        });
      }
      return storeFileInspection(key, {
        documentEncoding: docEncoding,
        match,
        ruleConfirmed: true,
        status: "detectedMismatch",
        detectedEncoding: expectedRuleEncoding,
        initialHadReplacementCharacter: false,
        initialReplacementCharacterCount: 0,
      });
    }

    if (docEncoding !== expectedRuleEncoding) {
      const preloadedUtf8 = expectedRuleEncoding === "utf8" ? inspected : undefined;
      const evaluated = await evaluateDocumentBytes(document, docEncoding, key, isInvalid, stillValid, preloadedUtf8);
      if (!stillValid()) return inspectedFileDocuments.get(key);
      if (!evaluated) {
        inspectedFileDocuments.delete(key);
        return undefined;
      }
      return storeFileInspection(key, {
        ...evaluated,
        match,
        ruleConfirmed: false,
      });
    }

    if (classification.kind === "mismatch" && classification.detectedEncoding) {
      return storeFileInspection(key, {
        documentEncoding: docEncoding,
        match,
        ruleConfirmed: false,
        status: "detectedMismatch",
        detectedEncoding: classification.detectedEncoding,
        initialHadReplacementCharacter: false,
        initialReplacementCharacterCount: 0,
      });
    }
    if (classification.kind === "ambiguous" && classification.candidates?.length) {
      return storeFileInspection(key, {
        documentEncoding: docEncoding,
        match,
        ruleConfirmed: false,
        status: "candidateMismatch",
        candidates: classification.candidates,
        initialHadReplacementCharacter: false,
        initialReplacementCharacterCount: 0,
      });
    }
    return storeFileInspection(key, {
      documentEncoding: docEncoding,
      match,
      ruleConfirmed: false,
      status: "decodeLoss",
      initialHadReplacementCharacter: false,
      initialReplacementCharacterCount: 0,
    });
  } finally {
    invalidators.delete(markInvalid);
    if (invalidators.size === 0) activeInspectionInvalidators.delete(key);
  }
}

export function currentFileInspection(document: vscode.TextDocument): FileEncodingInspection | undefined {
  if (document.uri.scheme !== "file") return undefined;
  const key = document.uri.toString();
  const cached = inspectedFileDocuments.get(key);
  if (!cached) return undefined;
  const docEncoding = document.encoding.toLowerCase();
  const currentRule = resolveRule(document.uri)?.rule.encoding.toLowerCase();
  const cachedRule = cached.match?.rule.encoding.toLowerCase();
  if (currentRule !== cachedRule && !document.isDirty) {
    return undefined;
  }
  if (cached.documentEncoding === docEncoding) {
    return cached;
  }
  if (
    cached.status !== "ok" &&
    (cached.detectedEncoding?.toLowerCase() === docEncoding ||
      cached.candidates?.some((candidate) => candidate.toLowerCase() === docEncoding))
  ) {
    return {
      ...cached,
      documentEncoding: docEncoding,
      ruleConfirmed: currentRule ? currentRule === docEncoding || cached.ruleConfirmed === true : undefined,
      status: "ok",
      basis: currentRule
        ? undefined
        : manualSides.has(key)
          ? "openFile"
          : "detected",
      initialHadReplacementCharacter: false,
      initialReplacementCharacterCount: 0,
    };
  }
  return document.isDirty ? cached : undefined;
}

export async function canReopenWithRule(document: vscode.TextDocument, match: RuleMatch): Promise<boolean> {
  if (document.isDirty || document.isClosed || document.uri.scheme !== "file") return false;
  const version = document.version;
  const resolution = await classifySide(document.uri);
  return document.version === version && !document.isDirty && !document.isClosed && resolution.basis === "rule" &&
    sameEncoding(resolution.encoding, match.rule.encoding) &&
    sameEncoding(resolveRule(document.uri)?.rule.encoding, match.rule.encoding);
}

export async function canReopenWithDetectedEncoding(document: vscode.TextDocument, expectedEncoding: string): Promise<boolean> {
  if (document.isDirty || document.isClosed || document.uri.scheme !== "file") return false;
  const version = document.version;
  const inspection = await inspectFileDocument(document);
  return document.version === version && !document.isDirty && !document.isClosed &&
    !resolveRule(document.uri) && inspection?.status === "detectedMismatch" &&
    sameEncoding(inspection.detectedEncoding, expectedEncoding);
}

function reconcileSideWithCounterpart(side: SideResolution, other: SideResolution): SideResolution {
  if (side.keepCurrentEncoding) return side;
  if (!side.encoding && side.candidates?.length && other.encoding && side.candidates.includes(other.encoding)) {
    return { ...side, encoding: other.encoding, basis: other.basis ?? "detected", candidates: undefined };
  }
  if (!side.encoding && side.ascii && other.encoding && compatibleWithAscii(other.encoding, side.empty === true)) {
    return { ...side, encoding: other.encoding, basis: other.basis ?? "detected" };
  }
  return side;
}

async function resolveComparisonSides(comparison: ComparisonInput): Promise<[SideResolution, SideResolution]> {
  const [rawLeft, rawRight] = await Promise.all([
    classifySide(comparison.original, comparison.modified),
    classifySide(comparison.modified, comparison.original),
  ]);
  const left = reconcileSideWithCounterpart(rawLeft, rawRight);
  const right = reconcileSideWithCounterpart(rawRight, rawLeft);
  const now = Date.now();
  setBounded(resolvedSides, comparison.original.toString(), { resolution: left, updatedAt: now });
  setBounded(resolvedSides, comparison.modified.toString(), { resolution: right, updatedAt: now });
  return [left, right];
}

async function resolveSingleSide(uri: vscode.Uri): Promise<SideResolution> {
  const resolution = await classifySide(uri);
  setBounded(resolvedSides, uri.toString(), { resolution, updatedAt: Date.now() });
  return resolution;
}

function currentSideResolution(uri: vscode.Uri, counterpartUri?: vscode.Uri): SideResolution {
  const cached = resolvedSides.get(uri.toString());
  if (cached && Date.now() - cached.updatedAt <= CACHE_TTL_MS) {
    const directMatch = resolveRule(uri);
    if ((cached.resolution.match?.rule.encoding.toLowerCase() ?? undefined) === (directMatch?.rule.encoding.toLowerCase() ?? undefined)) {
      return cached.resolution;
    }
  }
  const preferred = syncPreferredResolution(uri, counterpartUri);
  return preferred
    ? { encoding: preferred.encoding, basis: preferred.basis, match: resolveRule(uri) ?? preferred.match }
    : { match: resolveRule(uri) };
}

export function isInAutoAlignedComparison(document: vscode.TextDocument): boolean {
  const multiDiffs = activeMultiDiffComparisons();
  if (multiDiffs.length > 0) {
    return multiDiffs.some(
      (comparison) =>
        autoAlignEnabled(comparison) &&
        [comparison.original, comparison.modified].some((uri) => uri.toString() === document.uri.toString()),
    );
  }
  const comparison = activeComparison();
  return !!comparison && autoAlignEnabled(comparison) &&
    [comparison.original, comparison.modified].some((uri) => uri.toString() === document.uri.toString());
}

function autoAlignSingleEnabled(uri: vscode.Uri): boolean {
  return uri.scheme === "git" && configurationFor(fileUriForResource(uri)).get<boolean>("autoReopenGitComparison", true);
}

function autoAlignEnabled(comparison: ActiveComparison): boolean {
  const schemes = [comparison.original.scheme, comparison.modified.scheme];
  const hasGit = schemes.includes("git");
  const hasReopenable = schemes.some((scheme) => isReopenableScheme(scheme));
  const hasVirtualPairedWithFile = schemes.includes("file") && schemes.some((scheme) => !isReopenableScheme(scheme));
  if (!hasReopenable) return false;
  if (!hasGit && !comparison.multiDiff && !hasVirtualPairedWithFile) return false;
  const scopeUri = comparison.modified.scheme === "file" || comparison.modified.scheme === "git"
    ? fileUriForResource(comparison.modified)
    : fileUriForResource(comparison.original);
  return configurationFor(scopeUri).get<boolean>("autoReopenGitComparison", true);
}

function visibleEmbeddedGitComparisons(hintUris: readonly vscode.Uri[] = []): readonly ActiveComparison[] {
  const seen = new Set<string>();
  const comparisons: ActiveComparison[] = [];
  const pushGitUri = (gitUri: vscode.Uri): void => {
    if (gitUri.scheme !== "git" || comparisons.length >= MAX_MULTI_DIFF_ENTRIES) return;
    const key = gitUri.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const fileUri = fileUriForResource(gitUri);
    comparisons.push({
      original: gitUri,
      modified: fileUri,
      preview: false,
      multiDiff: true,
    });
  };
  for (const hintUri of hintUris) {
    if (hintUri.scheme === "git") {
      pushGitUri(hintUri);
    }
  }
  for (const editor of vscode.window.visibleTextEditors ?? []) {
    if (editor.document.uri.scheme === "git") {
      pushGitUri(editor.document.uri);
    }
  }
  return comparisons;
}

let aligning = false;
let alignAgain = false;
const pendingAlignHints = new Map<string, vscode.Uri>();

/** Keeps active Git/Multi-Diff comparisons, embedded diff views, and single Git views in the expected or detected encoding (display only, never saves). */
export async function alignActiveComparison(hintUri?: vscode.Uri): Promise<boolean> {
  if (hintUri?.scheme === "git") {
    const key = hintUri.toString();
    if (pendingAlignHints.has(key)) pendingAlignHints.delete(key);
    else if (pendingAlignHints.size >= MAX_MULTI_DIFF_ENTRIES) {
      const oldest = pendingAlignHints.keys().next().value;
      if (oldest !== undefined) pendingAlignHints.delete(oldest);
    }
    pendingAlignHints.set(key, hintUri);
  }
  if (aligning) { alignAgain = true; return false; }
  aligning = true;
  let changed = false;
  try {
    do {
      alignAgain = false;
      const currentHints = [...pendingAlignHints.values()];
      pendingAlignHints.clear();
      const multiDiffs = activeMultiDiffComparisons();
      if (multiDiffs.length > 0) {
        const focused = activeComparison();
        const visibleUris = new Set(
          (vscode.window.visibleTextEditors ?? []).map((editor) => editor.document.uri.toString()),
        );
        const prioritized = [...multiDiffs].sort((a, b) => {
          const rank = (entry: ActiveComparison): number => {
            if (
              focused &&
              entry.original.toString() === focused.original.toString() &&
              entry.modified.toString() === focused.modified.toString()
            ) {
              return 0;
            }
            if (visibleUris.has(entry.original.toString()) || visibleUris.has(entry.modified.toString())) {
              return 1;
            }
            return 2;
          };
          return rank(a) - rank(b);
        });
        let inspectedCount = 0;
        for (const comparison of prioritized) {
          if (inspectedCount >= MAX_MULTI_DIFF_ENTRIES) break;
          if (!autoAlignEnabled(comparison)) continue;
          const leftDoc = findDocument(comparison.original);
          const rightDoc = findDocument(comparison.modified);
          if (!leftDoc && !rightDoc) continue;
          inspectedCount += 1;
          const [left, right] = await resolveComparisonSides(comparison);
          const pairs: [vscode.Uri, SideResolution, vscode.TextDocument | undefined][] = [
            [comparison.original, left, leftDoc],
            [comparison.modified, right, rightDoc],
          ];
          const items = pairs.flatMap(([uri, res, doc]) => {
            if (!doc || !isReopenableScheme(uri.scheme) || manualSides.has(uri.toString()) || !res.encoding) return [];
            return !sameEncoding(doc.encoding, res.encoding)
              ? [{ uri, encoding: res.encoding, basis: res.basis }]
              : [];
          });
          if (items.length > 0) {
            const result = await reopenComparisonSides(comparison, items);
            if (result.changed) {
              changed = true;
            }
          }
        }
        continue;
      }
      const comparison = activeComparison();
      if (comparison) {
        if (!autoAlignEnabled(comparison)) break;
        const [left, right] = await resolveComparisonSides(comparison);
        const pairs: [vscode.Uri, SideResolution][] = [[comparison.original, left], [comparison.modified, right]];
        const items = pairs.flatMap(([uri, res]) => {
          if (!isReopenableScheme(uri.scheme) || manualSides.has(uri.toString()) || !res.encoding) return [];
          return !sameEncoding(findDocument(uri)?.encoding, res.encoding) ? [{ uri, encoding: res.encoding, basis: res.basis }] : [];
        });
        if (items.length > 0) changed = (await reopenComparisonSides(comparison, items)).changed || changed;
        continue;
      }
      const single = activeSingleGit();
      if (single) {
        if (!autoAlignSingleEnabled(single.uri)) break;
        const res = await resolveSingleSide(single.uri);
        if (!manualSides.has(single.uri.toString()) && res.encoding && !sameEncoding(findDocument(single.uri)?.encoding, res.encoding)) {
          changed = (await reopenSingleGit(single, res.encoding, res.basis)) || changed;
        }
        continue;
      }
      const embedded = visibleEmbeddedGitComparisons(currentHints);
      for (const embeddedComparison of embedded) {
        if (!autoAlignEnabled(embeddedComparison)) continue;
        const leftDoc = findDocument(embeddedComparison.original);
        const rightDoc = findDocument(embeddedComparison.modified);
        if (!leftDoc && !rightDoc) continue;
        const [left, right] = await resolveComparisonSides(embeddedComparison);
        const pairs: [vscode.Uri, SideResolution, vscode.TextDocument | undefined][] = [
          [embeddedComparison.original, left, leftDoc],
          [embeddedComparison.modified, right, rightDoc],
        ];
        const items = pairs.flatMap(([uri, res, doc]) => {
          if (!doc || !isReopenableScheme(uri.scheme) || manualSides.has(uri.toString()) || !res.encoding) return [];
          return !sameEncoding(doc.encoding, res.encoding)
            ? [{ uri, encoding: res.encoding, basis: res.basis }]
            : [];
        });
        if (items.length > 0) changed = (await reopenComparisonSides(embeddedComparison, items)).changed || changed;
      }
    } while (alignAgain);
  } catch {
    console.error("Auto Encoding: Failed to reopen Git comparison.");
  } finally { aligning = false; }
  return changed;
}

export function isDocumentEncodingMatch(document: vscode.TextDocument, match: RuleMatch): boolean {
  return sameEncoding(document.encoding, match.rule.encoding);
}

export function diagnosticFor(document: vscode.TextDocument): vscode.Diagnostic | undefined {
  if (document.isClosed || document.uri.scheme === "git") return undefined;
  if (document.uri.scheme === "file" && !vscode.workspace.getWorkspaceFolder?.(document.uri)) return undefined;
  const match = resolveRule(document.uri);
  const actual = encodingInfo(document.encoding).label;
  let message: string | undefined;
  if (match && !isDocumentEncodingMatch(document, match)) {
    const expected = encodingInfo(match.rule.encoding).label;
    const inspection = currentFileInspection(document);
    if (inspection?.ruleConfirmed === false && inspection.status !== "ok") {
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        message = t(
          "Current encoding ({0}) and configured rule ({1}) differ from saved bytes. Detected: {2}",
          actual,
          expected,
          encodingInfo(inspection.detectedEncoding).label,
        );
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        const list = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
        message = t(
          "Current encoding ({0}) and configured rule ({1}) differ from saved bytes. Candidates: {2}",
          actual,
          expected,
          list,
        );
      } else {
        message = t(
          "Saved bytes could not be decoded without loss using either the current encoding ({0}) or the configured rule ({1}).",
          actual,
          expected,
        );
      }
    } else {
      message = t("Encoding differs from configured rule. Current: {0} / Expected: {1}", actual, expected);
    }
  } else {
    const inspection = currentFileInspection(document);
    if (!inspection || inspection.status === "ok") return undefined;
    if (match) {
      const expected = encodingInfo(match.rule.encoding).label;
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        message = t(
          "Saved bytes differ from configured rule ({0}). Detected: {1}",
          expected,
          encodingInfo(inspection.detectedEncoding).label,
        );
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        const list = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
        message = t(
          "Saved bytes differ from configured rule ({0}). Candidates: {1}",
          expected,
          list,
        );
      } else {
        message = t("Saved bytes could not be decoded without loss using the configured rule ({0}).", expected);
      }
    } else if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
      message = t(
        "Current encoding ({0}) differs from saved bytes. Detected: {1}",
        actual,
        encodingInfo(inspection.detectedEncoding).label,
      );
    } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
      const list = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
      message = t(
        "Current encoding ({0}) differs from saved bytes. Candidates: {1}",
        actual,
        list,
      );
    } else {
      message = t("Saved bytes could not be decoded without loss using the current encoding ({0}).", actual);
    }
  }
  if (typeof vscode.Diagnostic !== "function" || !vscode.DiagnosticSeverity || typeof document.lineAt !== "function") {
    return undefined;
  }
  const range = document.lineAt(0).range;
  const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
  diagnostic.source = "Auto Encoding";
  diagnostic.code = "encoding-mismatch";
  return diagnostic;
}

const REOPEN_NOTE = t("Reopen changes display only (does not modify files). To change the saved format, use Convert from the context menu.");
const FILE_INSPECT_NOTE = t("Reopen changes display only (does not modify files). To change the saved format, choose Convert and Save.");
export const UNCONFIRMED_RULE_MESSAGE = t("Saved bytes could not be confirmed against the configured encoding rule; keeping the current encoding.");
const DIRTY_MESSAGE = t("Cannot reopen while there are unsaved changes. Save or back up your changes before changing the encoding.");

type InspectAction = "candidate" | "expected" | "choose" | "convertRule" | "convertFile" | "registerFile" | "registerFolder" | "original" | "modified" | "openWorkingFile";
interface InspectChoice extends vscode.QuickPickItem { readonly action: InspectAction; readonly encoding?: string }

function uniqueCandidates(resolutions: readonly SideResolution[]): string[] {
  return [...new Set(resolutions.flatMap((res) => !res.encoding && res.candidates ? res.candidates : []))];
}

function candidateTargetsFor(
  comparison: ComparisonInput,
  resolutions: readonly SideResolution[],
  candidate: string,
): vscode.Uri[] {
  const pairs: [vscode.Uri, SideResolution | undefined][] = [
    [comparison.original, resolutions[0]],
    [comparison.modified, resolutions[1]],
  ];
  const direct = pairs
    .filter(([uri, res]) => isReopenableScheme(uri.scheme) && !res?.encoding && res?.candidates?.includes(candidate) === true)
    .map(([uri]) => uri);
  if (direct.length === 0) return [];
  for (const [uri, res] of pairs) {
    if (isReopenableScheme(uri.scheme) && !res?.encoding && res?.ascii && compatibleWithAscii(candidate, res.empty === true) &&
      !direct.some((entry) => entry.toString() === uri.toString())) {
      direct.push(uri);
    }
  }
  return direct;
}

function expectedActionLabel(resolutions: readonly SideResolution[], match: RuleMatch | undefined): string {
  const encodings = [...new Set(resolutions.flatMap((res) => res.encoding ? [res.encoding] : []))];
  if (resolutions.some((res) => res.keepCurrentEncoding) && encodings.length === 1) {
    return t("$(check) Reopen detected side as {0}", encodingInfo(encodings[0]!).label);
  }
  if (encodings.length === 2) {
    return t(
      "$(check) Reopen with detected encodings (Left: {0} / Right: {1})",
      encodingInfo(encodings[0]!).label,
      encodingInfo(encodings[1]!).label,
    );
  }
  const single = encodings[0] ?? match?.rule.encoding ?? "utf8";
  const label = encodingInfo(single).label;
  if (match && !resolutions.some((res) => res.actualMismatch)) {
    return t("$(check) Reopen with expected encoding ({0})", label);
  }
  if (resolutions.some((res) => res.basis === "openFile")) {
    return t("$(check) Reopen with working file encoding ({0})", label);
  }
  return t("$(check) Reopen with auto-detected encoding ({0})", label);
}

function describeBasisTitle(
  resolutions: readonly SideResolution[],
  match: RuleMatch | undefined,
  mismatched: boolean,
  candidates: readonly string[],
  decodeLoss = false,
): string {
  if (candidates.length > 0) {
    const list = candidates.map((id) => encodingInfo(id).label).join(" / ");
    return match
      ? t("Rule: {0} (mismatch · candidates: {1})", encodingInfo(match.rule.encoding).label, list)
      : t("Candidates: {0} (no rule)", list);
  }
  if (decodeLoss) {
    return match
      ? t("Rule: {0} (mismatch · decode loss)", encodingInfo(match.rule.encoding).label)
      : t("Could not decode without loss in current encoding (no rule)");
  }
  if (match) {
    return mismatched
      ? t("Rule: {0} (mismatch)", encodingInfo(match.rule.encoding).label)
      : t("Rule: {0} (matched)", encodingInfo(match.rule.encoding).label);
  }
  if (resolutions.some((res) => res.basis === "openFile")) {
    return t("Inherited from working file (no rule)");
  }
  if (resolutions.some((res) => res.basis === "detected" && res.encoding && (res.encoding !== "utf8" || mismatched))) {
    return t("Auto-detected (no rule)");
  }
  return t("Encoding rule: none");
}

async function decodeAndRankSideCandidates(
  uri: vscode.Uri,
  sideCandidates: readonly string[],
  previewPrefix?: string,
): Promise<readonly RankedEncodingCandidate[] | undefined> {
  if (sideCandidates.length === 0) return undefined;
  const read = await readResourceBytes(uri, maxResourceBytes(uri));
  if (!read) return undefined;
  const decoded: Array<{ readonly encoding: string; readonly text: string }> = [];
  for (const candidate of sideCandidates) {
    const normalized = candidate.toLowerCase();
    const bomLength = normalized === "utf8bom" &&
      read.bytes[0] === 0xef && read.bytes[1] === 0xbb && read.bytes[2] === 0xbf ? 3 : 0;
    const decodeEncoding = normalized === "utf8bom" ? "utf8" : normalized;
    try {
      const text = await vscode.workspace.decode(read.bytes.subarray(bomLength), { encoding: decodeEncoding });
      decoded.push({ encoding: candidate, text });
    } catch {
      // Skip unreadable candidates from previews while keeping them in original order.
    }
  }
  if (decoded.length === 0) return undefined;
  if (read.stillCurrent && !(await read.stillCurrent())) return undefined;
  return rankDecodedCandidates(decoded, { previewPrefix });
}

async function buildCandidatePreviews(
  document: vscode.TextDocument,
  comparison: ActiveComparison | undefined,
  resolutions: readonly SideResolution[],
  candidates: readonly string[],
): Promise<{ readonly ordered: readonly string[]; readonly byEncoding: ReadonlyMap<string, RankedEncodingCandidate> } | undefined> {
  if (candidates.length === 0 || typeof vscode.workspace.decode !== "function") {
    return undefined;
  }
  let primary: readonly RankedEncodingCandidate[] | undefined;
  let secondary: readonly RankedEncodingCandidate[] | undefined;

  if (comparison) {
    const rightCandidates = !resolutions[1]?.encoding ? (resolutions[1]?.candidates ?? []) : [];
    const leftCandidates = !resolutions[0]?.encoding ? (resolutions[0]?.candidates ?? []) : [];
    const rightRanked = rightCandidates.length > 0
      ? await decodeAndRankSideCandidates(comparison.modified, rightCandidates, t("Right"))
      : undefined;
    const rightHasNonAscii = rightRanked?.some((entry) => entry.nonAsciiCount > 0) ?? false;
    const rightSet = new Set(rightRanked?.map((entry) => entry.encoding) ?? []);
    const needsLeft = leftCandidates.length > 0 && (
      !rightHasNonAscii || leftCandidates.some((candidate) => !rightSet.has(candidate))
    );
    const leftRanked = needsLeft
      ? await decodeAndRankSideCandidates(comparison.original, leftCandidates, t("Left"))
      : undefined;
    const leftHasNonAscii = leftRanked?.some((entry) => entry.nonAsciiCount > 0) ?? false;

    if (rightHasNonAscii) {
      primary = rightRanked;
      secondary = leftRanked;
    } else if (leftHasNonAscii) {
      primary = leftRanked;
      secondary = rightRanked;
    } else {
      primary = rightRanked ?? leftRanked;
      secondary = rightRanked ? leftRanked : undefined;
    }
  } else {
    primary = await decodeAndRankSideCandidates(document.uri, candidates);
  }

  if (!primary && !secondary) return undefined;

  const byEncoding = new Map<string, RankedEncodingCandidate>();
  const ordered: string[] = [];
  for (const entry of primary ?? []) {
    if (byEncoding.has(entry.encoding)) continue;
    byEncoding.set(entry.encoding, entry);
    ordered.push(entry.encoding);
  }
  for (const entry of secondary ?? []) {
    if (byEncoding.has(entry.encoding)) continue;
    byEncoding.set(entry.encoding, primary ? { ...entry, likely: false } : entry);
    ordered.push(entry.encoding);
  }
  for (const candidate of candidates) {
    if (!byEncoding.has(candidate)) {
      ordered.push(candidate);
    }
  }
  return { ordered, byEncoding };
}

export async function inspectActiveFile(): Promise<void> {
  const comparison = activeComparison();
  const document = vscode.window.activeTextEditor?.document ?? activeComparisonDocument();
  if (!document) {
    void vscode.window.showInformationMessage(t("Open a file to inspect its encoding."));
    return;
  }
  const details = await describeDocumentLineEndings(document);
  const resolutions = comparison
    ? await resolveComparisonSides(comparison)
    : [await resolveSingleSide(document.uri)];
  const fileInspection = !comparison && document.uri.scheme === "file" ? await inspectFileDocument(document) : undefined;
  const decodeLoss = !comparison && fileInspection?.status === "decodeLoss";
  const match = resolveRule(document.uri)
    ?? (comparison ? resolveRule(comparison.modified) ?? resolveRule(comparison.original) : undefined);
  const name = path.basename(document.fileName || document.uri.fsPath || document.uri.path);
  const mismatched = comparison
    ? ([comparison.original, comparison.modified] as const).some((uri, idx) => {
      if (!isReopenableScheme(uri.scheme)) return false;
      const expected = resolutions[idx]?.encoding;
      const doc = findDocument(uri);
      return !!expected && !!doc && !sameEncoding(doc.encoding, expected);
    })
    : (() => {
      const resolution = resolutions[0];
      const expected = resolution?.keepCurrentEncoding ? undefined : (resolution?.encoding ?? match?.rule.encoding);
      return !!expected && !sameEncoding(document.encoding, expected);
    })();
  const candidates = uniqueCandidates(resolutions);
  const rankedCandidates = await buildCandidatePreviews(document, comparison, resolutions, candidates);
  const orderedCandidates = rankedCandidates?.ordered ?? candidates;
  const ruleMismatch = match
    ? comparison
      ? [comparison.original, comparison.modified].some((uri) => {
        const sideRule = resolveRule(uri);
        const doc = findDocument(uri);
        return !!sideRule && !!doc && !sameEncoding(doc.encoding, sideRule.rule.encoding);
      })
      : !isDocumentEncodingMatch(document, match)
    : false;
  const ruleText = describeBasisTitle(resolutions, match, mismatched || ruleMismatch, orderedCandidates, decodeLoss);
  const ruleSource = match ? ` | ${t("Source: {0} / {1}", match.folder.name, match.rule.pattern)}` : "";
  const state = comparison
    ? comparisonLabel(comparison)
    : document.uri.scheme === "git"
      ? t("Git: {0}", encodingInfo(document.encoding).label)
      : t("Current: {0}", encodingInfo(document.encoding).label);

  const choices: InspectChoice[] = [];
  for (const candidate of orderedCandidates) {
    const targets = comparison ? candidateTargetsFor(comparison, resolutions, candidate) : [document.uri];
    const targetDesc = comparison
      ? targets.length === 1
        ? t(
            "{0} only · keep diff view (no save)",
            targets[0]!.toString() === comparison.original.toString()
              ? sideName(comparison, "original")
              : sideName(comparison, "modified"),
          )
        : t("Both sides · keep diff view (no save)")
      : t("Display only (no save)");
    const ranked = rankedCandidates?.byEncoding.get(candidate);
    choices.push({
      action: "candidate",
      encoding: candidate,
      label: t("$(sparkle) Candidate: Reopen as {0}", encodingInfo(candidate).label),
      description: ranked?.likely ? `${t("Likely")} · ${targetDesc}` : targetDesc,
      ...(ranked?.preview ? { detail: ranked.preview } : {}),
    });
  }
  if (mismatched) {
    choices.push({
      action: "expected",
      label: expectedActionLabel(resolutions, match),
      description: comparison
        ? resolutions.some((res) => res.keepCurrentEncoding)
          ? t("Keep diff view (no save)")
          : t("Both sides · keep diff view")
        : t("Display only"),
    });
  }
  const hasVirtualComparisonSide = Boolean(
    comparison && (!isReopenableScheme(comparison.original.scheme) || !isReopenableScheme(comparison.modified.scheme)),
  );
  choices.push({
    action: "choose",
    label: t("$(symbol-text) Reopen with Another Encoding (no save)"),
    description: comparison
      ? hasVirtualComparisonSide ? t("Working / Git side only · keep diff view") : t("Both sides · keep diff view")
      : t("Display only"),
  });
  const fileUri = fileUriForResource(document.uri);
  const inWorkspaceFile = fileUri.scheme === "file" && Boolean(vscode.workspace.getWorkspaceFolder(fileUri));
  if (inWorkspaceFile) {
    if (!comparison && document.uri.scheme === "file") {
      if (match && (fileInspection?.ruleConfirmed === false || (!isDocumentEncodingMatch(document, match) && fileInspection?.ruleConfirmed !== true))) {
        const expectedLabel = encodingInfo(match.rule.encoding).label;
        choices.push({
          action: "convertRule",
          encoding: match.rule.encoding,
          label: t("$(replace) Convert and Save to Configured Encoding ({0})...", expectedLabel),
          description: t("Rewrites the file with confirmation and local backup"),
        });
      }
      choices.push({
        action: "convertFile",
        label: t("$(replace) Convert and Save Encoding / Line Endings..."),
        description: t("Rewrites the file with confirmation and local backup"),
      });
    }
    choices.push(
      { action: "registerFile", label: t("$(pin) Set Encoding Rule for This File"), description: t("Also preserved in Git comparisons") },
      { action: "registerFolder", label: t("$(folder) Set Encoding Rule for This Folder"), description: t("Applies to files under this folder and Git comparisons") },
    );
  }
  if (comparison) {
    const reopenableOriginal = isReopenableScheme(comparison.original.scheme);
    const reopenableModified = isReopenableScheme(comparison.modified.scheme);
    if (reopenableOriginal) {
      choices.push({ action: "original", label: t("$(arrow-left) Reopen {0} with Another Encoding", sideName(comparison, "original")), description: t("For inspecting intentional encoding conversion commits") });
    }
    if (reopenableModified) {
      choices.push({ action: "modified", label: t("$(arrow-right) Reopen {0} with Another Encoding", sideName(comparison, "modified")), description: t("For inspecting intentional encoding conversion commits") });
    }
    const workingFileUri = comparison.modified.scheme === "file"
      ? comparison.modified
      : comparison.original.scheme === "file"
        ? comparison.original
        : undefined;
    if (workingFileUri && (comparison.multiDiff || !reopenableOriginal || !reopenableModified)) {
      choices.push({
        action: "openWorkingFile",
        label: t("$(go-to-file) Open Working File in Standard Editor"),
        description: t("Open as a standalone editor when multi-file diff or virtual snapshot is hard to read"),
      });
    }
  }
  const selected = await vscode.window.showQuickPick<InspectChoice>(choices, {
    title: `${name}: ${state} | ${details} | ${ruleText}${ruleSource}`,
    placeHolder: !comparison && document.uri.scheme === "file" && inWorkspaceFile ? FILE_INSPECT_NOTE : REOPEN_NOTE,
  });
  if (!selected) return;

  if (selected.action === "openWorkingFile") {
    const workingFileUri = comparison?.modified.scheme === "file"
      ? comparison.modified
      : comparison?.original.scheme === "file"
        ? comparison.original
        : undefined;
    if (workingFileUri && typeof vscode.window.showTextDocument === "function") {
      const targetDoc = findDocument(workingFileUri) ?? await vscode.workspace.openTextDocument(workingFileUri);
      await vscode.window.showTextDocument(targetDoc, { preview: false, preserveFocus: false });
    }
    return;
  }

  if (selected.action === "convertRule" || selected.action === "convertFile") {
    await vscode.commands.executeCommand("autoEncoding.convertFile", fileUri, selected.encoding);
    const active = findDocument(fileUri);
    if (active && !active.isClosed) {
      clearEncodingDetectionCache(fileUri);
      clearFileEncodingInspection(fileUri);
      await inspectFileDocument(active);
    }
    return;
  }

  if (selected.action === "candidate") {
    if (selected.encoding) {
      if (comparison) {
        const targets = candidateTargetsFor(comparison, resolutions, selected.encoding);
        if (targets.length > 0) {
          await reopenComparisonManually(
            comparison,
            targets.map((uri) => ({ uri, encoding: selected.encoding! })),
            true,
            false,
          );
        }
      } else {
        const matchesRule = Boolean(match && sameEncoding(selected.encoding, match.rule.encoding));
        await reopenWithEncoding(document, selected.encoding, !matchesRule, matchesRule ? "rule" : undefined);
      }
    }
    return;
  }
  if (selected.action === "expected") {
    if (comparison) {
      await reopenComparisonToExpectation(comparison, match?.rule.encoding);
    } else {
      const target = resolutions[0]?.encoding;
      if (target) {
        const manualOverride = Boolean(match && target.toLowerCase() !== match.rule.encoding.toLowerCase());
        await reopenWithEncoding(document, target, manualOverride, manualOverride ? undefined : resolutions[0]?.basis);
      }
    }
    return;
  }
  if (selected.action === "registerFile" || selected.action === "registerFolder") {
    const registerTarget = selected.action === "registerFile"
      ? (document.uri.scheme === "git" ? document.uri : fileUri)
      : vscode.Uri.file(path.dirname(fileUri.fsPath));
    const saved = await vscode.commands.executeCommand(
      selected.action === "registerFile" ? "autoEncoding.configureFile" : "autoEncoding.configureFolder",
      registerTarget,
    );
    // A cancelled picker leaves any existing rule untouched; never reopen on its account.
    if (saved !== true) return;
    clearWorkspaceRuleCache();
    clearEncodingDetectionCache();
    clearCleanFileEncodingInspections();
    clearAutoReopenFailure();
    const created = resolveRule(document.uri)
      ?? (comparison ? resolveRule(comparison.modified) ?? resolveRule(comparison.original) : undefined);
    if (created) {
      manualSides.delete(document.uri.toString());
      await reopenWithExpectedEncoding(document, created);
    }
    return;
  }
  const currentEncoding = document.encoding;
  const picked = await vscode.window.showQuickPick(
    ENCODINGS.map((encoding) => ({
      label: encoding.label,
      description: sameEncoding(encoding.id, currentEncoding)
        ? t("{0} · Current encoding", encoding.id)
        : encoding.id,
      encoding: encoding.id,
    })),
    {
      title:
        selected.action === "choose"
          ? t("Select Encoding to Reopen (no save)")
          : t("Select Encoding to Reopen {0} (no save)", sideName(comparison!, selected.action)),
      placeHolder: REOPEN_NOTE,
    },
  );
  if (!picked) return;
  if (selected.action === "original" || selected.action === "modified") {
    await reopenComparisonManually(comparison!, [{ uri: comparison![selected.action], encoding: picked.encoding }], true);
  } else {
    await reopenWithEncoding(document, picked.encoding, true);
  }
}

async function describeDocumentLineEndings(document: vscode.TextDocument): Promise<string> {
  let endings;
  let source: string;
  if (document.isDirty) {
    endings = classifyTextLineEndings(document.getText());
    source = t("unsaved buffer");
  } else if (document.uri.scheme === "git") {
    const gitRead = typeof classifyLineEndings === "function"
      ? await readResourceBytes(document.uri, maxResourceBytes(document.uri))
      : undefined;
    if (gitRead) {
      endings = classifyLineEndings(gitRead.bytes, document.encoding);
      source = t("Git");
    } else {
      endings = classifyTextLineEndings(document.getText());
      source = t("current document");
    }
  } else if (document.uri.scheme !== "file") {
    endings = classifyTextLineEndings(document.getText());
    source = t("current document");
  } else {
    const version = document.version;
    const encoding = document.encoding;
    const changed = (): boolean => document.isDirty || document.version !== version || document.encoding !== encoding;
    const maxSize = maxResourceBytes(document.uri);
    try {
      const read = await readStableResource(document.uri, maxSize, changed);
      if (!read || !(await resourceStillMatchesRead(document.uri, maxSize, read, changed))) {
        return t("EOL: Unchecked (file may be changing, unreadable, or over size limit)");
      }
      endings = classifyLineEndings(read.bytes, encoding);
      source = t("saved file");
    } catch {
      return t("EOL: Unchecked (could not read file safely)");
    }
  }
  const label = endings.kind === "none" ? t("No EOL")
    : endings.kind === "mixed" ? t("Mixed EOL: {0}", endings.styles.join(" / ").toUpperCase())
      : t("EOL: {0}", endings.kind.toUpperCase());
  return `${label} (${source})`;
}

export async function reopenWithExpectedEncoding(
  document: vscode.TextDocument,
  match: RuleMatch,
): Promise<void> {
  if (document.isClosed) return;
  const comparison = activeComparison();
  if (comparison && involves(comparison, document)) {
    await reopenComparisonToExpectation(comparison, match.rule.encoding);
    return;
  }
  if (document.uri.scheme === "file" && !document.isDirty && !(await canReopenWithRule(document, match))) {
    void vscode.window.showWarningMessage(UNCONFIRMED_RULE_MESSAGE);
    return;
  }
  manualSides.delete(document.uri.toString());
  await reopenWithEncoding(document, match.rule.encoding, false, "rule");
}

function involves(comparison: ComparisonInput, document: vscode.TextDocument): boolean {
  return [comparison.original, comparison.modified].some((uri) => uri.toString() === document.uri.toString());
}

const openingDocuments = new Set<string>();
const openingPromises = new Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>();

function beginOpeningDocument(key: string): boolean {
  if (openingDocuments.has(key)) return false;
  openingDocuments.add(key);
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  openingPromises.set(key, { promise, resolve });
  return true;
}

function endOpeningDocument(key: string): void {
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

// Sides the user deliberately reopened on their own (e.g. to inspect a conversion commit).
const manualSides = new Set<string>();
export function isManualEncodingOverride(uri: vscode.Uri): boolean {
  return manualSides.has(uri.toString());
}
export function forgetManualEncoding(uri: vscode.Uri): void {
  const key = uri.toString();
  manualSides.delete(key);
  autoDetectedUris.delete(key);
  clearAutoReopenFailure(uri);
  clearEncodingDetectionCache(uri);
  clearFileEncodingInspection(uri);
}

async function reopenComparisonToExpectation(comparison: ActiveComparison, fallback?: string): Promise<void> {
  const [left, right] = await resolveComparisonSides(comparison);
  const pairs: [vscode.Uri, SideResolution][] = [[comparison.original, left], [comparison.modified, right]];
  const items = pairs.flatMap(([uri, res]) => {
    if (!isReopenableScheme(uri.scheme)) return [];
    if (res.keepCurrentEncoding && !findDocument(uri)?.isDirty) return [];
    const encoding = res.encoding ?? (uri.scheme === "git" || uri.toString() === comparison.modified.toString() ? fallback : undefined);
    return encoding ? [{ uri, encoding, basis: res.basis }] : [];
  });
  await reopenComparisonManually(comparison, items, false);
}

async function reopenComparisonManually(
  comparison: ActiveComparison,
  items: { uri: vscode.Uri; encoding: string; basis?: EncodingBasis }[],
  manual: boolean,
  markAllSidesManual = manual,
): Promise<void> {
  // A deliberate reopen pauses automatic alignment for both sides (or only targeted unresolved sides for candidate picks).
  const trackedUris = markAllSidesManual
    ? [comparison.original, comparison.modified, ...items.map((item) => item.uri)]
    : manual
      ? items.map((item) => item.uri)
      : [comparison.original, comparison.modified, ...items.map((item) => item.uri)];
  for (const uri of trackedUris) {
    const key = uri.toString();
    if (manual) {
      manualSides.add(key);
      autoDetectedUris.delete(key);
    } else {
      manualSides.delete(key);
    }
  }
  try {
    const result = await reopenComparisonSides(comparison, items);
    if (result.blocked) void vscode.window.showErrorMessage(DIRTY_MESSAGE);
  } catch {
    void vscode.window.showErrorMessage(
      t("Failed to reopen with the expected encoding. Please check the file contents and read permissions, then try again."),
    );
  }
}

/** Reopens only the display encoding of comparison sides; unsaved sides are never touched and nothing is written. */
async function reopenComparisonSides(
  comparison: ActiveComparison,
  items: readonly { uri: vscode.Uri; encoding: string; basis?: EncodingBasis }[],
): Promise<{ changed: boolean; blocked: boolean }> {
  let changed = false;
  let blocked = false;
  for (const { uri, encoding, basis } of items) {
    if (!isReopenableScheme(uri.scheme)) continue;
    const document = findDocument(uri);
    if (document?.isDirty) { blocked = true; continue; }
    const key = uri.toString();
    if (!beginOpeningDocument(key)) continue;
    try {
      const previous = document?.encoding;
      const reopened = await vscode.workspace.openTextDocument(uri, { encoding });
      if (uri.scheme === "file") {
        clearFileEncodingInspection(uri);
      }
      if (!sameEncoding(previous, reopened.encoding)) {
        changed = true;
        if (basis === "detected" && sameEncoding(reopened.encoding, encoding)) setBounded(autoDetectedUris, key, reopened.encoding);
        else autoDetectedUris.delete(key);
      }
      if (uri.scheme === "file" && !reopened.isClosed && !reopened.isDirty) {
        await inspectFileDocument(reopened);
      }
    } finally { endOpeningDocument(key); }
  }
  const current = activeComparison();
  if (changed && !comparison.multiDiff && current && !current.multiDiff &&
    current.original.toString() === comparison.original.toString() &&
    current.modified.toString() === comparison.modified.toString()) {
    await vscode.commands.executeCommand("vscode.diff", comparison.original, comparison.modified,
      current.label ?? comparison.label ?? `${path.basename(comparison.modified.fsPath)} — ${comparisonLabel(comparison)}`, { preview: current.preview });
  }
  return { changed, blocked };
}

async function reopenSingleGit(single: ActiveSingleGit, encoding: string, basis?: EncodingBasis): Promise<boolean> {
  const document = findDocument(single.uri);
  if (document?.isDirty) return false;
  const key = single.uri.toString();
  if (!beginOpeningDocument(key)) return false;
  try {
    const previous = document?.encoding;
    const reopened = await vscode.workspace.openTextDocument(single.uri, { encoding });
    if (sameEncoding(previous, reopened.encoding)) return false;
    if (basis === "detected" && sameEncoding(reopened.encoding, encoding)) setBounded(autoDetectedUris, key, reopened.encoding);
    else autoDetectedUris.delete(key);
    const current = activeSingleGit();
    if (current && current.uri.toString() === key && typeof vscode.window.showTextDocument === "function") {
      await vscode.window.showTextDocument(reopened, { preview: current.preview, preserveFocus: true });
    }
    return true;
  } finally { endOpeningDocument(key); }
}

export async function autoReopenWithDetectedEncoding(
  document: vscode.TextDocument,
  encoding: string,
): Promise<vscode.TextDocument | undefined> {
  if (document.isDirty || document.isClosed || document.uri.scheme !== "file") return undefined;
  const targetEncoding = encoding.toLowerCase();
  const previousEncoding = document.encoding;
  const normalizedPrevious = previousEncoding.toLowerCase();
  if (normalizedPrevious === targetEncoding) return undefined;
  const key = document.uri.toString();
  if (openingDocuments.has(key) || manualSides.has(key) || hasAutoReopenFailed(document.uri, targetEncoding)) {
    return undefined;
  }
  if (!beginOpeningDocument(key)) return undefined;
  try {
    if (!(await canReopenWithDetectedEncoding(document, encoding))) return undefined;
    const reopened = await vscode.workspace.openTextDocument(document.uri, { encoding });
    if (reopened.isClosed) return undefined;
    const reopenedEncoding = reopened.encoding.toLowerCase();
    if (reopenedEncoding !== targetEncoding || reopenedEncoding === normalizedPrevious) {
      markAutoReopenFailed(document.uri, targetEncoding);
      if (reopenedEncoding !== normalizedPrevious) {
        clearFileEncodingInspection(document.uri);
        await inspectFileDocument(reopened);
      }
      return undefined;
    }
    manualSides.delete(key);
    clearAutoReopenFailure(document.uri);
    setBounded(autoDetectedUris, key, reopened.encoding);
    clearFileEncodingInspection(document.uri);
    await inspectFileDocument(reopened);
    return reopened;
  } catch (error) {
    markAutoReopenFailed(document.uri, targetEncoding);
    throw error;
  } finally {
    endOpeningDocument(key);
  }
}

export async function reopenDocumentWithDetectedEncoding(
  document: vscode.TextDocument,
  encoding: string,
  manual = false,
): Promise<vscode.TextDocument | undefined> {
  return reopenWithEncoding(document, encoding, manual, manual ? undefined : "detected");
}

async function reopenWithEncoding(
  document: vscode.TextDocument,
  encoding: string,
  manual = false,
  basis?: EncodingBasis,
): Promise<vscode.TextDocument | undefined> {
  const comparison = activeComparison();
  if (comparison && involves(comparison, document)) {
    const targets = [comparison.original, comparison.modified]
      .filter((uri) => isReopenableScheme(uri.scheme))
      .map((uri) => ({ uri, encoding, basis }));
    await reopenComparisonManually(comparison, targets, manual);
    return findDocument(document.uri);
  }
  if (document.isClosed) return undefined;
  if (document.isDirty) {
    void vscode.window.showErrorMessage(DIRTY_MESSAGE);
    return undefined;
  }
  const key = document.uri.toString();
  if (!beginOpeningDocument(key)) return undefined;
  const hadManual = manualSides.has(key);
  const previousAutoDetected = autoDetectedUris.get(key);
  if (manual) {
    manualSides.add(key);
    autoDetectedUris.delete(key);
  }
  try {
    const reopened = await vscode.workspace.openTextDocument(document.uri, {
      encoding,
    });
    if (!manual) {
      manualSides.delete(key);
      if (basis === "detected" && sameEncoding(reopened.encoding, encoding)) setBounded(autoDetectedUris, key, reopened.encoding);
      else autoDetectedUris.delete(key);
    }
    clearAutoReopenFailure(document.uri);
    clearFileEncodingInspection(document.uri);
    await vscode.window.showTextDocument(reopened, { preview: false, preserveFocus: false });
    if (reopened.uri.scheme === "file" && !reopened.isClosed) {
      await inspectFileDocument(reopened);
    }
    return reopened;
  } catch {
    if (manual) {
      if (!hadManual) manualSides.delete(key);
      if (previousAutoDetected !== undefined) setBounded(autoDetectedUris, key, previousAutoDetected);
    }
    void vscode.window.showErrorMessage(
      t("Failed to reopen with the expected encoding. Please check the file contents and read permissions, then try again."),
    );
    return undefined;
  } finally { endOpeningDocument(key); }
}

export function updateStatus(status: vscode.StatusBarItem, document: vscode.TextDocument): void {
  status.command = "autoEncoding.inspectActiveFile";
  const comparison = activeComparison();
  if (comparison) {
    const [leftUri, rightUri] = [comparison.original, comparison.modified];
    const sides = [
      { uri: leftUri, doc: findDocument(leftUri), res: currentSideResolution(leftUri, rightUri), directMatch: resolveRule(leftUri) },
      { uri: rightUri, doc: findDocument(rightUri), res: currentSideResolution(rightUri, leftUri), directMatch: resolveRule(rightUri) },
    ] as const;
    const candidates = uniqueCandidates(sides.map((side) => side.res));
    const hasVirtualSide = sides.some((side) => !isReopenableScheme(side.uri.scheme));
    const targetMismatch = sides.some((side) => isReopenableScheme(side.uri.scheme) && side.res.encoding && side.doc && !sameEncoding(side.doc.encoding, side.res.encoding));
    const ruleMismatch = sides.some((side) => isReopenableScheme(side.uri.scheme) && side.directMatch && side.doc && !sameEncoding(side.doc.encoding, side.directMatch.rule.encoding));
    const sidesDiffer = !!sides[0].doc && !!sides[1].doc && !sameEncoding(sides[0].doc.encoding, sides[1].doc.encoding);
    const unconfirmedWorkingFile = sides.some((side) => side.res.keepCurrentEncoding && side.doc && !side.doc.isDirty);
    const warn = candidates.length > 0 || targetMismatch || ruleMismatch || sidesDiffer || unconfirmedWorkingFile;
    const ruleMatch = sides.find((side) => side.directMatch)?.directMatch ?? sides.find((side) => side.res.match)?.res.match;
    const suffix = !ruleMatch
      ? candidates.length > 0
        ? ` (${t("candidates")})`
        : !warn && sides.some((side) => side.res.basis === "openFile")
          ? ` (${t("from working file")})`
          : !warn && sides.some((side) => side.res.basis === "detected" && side.doc && side.doc.encoding.toLowerCase() !== "utf8")
            ? ` (${t("auto-detected")})`
            : ""
      : "";
    status.text = `${warn ? "$(warning)" : "$(pass)"} ${comparisonLabel(comparison)}${suffix}`;
    status.backgroundColor = warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const candidateLabels = candidates.map((id) => encodingInfo(id).label).join(" / ");
    const basisLine = ruleMatch
      ? t("Encoding rule: {0} ({1})", encodingInfo(ruleMatch.rule.encoding).label, ruleMatch.rule.pattern)
      : candidates.length > 0
        ? t("Encoding rule: none (candidates: {0})", candidateLabels)
        : sides.some((side) => side.res.basis === "openFile")
          ? t("Encoding rule: none (inherited from open working file)")
          : sides.some((side) => side.res.basis === "detected")
            ? t("Encoding rule: none (auto-detected from bytes)")
            : t("Encoding rule: none");
    const stateLine = candidates.length > 0
      ? t("Multiple encoding candidates match, so auto-reopen was skipped. Click to choose and reopen.")
      : ruleMatch && sides.some((side) => side.res.actualMismatch)
        ? t("One side differs from the configured rule; displaying the detected encoding to prevent mojibake.")
        : unconfirmedWorkingFile
          ? UNCONFIRMED_RULE_MESSAGE
          : ruleMismatch || targetMismatch
            ? t("One side differs from the expected encoding.")
            : sidesDiffer
              ? hasVirtualSide
                ? t("Virtual snapshot sides cannot change encoding due to VS Code limitations; only the working/Git side is aligned. Click to open the working file in a standard editor.")
                : t("Left and right sides use different encodings. Click to align unless inspecting an intentional conversion commit.")
              : t("Both sides match.");
    status.tooltip = [
      comparison.multiDiff
        ? t("Shows the encodings currently used to read the active file in the multi-file diff.")
        : t("Shows the encodings currently used to read both sides of the Git comparison."),
      basisLine,
      stateLine,
      t("Click to reopen, register an encoding rule, or open the working file in a standard editor. Reopening changes display only and never modifies files."),
    ].join("\n");
    status.show();
    return;
  }

  if (document.uri.scheme === "git") {
    const fileUri = fileUriForResource(document.uri);
    if (fileUri.scheme !== "file") {
      status.hide();
      return;
    }
    const res = currentSideResolution(document.uri);
    const match = resolveRule(document.uri);
    const actual = encodingInfo(document.encoding).label;
    const candidates = uniqueCandidates([res]);
    if (match) {
      const expected = encodingInfo(match.rule.encoding);
      const matches = isDocumentEncodingMatch(document, match);
      status.text = matches
        ? `$(pass) ${t("Git: {0}", expected.label)}`
        : `$(warning) ${t("Git: {0} → {1}", actual, expected.label)}`;
      status.backgroundColor = matches ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
      status.tooltip = [
        res.actualMismatch
          ? t("Saved bytes in the Git view differ from the configured rule ({0}); displaying as {1} to prevent mojibake.", expected.label, actual)
          : matches
            ? t("Git view matches encoding rule: {0}", match.rule.pattern)
            : t("Git view encoding differs from rule. Click to inspect: {0}", match.rule.pattern),
        t("Click to reopen with another encoding (no save) or manage encoding rules."),
      ].join("\n");
      status.show();
      return;
    }
    if (candidates.length > 0) {
      const candidateLabels = candidates.map((id) => encodingInfo(id).label).join(" / ");
      status.text = `$(warning) ${t("Git: {0} (candidates)", actual)}`;
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      status.tooltip = [
        t("Multiple encoding candidates ({0}) match, so auto-reopen was skipped.", candidateLabels),
        t("Click to reopen from candidates (no save) or set a file/folder encoding rule."),
      ].join("\n");
      status.show();
      return;
    }
    const isInherited = res.basis === "openFile";
    const isDetected = res.basis === "detected" && (document.encoding.toLowerCase() !== "utf8" || autoDetectedUris.has(document.uri.toString()));
    const basisSuffix = isInherited
      ? ` (${t("from working file")})`
      : isDetected
        ? ` (${t("auto-detected · no rule")})`
        : ` (${t("no rule")})`;
    const icon = !isInherited && !isDetected ? "$(symbol-text)" : "$(pass)";
    status.text = `${icon} ${t("Git: {0}", actual)}${basisSuffix}`;
    status.backgroundColor = undefined;
    status.tooltip = [
      res.basis === "openFile"
        ? t("Displaying Git view using the open working file's encoding (no rule).")
        : res.basis === "detected"
          ? t("Displaying Git view using the encoding auto-detected from bytes (no rule).")
          : t("No encoding rule is configured for this Git file."),
      t("Click to reopen with another encoding (no save) or set a file/folder encoding rule."),
    ].join("\n");
    status.show();
    return;
  }

  const match = resolveRule(document.uri);
  const inspection = currentFileInspection(document);
  if (!match) {
    const fileUri = fileUriForResource(document.uri);
    if (fileUri.scheme !== "file") {
      status.hide();
      return;
    }
    const actual = encodingInfo(document.encoding).label;
    if (inspection && inspection.status !== "ok") {
      if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
        const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
        status.text = `$(warning) ${t("Open: {0} / Detected: {1} (no rule)", actual, detectedLabel)}`;
        status.tooltip = [
          t("Current encoding ({0}) may differ from saved bytes ({1}).", actual, detectedLabel),
          t("Click to reopen with the detected encoding (no save) or register a file/folder encoding rule."),
        ].join("\n");
      } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
        const candidateLabels = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
        status.text = `$(warning) ${t("Open: {0} (candidates · no rule)", actual)}`;
        status.tooltip = [
          t("Current encoding ({0}) does not match saved bytes; multiple candidates ({1}) are possible.", actual, candidateLabels),
          t("Click to reopen from candidates (no save) or register an encoding rule."),
        ].join("\n");
      } else {
        status.text = `$(warning) ${t("Open: {0} (decode loss · no rule)", actual)}`;
        status.tooltip = [
          t("Saved bytes could not be decoded without loss using the current encoding ({0}).", actual),
          t("Click to reopen with another encoding (no save) or register a file/folder encoding rule."),
        ].join("\n");
      }
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      status.show();
      return;
    }
    if (
      inspection?.status === "ok" &&
      inspection.basis === "detected" &&
      (document.encoding.toLowerCase() !== "utf8" || autoDetectedUris.has(document.uri.toString()))
    ) {
      status.text = `$(pass) ${t("{0} (auto-detected · no rule)", actual)}`;
      status.backgroundColor = undefined;
      status.tooltip = [
        t("Displaying using the encoding auto-detected from bytes (no rule)."),
        t("Click to reopen with another encoding (no save), register a file/folder encoding rule, or inspect line endings."),
        t("Registered rules are also preserved in VS Code Git comparisons."),
      ].join("\n");
      status.show();
      return;
    }
    status.text = `$(symbol-text) ${t("{0} (no rule)", actual)}`;
    status.backgroundColor = undefined;
    status.tooltip = [
      t("No encoding rule is configured for this file."),
      t("Click to reopen with another encoding (no save), register a file/folder encoding rule, or inspect line endings."),
      t("Registered rules are also preserved in VS Code Git comparisons."),
    ].join("\n");
    status.show();
    return;
  }
  const actual = encodingInfo(document.encoding).label;
  const expected = encodingInfo(match.rule.encoding).label;
  const matches = isDocumentEncodingMatch(document, match);
  if (!matches && inspection?.ruleConfirmed === false && inspection.status !== "ok") {
    if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
      const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
      status.text = `$(warning) ${t("Open: {0} / Rule: {1} (Actual: {2})", actual, expected, detectedLabel)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t("Saved bytes appear to be {0}. Click to reopen (no save) or inspect the rule.", detectedLabel),
      ].join("\n");
    } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
      const candidateLabels = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
      status.text = `$(warning) ${t("Open: {0} / Rule: {1} (candidates)", actual, expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t("Saved bytes match neither the current encoding nor the rule; candidates: {0}. Click to inspect and reopen.", candidateLabels),
      ].join("\n");
    } else {
      status.text = `$(warning) ${t("Open: {0} / Rule: {1} (decode loss)", actual, expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t("Saved bytes could not be decoded without loss in either the current encoding or the rule. Click to reopen or inspect."),
      ].join("\n");
    }
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    status.show();
    return;
  }
  if (matches && inspection && inspection.status !== "ok") {
    if (inspection.status === "detectedMismatch" && inspection.detectedEncoding) {
      const detectedLabel = encodingInfo(inspection.detectedEncoding).label;
      status.text = `$(warning) ${t("Rule: {0} (Actual: {1})", expected, detectedLabel)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t("Saved bytes appear to be {0}. Click to reopen (no save) or inspect the rule.", detectedLabel),
      ].join("\n");
    } else if (inspection.status === "candidateMismatch" && inspection.candidates?.length) {
      const candidateLabels = inspection.candidates.map((id) => encodingInfo(id).label).join(" / ");
      status.text = `$(warning) ${t("Rule: {0} (candidates)", expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t("Saved bytes do not match the configured rule; candidates: {0}. Click to inspect and reopen.", candidateLabels),
      ].join("\n");
    } else {
      status.text = `$(warning) ${t("Rule: {0} (decode loss)", expected)}`;
      status.tooltip = [
        t("Open: {0}", actual),
        t("Rule: {0}", expected),
        t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
        t("Saved bytes could not be decoded without loss using the configured rule ({0}). Click to reopen or inspect.", expected),
      ].join("\n");
    }
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    status.show();
    return;
  }
  status.text = matches
    ? `$(pass) ${t("Rule: {0}", expected)}`
    : `$(warning) ${t("Open: {0} / Rule: {1}", actual, expected)}`;
  status.backgroundColor = matches
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
  status.tooltip = [
    t("Open: {0}", actual),
    t("Rule: {0}", expected),
    t("Source: {0} / {1}", match.folder.name, match.rule.pattern),
    t("Click to inspect the rule or reopen with another encoding."),
  ].join("\n");
  status.show();
}
