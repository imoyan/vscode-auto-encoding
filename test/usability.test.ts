import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
  readFile,
  rename,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import { build } from "esbuild";
import { minimatch } from "minimatch";
import { classifyLineEndings, classifyTextLineEndings } from "../src/scanCore.js";

type Runtime = typeof import("../src/extension.js") &
  typeof import("../src/editorEncoding.js") &
  typeof import("../src/conversionSelection.js") &
  typeof import("../src/conversion.js");
type Listener = (value: unknown) => unknown;

const bundle = build({
  stdin: {
    contents:
      'export { activate } from "./src/extension.ts"; export { inspectActiveFile } from "./src/editorEncoding.ts"; export { selectConversion } from "./src/conversionSelection.ts"; export { ConversionManager } from "./src/conversion.ts";',
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
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((item) => item !== listener);
      },
    };
  };
  public fire(value?: unknown): void {
    this.listeners.forEach((listener) => listener(value));
  }
  public dispose(): void {
    this.listeners = [];
  }
}

class Cancellation {
  private emitter = new Emitter();
  public token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  public cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  public dispose(): void {
    this.emitter.dispose();
  }
}

class Uri {
  public scheme = "file";
  public path: string;
  public constructor(public fsPath: string) {
    this.path = fsPath;
  }
  public static file(value: string): Uri {
    return new Uri(value);
  }
  public static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...parts));
  }
  public static parse(value: string): Uri {
    return new Uri(fileURLToPath(value));
  }
  public with(changes: { path?: string }): Uri {
    return new Uri(changes.path ?? this.fsPath);
  }
  public toString(): string {
    return pathToFileURL(this.fsPath).href;
  }
}

async function harness(t: TestContext, input: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(path.join(tmpdir(), "encoding-usability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(input)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), data);
  }
  const events = new Map<string, Emitter>();
  const on = (name: string) => {
    const emitter = new Emitter();
    events.set(name, emitter);
    return emitter.event;
  };
  const folder = { uri: Uri.file(root), name: "workspace", index: 0 };
  const config = new Map<string, unknown>();
  const inheritedConfig = new Map<string, unknown>();
  const configReads = new Map<string, number>();
  const configFailures: string[] = [];
  const state = new Map<string, unknown>();
  const globalStateMap = new Map<string, unknown>();
  let syncedKeys: readonly string[] | undefined;
  let beforeStateUpdate: ((key: string, value: unknown) => void) | undefined;
  const unreadableDirectories = new Set<string>();
  const messages: string[] = [];
  const picks: unknown[] = [];
  const confirmations: string[] = [];
  const information: (string | Promise<string | undefined>)[] = [];
  const shownPicks: { items: Record<string, unknown>[]; title?: string; placeHolder?: string }[] = [];
  const searchPatterns: string[] = [];
  let decorationChanges = 0;
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let decorations: import("../src/ruleDecorations.js").EncodingDecorationProvider | undefined;
  let duringDecode: (() => void) | undefined;
  let progressCancellation: Cancellation | undefined;
  const disposable = { dispose() {} };
  const workspace = {
    workspaceFile: Uri.file(path.join(root, "test.code-workspace")) as Uri | undefined,
    workspaceFolders: [folder],
    textDocuments: [] as unknown[],
    asRelativePath: (uri: Uri) => path.relative(root, uri.fsPath),
    getWorkspaceFolder: (uri: Uri) =>
      workspace.workspaceFolders
        .filter(
          (candidate) =>
            uri.fsPath === candidate.uri.fsPath ||
            uri.fsPath.startsWith(candidate.uri.fsPath + path.sep),
        )
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0],
    getConfiguration: () => ({
      inspect: (key: string) => ({
        workspaceFolderValue: workspace.workspaceFile ? config.get(key) : undefined,
        workspaceValue: workspace.workspaceFile ? inheritedConfig.get(key) : config.get(key),
      }),
      get: (key: string, fallback?: unknown) => {
        configReads.set(key, (configReads.get(key) ?? 0) + 1);
        return config.get(key) ?? inheritedConfig.get(key) ?? fallback;
      },
      update: async (key: string, value: unknown) => {
        if (configFailures[0] === key) {
          configFailures.shift();
          throw new Error("設定保存失敗");
        }
        if (value === undefined) config.delete(key);
        else config.set(key, value);
        events.get("configuration")?.fire({ affectsConfiguration: () => true });
      },
    }),
    findFiles: async (
      pattern: { pattern: string; base?: Uri | { uri: Uri } },
      exclude: string,
      limit: number,
    ) => {
      searchPatterns.push(pattern.pattern);
      return Object.keys(input)
        .filter((name) => {
          const base = pattern.base && ("uri" in pattern.base ? pattern.base.uri : pattern.base);
          return !base || path.join(root, name).startsWith(base.fsPath + path.sep);
        })
        .filter(
          (name) =>
            minimatch(name, pattern.pattern, { dot: true }) &&
            !minimatch(name, exclude, { dot: true }),
        )
        .slice(0, limit)
        .map((name) => Uri.file(path.join(root, name)));
    },
    fs: {
      stat: async (uri: Uri) => {
        const s = await stat(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1, size: s.size };
      },
      createDirectory: async (uri: Uri) => {
        await mkdir(uri.fsPath, { recursive: true });
      },
      writeFile: async (uri: Uri, bytes: Uint8Array) => {
        await writeFile(uri.fsPath, bytes);
      },
      readFile: async (uri: Uri) => new Uint8Array(await readFile(uri.fsPath)),
      rename: async (from: Uri, to: Uri) => {
        await rename(from.fsPath, to.fsPath);
      },
      delete: async (uri: Uri, options?: { recursive?: boolean }) => {
        await rm(uri.fsPath, { recursive: options?.recursive ?? false });
      },
      readDirectory: async (uri: Uri) =>
        (await readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [
          entry.name,
          entry.isDirectory() ? 2 : 1,
        ]),
    },
    decode: async (bytes: Uint8Array, options: { encoding: string }) => {
      duringDecode?.();
      if (options.encoding !== "utf8" && options.encoding !== "utf8bom") {
        throw new Error("unsupported fixture encoding");
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    encode: async (text: string, options: { encoding: string }) => {
      if (options.encoding === "utf8bom") {
        return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
      }
      if (options.encoding !== "utf8") throw new Error("unsupported fixture encoding");
      return new TextEncoder().encode(text);
    },
    createFileSystemWatcher: () => ({
      ...disposable,
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
    activeTextEditor: undefined as { document: unknown } | undefined,
    onDidChangeActiveTextEditor: on("active"),
    createStatusBarItem: () => ({ ...disposable, hide() {}, show() {} }),
    registerFileDecorationProvider: (value: typeof decorations) => {
      decorations = value;
      return disposable;
    },
    showInformationMessage: async (message: string) => {
      messages.push(message);
      return information.shift();
    },
    showWarningMessage: async (message: string) => {
      messages.push(message);
      return confirmations.shift();
    },
    showQuickPick: async (
      items: Record<string, unknown>[],
      options: { title?: string; placeHolder?: string },
    ) => {
      shownPicks.push({ items, title: options.title, placeHolder: options.placeHolder });
      const pick = picks.shift();
      return typeof pick === "function" ? pick(items) : pick;
    },
    showErrorMessage: async (message: string) => {
      messages.push(message);
    },
    withProgress: async (
      _options: unknown,
      action: (progress: unknown, token: unknown) => Promise<unknown>,
    ) => {
      progressCancellation = new Cancellation();
      return action({ report() {} }, progressCancellation.token);
    },
  };
  const vscode = {
    ViewColumn: { Active: -1 },
    workspace,
    window,
    Uri,
    EventEmitter: Emitter,
    CancellationTokenSource: Cancellation,
    RelativePattern: class {
      constructor(
        public base: unknown,
        public pattern: string,
      ) {}
    },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {},
    StatusBarAlignment: { Right: 2 },
    ProgressLocation: { Notification: 15 },
    FileType: { File: 1, Directory: 2 },
    ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
    extensions: { getExtension: () => undefined },
    languages: { createDiagnosticCollection: () => ({ ...disposable, set() {}, delete() {} }) },
    commands: {
      registerCommand: (name: string, action: (...args: unknown[]) => Promise<unknown>) => {
        commands.set(name, action);
        return disposable;
      },
      executeCommand: async (name: string, ...args: unknown[]) => {
        if (
          name === "setContext" ||
          name === "vscode.open" ||
          name === "vscode.diff" ||
          name === "revealInExplorer" ||
          name === "workbench.action.openSettings"
        ) {
          return undefined;
        }
        return commands.get(name)?.(...args);
      },
    },
  };
  const module = { exports: {} };
  const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  runInNewContext((await bundle).outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === "vscode") return vscode;
      const native = nativeRequire(id);
      if (id !== "node:fs/promises") return native;
      return {
        ...native,
        opendir: async (directory: string, options: unknown) => {
          if (unreadableDirectories.has(path.relative(root, directory))) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          return native.opendir(directory, options);
        },
      };
    },
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
  const memento = {
    get: (key: string) => state.get(key),
    update: async (key: string, value: unknown) => {
      beforeStateUpdate?.(key, value);
      state.set(key, value);
    },
  };
  const globalMemento = {
    keys: () => [...globalStateMap.keys()],
    get: (key: string) => globalStateMap.get(key),
    update: async (key: string, value: unknown) => {
      beforeStateUpdate?.(key, value);
      if (value === undefined) globalStateMap.delete(key);
      else globalStateMap.set(key, value);
    },
    setKeysForSync: (keys: readonly string[]) => {
      syncedKeys = keys;
    },
  };
  const subscriptions: Array<{ dispose(): void }> = [];
  const context = {
    workspaceState: memento,
    globalState: globalMemento,
    subscriptions,
    extensionPath: process.cwd(),
    globalStorageUri: Uri.file(path.join(root, "storage")),
  } as unknown as import("vscode").ExtensionContext;
  runtime.activate(context);
  subscriptions.push(
    decorations!.onDidChangeFileDecorations(() => {
      decorationChanges++;
    }),
  );
  t.after(() => subscriptions.forEach((item) => item.dispose()));
  return {
    config,
    configFailures,
    state,
    globalState: globalStateMap,
    getSyncedKeys: () => syncedKeys,
    unreadableDirectories,
    messages,
    window,
    workspace,
    runtime,
    picks,
    confirmations,
    information,
    shownPicks,
    searchPatterns,
    configReads,
    inheritedConfig,
    configurationChanged: () =>
      events.get("configuration")!.fire({ affectsConfiguration: () => true }),
    foldersChanged: () => events.get("folders")!.fire(),
    changes: () => ({ decorations: decorationChanges }),
    command: (name: string, ...args: unknown[]) => commands.get(`autoEncoding.${name}`)!(...args),
    fileSelection: (name: string, rule?: string) =>
      runtime.selectConversion(
        context,
        () => rule,
        () => workspace.getConfiguration() as unknown as import("vscode").WorkspaceConfiguration,
        Uri.file(path.join(root, name)) as import("vscode").Uri,
        undefined,
        "file",
      ),
    selection: () =>
      runtime.selectConversion(
        context,
        () => undefined,
        () => workspace.getConfiguration() as unknown as import("vscode").WorkspaceConfiguration,
        folder.uri as import("vscode").Uri,
      ),
    uri: (name: string) => Uri.file(path.join(root, name)),
    save: async (name: string, text: string) => {
      const document = {
        uri: Uri.file(path.join(root, name)),
        fileName: name,
        encoding: "utf8",
        version: 1,
        isDirty: false,
        getText: () => text,
        lineCount: 1,
        lineAt: () => ({ range: { end: text.length } }),
        offsetAt: (position: number) => position,
      };
      events.get("willSave")!.fire({ document });
      await writeFile(document.uri.fsPath, text);
      events.get("save")!.fire(document);
    },
    edit: (name: string, text: string) => {
      const document = {
        uri: Uri.file(path.join(root, name)),
        fileName: name,
        encoding: "utf8",
        isDirty: true,
        getText: () => text,
      };
      workspace.textDocuments = [document];
      window.activeTextEditor = { document };
      events.get("edit")!.fire({ document, contentChanges: [{ text }] });
    },
    badge: (name: string) => {
      const decoration = decorations!.provideFileDecoration(
        Uri.file(path.join(root, name)) as import("vscode").Uri,
      );
      return decoration && "badge" in decoration ? decoration : undefined;
    },
    folderBadge: (name: string) =>
      decorations!.provideFileDecoration(Uri.file(path.join(root, name)) as import("vscode").Uri),
    cancelProgress: () => progressCancellation!.cancel(),
    duringDecode: (action: () => void) => {
      duringDecode = action;
    },
    beforeStateUpdate: (action: (key: string, value: unknown) => void) => {
      beforeStateUpdate = action;
    },
  };
}

test("setting budgets stop invalid operations and cache repeated editor lookups until invalidation", async (t) => {
  const h = await harness(t, { "a.txt": "hello\n" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  for (let index = 0; index < 500; index++) assert.equal(h.badge("a.txt")?.badge, "U8");
  assert.equal(h.configReads.get("rules"), 1);
  h.config.set("rules", [{ pattern: "*.txt", encoding: "shiftjis" }]);
  h.configurationChanged();
  assert.equal(h.badge("a.txt")?.badge, "SJ");
  assert.equal(h.configReads.get("rules"), 2);
  h.foldersChanged();
  assert.equal(h.badge("a.txt")?.badge, "SJ");
  assert.equal(h.configReads.get("rules"), 3);
  h.config.set("rules", Array(257).fill({ pattern: "**", encoding: "utf8" }));
  h.configurationChanged();
  for (let index = 0; index < 500; index++) assert.equal(h.badge("a.txt"), undefined);
  assert.equal(h.configReads.get("rules"), 4);
  assert.equal(h.messages.filter((message) => message.includes("evaluation limit")).length, 1);
});

test("setting budgets reject exclusion expansion before conversion enumeration", async (t) => {
  const h = await harness(t, { "a.txt": "hello\n" });
  h.config.set("conversionExclude", "{1..1000000000}");
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  await assert.rejects(h.selection(), /evaluation limit/);
  assert.equal(h.searchPatterns.length, 0);
});

test("current file inspection reports mixed endings from unsaved text and physical saved bytes", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "large.txt": "x".repeat(2048) });
  h.config.set("maxFileSizeKB", 1);

  h.edit("a.txt", "line1\r\nline2\n");
  h.picks.push(() => undefined);
  await h.runtime.inspectActiveFile();
  assert.match(String(h.shownPicks.at(-1)?.title), /Mixed EOL.*unsaved buffer/);

  const cleanDoc = {
    uri: h.uri("a.txt"),
    fileName: h.uri("a.txt").fsPath,
    encoding: "utf8",
    isDirty: false,
    getText: () => "line1\nline2\n",
  };
  h.workspace.textDocuments = [cleanDoc];
  h.window.activeTextEditor = { document: cleanDoc };
  h.picks.push(() => undefined);
  await h.runtime.inspectActiveFile();
  assert.match(String(h.shownPicks.at(-1)?.title), /Mixed EOL/);

  const largeDoc = {
    uri: h.uri("large.txt"),
    fileName: h.uri("large.txt").fsPath,
    encoding: "utf8",
    isDirty: false,
    getText: () => "x".repeat(2048),
  };
  h.workspace.textDocuments = [largeDoc];
  h.window.activeTextEditor = { document: largeDoc };
  h.picks.push(() => undefined);
  await h.runtime.inspectActiveFile();
  assert.match(String(h.shownPicks.at(-1)?.title), /Unchecked/);
});

test("document and byte inspection agree on CR, CRLF, LF, empty and non-ASCII text", () => {
  for (const text of ["", "plain", "日本語\n", "日本語\r\n", "日本語\r", "a\nb\r\nc\rd"]) {
    assert.deepEqual(
      classifyTextLineEndings(text),
      classifyLineEndings(new TextEncoder().encode(text), "utf8"),
    );
  }
});

test("conversion reports skipped paths and warns before replacing a normal backup", async (t) => {
  const h = await harness(t, {
    "ready.txt": "abc",
    "same.txt": new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
    "binary.txt": "a\0b",
    "large.txt": "x".repeat(2048),
  });
  h.config.set("maxFileSizeKB", 1);
  h.state.set("autoEncoding.lastConversionBackup", h.uri("backup").toString());
  h.information.push("View Excluded Reasons");
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
    undefined,
    (items: Record<string, unknown>[]) => items,
  );
  h.confirmations.push("Convert");
  const selection = await h.selection();
  assert.equal(selection?.selected.length, 1);
  assert.equal(selection?.selected[0]?.relativePath, "ready.txt");
  const report = h.shownPicks.find((pick) => pick.title?.includes("Excluded Files"))!;
  assert.ok(
    report.items.some(
      (item) => item.label === "binary.txt" && item.description === "Excluded as binary",
    ),
  );
  assert.ok(
    report.items.some(
      (item) => item.label === "large.txt" && item.description === "Exceeds file size limit",
    ),
  );
  assert.ok(h.messages.some((message) => message.includes("previous backup will be deleted")));
});

test("cancelling backup replacement yields no conversion; protected backups retain their notice", async (t) => {
  const h = await harness(t, { "ready.txt": "abc" });
  const backup = h.uri("backup").toString();
  h.state.set("autoEncoding.lastConversionBackup", backup);
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
    (items: unknown[]) => items,
  );
  assert.equal(await h.selection(), undefined);
  assert.equal(h.state.get("autoEncoding.lastConversionBackup"), backup);
  h.state.set("autoEncoding.protectedConversionBackup", backup);
  h.confirmations.push("Keep Backup and Continue", "Convert");
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
    (items: unknown[]) => items,
  );
  const before = h.messages.length;
  assert.ok(await h.selection());
  assert.ok(h.messages.slice(before).some((message) => message.includes("previous restore is incomplete")));
  assert.ok(
    !h.messages.slice(before).some((message) => message.includes("previous backup will be deleted")),
  );
});

test("Western single-byte ambiguity prompts source encoding and is never preselected for conversion", async (t) => {
  const h = await harness(t, { "western.txt": new Uint8Array([0xe9]) });
  const decode = h.workspace.decode;
  const encode = h.workspace.encode;
  h.workspace.decode = async (bytes, options) => {
    if (options.encoding === "iso88591" || options.encoding === "windows1252") {
      return String.fromCharCode(...bytes);
    }
    return decode(bytes, options);
  };
  h.workspace.encode = async (text, options) => {
    if (options.encoding === "iso88591" || options.encoding === "windows1252") {
      return Uint8Array.from(text, (char) => char.charCodeAt(0));
    }
    return encode(text, options);
  };
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    { encoding: "iso88591" },
    (items: Record<string, unknown>[]) => {
      assert.equal(items.length, 1);
      assert.equal(items[0]?.picked, false);
      assert.equal(items[0]?.needsConfirmation, true);
      return undefined;
    },
  );
  await h.selection();
  assert.ok(h.shownPicks.some((pick) => pick.items.some((item) => item.label === "western.txt")));
});

test("warnOnSave warns without rewriting successive saves and ignores removed enforceOnSave", async (t) => {
  const h = await harness(t, { "a.txt": "initial" });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8bom" }]);
  await h.save("a.txt", "first");
  await h.save("a.txt", "newest");
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "newest");
  assert.equal(h.messages.filter((message) => message.startsWith("Save warning:")).length, 2);

  h.messages.length = 0;
  h.config.set("enforceOnSave", true);
  h.config.set("warnOnSave", false);
  await h.save("a.txt", "quiet");
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "quiet");
  assert.equal(h.messages.filter((message) => message.startsWith("Save warning:")).length, 0);
});

test("single file conversion previews decoded ISO-2022-JP text, hides EOL-only presets, and converts to UTF-8", async (t) => {
  const jisBytes = Uint8Array.from([
    0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42, 0x0a,
  ]);
  const h = await harness(t, { "jis.txt": jisBytes });
  let hasEolOnlyPreset = true;
  h.picks.push((items: Record<string, unknown>[]) => {
    hasEolOnlyPreset = items.some((item) => !item.targetEncoding && Boolean(item.targetLineEnding));
    return items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding);
  });
  const selected = await h.fileSelection("jis.txt");
  assert.ok(selected);
  const placeHolder = h.shownPicks[0]?.placeHolder ?? "";
  assert.match(placeHolder, /ISO-2022-JP \(JIS\)/);
  assert.match(placeHolder, /Preview: L1: 日本語/);
  assert.equal(hasEolOnlyPreset, false);
  assert.equal(selected.sourceEncoding, "iso2022jp");
  assert.equal(selected.targetEncoding, "utf8");
});

test("save warns when a configured file contains a replacement character even if the encoding matches", async (t) => {
  const h = await harness(t, { "sample.java": "// 元のコメント" });
  h.config.set("rules", [{ pattern: "**/*.java", encoding: "utf8" }]);
  await h.save("sample.java", "// コメント\uFFFD");
  assert.ok(
    h.messages.some(
      (message) => message.startsWith("Save warning: sample.java") && message.includes("replacement characters"),
    ),
  );
  assert.equal(await readFile(h.uri("sample.java").fsPath, "utf8"), "// コメント\uFFFD");

  h.messages.length = 0;
  h.config.set("warnOnSave", false);
  await h.save("sample.java", "// コメント\uFFFD");
  assert.equal(h.messages.filter((message) => message.startsWith("Save warning:")).length, 0);

  h.config.set("warnOnSave", true);
  h.config.set("maxFileSizeKB", 1);
  await h.save("sample.java", "a".repeat(1024) + "\uFFFD");
  assert.equal(h.messages.filter((message) => message.startsWith("Save warning:")).length, 0);
});

test("shows the registered folder encoding badge and supports removing folder/file rules directly", async (t) => {
  const h = await harness(t, {
    "legacy/[source]/Main.java": "class Main {}",
    "legacy/[source]/Inherited.java": "class Inherited {}",
    "handwritten/Sub.java": "class Sub {}",
    "other.java": "",
    "not-a-folder": "",
  });
  h.config.set("rules", [
    { pattern: "legacy/\\[source\\]/Main.java", encoding: "utf8" },
    { pattern: "legacy/\\[source\\]/**", encoding: "shiftjis" },
    { pattern: "handwritten/**/*", encoding: "eucjp" },
    { pattern: "not-a-folder/**", encoding: "shiftjis" },
  ]);
  const folder = await h.folderBadge("legacy/[source]");
  assert.equal(folder?.badge, "SJ");
  assert.equal(folder?.color, undefined);
  assert.match(String(folder?.tooltip), /Folder rule: Shift JIS \/ CP932/);
  const handwrittenFolder = await h.folderBadge("handwritten");
  assert.equal(handwrittenFolder?.badge, "EJ");
  assert.equal(handwrittenFolder?.color, undefined);
  assert.equal(h.badge("legacy/[source]/Main.java")?.badge, "U8");
  assert.equal(h.badge("legacy/[source]/Main.java")?.color, undefined);
  assert.equal(h.badge("legacy/[source]/Inherited.java"), undefined);
  assert.equal(h.badge("handwritten/Sub.java"), undefined);
  assert.equal(await h.folderBadge("not-a-folder"), undefined);
  assert.equal(h.badge("other.java"), undefined);

  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.action === "remove"),
  );
  assert.equal(await h.command("configureFolder", h.uri("legacy/[source]")), true);
  assert.match(h.shownPicks.at(-1)!.title!, /Rule: Shift JIS \/ CP932/);
  assert.match(String(h.shownPicks.at(-1)!.items[0]?.description), /Current rule/);
  assert.equal(await h.folderBadge("legacy/[source]"), undefined);
});

test("file settings override a folder setting without changing sibling files and can be removed", async (t) => {
  const h = await harness(t, { "one.txt": "a", "two.txt": "b" });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.encoding === "utf8bom"),
  );
  await h.command("configureFile", h.uri("one.txt"));
  assert.equal(h.badge("one.txt")?.badge, "UB");
  assert.equal(h.badge("one.txt")?.color, undefined);
  assert.equal(h.badge("two.txt"), undefined);

  h.config.set("explorerBadges", "all");
  assert.equal(h.badge("two.txt")?.badge, "U8");
  assert.equal(h.badge("two.txt")?.color, undefined);
  h.config.delete("explorerBadges");

  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.action === "remove"),
  );
  await h.command("configureFile", h.uri("one.txt"));
  assert.equal(h.badge("one.txt"), undefined);
  h.config.set("explorerBadges", "all");
  assert.equal(h.badge("one.txt")?.badge, "U8");
});

test("removing the last rule persists an empty array so inherited rules do not reappear", async (t) => {
  const h = await harness(t, { "inherited/a.txt": "a" });
  h.inheritedConfig.set("rules", [{ pattern: "inherited/**", encoding: "shiftjis" }]);
  assert.equal((await h.folderBadge("inherited"))?.badge, "SJ");

  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.action === "remove"),
  );
  assert.equal(await h.command("configureFolder", h.uri("inherited")), true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.config.get("rules"))), []);
  assert.equal(await h.folderBadge("inherited"), undefined);
});

test("single file conversion skips folder enumeration and preserves EOL immediately after preset selection", async (t) => {
  const h = await harness(t, { "a.txt": "日本語\r\n内部\n", "b.txt": "other" });
  h.config.set("conversionExclude", "**/*");
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  const selection = await h.fileSelection("a.txt", "utf8bom");
  assert.equal(selection?.selected.length, 1);
  assert.equal(selection?.selected[0]?.uri.toString(), h.uri("a.txt").toString());
  assert.equal(selection?.targetEncoding, "utf8bom");
  assert.equal(selection?.targetLineEnding, undefined);
  assert.deepEqual(h.searchPatterns, []);
  assert.equal(h.shownPicks.length, 1);
  assert.equal(h.shownPicks[0]?.items[0]?.targetEncoding, "utf8bom");
  assert.match(String(h.shownPicks[0]?.items[0]?.description), /Rule target/);
  assert.equal(
    h.shownPicks[0]?.items.some((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    false,
  );
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "日本語\r\n内部\n");
});

test("single file conversion refuses dirty documents and supports cancelling preset picker", async (t) => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  h.workspace.textDocuments.push({ uri: h.uri("a.txt"), isDirty: true });
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.equal(h.shownPicks.length, 0);
  assert.ok(h.messages.some((message) => message.includes("save the file before converting")));
  h.workspace.textDocuments.length = 0;
  h.picks.push(() => undefined);
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "日本語\n");
});

test("single file conversion explains unrepresentable content without saving", async (t) => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "windows1252" && !item.targetLineEnding),
  );
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.ok(h.messages.some((message) => message.includes("Characters unrepresentable in target encoding")));
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "日本語\n");
});

test("single file conversion reports no change when source and target match", async (t) => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  assert.equal(await h.command("convertFile", h.uri("a.txt"), "utf8"), false);
  assert.ok(h.messages.some((message) => message.includes("No conversion needed")));
});

test("completed conversion survives a final backup metadata save failure", async (t) => {
  const h = await harness(t, { "ready.txt": "original" });
  let completedUpdates = 0;
  h.beforeStateUpdate((key, value) => {
    if (
      key === "autoEncoding.protectedConversionBackup" &&
      value === undefined &&
      ++completedUpdates === 2
    ) {
      throw new Error("PRIVATE_EXCEPTION_DETAIL");
    }
  });
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  h.confirmations.push("Convert");
  assert.equal(
    await h.command("convertFile", h.uri("ready.txt")),
    true,
    JSON.stringify({ messages: h.messages, picks: h.shownPicks, completedUpdates }),
  );
  assert.equal(completedUpdates, 2);
  assert.deepEqual(
    await readFile(h.uri("ready.txt").fsPath),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("original")]),
  );
  const session = h.state.get("autoEncoding.lastConversionBackup") as string;
  const backupFiles = await readdir(fileURLToPath(session));
  assert.ok(backupFiles.includes("000001.bin"));
  assert.equal(
    (await readFile(path.join(fileURLToPath(session), "000001.bin"))).toString(),
    "original",
  );
  assert.ok(
    h.messages.some((message) => message.includes("Converted 1 file(s)") && message.includes("Could not save backup metadata")),
  );
  assert.ok(h.messages.every((message) => !message.includes("PRIVATE_EXCEPTION_DETAIL")));
});

const LAST = "autoEncoding.lastConversionBackup";
const PROTECTED = "autoEncoding.protectedConversionBackup";

async function staleAfterBackupRegistration(
  t: TestContext,
  failure: (key: string, value: unknown, prev: string) => void,
) {
  const h = await harness(t, { "a.txt": "alpha", "b.txt": "beta" });
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  assert.equal(await h.command("convertFile", h.uri("a.txt")), true, JSON.stringify(h.messages));
  const prev = h.state.get(LAST) as string;
  let staled = false;
  h.beforeStateUpdate((key, value) => {
    if (!staled && key === LAST && typeof value === "string" && value !== prev) {
      staled = true;
      h.edit("b.txt", "edited");
    }
    failure(key, value, prev);
  });
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  const converted = await h.command("convertFile", h.uri("b.txt"));
  return { h, prev, converted };
}

test("stale target after backup registration keeps the previous conversion undoable when the pointer rollback keeps failing", async (t) => {
  const { h, prev, converted } = await staleAfterBackupRegistration(t, (key, value, prev) => {
    if (key === LAST && value === prev) throw new Error("PRIVATE_EXCEPTION_DETAIL");
  });
  assert.equal(converted, false);
  assert.ok(
    h.messages.some(
      (message) =>
        message.includes("Conversion failed.") &&
        message.includes("Could not save backup metadata") &&
        message.includes(fileURLToPath(prev)),
    ),
    JSON.stringify(h.messages),
  );
  assert.ok(h.messages.every((message) => !message.includes("PRIVATE_EXCEPTION_DETAIL")));
  assert.equal((await readFile(h.uri("b.txt").fsPath)).toString(), "beta");
  assert.ok((await readdir(fileURLToPath(prev))).includes("000001.bin"));
  assert.notEqual(h.state.get(LAST), prev);
  h.confirmations.push("Undo");
  await h.command("undoLastConversion");
  assert.equal((await readFile(h.uri("a.txt").fsPath)).toString(), "alpha");
  assert.equal(h.state.get(LAST), undefined);
  assert.equal(h.state.get(PROTECTED), undefined);
  await h.command("undoLastConversion");
  assert.deepEqual(await readdir(path.join(h.uri("storage").fsPath, "conversion-backups")), []);
  assert.ok(h.messages.some((message) => message.includes("No previous conversion to undo")));
});

test("second-stage protected pointer rollback failure is reported and repaired by Undo", async (t) => {
  const { h, prev, converted } = await staleAfterBackupRegistration(t, (key, value) => {
    if (key === PROTECTED && value === undefined) throw new Error("PRIVATE_EXCEPTION_DETAIL");
  });
  assert.equal(converted, false);
  assert.ok(
    h.messages.some((message) => message.includes("Could not save backup metadata")),
    JSON.stringify(h.messages),
  );
  assert.ok(h.messages.every((message) => !message.includes("PRIVATE_EXCEPTION_DETAIL")));
  assert.equal(h.state.get(LAST), prev);
  assert.notEqual(h.state.get(LAST), h.state.get(PROTECTED));
  assert.ok((await readdir(fileURLToPath(prev))).includes("000001.bin"));
  h.beforeStateUpdate(() => undefined);
  h.confirmations.push("Undo");
  await h.command("undoLastConversion");
  assert.equal((await readFile(h.uri("a.txt").fsPath)).toString(), "alpha");
  assert.equal(h.state.get(LAST), undefined);
  assert.equal(h.state.get(PROTECTED), undefined);
  assert.deepEqual(await readdir(path.join(h.uri("storage").fsPath, "conversion-backups")), []);
});

test("a later conversion repairs a one-shot pointer rollback failure before replacing the previous backup", async (t) => {
  let failed = false;
  const { h, converted } = await staleAfterBackupRegistration(t, (key, value, prev) => {
    if (!failed && key === LAST && value === prev) {
      failed = true;
      throw new Error("PRIVATE_EXCEPTION_DETAIL");
    }
  });
  assert.equal(converted, false);
  assert.ok(
    h.messages.some((message) => message.includes("Could not save backup metadata")),
    JSON.stringify(h.messages),
  );
  h.beforeStateUpdate(() => undefined);
  await writeFile(h.uri("c.txt").fsPath, "gamma");
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  assert.equal(await h.command("convertFile", h.uri("c.txt")), true, JSON.stringify(h.messages));
  const sessions = await readdir(path.join(h.uri("storage").fsPath, "conversion-backups"));
  const last = fileURLToPath(h.state.get(LAST) as string);
  assert.deepEqual(sessions, [path.basename(last)]);
  assert.ok((await readdir(last)).some((name) => name.endsWith(".bin")));
});

test("a second stale conversion while the pointer is still stuck keeps the real previous conversion undoable", async (t) => {
  const { h, prev } = await staleAfterBackupRegistration(t, (key, value, prev) => {
    if (key === LAST && value === prev) throw new Error("PRIVATE_EXCEPTION_DETAIL");
  });
  const stuck = h.state.get(LAST) as string;
  await writeFile(h.uri("c.txt").fsPath, "gamma");
  let staled = false;
  h.beforeStateUpdate((key, value) => {
    if (!staled && key === LAST && typeof value === "string" && value !== prev && value !== stuck) {
      staled = true;
      h.edit("c.txt", "edited");
    }
    if (key === LAST && value === prev) throw new Error("PRIVATE_EXCEPTION_DETAIL");
  });
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  assert.equal(await h.command("convertFile", h.uri("c.txt")), false);
  assert.ok(
    h.messages.filter((message) => message.includes(fileURLToPath(prev))).length >= 2,
    JSON.stringify(h.messages),
  );
  h.confirmations.push("Undo");
  await h.command("undoLastConversion");
  assert.equal((await readFile(h.uri("a.txt").fsPath)).toString(), "alpha");
});

test("rule registration places the active encoding first and accepts deleted Git resources", async (t) => {
  const h = await harness(t, { "legacy/open.dat": "abc\n" });
  const deletedTarget = h.uri("legacy/deleted.dat");
  const deletedGit = Object.assign(new Uri(deletedTarget.fsPath), {
    scheme: "git",
    with: () => deletedTarget,
    toString: () => `git://${deletedTarget.fsPath}?ref=HEAD`,
  });
  const gitDoc = {
    uri: deletedGit,
    fileName: deletedTarget.fsPath,
    encoding: "shiftjis",
    isDirty: false,
    version: 1,
    getText: () => "日本語\n",
  };
  h.workspace.textDocuments.push(gitDoc);
  h.window.activeTextEditor = { document: gitDoc };

  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.encoding === "shiftjis"),
  );
  await h.command("configureFile", deletedGit);
  assert.equal(h.shownPicks.at(-1)!.items[0]?.encoding, "shiftjis");
  assert.match(String(h.shownPicks.at(-1)!.items[0]?.description), /Current encoding/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.config.get("rules"))), [
    { pattern: "legacy/deleted.dat", encoding: "shiftjis" },
  ]);

  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.encoding === "shiftjis"),
  );
  await h.command("configureFolder", h.uri("legacy"));
  assert.equal(h.shownPicks.at(-1)!.items[0]?.encoding, "shiftjis");
  assert.match(String(h.shownPicks.at(-1)!.items[0]?.description), /Current encoding/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.config.get("rules"))), [
    { pattern: "legacy/**", encoding: "shiftjis" },
    { pattern: "legacy/deleted.dat", encoding: "shiftjis" },
  ]);
});

function installMultiEncodingCodec(h: Awaited<ReturnType<typeof harness>>): void {
  const sjisKnown = new Map<string, readonly number[]>([
    ["日", [0x93, 0xfa]],
    ["本", [0x96, 0x7b]],
    ["語", [0x8c, 0xea]],
    ["Ⅰ", [0x87, 0x54]],
    ["ｱ", [0xb1]],
    ["ア", [0x83, 0x41]],
  ]);
  const eucKnown = new Map<string, readonly number[]>([
    ["あ", [0xa4, 0xa2]],
    ["い", [0xa4, 0xa4]],
  ]);
  const encodeTable = (
    text: string,
    map: ReadonlyMap<string, readonly number[]>,
    encodingName: string,
  ) => {
    const out: number[] = [];
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code <= 0x7f) {
        out.push(code);
        continue;
      }
      if (encodingName === "shiftjis" && code >= 0xff61 && code <= 0xff9f) {
        out.push(code - 0xff61 + 0xa1);
        continue;
      }
      const entry = map.get(ch);
      if (!entry) throw new Error(`unrepresentable in ${encodingName}: ${ch}`);
      out.push(...entry);
    }
    return Uint8Array.from(out);
  };
  h.workspace.decode = async (bytes, options) => {
    if (options.encoding === "utf8" || options.encoding === "utf8bom") {
      const start =
        options.encoding === "utf8bom" &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
          ? 3
          : 0;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
    }
    if (options.encoding === "shiftjis") return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
    if (options.encoding === "eucjp") return new TextDecoder("euc-jp", { fatal: true }).decode(bytes);
    if (options.encoding === "windows1252") {
      return new TextDecoder("windows-1252", { fatal: true }).decode(bytes);
    }
    if (options.encoding === "iso88591") {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
    }
    throw new Error(`unsupported fixture encoding: ${options.encoding}`);
  };
  h.workspace.encode = async (text, options) => {
    if (options.encoding === "utf8") return new TextEncoder().encode(text);
    if (options.encoding === "utf8bom") {
      return Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    }
    if (options.encoding === "shiftjis") return encodeTable(text, sjisKnown, "shiftjis");
    if (options.encoding === "eucjp") return encodeTable(text, eucKnown, "eucjp");
    if (options.encoding === "windows1252" || options.encoding === "iso88591") {
      return Uint8Array.from(text, (ch) => {
        const code = ch.charCodeAt(0);
        if (code === 0x0192) return 0x83;
        if (code > 0xff || (code >= 0x80 && code <= 0x9f)) {
          throw new Error("unrepresentable single-byte");
        }
        return code;
      });
    }
    throw new Error(`unsupported fixture encoding: ${options.encoding}`);
  };
}

test("single file conversion supports 1-screen presets, EOL-only CP932 alias preservation, rule ordering, shortcuts and Explorer Uri[] safety", async (t) => {
  const aliasCrlf = Uint8Array.from([0xfa, 0x4a, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]);
  const sjisLf = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
  const h = await harness(t, {
    "alias.txt": aliasCrlf,
    "ja.txt": sjisLf,
    "ascii.txt": "plain\r\n",
  });
  installMultiEncodingCodec(h);
  h.config.set("rules", [
    { pattern: "ja.txt", encoding: "utf8" },
    { pattern: "ascii.txt", encoding: "shiftjis" },
  ]);

  // 1. EOL-only on CP932 alias file keeps 0xfa 0x4a untouched and undoes cleanly.
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => !item.targetEncoding && item.targetLineEnding === "lf"),
  );
  assert.equal(await h.command("convertFile", h.uri("alias.txt")), true);
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("alias.txt").fsPath)),
    Uint8Array.from([0xfa, 0x4a, 0x0a, 0x41, 0x0a]),
  );
  h.confirmations.push("Undo");
  assert.equal(await h.command("undoLastConversion"), true);
  assert.deepEqual(new Uint8Array(await readFile(h.uri("alias.txt").fsPath)), aliasCrlf);

  // 2. Combined encoding + EOL conversion in 1 screen shows current EOL and places rule encoding first.
  h.shownPicks.length = 0;
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8" && item.targetLineEnding === "crlf"),
  );
  assert.equal(await h.command("convertFile", h.uri("ja.txt")), true);
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("ja.txt").fsPath)),
    new TextEncoder().encode("日本語\r\n"),
  );
  assert.equal(h.shownPicks[0]?.items[0]?.targetEncoding, "utf8");
  assert.match(String(h.shownPicks[0]?.items[0]?.description), /current: LF/);
  assert.match(String(h.shownPicks[0]?.items[0]?.description), /Rule target/);
  assert.equal(
    h.shownPicks[0]?.items.some((item) => item.targetEncoding === "shiftjis" && !item.targetLineEnding),
    false,
  );

  // 3. Pure ASCII + shiftjis rule for EOL-only does not emit a false rule-mismatch confirmation warning.
  h.messages.length = 0;
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => !item.targetEncoding && item.targetLineEnding === "lf"),
  );
  assert.equal(await h.command("convertFile", h.uri("ascii.txt")), true);
  assert.equal(await readFile(h.uri("ascii.txt").fsPath, "utf8"), "plain\n");
  assert.equal(
    h.messages.some((message) => message.includes("configured encoding rule")),
    false,
  );

  // 4. Explorer Uri[] passed as second argument does NOT trigger shortcut bypass; string target DOES bypass preset picker.
  h.shownPicks.length = 0;
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8bom" && !item.targetLineEnding),
  );
  assert.equal(await h.command("convertFile", h.uri("ja.txt"), [h.uri("ja.txt")]), true);
  assert.equal(h.shownPicks.length, 1);

  h.shownPicks.length = 0;
  assert.equal(await h.command("convertFile", h.uri("ascii.txt"), "utf8bom"), true);
  assert.equal(h.shownPicks.length, 0);
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("ascii.txt").fsPath)),
    Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("plain\n")]),
  );
});

test("single file conversion prompts source with previews when bytes are ambiguous or conflict with a Western rule", async (t) => {
  const ambiguousEuc = Uint8Array.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]);
  const sjisOrWin1252 = Uint8Array.from([0x83, 0x41, 0x0a]);
  const h = await harness(t, {
    "ambig.txt": ambiguousEuc,
    "conflict.txt": sjisOrWin1252,
  });
  installMultiEncodingCodec(h);
  h.config.set("rules", [{ pattern: "conflict.txt", encoding: "windows1252" }]);

  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    { encoding: "eucjp" },
  );
  h.confirmations.push("Convert");
  assert.equal(await h.command("convertFile", h.uri("ambig.txt")), true);
  const ambigSourcePick = h.shownPicks.at(-1)!;
  assert.equal(ambigSourcePick.title, "Select Current Encoding");
  assert.equal(ambigSourcePick.items[0]?.encoding, "eucjp");
  assert.match(String(ambigSourcePick.items[0]?.description), /Likely/);
  assert.equal(ambigSourcePick.items[0]?.detail, "L1: あい");
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("ambig.txt").fsPath)),
    new TextEncoder().encode("あい\n"),
  );

  h.shownPicks.length = 0;
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    { encoding: "windows1252" },
  );
  h.confirmations.push("Convert");
  assert.equal(await h.command("convertFile", h.uri("conflict.txt")), true);
  const conflictPick = h.shownPicks.at(-1)!;
  assert.equal(conflictPick.title, "Select Current Encoding");
  assert.equal(conflictPick.items[0]?.encoding, "windows1252");
  assert.match(String(conflictPick.items[0]?.description), /Rule target/);
  assert.equal(conflictPick.items[0]?.detail, "L1: ƒA");
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("conflict.txt").fsPath)),
    new TextEncoder().encode("ƒA\n"),
  );
});

test("folder auto source conversion handles mixed encodings, preserves ambiguous rules only on EOL-only, and trusts clear CP932 in manual shiftjis mode", async (t) => {
  const bomCrlf = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("本文\r\n")]);
  const cp932Crlf = Uint8Array.from([0xfa, 0x4a, 0x0d, 0x0a, 0x93, 0xfa, 0x0d, 0x0a]);
  const eucAmbigCrlf = Uint8Array.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0d, 0x0a]);
  const westernCrlf = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]);
  const h = await harness(t, {
    "batch/bom.txt": bomCrlf,
    "batch/cp932.txt": cp932Crlf,
    "batch/utf8.txt": "既にUTF8\n",
    "batch/ambig.txt": eucAmbigCrlf,
    "batch/ruled-ambig.txt": eucAmbigCrlf,
    "batch/western.txt": westernCrlf,
  });
  installMultiEncodingCodec(h);
  h.config.set("rules", [{ pattern: "batch/ruled-ambig.txt", encoding: "eucjp" }]);

  // 1. Auto-detect folder encoding conversion to UTF-8 (without extra source picker prompt!).
  h.information.push("View Excluded Reasons");
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    undefined,
    (items: Record<string, unknown>[]) => {
      assert.deepEqual([...items.map((item) => item.label)].sort(), ["bom.txt", "cp932.txt"]);
      assert.ok(items.every((item) => item.picked === true && item.needsConfirmation === false));
      return items;
    },
  );
  h.confirmations.push("Convert");
  assert.equal(await h.command("convertFolder", h.uri("batch")), true);
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("batch/bom.txt").fsPath)),
    new TextEncoder().encode("本文\r\n"),
  );
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("batch/cp932.txt").fsPath)),
    new TextEncoder().encode("Ⅰ\r\n日\r\n"),
  );
  const excludedPick = h.shownPicks.find((pick) => pick.title?.includes("Excluded Files"))!;
  assert.equal(
    excludedPick.items.find((item) => item.label === "ambig.txt")?.description,
    "Encoding could not be uniquely identified",
  );
  assert.equal(
    excludedPick.items.find((item) => item.label === "western.txt")?.description,
    "Encoding could not be uniquely identified",
  );
  assert.equal(
    excludedPick.items.find((item) => item.label === "ruled-ambig.txt")?.description,
    "A different encoding rule applies",
  );
  assert.ok(h.messages.some((message) => message.includes("Converted 2 file(s) to UTF-8.")));
  h.confirmations.push("Undo");
  assert.equal(await h.command("undoLastConversion"), true);
  assert.deepEqual(new Uint8Array(await readFile(h.uri("batch/bom.txt").fsPath)), bomCrlf);
  assert.deepEqual(new Uint8Array(await readFile(h.uri("batch/cp932.txt").fsPath)), cp932Crlf);

  // 2. Auto-detect EOL-only conversion preserves each file encoding, CP932 alias bytes, and disambiguates ruled-ambig.txt.
  h.messages.length = 0;
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => !item.targetEncoding && item.targetLineEnding === "lf"),
    (items: Record<string, unknown>[]) => {
      assert.deepEqual(
        [...items.map((item) => item.label)].sort(),
        ["bom.txt", "cp932.txt", "ruled-ambig.txt"],
      );
      assert.ok(items.every((item) => item.picked === true && item.needsConfirmation === false));
      return items;
    },
  );
  h.confirmations.push("Convert");
  assert.equal(await h.command("convertFolder", h.uri("batch")), true);
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("batch/bom.txt").fsPath)),
    Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("本文\n")]),
  );
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("batch/cp932.txt").fsPath)),
    Uint8Array.from([0xfa, 0x4a, 0x0a, 0x93, 0xfa, 0x0a]),
  );
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("batch/ruled-ambig.txt").fsPath)),
    Uint8Array.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]),
  );
  assert.ok(
    h.messages.some((message) => message.includes("Converted line endings to LF in 3 file(s).")),
  );
  h.confirmations.push("Undo");
  assert.equal(await h.command("undoLastConversion"), true);

  // 3. Manual shiftjis re-extraction via "Specify Source Encoding & Rescan" selects clear CP932 alias file without false ISO-8859-1 confirmation warning.
  h.config.set("rules", []);
  h.information.push("Specify Source Encoding & Rescan");
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    { encoding: "shiftjis" },
    (items: Record<string, unknown>[]) => {
      const cp932 = items.find((item) => item.label === "cp932.txt");
      const ambig = items.find((item) => item.label === "ambig.txt");
      assert.equal(cp932?.picked, true);
      assert.equal(cp932?.needsConfirmation, false);
      assert.equal(ambig?.picked, false);
      assert.equal(ambig?.needsConfirmation, true);
      return undefined;
    },
  );
  assert.equal(await h.command("convertFolder", h.uri("batch")), false);
});

test("single file conversion previews non-ASCII lines across encodings, skips false BOM preview on ASCII, and enforces modal confirmation on ambiguous sources", async (t) => {
  const sjisLf = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
  const asciiBom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]);
  const ambiguousEuc = Uint8Array.from([0xa4, 0xa2, 0xa4, 0xa4, 0x0a]);
  const h = await harness(t, {
    "ja.txt": sjisLf,
    "ascii-bom.txt": asciiBom,
    "ambig.txt": ambiguousEuc,
  });
  installMultiEncodingCodec(h);

  // 1. Shift JIS single-file preset shows decoded non-ASCII preview and converts without modal confirmation.
  h.picks.push((items: Record<string, unknown>[]) =>
    items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
  );
  assert.equal(await h.command("convertFile", h.uri("ja.txt")), true);
  assert.match(String(h.shownPicks[0]?.placeHolder), /Preview: L1: 日本語/);
  assert.deepEqual(
    new Uint8Array(await readFile(h.uri("ja.txt").fsPath)),
    new TextEncoder().encode("日本語\n"),
  );

  // 2. Pure ASCII with UTF-8 BOM strips U+FEFF so no false Preview is shown.
  h.shownPicks.length = 0;
  h.picks.push(() => undefined);
  assert.equal(await h.command("convertFile", h.uri("ascii-bom.txt")), false);
  assert.doesNotMatch(String(h.shownPicks[0]?.placeHolder), /Preview:/);

  // 3. Ambiguous single file requires modal confirmation; cancelling aborts without modifying disk.
  h.shownPicks.length = 0;
  h.picks.push(
    (items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    { encoding: "eucjp" },
  );
  // No "Convert" pushed into confirmations -> user cancels modal
  assert.equal(await h.command("convertFile", h.uri("ambig.txt")), false);
  assert.deepEqual(new Uint8Array(await readFile(h.uri("ambig.txt").fsPath)), ambiguousEuc);
});

test(
  "outside-workspace single-file conversion and Undo work in workspace and empty windows while rejecting leaf symlinks and folder operations",
  { skip: process.platform === "win32" ? "symlink permissions vary on Windows" : false },
  async (t) => {
    const h = await harness(t, { "in-ws.txt": "inside\n" });
    installMultiEncodingCodec(h);
    assert.equal(h.getSyncedKeys()?.length, 0);

    const externalRoot = await mkdtemp(path.join(tmpdir(), "outside-ws-conversion-"));
    t.after(() => rm(externalRoot, { recursive: true, force: true }));
    const realSubdir = path.join(externalRoot, "real-worktree");
    const symlinkedParent = path.join(externalRoot, "linked-worktree");
    await mkdir(realSubdir, { recursive: true });
    await symlink(realSubdir, symlinkedParent, "dir");

    const sjisBytes = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
    const jisBytes = Uint8Array.from([
      0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42, 0x0a,
    ]);
    const extSjisPath = path.join(symlinkedParent, "ext-sjis.txt");
    const extJisPath = path.join(realSubdir, "ext-jis.txt");
    const leafSymlinkPath = path.join(realSubdir, "leaf-link.txt");
    await writeFile(extSjisPath, sjisBytes);
    await writeFile(extJisPath, jisBytes);
    await symlink(path.join(realSubdir, "ext-sjis.txt"), leafSymlinkPath);

    const extSjisUri = h.uri(extSjisPath);
    extSjisUri.fsPath = extSjisPath;
    extSjisUri.path = extSjisPath;
    const extJisUri = h.uri(extJisPath);
    extJisUri.fsPath = extJisPath;
    extJisUri.path = extJisPath;
    const leafSymlinkUri = h.uri(leafSymlinkPath);
    leafSymlinkUri.fsPath = leafSymlinkPath;
    leafSymlinkUri.path = leafSymlinkPath;
    const externalFolderUri = h.uri(realSubdir);
    externalFolderUri.fsPath = realSubdir;
    externalFolderUri.path = realSubdir;

    // 1. Leaf symlink outside workspace is rejected; folder conversion & rule setup outside workspace stay blocked.
    assert.equal(await h.command("convertFile", leafSymlinkUri, "utf8"), false);
    assert.equal(await h.command("convertFolder", externalFolderUri), false);
    assert.equal(await h.command("configureFile", extSjisUri), false);

    // 2. Outside-workspace file via symlinked parent converts + undoes in an open workspace window (stored in workspaceState).
    h.picks.push((items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    );
    assert.equal(await h.command("convertFile", extSjisUri), true);
    assert.equal(typeof h.state.get(LAST), "string");
    assert.equal(h.globalState.get(LAST), undefined);
    assert.deepEqual(
      new Uint8Array(await readFile(extSjisPath)),
      new TextEncoder().encode("日本語\n"),
    );
    h.confirmations.push("Undo");
    assert.equal(await h.command("undoLastConversion"), true);
    assert.deepEqual(new Uint8Array(await readFile(extSjisPath)), sjisBytes);
    assert.equal(h.state.get(LAST), undefined);

    // 3. Empty window (no workspaceFolders) converts ISO-2022-JP outside-workspace file and undoes via window-scoped globalState.
    h.workspace.workspaceFolders = [];
    h.foldersChanged();
    h.picks.push((items: Record<string, unknown>[]) =>
      items.find((item) => item.targetEncoding === "utf8" && !item.targetLineEnding),
    );
    assert.equal(await h.command("convertFile", extJisUri), true);
    const windowId = h.state.get("autoEncoding.emptyWindowId") as string;
    assert.equal(typeof windowId, "string");
    assert.equal(typeof h.globalState.get(`${LAST}:${windowId}`), "string");
    assert.deepEqual(
      new Uint8Array(await readFile(extJisPath)),
      new TextEncoder().encode("日本語\n"),
    );

    // Simulate a second concurrent empty window sharing globalState + globalStorageUri: it must NOT delete Window 1's backup!
    const otherEmptyWindowState = new Map<string, unknown>();
    const otherContext = {
      workspaceState: {
        get: (key: string) => otherEmptyWindowState.get(key),
        update: async (key: string, value: unknown) => {
          if (value === undefined) otherEmptyWindowState.delete(key);
          else otherEmptyWindowState.set(key, value);
        },
      },
      globalState: {
        keys: () => [...h.globalState.keys()],
        get: (key: string) => h.globalState.get(key),
        update: async (key: string, value: unknown) => {
          if (value === undefined) h.globalState.delete(key);
          else h.globalState.set(key, value);
        },
        setKeysForSync: () => undefined,
      },
      subscriptions: [] as Array<{ dispose(): void }>,
      extensionPath: process.cwd(),
      globalStorageUri: Uri.file(path.join(h.uri("storage").fsPath)),
    } as unknown as import("vscode").ExtensionContext;
    await writeFile(extSjisPath, sjisBytes);
    const secondManager = new h.runtime.ConversionManager(
      otherContext,
      () => undefined,
      () => h.workspace.getConfiguration() as unknown as import("vscode").WorkspaceConfiguration,
    );
    assert.equal(await secondManager.convertFile(extSjisUri as unknown as import("vscode").Uri, "utf8"), true);
    const secondWindowId = otherEmptyWindowState.get("autoEncoding.emptyWindowId") as string;
    assert.notEqual(secondWindowId, windowId);
    assert.equal(typeof h.globalState.get(`${LAST}:${windowId}`), "string");
    assert.equal(typeof h.globalState.get(`${LAST}:${secondWindowId}`), "string");

    // Window 1 undoes its own file without touching Window 2's file, and Window 2 undoes its own file cleanly
    h.confirmations.push("Undo");
    assert.equal(await h.command("undoLastConversion"), true);
    assert.deepEqual(new Uint8Array(await readFile(extJisPath)), jisBytes);
    assert.deepEqual(
      new Uint8Array(await readFile(extSjisPath)),
      new TextEncoder().encode("日本語\n"),
    );
    assert.equal(h.globalState.get(`${LAST}:${windowId}`), undefined);

    h.confirmations.push("Undo");
    assert.equal(await secondManager.undoLastConversion(), true);
    assert.deepEqual(new Uint8Array(await readFile(extSjisPath)), sjisBytes);
    assert.equal(h.globalState.get(`${LAST}:${secondWindowId}`), undefined);
  },
);
