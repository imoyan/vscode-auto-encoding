import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

type Runtime = typeof import("../src/extension.js") & typeof import("../src/editorEncoding.js");
type Listener = (value: unknown) => unknown;

const bundle = build({
  stdin: {
    contents: 'export { activate } from "./src/extension.ts"; export { inspectActiveFile, currentFileInspection, isManualEncodingOverride } from "./src/editorEncoding.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
});

class Emitter {
  private listeners: Listener[] = [];
  public event = (listener: Listener) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((item) => item !== listener); } };
  };
  public fire(value?: unknown): void {
    this.listeners.forEach((listener) => listener(value));
  }
  public dispose(): void { this.listeners = []; }
}

class Cancellation {
  private emitter = new Emitter();
  public token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  public cancel(): void { this.token.isCancellationRequested = true; this.emitter.fire(); }
  public dispose(): void { this.emitter.dispose(); }
}

class Uri {
  public readonly path: string;
  public constructor(
    public readonly fsPath: string,
    public readonly scheme = "file",
    public readonly query = "",
    public readonly fragment = "",
  ) {
    this.path = fsPath;
  }
  public static file(value: string): Uri { return new Uri(value, "file"); }
  public static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...parts), base.scheme, base.query, base.fragment);
  }
  public static parse(value: string): Uri {
    const parsed = new URL(value);
    return new Uri(parsed.pathname, parsed.protocol.replace(/:$/, ""), parsed.search.replace(/^\?/, ""), parsed.hash.replace(/^#/, ""));
  }
  public with(change: { path?: string; scheme?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.path ?? this.fsPath, change.scheme ?? this.scheme, change.query ?? this.query, change.fragment ?? this.fragment);
  }
  public toString(): string {
    return this.scheme === "file"
      ? pathToFileURL(this.fsPath).href
      : `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ""}`;
  }
}

class Diagnostic {
  public source?: string;
  public code?: string;
  public constructor(
    public readonly range: unknown,
    public readonly message: string,
    public readonly severity: number,
  ) {}
}

const SJIS_JA = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
const EUC_JA = Uint8Array.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec, 0x0a]);
const AMBIGUOUS_KANA = Uint8Array.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]);
const WIN1252_CAFE = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
const WIN1252_AA = Uint8Array.from([0xe0, 0x61, 0x0a]);
const WIN1252_AE = Uint8Array.from([0xe0, 0xe8, 0x0a]);
// UTF-16 LE "AB\n" without BOM -> contains null bytes or let's use UTF-8 opened as windows1252, or ISO-8859-1 / UTF-8
const UTF8_WITH_REPLACEMENT = new TextEncoder().encode("説明: \uFFFD\n");
const UTF8_CLEAN = new TextEncoder().encode("説明: ok\n");
const SJIS_JA_ASCII_OK = Uint8Array.from([0x90, 0xe0, 0x96, 0xbe, 0x3a, 0x20, 0x6f, 0x6b, 0x0a]); // "説明: ok\n" in Shift JIS

function testDecode(bytes: Uint8Array, encoding: string): string {
  if (encoding === "utf8" || encoding === "utf8bom") {
    const start = encoding === "utf8bom" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    return new TextDecoder("utf-8").decode(bytes.subarray(start));
  }
  if (encoding === "shiftjis") return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  if (encoding === "eucjp") return new TextDecoder("euc-jp", { fatal: true }).decode(bytes);
  if (encoding === "windows1252" || encoding === "iso88591") {
    return new TextDecoder("windows-1252", { fatal: true }).decode(bytes);
  }
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
  if (encoding === "windows1252" || encoding === "iso88591") {
    const out: number[] = [];
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code > 0xff || (code >= 0x80 && code <= 0x9f)) throw new Error("unrepresentable in single-byte");
      out.push(code);
    }
    return Uint8Array.from(out);
  }
  if (Array.from(text).every((ch) => ch.charCodeAt(0) < 0x80)) return new TextEncoder().encode(text);
  if (encoding === "shiftjis") {
    if (text === "日本語\n") return SJIS_JA;
    if (text === "説明: ok\n") return SJIS_JA_ASCII_OK;
    if (text === "､｢､､\n") return AMBIGUOUS_KANA;
    if (text === "// ASCII header line 1\n// ASCII header line 2\n､｢､､\n") {
      return Uint8Array.from([...new TextEncoder().encode("// ASCII header line 1\n// ASCII header line 2\n"), ...AMBIGUOUS_KANA]);
    }
    if (text === "濛\n") return WIN1252_AA;
    if (text === "琲\n") return WIN1252_AE;
    throw new Error("unrepresentable in shiftjis fixture");
  }
  if (encoding === "eucjp") {
    if (text === "日本語\n") return EUC_JA;
    if (text === "あい\n") return AMBIGUOUS_KANA;
    if (text === "// ASCII header line 1\n// ASCII header line 2\nあい\n") {
      return Uint8Array.from([...new TextEncoder().encode("// ASCII header line 1\n// ASCII header line 2\n"), ...AMBIGUOUS_KANA]);
    }
    if (text === "琥\n") return WIN1252_AE;
    throw new Error("unrepresentable in eucjp fixture");
  }
  throw new Error(`unsupported test encoding: ${encoding}`);
}

interface MockDoc {
  uri: Uri;
  fileName: string;
  encoding: string;
  version: number;
  isDirty: boolean;
  isClosed: boolean;
  lineCount: number;
  getText(): string;
  lineAt(): { range: { end: number } };
  offsetAt(position: number): number;
}

async function harness(t: TestContext, files: Record<string, Uint8Array>) {
  const root = await mkdtemp(path.join(tmpdir(), "editor-unruled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }

  const events = new Map<string, Emitter>();
  const on = (name: string) => {
    const emitter = new Emitter();
    events.set(name, emitter);
    return emitter.event;
  };
  const folder = { uri: Uri.file(root), name: "workspace", index: 0 };
  const config = new Map<string, unknown>();
  const state = new Map<string, unknown>();
  const warnings: { message: string; buttons: string[] }[] = [];
  const warningResponses: Array<string | undefined> = [];
  const errors: string[] = [];
  const picks: unknown[] = [];
  const shownPicks: { items: Record<string, unknown>[]; title?: string }[] = [];
  const reopenedCalls: { uri: Uri; encoding: string }[] = [];
  const diagnosticsMap = new Map<string, Diagnostic[]>();
  const documents: MockDoc[] = [];
  const status = {
    text: "",
    tooltip: "",
    command: "",
    backgroundColor: undefined as unknown,
    visible: false,
    show() { this.visible = true; },
    hide() { this.visible = false; },
    dispose() {},
  };

  const makeDoc = (name: string, encoding = "utf8", initialText?: string, uriOverride?: Uri): MockDoc => {
    const uri = uriOverride ?? Uri.file(path.join(root, name));
    const currentText = initialText ?? (uri.scheme === "file" ? testDecode(files[name] ?? new Uint8Array(), encoding) : "");
    const doc: MockDoc = {
      uri,
      fileName: uri.fsPath,
      encoding,
      version: 1,
      isDirty: false,
      isClosed: false,
      lineCount: 1,
      getText: () => currentText,
      lineAt: () => ({ range: { end: currentText.length } }),
      offsetAt: (position: number) => position,
    };
    const existingIndex = documents.findIndex((entry) => entry.uri.toString() === uri.toString());
    if (existingIndex >= 0) documents[existingIndex] = doc;
    else documents.push(doc);
    return doc;
  };

  let decodeOverride: ((bytes: Uint8Array, opts: { encoding: string }, fallback: (bytes: Uint8Array, opts: { encoding: string }) => Promise<string>) => Promise<string>) | undefined;
  let openDocumentOverride: ((uri: Uri, opts: { encoding?: string } | undefined, fallback: (uri: Uri, opts?: { encoding?: string }) => Promise<MockDoc>) => Promise<MockDoc>) | undefined;

  const workspace = {
    workspaceFolders: [folder],
    textDocuments: documents,
    getWorkspaceFolder: (uri: Uri) =>
      uri.scheme === "file" && (uri.fsPath === root || uri.fsPath.startsWith(root + path.sep)) &&
      workspace.workspaceFolders.some((entry) => entry.uri.toString() === folder.uri.toString())
        ? folder
        : undefined,
    getConfiguration: (section: string) => ({
      get: (key: string, fallback?: unknown) => section === "files" ? fallback : config.get(key) ?? fallback,
      inspect: (key: string) => ({ workspaceFolderValue: config.get(key) }),
    }),
    decode: async (bytes: Uint8Array, opts: { encoding: string }) =>
      decodeOverride ? decodeOverride(bytes, opts, async (b, o) => testDecode(b, o.encoding)) : testDecode(bytes, opts.encoding),
    encode: async (text: string, opts: { encoding: string }) => testEncode(text, opts.encoding),
    openTextDocument: async (uri: Uri, opts?: { encoding?: string }) => {
      const defaultOpen = async (targetUri: Uri, openOpts?: { encoding?: string }) => {
        const targetEncoding = openOpts?.encoding ?? "utf8";
        reopenedCalls.push({ uri: targetUri, encoding: targetEncoding });
        const existing = documents.find((entry) => entry.uri.toString() === targetUri.toString());
        const rel = path.relative(root, targetUri.fsPath).replaceAll(path.sep, "/");
        let raw = files[rel] ?? new Uint8Array();
        if (targetUri.scheme === "file") {
          try { raw = new Uint8Array(readFileSync(targetUri.fsPath)); } catch { /* keep fixture fallback */ }
        }
        const decoded = testDecode(raw, targetEncoding);
        if (existing) {
          existing.encoding = targetEncoding;
          existing.version += 1;
          existing.getText = () => decoded;
          existing.lineAt = () => ({ range: { end: decoded.length } });
          events.get("open")!.fire(existing);
          return existing;
        }
        const created = makeDoc(rel, targetEncoding, decoded, targetUri);
        events.get("open")!.fire(created);
        return created;
      };
      return openDocumentOverride ? openDocumentOverride(uri, opts, defaultOpen) : defaultOpen(uri, opts);
    },
    fs: {
      stat: async (uri: Uri) => { const s = await stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size }; },
      createDirectory: async (uri: Uri) => { await mkdir(uri.fsPath, { recursive: true }); },
      writeFile: async (uri: Uri, bytes: Uint8Array) => { await writeFile(uri.fsPath, bytes); },
      readFile: async (uri: Uri) => new Uint8Array(await readFile(uri.fsPath)),
      rename: async (from: Uri, to: Uri) => { await rename(from.fsPath, to.fsPath); },
      delete: async (uri: Uri, options?: { recursive?: boolean }) => { await rm(uri.fsPath, { recursive: options?.recursive ?? false }); },
      readDirectory: async (uri: Uri) => (await readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
    },
    createFileSystemWatcher: () => ({
      dispose() {},
      onDidChange: on("fileChange"),
      onDidCreate: on("fileCreate"),
      onDidDelete: on("fileDelete"),
    }),
    onDidChangeTextDocument: on("edit"),
    onDidOpenTextDocument: on("open"),
    onDidCloseTextDocument: on("close"),
    onWillSaveTextDocument: on("willSave"),
    onDidSaveTextDocument: on("save"),
    onDidChangeConfiguration: on("configuration"),
    onDidChangeWorkspaceFolders: on("folders"),
  };

  const window = {
    activeTextEditor: undefined as { document: MockDoc } | undefined,
    visibleTextEditors: [] as Array<{ document: MockDoc }>,
    onDidChangeActiveTextEditor: on("active"),
    onDidChangeVisibleTextEditors: on("visible"),
    createStatusBarItem: () => status,
    createWebviewPanel: () => ({ webview: { html: "", onDidDispose: () => ({ dispose() {} }) }, dispose() {}, reveal() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    registerFileDecorationProvider: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async (message: string, ...buttons: string[]) => {
      const rawArgs = buttons as unknown[];
      const labels = (typeof rawArgs[0] === "object" && rawArgs[0] !== null ? rawArgs.slice(1) : rawArgs) as string[];
      warnings.push({ message, buttons: labels });
      return warningResponses.shift();
    },
    withProgress: async (_options: unknown, action: (progress: unknown, token: unknown) => Promise<unknown>) => {
      const cts = new Cancellation();
      return action({ report() {} }, cts.token);
    },
    showErrorMessage: async (message: string) => {
      errors.push(message);
      return undefined;
    },
    showQuickPick: async (items: Record<string, unknown>[], options: { title?: string }) => {
      shownPicks.push({ items, title: options.title });
      const pick = picks.shift();
      return typeof pick === "function" ? pick(items) : pick;
    },
    showTextDocument: async (document: MockDoc) => {
      const editor = { document };
      window.activeTextEditor = editor;
      if (!window.visibleTextEditors.some((entry) => entry.document.uri.toString() === document.uri.toString())) {
        window.visibleTextEditors = [editor];
      }
      events.get("visible")!.fire(window.visibleTextEditors);
      events.get("active")!.fire(editor);
      return editor;
    },
  };

  const vscode = {
    Uri,
    Diagnostic,
    DiagnosticSeverity: { Warning: 1 },
    ThemeColor: class { public constructor(public readonly id: string) {} },
    ThemeIcon: class {},
    MarkdownString: class {},
    TreeItem: class {},
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    StatusBarAlignment: { Right: 2 },
    ProgressLocation: { Notification: 15 },
    FileType: { File: 1, Directory: 2 },
    EventEmitter: Emitter,
    CancellationTokenSource: Cancellation,
    languages: {
      createDiagnosticCollection: () => ({
        dispose() {},
        has(uri: Uri) { return diagnosticsMap.has(uri.toString()); },
        set(uri: Uri, entries: Diagnostic[]) {
          if (entries.length === 0) diagnosticsMap.delete(uri.toString());
          else diagnosticsMap.set(uri.toString(), entries);
        },
        delete(uri: Uri) { diagnosticsMap.delete(uri.toString()); },
      }),
    },
    commands: (() => {
      const registered = new Map<string, (...args: unknown[]) => unknown>();
      return {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
          registered.set(id, handler);
          return { dispose() { registered.delete(id); } };
        },
        executeCommand: async (id: string, ...args: unknown[]) => {
          const handler = registered.get(id);
          return handler ? await handler(...args) : undefined;
        },
      };
    })(),
    workspace,
    window,
  };

  const module = { exports: {} };
  const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  runInNewContext((await bundle).outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (id: string) => id === "vscode" ? vscode : nativeRequire(id),
    Buffer,
    process,
    console,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  });
  const runtime = module.exports as Runtime;
  const subscriptions: Array<{ dispose(): void }> = [];
  const memento = {
    get: (key: string) => state.get(key),
    update: async (key: string, value: unknown) => { state.set(key, value); },
  };
  runtime.activate({
    workspaceState: memento,
    subscriptions,
    extensionPath: process.cwd(),
    globalStorageUri: Uri.file(path.join(root, "storage")),
  } as unknown as import("vscode").ExtensionContext);
  t.after(() => subscriptions.forEach((item) => item.dispose()));

  const settle = async (ms = 40) => {
    await delay(ms);
    await setImmediate();
  };
  const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${description}`);
      await delay(10);
    }
    await setImmediate();
  };

  return {
    root,
    folder,
    files,
    runtime,
    config,
    state,
    warnings,
    warningResponses,
    errors,
    picks,
    shownPicks,
    reopenedCalls,
    status,
    workspace,
    window,
    events,
    command: async (name: string, ...args: unknown[]) =>
      vscode.commands.executeCommand(`autoEncoding.${name}`, ...args),
    setDecodeOverride: (fn: typeof decodeOverride) => { decodeOverride = fn; },
    setOpenDocumentOverride: (fn: typeof openDocumentOverride) => { openDocumentOverride = fn; },
    diagnosticsFor: (name: string) => diagnosticsMap.get(Uri.file(path.join(root, name)).toString()) ?? [],
    diagnosticsForUri: (uri: Uri) => diagnosticsMap.get(uri.toString()) ?? [],
    currentInspection: (doc: MockDoc) => runtime.currentFileInspection(doc as unknown as import("vscode").TextDocument),
    openVisible: async (name: string, encoding = "utf8", ready?: (doc: MockDoc) => boolean) => {
      const doc = makeDoc(name, encoding);
      const editor = { document: doc };
      window.activeTextEditor = editor;
      window.visibleTextEditors = [editor];
      events.get("open")!.fire(doc);
      events.get("visible")!.fire([editor]);
      events.get("active")!.fire(editor);
      if (ready) await waitFor(() => ready(doc), name);
      else await waitFor(() => runtime.currentFileInspection(doc as unknown as import("vscode").TextDocument) !== undefined || warnings.length > 0, name);
      await settle(40);
      return doc;
    },
    openVisibleWithoutWait: (name: string, encoding = "utf8", uriOverride?: Uri, initialText?: string) => {
      const doc = makeDoc(name, encoding, initialText, uriOverride);
      const editor = { document: doc };
      window.activeTextEditor = editor;
      window.visibleTextEditors = [editor];
      events.get("open")!.fire(doc);
      events.get("visible")!.fire([editor]);
      events.get("active")!.fire(editor);
      return doc;
    },
    openBackground: async (name: string, encoding = "utf8", uriOverride?: Uri, initialText?: string) => {
      const doc = makeDoc(name, encoding, initialText, uriOverride);
      events.get("open")!.fire(doc);
      await settle();
      return doc;
    },
    hideEditors: async () => {
      window.activeTextEditor = undefined;
      window.visibleTextEditors = [];
      events.get("visible")!.fire([]);
      events.get("active")!.fire(undefined);
      await settle();
    },
    closeDoc: async (doc: MockDoc) => {
      doc.isClosed = true;
      const key = doc.uri.toString();
      const idx = documents.findIndex((entry) => entry.uri.toString() === key);
      if (idx >= 0) documents.splice(idx, 1);
      window.visibleTextEditors = window.visibleTextEditors.filter((entry) => entry.document.uri.toString() !== key);
      if (window.activeTextEditor?.document.uri.toString() === key) {
        window.activeTextEditor = window.visibleTextEditors[0];
      }
      events.get("close")!.fire(doc);
      await settle();
    },
    showExistingInEditor: async (doc: MockDoc, ready?: () => boolean) => {
      const editor = { document: doc };
      window.activeTextEditor = editor;
      window.visibleTextEditors = [editor];
      events.get("visible")!.fire([editor]);
      events.get("active")!.fire(editor);
      if (ready) {
        await waitFor(ready, doc.fileName);
        await settle(40);
      } else {
        await settle();
      }
    },
    editDoc: async (doc: MockDoc, newText: string) => {
      doc.isDirty = true;
      doc.version += 1;
      doc.getText = () => newText;
      doc.lineAt = () => ({ range: { end: newText.length } });
      events.get("edit")!.fire({ document: doc, contentChanges: [{ text: newText }] });
      await settle(10);
    },
    saveDoc: async (doc: MockDoc, writtenBytes?: Uint8Array, options: { fireFileChange?: boolean } = {}) => {
      events.get("willSave")!.fire({ document: doc });
      await settle(10);
      const rel = path.relative(root, doc.uri.fsPath).replaceAll(path.sep, "/");
      const bytes = writtenBytes ?? testEncode(doc.getText(), doc.encoding);
      files[rel] = bytes;
      await writeFile(doc.uri.fsPath, bytes);
      doc.isDirty = false;
      doc.version += 1;
      events.get("save")!.fire(doc);
      await settle(10);
      if (options.fireFileChange !== false) {
        events.get("fileChange")!.fire(doc.uri);
      }
      await settle();
    },
    fireFileChange: async (name: string) => {
      events.get("fileChange")!.fire(Uri.file(path.join(root, name)));
      await settle();
    },
    fireConfigChange: async (section = "autoEncoding") => {
      events.get("configuration")!.fire({ affectsConfiguration: (target: string) => target === section || target.startsWith(`${section}.`) });
      await settle();
    },
    fireWorkspaceFoldersChange: async (folders: Array<typeof folder>) => {
      workspace.workspaceFolders = folders;
      events.get("folders")!.fire({ added: [], removed: [] });
      await settle();
    },
    waitFor,
    settle,
  };
}

test("when autoReopen=false, unconfigured unambiguous Shift JIS shows warning, diagnostics, and 1-button reopen on visible open", async (t) => {
  const h = await harness(t, { "legacy.txt": SJIS_JA });
  h.config.set("autoReopen", false);
  h.warningResponses.push("Reopen as Shift JIS / CP932");
  const doc = await h.openVisible("legacy.txt", "utf8", (d) => d.encoding === "shiftjis" && h.status.backgroundColor === undefined && h.diagnosticsFor("legacy.txt").length === 0);

  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.warnings[0]!.buttons, ["Reopen as Shift JIS / CP932"]);
  assert.match(h.warnings[0]!.message, /legacy\.txt.*UTF-8.*Shift JIS \/ CP932/);
  assert.equal(doc.encoding, "shiftjis");
  assert.equal(h.status.text, "$(pass) Shift JIS / CP932 (auto-detected · no rule)");
  assert.equal(h.status.backgroundColor, undefined);
  assert.deepEqual(h.diagnosticsFor("legacy.txt"), []);

  // Leaving warning unanswered keeps warning status and diagnostic
  const h2 = await harness(t, { "legacy2.txt": SJIS_JA });
  h2.config.set("autoReopen", false);
  h2.warningResponses.push(undefined);
  await h2.openVisible("legacy2.txt", "utf8", () => h2.warnings.length === 1);
  assert.equal(h2.status.text, "$(warning) Open: UTF-8 / Detected: Shift JIS / CP932 (no rule)");
  assert.ok(h2.status.backgroundColor);
  assert.equal(h2.diagnosticsFor("legacy2.txt").length, 1);
  assert.match(h2.diagnosticsFor("legacy2.txt")[0]!.message, /Shift JIS \/ CP932/);
});

test("default autoReopen=true reopens unambiguous unconfigured files silently without guessing ambiguous candidates", async (t) => {
  const h = await harness(t, { "sjis.txt": SJIS_JA, "ambiguous.txt": AMBIGUOUS_KANA });

  const sjis = await h.openVisible("sjis.txt", "utf8", (d) => d.encoding === "shiftjis" && h.status.text === "$(pass) Shift JIS / CP932 (auto-detected · no rule)" && h.status.backgroundColor === undefined);
  assert.equal(sjis.encoding, "shiftjis");
  assert.equal(h.warnings.length, 0);
  assert.equal(h.status.text, "$(pass) Shift JIS / CP932 (auto-detected · no rule)");

  const ambiguous = await h.openVisible("ambiguous.txt", "utf8", () => h.status.text === "$(warning) Open: UTF-8 (candidates · no rule)");
  assert.equal(h.warnings.length, 0);
  assert.equal(ambiguous.encoding, "utf8");
  assert.equal(h.diagnosticsFor("ambiguous.txt").length, 1);

  h.picks.push((items: Record<string, unknown>[]) => items.find((item) => item.action === "candidate" && item.encoding === "eucjp"));
  await h.command("inspectActiveFile");
  await h.waitFor(() => ambiguous.encoding === "eucjp" && h.diagnosticsFor("ambiguous.txt").length === 0, "reopened ambiguous via status bar");
  assert.equal(ambiguous.encoding, "eucjp");
  assert.deepEqual(h.diagnosticsFor("ambiguous.txt"), []);
});

test("unidentifiable decode loss (Windows-1252 opened as UTF-8) warns and clears after reopening as Windows-1252", async (t) => {
  const h = await harness(t, { "european.txt": WIN1252_CAFE });
  h.warningResponses.push("Inspect and Reopen");
  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "windows1252"),
  );
  const doc = await h.openVisible("european.txt", "utf8", (d) => d.encoding === "windows1252" && h.status.backgroundColor === undefined && h.diagnosticsFor("european.txt").length === 0);

  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.warnings[0]!.buttons, ["Inspect and Reopen"]);
  assert.match(h.shownPicks[0]!.title!, /Could not decode without loss/);
  assert.equal(doc.encoding, "windows1252");
  assert.equal(h.status.backgroundColor, undefined);
  assert.deepEqual(h.diagnosticsFor("european.txt"), []);

  // Without reopening, status bar and diagnostic retain decode-loss warning
  const h2 = await harness(t, { "european2.txt": WIN1252_CAFE });
  h2.warningResponses.push(undefined);
  await h2.openVisible("european2.txt", "utf8", () => h2.warnings.length === 1);
  assert.equal(h2.status.text, "$(warning) Open: UTF-8 (decode loss · no rule)");
  assert.ok(h2.status.backgroundColor);
  assert.equal(h2.diagnosticsFor("european2.txt").length, 1);
});

test("manual reopen on an unconfigured file is never overwritten by autoReopen", async (t) => {
  const h = await harness(t, { "sjis.txt": SJIS_JA });
  h.config.set("autoReopen", true);
  const doc = await h.openVisible("sjis.txt", "utf8", (d) => d.encoding === "shiftjis");
  assert.equal(doc.encoding, "shiftjis");

  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "utf8"),
  );
  await h.runtime.inspectActiveFile();
  await h.waitFor(() => doc.encoding === "utf8", "manual reopen as utf8");

  h.warnings.length = 0;
  await h.showExistingInEditor(doc);
  assert.equal(doc.encoding, "utf8");
  assert.equal(h.warnings.length, 0);
});

test("background document opens stay quiet while visible excluded files are still inspected", async (t) => {
  const h = await harness(t, { "bg.txt": SJIS_JA, "dist/excluded.txt": SJIS_JA });
  h.config.set("autoReopen", true);

  const bg = await h.openBackground("bg.txt", "utf8");
  assert.equal(bg.encoding, "utf8");
  assert.equal(h.reopenedCalls.length, 0);
  assert.equal(h.warnings.length, 0);

  await h.showExistingInEditor(bg, () => bg.encoding === "shiftjis");
  assert.equal(bg.encoding, "shiftjis");

  h.config.set("autoReopen", false);
  h.warningResponses.push(undefined);
  await h.openVisible("dist/excluded.txt", "utf8", () => h.warnings.length === 1);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.diagnosticsFor("dist/excluded.txt").length, 1);
});

test("configured rule with mismatched disk bytes warns instead of green pass and never auto-reopens outside the rule", async (t) => {
  const h = await harness(t, { "ruled.txt": SJIS_JA });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  h.config.set("autoReopen", true);
  h.warningResponses.push("Reopen as Shift JIS / CP932");

  const doc = await h.openVisible("ruled.txt", "utf8", (d) => d.encoding === "shiftjis" && h.status.text.includes("Open: Shift JIS / CP932"));
  // Did NOT auto-reopen to shiftjis even though autoReopen=true, because a rule exists; user clicked toast button
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.warnings[0]!.buttons, ["Reopen as Shift JIS / CP932"]);
  assert.match(h.warnings[0]!.message, /configured encoding UTF-8.*Shift JIS \/ CP932/);
  assert.equal(doc.encoding, "shiftjis");
  assert.equal(h.status.text, "$(warning) Open: Shift JIS / CP932 / Rule: UTF-8");
  assert.equal(h.diagnosticsFor("ruled.txt").length, 1);

  // Manual override prevents subsequent autoReopen / duplicate warning spam when revisiting the editor
  h.warnings.length = 0;
  await h.showExistingInEditor(doc);
  assert.equal(h.warnings.length, 0);
  assert.equal(doc.encoding, "shiftjis");

  // Leaving the mismatch unresolved shows rule-body mismatch status instead of $(pass)
  const h2 = await harness(t, { "ruled2.txt": SJIS_JA });
  h2.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  h2.warningResponses.push(undefined);
  await h2.openVisible("ruled2.txt", "utf8", () => h2.warnings.length === 1);
  assert.equal(h2.status.text, "$(warning) Rule: UTF-8 (Actual: Shift JIS / CP932)");
  assert.ok(h2.status.backgroundColor);
  assert.equal(h2.diagnosticsFor("ruled2.txt").length, 1);
});

test("warnOnSave protects against encoding-mismatched saves and newly introduced U+FFFD without spamming pre-existing valid UTF-8 U+FFFD", async (t) => {
  const h = await harness(t, {
    "has-fffd.md": UTF8_WITH_REPLACEMENT,
    "clean.md": UTF8_CLEAN,
    "loss.txt": WIN1252_CAFE,
  });

  // 1. Pre-existing valid UTF-8 with 1 U+FFFD: editing unrelated lines does NOT warn
  const hasFffd = await h.openVisible("has-fffd.md", "utf8");
  await h.editDoc(hasFffd, "説明: \uFFFD\n追記: ok\n");
  await h.saveDoc(hasFffd);
  assert.deepEqual(h.errors, []);

  // Adding a second U+FFFD DOES trigger save warning
  await h.editDoc(hasFffd, "説明: \uFFFD\n追記: \uFFFD\n");
  await h.saveDoc(hasFffd);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!, /^Save warning: has-fffd\.md contains replacement characters/);

  // 2. Clean UTF-8 file where U+FFFD is introduced during editing triggers save warning
  h.errors.length = 0;
  const clean = await h.openVisible("clean.md", "utf8");
  await h.editDoc(clean, "説明: broken \uFFFD\n");
  await h.saveDoc(clean);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!, /^Save warning: clean\.md contains replacement characters/);

  // 3. Mismatched / decodeLoss file saved without fixing encoding triggers save warning even when edited text has no U+FFFD
  h.errors.length = 0;
  h.warningResponses.push(undefined);
  const loss = await h.openVisible("loss.txt", "utf8");
  await h.editDoc(loss, "cafe without replacement\n");
  await h.saveDoc(loss);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!, /^Save warning: Saving loss\.txt while it could not be decoded without loss in UTF-8/);
});

test("background opens never inspect, auto-reopen, toast, or create diagnostics for ruled or unruled files, while resolving existing diagnostics when saved or reconfigured in background", async (t) => {
  const h = await harness(t, { "ruled-bg.txt": SJIS_JA, "unruled-bg.txt": SJIS_JA, "resolved.txt": SJIS_JA });
  h.config.set("rules", [{ pattern: "ruled-bg.txt", encoding: "shiftjis" }, { pattern: "resolved.txt", encoding: "shiftjis" }]);
  h.config.set("autoReopen", true);
  let decodeCalls = 0;
  h.setDecodeOverride(async (bytes, opts, fallback) => {
    decodeCalls += 1;
    return fallback(bytes, opts);
  });

  const ruledBg = await h.openBackground("ruled-bg.txt", "utf8");
  assert.equal(ruledBg.encoding, "utf8");
  assert.equal(h.reopenedCalls.length, 0);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.diagnosticsFor("ruled-bg.txt"), []);
  assert.equal(decodeCalls, 0);

  h.config.set("autoReopen", false);
  await h.fireConfigChange();
  const unruledBg = await h.openBackground("unruled-bg.txt", "utf8");
  assert.equal(unruledBg.encoding, "utf8");
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.diagnosticsFor("ruled-bg.txt"), []);
  assert.deepEqual(h.diagnosticsFor("unruled-bg.txt"), []);
  assert.equal(decodeCalls, 0);

  // Open resolved.txt visibly so a diagnostic is created, then hide it and resolve via configuration / save
  h.warningResponses.push(undefined);
  const resolved = await h.openVisible("resolved.txt", "utf8", () => h.warnings.length === 1);
  assert.equal(h.diagnosticsFor("resolved.txt").length, 1);
  await h.hideEditors();

  h.warnings.length = 0;
  decodeCalls = 0;
  h.config.set("rules", [{ pattern: "ruled-bg.txt", encoding: "shiftjis" }, { pattern: "resolved.txt", encoding: "utf8" }]);
  await h.fireConfigChange();
  assert.deepEqual(h.diagnosticsFor("resolved.txt"), []);
  assert.deepEqual(h.diagnosticsFor("ruled-bg.txt"), []);
  assert.equal(h.warnings.length, 0);
  assert.equal(decodeCalls, 0);

  // Background save of a previously-visible diagnosed file clears its resolved diagnostic without disk inspection
  h.config.set("rules", [{ pattern: "resolved.txt", encoding: "utf8" }]);
  h.warningResponses.push(undefined);
  await h.showExistingInEditor(resolved, () => h.diagnosticsFor("resolved.txt").length === 1 && h.warnings.length === 1);
  await h.hideEditors();
  h.warnings.length = 0;
  decodeCalls = 0;
  await h.editDoc(resolved, "説明: ok\n");
  await h.saveDoc(resolved, UTF8_CLEAN);
  assert.deepEqual(h.diagnosticsFor("resolved.txt"), []);
  assert.equal(h.warnings.length, 0);
  assert.equal(decodeCalls, 0);
});

test("delayed fileChange after save preserves baseline, avoids duplicate warning toasts, and re-inspects external changes", async (t) => {
  const h = await harness(t, { "has-fffd.md": UTF8_WITH_REPLACEMENT, "watch.txt": SJIS_JA });

  // 1. After saving with delayed fileChange, baseline stays intact and unrelated edits do not falsely warn
  const hasFffd = await h.openVisible("has-fffd.md", "utf8");
  await h.editDoc(hasFffd, "説明: \uFFFD\n追記: 1\n");
  await h.saveDoc(hasFffd); // fires save + fileChange
  assert.equal(h.currentInspection(hasFffd)?.status, "ok");
  assert.equal(h.currentInspection(hasFffd)?.initialHadReplacementCharacter, true);
  assert.equal(h.currentInspection(hasFffd)?.initialReplacementCharacterCount, 1);
  assert.deepEqual(h.errors, []);

  await h.editDoc(hasFffd, "説明: \uFFFD\n追記: 2\n");
  await h.saveDoc(hasFffd);
  assert.deepEqual(h.errors, []);

  // 2. Unresolved mismatch after save + delayed fileChange does NOT re-toast the same warningKey
  h.config.set("autoReopen", false);
  h.warningResponses.push(undefined);
  const watchDoc = await h.openVisible("watch.txt", "utf8", () => h.warnings.length === 1);
  assert.equal(h.warnings.length, 1);
  await h.editDoc(watchDoc, "edited");
  await h.saveDoc(watchDoc, SJIS_JA); // mock keeps SJIS bytes on disk -> same warningKey
  assert.equal(h.warnings.length, 1);
  assert.equal(h.currentInspection(watchDoc)?.status, "detectedMismatch");

  // 3. External fileChange fixing disk bytes clears warning/diagnostic and updates status without editor text change
  h.files["watch.txt"] = UTF8_CLEAN;
  await writeFile(watchDoc.uri.fsPath, UTF8_CLEAN);
  await h.fireFileChange("watch.txt");
  await h.waitFor(() => h.currentInspection(watchDoc)?.status === "ok" && h.diagnosticsFor("watch.txt").length === 0, "external fix cleared");
  assert.equal(h.status.text, "$(symbol-text) UTF-8 (no rule)");
});

test("onDidChangeWorkspaceFolders keeps dirty baselines and re-evaluates open documents", async (t) => {
  const h = await harness(t, { "has-fffd.md": UTF8_WITH_REPLACEMENT, "clean-sjis.txt": SJIS_JA });
  h.config.set("autoReopen", false);
  const dirtyDoc = await h.openVisible("has-fffd.md", "utf8");
  await h.editDoc(dirtyDoc, "説明: \uFFFD\n編集: yes\n");

  const sjisBg = await h.openBackground("clean-sjis.txt", "utf8");
  h.warningResponses.push(undefined);
  await h.showExistingInEditor(sjisBg, () => h.warnings.length === 1);
  assert.equal(h.diagnosticsFor("clean-sjis.txt").length, 1);

  // Trigger workspace folder update while dirtyDoc is dirty and clean-sjis.txt is clean & visible
  h.warnings.length = 0;
  h.warningResponses.push(undefined);
  await h.fireWorkspaceFoldersChange([h.folder]);
  await h.waitFor(() => h.warnings.length === 1, "re-evaluated clean-sjis.txt after workspaceFolders change");
  assert.equal(h.currentInspection(dirtyDoc)?.initialHadReplacementCharacter, true);
  assert.equal(h.warnings.length, 1); // re-evaluated clean-sjis.txt because warned.clear() ran

  // Saving dirtyDoc after folder change still preserves its baseline (no false U+FFFD warning)
  await h.saveDoc(dirtyDoc);
  assert.deepEqual(h.errors, []);

  // Removing the workspace folder clears diagnostics on open documents
  await h.fireWorkspaceFoldersChange([]);
  assert.deepEqual(h.diagnosticsFor("clean-sjis.txt"), []);
});

test("closing a git: document never clears the working file: inspection baseline", async (t) => {
  const h = await harness(t, { "notes.md": UTF8_WITH_REPLACEMENT });
  const fileDoc = await h.openVisible("notes.md", "utf8");
  await h.editDoc(fileDoc, "説明: \uFFFD\n編集中\n");

  const gitUri = fileDoc.uri.with({ scheme: "git", query: "ref=HEAD" });
  const gitDoc = await h.openBackground("notes.md", "utf8", gitUri, "old");
  await h.closeDoc(gitDoc);

  const preserved = h.currentInspection(fileDoc);
  assert.equal(preserved?.status, "ok");
  assert.equal(preserved?.initialHadReplacementCharacter, true);
  assert.equal(preserved?.initialReplacementCharacterCount, 1);

  await h.saveDoc(fileDoc);
  assert.deepEqual(h.errors, []);
});

test("autoReopen falls back to warnOnOpen without looping when openTextDocument returns the original encoding, and resets failure state on save/fileChange/close/config", async (t) => {
  // 1. Unruled detectedMismatch with failing openTextDocument
  const h1 = await harness(t, { "loop.txt": SJIS_JA });
  h1.config.set("autoReopen", true);
  h1.warningResponses.push(undefined);
  let openAttempts = 0;
  h1.setOpenDocumentOverride(async (uri, opts, fallback) => {
    openAttempts += 1;
    const existing = h1.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
    if (existing && opts?.encoding === "shiftjis") {
      // Simulate VS Code ignoring encoding option and returning original encoding
      return existing;
    }
    return fallback(uri, opts);
  });

  const doc = await h1.openVisible("loop.txt", "utf8", () => h1.warnings.length === 1);
  assert.equal(doc.encoding, "utf8");
  assert.equal(openAttempts, 1);
  assert.equal(h1.warnings.length, 1);
  assert.deepEqual(h1.warnings[0]!.buttons, ["Reopen as Shift JIS / CP932"]);
  assert.equal(h1.diagnosticsFor("loop.txt").length, 1);
  const ops = h1.state.get("encodingOperations.v1") as Array<{ kind: string }> | undefined;
  assert.ok(!ops?.some((entry) => entry.kind === "reopen"));

  // Revisiting editor does not retry failed autoReopen or spam duplicate warnings
  await h1.showExistingInEditor(doc);
  assert.equal(openAttempts, 1);
  assert.equal(h1.warnings.length, 1);

  // fileChange clears failure record so autoReopen can succeed once openTextDocument works
  h1.setOpenDocumentOverride(undefined);
  await h1.fireFileChange("loop.txt");
  await h1.waitFor(() => doc.encoding === "shiftjis", "autoReopen recovers after fileChange");

  // 2. Ruled autoReopen with failing openTextDocument falls back to warnOnOpen and clears failure on save/config/close
  const h2 = await harness(t, { "ruled-loop.txt": SJIS_JA });
  h2.config.set("rules", [{ pattern: "**/*", encoding: "shiftjis" }]);
  h2.config.set("autoReopen", true);
  h2.warningResponses.push(undefined);
  let ruledAttempts = 0;
  h2.setOpenDocumentOverride(async (uri, opts, fallback) => {
    ruledAttempts += 1;
    const existing = h2.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
    if (existing && opts?.encoding === "shiftjis") return existing;
    return fallback(uri, opts);
  });

  const ruledDoc = await h2.openVisible("ruled-loop.txt", "utf8", () => h2.warnings.length === 1);
  assert.equal(ruledDoc.encoding, "utf8");
  assert.equal(ruledAttempts, 1);
  assert.deepEqual(h2.warnings[0]!.buttons, ["Reopen with Expected Encoding"]);

  await h2.showExistingInEditor(ruledDoc);
  assert.equal(ruledAttempts, 1);

  // Config change clears failure record
  h2.setOpenDocumentOverride(undefined);
  await h2.fireConfigChange();
  await h2.waitFor(() => ruledDoc.encoding === "shiftjis", "ruled autoReopen recovers after configChange");

  // Save and close also clear failure records
  const h3 = await harness(t, { "save-close-loop.txt": SJIS_JA });
  h3.config.set("autoReopen", true);
  h3.warningResponses.push(undefined);
  h3.setOpenDocumentOverride(async (uri, opts, fallback) => {
    const existing = h3.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
    if (existing && opts?.encoding === "shiftjis") return existing;
    return fallback(uri, opts);
  });
  const doc3 = await h3.openVisible("save-close-loop.txt", "utf8", () => h3.warnings.length === 1);
  h3.setOpenDocumentOverride(undefined);
  await h3.editDoc(doc3, "dirty");
  await h3.saveDoc(doc3, SJIS_JA, { fireFileChange: false });
  await h3.waitFor(() => doc3.encoding === "shiftjis", "autoReopen recovers after save");

  const h4 = await harness(t, { "close-loop.txt": SJIS_JA });
  h4.config.set("autoReopen", true);
  h4.warningResponses.push(undefined);
  h4.setOpenDocumentOverride(async (uri, opts, fallback) => {
    const existing = h4.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
    if (existing && opts?.encoding === "shiftjis") return existing;
    return fallback(uri, opts);
  });
  const doc4 = await h4.openVisible("close-loop.txt", "utf8", () => h4.warnings.length === 1);
  await h4.closeDoc(doc4);
  h4.setOpenDocumentOverride(undefined);
  const reopened4 = await h4.openVisible("close-loop.txt", "utf8", (d) => d.encoding === "shiftjis");
  assert.equal(reopened4.encoding, "shiftjis");
});

test("editing after ruleUnconfirmed or during reopening never interrupts with dirty reopen toasts and preserves queued config updates", async (t) => {
  const h = await harness(t, { "unconfirmed.java": UTF8_CLEAN, "queued.txt": SJIS_JA });
  h.config.set("rules", [{ pattern: "**/*.java", encoding: "shiftjis" }]);
  h.config.set("autoReopen", true);

  const doc = await h.openVisible("unconfirmed.java", "utf8", () => h.warnings.length === 1);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.warnings[0]!.buttons, []);
  assert.match(h.warnings[0]!.message, /keeping the current encoding/);

  // Typing 1 character must NOT trigger a new "Reopen with Expected Encoding" toast
  await h.editDoc(doc, "edited\n");
  assert.equal(h.warnings.length, 1);

  // Queued configuration change during reopening is not dropped
  let releaseOpen!: () => void;
  let enteredOpen = false;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  h.setOpenDocumentOverride(async (uri, opts, fallback) => {
    if (uri.fsPath.endsWith("queued.txt") && opts?.encoding === "shiftjis") {
      enteredOpen = true;
      await openGate;
    }
    return fallback(uri, opts);
  });
  h.config.set("rules", [{ pattern: "queued.txt", encoding: "shiftjis" }]);
  const queuedDoc = h.openVisibleWithoutWait("queued.txt", "utf8");
  await h.waitFor(() => enteredOpen && h.diagnosticsFor("queued.txt").length === 1, "initial rule check started");
  // Remove rule while reopening is awaiting openTextDocument -> queued config change re-evaluates to clean Shift JIS
  h.config.set("rules", []);
  const configPromise = h.fireConfigChange();
  releaseOpen();
  await configPromise;
  await h.waitFor(() => queuedDoc.encoding === "shiftjis" && h.diagnosticsFor("queued.txt").length === 0, "queued configuration change evaluated after reopen");
  assert.equal(queuedDoc.encoding, "shiftjis");
});

test("epoch protection retains initial disk baseline when editing begins before initial inspection completes", async (t) => {
  const h = await harness(t, { "race.md": UTF8_WITH_REPLACEMENT });
  let releaseDecode!: () => void;
  const decodeGate = new Promise<void>((resolve) => { releaseDecode = resolve; });
  h.setDecodeOverride(async (bytes, opts, fallback) => {
    await decodeGate;
    return fallback(bytes, opts);
  });

  const doc = h.openVisibleWithoutWait("race.md", "utf8");
  await h.settle(15);
  // User starts editing before initial inspectFileDocument completes
  await h.editDoc(doc, "説明: \uFFFD\n追記: edited\n");
  releaseDecode();
  await h.waitFor(() => h.currentInspection(doc) !== undefined, "baseline stored despite early edit");

  assert.equal(h.currentInspection(doc)?.initialHadReplacementCharacter, true);
  assert.equal(h.currentInspection(doc)?.initialReplacementCharacterCount, 1);
  await h.saveDoc(doc);
  assert.deepEqual(h.errors, []);
});

test("conversion or restore operation clears manual override and stale warnings", async (t) => {
  const h = await harness(t, { "manual.txt": SJIS_JA });
  h.config.set("autoReopen", true);
  const doc = await h.openVisible("manual.txt", "utf8", (d) => d.encoding === "shiftjis");
  assert.equal(doc.encoding, "shiftjis");

  // User manually overrides back to UTF-8
  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "utf8"),
  );
  await h.runtime.inspectActiveFile();
  await h.waitFor(() => doc.encoding === "utf8", "manual override to utf8");
  assert.equal(h.runtime.isManualEncodingOverride(doc.uri as unknown as import("vscode").Uri), true);

  // Real conversion + undo operation clears manual override and refreshes open document state
  h.warningResponses.push("Undo");
  assert.equal(await h.command("convertFile", doc.uri, "utf8"), true);
  assert.equal(h.runtime.isManualEncodingOverride(doc.uri as unknown as import("vscode").Uri), false);
  assert.equal(await h.command("undoLastConversion"), true);

  await h.showExistingInEditor(doc, () => doc.encoding === "shiftjis" && h.status.text.includes("Shift JIS / CP932"));
  assert.equal(doc.encoding, "shiftjis");

  // Failed manual reopen rolls back manualSides override so autoReopen/detection is not stuck disabled
  const hFail = await harness(t, { "rollback.txt": SJIS_JA });
  hFail.config.set("autoReopen", false);
  hFail.warningResponses.push(undefined);
  const rollbackDoc = await hFail.openVisible("rollback.txt", "utf8", () => hFail.warnings.length === 1);
  hFail.setOpenDocumentOverride(async () => { throw new Error("reopen failed"); });
  hFail.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "shiftjis"),
  );
  await hFail.runtime.inspectActiveFile();
  assert.equal(hFail.errors.length, 1);
  assert.equal(hFail.runtime.isManualEncodingOverride(rollbackDoc.uri as unknown as import("vscode").Uri), false);
});

test("warnOnOpen=false suppresses open toasts while keeping status/diagnostics, and non-file URIs are ignored", async (t) => {
  const h = await harness(t, { "quiet-sjis.txt": SJIS_JA, "quiet-ruled.txt": SJIS_JA });
  h.config.set("autoReopen", false);
  h.config.set("warnOnOpen", false);
  h.config.set("rules", [{ pattern: "quiet-ruled.txt", encoding: "utf8" }]);

  const unruled = await h.openVisible("quiet-sjis.txt", "utf8", (d) => h.currentInspection(d) !== undefined);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.diagnosticsFor("quiet-sjis.txt").length, 1);
  assert.equal(h.status.text, "$(warning) Open: UTF-8 / Detected: Shift JIS / CP932 (no rule)");
  assert.equal(unruled.encoding, "utf8");

  await h.openVisible("quiet-ruled.txt", "utf8", (d) => h.currentInspection(d) !== undefined);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.diagnosticsFor("quiet-ruled.txt").length, 1);
  assert.equal(h.status.text, "$(warning) Rule: UTF-8 (Actual: Shift JIS / CP932)");

  const untitledUri = new Uri("Untitled-1", "untitled");
  const untitled = h.openVisibleWithoutWait("Untitled-1", "utf8", untitledUri, "plain");
  await h.settle();
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.diagnosticsForUri(untitledUri), []);
  assert.equal(h.currentInspection(untitled), undefined);
  assert.equal(h.status.visible, false);
});

test("unresolved candidateMismatch (unruled and ruled) stays quiet without toast while keeping status/diagnostics, and ruled decodeLoss keeps 1-button prompt", async (t) => {
  const h = await harness(t, {
    "unruled-ambig.txt": AMBIGUOUS_KANA,
    "ruled-ambig.txt": AMBIGUOUS_KANA,
    "ruled-loss.txt": WIN1252_CAFE,
  });

  await h.openVisible("unruled-ambig.txt", "utf8", () => h.status.text === "$(warning) Open: UTF-8 (candidates · no rule)");
  assert.equal(h.warnings.length, 0);
  assert.equal(h.status.text, "$(warning) Open: UTF-8 (candidates · no rule)");
  assert.equal(h.diagnosticsFor("unruled-ambig.txt").length, 1);

  h.config.set("rules", [{ pattern: "ruled-*", encoding: "utf8" }]);
  await h.fireConfigChange();
  h.warnings.length = 0;
  await h.openVisible("ruled-ambig.txt", "utf8", () => h.status.text === "$(warning) Rule: UTF-8 (candidates)");
  assert.equal(h.warnings.length, 0);
  assert.equal(h.status.text, "$(warning) Rule: UTF-8 (candidates)");
  assert.equal(h.diagnosticsFor("ruled-ambig.txt").length, 1);

  h.warnings.length = 0;
  h.warningResponses.push(undefined);
  await h.openVisible("ruled-loss.txt", "utf8", () => h.warnings.length === 1 && h.status.text === "$(warning) Rule: UTF-8 (decode loss)");
  assert.deepEqual(h.warnings[0]!.buttons, ["Inspect and Reopen"]);
  assert.equal(h.status.text, "$(warning) Rule: UTF-8 (decode loss)");
  assert.equal(h.diagnosticsFor("ruled-loss.txt").length, 1);
});

test("onWillSaveTextDocument matches readResourceBytes byte limit for multibyte documents", async (t) => {
  const multibyte = new TextEncoder().encode("あ".repeat(400) + "\uFFFD\n"); // 402 chars, > 1024 UTF-8 bytes
  const h = await harness(t, { "multibyte.md": multibyte });
  h.config.set("maxFileSizeKB", 1);

  const doc = await h.openVisible("multibyte.md", "utf8", () => h.status.text === "$(symbol-text) UTF-8 (no rule)");
  assert.equal(h.currentInspection(doc), undefined);

  await h.editDoc(doc, "あ".repeat(400) + "\uFFFD\n");
  await h.saveDoc(doc, multibyte);
  assert.deepEqual(h.errors, []);
});

test("toast reopen button checks closed tabs and latest disk state before reopening", async (t) => {
  // 1. Tab closed before user clicks toast button
  const h1 = await harness(t, { "closed-before-click.txt": SJIS_JA });
  h1.config.set("autoReopen", false);
  let resolveToast1!: (value: string | undefined) => void;
  h1.window.showWarningMessage = (_msg: string, ...buttons: string[]) => {
    h1.warnings.push({ message: _msg, buttons });
    return new Promise<string | undefined>((resolve) => { resolveToast1 = resolve; });
  };
  const doc1 = await h1.openVisible("closed-before-click.txt", "utf8", () => h1.warnings.length === 1);
  await h1.closeDoc(doc1);
  resolveToast1("Reopen as Shift JIS / CP932");
  await h1.settle();
  assert.equal(h1.reopenedCalls.length, 0);
  assert.deepEqual(h1.diagnosticsFor("closed-before-click.txt"), []);

  // 2. Disk changed to valid UTF-8 before user clicks toast button
  const h2 = await harness(t, { "fixed-before-click.txt": SJIS_JA });
  h2.config.set("autoReopen", false);
  let resolveToast2!: (value: string | undefined) => void;
  h2.window.showWarningMessage = (_msg: string, ...buttons: string[]) => {
    h2.warnings.push({ message: _msg, buttons });
    return new Promise<string | undefined>((resolve) => { resolveToast2 = resolve; });
  };
  const doc2 = await h2.openVisible("fixed-before-click.txt", "utf8", () => h2.warnings.length === 1);
  h2.files["fixed-before-click.txt"] = UTF8_CLEAN;
  await writeFile(doc2.uri.fsPath, UTF8_CLEAN);
  resolveToast2("Reopen as Shift JIS / CP932");
  await h2.waitFor(
    () => h2.diagnosticsFor("fixed-before-click.txt").length === 0,
    "diagnostics cleared after stale toast check",
  );
  assert.equal(h2.reopenedCalls.length, 0);
  assert.deepEqual(h2.diagnosticsFor("fixed-before-click.txt"), []);
});

test("ruled UTF-8 file opened as UTF-8 with autoReopen=false keeps current reading without broken reopen button", async (t) => {
  const h = await harness(t, { "exception.java": UTF8_CLEAN });
  h.config.set("rules", [{ pattern: "**/*.java", encoding: "shiftjis" }]);
  h.config.set("autoReopen", false);

  const doc = await h.openVisible("exception.java", "utf8", () => h.warnings.length === 1);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.warnings[0]!.buttons, []);
  assert.match(h.warnings[0]!.message, /keeping the current encoding/);
  assert.equal(h.status.text, "$(warning) Open: UTF-8 / Rule: Shift JIS / CP932");
  assert.equal(h.diagnosticsFor("exception.java").length, 1);

  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "expected"), false);
    return undefined;
  });
  await h.command("inspectActiveFile");

  await h.editDoc(doc, "説明: edited\n");
  await h.saveDoc(doc);
  assert.deepEqual(h.errors, [
    "Save warning: exception.java is open as UTF-8, while the configured encoding rule is Shift JIS / CP932.",
  ]);
});

test("ruled ambiguous Shift JIS / EUC-JP file keeps candidates on UTF-8 open and accepts rule candidate via menu", async (t) => {
  const h = await harness(t, { "ambig.dat": AMBIGUOUS_KANA });
  h.config.set("rules", [{ pattern: "*.dat", encoding: "shiftjis" }]);
  h.config.set("autoReopen", true);
  h.warningResponses.push(undefined);

  const doc = await h.openVisible("ambig.dat", "utf8", () => h.status.text === "$(warning) Open: UTF-8 / Rule: Shift JIS / CP932 (candidates)");
  assert.equal(doc.encoding, "utf8");
  assert.equal(h.reopenedCalls.length, 0);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.status.text, "$(warning) Open: UTF-8 / Rule: Shift JIS / CP932 (candidates)");
  assert.match(h.diagnosticsFor("ambig.dat")[0]!.message, /Current encoding \(UTF-8\) and configured rule \(Shift JIS \/ CP932\)/);

  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "expected"), false);
    return items.find((item) => item.action === "candidate" && item.encoding === "shiftjis");
  });
  await h.command("inspectActiveFile");
  await h.waitFor(() => doc.encoding === "shiftjis" && h.status.text === "$(pass) Rule: Shift JIS / CP932", "reopened as ruled shiftjis");
  assert.deepEqual(h.diagnosticsFor("ambig.dat"), []);
  assert.equal(h.runtime.isManualEncodingOverride(doc.uri as unknown as import("vscode").Uri), false);
});

test("three-way mismatch (rule, disk bytes, and current encoding all differ) guides to disk encoding without broken rule reopen", async (t) => {
  // 1. detectedMismatch: rule=shiftjis, disk=eucjp, doc=utf8
  const h1 = await harness(t, { "three-way.dat": EUC_JA });
  h1.config.set("rules", [{ pattern: "*.dat", encoding: "shiftjis" }]);
  h1.warningResponses.push(undefined);

  const doc1 = await h1.openVisible("three-way.dat", "utf8", () => h1.warnings.length === 1);
  assert.equal(h1.currentInspection(doc1)?.status, "detectedMismatch");
  assert.equal(h1.currentInspection(doc1)?.ruleConfirmed, false);
  assert.deepEqual(h1.warnings[0]!.buttons, ["Reopen as EUC-JP"]);
  assert.match(h1.warnings[0]!.message, /rule: Shift JIS \/ CP932.*EUC-JP/);
  assert.equal(h1.status.text, "$(warning) Open: UTF-8 / Rule: Shift JIS / CP932 (Actual: EUC-JP)");
  assert.match(h1.diagnosticsFor("three-way.dat")[0]!.message, /Detected: EUC-JP/);

  // Saving without fixing reports both rule mismatch and disk EUC-JP mismatch
  await h1.editDoc(doc1, "edited\n");
  await h1.saveDoc(doc1, EUC_JA);
  assert.equal(h1.errors.length, 1);
  assert.match(h1.errors[0]!, /configured encoding rule is Shift JIS \/ CP932\..*saved bytes \(EUC-JP\)/);

  // QuickPick offers detected EUC-JP reopen and switches cleanly
  h1.picks.push((items: Record<string, unknown>[]) => {
    const expected = items.find((item) => item.action === "expected");
    assert.ok(expected);
    assert.match(String(expected.label), /Reopen with auto-detected encoding \(EUC-JP\)/);
    return expected;
  });
  await h1.command("inspectActiveFile");
  await h1.waitFor(() => doc1.encoding === "eucjp" && h1.status.text === "$(warning) Open: EUC-JP / Rule: Shift JIS / CP932", "switched to EUC-JP");
  assert.equal(h1.currentInspection(doc1)?.status, "ok");

  // 2. decodeLoss: rule=shiftjis, disk=WIN1252_CAFE, doc=utf8 (no expected action button in QuickPick)
  const h2 = await harness(t, { "loss-three-way.dat": WIN1252_CAFE });
  h2.config.set("rules", [{ pattern: "*.dat", encoding: "shiftjis" }]);
  h2.warningResponses.push(undefined);

  const doc2 = await h2.openVisible("loss-three-way.dat", "utf8", () => h2.warnings.length === 1);
  assert.equal(h2.currentInspection(doc2)?.status, "decodeLoss");
  assert.equal(h2.currentInspection(doc2)?.ruleConfirmed, false);
  assert.deepEqual(h2.warnings[0]!.buttons, ["Inspect and Reopen"]);
  assert.equal(h2.status.text, "$(warning) Open: UTF-8 / Rule: Shift JIS / CP932 (decode loss)");

  h2.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "expected"), false);
    return undefined;
  });
  await h2.command("inspectActiveFile");
});

test("manual reopen to a round-trippable single-byte encoding clears warnings even if bytes overlap Shift JIS or EUC-JP", async (t) => {
  const h = await harness(t, {
    "overlap-sjis.txt": WIN1252_AA,
    "overlap-both.txt": WIN1252_AE,
    "non-roundtrip.txt": SJIS_JA,
  });
  h.config.set("autoReopen", false);

  // Initial UTF-8 opens still flag overlapping bytes so autoGuessEncoding issues are detected
  h.warningResponses.push(undefined);
  const docAa = await h.openVisible("overlap-sjis.txt", "utf8", () => h.warnings.length === 1);
  assert.deepEqual(h.warnings[0]!.buttons, ["Reopen as Shift JIS / CP932"]);
  assert.equal(h.diagnosticsFor("overlap-sjis.txt").length, 1);

  // Even if VS Code fires a close event during openTextDocument encoding switch, manual override survives
  h.setOpenDocumentOverride(async (uri, opts, fallback) => {
    const existing = h.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
    if (existing && opts?.encoding === "windows1252") {
      h.events.get("close")!.fire(existing);
    }
    return fallback(uri, opts);
  });

  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "windows1252"),
  );
  await h.command("inspectActiveFile");
  await h.waitFor(() => docAa.encoding === "windows1252" && h.currentInspection(docAa)?.status === "ok", "reopened AA as windows1252");
  assert.equal(h.status.backgroundColor, undefined);
  assert.deepEqual(h.diagnosticsFor("overlap-sjis.txt"), []);
  assert.equal(h.runtime.isManualEncodingOverride(docAa.uri as unknown as import("vscode").Uri), true);

  await h.editDoc(docAa, "àa!\n");
  await h.saveDoc(docAa);
  assert.deepEqual(h.errors, []);

  // Same for bytes valid in both Shift JIS and EUC-JP (WIN1252_AE)
  h.warnings.length = 0;
  const docAe = await h.openVisible("overlap-both.txt", "utf8", () => h.status.text === "$(warning) Open: UTF-8 (candidates · no rule)");
  assert.equal(h.warnings.length, 0);
  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "windows1252"),
  );
  await h.command("inspectActiveFile");
  await h.waitFor(() => docAe.encoding === "windows1252" && h.currentInspection(docAe)?.status === "ok", "reopened AE as windows1252");
  assert.deepEqual(h.diagnosticsFor("overlap-both.txt"), []);

  // Reopening manually into a non-round-trippable encoding (Shift JIS file opened manually as UTF-8) keeps warnings
  h.warnings.length = 0;
  h.warningResponses.push("Reopen as Shift JIS / CP932");
  const docSjis = await h.openVisible("non-roundtrip.txt", "utf8", (d) => d.encoding === "shiftjis");
  h.picks.push(
    (items: Record<string, unknown>[]) => items.find((item) => item.action === "choose"),
    (items: Record<string, unknown>[]) => items.find((item) => item.encoding === "utf8"),
  );
  await h.command("inspectActiveFile");
  await h.waitFor(() => docSjis.encoding === "utf8", "reopened SJIS manually as utf8");
  assert.notEqual(h.currentInspection(docSjis)?.status, "ok");
  assert.equal(h.diagnosticsFor("non-roundtrip.txt").length, 1);
});

test("status bar inspectActiveFile exposes rule shortcut and file conversion only on eligible file editors", async (t) => {
  const h = await harness(t, {
    "mismatch-rule.txt": UTF8_CLEAN,
    "matched-bytes.txt": SJIS_JA,
  });
  h.config.set("autoReopen", false);
  h.config.set("warnOnOpen", false);
  h.config.set("rules", [{ pattern: "**/*", encoding: "shiftjis" }]);

  // 1. Disk bytes (UTF-8) disagree with shiftjis rule -> convertRule shortcut converts and refreshes state.
  const mismatchDoc = await h.openVisible("mismatch-rule.txt", "utf8");
  await h.waitFor(() => h.currentInspection(mismatchDoc)?.ruleConfirmed === false, "rule mismatch inspected");
  h.picks.push((items: Record<string, unknown>[]) => {
    assert.ok(items.some((item) => item.action === "convertRule" && item.encoding === "shiftjis"));
    assert.ok(items.some((item) => item.action === "convertFile"));
    return items.find((item) => item.action === "convertRule");
  });
  h.warningResponses.push("Convert");
  await h.command("inspectActiveFile");
  await h.waitFor(
    () => mismatchDoc.encoding === "shiftjis" && h.status.text === "$(pass) Rule: Shift JIS / CP932",
    "converted via inspectActiveFile convertRule shortcut",
  );
  assert.deepEqual(new Uint8Array(await readFile(mismatchDoc.uri.fsPath)), SJIS_JA_ASCII_OK);
  assert.deepEqual(h.diagnosticsFor("mismatch-rule.txt"), []);
  assert.equal(h.shownPicks.length, 1);

  // 2. Once converted and aligned with rule, convertRule is absent while convertFile remains available.
  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "convertRule"), false);
    assert.ok(items.some((item) => item.action === "convertFile"));
    return undefined;
  });
  await h.command("inspectActiveFile");

  // 3. When disk bytes already match rule (autoReopen=false, still opened in utf8), convertRule is NOT shown (reopen is right action).
  const matchedDoc = await h.openVisible("matched-bytes.txt", "utf8");
  await h.waitFor(() => h.currentInspection(matchedDoc)?.ruleConfirmed === true, "rule confirmed even while opened as utf8");
  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items.some((item) => item.action === "convertRule"), false);
    assert.ok(items.some((item) => item.action === "expected"));
    assert.ok(items.some((item) => item.action === "convertFile"));
    return undefined;
  });
  await h.command("inspectActiveFile");
});

test("inspectActiveFile ranks ambiguous candidates with non-ASCII line previews in normal editors", async (t) => {
  const withHeader = new Uint8Array([
    ...new TextEncoder().encode("// ASCII header line 1\n// ASCII header line 2\n"),
    ...AMBIGUOUS_KANA,
  ]);
  const h = await harness(t, { "header-ambig.txt": withHeader });
  await h.openVisible("header-ambig.txt", "utf8", () => h.status.text === "$(warning) Open: UTF-8 (candidates · no rule)");
  assert.equal(h.warnings.length, 0);

  h.picks.push((items: Record<string, unknown>[]) => {
    assert.equal(items[0]?.action, "candidate");
    assert.equal(items[0]?.encoding, "eucjp");
    assert.equal(items[0]?.description, "Likely · Display only (no save)");
    assert.match(String(items[0]?.detail), /^L3: /);
    assert.equal(items[1]?.action, "candidate");
    assert.equal(items[1]?.encoding, "shiftjis");
    assert.equal(items[1]?.description, "Display only (no save)");
    assert.match(String(items[1]?.detail), /^L3: /);
    return undefined;
  });
  await h.command("inspectActiveFile");
});
