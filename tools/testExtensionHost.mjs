import * as esbuild from "esbuild";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { runExtensionHost } from "./testExtensionHostProcess.mjs";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let executable = process.env.VSCODE_EXECUTABLE;
if (!executable && process.platform === "darwin") {
  for (const name of ["Code", "Electron"]) {
    const candidate = `/Applications/Visual Studio Code.app/Contents/MacOS/${name}`;
    try {
      await fs.access(candidate);
      executable = candidate;
      break;
    } catch {
      /* Try the other bundle executable name. */
    }
  }
}
if (!executable) throw new Error("VSCODE_EXECUTABLEにVS Code実行ファイルを指定してください。");
await fs.access(executable);
const tempRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(tempRoot, "fe-")),
);
try {
  const extension = path.join(temporary, "extension");
  const plain = path.join(temporary, "plain");
  const tracked = path.join(temporary, "tracked");
  await Promise.all([extension, plain, tracked].map((dir) => fs.mkdir(dir)));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  await fs.writeFile(
    path.join(extension, "package.json"),
    JSON.stringify({ ...manifest, main: "./extension.cjs", activationEvents: [] }),
  );
  await fs.copyFile(path.join(root, "package.nls.json"), path.join(extension, "package.nls.json"));
  await fs.copyFile(path.join(root, "package.nls.ja.json"), path.join(extension, "package.nls.ja.json"));
  await fs.cp(path.join(root, "l10n"), path.join(extension, "l10n"), { recursive: true });
  const workspace = path.join(temporary, "test.code-workspace");
  await fs.writeFile(
    workspace,
    JSON.stringify({
      folders: [{ path: plain }, { path: tracked }],
      settings: {
        "security.workspace.trust.enabled": false,
        "git.openRepositoryInParentFolders": "never",
      },
    }),
  );
  await fs.writeFile(path.join(tracked, "history.txt"), "履歴\n");
  const shiftJisHead = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]);
  const shiftJisNext = Buffer.from([
    0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a,
  ]);
  await fs.writeFile(path.join(tracked, "sjis-rule.dat"), shiftJisHead);
  await fs.writeFile(path.join(tracked, "sjis-open.dat"), shiftJisHead);
  await fs.writeFile(path.join(tracked, "sjis-auto-work.dat"), shiftJisHead);
  await fs.writeFile(path.join(tracked, "sjis-auto-commit.dat"), shiftJisHead);
  await fs.writeFile(path.join(tracked, "sjis-deleted.dat"), shiftJisHead);
  const scmFixtures = [
    ["CanonicalComparison.java", [0x81, 0xe0]],
    ["LegacyComparison.java", [0x87, 0x90]],
  ];
  for (const [name, approximately] of scmFixtures) {
    await fs.writeFile(
      path.join(tracked, name),
      Buffer.concat([
        Buffer.from("// "),
        shiftJisHead.subarray(0, -1),
        Buffer.from(approximately),
        Buffer.from("\r\nfinal class Comparison {}\r\n"),
      ]),
    );
  }
  for (const args of [
    ["init"],
    [
      "-c",
      "core.autocrlf=false",
      "add",
      "history.txt",
      "sjis-rule.dat",
      "sjis-open.dat",
      "sjis-auto-work.dat",
      "sjis-auto-commit.dat",
      "sjis-deleted.dat",
      ...scmFixtures.map(([name]) => name),
    ],
    ["-c", "user.name=Host Test", "-c", "user.email=host@example.invalid", "commit", "-m", "テスト用基準"],
  ]) {
    const result = spawnSync("git", args, { cwd: tracked, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  await fs.writeFile(path.join(tracked, "sjis-auto-commit.dat"), shiftJisNext);
  for (const args of [
    ["add", "sjis-auto-commit.dat"],
    ["-c", "user.name=Host Test", "-c", "user.email=host@example.invalid", "commit", "-m", "Shift JIS履歴更新"],
  ]) {
    const result = spawnSync("git", args, { cwd: tracked, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const shared = { bundle: true, platform: "node", format: "cjs", target: "node20", absWorkingDir: root };
  const driverPlugin = {
    name: "shared-test-driver",
    setup(build) {
      build.onResolve({ filter: /hostDriver\.js$/ }, () => ({ path: "./driver.cjs", external: true }));
    },
  };
  await esbuild.build({
    ...shared,
    entryPoints: ["test/host/hostDriver.ts"],
    outfile: path.join(extension, "driver.cjs"),
    external: ["vscode"],
  });
  await esbuild.build({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: path.join(extension, "extension.cjs"),
    plugins: [
      driverPlugin,
      {
        name: "automated-dialogs",
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({
            path: path.join(root, "test/host/vscodeProxy.ts"),
          }));
        },
      },
    ],
  });
  await esbuild.build({
    ...shared,
    entryPoints: ["test/host/suite.ts"],
    outfile: path.join(extension, "suite.cjs"),
    external: ["vscode"],
    plugins: [driverPlugin],
  });
  const env = { ...process.env };
  env.FEG_HOST_RESULT = path.join(temporary, "passed.txt");
  env.VSCODE_CLI = "1";
  delete env.ELECTRON_RUN_AS_NODE;
  const controller = new globalThis.AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timeoutMs = 180_000;
  try {
    const result = await runExtensionHost(
      executable,
      [
        workspace,
        "--new-window",
        "--locale",
        "en",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-updates",
        "--force-disable-user-env",
        "--disable-workspace-trust",
        "--disable-extensions",
        "--user-data-dir",
        path.join(temporary, "profile"),
        "--extensions-dir",
        path.join(temporary, "extensions"),
        "--extensionDevelopmentPath",
        extension,
        "--extensionTestsPath",
        path.join(extension, "suite.cjs"),
      ],
      { env, signal: controller.signal, timeoutMs },
    );
    if (result.reason !== "exit" || result.code !== 0 || !result.reaped) {
      throw new Error(`Extension Host failed: ${JSON.stringify({ ...result, timeoutMs })}`);
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if ((await fs.readFile(env.FEG_HOST_RESULT, "utf8").catch(() => undefined)) !== "passed") {
    throw new Error("テスト完了を確認できません。");
  }
  console.log("Extension Hostの操作フローテストが成功しました。");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
