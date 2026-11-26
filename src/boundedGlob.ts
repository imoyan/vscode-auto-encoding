import { braceExpand, GLOBSTAR, Minimatch } from "minimatch";

export const MAX_SETTING_ENTRIES = 256;
export const MAX_SETTING_CHARACTERS = 32_768;
export const MAX_PATTERN_CHARACTERS = 512;
export const MAX_PATH_CHARACTERS = 4096;
const MAX_EXPANSIONS = 128;
const MAX_COMPILED_CHARACTERS = 16_384;
const MAX_MATCH_WORK = 100_000;

export class ConfigurationLimitError extends Error {
  public constructor() {
    super("Auto Encoding settings or path exceeded the evaluation limit. Reduce the number, length, or glob complexity of your rules.");
    this.name = "ConfigurationLimitError";
  }
}

export class MatchBudget {
  public constructor(private remaining = MAX_MATCH_WORK) {}
  public spend(amount = 1): void {
    this.remaining -= amount;
    if (this.remaining < 0) throw new ConfigurationLimitError();
  }
}

export interface BoundedGlob { readonly characters: number; match(value: string, budget?: MatchBudget): boolean }
const cache = new Map<string, BoundedGlob>();

export function clearGlobCache(): void { cache.clear(); }

function boundCompilation(patterns: readonly string[]): number {
  let work = 0;
  let characters = 0;
  for (const pattern of patterns) for (const part of pattern.split("/")) {
    // Keep the existing complexity limit for patterns with negative extglobs,
    // in addition to the limits on pattern length and brace expansion.
    let growth = 1;
    let escaped = false;
    let inClass = false;
    for (let index = 0; index < part.length; index++) {
      const character = part[index];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "[") { inClass = true; continue; }
      if (character === "]") { inClass = false; continue; }
      if (!inClass && character === "!" && part[index + 1] === "(") {
        growth *= 2;
        if (growth > MAX_COMPILED_CHARACTERS) throw new ConfigurationLimitError();
      }
    }
    work += (part.length + 16) * growth;
    if (work > MAX_COMPILED_CHARACTERS) throw new ConfigurationLimitError();
    characters += part.length * growth;
  }
  return characters;
}

// Letters, marks and numbers are literal outside glob syntax. Use the
// matcher's Unicode case folding for case-insensitive prefixes.
function literalPrefix(pattern: string, nocase: boolean): { literal: string; folded?: RegExp } {
  const literal = /^[\p{L}\p{M}\p{N}_.-]*/u.exec(pattern)![0];
  return {
    literal,
    folded: nocase && literal ? new RegExp(`^${literal.replaceAll(".", "\\.")}`, "iu") : undefined,
  };
}

export function compileGlob(pattern: unknown, nocase = false): BoundedGlob {
  if (typeof pattern !== "string" || pattern.length > MAX_PATTERN_CHARACTERS) throw new ConfigurationLimitError();
  const key = JSON.stringify([pattern, nocase]);
  const cached = cache.get(key);
  if (cached) return cached;
  // Expansion uses max+1 so an over-limit input is rejected, never truncated.
  const expanded = braceExpand(pattern, { braceExpandMax: MAX_EXPANSIONS + 1 });
  if (expanded.length > MAX_EXPANSIONS) throw new ConfigurationLimitError();
  const characters = boundCompilation(expanded);
  const matcher = new Minimatch(pattern, { dot: true, matchBase: false, nocase, windowsPathsNoEscape: false, braceExpandMax: MAX_EXPANSIONS + 1 });
  const sets = matcher.set.map((parts) => parts.map((part) => {
    if (typeof part === "string" || part === GLOBSTAR) return part;
    return { matcher: part, prefix: literalPrefix(part.pattern, part.options.nocase ?? false) };
  }));
  const result: BoundedGlob = {
    // Count the pre-optimization expansion, so merging equivalent rows in
    // Minimatch does not bypass the total configuration complexity limit.
    characters,
    match(value, budget = new MatchBudget()) {
      if (value.length > MAX_PATH_CHARACTERS) throw new ConfigurationLimitError();
      if (matcher.comment) return false;
      if (matcher.empty) return value === "";
      const normalized = matcher.isWindows ? value.replaceAll("\\", "/") : value;
      const file = normalized.split(/\/+/);
      // Preserve the two leading separators of Windows UNC paths.
      if (matcher.isWindows && /^\/\/[^/]+/.test(normalized)) file.unshift("");
      for (const parts of sets) {
        const memo = new Map<string, boolean>();
        const match = (fi: number, pi: number): boolean => {
          budget.spend();
          const key = `${fi}:${pi}`;
          if (memo.has(key)) return memo.get(key)!;
          const part = parts[pi];
          let hit = false;
          if (part === undefined) hit = fi === file.length || (fi === file.length - 1 && file[fi] === "");
          else if (part === GLOBSTAR) {
            if (pi === parts.length - 1) hit = fi < file.length && file.slice(fi).every((segment) => { budget.spend(); return segment !== "." && segment !== ".."; });
            else {
              hit = match(fi, pi + 1);
              if (!hit && fi < file.length && file[fi] !== "." && file[fi] !== "..") hit = match(fi + 1, pi);
            }
          } else if (fi < file.length) {
            const segment = file[fi]!;
            if (typeof part === "string") {
              budget.spend(part.length);
              hit = part === segment;
            } else if (segment !== "") {
              const { literal, folded } = part.prefix;
              budget.spend(literal.length);
              const matchesPrefix = folded ? folded.test(segment) : segment.startsWith(literal);
              if (matchesPrefix) {
                // Reserve work for the library's per-segment state-machine evaluation.
                budget.spend((part.matcher.pattern.length + 1) * (segment.length + 1));
                hit = part.matcher.testUnchecked(segment);
              }
            }
            if (hit) hit = match(fi + 1, pi + 1);
          }
          memo.set(key, hit);
          return hit;
        };
        if (match(0, 0)) return !matcher.negate;
      }
      return matcher.negate;
    },
  };
  if (cache.size >= MAX_SETTING_ENTRIES * 2) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
