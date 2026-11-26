const MAX_SCORE_SAMPLES = 2_048;
const DEFAULT_MAX_PREVIEW_LENGTH = 100;
const LINE_WINDOW_LEAD = 20;
const LINE_WINDOW_TRIGGER = 40;
const LINE_SLICE_LIMIT = 512;

const MIN_LIKELY_NON_ASCII = 2;
const MIN_LIKELY_AVG_MARGIN = 1.5;
const MIN_LIKELY_TOTAL_MARGIN = 4.0;

export interface DecodedTextScore {
  readonly score: number;
  readonly avgScore: number;
  readonly nonAsciiCount: number;
  readonly replacementCount: number;
}

export interface RankedEncodingCandidate {
  readonly encoding: string;
  readonly preview: string;
  readonly score: number;
  readonly avgScore: number;
  readonly nonAsciiCount: number;
  readonly likely: boolean;
}

export interface CandidatePreviewOptions {
  readonly prefix?: string;
  readonly maxLength?: number;
}

export interface RankCandidatesOptions {
  readonly previewPrefix?: string;
  readonly maxPreviewLength?: number;
}

type CharCategory =
  | "ascii"
  | "hiragana"
  | "katakana"
  | "cjkPunct"
  | "kanji"
  | "hangul"
  | "commonSymbol"
  | "latinLetter"
  | "halfwidthKatakana"
  | "halfwidthKatakanaPunct"
  | "latin1Symbol"
  | "control"
  | "replacement"
  | "pua"
  | "boxDrawing"
  | "other";

interface LineSpan {
  readonly start: number;
  readonly end: number;
  readonly nextOffset: number;
  readonly firstNonAscii: number;
  readonly firstNonWs: number;
}

function isJapaneseCore(category: CharCategory): boolean {
  return (
    category === "hiragana" ||
    category === "katakana" ||
    category === "cjkPunct" ||
    category === "kanji"
  );
}

function isAsciiLetter(code: number | undefined): boolean {
  return (
    code !== undefined &&
    ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
  );
}

function isLatinLetterCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  if (code >= 0x00c0 && code <= 0x00ff && code !== 0x00d7 && code !== 0x00f7) {
    return true;
  }
  return code >= 0x0100 && code <= 0x017f;
}

function isLatinWordCode(code: number | undefined): boolean {
  return isAsciiLetter(code) || isLatinLetterCode(code);
}

function isCommonSymbol(cp: number): boolean {
  if (
    cp === 0x00a5 ||
    cp === 0x00a9 ||
    cp === 0x00ae ||
    cp === 0x00b0 ||
    cp === 0x00b1 ||
    cp === 0x00d7 ||
    cp === 0x00f7 ||
    cp === 0x20ac ||
    cp === 0x2122
  ) {
    return true;
  }
  if (cp >= 0x2010 && cp <= 0x2027) return true;
  if (cp >= 0x2030 && cp <= 0x203b) return true;
  if (cp >= 0x2160 && cp <= 0x217f) return true;
  if (cp >= 0x2190 && cp <= 0x21ff) return true;
  if (cp >= 0x2460 && cp <= 0x24ff) return true;
  if (cp >= 0x25a0 && cp <= 0x26ff) return true;
  return false;
}

function isKanji(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x323af)
  );
}

function isHangul(cp: number): boolean {
  return (
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  );
}

function classifyCodePoint(cp: number): CharCategory {
  if (cp < 0x80) return "ascii";
  if (cp === 0xfffd) return "replacement";
  if (cp <= 0x9f) return "control";
  if (cp >= 0x3040 && cp <= 0x309f) return "hiragana";
  if (cp >= 0x30a0 && cp <= 0x30ff) return "katakana";
  if (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff01 && cp <= 0xff5e) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return "cjkPunct";
  }
  if (isKanji(cp)) return "kanji";
  if (isHangul(cp)) return "hangul";
  if (cp >= 0xff61 && cp <= 0xff65) return "halfwidthKatakanaPunct";
  if (cp >= 0xff66 && cp <= 0xff9f) return "halfwidthKatakana";
  if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xfff0 && cp <= 0xffff)) {
    return "pua";
  }
  if (isLatinLetterCode(cp)) return "latinLetter";
  if (isCommonSymbol(cp)) return "commonSymbol";
  if (cp >= 0x00a0 && cp <= 0x00bf) return "latin1Symbol";
  if (cp >= 0x2500 && cp <= 0x259f) return "boxDrawing";
  return "other";
}

function isUnexpectedC0Control(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f;
}

export function scoreDecodedText(text: string): DecodedTextScore {
  const limit = text.length;
  let score = 0;
  let nonAsciiCount = 0;
  let sampledCount = 0;
  let replacementCount = 0;
  let prevCategory: CharCategory = "ascii";

  for (let i = 0; i < limit && sampledCount < MAX_SCORE_SAMPLES; ) {
    const cp = text.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;

    if (cp < 0x80) {
      if (isUnexpectedC0Control(cp)) {
        score -= 8.0;
        sampledCount += 1;
        prevCategory = "control";
      } else {
        prevCategory = "ascii";
      }
      i += step;
      continue;
    }

    nonAsciiCount += 1;
    sampledCount += 1;
    const category = classifyCodePoint(cp);
    switch (category) {
      case "hiragana":
        score += 4.0;
        break;
      case "katakana":
        score += 3.5;
        break;
      case "cjkPunct":
        score += 2.5;
        break;
      case "kanji":
        score += 2.0;
        break;
      case "hangul":
        score += 3.5;
        break;
      case "commonSymbol":
        score += 1.0;
        break;
      case "latinLetter": {
        const prevCode = i > 0 ? text.charCodeAt(i - 1) : undefined;
        const nextCode = i + step < limit ? text.charCodeAt(i + step) : undefined;
        score += isLatinWordCode(prevCode) || isLatinWordCode(nextCode) ? 1.5 : -1.5;
        break;
      }
      case "halfwidthKatakanaPunct":
        score -= 2.5;
        break;
      case "halfwidthKatakana":
        score -= 1.0;
        break;
      case "latin1Symbol":
        score -= 1.5;
        break;
      case "boxDrawing":
        score -= 0.5;
        break;
      case "pua":
        score -= 5.0;
        break;
      case "control":
        score -= 8.0;
        break;
      case "replacement":
        replacementCount += 1;
        score -= 12.0;
        break;
      default:
        break;
    }

    if (
      (isJapaneseCore(prevCategory) && isJapaneseCore(category)) ||
      (prevCategory === "hangul" && category === "hangul")
    ) {
      score += 1.5;
    }

    prevCategory = category;
    i += step;
  }

  return {
    score,
    avgScore: sampledCount > 0 ? score / sampledCount : 0,
    nonAsciiCount,
    replacementCount,
  };
}

function sanitizeAndCompact(segment: string, maxLength: number): string {
  const chars: string[] = [];
  for (let i = 0; i < segment.length; ) {
    const cp = segment.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const control = isUnexpectedC0Control(cp) || (cp >= 0x80 && cp <= 0x9f);
    chars.push(control ? "\uFFFD" : segment.slice(i, i + step));
    i += step;
  }
  const compact = chars.join("").replace(/\s+/g, " ").trim();
  const codePoints = Array.from(compact);
  if (codePoints.length > maxLength) {
    return `${codePoints.slice(0, Math.max(1, maxLength - 3)).join("")}...`;
  }
  return compact;
}

function formatPreviewLine(
  lineNumber: number,
  snippet: string,
  prefix?: string,
): string {
  const head = prefix ? `${prefix} L${lineNumber}: ` : `L${lineNumber}: `;
  return `${head}${snippet}`;
}

function emptyPreviewText(prefix?: string): string {
  return prefix ? `${prefix}: (empty text)` : "(empty text)";
}

function readNextLineSpan(text: string, offset: number): LineSpan {
  const len = text.length;
  let firstNonAscii = -1;
  let firstNonWs = -1;
  let i = offset;
  while (i < len) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) {
      const nextOffset =
        code === 0x0d && i + 1 < len && text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      return { start: offset, end: i, nextOffset, firstNonAscii, firstNonWs };
    }
    if (firstNonWs < 0 && code !== 0x20 && code !== 0x09) {
      firstNonWs = i;
    }
    if (firstNonAscii < 0 && code >= 0x80) {
      firstNonAscii = i;
    }
    i += 1;
  }
  return { start: offset, end: len, nextOffset: len, firstNonAscii, firstNonWs };
}

function formatSpanPreview(
  text: string,
  span: LineSpan,
  focusIndex: number,
  lineNumber: number,
  maxLength: number,
  prefix?: string,
): string {
  const clampedFocus = Math.max(span.start, Math.min(span.end, focusIndex));
  const contentStart = span.firstNonWs >= 0 ? span.firstNonWs : span.start;
  let sliceStart = contentStart;
  let leadingEllipsis = false;

  if (clampedFocus > contentStart && clampedFocus - contentStart > LINE_WINDOW_TRIGGER) {
    sliceStart = Math.max(contentStart, clampedFocus - LINE_WINDOW_LEAD);
    // Avoid starting in the middle of a surrogate pair.
    const startCode = text.charCodeAt(sliceStart);
    if (startCode >= 0xdc00 && startCode <= 0xdfff && sliceStart > contentStart) {
      sliceStart -= 1;
    }
    leadingEllipsis = sliceStart > contentStart;
  }

  let sliceEnd = Math.min(span.end, sliceStart + LINE_SLICE_LIMIT);
  if (sliceEnd > sliceStart && sliceEnd < span.end) {
    const endCode = text.charCodeAt(sliceEnd - 1);
    if (endCode >= 0xd800 && endCode <= 0xdbff) {
      sliceEnd -= 1;
    }
  }

  const raw = text.slice(sliceStart, sliceEnd);
  const snippet = sanitizeAndCompact(leadingEllipsis ? `...${raw}` : raw, maxLength);
  return formatPreviewLine(lineNumber, snippet || "(empty text)", prefix);
}

function findFirstLineDiffOffset(
  entries: ReadonlyArray<{ readonly text: string }>,
  spans: readonly LineSpan[],
): number {
  const baseText = entries[0]!.text;
  const baseSpan = spans[0]!;
  const baseLen = baseSpan.end - baseSpan.start;
  let earliestDiff = -1;

  for (let k = 1; k < entries.length; k += 1) {
    const text = entries[k]!.text;
    const span = spans[k]!;
    const len = span.end - span.start;
    const minLen = Math.min(baseLen, len);
    const scanLimit = earliestDiff >= 0 ? Math.min(minLen, earliestDiff) : minLen;
    let diff = -1;

    for (let j = 0; j < scanLimit; j += 1) {
      if (baseText.charCodeAt(baseSpan.start + j) !== text.charCodeAt(span.start + j)) {
        diff = j;
        break;
      }
    }
    if (diff < 0 && baseLen !== len) {
      const lenDiff = minLen;
      if (earliestDiff < 0 || lenDiff < earliestDiff) {
        diff = lenDiff;
      }
    }
    if (diff >= 0 && (earliestDiff < 0 || diff < earliestDiff)) {
      earliestDiff = diff;
      if (earliestDiff === 0) return 0;
    }
  }

  return earliestDiff;
}

export function extractNonAsciiPreview(
  text: string,
  options: CandidatePreviewOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_PREVIEW_LENGTH;
  const prefix = options.prefix;

  let offset = 0;
  let lineNumber = 1;
  let firstNonEmpty: { readonly lineNumber: number; readonly span: LineSpan } | undefined;

  while (offset < text.length) {
    const span = readNextLineSpan(text, offset);
    if (!firstNonEmpty && span.firstNonWs >= 0) {
      firstNonEmpty = { lineNumber, span };
    }
    if (span.firstNonAscii >= 0) {
      return formatSpanPreview(text, span, span.firstNonAscii, lineNumber, maxLength, prefix);
    }
    offset = span.nextOffset;
    lineNumber += 1;
  }

  if (firstNonEmpty) {
    return formatSpanPreview(
      text,
      firstNonEmpty.span,
      firstNonEmpty.span.firstNonWs,
      firstNonEmpty.lineNumber,
      maxLength,
      prefix,
    );
  }

  return emptyPreviewText(prefix);
}

function extractCandidatePreviews(
  entries: ReadonlyArray<{ readonly encoding: string; readonly text: string }>,
  options: CandidatePreviewOptions = {},
): string[] {
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    return [extractNonAsciiPreview(entries[0]!.text, options)];
  }

  const maxLength = options.maxLength ?? DEFAULT_MAX_PREVIEW_LENGTH;
  const prefix = options.prefix;
  const offsets = entries.map(() => 0);
  let lineNumber = 1;
  let firstNonAscii: { readonly lineNumber: number; readonly spans: readonly LineSpan[] } | undefined;
  let firstNonEmpty: { readonly lineNumber: number; readonly spans: readonly LineSpan[] } | undefined;

  while (entries.some((entry, idx) => offsets[idx]! < entry.text.length)) {
    const spans = entries.map((entry, idx) => {
      const offset = offsets[idx]!;
      if (offset >= entry.text.length) {
        return {
          start: entry.text.length,
          end: entry.text.length,
          nextOffset: entry.text.length,
          firstNonAscii: -1,
          firstNonWs: -1,
        };
      }
      const span = readNextLineSpan(entry.text, offset);
      offsets[idx] = span.nextOffset;
      return span;
    });

    if (!firstNonEmpty && spans.some((span) => span.firstNonWs >= 0)) {
      firstNonEmpty = { lineNumber, spans };
    }

    if (spans.some((span) => span.firstNonAscii >= 0)) {
      if (!firstNonAscii) {
        firstNonAscii = { lineNumber, spans };
      }
      const diffOffset = findFirstLineDiffOffset(entries, spans);
      if (diffOffset >= 0) {
        return entries.map((entry, idx) => {
          const span = spans[idx]!;
          const focusIndex = span.start + Math.min(diffOffset, span.end - span.start);
          return formatSpanPreview(entry.text, span, focusIndex, lineNumber, maxLength, prefix);
        });
      }
    }

    lineNumber += 1;
  }

  if (firstNonAscii) {
    return entries.map((entry, idx) => {
      const span = firstNonAscii.spans[idx]!;
      const focusIndex =
        span.firstNonAscii >= 0
          ? span.firstNonAscii
          : span.firstNonWs >= 0
            ? span.firstNonWs
            : span.start;
      return formatSpanPreview(
        entry.text,
        span,
        focusIndex,
        firstNonAscii.lineNumber,
        maxLength,
        prefix,
      );
    });
  }

  if (firstNonEmpty) {
    return entries.map((entry, idx) => {
      const span = firstNonEmpty.spans[idx]!;
      if (span.firstNonWs < 0) return emptyPreviewText(prefix);
      return formatSpanPreview(
        entry.text,
        span,
        span.firstNonWs,
        firstNonEmpty.lineNumber,
        maxLength,
        prefix,
      );
    });
  }

  return entries.map(() => emptyPreviewText(prefix));
}

export function rankDecodedCandidates(
  entries: ReadonlyArray<{ readonly encoding: string; readonly text: string }>,
  options: RankCandidatesOptions = {},
): RankedEncodingCandidate[] {
  const previews = extractCandidatePreviews(entries, {
    prefix: options.previewPrefix,
    maxLength: options.maxPreviewLength,
  });

  const scored = entries.map((entry, originalIndex) => {
    const { score, avgScore, nonAsciiCount, replacementCount } = scoreDecodedText(entry.text);
    return {
      encoding: entry.encoding,
      preview: previews[originalIndex]!,
      score,
      avgScore,
      nonAsciiCount,
      replacementCount,
      originalIndex,
    };
  });

  scored.sort((a, b) => {
    if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const top = scored[0];
  const second = scored[1];
  const topIsLikely =
    top !== undefined &&
    second !== undefined &&
    top.nonAsciiCount >= MIN_LIKELY_NON_ASCII &&
    top.replacementCount === 0 &&
    top.score > 0 &&
    top.avgScore - second.avgScore >= MIN_LIKELY_AVG_MARGIN &&
    top.score - second.score >= MIN_LIKELY_TOTAL_MARGIN;

  return scored.map((entry, index) => ({
    encoding: entry.encoding,
    preview: entry.preview,
    score: entry.score,
    avgScore: entry.avgScore,
    nonAsciiCount: entry.nonAsciiCount,
    likely: index === 0 && topIsLikely,
  }));
}
