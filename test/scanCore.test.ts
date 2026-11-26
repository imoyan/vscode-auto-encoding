import assert from "node:assert/strict";
import test from "node:test";
import { EncodingCodec } from "../src/conversionCore.js";
import {
  classifyEncoding,
  classifyConsistentLineEndings,
  classifyLineEndings,
  isExpectedEncodingForLineEndings,
  detectLineEndingChange,
  EncodingClassificationCancelledError,
} from "../src/scanCore.js";

const codec: EncodingCodec = {
  async decode(bytes, encoding) {
    if (encoding === "utf8" || encoding === "utf8bom") {
      const offset = encoding === "utf8bom" && bytes[0] === 0xef ? 3 : 0;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset));
    }
    if (encoding === "windows1252" || encoding === "iso88591") {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
    }
    if (encoding === "utf16le" || encoding === "utf16be") {
      return new TextDecoder("utf-16le", { fatal: true }).decode(
        encoding === "utf16le" ? bytes : swapBytePairs(bytes),
      );
    }
    throw new Error(`unsupported test encoding: ${encoding}`);
  },
  async encode(text, encoding) {
    if (encoding === "utf8") {
      return new TextEncoder().encode(text);
    }
    if (encoding === "utf8bom") {
      return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    }
    if (encoding === "windows1252" || encoding === "iso88591") {
      if (Array.from(text).some((character) => character.charCodeAt(0) > 0xff)) {
        throw new Error("not representable");
      }
      return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));
    }
    if (encoding === "utf16le" || encoding === "utf16be") {
      const bytes = Buffer.from(text, "utf16le");
      return encoding === "utf16le" ? bytes : swapBytePairs(bytes);
    }
    throw new Error(`unsupported test encoding: ${encoding}`);
  },
};

test("treats ASCII as compatible with an ASCII-superset rule", async () => {
  assert.deepEqual(
    await classifyEncoding(new TextEncoder().encode("plain text"), "shiftjis", codec),
    { kind: "ascii" },
  );
});

test("treats an empty file as encoding-neutral", async () => {
  assert.deepEqual(await classifyEncoding(new Uint8Array(), "utf16le", codec), {
    kind: "ascii",
  });
  assert.deepEqual(await classifyEncoding(new Uint8Array(), "utf8bom", codec), {
    kind: "ascii",
  });
});

test("does not call ASCII-looking bytes UTF-8 when UTF-16 is expected", async () => {
  assert.deepEqual(
    await classifyEncoding(Buffer.from("あい", "utf16le"), "utf16le", codec),
    { kind: "ambiguous", candidates: ["utf8", "utf16le"] },
  );
});

test("detects a short BOM-less UTF-16 file under a UTF-8 rule", async () => {
  assert.deepEqual(
    await classifyEncoding(Buffer.from("a\n", "utf16le"), "utf8", codec),
    { kind: "mismatch", detectedEncoding: "utf16le" },
  );
});

test("withholds line endings when ambiguous encodings disagree", () => {
  const bytes = new TextEncoder().encode("a\n");
  assert.equal(
    classifyConsistentLineEndings(
      bytes,
      { kind: "ambiguous", candidates: ["utf8", "utf16le"] },
      "utf16le",
    ),
    undefined,
  );
  assert.deepEqual(
    classifyConsistentLineEndings(
      new TextEncoder().encode("one line"),
      { kind: "ambiguous", candidates: ["utf8", "utf16le"] },
      "utf16le",
    ),
    { kind: "none", styles: [] },
  );
});

test("detects matching and mismatching UTF-8", async () => {
  const bytes = new TextEncoder().encode("日本語");
  assert.deepEqual(await classifyEncoding(bytes, "utf8", codec), {
    kind: "match",
    detectedEncoding: "utf8",
  });
  assert.deepEqual(await classifyEncoding(bytes, "shiftjis", codec), {
    kind: "mismatch",
    detectedEncoding: "utf8",
  });
});

test("uses a BOM as an explicit signal", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("日本語")]);
  assert.deepEqual(await classifyEncoding(bytes, "utf8bom", codec), {
    kind: "match",
    detectedEncoding: "utf8bom",
  });
  assert.deepEqual(await classifyEncoding(bytes, "utf8", codec), {
    kind: "mismatch",
    detectedEncoding: "utf8bom",
  });
});

test("reports a replacement character only when the saved bytes round-trip", async () => {
  const lenientCodec: EncodingCodec = {
    ...codec,
    async decode(bytes, encoding) {
      return encoding === "utf8" ? new TextDecoder().decode(bytes) : codec.decode(bytes, encoding);
    },
  };
  assert.deepEqual(await classifyEncoding(Buffer.from("文字\uFFFD"), "utf8", lenientCodec), {
    kind: "match", detectedEncoding: "utf8", replacementCharacterEncoding: "utf8",
  });
  assert.deepEqual(await classifyEncoding(Buffer.from([0xff, 0xfe, 0xfd, 0xff]), "utf8", lenientCodec), {
    kind: "mismatch", detectedEncoding: "utf16le", replacementCharacterEncoding: "utf16le",
  });
  assert.deepEqual(await classifyEncoding(Buffer.from([0x81]), "utf8", lenientCodec), {
    kind: "ambiguous", candidates: undefined,
  });
});

test("identifies the candidate containing a replacement character when encodings overlap", async () => {
  assert.deepEqual(await classifyEncoding(Buffer.from("あ\uFFFD"), "windows1252", codec), {
    kind: "ambiguous", candidates: ["utf8", "windows1252"], replacementCharacterEncoding: "utf8",
  });
});

test("only comparison display accepts CP932 aliases that decode without replacement", async () => {
  const alternate = Uint8Array.of(0x87, 0x90);
  const malformed = Uint8Array.of(0x87, 0x90, 0x81);
  const cp932Codec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "shiftjis") return new TextDecoder("shift_jis").decode(bytes);
      return codec.decode(bytes, encoding);
    },
    async encode(text, encoding) {
      if (encoding === "shiftjis") return text === "≒" ? Uint8Array.of(0x81, 0xe0) : Uint8Array.of(0x81, 0xe0, 0x3f);
      return codec.encode(text, encoding);
    },
  };
  assert.deepEqual(await classifyEncoding(alternate, "shiftjis", cp932Codec), {
    kind: "ambiguous", candidates: undefined,
  });
  assert.deepEqual(await classifyEncoding(alternate, "utf8", cp932Codec, { allowNonCanonicalShiftJis: true }), {
    kind: "mismatch", detectedEncoding: "shiftjis",
  });
  assert.deepEqual(await classifyEncoding(malformed, "shiftjis", cp932Codec, { allowNonCanonicalShiftJis: true }), {
    kind: "ambiguous", candidates: undefined,
  });
});

test("does not guess when UTF-8 and the expected single-byte encoding both round-trip", async () => {
  const bytes = new TextEncoder().encode("café");
  assert.deepEqual(await classifyEncoding(bytes, "windows1252", codec), {
    kind: "ambiguous",
    candidates: ["utf8", "windows1252"],
  });
});

test("does not guess when configured single-byte encodings overlap", async () => {
  const overlappingCodec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "utf8") {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (encoding === "shiftjis" || encoding === "windows1252") {
        return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
      }
      throw new Error(`unsupported test encoding: ${encoding}`);
    },
    async encode(text, encoding) {
      if (encoding === "utf8") {
        return new TextEncoder().encode(text);
      }
      if (encoding === "shiftjis" || encoding === "windows1252") {
        return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));
      }
      throw new Error(`unsupported test encoding: ${encoding}`);
    },
  };
  assert.deepEqual(
    await classifyEncoding(
      new Uint8Array([0xa6]),
      "shiftjis",
      overlappingCodec,
      { alternativeEncodings: ["shiftjis", "windows1252"] },
    ),
    {
      kind: "ambiguous",
      candidates: ["shiftjis", "windows1252"],
    },
  );
});

test("stops encoding probes after cancellation", async () => {
  let cancelled = false;
  const probed: string[] = [];
  const cancellingCodec: EncodingCodec = {
    async decode(_bytes, encoding) {
      probed.push(encoding);
      await Promise.resolve();
      cancelled = true;
      throw new Error("invalid encoding");
    },
    async encode() {
      throw new Error("encode must not run");
    },
  };

  await assert.rejects(
    classifyEncoding(
      new Uint8Array([0x80]),
      "shiftjis",
      cancellingCodec,
      {
        alternativeEncodings: ["windows1252"],
        isCancellationRequested: () => cancelled,
      },
    ),
    EncodingClassificationCancelledError,
  );
  assert.deepEqual(probed, ["utf8"]);
});

test("recognizes LF, CRLF, CR, and files without line endings", () => {
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\nb\n")), {
    kind: "lf",
    styles: ["lf"],
  });
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\r\nb\r\n")), {
    kind: "crlf",
    styles: ["crlf"],
  });
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\rb\r")), {
    kind: "cr",
    styles: ["cr"],
  });
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("one line")), {
    kind: "none",
    styles: [],
  });
});

test("reports mixed line endings without double-counting CRLF", () => {
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\r\nb\nc\r")), {
    kind: "mixed",
    styles: ["lf", "crlf", "cr"],
  });
});

test("recognizes UTF-16 line endings", () => {
  const utf16le = new Uint8Array([0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0, 0x62, 0]);
  assert.deepEqual(classifyLineEndings(utf16le), {
    kind: "crlf",
    styles: ["crlf"],
  });
});

test("verifies the encoding before interpreting HEAD line endings", async () => {
  assert.equal(
    await isExpectedEncodingForLineEndings(
      new Uint8Array([0xc3, 0xa9, 0x0a]),
      "windows1252",
      codec,
    ),
    true,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      Buffer.from("a\n", "utf16le"),
      "utf16le",
      codec,
    ),
    true,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      Buffer.from("「日本語」\n", "utf16le"),
      "utf16le",
      codec,
    ),
    true,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      new TextEncoder().encode("a\nb\n"),
      "utf16le",
      codec,
    ),
    false,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      Buffer.from("あい", "utf16le"),
      "utf16le",
      codec,
    ),
    true,
  );
});

function swapBytePairs(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("odd UTF-16 byte length");
  }
  const swapped = Uint8Array.from(bytes);
  for (let index = 0; index < swapped.length; index += 2) {
    [swapped[index], swapped[index + 1]] = [swapped[index + 1]!, swapped[index]!];
  }
  return swapped;
}

test("detects line ending changes only after a baseline exists", () => {
  const lf = { kind: "lf", styles: ["lf"] } as const;
  assert.equal(detectLineEndingChange(undefined, lf), undefined);
  assert.equal(detectLineEndingChange(lf, lf), undefined);
  assert.deepEqual(detectLineEndingChange({ kind: "crlf", styles: ["crlf"] }, lf), {
    from: "crlf",
    to: "lf",
    fromStyles: ["crlf"],
    toStyles: ["lf"],
  });
  assert.deepEqual(
    detectLineEndingChange(
      { kind: "mixed", styles: ["lf", "crlf"] },
      { kind: "mixed", styles: ["lf", "cr"] },
    ),
    {
      from: "mixed",
      to: "mixed",
      fromStyles: ["lf", "crlf"],
      toStyles: ["lf", "cr"],
    },
  );
  assert.equal(
    detectLineEndingChange(
      { kind: "mixed" },
      { kind: "mixed", styles: ["lf", "cr"] },
    ),
    undefined,
  );
});

test("does not invent UTF-16 alternatives for Japanese legacy bytes", async () => {
  const bytes = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
  const legacyCodec: EncodingCodec = {
    decode: async (data, encoding) => encoding === "shiftjis" ? "日本語" : codec.decode(data, encoding),
    encode: async (text, encoding) => encoding === "shiftjis" ? bytes : codec.encode(text, encoding),
  };
  assert.deepEqual(await classifyEncoding(bytes, "shiftjis", legacyCodec, { alternativeEncodings: ["utf16le", "utf16be"] }),
    { kind: "match", detectedEncoding: "shiftjis" });
});
test("skips ASCII control streams and withholds their line endings", async () => {
  const bytes = new Uint8Array([1, 2, 3, 10]);
  const result = await classifyEncoding(bytes, "utf8", codec);
  assert.equal(result.kind, "skip");
  assert.equal(classifyConsistentLineEndings(bytes, result, "utf8"), undefined);
});

test("detects ISO-2022-JP escape sequences and ignores ANSI color escape sequences", async () => {
  const jisBytes = Uint8Array.from([
    0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42, 0x0a,
  ]); // "日本語\n"
  assert.deepEqual(await classifyEncoding(jisBytes, "utf8", codec), {
    kind: "mismatch",
    detectedEncoding: "iso2022jp",
  });
  const ansiColor = new TextEncoder().encode("\x1b[31merror\x1b[0m\n");
  assert.notEqual((await classifyEncoding(ansiColor, "utf8", codec)).detectedEncoding, "iso2022jp");
});

test("detects Windows-1252 uniquely via 0x80-0x9F and reports Windows-1252/ISO-8859-1 candidates for 0xA0-0xFF", async () => {
  const westernCodec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "windows1252") return new TextDecoder("windows-1252", { fatal: true }).decode(bytes);
      if (encoding === "iso88591") return String.fromCharCode(...bytes);
      return codec.decode(bytes, encoding);
    },
    async encode(text, encoding) {
      if (encoding === "windows1252") {
        return Uint8Array.from(text, (ch) => (ch === "€" ? 0x80 : ch.charCodeAt(0)));
      }
      if (encoding === "iso88591") {
        return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
      }
      return codec.encode(text, encoding);
    },
  };
  const euro = Uint8Array.from([0x50, 0x72, 0x69, 0x63, 0x65, 0x3a, 0x20, 0x80, 0x31, 0x30]); // "Price: €10"
  assert.deepEqual(await classifyEncoding(euro, "utf8", westernCodec), {
    kind: "mismatch",
    detectedEncoding: "windows1252",
  });
  const cafe = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n"
  assert.deepEqual(await classifyEncoding(cafe, "utf8", westernCodec), {
    kind: "ambiguous",
    candidates: ["windows1252", "iso88591"],
  });
  const undefinedByte = Uint8Array.from([0x63, 0x61, 0x66, 0x81, 0x0a]);
  assert.deepEqual(await classifyEncoding(undefinedByte, "utf8", westernCodec), {
    kind: "ambiguous",
    candidates: undefined,
  });
});

test("detects Japanese BOM-less UTF-16LE and UTF-16BE with low or zero NULL bytes", async () => {
  const utf16Codec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "utf16le") return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
      if (encoding === "utf16be") return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
      return codec.decode(bytes, encoding);
    },
    async encode(text, encoding) {
      if (encoding === "utf16le" || encoding === "utf16be") {
        const out = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i += 1) {
          const code = text.charCodeAt(i);
          out[i * 2] = encoding === "utf16le" ? code & 0xff : (code >> 8) & 0xff;
          out[i * 2 + 1] = encoding === "utf16le" ? (code >> 8) & 0xff : code & 0xff;
        }
        return out;
      }
      return codec.encode(text, encoding);
    },
  };
  const sample = "日本語のテスト文章です";
  const leBytes = await utf16Codec.encode(sample, "utf16le");
  const beBytes = await utf16Codec.encode(sample, "utf16be");
  assert.deepEqual(await classifyEncoding(leBytes, "utf8", utf16Codec), {
    kind: "mismatch",
    detectedEncoding: "utf16le",
  });
  assert.deepEqual(await classifyEncoding(beBytes, "utf8", utf16Codec), {
    kind: "mismatch",
    detectedEncoding: "utf16be",
  });

  // Large (>8 KiB) non-UTF-16 buffer should be rejected during 8 KiB pre-screening without probing UTF-16.
  const probedUtf16: string[] = [];
  const trackingCodec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "utf16le" || encoding === "utf16be") probedUtf16.push(encoding);
      return utf16Codec.decode(bytes, encoding);
    },
    async encode(text, encoding) {
      return utf16Codec.encode(text, encoding);
    },
  };
  const largeNonUtf16 = new Uint8Array(10_000).fill(0x81);
  assert.deepEqual(await classifyEncoding(largeNonUtf16, "utf8", trackingCodec), {
    kind: "ambiguous",
    candidates: undefined,
  });
  assert.deepEqual(probedUtf16, []);

  // Large (>8 KiB) Japanese BOM-less UTF-16LE with a surrogate pair straddling byte 8192.
  const largeSample = "あ".repeat(4095) + "𠮷" + "日本語テスト";
  const largeLe = await utf16Codec.encode(largeSample, "utf16le");
  assert.deepEqual(await classifyEncoding(largeLe, "utf8", utf16Codec), {
    kind: "mismatch",
    detectedEncoding: "utf16le",
  });
});

test("supports opt-in East Asian autoDetectEncodings without affecting default Japanese detection", async () => {
  const euckrBytes = Uint8Array.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]); // "안녕하세요"
  const eastAsiaCodec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "euckr") return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
      return codec.decode(bytes, encoding);
    },
    async encode(text, encoding) {
      if (encoding === "euckr" && text === "안녕하세요") return euckrBytes;
      return codec.encode(text, encoding);
    },
  };
  assert.deepEqual(
    await classifyEncoding(euckrBytes, "utf8", eastAsiaCodec, {
      alternativeEncodings: ["euckr"],
    }),
    {
      kind: "mismatch",
      detectedEncoding: "euckr",
    },
  );
});
