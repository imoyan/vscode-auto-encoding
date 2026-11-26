import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTO_DETECT_ENCODINGS,
  encodingInfo,
  findFileRegistration,
  findFolderRegistration,
  findMatchingRule,
  isReopenableEncoding,
  isSupportedEncoding,
  normalizeRelativePath,
  patternForFolder,
  patternForFile,
  sanitizeAutoDetectEncodings,
  sanitizeRules,
} from "../src/rules.js";

test("normalizes platform path separators", () => {
  assert.equal(normalizeRelativePath(".\\legacy\\src\\"), "legacy/src");
});

test("creates a recursive literal pattern for a selected folder", () => {
  assert.equal(patternForFolder("legacy/source"), "legacy/source/**");
  assert.equal(patternForFolder(""), "**");
  assert.equal(patternForFolder("legacy/[generated]"), "legacy/\\[generated\\]/**");
});

test("uses the first matching rule", () => {
  const rules = [
    { pattern: "legacy/special/**", encoding: "utf8" },
    { pattern: "legacy/**", encoding: "shiftjis" },
  ];
  assert.deepEqual(findMatchingRule(rules, "legacy/special/a.txt", false), {
    rule: rules[0],
    index: 0,
  });
  assert.deepEqual(findMatchingRule(rules, "legacy/other/a.txt", false), {
    rule: rules[1],
    index: 1,
  });
  assert.equal(findMatchingRule(rules, "src/a.txt", false), undefined);
});

test("can match case-insensitively on supported platforms", () => {
  const rules = [{ pattern: "Legacy/**", encoding: "shiftjis" }];
  assert.ok(findMatchingRule(rules, "legacy/a.txt", true));
  assert.equal(findMatchingRule(rules, "legacy/a.txt", false), undefined);
});

test("drops malformed configuration entries", () => {
  assert.deepEqual(
    sanitizeRules([
      { pattern: "legacy/**", encoding: "shiftjis" },
      { pattern: "", encoding: "utf8" },
      { pattern: "src/**" },
      { pattern: "src/**", encoding: "made-up" },
      null,
    ]),
    [{ pattern: "legacy/**", encoding: "shiftjis" }],
  );
});

test("single-file settings match only the literal selected filename and lookup exact file/folder registrations", () => {
  for (const name of ["legacy/[sample].txt", "!special.txt", "#note.txt"]) {
    const rules = [{ pattern: patternForFile(name), encoding: "utf8bom" }];
    assert.ok(findMatchingRule(rules, name));
    assert.ok(findFileRegistration(rules, name));
    assert.equal(findMatchingRule(rules, "other.txt"), undefined);
    assert.equal(findMatchingRule(rules, name + "/nested.txt"), undefined);
  }
  const folderRules = [{ pattern: patternForFolder("legacy/[src]"), encoding: "shiftjis" }];
  assert.equal(findFolderRegistration(folderRules, "legacy/[src]")?.encoding, "shiftjis");
  assert.equal(findFolderRegistration(folderRules, "legacy/other"), undefined);
});

test("supports East Asian rule encodings, keeps ISO-2022-JP source-only, and sanitizes autoDetectEncodings", () => {
  for (const id of ["gb18030", "big5hkscs", "euckr"]) {
    assert.equal(isSupportedEncoding(id), true);
    assert.equal(isReopenableEncoding(id), true);
  }
  assert.equal(isSupportedEncoding("iso2022jp"), false);
  assert.equal(isReopenableEncoding("iso2022jp"), false);
  assert.equal(encodingInfo("iso2022jp").label, "ISO-2022-JP (JIS)");

  assert.deepEqual(sanitizeAutoDetectEncodings(undefined), DEFAULT_AUTO_DETECT_ENCODINGS);
  assert.deepEqual(sanitizeAutoDetectEncodings([]), []);
  assert.deepEqual(
    sanitizeAutoDetectEncodings(["SHIFTJIS", "gb18030", "shiftjis", "invalid", "euckr", 42]),
    ["shiftjis", "gb18030", "euckr"],
  );
});
