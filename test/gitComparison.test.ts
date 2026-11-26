import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type * as vscode from "vscode";

type Runtime = typeof import("../src/editorEncoding.js");
const bundle = build({
  entryPoints: ["src/editorEncoding.ts"], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["vscode"],
});

class Uri {
  public constructor(public scheme: string, public path: string, public query = "", public fragment = "") {}
  public get fsPath(): string { return this.path; }
  public static file(value: string): Uri { return new Uri("file", value); }
  public with(change: { query?: string; fragment?: string }): Uri {
    return new Uri(this.scheme, this.path, change.query ?? this.query, change.fragment ?? this.fragment);
  }
  public toString(): string { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ""}`; }
}
class TabInputText { public constructor(public uri: Uri) {} }
class TabInputTextDiff { public constructor(public original: Uri, public modified: Uri) {} }
interface Doc { uri: Uri; fileName: string; encoding: string; isDirty: boolean; version: number; getText(): string }

// Real Japanese byte sequences: SJIS_JA is invalid UTF-8 and invalid EUC-JP; EUC_JA ends in 0xEC 0x0A (invalid SJIS); AMBIGUOUS_KANA (0xA4 0xA2 0xA4 0xA4 0x0A) round-trips in both SJIS and EUC-JP.
const SJIS_JA = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
const EUC_JA = Uint8Array.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec, 0x0a]);
const AMBIGUOUS_KANA = Uint8Array.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]);
const UTF8_JA = new TextEncoder().encode("あ\n");

function testDecode(bytes: Uint8Array, encoding: string): string {
  if (encoding === "utf8" || encoding === "utf8bom") {
    const start = encoding === "utf8bom" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
  }
  if (encoding === "shiftjis") return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  if (encoding === "eucjp") return new TextDecoder("euc-jp", { fatal: true }).decode(bytes);
  if (encoding === "utf16le" || encoding === "utf16be") {
    const start = (encoding === "utf16le" && bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (encoding === "utf16be" && bytes[0] === 0xfe && bytes[1] === 0xff) ? 2 : 0;
    const body = bytes.subarray(start);
    if (body.byteLength % 2 !== 0) throw new Error("odd utf16");
    const le = encoding === "utf16le" ? body : Uint8Array.from(body, (_, i) => body[i % 2 === 0 ? i + 1 : i - 1]!);
    return new TextDecoder("utf-16le", { fatal: true }).decode(le);
  }
  throw new Error(`unsupported test encoding: ${encoding}`);
}

function testEncode(text: string, encoding: string): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(text);
  if (encoding === "utf8bom") return Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
  if (encoding === "utf16le") return new Uint8Array(Buffer.from(text, "utf16le"));
  if (encoding === "utf16be") {
    const le = Buffer.from(text, "utf16le");
    return Uint8Array.from(le, (_, i) => le[i % 2 === 0 ? i + 1 : i - 1]!);
  }
  if (Array.from(text).every((ch) => ch.charCodeAt(0) < 0x80)) return new TextEncoder().encode(text);
  if (encoding === "shiftjis") {
    if (text === "日本語\n") return SJIS_JA;
    if (text === "､｢､､\n") return AMBIGUOUS_KANA;
    throw new Error("unrepresentable in shiftjis fixture");
  }
  if (encoding === "eucjp") {
    if (text === "日本語\n") return EUC_JA;
    if (text === "あい\n") return AMBIGUOUS_KANA;
    throw new Error("unrepresentable in eucjp fixture");
  }
  throw new Error(`unsupported test encoding: ${encoding}`);
}

async function harness(t: TestContext, options: { rule?: string; autoReopenGitComparison?: boolean; preview?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "git-comparison-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "a.dat");
  await writeFile(filePath, "saved\n");
  const config: Record<string, unknown> = {
    rules: options.rule ? [{ pattern: "**/*.dat", encoding: options.rule }] : [],
    autoReopenGitComparison: options.autoReopenGitComparison,
  };
  const folder = { uri: Uri.file(root), name: "workspace", index: 0 };
  const fileUri = Uri.file(filePath);
  const headUri = new Uri("git", filePath, "ref=HEAD");
  const indexUri = new Uri("git", filePath, "ref=~");
  const gitBlobs = new Map<string, Uint8Array>();
  const documents: Doc[] = [];
  const doc = (uri: Uri, encoding = "utf8"): Doc => {
    const entry: Doc = { uri, fileName: uri.fsPath, encoding, isDirty: false, version: 1, getText: () => "text" };
    documents.push(entry);
    return entry;
  };
  const opened: { uri: Uri; encoding: string }[] = [];
  const shownDocs: { doc: Doc; options: unknown }[] = [];
  const commands: unknown[][] = [];
  const picks: unknown[] = [];
  const shown: { items: Record<string, unknown>[]; title?: string }[] = [];
  const errors: string[] = [];
  let tab: { input: unknown; label: string; isPreview: boolean } | undefined;
  const hooks: { onOpen?: () => void; command?: (args: unknown[]) => unknown } = {};
  const vsc = {
    Uri, TabInputText, TabInputTextDiff, FileType: { File: 1 }, ThemeColor: class { constructor(public id: string) {} },
    EventEmitter: class { public event = () => undefined; public fire(): void {} },
    DiagnosticSeverity: { Warning: 1 }, Diagnostic: class {},
    workspace: {
      textDocuments: documents,
      getWorkspaceFolder: (uri: Uri) => uri.path.startsWith(root) ? folder : undefined,
      getConfiguration: (section: string) => ({
        get: (key: string, fallback?: unknown) => section === "files" ? fallback : config[key] ?? fallback,
      }),
      decode: async (bytes: Uint8Array, opts: { encoding: string }) => testDecode(bytes, opts.encoding),
      encode: async (text: string, opts: { encoding: string }) => testEncode(text, opts.encoding),
      fs: {
        stat: async (uri: Uri) => {
          const blob = gitBlobs.get(uri.toString());
          if (!blob) throw new Error("missing git blob");
          return { type: 1, size: blob.byteLength, mtime: 1 };
        },
        readFile: async (uri: Uri) => {
          const blob = gitBlobs.get(uri.toString());
          if (!blob) throw new Error("missing git blob");
          return blob;
        },
      },
      openTextDocument: async (uri: Uri, open: { encoding: string }) => {
        opened.push({ uri, encoding: open.encoding });
        hooks.onOpen?.();
        const existing = documents.find((entry) => entry.uri.toString() === uri.toString()) ?? doc(uri);
        existing.encoding = open.encoding;
        return existing;
      },
    },
    window: {
      activeTextEditor: undefined as { document: Doc } | undefined,
      get tabGroups() { return { activeTabGroup: { activeTab: tab } }; },
      showTextDocument: async (document: Doc, showOptions?: unknown) => {
        shownDocs.push({ doc: document, options: showOptions });
        vsc.window.activeTextEditor = { document };
        return vsc.window.activeTextEditor;
      },
      showQuickPick: async (items: Record<string, unknown>[], quickPick: { title?: string }) => {
        shown.push({ items, title: quickPick.title });
        const pick = picks.shift();
        return typeof pick === "function" ? pick(items) : pick;
      },
      showErrorMessage: async (message: string) => { errors.push(message); },
      showInformationMessage: async () => undefined,
    },
    commands: { executeCommand: async (...args: unknown[]) => { commands.push(args); return hooks.command?.(args); } },
  };
  const module = { exports: {} };
  const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  runInNewContext((await bundle).outputFiles[0]!.text, {
    module, exports: module.exports, Buffer, process, console, TextDecoder, TextEncoder,
    require: (name: string) => name === "vscode" ? vsc : nativeRequire(name),
  });
  const runtime = module.exports as Runtime;
  const status = { text: "", tooltip: "", command: "", backgroundColor: undefined as unknown, show() {}, hide() {} };
  return {
    runtime, root, filePath, fileUri, headUri, indexUri, gitBlobs, documents, doc, opened, shownDocs, commands, picks, shown, errors, status,
    config, vsc, hooks,
    show: (original: Uri, modified: Uri) => {
      tab = { input: new TabInputTextDiff(original, modified), label: "a.dat (Working Tree)", isPreview: options.preview ?? false };
      vsc.window.activeTextEditor = { document: documents.find((entry) => entry.uri.toString() === modified.toString())! };
    },
    showMultiDiff: (pairs: Array<[Uri, Uri]>, activeUri?: Uri) => {
      tab = {
        input: { textDiffs: pairs.map(([original, modified]) => new TabInputTextDiff(original, modified)) },
        label: "Changes",
        isPreview: options.preview ?? false,
      };
      const targetUri = activeUri ?? pairs[0]![1];
      vsc.window.activeTextEditor = { document: documents.find((entry) => entry.uri.toString() === targetUri.toString())! };
    },
    showSingle: (uri: Uri) => {
      tab = { input: new TabInputText(uri), label: path.basename(uri.path), isPreview: options.preview ?? false };
      vsc.window.activeTextEditor = { document: documents.find((entry) => entry.uri.toString() === uri.toString())! };
    },
    switchTab: () => { tab = { input: new TabInputTextDiff(Uri.file("/other-a"), Uri.file("/other-b")), label: "other", isPreview: true }; },
    align: () => runtime.alignActiveComparison(),
    inspect: () => runtime.inspectActiveFile(),
    updateStatus: (document: Doc) => runtime.updateStatus(status as unknown as vscode.StatusBarItem, document as unknown as vscode.TextDocument),
    encodings: () => Object.fromEntries(documents.map((entry) => [entry.uri.scheme + (entry.uri.query || ""), entry.encoding])),
  };
}

test("a configured rule reopens both Git comparison sides and keeps the preview tab", async (t) => {
  const h = await harness(t, { rule: "shiftjis", preview: true });
  h.doc(h.headUri); h.doc(h.fileUri);
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.encodings(), { "gitref=HEAD": "shiftjis", file: "shiftjis" });
  assert.equal(h.commands.length, 1);
  assert.deepEqual(h.commands[0]!.slice(0, 4), ["vscode.diff", h.headUri, h.fileUri, "a.dat (Working Tree)"]);
  assert.equal(JSON.stringify(h.commands[0]![4]), JSON.stringify({ preview: true }));
  assert.equal(await h.align(), false);
  assert.equal(h.commands.length, 1);
});

test("an unsaved working file is never reopened while its Git side still follows the rule", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  h.doc(h.headUri); const working = h.doc(h.fileUri); working.isDirty = true;
  h.show(h.headUri, h.fileUri);
  await h.align();
  assert.deepEqual(h.opened.map((entry) => entry.uri.scheme), ["git"]);
  assert.equal(working.encoding, "utf8");
});

test("without a rule the Git side follows a working file already opened in a non-default encoding", async (t) => {
  const h = await harness(t);
  h.doc(h.headUri); h.doc(h.fileUri, "shiftjis");
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.opened, [{ uri: h.headUri, encoding: "shiftjis" }]);
  const second = await harness(t);
  second.doc(second.headUri); second.doc(second.fileUri);
  second.show(second.headUri, second.fileUri);
  assert.equal(await second.align(), false);
  assert.deepEqual(second.opened, []);
});

test("staged and history comparisons (Git on both sides) use the open working file's encoding", async (t) => {
  const h = await harness(t);
  h.doc(h.headUri); h.doc(h.indexUri); h.doc(h.fileUri, "shiftjis");
  h.show(h.headUri, h.indexUri);
  await h.align();
  assert.deepEqual(h.opened.map((entry) => entry.encoding), ["shiftjis", "shiftjis"]);
  assert.deepEqual(h.opened.map((entry) => entry.uri.query), ["ref=HEAD", "ref=~"]);
});

test("autoReopenGitComparison=false leaves comparisons alone", async (t) => {
  const h = await harness(t, { rule: "shiftjis", autoReopenGitComparison: false });
  h.doc(h.headUri); h.doc(h.fileUri);
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), false);
  assert.deepEqual(h.opened, []);
});

test("comparisons without a Git side are not touched automatically", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  const other = h.doc(Uri.file(path.join(h.root, "b.dat"))); h.doc(h.fileUri);
  h.show(other.uri, h.fileUri);
  assert.equal(await h.align(), false);
});

test("the status bar explains matches, mismatches and unconfigured files", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  const head = h.doc(h.headUri, "utf8"); const working = h.doc(h.fileUri, "shiftjis");
  h.show(h.headUri, h.fileUri);
  h.updateStatus(working);
  assert.match(h.status.text, /^\$\(warning\) Left \(Git\): UTF-8 \/ Right \(Working\): Shift JIS/);
  assert.ok(h.status.backgroundColor);
  assert.match(String(h.status.tooltip), /One side differs from the expected encoding/);
  assert.match(String(h.status.tooltip), /never modifies files/);
  head.encoding = "shiftjis";
  h.updateStatus(working);
  assert.match(h.status.text, /^\$\(pass\) /);
  assert.equal(h.status.backgroundColor, undefined);

  const plain = await harness(t);
  const file = plain.doc(plain.fileUri, "shiftjis");
  plain.updateStatus(file);
  assert.match(plain.status.text, /Shift JIS \/ CP932 \(no rule\)/);
  assert.match(String(plain.status.tooltip), /preserved in VS Code Git comparisons/);
});

test("normal editor status distinguishes current decoding from the effective rule", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  const doc = h.doc(h.fileUri, "utf8");
  h.updateStatus(doc);
  assert.equal(h.status.text, "$(warning) Open: UTF-8 / Rule: Shift JIS / CP932");
  assert.match(String(h.status.tooltip), /Source: workspace \/ \*\*\/\*\.dat/);
  doc.encoding = "shiftjis";
  h.updateStatus(doc);
  assert.equal(h.status.text, "$(pass) Rule: Shift JIS / CP932");
  assert.match(String(h.status.tooltip), /Open: Shift JIS \/ CP932/);
});

test("the menu reopens both comparison sides at the expected encoding without saving", async (t) => {
  const h = await harness(t, { rule: "shiftjis", autoReopenGitComparison: false });
  h.doc(h.headUri); h.doc(h.fileUri);
  h.show(h.headUri, h.fileUri);
  h.picks.push((items: Record<string, unknown>[]) => items.find((item) => item.action === "expected"));
  await h.inspect();
  assert.match(h.shown[0]!.title!, /Left \(Git\): UTF-8 \/ Right \(Working\): UTF-8/);
  assert.ok(h.shown[0]!.items.some((item) => item.action === "registerFolder"));
  assert.deepEqual(h.opened.map((entry) => entry.encoding), ["shiftjis", "shiftjis"]);
  assert.deepEqual(h.errors, []);
});

test("a single side can be reopened on purpose and stays that way", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  h.doc(h.headUri, "shiftjis"); h.doc(h.fileUri, "shiftjis");
  h.show(h.headUri, h.fileUri);
  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "original"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "utf8"),
  );
  await h.inspect();
  assert.deepEqual(h.opened, [{ uri: h.headUri, encoding: "utf8" }]);
  assert.equal(await h.align(), false);
  assert.deepEqual(h.opened, [{ uri: h.headUri, encoding: "utf8" }]);
});

test("the menu refuses to reopen an unsaved side but still reopens the other", async (t) => {
  const h = await harness(t, { rule: "shiftjis", autoReopenGitComparison: false });
  h.doc(h.headUri); const working = h.doc(h.fileUri); working.isDirty = true;
  h.show(h.headUri, h.fileUri);
  h.picks.push((items: Record<string, unknown>[]) => items.find((item) => item.action === "expected"));
  await h.inspect();
  assert.deepEqual(h.opened.map((entry) => entry.uri.scheme), ["git"]);
  assert.ok(h.errors.some((message) => message.includes("unsaved changes")));
});

test("a comparison the user has navigated away from is not restored after reopening", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  h.doc(h.headUri); h.doc(h.fileUri);
  h.show(h.headUri, h.fileUri);
  h.hooks.onOpen = () => h.switchTab();
  await h.align();
  assert.equal(h.opened.length, 2);
  assert.deepEqual(h.commands, []);
});

test("cancelling the registration picker never reopens the document", async (t) => {
  const h = await harness(t, { rule: "shiftjis", autoReopenGitComparison: false });
  h.doc(h.headUri); h.doc(h.fileUri, "utf16le");
  h.show(h.headUri, h.fileUri);
  h.hooks.command = () => false;
  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "convertRule" || item.action === "convertFile"), false);
    return items.find((item) => item.action === "registerFile");
  });
  await h.inspect();
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.commands.map((call) => call[0]), ["autoEncoding.configureFile"]);
});

test("a saved registration reopens both comparison sides at the new rule", async (t) => {
  const h = await harness(t, { autoReopenGitComparison: false });
  h.doc(h.headUri); h.doc(h.fileUri);
  h.show(h.headUri, h.fileUri);
  h.hooks.command = () => { h.config.rules = [{ pattern: "**/*.dat", encoding: "eucjp" }]; return true; };
  h.picks.push((items: Record<string, unknown>[]) => items.find((item) => item.action === "registerFolder"));
  await h.inspect();
  assert.deepEqual(h.opened.map((entry) => entry.encoding), ["eucjp", "eucjp"]);
});

test("reopening only the working side keeps the Git side as it is without a rule", async (t) => {
  const h = await harness(t);
  h.doc(h.headUri, "shiftjis"); h.doc(h.fileUri, "shiftjis");
  h.show(h.headUri, h.fileUri);
  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "modified"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "eucjp"),
  );
  await h.inspect();
  assert.deepEqual(h.opened, [{ uri: h.fileUri, encoding: "eucjp" }]);
  assert.equal(await h.align(), false);
  assert.deepEqual(h.opened, [{ uri: h.fileUri, encoding: "eucjp" }]);
});

test("unconfigured working-tree and staged/history comparisons auto-detect unambiguous Shift JIS and EUC-JP", async (t) => {
  // (1) Working tree diff (git: vs file:) without rule or prior open
  const working = await harness(t);
  await writeFile(working.filePath, SJIS_JA);
  working.gitBlobs.set(working.headUri.toString(), SJIS_JA);
  working.doc(working.headUri);
  const workingDoc = working.doc(working.fileUri);
  working.show(working.headUri, working.fileUri);
  assert.equal(await working.align(), true);
  assert.deepEqual(working.encodings(), { "gitref=HEAD": "shiftjis", file: "shiftjis" });
  working.updateStatus(workingDoc);
  assert.match(working.status.text, /^\$\(pass\) Left \(Git\): Shift JIS \/ CP932 \/ Right \(Working\): Shift JIS \/ CP932 \(auto-detected\)$/);
  assert.match(String(working.status.tooltip), /auto-detected from bytes/);

  // (2) Staged / commit-to-commit diff (git: vs git:) when working file is not open
  const staged = await harness(t);
  staged.gitBlobs.set(staged.headUri.toString(), EUC_JA);
  staged.gitBlobs.set(staged.indexUri.toString(), EUC_JA);
  staged.doc(staged.headUri);
  const stagedRight = staged.doc(staged.indexUri);
  staged.show(staged.headUri, staged.indexUri);
  assert.equal(await staged.align(), true);
  assert.deepEqual(staged.encodings(), { "gitref=HEAD": "eucjp", "gitref=~": "eucjp" });
  staged.updateStatus(stagedRight);
  assert.match(staged.status.text, /^\$\(pass\) Left \(Git\): EUC-JP \/ Right \(Git\): EUC-JP \(auto-detected\)$/);
});

test("an empty or pure-ASCII comparison side aligns to its unambiguous counterpart", async (t) => {
  const h = await harness(t);
  await writeFile(h.filePath, SJIS_JA);
  h.gitBlobs.set(h.headUri.toString(), new TextEncoder().encode("ascii header\n"));
  h.doc(h.headUri);
  const working = h.doc(h.fileUri);
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.encodings(), { "gitref=HEAD": "shiftjis", file: "shiftjis" });
  h.updateStatus(working);
  assert.match(h.status.text, /^\$\(pass\) /);
});

test("encoding conversion commits keep each side readable instead of forcing mojibake", async (t) => {
  // Rule is UTF-8 after migrating from Shift JIS; HEAD still has Shift JIS bytes.
  const h = await harness(t, { rule: "utf8" });
  await writeFile(h.filePath, UTF8_JA);
  h.gitBlobs.set(h.headUri.toString(), SJIS_JA);
  h.doc(h.headUri, "utf8");
  const working = h.doc(h.fileUri, "utf8");
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.encodings(), { "gitref=HEAD": "shiftjis", file: "utf8" });
  h.updateStatus(working);
  assert.match(h.status.text, /^\$\(warning\) Left \(Git\): Shift JIS \/ CP932 \/ Right \(Working\): UTF-8$/);
  assert.ok(h.status.backgroundColor);
  assert.match(String(h.status.tooltip), /displaying the detected encoding to prevent mojibake/);
});

test("a CP932 rule does not reopen a UTF-8 working file in the Git comparison", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  await writeFile(h.filePath, UTF8_JA);
  h.gitBlobs.set(h.headUri.toString(), SJIS_JA);
  h.doc(h.headUri, "utf8");
  const working = h.doc(h.fileUri, "utf8");
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.opened, [{ uri: h.headUri, encoding: "shiftjis" }]);
  h.updateStatus(working);
  assert.match(h.status.text, /^\$\(warning\).*Right \(Working\): UTF-8$/);
  assert.match(String(h.status.tooltip), /One side differs from the configured rule/);
});

test("a Git counterpart does not choose an encoding for an ambiguous working file with a different rule", async (t) => {
  const h = await harness(t, { rule: "shiftjis" });
  await writeFile(h.filePath, AMBIGUOUS_KANA);
  h.gitBlobs.set(h.headUri.toString(), SJIS_JA);
  h.doc(h.headUri, "utf8");
  const working = h.doc(h.fileUri, "utf8");
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.opened, [{ uri: h.headUri, encoding: "shiftjis" }]);
  h.updateStatus(working);
  assert.match(String(h.status.tooltip), /Multiple encoding candidates/);
});

test("ambiguous Shift JIS / EUC-JP bytes do not guess blindly unless disambiguated by the other side", async (t) => {
  // Both sides ambiguous -> keep UTF-8, warn with candidates, allow 1-click candidate reopen from menu top
  const both = await harness(t);
  await writeFile(both.filePath, AMBIGUOUS_KANA);
  both.gitBlobs.set(both.headUri.toString(), AMBIGUOUS_KANA);
  both.doc(both.headUri);
  const working = both.doc(both.fileUri);
  both.show(both.headUri, both.fileUri);
  assert.equal(await both.align(), false);
  assert.deepEqual(both.opened, []);
  both.updateStatus(working);
  assert.match(both.status.text, /^\$\(warning\) Left \(Git\): UTF-8 \/ Right \(Working\): UTF-8 \(candidates\)$/);
  assert.match(String(both.status.tooltip), /candidates: Shift JIS \/ CP932 \/ EUC-JP/);
  both.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items[0]?.action, "candidate");
    assert.equal(items[0]?.encoding, "eucjp");
    assert.match(String(items[0]?.description), /^Likely · Both sides/);
    assert.match(String(items[0]?.detail), /^Right L1: /);
    return items.find((item) => item.action === "candidate" && item.encoding === "eucjp");
  });
  await both.inspect();
  assert.deepEqual(both.encodings(), { "gitref=HEAD": "eucjp", file: "eucjp" });

  // Counterpart is unambiguous EUC-JP -> resolves ambiguous side automatically
  const resolved = await harness(t);
  await writeFile(resolved.filePath, EUC_JA);
  resolved.gitBlobs.set(resolved.headUri.toString(), AMBIGUOUS_KANA);
  resolved.doc(resolved.headUri);
  resolved.doc(resolved.fileUri);
  resolved.show(resolved.headUri, resolved.fileUri);
  assert.equal(await resolved.align(), true);
  assert.deepEqual(resolved.encodings(), { "gitref=HEAD": "eucjp", file: "eucjp" });

  // Counterpart is uniquely UTF-8 while Git side is ambiguous -> picking EUC-JP candidate reopens ONLY the ambiguous Git side
  const mixed = await harness(t);
  await writeFile(mixed.filePath, UTF8_JA);
  mixed.gitBlobs.set(mixed.headUri.toString(), AMBIGUOUS_KANA);
  mixed.doc(mixed.headUri, "utf8");
  const mixedWork = mixed.doc(mixed.fileUri, "utf8");
  mixed.show(mixed.headUri, mixed.fileUri);
  assert.equal(await mixed.align(), false);
  mixed.updateStatus(mixedWork);
  assert.match(mixed.status.text, /\(candidates\)$/);
  mixed.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "convertRule" || item.action === "convertFile"), false);
    const candidate = items.find((item) => item.action === "candidate" && item.encoding === "eucjp");
    assert.match(String(candidate?.description), /^Likely · Left side \(Git\) only/);
    assert.match(String(candidate?.detail), /^Left L1: /);
    return candidate;
  });
  await mixed.inspect();
  assert.deepEqual(mixed.encodings(), { "gitref=HEAD": "eucjp", file: "utf8" });
});

test("an already-open working file keeps its compatible non-default encoding even when compared with a different Git encoding", async (t) => {
  const h = await harness(t);
  await writeFile(h.filePath, AMBIGUOUS_KANA);
  h.gitBlobs.set(h.headUri.toString(), SJIS_JA);
  h.doc(h.headUri, "utf8");
  const working = h.doc(h.fileUri, "eucjp");
  h.show(h.headUri, h.fileUri);
  assert.equal(await h.align(), true);
  assert.deepEqual(h.encodings(), { "gitref=HEAD": "shiftjis", file: "eucjp" });
  h.updateStatus(working);
  assert.match(h.status.text, /^\$\(warning\) Left \(Git\): Shift JIS \/ CP932 \/ Right \(Working\): EUC-JP$/);
  assert.match(String(h.status.tooltip), /Left and right sides use different encodings/);
});

test("single-side Git views (such as deleted files) auto-detect encoding and allow rule registration", async (t) => {
  const h = await harness(t, { preview: true });
  const deletedPath = path.join(h.root, "deleted.dat");
  const deletedGitUri = new Uri("git", deletedPath, "ref=HEAD");
  h.gitBlobs.set(deletedGitUri.toString(), SJIS_JA);
  const gitDoc = h.doc(deletedGitUri, "utf8");
  h.showSingle(deletedGitUri);

  assert.equal(await h.align(), true);
  assert.equal(gitDoc.encoding, "shiftjis");
  assert.equal(h.shownDocs.length, 1);
  assert.equal(JSON.stringify(h.shownDocs[0]!.options), JSON.stringify({ preview: true, preserveFocus: true }));
  h.updateStatus(gitDoc);
  assert.equal(h.status.text, "$(pass) Git: Shift JIS / CP932 (auto-detected · no rule)");

  // Registering a file rule from a deleted Git document passes the git: URI so missing disk files do not fail
  h.hooks.command = (args) => {
    assert.equal((args[1] as Uri).scheme, "git");
    h.config.rules = [{ pattern: "deleted.dat", encoding: "shiftjis" }];
    return true;
  };
  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "convertRule" || item.action === "convertFile"), false);
    return items.find((item) => item.action === "registerFile");
  });
  await h.inspect();
  assert.equal(h.commands.at(-1)?.[0], "autoEncoding.configureFile");
  h.updateStatus(gitDoc);
  assert.equal(h.status.text, "$(pass) Git: Shift JIS / CP932");
});

test("rename comparisons inherit open working file encoding or rule fallback across paths", async (t) => {
  const h = await harness(t);
  const oldGit = new Uri("git", path.join(h.root, "old-dir", "before.txt"), "ref=HEAD");
  const newFile = Uri.file(path.join(h.root, "legacy", "after.txt"));
  await writeFile(h.filePath, "placeholder");
  h.doc(oldGit, "utf8");
  h.doc(newFile, "shiftjis");
  h.show(oldGit, newFile);
  assert.equal(await h.align(), true);
  assert.equal(h.documents.find((d) => d.uri === oldGit)?.encoding, "shiftjis");

  const byRule = await harness(t);
  byRule.config.rules = [{ pattern: "legacy/**", encoding: "eucjp" }];
  const oldRuleGit = new Uri("git", path.join(byRule.root, "outside", "before.txt"), "ref=HEAD");
  const newRuleGit = new Uri("git", path.join(byRule.root, "legacy", "after.txt"), "ref=~");
  byRule.doc(oldRuleGit, "utf8");
  byRule.doc(newRuleGit, "utf8");
  byRule.show(oldRuleGit, newRuleGit);
  assert.equal(await byRule.align(), true);
  assert.equal(byRule.documents.find((d) => d.uri === oldRuleGit)?.encoding, "eucjp");
  assert.equal(byRule.documents.find((d) => d.uri === newRuleGit)?.encoding, "eucjp");
});

test("multi-diff tabs align loaded reopenable sides without calling vscode.diff and skip virtual/unloaded entries", async (t) => {
  const h = await harness(t);
  const secondPath = path.join(h.root, "second.txt");
  const secondFile = Uri.file(secondPath);
  const unloadedPath = path.join(h.root, "unloaded.txt");
  const unloadedFile = Uri.file(unloadedPath);
  const unloadedGit = new Uri("git", unloadedPath, "ref=HEAD");
  const virtualOriginal = new Uri("chat-editing-snapshot-text-model", secondPath, "session=1");
  await writeFile(h.filePath, SJIS_JA);
  await writeFile(secondPath, SJIS_JA);
  await writeFile(unloadedPath, SJIS_JA);
  h.gitBlobs.set(h.headUri.toString(), SJIS_JA);
  h.gitBlobs.set(unloadedGit.toString(), SJIS_JA);

  h.doc(h.headUri, "utf8");
  h.doc(h.fileUri, "utf8");
  const virtualDoc = h.doc(virtualOriginal, "utf8");
  const secondDoc = h.doc(secondFile, "utf8");

  h.showMultiDiff([[h.headUri, h.fileUri], [virtualOriginal, secondFile], [unloadedGit, unloadedFile]], secondFile);
  assert.equal(await h.align(), true);

  assert.equal(h.documents.find((d) => d.uri === h.headUri)?.encoding, "shiftjis");
  assert.equal(h.documents.find((d) => d.uri === h.fileUri)?.encoding, "shiftjis");
  assert.equal(secondDoc.encoding, "shiftjis");
  assert.equal(virtualDoc.encoding, "utf8");
  assert.equal(h.opened.some((entry) => entry.uri.toString() === unloadedFile.toString() || entry.uri.toString() === unloadedGit.toString()), false);
  assert.equal(h.commands.length, 0);
  assert.equal(h.opened.some((entry) => entry.uri.scheme === "chat-editing-snapshot-text-model"), false);

  h.updateStatus(secondDoc);
  assert.match(String(h.status.text), /Left \(Original \(Virtual\)\): UTF-8 \/ Right \(Working\): Shift JIS \/ CP932/);
  assert.match(String(h.status.tooltip), /Virtual snapshot sides cannot change encoding/);

  h.vsc.window.activeTextEditor = undefined as unknown as { document: Doc };
  h.picks.push((items: Record<string, unknown>[]) => {
    const choose = items.find((item) => item.action === "choose");
    assert.equal(choose?.description, "Both sides · keep diff view");
    return undefined;
  });
  await h.inspect();

  h.vsc.window.activeTextEditor = { document: secondDoc };
  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "original"), false);
    assert.equal(items.some((item) => item.action === "modified"), true);
    const choose = items.find((item) => item.action === "choose");
    assert.equal(choose?.description, "Working / Git side only · keep diff view");
    const openWorking = items.find((item) => item.action === "openWorkingFile");
    assert.ok(openWorking, "openWorkingFile action should be offered");
    return openWorking;
  });
  await h.inspect();
  assert.equal(h.shownDocs.at(-1)?.doc.uri.toString(), secondFile.toString());
});

test("embedded git diff views outside tabGroups align git and working file sides via hintUri without calling vscode.diff", async (t) => {
  const h = await harness(t);
  await writeFile(h.filePath, SJIS_JA);
  h.gitBlobs.set(h.headUri.toString(), SJIS_JA);
  const gitDoc = h.doc(h.headUri, "utf8");
  const workingDoc = h.doc(h.fileUri, "utf8");

  // No diff tab in tabGroups (e.g. Agents Window inline Changes pane while chat tab is active)
  assert.equal(await (h.runtime.alignActiveComparison as (hint?: unknown) => Promise<boolean>)(h.headUri), true);
  assert.equal(gitDoc.encoding, "shiftjis");
  assert.equal(workingDoc.encoding, "shiftjis");
  assert.equal(h.commands.length, 0);
});
