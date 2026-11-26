import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loadModule<T>(name: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(path.join(process.cwd(), "src", name), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  runInContext(
    output.outputText,
    createContext({
      exports,
      TextEncoder,
      TextDecoder,
      require: (id: string) => {
        if (id in dependencies) return dependencies[id];
        throw new Error(`Unexpected dependency: ${id}`);
      },
    }),
  );
  return exports as T;
}

test("resource rules preserve remote URI identity", () => {
  const remote = {
    scheme: "vscode-remote",
    authority: "ssh-remote+example",
    fsPath: "/workspace/a.txt",
    path: "/workspace/a.txt",
  };
  const rules = loadModule<{ fileUriForResource(uri: typeof remote): unknown }>("workspaceRules.ts", {
    "node:path": path,
    vscode: {
      Uri: {
        file: () => {
          throw new Error("remote URI must not become local");
        },
      },
    },
    "./rules.js": {},
    "./boundedGlob.js": {},
    "./l10n.js": { t: (s: string) => s },
  });
  assert.equal(rules.fileUriForResource(remote), remote);
});

test("conversion refresh only reloads an already-open clean document", async () => {
  const uri = { toString: () => "file:///work/a.txt" };
  const documents: Array<{ uri: typeof uri; isDirty: boolean }> = [];
  const calls: unknown[][] = [];
  const resources = loadModule<{ reopenCleanDocument(uri: unknown, encoding: string): Promise<void> }>(
    "conversionResources.ts",
    {
      "node:crypto": {},
      "./conversionCore.js": {},
      vscode: {
        workspace: {
          textDocuments: documents,
          openTextDocument: async (...args: unknown[]) => {
            calls.push(args);
          },
        },
      },
    },
  );
  await resources.reopenCleanDocument(uri, "utf8");
  assert.equal(calls.length, 0);
  documents.push({ uri, isDirty: true });
  await resources.reopenCleanDocument(uri, "utf8");
  assert.equal(calls.length, 0);
  documents[0]!.isDirty = false;
  await resources.reopenCleanDocument(uri, "utf8");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], uri);
});

test("Explorer badge setting gates rule badges cleanly", () => {
  let enabled = true;
  const uri = { scheme: "file", fsPath: "/workspace/a.txt", toString: () => "file:///workspace/a.txt" };
  const decorations = loadModule<{
    EncodingDecorationProvider: new () => {
      provideFileDecoration(value: unknown): { badge: string } | undefined;
    };
  }>("ruleDecorations.ts", {
    vscode: {
      ThemeColor: class {},
      EventEmitter: class {
        event = () => undefined;
        fire() {}
      },
      workspace: { getWorkspaceFolder: () => ({ name: "workspace", uri }) },
    },
    "./rules.js": {
      encodingInfo: (id: string) => ({ label: id, badge: "SJ" }),
      findFolderRegistration: () => undefined,
    },
    "./l10n.js": { t: (s: string) => s },
    "./workspaceRules.js": {
      fileUriForResource: (value: unknown) => value,
      configurationFor: () => ({ get: () => enabled }),
      resolveRule: () => ({ folder: { name: "workspace" }, rule: { pattern: "*.txt", encoding: "shiftjis" } }),
      getRules: () => [],
      relativePathFor: () => "a.txt",
      notifyConfigurationLimit: () => false,
    },
  });
  const provider = new decorations.EncodingDecorationProvider();
  assert.equal(provider.provideFileDecoration(uri)?.badge, "SJ");
  enabled = false;
  assert.equal(provider.provideFileDecoration(uri), undefined);
});

test("malformed backup JSON is ignored as an invalid record", async () => {
  let bytes = Buffer.from('{"version":');
  const backup = loadModule<{ readBackupRecord(uri: unknown): Promise<unknown> }>("conversionBackup.ts", {
    "node:crypto": {},
    vscode: {},
    "./conversionCore.js": {},
    "./localPathSafety.js": {},
    "./stableResourceRead.js": { readStableResource: async () => ({ bytes }) },
  });
  assert.equal(await backup.readBackupRecord({ scheme: "file" }), undefined);
  const valid = JSON.stringify({
    version: 1,
    originalUri: "CORRUPT",
    relativePath: "a",
    backupFile: "0.bin",
    originalHash: "a",
    convertedHash: "b",
    sourceEncoding: "utf8",
    targetEncoding: "utf8bom",
  });
  bytes = Buffer.concat([
    Buffer.from(valid.split("CORRUPT")[0]!),
    Buffer.from([0xff]),
    Buffer.from(valid.split("CORRUPT")[1]!),
  ]);
  assert.equal(await backup.readBackupRecord({ scheme: "file" }), undefined);
});

test("undo retains recovery state, rejects replacements and clears read-only completed data", async () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: "file", toString: () => fsPath });
  const state = new Map<string, unknown>([["last", "/storage/session"]]);
  let record = {
    version: 1,
    originalUri: "/workspace/a.txt",
    relativePath: "a.txt",
    backupFile: "0.bin",
    originalHash: "original",
    convertedHash: "converted",
    sourceEncoding: "utf8",
    targetEncoding: "utf8bom",
    recoveryRequired: false,
  };
  let disk = "converted";
  let writes = 0;
  let removed = false;
  let held = false;
  let writable = true;
  let replacement = false;
  let rejectWrite = false;
  const prompts: string[] = [];
  const touched: unknown[] = [];
  const recovery = loadModule<{
    restoreLastConversion(
      context: unknown,
      changed: () => void,
      stored?: string,
      onFileTouched?: (uri: unknown) => void,
      backup?: { lastKey: string; protectedKey: string; label: string; protectSkipped: boolean },
    ): Promise<boolean>;
  }>("conversionRecovery.ts", {
    vscode: {
      Uri: {
        parse: uri,
        file: uri,
        joinPath: (base: { fsPath: string }, name: string) => uri(`${base.fsPath}/${name}`),
      },
      FileType: { File: 1 },
      workspace: {
        getWorkspaceFolder: () => ({ uri: uri("/workspace") }),
        fs: {
          readDirectory: async () => [["0.json", 1]],
        },
      },
      window: {
        showWarningMessage: async (message: string, _options: unknown, action: string) => {
          assert.equal(held, false, "confirmation must not hold a writable file");
          prompts.push(message);
          return action;
        },
        showInformationMessage() {},
        showErrorMessage() {},
      },
    },
    "./conversionCore.js": { conversionBackupReadLimit: () => 1024 },
    "./l10n.js": {
      t: (s: string, ...args: unknown[]) =>
        s.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] === undefined ? m : String(args[Number(i)]))),
    },
    "./conversionBackup.js": {
      LAST_BACKUP_KEY: "last",
      PROTECTED_BACKUP_KEY: "protected",
      isConversionBackupSession: () => true,
      readBackupRecord: async () => record,
      readBackupResource: async () => ({ bytes: Buffer.from("original") }),
      writeJsonAtomic: async (_uri: unknown, value: typeof record) => {
        record = value;
      },
      deleteStoredBackupSession: async () => {
        removed = true;
      },
    },
    "./conversionResources.js": {
      isDirty: () => false,
      hashBytes: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
      reopenCleanDocument: async () => undefined,
    },
    "./pinnedLocalFile.js": {
      readPinnedLocalFile: async () => ({
        bytes: Buffer.from(disk),
        identity: "fixture",
        contentHash: disk,
      }),
      PinnedLocalFile: {
        open: async () => {
          if (!writable) return undefined;
          held = true;
          return {
            read: {
              bytes: Buffer.from(disk),
              identity: replacement ? "replacement" : "fixture",
              contentHash: disk,
            },
            isCurrent: async () => true,
            dispose: async () => {
              held = false;
            },
            writeConverted: async (bytes: Uint8Array) => {
              assert.equal(record.recoveryRequired, true);
              assert.equal(state.get("protected"), "/storage/session");
              if (rejectWrite) return false;
              writes++;
              if (writes === 1) {
                disk = "partial";
                throw new Error("disk full");
              }
              disk = Buffer.from(bytes).toString();
              return true;
            },
          };
        },
      },
    },
    "./localPathSafety.js": {
      resolveRealDirectory: async (value: string) => value,
      resolveRealPathWithin: async (_root: string, value: string) => value,
    },
  });
  const context = {
    globalStorageUri: uri("/storage"),
    workspaceState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
    },
  };
  assert.equal(
    await recovery.restoreLastConversion(context, () => undefined, undefined, (u) => touched.push(u)),
    false,
  );
  assert.equal(disk, "partial");
  assert.equal(touched.length, 0);
  assert.equal(removed, false);
  assert.equal(
    await recovery.restoreLastConversion(context, () => undefined, undefined, (u) => touched.push(u)),
    true,
  );
  assert.equal(disk, "original");
  assert.equal(touched.length, 1);
  assert.equal(removed, true);
  assert.equal(state.get("protected"), undefined);
  assert.ok(prompts.some((message) => message.includes("Replace the current contents")));

  writable = false;
  removed = false;
  state.set("last", "/storage/session");
  assert.equal(await recovery.restoreLastConversion(context, () => undefined), false);
  assert.equal(removed, true);
  assert.equal(state.get("last"), undefined);
  assert.equal(writes, 2);

  writable = true;
  replacement = true;
  disk = "converted";
  removed = false;
  state.set("last", "/storage/session");
  assert.equal(await recovery.restoreLastConversion(context, () => undefined), false);
  assert.equal(disk, "converted");
  assert.equal(writes, 2);
  assert.equal(removed, false);
  assert.equal(state.get("protected"), "/storage/session");
  assert.equal(held, false);

  replacement = false;
  rejectWrite = true;
  record = { ...record, recoveryRequired: false };
  state.delete("protected");
  assert.equal(
    await recovery.restoreLastConversion(
      context,
      () => undefined,
      "/storage/session",
      undefined,
      { lastKey: "last", protectedKey: "protected", label: "変換", protectSkipped: false },
    ),
    false,
  );
  assert.equal(record.recoveryRequired, false);
  assert.equal(state.get("protected"), undefined);
  assert.equal(disk, "converted");
  assert.equal(writes, 2);
  assert.equal(held, false);
});

test("file-backed UNC storage reaches filesystem containment checks", async () => {
  let checks = 0;
  const backup = loadModule<{ isConversionBackupSession(root: unknown, candidate: unknown): Promise<boolean> }>(
    "conversionBackup.ts",
    {
      "node:crypto": {},
      vscode: { env: {} },
      "./conversionCore.js": {},
      "./stableResourceRead.js": {},
      "./localPathSafety.js": {
        isConversionBackupSessionPath: async () => {
          checks++;
          return true;
        },
      },
    },
  );
  const root = { scheme: "file", authority: "server", fsPath: "//server/share/storage" };
  const session = { ...root, fsPath: "//server/share/storage/conversion-backups/session" };
  assert.equal(await backup.isConversionBackupSession(root, session), true);
  assert.equal(checks, 1);
  assert.equal(await backup.isConversionBackupSession(root, { ...session, authority: "other" }), false);
  assert.equal(
    await backup.isConversionBackupSession(
      { ...root, scheme: "vscode-userdata" },
      { ...session, scheme: "vscode-userdata" },
    ),
    false,
  );
  assert.equal(checks, 1);
});

test("reopening a comparison side preserves both URIs and labels their encodings", async () => {
  const uri = (value: string, scheme: string) => ({
    scheme,
    fsPath: value,
    toString: () => `${scheme}:${value}`,
  });
  const original = uri("/a.txt", "git");
  const modified = uri("/a.txt", "file");
  class Diff {
    constructor(
      public original: unknown,
      public modified: unknown,
    ) {}
  }
  const input = new Diff(original, modified);
  const documents = [
    { uri: original, encoding: "shiftjis", isDirty: false },
    { uri: modified, encoding: "utf8", isDirty: false },
  ];
  const calls: unknown[][] = [];
  const editor = loadModule<{
    reopenWithExpectedEncoding(document: unknown, match: unknown): Promise<void>;
    updateStatus(status: unknown, document: unknown): void;
    diagnosticFor(document: unknown): unknown;
  }>("editorEncoding.ts", {
    "node:path": path,
    "./candidatePreview.js": { rankDecodedCandidates: () => [] },
    "./scanCore.js": { classifyEncoding: async () => ({ kind: "match", detectedEncoding: "utf8bom" }) },
    "./fileLimits.js": {},
    "./stableResourceRead.js": {
      readStableResource: async () => ({ bytes: new Uint8Array([0xef, 0xbb, 0xbf]), mtime: 1, size: 3 }),
      resourceStillMatchesRead: async () => true,
    },
    "./workspaceRules.js": {
      resolveRule: () => ({ rule: { encoding: "utf8bom" } }),
      fileUriForResource: (value: unknown) => value,
      configurationFor: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      clearWorkspaceRuleCache: () => undefined,
    },
    "./rules.js": { encodingInfo: (id: string) => ({ label: id }), ENCODINGS: [] },
    "./l10n.js": {
      t: (s: string, ...args: unknown[]) =>
        s.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] === undefined ? m : String(args[Number(i)]))),
    },
    vscode: {
      TabInputTextDiff: Diff,
      workspace: {
        textDocuments: documents,
        decode: async () => "",
        encode: async () => new Uint8Array(),
        openTextDocument: async (selected: unknown, options: { encoding: string }) => {
          const doc = documents.find((entry) => entry.uri === selected)!;
          doc.encoding = options.encoding;
          return doc;
        },
      },
      window: {
        tabGroups: { activeTabGroup: { activeTab: { input } } },
        showTextDocument: () => {
          throw new Error("must keep comparison");
        },
        showErrorMessage: (error: string) => {
          throw new Error(error);
        },
      },
      commands: {
        executeCommand: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    },
  });
  await editor.reopenWithExpectedEncoding(documents[1], { rule: { encoding: "utf8bom" } });
  assert.equal(documents[0]?.encoding, "utf8bom");
  assert.equal(calls[0]?.[0], "vscode.diff");
  assert.equal(calls[0]?.[1], original);
  assert.equal(calls[0]?.[2], modified);
  assert.match(String(calls[0]?.[3]), /Left \(Git\): utf8bom \/ Right \(Working\): utf8bom/);
  const status = { text: "", show() {}, hide() {} };
  editor.updateStatus(status, documents[1]);
  assert.match(status.text, /Left \(Git\): utf8bom \/ Right \(Working\): utf8bom/);
  assert.equal(editor.diagnosticFor(documents[0]), undefined);
});
