import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import { release } from "node:os";
import {
  picks,
  confirmations,
  nonModalResponses,
  errors,
  expectedErrors,
  notices,
  statusItems,
  decorationProviders,
} from "./hostDriver.js";
import { ConfigurationLimitError, MAX_SETTING_ENTRIES } from "../../src/boundedGlob.js";
import { readBackupResource } from "../../src/conversionBackup.js";

const command = (name: string, ...args: unknown[]) =>
  vscode.commands.executeCommand(`autoEncoding.${name}`, ...args);

async function waitFor(condition: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withObservedFileChange(
  uri: vscode.Uri | readonly vscode.Uri[],
  action: () => PromiseLike<unknown>,
): Promise<void> {
  const expected = new Set(
    (Array.isArray(uri) ? uri : [uri]).map((entry: vscode.Uri) => entry.toString()),
  );
  const pending = new Set(expected);
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let accept: (() => void) | undefined;
  const event = new Promise<void>((resolve, reject) => {
    accept = resolve;
    timer = setTimeout(
      () => reject(new Error(`Missing file event: ${[...pending].join(", ")}`)),
      15000,
    );
  });
  const observe = (changed: vscode.Uri): void => {
    if (!expected.has(changed.toString())) return;
    pending.delete(changed.toString());
    clearTimeout(quietTimer);
    if (!pending.size) quietTimer = setTimeout(() => accept?.(), 250);
  };
  const listeners = [watcher.onDidCreate(observe), watcher.onDidChange(observe)];
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await action();
    await event;
  } finally {
    clearTimeout(timer);
    clearTimeout(quietTimer);
    listeners.forEach((listener) => listener.dispose());
    watcher.dispose();
  }
}

async function writeObserved(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await withObservedFileChange(uri, () => vscode.workspace.fs.writeFile(uri, bytes));
}

export async function run(): Promise<void> {
  console.log("Auto Encoding Extension Host suite started");
  const extension = vscode.extensions.getExtension("imoyan.auto-encoding");
  assert.ok(extension);
  console.log("Host phase: activate-extension");
  await extension.activate();
  console.log("Host phase: workspace-configuration");
  const folders = vscode.workspace.workspaceFolders!;
  const plain = folders.find((folder) => folder.name === "plain")!;
  const tracked = folders.find((folder) => folder.name === "tracked")!;
  for (const folder of folders) {
    await vscode.workspace
      .getConfiguration("autoEncoding", folder.uri)
      .update("rules", [{ pattern: "**/*.txt", encoding: "utf8" }], vscode.ConfigurationTarget.WorkspaceFolder);
  }

  console.log("Host phase: activate-git");
  const git = vscode.extensions.getExtension("vscode.git");
  assert.ok(git);
  await git.activate();
  const hostGit = git.exports.getAPI(1) as { git: { path: string } };
  const gitVersion = execFileSync(hostGit.git.path, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  console.log(
    `Host environment: ${process.platform}/${process.arch} ${release()}, ${gitVersion}, Node ${process.version}, VS Code ${vscode.version}`,
  );

  const documentOf = (uri: vscode.Uri): vscode.TextDocument | undefined =>
    vscode.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());

  console.log("Host phase: configuration-limit-and-recovery");
  const plainConfig = vscode.workspace.getConfiguration("autoEncoding", plain.uri);
  const originalPlainRules = plainConfig.inspect("rules")?.workspaceFolderValue;
  const invalidRules = Array.from({ length: MAX_SETTING_ENTRIES + 1 }, () => ({
    pattern: "**/*.txt",
    encoding: "utf8",
  }));
  const limitMessage = new ConfigurationLimitError().message;
  try {
    expectedErrors.push(limitMessage);
    await plainConfig.update("rules", invalidRules, vscode.ConfigurationTarget.WorkspaceFolder);
    const cancellation = new vscode.CancellationTokenSource();
    const badDecoration = await decorationProviders[0]?.provideFileDecoration(
      vscode.Uri.joinPath(plain.uri, "check.txt"),
      cancellation.token,
    );
    cancellation.dispose();
    assert.equal(badDecoration, undefined);
    assert.ok(!expectedErrors.includes(limitMessage), "The extension must notify the user of the configuration limit");
  } finally {
    await plainConfig.update("rules", originalPlainRules, vscode.ConfigurationTarget.WorkspaceFolder);
  }

  console.log("Host phase: conversion");
  const conversionFolder = vscode.Uri.joinPath(plain.uri, "convert");
  await vscode.workspace.fs.createDirectory(conversionFolder);
  const target = vscode.Uri.joinPath(conversionFolder, "sample.txt");
  const original = await vscode.workspace.encode("café\r\n", { encoding: "windows1252" });
  await writeObserved(target, original);
  picks.push(
    { title: "Select Target Format", label: "UTF-8 + LF" },
    { title: "Select Current Encoding", label: "Windows-1252" },
    { title: "Conversion candidates", all: true },
  );
  confirmations.push("Convert");
  const targetIsLoaded = () =>
    vscode.workspace.textDocuments.some((document) => document.uri.toString() === target.toString());
  assert.equal(targetIsLoaded(), false);
  await command("convertFolder", conversionFolder);
  assert.equal(targetIsLoaded(), false);
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from("café\n"));
  confirmations.push("Undo");
  assert.equal(await command("undoLastConversion"), true, JSON.stringify({ errors, notices }));
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from(original));

  const sibling = vscode.Uri.joinPath(conversionFolder, "sibling.txt");
  await writeObserved(sibling, original);
  picks.push(
    { title: "Select Target Format", label: "UTF-8" },
    { title: "Select Current Encoding", label: "Windows-1252" },
  );
  assert.equal(await command("convertFile", target), true);
  assert.equal(targetIsLoaded(), false);
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from("café\r\n"));
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(sibling)), Buffer.from(original));
  confirmations.push("Undo");
  assert.equal(await command("undoLastConversion"), true);
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from(original));
  assert.equal(targetIsLoaded(), false);

  const cp932AliasHost = vscode.Uri.joinPath(conversionFolder, "cp932-alias.txt");
  const cp932AliasBytes = Uint8Array.from([0xfa, 0x4a, 0x0d, 0x0a]);
  const utf8BomHost = vscode.Uri.joinPath(conversionFolder, "utf8bom-host.txt");
  const utf8BomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("日本語\r\n")]);
  await writeObserved(cp932AliasHost, cp932AliasBytes);
  await writeObserved(utf8BomHost, utf8BomBytes);
  picks.push(
    { title: "Select Target Format", label: "Line endings only → LF" },
    { title: "Conversion candidates", all: true },
  );
  confirmations.push("Convert");
  assert.equal(await command("convertFolder", conversionFolder), true);
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(cp932AliasHost)),
    Buffer.from([0xfa, 0x4a, 0x0a]),
  );
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(utf8BomHost)),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("日本語\n")]),
  );
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from(original));
  confirmations.push("Undo");
  assert.equal(await command("undoLastConversion"), true);
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(cp932AliasHost)),
    Buffer.from(cp932AliasBytes),
  );
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(utf8BomHost)), utf8BomBytes);

  const bomEditor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(utf8BomHost),
    { preview: false },
  );
  picks.push(
    { title: "utf8bom-host.txt", label: "$(replace) Convert and Save Encoding / Line Endings..." },
    { title: "Select Target Format", label: "UTF-8" },
  );
  await command("inspectActiveFile");
  assert.equal(picks.length, 0);
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(utf8BomHost)),
    Buffer.from("日本語\r\n"),
  );
  assert.equal(bomEditor.document.isClosed, false);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(
    () =>
      vscode.window.visibleTextEditors.every(
        (editor) => editor.document.uri.toString() !== utf8BomHost.toString(),
      ),
    () => "utf8bom-host.txt が閉じられません",
  );
  await vscode.workspace.fs.delete(cp932AliasHost);
  await vscode.workspace.fs.delete(utf8BomHost);

  assert.ok(await readBackupResource(target, original.length));
  assert.ok(await readBackupResource(target.with({ scheme: "vscode-userdata" }), original.length));
  assert.equal(await readBackupResource(target, original.length - 1), undefined);
  assert.equal(
    await readBackupResource(
      target.with({ scheme: "vscode-userdata", authority: "remote" }),
      original.length,
    ),
    undefined,
  );
  assert.equal(await readBackupResource(target.with({ scheme: "unknown" }), original.length), undefined);

  console.log("Host phase: git-diff-reopen");
  const gitApi = git.exports.getAPI(1) as { toGitUri(uri: vscode.Uri, ref: string): vscode.Uri };
  const changed = vscode.Uri.joinPath(tracked.uri, "history.txt");
  await writeObserved(changed, Buffer.from("履歴更新\r\n", "utf8"));
  const headUri = gitApi.toGitUri(changed, "HEAD");
  await vscode.workspace.openTextDocument(headUri);
  await vscode.workspace.openTextDocument(changed, { encoding: "utf16le" });
  await vscode.commands.executeCommand("vscode.diff", headUri, changed, "文字コード比較テスト", {
    preview: false,
  });
  const bytesBeforeReopen = await vscode.workspace.fs.readFile(changed);
  const sides = () =>
    JSON.stringify({ left: documentOf(headUri)?.encoding, right: documentOf(changed)?.encoding });
  await waitFor(
    () => documentOf(headUri)?.encoding === "utf8" && documentOf(changed)?.encoding === "utf8",
    sides,
  );
  const comparisonTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(comparisonTab?.input instanceof vscode.TabInputTextDiff);
  assert.equal(comparisonTab.input.original.toString(), headUri.toString());
  assert.equal(comparisonTab.input.modified.toString(), changed.toString());
  await waitFor(
    () =>
      statusItems.some(
        (item) => /Left \(Git\):.*Right \(Working\):/.test(item.text) && item.text.includes("$(pass)"),
      ),
    () => JSON.stringify(statusItems.map((item) => item.text)),
  );
  picks.push({ title: "history.txt", cancel: true });
  await command("inspectActiveFile");
  assert.equal(picks.length, 0);
  assert.deepEqual(await vscode.workspace.fs.readFile(changed), bytesBeforeReopen);
  assert.deepEqual(nonModalResponses, []);

  console.log("Host phase: git-diff-shiftjis");
  const sjisWork = Uint8Array.from([
    0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a,
  ]);
  const withRule = vscode.Uri.joinPath(tracked.uri, "sjis-rule.dat");
  const withoutRule = vscode.Uri.joinPath(tracked.uri, "sjis-open.dat");
  const trackedConfig = vscode.workspace.getConfiguration("autoEncoding", tracked.uri);
  const previousRules = trackedConfig.get<unknown[]>("rules") ?? [];
  await writeObserved(withRule, sjisWork);
  await writeObserved(withoutRule, sjisWork);

  await trackedConfig.update(
    "rules",
    [{ pattern: "sjis-rule.dat", encoding: "shiftjis" }, ...previousRules],
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  const ruleHead = gitApi.toGitUri(withRule, "HEAD");
  await vscode.commands.executeCommand("vscode.diff", ruleHead, withRule, "Shift JIS ルール比較", {
    preview: false,
  });
  const ruleSides = () =>
    JSON.stringify({ left: documentOf(ruleHead)?.encoding, right: documentOf(withRule)?.encoding });
  await waitFor(
    () =>
      documentOf(ruleHead)?.encoding === "shiftjis" && documentOf(withRule)?.encoding === "shiftjis",
    ruleSides,
  );
  await waitFor(
    () =>
      !!documentOf(ruleHead)?.getText().includes("日本語") &&
      !!documentOf(withRule)?.getText().includes("日本語テスト"),
    () =>
      `Git側が文字化けしています: ${documentOf(ruleHead)?.getText()} / ${documentOf(withRule)?.getText()}`,
  );
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(withRule)), Buffer.from(sjisWork));

  await vscode.workspace.openTextDocument(withoutRule, { encoding: "shiftjis" });
  const openHead = gitApi.toGitUri(withoutRule, "HEAD");
  await vscode.commands.executeCommand(
    "vscode.diff",
    openHead,
    withoutRule,
    "Shift JIS 開き直し比較",
    { preview: false },
  );
  const openSides = () =>
    JSON.stringify({
      left: documentOf(openHead)?.encoding,
      right: documentOf(withoutRule)?.encoding,
    });
  await waitFor(
    () =>
      documentOf(openHead)?.encoding === "shiftjis" &&
      documentOf(withoutRule)?.encoding === "shiftjis",
    openSides,
  );
  await waitFor(
    () => !!documentOf(openHead)?.getText().includes("日本語"),
    () => `Git側が文字化けしています: ${documentOf(openHead)?.getText()}`,
  );
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(withoutRule)),
    Buffer.from(sjisWork),
  );

  const autoWork = vscode.Uri.joinPath(tracked.uri, "sjis-auto-work.dat");
  await writeObserved(autoWork, sjisWork);
  assert.equal(documentOf(autoWork), undefined);
  const autoWorkHead = gitApi.toGitUri(autoWork, "HEAD");
  await vscode.commands.executeCommand(
    "vscode.diff",
    autoWorkHead,
    autoWork,
    "Shift JIS 自動判定比較",
    { preview: false },
  );
  const autoWorkSides = () =>
    JSON.stringify({
      left: documentOf(autoWorkHead)?.encoding,
      right: documentOf(autoWork)?.encoding,
    });
  await waitFor(
    () =>
      documentOf(autoWorkHead)?.encoding === "shiftjis" &&
      documentOf(autoWork)?.encoding === "shiftjis",
    autoWorkSides,
  );
  await waitFor(
    () =>
      !!documentOf(autoWorkHead)?.getText().includes("日本語") &&
      !!documentOf(autoWork)?.getText().includes("日本語テスト"),
    () =>
      `自動判定比較が文字化けしています: ${documentOf(autoWorkHead)?.getText()} / ${documentOf(autoWork)?.getText()}`,
  );
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(autoWork)), Buffer.from(sjisWork));

  const autoCommit = vscode.Uri.joinPath(tracked.uri, "sjis-auto-commit.dat");
  assert.equal(documentOf(autoCommit), undefined);
  const prevCommitUri = gitApi.toGitUri(autoCommit, "HEAD~1");
  const currCommitUri = gitApi.toGitUri(autoCommit, "HEAD");
  await vscode.commands.executeCommand(
    "vscode.diff",
    prevCommitUri,
    currCommitUri,
    "Shift JIS 履歴比較",
    { preview: false },
  );
  const commitSides = () =>
    JSON.stringify({
      left: documentOf(prevCommitUri)?.encoding,
      right: documentOf(currCommitUri)?.encoding,
    });
  await waitFor(
    () =>
      documentOf(prevCommitUri)?.encoding === "shiftjis" &&
      documentOf(currCommitUri)?.encoding === "shiftjis",
    commitSides,
  );
  await waitFor(
    () =>
      !!documentOf(prevCommitUri)?.getText().includes("日本語") &&
      !!documentOf(currCommitUri)?.getText().includes("日本語テスト"),
    () =>
      `履歴比較が文字化けしています: ${documentOf(prevCommitUri)?.getText()} / ${documentOf(currCommitUri)?.getText()}`,
  );

  const deletedFile = vscode.Uri.joinPath(tracked.uri, "sjis-deleted.dat");
  await vscode.workspace.fs.delete(deletedFile);
  const deletedHead = gitApi.toGitUri(deletedFile, "HEAD");
  const openedDeleted = await vscode.workspace.openTextDocument(deletedHead);
  await vscode.window.showTextDocument(openedDeleted, { preview: false });
  await waitFor(
    () => documentOf(deletedHead)?.encoding === "shiftjis",
    () => `単体Git表示の文字コード: ${documentOf(deletedHead)?.encoding}`,
  );
  await waitFor(
    () => !!documentOf(deletedHead)?.getText().includes("日本語"),
    () => `単体Git表示が文字化けしています: ${documentOf(deletedHead)?.getText()}`,
  );
  await waitFor(
    () => statusItems.some((item) => item.text.includes("Git: Shift JIS / CP932 (auto-detected · no rule)")),
    () => JSON.stringify(statusItems.map((item) => item.text)),
  );
  picks.push(
    { title: "sjis-deleted.dat", label: "$(pin) Set Encoding Rule for This File" },
    { title: "Encoding for sjis-deleted.dat", label: "Shift JIS / CP932" },
  );
  await command("inspectActiveFile");
  assert.equal(picks.length, 0);
  assert.ok(
    (
      vscode.workspace
        .getConfiguration("autoEncoding", tracked.uri)
        .get<{ pattern: string; encoding: string }[]>("rules") ?? []
    ).some((entry) => entry.pattern === "sjis-deleted.dat" && entry.encoding === "shiftjis"),
  );

  await trackedConfig.update("rules", previousRules, vscode.ConfigurationTarget.WorkspaceFolder);
  assert.deepEqual(errors, []);

  console.log("Host phase: git-scm-shiftjis-dirty");
  const scmApi = git.exports.getAPI(1) as {
    getRepository(uri: vscode.Uri): {
      status(): Promise<void>;
      state: { workingTreeChanges: readonly { uri: vscode.Uri }[] };
    } | null;
  };
  const repository = scmApi.getRepository(tracked.uri);
  assert.ok(repository, "VS CodeのGitリポジトリが見つかりません");
  for (const name of ["CanonicalComparison.java", "LegacyComparison.java"]) {
    const uri = vscode.Uri.joinPath(tracked.uri, name);
    const committed = await vscode.workspace.fs.readFile(uri);
    const saved = Buffer.concat([committed, Buffer.from("// saved change\r\n")]);
    await writeObserved(uri, saved);
    const working = await vscode.workspace.openTextDocument(uri, { encoding: "shiftjis" });
    assert.equal(working.lineAt(0).text, "// 日本語≒");
    assert.equal(working.eol, vscode.EndOfLine.CRLF);
    const edit = new vscode.WorkspaceEdit();
    const unsaved = "// unsaved change\r\n";
    edit.insert(uri, working.positionAt(working.getText().length), unsaved);
    const expectedText = working.getText() + unsaved;
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(working.isDirty);

    await repository.status();
    await waitFor(
      () =>
        repository.state.workingTreeChanges.some(
          (change) => change.uri.toString() === uri.toString(),
        ),
      () => `SCMの作業ツリーに ${name} が見つかりません`,
    );
    await vscode.commands.executeCommand("git.openChange", uri);
    const activeDiff = () => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff &&
        input.modified.toString() === uri.toString()
        ? input
        : undefined;
    };
    await waitFor(
      () => activeDiff()?.original.scheme === "git",
      () => `SCM比較を開けませんでした: ${name}`,
    );
    const originalSide = activeDiff()!.original;
    await waitFor(
      () =>
        documentOf(originalSide)?.encoding === "shiftjis" &&
        documentOf(originalSide)?.lineAt(0).text === "// 日本語≒",
      () => `SCM比較のGit側が文字化けしています: ${name} (${documentOf(originalSide)?.encoding})`,
    );
    assert.equal(activeDiff()?.original.toString(), originalSide.toString());
    assert.equal(working.encoding, "shiftjis");
    assert.ok(working.isDirty);
    assert.equal(working.getText(), expectedText);
    assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)), saved);
    assert.deepEqual(
      Buffer.from(await vscode.workspace.fs.readFile(originalSide)),
      Buffer.from(committed),
    );
  }

  console.log("Host phase: folder-encoding-and-default-auto-reopen");
  const originalRules = plainConfig.get<unknown[]>("rules") ?? [];
  const legacyFolder = vscode.Uri.joinPath(plain.uri, "legacy");
  await vscode.workspace.fs.createDirectory(legacyFolder);
  const legacyFile = vscode.Uri.joinPath(legacyFolder, "Main.java");
  const legacyBytes = await vscode.workspace.encode("// 日本語\r\n", { encoding: "shiftjis" });
  await writeObserved(legacyFile, legacyBytes);
  picks.push({ title: "Encoding for legacy", label: "Shift JIS / CP932" });
  assert.equal(await command("configureFolder", legacyFolder), true);
  const decorationCancellation = new vscode.CancellationTokenSource();
  const decoration = await decorationProviders[0]?.provideFileDecoration(
    legacyFolder,
    decorationCancellation.token,
  );
  decorationCancellation.dispose();
  assert.equal(decoration?.badge, "SJ");
  assert.match(String(decoration?.tooltip), /Folder rule: Shift JIS \/ CP932/);

  // Default autoReopen=true automatically reopens ruled files without extra configuration!
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(legacyFile));
  await waitFor(
    () =>
      documentOf(legacyFile)?.encoding === "shiftjis" &&
      documentOf(legacyFile)?.lineAt(0).text === "// 日本語",
    () => "Folder rule was not automatically applied in regular editor",
  );
  await waitFor(
    () =>
      statusItems.some(
        (item) =>
          item.text === "$(pass) Rule: Shift JIS / CP932" &&
          String(item.tooltip).includes("Source: plain / legacy/**"),
      ),
    () => JSON.stringify(statusItems.map((item) => item.text)),
  );
  assert.deepEqual(await vscode.workspace.fs.readFile(legacyFile), legacyBytes);

  const utf8Exception = vscode.Uri.joinPath(legacyFolder, "Utf8Exception.java");
  const originalUtf8 = "// 日本語\r\nclass Example {}\r\n";
  await writeObserved(utf8Exception, Buffer.from(originalUtf8));
  const utf8Document = await vscode.workspace.openTextDocument(utf8Exception);
  await vscode.window.showTextDocument(utf8Document);
  await waitFor(
    () =>
      notices.some(
        (notice) =>
          notice.includes("Utf8Exception.java") && notice.includes("keeping the current encoding"),
      ),
    () => "Mismatch between rule and saved bytes was not notified",
  );
  assert.equal(utf8Document.encoding, "utf8");
  assert.equal(utf8Document.getText(), originalUtf8);
  const utf8Edit = new vscode.WorkspaceEdit();
  utf8Edit.insert(utf8Exception, new vscode.Position(1, 0), "// edited\r\n");
  assert.ok(await vscode.workspace.applyEdit(utf8Edit));
  expectedErrors.push(
    "Save warning: Utf8Exception.java is open as UTF-8, while the configured encoding rule is Shift JIS / CP932.",
  );
  await withObservedFileChange(utf8Exception, async () => {
    assert.ok(await utf8Document.save());
  });
  assert.deepEqual(
    Buffer.from(await vscode.workspace.fs.readFile(utf8Exception)),
    Buffer.from("// 日本語\r\n// edited\r\nclass Example {}\r\n"),
  );

  // Removing folder rule directly via configureFolder clears badge
  picks.push({
    title: "Encoding for legacy",
    label: "$(trash) Remove encoding rule for this folder",
  });
  assert.equal(await command("configureFolder", legacyFolder), true);
  const clearedCancellation = new vscode.CancellationTokenSource();
  const clearedDecoration = await decorationProviders[0]?.provideFileDecoration(
    legacyFolder,
    clearedCancellation.token,
  );
  clearedCancellation.dispose();
  assert.equal(clearedDecoration, undefined);
  await plainConfig.update("rules", originalRules, vscode.ConfigurationTarget.WorkspaceFolder);

  console.log("Host phase: unruled-editor-default-auto-reopen");
  const unruledAuto = vscode.Uri.joinPath(plain.uri, "unruled-auto.dat");
  await writeObserved(unruledAuto, legacyBytes);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(unruledAuto), {
    preview: false,
  });
  await waitFor(
    () =>
      documentOf(unruledAuto)?.encoding === "shiftjis" &&
      documentOf(unruledAuto)?.lineAt(0).text === "// 日本語",
    () => "Default autoReopen did not reopen unruled Shift JIS file",
  );
  await waitFor(
    () =>
      statusItems.some((item) => item.text === "$(pass) Shift JIS / CP932 (auto-detected · no rule)"),
    () => JSON.stringify(statusItems.map((item) => item.text)),
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.workspace.fs.delete(unruledAuto);

  assert.deepEqual(errors, []);
  await fsWritePassed();
}

async function fsWritePassed(): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const destination = process.env.FEG_HOST_RESULT;
  assert.ok(destination);
  await writeFile(destination, "passed", "utf8");
}
