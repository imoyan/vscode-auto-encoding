import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const { runExtensionHost } = createRequire(path.join(process.cwd(), "package.json"))("./tools/testExtensionHostProcess.mjs");
const options = { timeoutMs: 1_500, graceMs: 100, stdio: "ignore" };

test("Extension Host watchdog preserves normal and abnormal child exit", async () => {
  for (const code of [0, 7]) {
    const result = await runExtensionHost(process.execPath, ["-e", `process.exit(${code})`], options);
    assert.equal(result.reason, "exit");
    assert.equal(result.code, code);
    assert.equal(result.reaped, true);
    assert.equal(result.forced, false);
  }
  const missing = await runExtensionHost(path.join(tmpdir(), "missing-extension-host", "not-present"), [], options);
  assert.equal(missing.reason, "exit");
  assert.equal(missing.errorCode, "ENOENT");
  assert.equal(missing.reaped, true);
});

test("POSIX watchdog times out and kills a child that keeps inherited stdio after abnormal exit", {
  skip: process.platform === "win32",
}, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ae-host-watchdog-"));
  try {
    for (const mode of ["timeout", "exit"]) {
      const marker = path.join(temporary, mode);
      const descendant = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(process.argv[1], 'ready');
        setTimeout(() => { fs.writeFileSync(process.argv[1], 'survived'); process.exit(0); }, 2000);
      `;
      const launcher = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1]], { stdio: 'inherit' });
        const timer = setInterval(() => {
          if (fs.existsSync(process.argv[1]) && process.argv[2] === 'exit') {
            clearInterval(timer);
            process.exit(7);
          }
        }, 20);
      `;
      const result = await runExtensionHost(process.execPath, ["-e", launcher, marker, mode], options);
      assert.equal(result.reason, mode);
      assert.equal(result.reaped, true);
      assert.equal(result.forced, true);
      if (mode === "timeout") assert(result.elapsedMs >= options.timeoutMs - 50);
      else assert.equal(result.code, 7);
      assert.equal(await readFile(marker, "utf8"), "ready");
      await delay(Math.max(0, 2_150 - result.elapsedMs));
      assert.equal(await readFile(marker, "utf8"), "ready", "descendant survived process-group cleanup");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("watchdog distinguishes interruption from timeout", async () => {
  const controller = new AbortController();
  const running = runExtensionHost(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { ...options, signal: controller.signal });
  controller.abort();
  const result = await running;
  assert.equal(result.reason, "interrupted");
  assert.equal(result.reaped, true);
});
