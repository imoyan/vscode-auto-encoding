import assert from "node:assert/strict";
import test from "node:test";
import { minimatch } from "minimatch";
import { compileGlob, ConfigurationLimitError, MatchBudget, MAX_PATTERN_CHARACTERS, MAX_SETTING_ENTRIES } from "../src/boundedGlob.js";
import { sanitizeRules, findMatchingRule } from "../src/rules.js";
import { DEFAULT_SCAN_EXCLUDE } from "../src/fileLimits.js";

test("bounded evaluation preserves the existing glob dialect", () => {
  const patterns = ["**", "**/*", "**/*.txt", "a/**/b", "a/**", "{a,b}/**", "{1..4}.txt", "[ab]?.txt", "[a-z]", "+(a|b)", "[!ab]*", "[[:alpha:]]*", "a\\[b\\].txt", "\\!file", "!a/**", "#comment", "", "@(a|b).txt", "+(a|b).txt", "?(a|b).txt", "*(a|b).txt", "!(a|b).txt", "a!(b|c)*", "@(!(a)|b)", "a/**/**/b", "a//b", DEFAULT_SCAN_EXCLUDE];
  const paths = ["", "a", "b", "c", "a.txt", "b.txt", "aa.txt", "c.txt", "é.txt", "A.TXT", "1.txt", "4.txt", ".hidden", "a/.hidden", "a/b", "a/x/b", "a/x/y/b", "a//b", "a/b/", "a[b].txt", "!file", "node_modules/pkg/a.js", "src/a.txt", "src/\n", "a\n", "a\r", "a\u2028", "a\r\n"];
  for (const pattern of patterns) for (const nocase of [false, true]) {
    const bounded = compileGlob(pattern, nocase);
    for (const value of paths) assert.equal(bounded.match(value), minimatch(value, pattern, { dot: true, matchBase: false, nocase, windowsPathsNoEscape: false }), JSON.stringify({ pattern, value, nocase }));
  }
});

test("oversized arrays and expansions are rejected rather than truncated", () => {
  assert.throws(() => sanitizeRules(Array(MAX_SETTING_ENTRIES + 1).fill({ pattern: "**", encoding: "utf8" })), ConfigurationLimitError);
  assert.throws(() => compileGlob("x".repeat(MAX_PATTERN_CHARACTERS + 1)), ConfigurationLimitError);
  for (const pattern of ["{1..1000000000}", "{a,b}".repeat(20)]) assert.throws(() => compileGlob(pattern), ConfigurationLimitError);
  // Negative extglob complexity is bounded separately from pattern length.
  assert.throws(() => compileGlob("x" + "!(a)".repeat(100) + "y"), ConfigurationLimitError);
  assert.throws(() => sanitizeRules(Array(100).fill({ pattern: "{1..120}.txt", encoding: "utf8" })), ConfigurationLimitError);
});

test("literal rules count compiled characters without per-part compiler overhead", () => {
  const input = Array.from({ length: 205 }, (_, index) => ({
    pattern: "x".repeat(61) + String(index).padStart(3, "0"),
    encoding: "utf8",
  }));
  const rules = sanitizeRules(input);
  assert.equal(rules.length, input.length);
  assert.equal(findMatchingRule(rules, input.at(-1)!.pattern, false)?.index, input.length - 1);
});

test("rules that fail an ASCII or Unicode literal prefix check leave budget for the fallback rule", () => {
  for (const prefix of ["file-", "資料"]) {
    const earlier = Array.from({ length: 150 }, (_, index) => ({
      pattern: `${prefix}${String(index).padStart(3, "0")}[a-z]*.txt`,
      encoding: "shiftjis",
    }));
    const rules = sanitizeRules([...earlier, { pattern: "**/*.txt", encoding: "utf8" }]);
    for (const nocase of [false, true]) {
      assert.equal(findMatchingRule(rules, `${"x".repeat(80)}.txt`, nocase)?.index, earlier.length);
      assert.equal(findMatchingRule(rules, `${prefix}042a.txt`, nocase)?.index, 42);
    }
  }
  assert.equal(compileGlob("K[a-z].txt", true).match("Ka.txt"), true);
  assert.equal(compileGlob("É[a-z].txt", true).match("éa.txt"), true);
  assert.equal(compileGlob("É[a-z].txt").match("éa.txt"), false);
});

test("wildcards count Unicode code points and optional extglobs need a nonempty path part", () => {
  assert.equal(compileGlob("?.txt").match("😀.txt"), true);
  assert.equal(compileGlob("??.txt").match("😀.txt"), false);
  assert.equal(compileGlob("[😀].txt").match("😀.txt"), true);
  assert.equal(compileGlob("a/?(b)").match("a/"), false);
  assert.equal(compileGlob("a/**").match("a/"), true);
});

test("match work is explicit and shared across rules", () => {
  const pattern = compileGlob("+(a|aa)*b");
  assert.throws(() => pattern.match("a".repeat(128), new MatchBudget(200)), ConfigurationLimitError);
  assert.equal(compileGlob("legacy/**").match("legacy/file.txt"), true);
  assert.deepEqual(findMatchingRule([{ pattern: "legacy/special/**", encoding: "utf8" }, { pattern: "legacy/**", encoding: "shiftjis" }], "legacy/special/a.txt", false)?.index, 0);
});
