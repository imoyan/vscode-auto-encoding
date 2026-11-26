import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { PinnedLocalFile, readPinnedLocalFile } from "../src/pinnedLocalFile.js";
import { resolveRealPathWithin } from "../src/localPathSafety.js";

async function fixture(t: TestContext) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "pinned-file-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace");
  const other = path.join(temporary, "control");
  await mkdir(root);
  await mkdir(other);
  await writeFile(path.join(root, "a.txt"), "initial\n");
  await writeFile(path.join(other, "a.txt"), "sentinel\n");
  return { temporary, root, other, file: path.join(root, "a.txt") };
}

test("pinned conversion and restore preserve bytes through longer, shorter and empty writes", async (t) => {
  const f = await fixture(t);
  for (const converted of [
    Buffer.alloc(1024 * 1024 + 7, 97),
    Buffer.from("短い\n"),
    Buffer.alloc(0),
    Buffer.from("initial\n"),
  ]) {
    const file = await PinnedLocalFile.open(f.root, f.file, 2 * 1024 * 1024, true);
    assert.ok(file);
    try {
      assert.equal(await file.isCurrent(), true);
      assert.equal(await file.writeConverted(converted), true);
    } finally {
      await file.dispose();
    }
    assert.deepEqual(await readFile(f.file), converted);
  }
});

test("pinned initial read rejects an indirect parent without reading its file", async (t) => {
  const f = await fixture(t);
  await symlink(f.other, path.join(f.root, "parent"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await readPinnedLocalFile(f.root, path.join(f.root, "parent/a.txt"), 1024), undefined);
  assert.equal(await readFile(path.join(f.other, "a.txt"), "utf8"), "sentinel\n");
});

test("conversion and restore accept search-only ancestors without requiring directory listing", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const ancestor = path.join(f.root, "search-only");
  const workspace = path.join(ancestor, "workspace");
  const target = path.join(workspace, "a.txt");
  await mkdir(workspace, { recursive: true });
  await writeFile(target, "initial\n");
  await chmod(ancestor, 0o111);
  try {
    assert.equal(await readFile(target, "utf8"), "initial\n");
    for (const bytes of [Buffer.from("converted\n"), Buffer.from("initial\n")]) {
      const file = await PinnedLocalFile.open(workspace, target, 1024, true);
      assert.ok(file);
      try {
        assert.equal(await file.writeConverted(bytes), true);
      } finally {
        await file.dispose();
      }
      assert.deepEqual(await readFile(target), bytes);
    }
  } finally {
    await chmod(ancestor, 0o700);
  }
});

test("retained writer prevents or rejects parent replacement and keeps the other control unchanged", async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.root, "parent");
  await mkdir(parent);
  await writeFile(path.join(parent, "a.txt"), "initial\n");
  const previous = path.join(f.root, "old-parent");
  await rename(parent, previous);
  await rename(previous, parent);
  const file = await PinnedLocalFile.open(f.root, path.join(parent, "a.txt"), 1024, true);
  assert.ok(file);
  try {
    assert.equal(await file.isCurrent(), true);
    try {
      await rename(parent, previous);
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      assert.equal(await file.isCurrent(), true);
      assert.equal(await file.writeConverted(Buffer.from("converted\n")), true);
      assert.equal(await readFile(path.join(parent, "a.txt"), "utf8"), "converted\n");
      assert.equal(await readFile(path.join(f.other, "a.txt"), "utf8"), "sentinel\n");
      return;
    }
    await symlink(f.other, parent, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await file.isCurrent(), false);
    assert.equal(await file.writeConverted(Buffer.from("converted\n")), false);
    assert.equal(await readFile(path.join(f.other, "a.txt"), "utf8"), "sentinel\n");
    assert.equal(await readFile(path.join(f.root, "old-parent/a.txt"), "utf8"), "initial\n");
  } finally {
    await file.dispose();
  }
});

test("pinned writer rejects leaf replacement before any write", async (t) => {
  const f = await fixture(t);
  const file = await PinnedLocalFile.open(f.root, f.file, 1024, true);
  assert.ok(file);
  try {
    assert.equal(await file.isCurrent(), true);
    await rename(f.file, path.join(f.root, "old.txt"));
    if (process.platform === "win32") await writeFile(f.file, "sentinel\n");
    else await symlink(path.join(f.other, "a.txt"), f.file);
    assert.equal(await file.writeConverted(Buffer.from("converted\n")), false);
    assert.equal(await readFile(f.file, "utf8"), "sentinel\n");
    assert.equal(await readFile(path.join(f.root, "old.txt"), "utf8"), "initial\n");
    assert.equal(await readFile(path.join(f.other, "a.txt"), "utf8"), "sentinel\n");
  } finally {
    await file.dispose();
  }
});

test("read-only snapshots do not require write permission for already-restored data", async (t) => {
  const f = await fixture(t);
  await chmod(f.file, 0o400);
  try {
    const snapshot = await readPinnedLocalFile(f.root, f.file, 1024);
    assert.ok(snapshot);
    assert.equal(Buffer.from(snapshot.bytes).toString(), "initial\n");
    assert.equal(await PinnedLocalFile.open(f.root, f.file, 1024, true), undefined);
  } finally {
    await chmod(f.file, 0o600);
  }
});

test("selection identity distinguishes same-content replacement", async (t) => {
  const f = await fixture(t);
  const before = await readPinnedLocalFile(f.root, f.file, 1024);
  assert.ok(before);
  await rename(f.file, path.join(f.root, "old.txt"));
  await writeFile(f.file, "initial\n");
  const after = await readPinnedLocalFile(f.root, f.file, 1024);
  assert.ok(after);
  assert.equal(before.contentHash, after.contentHash);
  assert.notEqual(before.identity, after.identity);
});

test("contained aliases still select and change their original regular file", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias.txt");
  await symlink(f.file, alias);
  const resolved = await resolveRealPathWithin(f.root, alias);
  assert.equal(resolved, f.file);
  const file = await PinnedLocalFile.open(f.root, resolved, 1024, true);
  assert.ok(file);
  try {
    assert.equal(await file.writeConverted(Buffer.from("converted\n")), true);
  } finally {
    await file.dispose();
  }
  assert.equal(await readFile(alias, "utf8"), "converted\n");
});

test("missing and oversized targets are rejected without creation or truncation", async (t) => {
  const f = await fixture(t);
  assert.equal(await readPinnedLocalFile(f.root, path.join(f.root, "missing.txt"), 1024), undefined);
  assert.equal(await readPinnedLocalFile(f.root, f.file, 1), undefined);
  assert.equal(await readFile(f.file, "utf8"), "initial\n");
});

test("changed data and newly added aliases invalidate the captured version", async (t) => {
  const f = await fixture(t);
  const file = await PinnedLocalFile.open(f.root, f.file, 1024, true);
  assert.ok(file);
  try {
    await link(f.file, path.join(f.root, "second.txt"));
    assert.equal(await file.isCurrent(), false);
    assert.equal(await file.writeConverted(Buffer.from("converted\n")), false);
    await writeFile(f.file, "edited\n");
    assert.equal(await file.isCurrent(), false);
  } finally {
    await file.dispose();
  }
  assert.equal(await readFile(f.file, "utf8"), "edited\n");
});

test("preexisting hard links keep the authorized file identity and normal shared contents", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "second.txt");
  await link(f.file, alias);
  const file = await PinnedLocalFile.open(f.root, f.file, 1024, true);
  assert.ok(file);
  try {
    assert.equal(await file.writeConverted(Buffer.from("converted\n")), true);
  } finally {
    await file.dispose();
  }
  assert.equal(await readFile(alias, "utf8"), "converted\n");
});

test("out-of-root paths are rejected before opening", async (t) => {
  const f = await fixture(t);
  assert.equal(await PinnedLocalFile.open(f.root, path.join(f.other, "a.txt"), 1024, true), undefined);
  assert.equal(await readFile(path.join(f.other, "a.txt"), "utf8"), "sentinel\n");
});
