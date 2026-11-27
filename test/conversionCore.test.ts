import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesEqual,
  conversionBackupReadLimit,
  conversionBackupDisposition,
  conversionSelectionBackupBytes,
  EncodingCodec,
  ConversionOperationGate,
  ConversionTargetWriteError,
  looksLikeBinary,
  prepareEncodingConversion,
  assessEncodingConversion,
  protectedConversionSession,
  validStoredConversionSizes,
  writeConversionIfCurrent,
} from "../src/conversionCore.js";

const codec: EncodingCodec = {
  async decode(bytes, encoding) {
    if (encoding === "latin1") {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
    }
    if (encoding === "ascii") {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  },
  async encode(text, encoding) {
    if (encoding === "latin1") {
      return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0) & 0xff));
    }
    if (encoding === "ascii") {
      return new Uint8Array(
        Array.from(text, (character) => {
          const code = character.charCodeAt(0);
          return code <= 0x7f ? code : 0x3f;
        }),
      );
    }
    return new TextEncoder().encode(text);
  },
};

test("line-ending-only conversion preserves the source encoding and text", async () => {
  const original = await codec.encode("café\r\nx\ry\n", "latin1");
  const result = await prepareEncodingConversion(original, "latin1", "latin1", codec, undefined, "lf");
  assert.deepEqual(result?.converted, await codec.encode("café\nx\ny\n", "latin1"));
});

test("combined conversion normalizes CRLF once and preserves no final newline", async () => {
  const original = await codec.encode("café\r\nx\ry\nz", "latin1");
  const result = await prepareEncodingConversion(original, "latin1", "utf8", codec, undefined, "crlf");
  assert.deepEqual(result?.converted, await codec.encode("café\r\nx\r\ny\r\nz", "utf8"));
});

test("encoding-only conversion preserves intentional mixed line endings", async () => {
  const original = await codec.encode("café\r\nx\ry\n", "latin1");
  const result = await prepareEncodingConversion(original, "latin1", "utf8", codec);
  assert.equal(await codec.decode(result!.converted, "utf8"), "café\r\nx\ry\n");
});

test("line ending conversion skips unchanged bytes, binary and lossy targets", async () => {
  for (const content of ["a\n", "a", "a\0\r\n"]) {
    assert.equal(await prepareEncodingConversion(await codec.encode(content, "utf8"), "utf8", "utf8", codec, undefined, "lf"), undefined);
  }
  assert.equal(await prepareEncodingConversion(await codec.encode("café\r\n", "utf8"), "utf8", "ascii", codec, undefined, "lf"), undefined);
});

test("compares byte arrays without coercion", () => {
  assert.equal(bytesEqual(new Uint8Array([0, 1, 255]), new Uint8Array([0, 1, 255])), true);
  assert.equal(bytesEqual(new Uint8Array([0, 1]), new Uint8Array([0, 2])), false);
  assert.equal(bytesEqual(new Uint8Array([0, 1]), new Uint8Array([0, 1, 2])), false);
});

test("distinguishes text from likely binary content", () => {
  assert.equal(looksLikeBinary("日本語のテキスト\r\nsecond line\tvalue"), false);
  assert.equal(looksLikeBinary("abc\0def"), true);
  assert.equal(looksLikeBinary(`abc${String.fromCharCode(1, 2, 3)}def`), true);
});

test("prepares a reversible conversion", async () => {
  const result = await prepareEncodingConversion(
    new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    "latin1",
    "utf8",
    codec,
  );
  assert.equal(result?.text, "café");
  assert.deepEqual(result?.converted, new TextEncoder().encode("café"));
});

test("rejects content that the target cannot represent", async () => {
  const result = await prepareEncodingConversion(
    new TextEncoder().encode("日本語"),
    "utf8",
    "ascii",
    codec,
  );
  assert.equal(result, undefined);
});

test("skips binary and byte-identical conversions", async () => {
  assert.equal(
    await prepareEncodingConversion(new TextEncoder().encode("same"), "utf8", "utf8", codec),
    undefined,
  );
  assert.equal(
    await prepareEncodingConversion(new Uint8Array([0x61, 0, 0x62]), "latin1", "utf8", codec),
    undefined,
  );
});

test("stops a conversion after cancellation", async () => {
  let cancelled = false;
  let decodeCount = 0;
  const cancellingCodec: EncodingCodec = {
    async decode() {
      decodeCount += 1;
      cancelled = true;
      return "text";
    },
    async encode() {
      throw new Error("encode must not run");
    },
  };

  assert.equal(
    await prepareEncodingConversion(
      new TextEncoder().encode("text"),
      "utf8",
      "utf16le",
      cancellingCodec,
      () => cancelled,
    ),
    undefined,
  );
  assert.equal(decodeCount, 1);
});

test("keeps undo readable when conversion changes the file size", () => {
  assert.equal(conversionBackupReadLimit(20, 10), 20);
  assert.equal(conversionBackupReadLimit(10, 20), 20);
});

test("bounds the total conversion backup before writing", () => {
  assert.equal(conversionSelectionBackupBytes([20, 30], 50), 50);
  assert.equal(conversionSelectionBackupBytes([20, 31], 50), undefined);
  assert.equal(conversionSelectionBackupBytes([Number.MAX_SAFE_INTEGER, 1]), undefined);
  assert.equal(conversionSelectionBackupBytes([-1], 50), undefined);
});

test("rejects stored conversion sizes that can bypass undo limits", () => {
  assert.equal(validStoredConversionSizes(undefined, undefined), false);
  assert.equal(validStoredConversionSizes(100 * 1024 * 1024, 320 * 1024 * 1024), true);
  assert.equal(validStoredConversionSizes(100 * 1024 * 1024 + 1, 1), false);
  assert.equal(validStoredConversionSizes(1, 320 * 1024 * 1024 + 1), false);
  assert.equal(validStoredConversionSizes(1, undefined), false);
});

test("does not write a changed target while preparing its backup", async () => {
  const events: string[] = [];
  let current = true;
  const written = await writeConversionIfCurrent({
    writeBackup: async () => {
      events.push("backup");
      current = false;
    },
    writeRecord: async () => {
      events.push("record");
    },
    isCurrent: async () => current,
    registerBackup: async () => {
      events.push("register");
    },
    markTargetStarted: async () => {
      events.push("started");
    },
    writeTarget: async () => {
      events.push("target");
    },
    markTargetCompleted: async () => {
      events.push("completed");
    },
    recoverTarget: async () => {
      events.push("recover");
    },
    cleanupBackup: async () => {
      events.push("cleanup");
    },
  });

  assert.equal(written, false);
  assert.deepEqual(events, ["backup", "cleanup"]);
});

test("does not write a target that changes while recording its backup", async () => {
  const events: string[] = [];
  let checks = 0;
  const written = await writeConversionIfCurrent({
    writeBackup: async () => {
      events.push("backup");
    },
    writeRecord: async () => {
      events.push("record");
    },
    isCurrent: async () => {
      checks += 1;
      return checks === 1;
    },
    registerBackup: async () => {
      events.push("register");
    },
    writeTarget: async () => {
      events.push("target");
    },
    recoverTarget: async () => {
      events.push("recover");
    },
    cleanupBackup: async () => {
      events.push("cleanup");
    },
  });

  assert.equal(written, false);
  assert.deepEqual(events, ["backup", "record", "cleanup"]);
});

test("registers a backup before writing the target", async () => {
  const events: string[] = [];
  const written = await writeConversionIfCurrent({
    writeBackup: async () => {
      events.push("backup");
    },
    writeRecord: async () => {
      events.push("record");
    },
    isCurrent: async () => true,
    registerBackup: async () => {
      events.push("register");
    },
    markTargetStarted: async () => {
      events.push("started");
    },
    writeTarget: async () => {
      events.push("target");
    },
    markTargetCompleted: async () => {
      events.push("completed");
    },
    recoverTarget: async () => {
      events.push("recover");
    },
    cleanupBackup: async () => {
      events.push("cleanup");
    },
  });

  assert.equal(written, true);
  assert.deepEqual(events, [
    "backup",
    "record",
    "register",
    "started",
    "target",
    "completed",
  ]);
});

test("a writer declining changed authorization cleans up without recovery", async () => {
  for (const failCompletion of [false, true]) {
    const events: string[] = [];
    const operation = writeConversionIfCurrent({
      writeBackup: async () => { events.push("backup"); },
      writeRecord: async () => { events.push("record"); },
      registerBackup: async () => { events.push("register"); },
      isCurrent: async () => true,
      writeTarget: async () => { events.push("declined"); return false; },
      markTargetCompleted: async () => {
        events.push("completed");
        if (failCompletion && events.filter(event => event === "completed").length === 1) throw new Error("record unavailable");
      },
      recoverTarget: async () => { events.push("recover"); },
      cleanupBackup: async () => { events.push("cleanup"); },
    });
    if (failCompletion) await assert.rejects(operation, /record unavailable/);
    else assert.equal(await operation, false);
    assert.ok(!events.includes("recover"));
    assert.equal(events.at(-1), "cleanup");
  }
});

test("cleans an unregistered backup when registration fails", async () => {
  const events: string[] = [];
  await assert.rejects(
    writeConversionIfCurrent({
      writeBackup: async () => {
        events.push("backup");
      },
      writeRecord: async () => {
        events.push("record");
      },
      isCurrent: async () => true,
      registerBackup: async () => {
        events.push("register");
        throw new Error("registration failed");
      },
      writeTarget: async () => {
        events.push("target");
      },
      recoverTarget: async () => {
        events.push("recover");
      },
      cleanupBackup: async () => {
        events.push("cleanup");
      },
    }),
    /registration failed/,
  );
  assert.deepEqual(events, ["backup", "record", "register", "cleanup"]);
});

test("recovers a failed target and preserves its registered backup", async () => {
  const events: string[] = [];
  await assert.rejects(
    writeConversionIfCurrent({
      writeBackup: async () => {
        events.push("backup");
      },
      writeRecord: async () => {
        events.push("record");
      },
      isCurrent: async () => true,
      registerBackup: async () => {
        events.push("register");
      },
      markTargetStarted: async () => {
        events.push("started");
      },
      writeTarget: async () => {
        events.push("target");
        throw new Error("partial write");
      },
      recoverTarget: async () => {
        events.push("recover");
      },
      markTargetCompleted: async () => {
        events.push("completed");
      },
      cleanupBackup: async () => {
        events.push("cleanup");
      },
    }),
    (error) =>
      error instanceof ConversionTargetWriteError &&
      !error.recoveryFailed &&
      error.message === "partial write",
  );
  assert.deepEqual(events, [
    "backup",
    "record",
    "register",
    "started",
    "target",
    "recover",
    "completed",
  ]);
});

test("reports when immediate target recovery also fails", async () => {
  await assert.rejects(
    writeConversionIfCurrent({
      writeBackup: async () => undefined,
      writeRecord: async () => undefined,
      isCurrent: async () => true,
      registerBackup: async () => undefined,
      writeTarget: async () => {
        throw new Error("write failed");
      },
      recoverTarget: async () => {
        throw new Error("recovery failed");
      },
      cleanupBackup: async () => undefined,
    }),
    (error) =>
      error instanceof ConversionTargetWriteError && error.recoveryFailed,
  );
});

test("allows only one conversion operation at a time", () => {
  const gate = new ConversionOperationGate();
  const release = gate.enter();
  assert.ok(release);
  assert.equal(gate.enter(), undefined);
  release();
  assert.equal(typeof gate.enter(), "function");
});

test("keeps only backup sessions that can still restore data", () => {
  assert.equal(
    conversionBackupDisposition(1, false, true),
    "keepNewAndDeletePrevious",
  );
  assert.equal(
    conversionBackupDisposition(0, true, true),
    "keepNewForRecovery",
  );
  assert.equal(
    conversionBackupDisposition(0, false, true),
    "restorePreviousAndDeleteNew",
  );
  assert.equal(
    conversionBackupDisposition(0, false, false),
    "deleteUnusedNew",
  );
});

test("notifies only when the last conversion session is still protected", () => {
  assert.equal(protectedConversionSession(undefined, undefined), undefined);
  assert.equal(protectedConversionSession("session-a", "session-b"), undefined);
  assert.equal(protectedConversionSession("", ""), undefined);
  assert.equal(protectedConversionSession(1, 1), undefined);
  const invalidSession = {};
  assert.equal(protectedConversionSession(invalidSession, invalidSession), undefined);
  assert.equal(
    protectedConversionSession("session-a", "session-a"),
    "session-a",
  );
});


test("conversion assessment distinguishes unchanged, binary, source and target failures", async () => {
  const cases = [
    { bytes: new TextEncoder().encode("same"), source: "utf8", target: "utf8", reason: "unchanged" },
    { bytes: new Uint8Array([0x61, 0, 0x62]), source: "latin1", target: "utf8", reason: "binary" },
    { bytes: new TextEncoder().encode("café"), source: "utf8", target: "ascii", reason: "targetMismatch" },
    { bytes: new Uint8Array([0xff]), source: "utf8", target: "latin1", reason: "sourceMismatch" },
  ];
  for (const entry of cases) {
    const result = await assessEncodingConversion(entry.bytes, entry.source, entry.target, codec);
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") assert.equal(result.reason, entry.reason);
  }
  const result = await assessEncodingConversion(await codec.encode("café", "latin1"), "latin1", "utf8", codec);
  assert.equal(result.kind, "ready");
  if (result.kind === "ready") assert.equal(new TextDecoder().decode(result.prepared.converted), "café");
  await assert.rejects(prepareEncodingConversion(new Uint8Array([0xff]), "utf8", "latin1", codec));
});

test("rechecks after registration and the start marker without recovering untouched targets", async () => {
  for (const failure of ["register-change", "marker-change", "marker-error"]) {
    let current = true;
    let writes = 0;
    let recoveries = 0;
    let cleaned = false;
    const operation = writeConversionIfCurrent({
      writeBackup: async () => {}, writeRecord: async () => {},
      isCurrent: async () => current,
      registerBackup: async () => { if (failure === "register-change") current = false; },
      markTargetStarted: async () => {
        if (failure === "marker-change") current = false;
        if (failure === "marker-error") throw new Error("marker failed");
      },
      writeTarget: async () => { writes++; },
      recoverTarget: async () => { recoveries++; },
      cleanupBackup: async () => { cleaned = true; },
    });
    if (failure === "marker-error") await assert.rejects(operation, /marker failed/);
    else assert.equal(await operation, false);
    assert.equal(writes, 0);
    assert.equal(recoveries, 0);
    assert.equal(cleaned, true);
  }
});

test("converts non-canonical CP932 alias bytes to UTF-8 and preserves alias bytes on EOL-only conversion", async () => {
  const canonicalBytes = new Map<string, readonly number[]>([
    ["Ⅰ", [0x87, 0x54]],
    ["纊", [0xed, 0x40]],
  ]);
  const sjisCodec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "shiftjis") return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
      return codec.decode(bytes, encoding);
    },
    async encode(text, encoding) {
      if (encoding === "shiftjis") {
        const out: number[] = [];
        for (const ch of text) {
          const mapped = canonicalBytes.get(ch);
          if (mapped) { out.push(...mapped); continue; }
          const code = ch.charCodeAt(0);
          assert.ok(code <= 0x7f, `unexpected char ${ch}`);
          out.push(code);
        }
        return Uint8Array.from(out);
      }
      return codec.encode(text, encoding);
    },
  };
  // IBM extension alias bytes for Ⅰ (0xfa4a) and 纊 (0xfa5c) mixed with CRLF / lone CR / LF.
  const aliasOriginal = Uint8Array.from([0xfa, 0x4a, 0x0d, 0x0a, 0xfa, 0x5c, 0x0d, 0x41, 0x0a]);
  const toUtf8 = await assessEncodingConversion(aliasOriginal, "shiftjis", "utf8", sjisCodec);
  assert.equal(toUtf8.kind, "ready");
  if (toUtf8.kind === "ready") {
    assert.deepEqual(toUtf8.prepared.converted, new TextEncoder().encode("Ⅰ\r\n纊\rA\n"));
  }

  const toLf = await assessEncodingConversion(aliasOriginal, "shiftjis", "shiftjis", sjisCodec, undefined, "lf");
  assert.equal(toLf.kind, "ready");
  if (toLf.kind === "ready") {
    assert.deepEqual(toLf.prepared.converted, Uint8Array.from([0xfa, 0x4a, 0x0a, 0xfa, 0x5c, 0x0a, 0x41, 0x0a]));
  }

  const toCrlf = await assessEncodingConversion(aliasOriginal, "shiftjis", "shiftjis", sjisCodec, undefined, "crlf");
  assert.equal(toCrlf.kind, "ready");
  if (toCrlf.kind === "ready") {
    assert.deepEqual(toCrlf.prepared.converted, Uint8Array.from([0xfa, 0x4a, 0x0d, 0x0a, 0xfa, 0x5c, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]));
  }

  const unchanged = await assessEncodingConversion(aliasOriginal, "shiftjis", "shiftjis", sjisCodec);
  assert.deepEqual(unchanged, { kind: "skipped", reason: "unchanged" });

  const alreadyLf = Uint8Array.from([0xfa, 0x4a, 0x0a]);
  assert.deepEqual(await assessEncodingConversion(alreadyLf, "shiftjis", "shiftjis", sjisCodec, undefined, "lf"), { kind: "skipped", reason: "unchanged" });
});

test("converts ISO-2022-JP source bytes to UTF-8 and rejects ISO-2022-JP as target", async () => {
  const jisBytes = Uint8Array.from([
    0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42, 0x0a,
  ]);
  const jisCodec: EncodingCodec = {
    decode: async (bytes, encoding) => {
      if (encoding === "iso2022jp") return new TextDecoder("iso-2022-jp", { fatal: true }).decode(bytes);
      return codec.decode(bytes, encoding);
    },
    encode: async (text, encoding) => {
      if (encoding === "iso2022jp") throw new Error("read-only");
      return codec.encode(text, encoding);
    },
  };
  const ready = await assessEncodingConversion(jisBytes, "iso2022jp", "utf8", jisCodec);
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") {
    assert.equal(ready.prepared.text, "日本語\n");
    assert.deepEqual(ready.prepared.converted, new TextEncoder().encode("日本語\n"));
  }

  const rejectedTarget = await assessEncodingConversion(
    new TextEncoder().encode("日本語\n"),
    "utf8",
    "iso2022jp",
    jisCodec,
  );
  assert.deepEqual(rejectedTarget, { kind: "skipped", reason: "targetMismatch" });
});
