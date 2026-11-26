import {
  bytesEqual,
  EncodingCodec,
  looksLikeBinary,
} from "./conversionCore.js";
import { scoreDecodedText } from "./candidatePreview.js";
import { ISO2022JP_ENCODING } from "./rules.js";

export type EncodingClassificationKind =
  | "match"
  | "mismatch"
  | "ambiguous"
  | "ascii"
  | "skip";

export interface EncodingClassification {
  readonly kind: EncodingClassificationKind;
  readonly detectedEncoding?: string;
  readonly candidates?: readonly string[];
  readonly replacementCharacterEncoding?: string;
}

export interface EncodingClassificationOptions {
  readonly alternativeEncodings?: readonly string[];
  readonly isCancellationRequested?: () => boolean;
  readonly allowNonCanonicalShiftJis?: boolean;
}

export class EncodingClassificationCancelledError extends Error {
  public constructor() {
    super("Encoding classification cancelled");
    this.name = "EncodingClassificationCancelledError";
  }
}

export type LineEndingKind = "lf" | "crlf" | "cr" | "mixed" | "none";
export type LineEndingStyle = Exclude<LineEndingKind, "mixed" | "none">;

export interface LineEndingClassification {
  readonly kind: LineEndingKind;
  readonly styles: readonly LineEndingStyle[];
}

export interface LineEndingSnapshot {
  readonly kind: LineEndingKind;
  readonly styles?: readonly LineEndingStyle[];
}

export interface LineEndingChange {
  readonly from: LineEndingKind;
  readonly to: LineEndingKind;
  readonly fromStyles?: readonly LineEndingStyle[];
  readonly toStyles: readonly LineEndingStyle[];
}

interface ProbeResult {
  readonly kind: "valid" | "invalid" | "binary";
  readonly hasReplacementCharacter?: true;
}

const ASCII_COMPATIBLE_ENCODINGS = new Set([
  "utf8",
  "shiftjis",
  "eucjp",
  "gb18030",
  "big5hkscs",
  "euckr",
  "windows1252",
  "iso88591",
]);

export function isAsciiCompatibleEncoding(encoding: string): boolean {
  return ASCII_COMPATIBLE_ENCODINGS.has(encoding.toLowerCase());
}

const FALLBACK_CANDIDATES = ["shiftjis", "eucjp", "utf16le", "utf16be"] as const;
const WINDOWS1252_UNDEFINED_BYTES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** Decodes bytes containing ISO-2022-JP designation escape sequences with strict validation. */
export function decodeIso2022JpStrict(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4 || !hasIso2022JpEscapeSequence(bytes)) {
    return undefined;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0 || byte >= 0x80) {
      return undefined;
    }
  }
  try {
    const text = new TextDecoder("iso-2022-jp", { fatal: true }).decode(bytes);
    if (text.includes("\uFFFD") || looksLikeBinary(text)) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

/** Returns whether bytes represent valid ISO-2022-JP (JIS) text. */
export function isIso2022JpBytes(bytes: Uint8Array): boolean {
  return decodeIso2022JpStrict(bytes) !== undefined;
}

function hasIso2022JpEscapeSequence(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length - 2; index += 1) {
    if (bytes[index] !== 0x1b) continue;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    if (second === 0x24 && (third === 0x42 || third === 0x40)) {
      return true;
    }
    if (second === 0x28 && third === 0x49) {
      return true;
    }
    if (second === 0x24 && third === 0x28 && bytes[index + 3] === 0x44) {
      return true;
    }
  }
  return false;
}

export async function classifyEncoding(
  bytes: Uint8Array,
  expectedEncoding: string,
  codec: EncodingCodec,
  options: EncodingClassificationOptions = {},
): Promise<EncodingClassification> {
  const utf16Signal = detectBom(bytes) ?? detectLikelyUtf16(bytes);
  const hasEvidence = (encoding: string): boolean => !isUtf16Encoding(encoding) || encoding === utf16Signal;
  const hasExplicitAlternatives = options.alternativeEncodings !== undefined;
  const allowSecondaryFallbacks = !hasExplicitAlternatives || options.alternativeEncodings!.length > 0;
  const alternativeEncodings = (options.alternativeEncodings ?? FALLBACK_CANDIDATES).filter(hasEvidence);
  const isCancellationRequested = options.isCancellationRequested ?? (() => false);
  const probe = (content: Uint8Array, encoding: string): Promise<ProbeResult> =>
    probeEncoding(content, encoding, codec, isCancellationRequested, options.allowNonCanonicalShiftJis === true);
  throwIfClassificationCancelled(isCancellationRequested);
  const bomEncoding = detectBom(bytes);
  if (bomEncoding) {
    const bomLength = bomEncoding === "utf8bom" ? 3 : 2;
    const contentEncoding = bomEncoding === "utf8bom" ? "utf8" : bomEncoding;
    const bomProbe = await probe(bytes.subarray(bomLength), contentEncoding);
    if (bomProbe.kind === "binary") {
      return { kind: "skip" };
    }
    if (bomProbe.kind === "valid") {
      return classifiedEncoding(bomEncoding, expectedEncoding, bomProbe);
    }
  }

  if (bytes.length === 0) {
    return { kind: "ascii" };
  }

  if (isIso2022JpBytes(bytes)) {
    return classifiedEncoding(ISO2022JP_ENCODING, expectedEncoding, { kind: "valid" });
  }

  if (isAscii(bytes) && !isUtf16Encoding(expectedEncoding)) {
    if (looksLikeBinary(new TextDecoder("ascii").decode(bytes.subarray(0, 8192)))) return { kind: "skip" };
    return ASCII_COMPATIBLE_ENCODINGS.has(expectedEncoding)
      ? { kind: "ascii" }
      : { kind: "mismatch", detectedEncoding: "utf8" };
  }

  const likelyUtf16 = detectLikelyUtf16(bytes);
  if (likelyUtf16) {
    const utf16Probe = await probe(bytes, likelyUtf16);
    if (utf16Probe.kind === "binary") {
      return { kind: "skip" };
    }
    if (utf16Probe.kind === "valid") {
      return classifiedEncoding(likelyUtf16, expectedEncoding, utf16Probe);
    }
  }

  const utf8Probe = await probe(bytes, "utf8");
  const expectedProbe =
    expectedEncoding === "utf8"
      ? utf8Probe
      : await probe(bytes, expectedEncoding);

  if (utf8Probe.kind === "valid") {
    if (expectedEncoding === "utf8") {
      return classifiedEncoding("utf8", expectedEncoding, utf8Probe);
    }
    if (expectedProbe.kind === "valid") {
      return {
        kind: "ambiguous",
        candidates: unique(["utf8", expectedEncoding]),
        ...(utf8Probe.hasReplacementCharacter ? { replacementCharacterEncoding: "utf8" }
          : expectedProbe.hasReplacementCharacter ? { replacementCharacterEncoding: expectedEncoding } : {}),
      };
    }
    return classifiedEncoding("utf8", expectedEncoding, utf8Probe);
  }

  const candidates = new Map<string, ProbeResult>();
  const alternatives = hasExplicitAlternatives
    ? alternativeEncodings
    : expectedProbe.kind === "valid"
      ? alternativeEncodings
      : [...alternativeEncodings, ...FALLBACK_CANDIDATES.filter(hasEvidence)];
  if (expectedProbe.kind === "valid") candidates.set(expectedEncoding, expectedProbe);
  for (const encoding of unique(alternatives)) {
    if (encoding === expectedEncoding || encoding === "utf8") continue;
    const result = await probe(bytes, encoding);
    if (result.kind === "valid") candidates.set(encoding, result);
  }
  if (candidates.size === 1) {
    const [encoding, result] = candidates.entries().next().value!;
    return classifiedEncoding(encoding, expectedEncoding, result);
  }
  if (candidates.size > 1) {
    const replacementCharacterEncoding = [...candidates].find(([, result]) => result.hasReplacementCharacter)?.[0];
    return {
      kind: "ambiguous",
      candidates: [...candidates.keys()],
      ...(replacementCharacterEncoding ? { replacementCharacterEncoding } : {}),
    };
  }

  if (allowSecondaryFallbacks) {
    const bomlessUtf16 = await classifyBomlessUtf16(bytes, expectedEncoding, probe, isCancellationRequested);
    if (bomlessUtf16) {
      return bomlessUtf16;
    }
    const western = await classifySingleByteWestern(bytes, expectedEncoding, probe, isCancellationRequested);
    if (western) {
      return western;
    }
  }

  if (expectedProbe.kind === "binary") {
    return { kind: "skip" };
  }
  return {
    kind: "ambiguous",
    candidates: undefined,
  };
}

function classifiedEncoding(
  detectedEncoding: string,
  expectedEncoding: string,
  probe: ProbeResult,
): EncodingClassification {
  return {
    kind: detectedEncoding === expectedEncoding ? "match" : "mismatch",
    detectedEncoding,
    ...(probe.hasReplacementCharacter ? { replacementCharacterEncoding: detectedEncoding } : {}),
  };
}

export function classifyLineEndings(
  bytes: Uint8Array,
  encodingHint?: string,
): LineEndingClassification {
  const bomEncoding = detectBom(bytes);
  const utf16Encoding =
    bomEncoding === "utf16le" || bomEncoding === "utf16be"
      ? bomEncoding
      : encodingHint === "utf16le" || encodingHint === "utf16be"
        ? encodingHint
        : detectLikelyUtf16(bytes);
  const units = utf16Encoding ? utf16CodeUnits(bytes, utf16Encoding) : bytes;
  return classifyLineEndingUnits(units);
}

export function classifyTextLineEndings(text: string): LineEndingClassification {
  return classifyLineEndingUnits(text);
}

function classifyLineEndingUnits(units: ArrayLike<number> | string): LineEndingClassification {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let index = 0; index < units.length; index += 1) {
    const current = typeof units === "string" ? units.charCodeAt(index) : units[index];
    const next = typeof units === "string" ? units.charCodeAt(index + 1) : units[index + 1];
    if (current === 0x0d && next === 0x0a) {
      crlf += 1;
      index += 1;
    } else if (current === 0x0d) {
      cr += 1;
    } else if (current === 0x0a) {
      lf += 1;
    }
  }
  const styles: Array<"lf" | "crlf" | "cr"> = [];
  if (lf > 0) {
    styles.push("lf");
  }
  if (crlf > 0) {
    styles.push("crlf");
  }
  if (cr > 0) {
    styles.push("cr");
  }
  return {
    kind: styles.length === 0 ? "none" : styles.length === 1 ? styles[0]! : "mixed",
    styles,
  };
}

export function classifyConsistentLineEndings(
  bytes: Uint8Array,
  classification: EncodingClassification,
  expectedEncoding: string,
): LineEndingClassification | undefined {
  if (classification.kind === "skip") return undefined;
  const encodings = classification.kind === "ambiguous"
    ? classification.candidates
    : [classification.detectedEncoding ?? expectedEncoding];
  if (!encodings || encodings.length === 0) {
    return undefined;
  }
  const candidates = unique(encodings).map((encoding) =>
    classifyLineEndings(bytes, encoding),
  );
  const first = candidates[0];
  return first && candidates.every((candidate) =>
    candidate.kind === first.kind &&
    candidate.styles.length === first.styles.length &&
    candidate.styles.every((style, index) => style === first.styles[index]),
  )
    ? first
    : undefined;
}

export async function isExpectedEncodingForLineEndings(
  bytes: Uint8Array,
  expectedEncoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean = () => false,
): Promise<boolean> {
  const normalized = expectedEncoding.toLowerCase().replaceAll("-", "");
  if (normalized !== "utf16le" && normalized !== "utf16be") {
    return true;
  }
  const classification = await classifyEncoding(bytes, expectedEncoding, codec, {
    alternativeEncodings: [],
    isCancellationRequested,
  });
  return (
    classification.kind === "match" ||
    classification.kind === "ascii" ||
    (classification.kind === "ambiguous" &&
      classifyConsistentLineEndings(bytes, classification, expectedEncoding) !== undefined)
  );
}

export function detectLineEndingChange(
  previous: LineEndingSnapshot | undefined,
  current: LineEndingClassification,
): LineEndingChange | undefined {
  if (!previous) {
    return undefined;
  }
  const changed = previous.kind !== current.kind || (
    previous.styles !== undefined &&
    !sameLineEndingStyles(previous.styles, current.styles)
  );
  return changed
    ? {
      from: previous.kind,
      to: current.kind,
      fromStyles: previous.styles,
      toStyles: current.styles,
    }
    : undefined;
}

function sameLineEndingStyles(
  left: readonly LineEndingStyle[],
  right: readonly LineEndingStyle[],
): boolean {
  return left.length === right.length && left.every((style) => right.includes(style));
}

async function probeEncoding(
  bytes: Uint8Array,
  encoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean,
  allowNonCanonicalShiftJis: boolean,
): Promise<ProbeResult> {
  throwIfClassificationCancelled(isCancellationRequested);
  let text: string;
  try {
    text = await codec.decode(bytes, encoding);
  } catch {
    throwIfClassificationCancelled(isCancellationRequested);
    return { kind: "invalid" };
  }
  throwIfClassificationCancelled(isCancellationRequested);
  if (looksLikeBinary(text)) {
    return { kind: "binary" };
  }
  let roundTrip: Uint8Array;
  try {
    roundTrip = await codec.encode(text, encoding);
  } catch {
    throwIfClassificationCancelled(isCancellationRequested);
    return { kind: "invalid" };
  }
  throwIfClassificationCancelled(isCancellationRequested);
  if (bytesEqual(bytes, roundTrip)) {
    return text.includes("\uFFFD") ? { kind: "valid", hasReplacementCharacter: true } : { kind: "valid" };
  }
  if (allowNonCanonicalShiftJis && encoding === "shiftjis") {
    // CP932 aliases can decode without loss even though the encoder chooses different bytes.
    try {
      if (new TextDecoder("shift_jis", { fatal: true }).decode(bytes) === text) {
        return { kind: "valid" };
      }
    } catch { /* Invalid Shift JIS bytes still fail the probe. */ }
  }
  return { kind: "invalid" };
}

function throwIfClassificationCancelled(
  isCancellationRequested: () => boolean,
): void {
  if (isCancellationRequested()) {
    throw new EncodingClassificationCancelledError();
  }
}

function detectBom(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf8bom";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf16be";
  }
  return undefined;
}

function isAscii(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte > 0 && byte < 0x80);
}

function detectLikelyUtf16(bytes: Uint8Array): "utf16le" | "utf16be" | undefined {
  const pairCount = Math.floor(Math.min(bytes.length, 8192) / 2);
  if (pairCount < 2) {
    return undefined;
  }
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < pairCount * 2; index += 2) {
    if (bytes[index] === 0) {
      evenZeros += 1;
    }
    if (bytes[index + 1] === 0) {
      oddZeros += 1;
    }
  }
  const evenRatio = evenZeros / pairCount;
  const oddRatio = oddZeros / pairCount;
  if (oddRatio >= 0.3 && evenRatio <= 0.1) {
    return "utf16le";
  }
  if (evenRatio >= 0.3 && oddRatio <= 0.1) {
    return "utf16be";
  }
  return undefined;
}

export function detectUtf16Signal(bytes: Uint8Array): "utf16le" | "utf16be" | undefined {
  const bom = detectBom(bytes);
  if (bom === "utf16le" || bom === "utf16be") {
    return bom;
  }
  return bom ? undefined : detectLikelyUtf16(bytes);
}

function isUtf16Encoding(encoding: string): boolean {
  const normalized = encoding.toLowerCase().replaceAll(/[-_]/g, "");
  return normalized === "utf16" || normalized === "utf16le" || normalized === "utf16be";
}

function utf16CodeUnits(
  bytes: Uint8Array,
  encoding: "utf16le" | "utf16be",
): Uint16Array {
  const offset = detectBom(bytes) === encoding ? 2 : 0;
  const length = Math.floor((bytes.length - offset) / 2);
  const units = new Uint16Array(length);
  for (let index = 0; index < length; index += 1) {
    const first = bytes[offset + index * 2]!;
    const second = bytes[offset + index * 2 + 1]!;
    units[index] = encoding === "utf16le" ? first | (second << 8) : (first << 8) | second;
  }
  return units;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

interface BomlessUtf16Candidate {
  readonly encoding: "utf16le" | "utf16be";
  readonly probe: ProbeResult;
  readonly score: ReturnType<typeof scoreDecodedText>;
  readonly strongScriptCount: number;
  readonly whitespaceCount: number;
}

function inspectBomlessUtf16Text(text: string): {
  readonly valid: boolean;
  readonly strongScriptCount: number;
  readonly whitespaceCount: number;
} {
  let strongScriptCount = 0;
  let whitespaceCount = 0;
  const sampleLimit = Math.min(text.length, 4096);
  for (let i = 0; i < sampleLimit; ) {
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) {
      whitespaceCount += 1;
      i += step;
      continue;
    }
    const invalidControl =
      cp < 0x20 ||
      cp === 0x7f ||
      (cp >= 0x80 && cp <= 0x9f) ||
      cp === 0xfffd ||
      (cp >= 0xe000 && cp <= 0xf8ff) ||
      (cp >= 0xfff0 && cp <= 0xffff);
    if (invalidControl) {
      return { valid: false, strongScriptCount: 0, whitespaceCount: 0 };
    }
    const isCommonJapanesePunct =
      cp === 0x3000 || cp === 0x3001 || cp === 0x3002 || cp === 0x300c || cp === 0x300d;
    const isStrongScript =
      isCommonJapanesePunct ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xff01 && cp <= 0xff5e) ||
      (cp >= 0xac00 && cp <= 0xd7a3);
    if (isStrongScript) {
      strongScriptCount += 1;
    }
    i += step;
  }
  return { valid: true, strongScriptCount, whitespaceCount };
}

const BOMLESS_UTF16_PRESCREEN_BYTES = 8192;

function sliceBomlessUtf16Prefix(
  bytes: Uint8Array,
  encoding: "utf16le" | "utf16be",
): Uint8Array {
  let limit = Math.min(bytes.length, BOMLESS_UTF16_PRESCREEN_BYTES);
  limit -= limit % 2;
  if (limit >= 2 && limit < bytes.length) {
    const lastUnit =
      encoding === "utf16le"
        ? bytes[limit - 2]! | (bytes[limit - 1]! << 8)
        : (bytes[limit - 2]! << 8) | bytes[limit - 1]!;
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      limit -= 2;
    }
  }
  return bytes.subarray(0, limit);
}

async function evaluateBomlessUtf16Endian(
  bytes: Uint8Array,
  encoding: "utf16le" | "utf16be",
  probe: (content: Uint8Array, encoding: string) => Promise<ProbeResult>,
): Promise<BomlessUtf16Candidate | undefined> {
  const decoderLabel = encoding === "utf16le" ? "utf-16le" : "utf-16be";
  const prefix = sliceBomlessUtf16Prefix(bytes, encoding);
  if (prefix.byteLength < 4) return undefined;
  let sampleText: string;
  try {
    sampleText = new TextDecoder(decoderLabel, { fatal: true }).decode(prefix);
  } catch {
    return undefined;
  }
  if (looksLikeBinary(sampleText)) return undefined;
  const inspected = inspectBomlessUtf16Text(sampleText);
  if (!inspected.valid) return undefined;
  if (inspected.strongScriptCount === 0 && inspected.whitespaceCount === 0) {
    return undefined;
  }
  if (prefix.byteLength < bytes.byteLength) {
    try {
      new TextDecoder(decoderLabel, { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  const probeResult = await probe(bytes, encoding);
  if (probeResult.kind !== "valid") return undefined;
  return {
    encoding,
    probe: probeResult,
    score: scoreDecodedText(sampleText),
    strongScriptCount: inspected.strongScriptCount,
    whitespaceCount: inspected.whitespaceCount,
  };
}

async function classifyBomlessUtf16(
  bytes: Uint8Array,
  expectedEncoding: string,
  probe: (content: Uint8Array, encoding: string) => Promise<ProbeResult>,
  isCancellationRequested: () => boolean,
): Promise<EncodingClassification | undefined> {
  if (bytes.length < 4 || bytes.length % 2 !== 0) {
    return undefined;
  }
  throwIfClassificationCancelled(isCancellationRequested);
  const evaluated: BomlessUtf16Candidate[] = [];
  for (const encoding of ["utf16le", "utf16be"] as const) {
    const candidate = await evaluateBomlessUtf16Endian(bytes, encoding, probe);
    if (candidate) evaluated.push(candidate);
  }
  if (evaluated.length === 0) return undefined;

  evaluated.sort((left, right) =>
    right.score.avgScore - left.score.avgScore ||
    right.score.score - left.score.score ||
    right.whitespaceCount - left.whitespaceCount,
  );
  const top = evaluated[0]!;
  const second = evaluated[1];
  const hasWhitespaceEdge =
    top.whitespaceCount >= 1 &&
    (!second || second.whitespaceCount === 0) &&
    top.score.avgScore >= 1.5;
  const hasNaturalTextEdge =
    top.strongScriptCount >= 2 &&
    top.score.nonAsciiCount >= 4 &&
    top.score.avgScore >= 2.0 &&
    top.score.score >= 12.0 &&
    (!second || (
      top.score.avgScore - second.score.avgScore >= 1.5 &&
      top.score.score - second.score.score >= 6.0
    ));
  if (hasWhitespaceEdge || hasNaturalTextEdge) {
    return classifiedEncoding(top.encoding, expectedEncoding, top.probe);
  }
  const plausible = evaluated.filter(
    (entry) => entry.score.avgScore >= 1.0 && (entry.strongScriptCount >= 2 || entry.whitespaceCount >= 1),
  );
  if (plausible.length === 0) return undefined;
  return {
    kind: "ambiguous",
    candidates: plausible.map((entry) => entry.encoding),
  };
}

async function classifySingleByteWestern(
  bytes: Uint8Array,
  expectedEncoding: string,
  probe: (content: Uint8Array, encoding: string) => Promise<ProbeResult>,
  isCancellationRequested: () => boolean,
): Promise<EncodingClassification | undefined> {
  throwIfClassificationCancelled(isCancellationRequested);
  let hasWindows1252Special = false;
  let hasHighByte = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      return undefined;
    }
    if (byte >= 0x80 && byte <= 0x9f) {
      if (WINDOWS1252_UNDEFINED_BYTES.has(byte)) {
        return undefined;
      }
      hasWindows1252Special = true;
      hasHighByte = true;
    } else if (byte >= 0xa0) {
      hasHighByte = true;
    }
  }
  if (!hasHighByte) return undefined;

  if (hasWindows1252Special) {
    const w1252 = await probe(bytes, "windows1252");
    return w1252.kind === "valid"
      ? classifiedEncoding("windows1252", expectedEncoding, w1252)
      : undefined;
  }

  const validCandidates: Array<{ readonly encoding: string; readonly probe: ProbeResult }> = [];
  for (const encoding of ["windows1252", "iso88591"] as const) {
    const result = await probe(bytes, encoding);
    if (result.kind === "valid") {
      validCandidates.push({ encoding, probe: result });
    }
  }
  if (validCandidates.length === 1) {
    return classifiedEncoding(validCandidates[0]!.encoding, expectedEncoding, validCandidates[0]!.probe);
  }
  if (validCandidates.length > 1) {
    return {
      kind: "ambiguous",
      candidates: validCandidates.map((entry) => entry.encoding),
    };
  }
  return undefined;
}
