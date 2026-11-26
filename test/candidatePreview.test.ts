import assert from "node:assert/strict";
import test from "node:test";
import {
  extractNonAsciiPreview,
  rankDecodedCandidates,
  scoreDecodedText,
} from "../src/candidatePreview.js";

test("extractNonAsciiPreview locates the first non-ASCII line with 1-based line number", () => {
  const text = [
    "// ASCII header line 1",
    "const x = 42;",
    "",
    "const msg = 'こんにちは世界';",
    "const next = '次の行';",
  ].join("\n");

  assert.equal(
    extractNonAsciiPreview(text),
    "L4: const msg = 'こんにちは世界';",
  );
  assert.equal(
    extractNonAsciiPreview(text, { prefix: "右側" }),
    "右側 L4: const msg = 'こんにちは世界';",
  );
});

test("extractNonAsciiPreview windows long lines around the first non-ASCII character and handles CRLF/CR", () => {
  const longPrefix = "a".repeat(60);
  const text = `first\r\n${longPrefix}日本語テキスト\rthird`;
  const preview = extractNonAsciiPreview(text);
  assert.match(preview, /^L2: \.\.\.a+日本語テキスト$/);

  const veryLongLine = `${"a".repeat(5000)}あいうえお`;
  assert.match(extractNonAsciiPreview(veryLongLine), /^L1: \.\.\.a{20}あいうえお$/);

  const longIndentedAscii = `${" ".repeat(600)}hello world`;
  assert.equal(extractNonAsciiPreview(longIndentedAscii), "L1: hello world");
});

test("extractNonAsciiPreview sanitizes C0 and C1 controls and falls back to first non-empty ASCII line", () => {
  assert.equal(
    extractNonAsciiPreview("line1\n\x80\x85abc"),
    "L2: \uFFFD\uFFFDabc",
  );
  assert.equal(
    extractNonAsciiPreview("\n  \n  hello world  \nsecond"),
    "L3: hello world",
  );
  assert.equal(extractNonAsciiPreview("   \n\t "), "(empty text)");
  assert.equal(extractNonAsciiPreview("", { prefix: "左側" }), "左側: (empty text)");
});

test("extractNonAsciiPreview does not split surrogate pairs when truncating", () => {
  const emoji = "😀".repeat(60);
  const preview = extractNonAsciiPreview(emoji, { maxLength: 20 });
  assert.equal(preview.endsWith("..."), true);
  assert.equal(preview.includes("\uFFFD"), false);
  // Ensure every UTF-16 code unit in the result is well-formed (no lone surrogates).
  assert.doesNotThrow(() => encodeURIComponent(preview));
});

test("rankDecodedCandidates ranks natural Japanese above halfwidth-katakana or control-char mojibake and marks likely", () => {
  const ranked = rankDecodedCandidates([
    { encoding: "shiftjis", text: "header\n､｢､､､ｦ､ｨ､ｪ" },
    { encoding: "eucjp", text: "header\nあいうえお" },
  ]);

  assert.equal(ranked[0]?.encoding, "eucjp");
  assert.equal(ranked[0]?.likely, true);
  assert.equal(ranked[0]?.preview, "L2: あいうえお");
  assert.equal(ranked[1]?.encoding, "shiftjis");
  assert.equal(ranked[1]?.likely, false);
  assert.equal(ranked[1]?.preview, "L2: ､｢､､､ｦ､ｨ､ｪ");
});

test("rankDecodedCandidates does not mark likely on a close tie or single non-ASCII character", () => {
  const tied = rankDecodedCandidates([
    { encoding: "shiftjis", text: "漢字" },
    { encoding: "eucjp", text: "文字" },
  ]);
  assert.equal(tied[0]?.encoding, "shiftjis");
  assert.equal(tied[0]?.likely, false);
  assert.equal(tied[1]?.likely, false);

  const singleChar = rankDecodedCandidates([
    { encoding: "shiftjis", text: "ア" },
    { encoding: "windows1252", text: "ƒA" },
  ]);
  assert.equal(singleChar[0]?.encoding, "shiftjis");
  assert.equal(singleChar[0]?.likely, false);
});

test("scoreDecodedText favors accented Latin letters surrounded by ASCII over C1 mojibake", () => {
  const western = scoreDecodedText("café naïve résumé");
  const mojibake = scoreDecodedText("\u0082\u00a0\u0082\u00a2\u0082\u00a4");
  assert.ok(western.score > 0);
  assert.ok(mojibake.score < 0);
  assert.ok(western.avgScore > mojibake.avgScore);
});

test("scoreDecodedText rewards CJK compatibility/extension kanji, common symbols, and Windows-1252 letters while penalizing PUA and C0 controls", () => {
  const cp932Compat = scoreDecodedText("﨑山①×¥100—テスト");
  const puaMojibake = scoreDecodedText("\uE000\uE001\uE002\uE003");
  assert.ok(cp932Compat.score > 0);
  assert.ok(cp932Compat.avgScore > 1.5);
  assert.ok(puaMojibake.score < 0);

  const win1252 = scoreDecodedText("Œuvre d’art — Škoda €50");
  assert.ok(win1252.score > 0);
  assert.ok(win1252.avgScore > 0.5);

  const c0Only = scoreDecodedText("abc\x01\x02\x03def");
  assert.ok(c0Only.score < 0);
  assert.equal(c0Only.avgScore, -8);

  const cjkExtB = scoreDecodedText("𠮟るテスト");
  assert.ok(cjkExtB.score > 0);
  assert.equal(cjkExtB.nonAsciiCount, 5);
});

test("scoreDecodedText and extractNonAsciiPreview scan past 128KB when non-ASCII appears late", () => {
  const latePrefix = `${"a".repeat(140_000)}\n`;
  const text = `${latePrefix}こんにちは世界`;
  const scored = scoreDecodedText(text);
  assert.equal(scored.nonAsciiCount, 7);
  assert.ok(scored.score > 0);
  assert.equal(extractNonAsciiPreview(text), "L2: こんにちは世界");
});

test("rankDecodedCandidates skips non-ASCII lines identical across candidates to show the first differing line", () => {
  const ranked = rankDecodedCandidates([
    { encoding: "shiftjis", text: "// © 2026\nconst msg = '､｢､､､ｦ､ｨ､ｪ';" },
    { encoding: "eucjp", text: "// © 2026\nconst msg = 'あいうえお';" },
  ]);

  assert.equal(ranked[0]?.encoding, "eucjp");
  assert.equal(ranked[0]?.likely, true);
  assert.equal(ranked[0]?.preview, "L2: const msg = 'あいうえお';");
  assert.equal(ranked[1]?.encoding, "shiftjis");
  assert.equal(ranked[1]?.preview, "L2: const msg = '､｢､､､ｦ､ｨ､ｪ';");
});

test("rankDecodedCandidates windows long lines around the first differing offset and falls back when all non-ASCII lines match", () => {
  const shared = `const s = '${"あ".repeat(50)}`;
  const ranked = rankDecodedCandidates([
    { encoding: "shiftjis", text: `${shared}､｢､､､ｦ';` },
    { encoding: "eucjp", text: `${shared}あいう';` },
  ]);
  assert.match(ranked[0]!.preview, /^L1: \.\.\.あ+あいう';$/);
  assert.match(ranked[1]!.preview, /^L1: \.\.\.あ+､｢､､､ｦ';$/);

  const identical = rankDecodedCandidates([
    { encoding: "shiftjis", text: "header\n© 2026" },
    { encoding: "eucjp", text: "header\n© 2026" },
  ]);
  assert.equal(identical[0]?.preview, "L2: © 2026");
  assert.equal(identical[1]?.preview, "L2: © 2026");
});

test("rankDecodedCandidates never marks a candidate containing U+FFFD as likely", () => {
  const ranked = rankDecodedCandidates([
    { encoding: "utf8", text: "あいうえおかきくけこ\uFFFD" },
    { encoding: "shiftjis", text: "\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a" },
  ]);
  assert.equal(ranked[0]?.encoding, "utf8");
  assert.equal(ranked[0]?.likely, false);
});
