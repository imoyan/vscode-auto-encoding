import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type * as vscode from "vscode";
import type { RuleMatch } from "../src/workspaceRules.js";

type Runtime = typeof import("../src/editorEncoding.js");
const bundle = build({
  entryPoints: ["src/editorEncoding.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["vscode"],
});

class Uri {
  public readonly scheme = "file";
  public readonly path: string;
  public constructor(public readonly fsPath: string) { this.path = fsPath; }
  public toString(): string { return pathToFileURL(this.fsPath).href; }
}

async function harness(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "editor-privacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uri = new Uri(path.join(root, "saved.txt"));
  const folder = { uri: new Uri(root), name: "workspace", index: 0 };
  await writeFile(uri.fsPath, "\uFEFFsaved text");
  const messages: { level: "error" | "warning" | "information"; text: string }[] = [];
  const opened: { uri: Uri; encoding: string }[] = [];
  const shown: { uri: Uri; encoding: string }[] = [];
  let failure: "encode" | "write" | "open" | "show" | undefined;
  let thrown: unknown;
  let writeCount = 0;
  const workspace = {
    getWorkspaceFolder: () => folder,
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => key === "rules"
        ? [{ pattern: "**/*", encoding: "utf8bom" }]
        : key === "enforceOnSave" ? true : fallback,
    }),
    encode: async (text: string, options: { encoding: string }) => {
      if (failure === "encode") throw thrown;
      const bytes = new TextEncoder().encode(text);
      return options.encoding === "utf8bom"
        ? new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]) : bytes;
    },
    decode: async (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes),
    openTextDocument: async (target: Uri, options: { encoding: string }) => {
      opened.push({ uri: target, encoding: options.encoding });
      if (failure === "open") throw thrown;
      return { uri: target, encoding: options.encoding };
    },
    fs: {
      writeFile: async (target: Uri, bytes: Uint8Array) => {
        writeCount += 1;
        if (failure === "write") throw thrown;
        await writeFile(target.fsPath, bytes);
      },
    },
  };
  const window = {
    showErrorMessage: async (text: string) => { messages.push({ level: "error", text }); },
    showWarningMessage: async (text: string) => { messages.push({ level: "warning", text }); },
    showInformationMessage: async (text: string) => { messages.push({ level: "information", text }); },
    showTextDocument: async (document: { uri: Uri; encoding: string }) => {
      shown.push(document);
      if (failure === "show") throw thrown;
    },
  };
  const module = { exports: {} };
  const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  runInNewContext((await bundle).outputFiles[0]!.text, {
    module, exports: module.exports, Buffer, process, TextDecoder, TextEncoder,
    require: (name: string) => name === "vscode" ? { workspace, window, EventEmitter: class { event = () => undefined; fire() {} } } : nativeRequire(name),
  });
  const runtime = module.exports as Runtime;
  const document = {
    uri, fileName: "saved.txt", encoding: "utf8", version: 1,
    isDirty: false, isClosed: false, getText: () => "saved text",
  };
  const match = {
    folder, relativePath: "saved.txt", rule: { pattern: "**/*", encoding: "utf8bom" }, index: 0,
  } as unknown as RuleMatch;
  return {
    messages, opened, shown, document,
    reopen: () => runtime.reopenWithExpectedEncoding(document as unknown as vscode.TextDocument, match),
    savedBytes: () => readFile(uri.fsPath),
    writes: () => writeCount,
    fail: (stage: typeof failure, value: unknown) => { failure = stage; thrown = value; },
    privateError: () => new Error(`PRIVATE_EXCEPTION_DETAIL ${uri.fsPath}`),
    assertPrivate: () => {
      assert.ok(messages.every((message) => !message.text.includes("PRIVATE_EXCEPTION_DETAIL")));
      assert.ok(messages.every((message) => !message.text.includes(uri.fsPath)));
    },
  };
}

test("opening or showing a document hides exception details and gives a retry action", async (t) => {
  for (const stage of ["open", "show"] as const) {
    await t.test(stage, async (t) => {
      const h = await harness(t);
      h.fail(stage, h.privateError());
      await h.reopen();
      h.assertPrivate();
      assert.equal(h.messages.length, 1);
      assert.equal(h.messages[0]!.level, "error");
      assert.match(h.messages[0]!.text, /file contents and read permissions.*try again/);
      assert.equal(h.writes(), 0);
      assert.equal((await h.savedBytes()).toString(), "\uFEFFsaved text");
      h.fail(undefined, undefined);
      await h.reopen();
      assert.equal(h.opened.at(-1)!.encoding, "utf8bom");
      assert.equal(h.shown.at(-1)!.uri, h.document.uri);
      assert.equal(h.shown.at(-1)!.encoding, "utf8bom");
      assert.equal(h.shown.length, stage === "show" ? 2 : 1);
      assert.equal(h.messages.length, 1);
    });
  }
});

test("reopen never formats a thrown object and releases its retry lock", async (t) => {
  const h = await harness(t);
  let formatted = false;
  h.fail("open", { toString: () => { formatted = true; throw new Error("PRIVATE_EXCEPTION_DETAIL"); } });
  await h.reopen();
  assert.equal(formatted, false);
  assert.equal(h.messages.length, 1);
  h.assertPrivate();
  h.fail(undefined, undefined);
  await h.reopen();
  assert.equal(h.shown.length, 1);
});

test("dirty documents are never reopened or written", async (t) => {
  const h = await harness(t);
  h.document.isDirty = true;
  await h.reopen();
  assert.equal(h.opened.length, 0);
  assert.equal(h.writes(), 0);
  assert.match(h.messages[0]!.text, /unsaved changes/);
});
