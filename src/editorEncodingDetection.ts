// Resource byte reading, encoding classification, document inspection, and comparison side resolution.

import * as vscode from "vscode";
import { rankDecodedCandidates } from "./candidatePreview.js";
import {
  classifyEncoding,
  isAsciiCompatibleEncoding,
  type EncodingClassification,
} from "./scanCore.js";
import { createWorkspaceCodec } from "./conversionResources.js";
import {
  readStableResource,
  resourceStillMatchesRead,
  statResourceVersion,
  statTokenFromStableRead,
} from "./stableResourceRead.js";
import { isLegacyMultibyteEncoding, isReopenableEncoding } from "./rules.js";
import {
  type RuleMatch,
  resolveRule,
  getAutoDetectEncodings,
  fileUriForResource,
} from "./workspaceRules.js";
import {
  CACHE_TTL_MS,
  type ComparisonInput,
  type EncodingBasis,
  type FileEncodingInspection,
  type InspectedBytes,
  type ResourceBytes,
  type SideResolution,
  activeInspectionInvalidators,
  autoDetectedUris,
  byteClassificationCache,
  countReplacementCharacters,
  effectiveDefaultFilesEncoding,
  findDocument,
  inspectedFileDocuments,
  manualSides,
  maxResourceBytes,
  resolvedSides,
  sameEncoding,
  setBounded,
  storedOpenEncodingBasis,
  syncPreferredResolution,
} from "./editorEncodingState.js";

export async function readResourceBytes(
  uri: vscode.Uri,
  maxSize: number,
  isInvalid: () => boolean = () => !!findDocument(uri)?.isDirty,
): Promise<ResourceBytes | undefined> {
  try {
    if (uri.scheme === "file") {
      if (typeof readStableResource !== "function" || typeof resourceStillMatchesRead !== "function") {
        return undefined;
      }
      const read = await readStableResource(uri, maxSize, isInvalid);
      if (!read) return undefined;
      const statToken =
        typeof statTokenFromStableRead === "function" ? statTokenFromStableRead(read) : undefined;
      return {
        bytes: read.bytes,
        fingerprint: `file:${read.localFile?.contentHash ?? `${read.mtime}:${read.size}`}`,
        statToken,
        stillCurrent: () =>
          statToken && typeof statResourceVersion === "function"
            ? statResourceVersion(uri, maxSize, isInvalid).then((current) => current === statToken)
            : resourceStillMatchesRead(uri, maxSize, read, isInvalid),
      };
    }
    if (uri.scheme === "git") {
      const fsApi = vscode.workspace.fs;
      if (!fsApi?.readFile) return undefined;
      const stat = fsApi.stat ? await fsApi.stat(uri) : undefined;
      const fileType = vscode.FileType?.File ?? 1;
      if (stat && ((stat.type !== undefined && stat.type !== fileType) || stat.size > maxSize)) {
        return undefined;
      }
      const bytes = await fsApi.readFile(uri);
      if (bytes.byteLength > maxSize) return undefined;
      const version = findDocument(uri)?.version ?? 0;
      return {
        bytes,
        fingerprint: `git:${uri.query}:${stat?.mtime ?? 0}:${bytes.byteLength}:v${version}`,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function countReplacementCharactersInBytes(bytes: Uint8Array, encoding: string): Promise<number> {
  if (typeof vscode.workspace.decode !== "function") return 1;
  const normalized = encoding.toLowerCase();
  const bomLength =
    normalized === "utf8bom" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const decodeEncoding = normalized === "utf8bom" ? "utf8" : normalized;
  try {
    const text = await vscode.workspace.decode(bytes.subarray(bomLength), {
      encoding: decodeEncoding,
    });
    return countReplacementCharacters(text);
  } catch {
    return 1;
  }
}

async function evaluateLikelyCandidates(
  bytes: Uint8Array,
  candidates: readonly string[],
): Promise<{ likelyEncoding?: string; likelyEquivalentEncodings?: readonly string[] }> {
  if (candidates.length < 2 || typeof vscode.workspace.decode !== "function") {
    return {};
  }
  const decoded: Array<{ readonly encoding: string; readonly text: string }> = [];
  for (const candidate of candidates) {
    if (!isReopenableEncoding(candidate)) continue;
    const normalized = candidate.toLowerCase();
    const bomLength =
      normalized === "utf8bom" &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
        ? 3
        : 0;
    const decodeEncoding = normalized === "utf8bom" ? "utf8" : normalized;
    try {
      const text = await vscode.workspace.decode(bytes.subarray(bomLength), {
        encoding: decodeEncoding,
      });
      decoded.push({ encoding: candidate, text });
    } catch {
      // Unreadable candidates cannot win natural-text ranking.
    }
  }
  if (decoded.length < 2) return {};
  const ranked = rankDecodedCandidates(decoded);
  if (!ranked[0]?.likely) return {};
  return {
    likelyEncoding: ranked[0].encoding,
    likelyEquivalentEncodings: ranked
      .filter((entry) => entry.equivalentToLikely)
      .map((entry) => entry.encoding.toLowerCase()),
  };
}

async function inspectUriBytes(
  uri: vscode.Uri,
  expectedEncoding: string,
  isInvalid?: () => boolean,
): Promise<InspectedBytes | undefined> {
  if (
    typeof classifyEncoding !== "function" ||
    typeof vscode.workspace.decode !== "function" ||
    typeof vscode.workspace.encode !== "function"
  ) {
    return undefined;
  }
  const maxSize = maxResourceBytes(uri);
  const checkInvalid = isInvalid ?? (() => !!findDocument(uri)?.isDirty);
  const alternativeEncodings = getAutoDetectEncodings(fileUriForResource(uri));
  const cacheKey = `${uri.toString()}::${expectedEncoding}::${alternativeEncodings.join(",")}`;
  const now = Date.now();
  const cached = byteClassificationCache.get(cacheKey);
  if (
    cached &&
    cached.expiresAt > now &&
    cached.statToken &&
    uri.scheme === "file" &&
    typeof statResourceVersion === "function"
  ) {
    const currentStat = await statResourceVersion(uri, maxSize, checkInvalid);
    if (currentStat && currentStat === cached.statToken) {
      return {
        classification: cached.classification,
        empty: cached.empty,
        replacementCharacterCount: cached.replacementCharacterCount,
        likelyEncoding: cached.likelyEncoding,
        likelyEquivalentEncodings: cached.likelyEquivalentEncodings,
      };
    }
  }
  const read = await readResourceBytes(uri, maxSize, checkInvalid);
  if (!read) return undefined;
  if (cached && cached.fingerprint === read.fingerprint && cached.expiresAt > now) {
    if (checkInvalid()) return undefined;
    return {
      classification: cached.classification,
      empty: cached.empty,
      replacementCharacterCount: cached.replacementCharacterCount,
      likelyEncoding: cached.likelyEncoding,
      likelyEquivalentEncodings: cached.likelyEquivalentEncodings,
    };
  }
  try {
    const classification = await classifyEncoding(
      read.bytes,
      expectedEncoding,
      createWorkspaceCodec(),
      {
        allowNonCanonicalShiftJis: true,
        alternativeEncodings,
      },
    );
    const replacementCharacterCount = classification.replacementCharacterEncoding
      ? await countReplacementCharactersInBytes(read.bytes, classification.replacementCharacterEncoding)
      : undefined;
    const likelyResult =
      classification.kind === "ambiguous" && classification.candidates?.length
        ? await evaluateLikelyCandidates(read.bytes, classification.candidates)
        : {};
    if (checkInvalid() || (read.stillCurrent && !(await read.stillCurrent()))) return undefined;
    const empty = read.bytes.byteLength === 0;
    setBounded(byteClassificationCache, cacheKey, {
      fingerprint: read.fingerprint,
      statToken: read.statToken,
      expiresAt: now + CACHE_TTL_MS,
      classification,
      empty,
      replacementCharacterCount,
      likelyEncoding: likelyResult.likelyEncoding,
      likelyEquivalentEncodings: likelyResult.likelyEquivalentEncodings,
    });
    return {
      classification,
      empty,
      replacementCharacterCount,
      likelyEncoding: likelyResult.likelyEncoding,
      likelyEquivalentEncodings: likelyResult.likelyEquivalentEncodings,
    };
  } catch {
    return undefined;
  }
}

export function compatibleWithAscii(encoding: string, empty: boolean): boolean {
  const normalized = encoding.toLowerCase();
  return empty || isAsciiCompatibleEncoding(normalized);
}

export function canAlignAsciiCounterpart(encoding: string, empty: boolean): boolean {
  const normalized = encoding.toLowerCase();
  return compatibleWithAscii(normalized, empty) || normalized === "utf8bom";
}

function resolveWorkingFileRule(
  match: RuleMatch,
  inspected: InspectedBytes | undefined,
): SideResolution {
  const encoding = match.rule.encoding;
  const classification = inspected?.classification;
  const likelyMatchesRule =
    classification?.kind === "ambiguous" &&
    inspected?.likelyEquivalentEncodings?.includes(encoding.toLowerCase()) === true;
  if (
    classification?.kind === "match" ||
    likelyMatchesRule ||
    (classification?.kind === "ascii" && compatibleWithAscii(encoding, inspected?.empty === true))
  ) {
    return { encoding, basis: "rule", match };
  }
  if (classification?.kind === "mismatch" && classification.detectedEncoding) {
    return {
      encoding: classification.detectedEncoding,
      basis: "detected",
      match,
      actualMismatch: true,
    };
  }
  return { match, keepCurrentEncoding: true, candidates: classification?.candidates };
}

export async function classifySide(
  uri: vscode.Uri,
  counterpartUri?: vscode.Uri,
): Promise<SideResolution> {
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
    const confirmed =
      classification.kind === "match" ||
      (classification.kind === "ascii" && compatibleWithAscii(preferred.encoding, empty)) ||
      (classification.kind === "ambiguous" &&
        classification.candidates?.includes(preferred.encoding) === true);
    if (confirmed) {
      return {
        encoding: preferred.encoding,
        basis: preferred.basis,
        match: directMatch ?? preferred.match,
        ...(preferred.basis === "guessed" && classification.kind === "ambiguous"
          ? { candidates: classification.candidates }
          : {}),
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
      if ((!directMatch || uri.scheme === "git") && inspected.likelyEncoding) {
        return {
          encoding: inspected.likelyEncoding,
          basis: "guessed",
          candidates: classification.candidates,
          match: directMatch ?? preferred.match,
          actualMismatch: true,
        };
      }
      return {
        candidates: classification.candidates,
        match: directMatch ?? preferred.match,
        actualMismatch: true,
      };
    }
    return { encoding: preferred.encoding, basis: preferred.basis, match: directMatch ?? preferred.match };
  }
  if (classification.kind === "ascii") return { ascii: true, empty };
  if (
    (classification.kind === "match" || classification.kind === "mismatch") &&
    classification.detectedEncoding
  ) {
    return { encoding: classification.detectedEncoding, basis: "detected" };
  }
  if (classification.kind === "ambiguous") {
    if (inspected.likelyEncoding) {
      return {
        encoding: inspected.likelyEncoding,
        basis: "guessed",
        candidates: classification.candidates,
      };
    }
    return { candidates: classification.candidates };
  }
  return {};
}

function storeFileInspection(key: string, inspection: FileEncodingInspection): FileEncodingInspection {
  setBounded(inspectedFileDocuments, key, inspection);
  return inspection;
}

function replacementCountIfMatched(
  inspected: {
    readonly classification: EncodingClassification;
    readonly replacementCharacterCount?: number;
  },
  encoding: string,
): { readonly has: boolean; readonly count: number } {
  if (inspected.classification.replacementCharacterEncoding?.toLowerCase() !== encoding.toLowerCase()) {
    return { has: false, count: 0 };
  }
  const count = inspected.replacementCharacterCount ?? 1;
  return { has: count > 0, count };
}

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
      (current.classification.kind === "ascii" &&
        (current.empty || isAsciiCompatibleEncoding(docEncoding))) ||
      (current.classification.kind === "ambiguous" &&
        current.classification.candidates?.some((candidate) => candidate.toLowerCase() === docEncoding) ===
          true)
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

  const inspected = preloadedUtf8 ?? (await inspectUriBytes(document.uri, "utf8", isInvalid));
  if (!stillValid() || !inspected || inspected.classification.kind === "skip") {
    return undefined;
  }
  const { classification, empty } = inspected;

  if (classification.kind === "ascii") {
    if (empty || isAsciiCompatibleEncoding(docEncoding)) {
      return {
        documentEncoding: docEncoding,
        status: "ok",
        ...(empty ? {} : { detectedEncoding: "utf8" }),
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

  if (
    (classification.kind === "match" || classification.kind === "mismatch") &&
    classification.detectedEncoding
  ) {
    const detected = classification.detectedEncoding.toLowerCase();
    if (docEncoding === detected) {
      const replacement = replacementCountIfMatched(inspected, detected);
      const defaultEncoding = effectiveDefaultFilesEncoding(document);
      const basis: EncodingBasis | undefined = isManual
        ? "openFile"
        : autoDetectedUris.get(key)?.toLowerCase() === docEncoding ||
            !sameEncoding(docEncoding, defaultEncoding)
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
    if (detected === "utf8" && isLegacyMultibyteEncoding(docEncoding)) {
      const current = await inspectUriBytes(document.uri, docEncoding, isInvalid);
      if (!stillValid()) return undefined;
      if (
        current?.classification.kind === "ambiguous" &&
        current.classification.candidates?.some((c) => c.toLowerCase() === docEncoding)
      ) {
        const replacement = replacementCountIfMatched(current, docEncoding);
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
        candidates: classification.candidates,
        basis: storedOpenEncodingBasis(key, docEncoding),
        initialHadReplacementCharacter: replacement.has,
        initialReplacementCharacterCount: replacement.count,
      };
    }
    return {
      documentEncoding: docEncoding,
      status: "candidateMismatch",
      ...(inspected.likelyEncoding
        ? { detectedEncoding: inspected.likelyEncoding, basis: "guessed" as const }
        : {}),
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
 * Inspects the saved bytes of a local file against the active editor encoding and rule.
 * Returns any preserved session state while dirty without touching disk.
 */
export async function inspectFileDocument(
  document: vscode.TextDocument,
): Promise<FileEncodingInspection | undefined> {
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
  const markInvalid = (): void => {
    invalidated = true;
  };
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
    const likelyMatchesRule =
      classification.kind === "ambiguous" &&
      inspected.likelyEquivalentEncodings?.includes(expectedRuleEncoding) === true;
    const ambiguousIncludesRule =
      classification.kind === "ambiguous" &&
      classification.candidates?.some((c) => c.toLowerCase() === expectedRuleEncoding) === true;
    if (
      uniquelyMatchesRule ||
      likelyMatchesRule ||
      (docEncoding === expectedRuleEncoding && ambiguousIncludesRule)
    ) {
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
        (classification.kind === "ascii" && (empty || isAsciiCompatibleEncoding(docEncoding))) ||
        (classification.kind === "ambiguous" &&
          classification.candidates?.some((c) => c.toLowerCase() === docEncoding) === true);
      if (!docCompatible && manualSides.has(key) && docEncoding !== "utf8") {
        const current = await inspectUriBytes(document.uri, docEncoding, isInvalid);
        if (!stillValid()) return inspectedFileDocuments.get(key);
        docCompatible = Boolean(
          current &&
            (current.classification.kind === "match" ||
              (current.classification.kind === "ascii" &&
                (current.empty || isAsciiCompatibleEncoding(docEncoding))) ||
              (current.classification.kind === "ambiguous" &&
                current.classification.candidates?.some((c) => c.toLowerCase() === docEncoding) ===
                  true)),
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
      const evaluated = await evaluateDocumentBytes(
        document,
        docEncoding,
        key,
        isInvalid,
        stillValid,
        preloadedUtf8,
      );
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

export function currentFileInspection(
  document: vscode.TextDocument,
): FileEncodingInspection | undefined {
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
      ruleConfirmed: currentRule
        ? currentRule === docEncoding || cached.ruleConfirmed === true
        : undefined,
      status: "ok",
      basis: currentRule ? undefined : storedOpenEncodingBasis(key, docEncoding, "detected"),
      initialHadReplacementCharacter: false,
      initialReplacementCharacterCount: 0,
    };
  }
  return document.isDirty ? cached : undefined;
}

export async function canReopenWithRule(
  document: vscode.TextDocument,
  match: RuleMatch,
): Promise<boolean> {
  if (document.isDirty || document.isClosed || document.uri.scheme !== "file") return false;
  const version = document.version;
  const resolution = await classifySide(document.uri);
  return (
    document.version === version &&
    !document.isDirty &&
    !document.isClosed &&
    resolution.basis === "rule" &&
    sameEncoding(resolution.encoding, match.rule.encoding) &&
    sameEncoding(resolveRule(document.uri)?.rule.encoding, match.rule.encoding)
  );
}

export async function canReopenWithDetectedEncoding(
  document: vscode.TextDocument,
  expectedEncoding: string,
): Promise<boolean> {
  if (
    document.isDirty ||
    document.isClosed ||
    document.uri.scheme !== "file" ||
    !isReopenableEncoding(expectedEncoding)
  ) {
    return false;
  }
  const version = document.version;
  const inspection = await inspectFileDocument(document);
  const eligibleMismatch =
    inspection?.status === "detectedMismatch" ||
    (inspection?.status === "candidateMismatch" && inspection.basis === "guessed");
  return (
    document.version === version &&
    !document.isDirty &&
    !document.isClosed &&
    !resolveRule(document.uri) &&
    eligibleMismatch &&
    sameEncoding(inspection?.detectedEncoding, expectedEncoding)
  );
}

function reconcileSideWithCounterpart(side: SideResolution, other: SideResolution): SideResolution {
  if (side.keepCurrentEncoding) return side;
  const otherEncoding = other.encoding;
  if (
    side.basis === "guessed" &&
    side.candidates?.length &&
    otherEncoding &&
    other.basis !== "guessed" &&
    side.candidates.some((candidate) => sameEncoding(candidate, otherEncoding))
  ) {
    return { ...side, encoding: otherEncoding, basis: other.basis ?? "detected", candidates: undefined };
  }
  if (
    !side.encoding &&
    side.candidates?.length &&
    otherEncoding &&
    side.candidates.some((candidate) => sameEncoding(candidate, otherEncoding))
  ) {
    return {
      ...side,
      encoding: otherEncoding,
      basis: other.basis ?? "detected",
      candidates: other.basis === "guessed" ? side.candidates : undefined,
    };
  }
  if (
    !side.encoding &&
    side.ascii &&
    otherEncoding &&
    canAlignAsciiCounterpart(otherEncoding, side.empty === true)
  ) {
    return { ...side, encoding: otherEncoding, basis: other.basis ?? "detected" };
  }
  return side;
}

export async function resolveComparisonSides(
  comparison: ComparisonInput,
): Promise<[SideResolution, SideResolution]> {
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

export async function resolveSingleSide(uri: vscode.Uri): Promise<SideResolution> {
  const resolution = await classifySide(uri);
  setBounded(resolvedSides, uri.toString(), { resolution, updatedAt: Date.now() });
  return resolution;
}

export function currentSideResolution(
  uri: vscode.Uri,
  counterpartUri?: vscode.Uri,
): SideResolution {
  const cached = resolvedSides.get(uri.toString());
  if (cached && Date.now() - cached.updatedAt <= CACHE_TTL_MS) {
    const directMatch = resolveRule(uri);
    if (
      (cached.resolution.match?.rule.encoding.toLowerCase() ?? undefined) ===
      (directMatch?.rule.encoding.toLowerCase() ?? undefined)
    ) {
      return cached.resolution;
    }
  }
  const preferred = syncPreferredResolution(uri, counterpartUri);
  return preferred
    ? { encoding: preferred.encoding, basis: preferred.basis, match: resolveRule(uri) ?? preferred.match }
    : { match: resolveRule(uri) };
}
