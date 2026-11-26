import { escape } from "minimatch";
import {
  compileGlob,
  ConfigurationLimitError,
  MatchBudget,
  MAX_PATH_CHARACTERS,
  MAX_PATTERN_CHARACTERS,
  MAX_SETTING_CHARACTERS,
  MAX_SETTING_ENTRIES,
} from "./boundedGlob.js";

export interface EncodingRule {
  readonly pattern: string;
  readonly encoding: string;
}

export interface MatchedRule {
  readonly rule: EncodingRule;
  readonly index: number;
}

const compiledRules = new WeakMap<
  EncodingRule,
  {
    pattern: string;
    sensitive: ReturnType<typeof compileGlob>;
    insensitive: ReturnType<typeof compileGlob>;
  }
>();

export const ISO2022JP_ENCODING = "iso2022jp" as const;

export const ENCODINGS = [
  { id: "utf8", label: "UTF-8", badge: "U8" },
  { id: "utf8bom", label: "UTF-8 with BOM", badge: "UB" },
  { id: "shiftjis", label: "Shift JIS / CP932", badge: "SJ" },
  { id: "eucjp", label: "EUC-JP", badge: "EJ" },
  { id: "gb18030", label: "GB18030", badge: "GB" },
  { id: "big5hkscs", label: "Big5 (HKSCS)", badge: "B5" },
  { id: "euckr", label: "EUC-KR", badge: "KR" },
  { id: "windows1252", label: "Windows-1252", badge: "W2" },
  { id: "iso88591", label: "ISO-8859-1", badge: "L1" },
  { id: "utf16le", label: "UTF-16 LE", badge: "16" },
  { id: "utf16be", label: "UTF-16 BE", badge: "16" },
] as const;

export const SOURCE_ONLY_ENCODINGS = [
  { id: ISO2022JP_ENCODING, label: "ISO-2022-JP (JIS)", badge: "JI" },
] as const;

export const AUTO_DETECT_ENCODING_IDS = [
  "shiftjis",
  "eucjp",
  "gb18030",
  "big5hkscs",
  "euckr",
  "windows1252",
  "iso88591",
] as const;

export const DEFAULT_AUTO_DETECT_ENCODINGS: readonly string[] = ["shiftjis", "eucjp"];

const AUTO_DETECT_ENCODING_SET = new Set<string>(AUTO_DETECT_ENCODING_IDS);
const LEGACY_MULTIBYTE_ENCODING_SET = new Set<string>([
  "shiftjis",
  "eucjp",
  "gb18030",
  "big5hkscs",
  "euckr",
]);

/** Returns whether an encoding is a non-UTF-8 legacy multibyte encoding. */
export function isLegacyMultibyteEncoding(encoding: string): boolean {
  return LEGACY_MULTIBYTE_ENCODING_SET.has(encoding.toLowerCase());
}

/** Returns whether VS Code can reopen and save files in the given encoding. */
export function isReopenableEncoding(encoding: string): boolean {
  return encoding.toLowerCase() !== ISO2022JP_ENCODING;
}

/** Validates and normalizes `autoEncoding.autoDetectEncodings`. */
export function sanitizeAutoDetectEncodings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_AUTO_DETECT_ENCODINGS;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.toLowerCase();
    if (!AUTO_DETECT_ENCODING_SET.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function isSupportedEncoding(encoding: string): boolean {
  return ENCODINGS.some((candidate) => candidate.id === encoding);
}

export function isEncodingRule(value: unknown): value is EncodingRule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pattern === "string" &&
    candidate.pattern.length > 0 &&
    typeof candidate.encoding === "string" &&
    isSupportedEncoding(candidate.encoding)
  );
}

export function sanitizeRules(value: unknown): EncodingRule[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SETTING_ENTRIES) throw new ConfigurationLimitError();
  let characters = 0;
  const rules: EncodingRule[] = [];
  for (const entry of value) {
    if (!isEncodingRule(entry)) continue;
    characters += entry.pattern.length;
    if (entry.pattern.length > MAX_PATTERN_CHARACTERS || characters > MAX_SETTING_CHARACTERS) {
      throw new ConfigurationLimitError();
    }
    rules.push({ pattern: entry.pattern, encoding: entry.encoding });
  }
  // Precompile both platform modes once, with a budget for the entire setting.
  let compiledCharacters = 0;
  for (const rule of rules) {
    const sensitive = compileGlob(rule.pattern, false);
    const insensitive = compileGlob(rule.pattern, true);
    compiledCharacters += sensitive.characters + insensitive.characters;
    if (compiledCharacters > MAX_SETTING_CHARACTERS) throw new ConfigurationLimitError();
    compiledRules.set(rule, { pattern: rule.pattern, sensitive, insensitive });
  }
  return rules;
}

export function normalizeRelativePath(relativePath: string): string {
  if (relativePath.length > MAX_PATH_CHARACTERS) throw new ConfigurationLimitError();
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function patternForFile(relativePath: string): string {
  return escape(normalizeRelativePath(relativePath)).replace(/^([!#])/, "\\$1");
}

export function patternForFolder(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.length === 0 ? "**" : `${patternForFile(normalized)}/**`;
}

export function findFileRegistration(
  rules: readonly EncodingRule[],
  relativePath: string,
  nocase = process.platform !== "linux",
): EncodingRule | undefined {
  const pattern = patternForFile(relativePath);
  const expected = nocase ? pattern.toLowerCase() : pattern;
  return rules.find((rule) => (nocase ? rule.pattern.toLowerCase() : rule.pattern) === expected);
}

export function findFolderRegistration(
  rules: readonly EncodingRule[],
  relativePath: string,
  nocase = process.platform !== "linux",
): EncodingRule | undefined {
  const pattern = patternForFolder(relativePath);
  const expected = nocase ? pattern.toLowerCase() : pattern;
  return rules.find((rule) => (nocase ? rule.pattern.toLowerCase() : rule.pattern) === expected);
}

export function findMatchingRule(
  rules: readonly EncodingRule[],
  relativePath: string,
  nocase = process.platform !== "linux",
): MatchedRule | undefined {
  const normalized = normalizeRelativePath(relativePath);
  if (rules.length > MAX_SETTING_ENTRIES) throw new ConfigurationLimitError();
  const budget = new MatchBudget();
  const index = rules.findIndex((rule) => {
    const cached = compiledRules.get(rule);
    const matcher =
      cached?.pattern === rule.pattern
        ? nocase
          ? cached.insensitive
          : cached.sensitive
        : compileGlob(rule.pattern, nocase);
    return matcher.match(normalized, budget);
  });
  return index === -1 ? undefined : { rule: rules[index]!, index };
}

export function encodingInfo(encoding: string): {
  readonly id: string;
  readonly label: string;
  readonly badge: string;
} {
  const normalized = encoding.toLowerCase();
  return (
    ENCODINGS.find((candidate) => candidate.id === normalized) ??
    SOURCE_ONLY_ENCODINGS.find((candidate) => candidate.id === normalized) ?? {
      id: encoding,
      label: encoding,
      badge: "?",
    }
  );
}
