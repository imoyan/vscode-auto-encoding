import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

// POSIX: own a dedicated process group so a descendant holding inherited
// stdio cannot keep the host test alive after the launcher has exited.
// Windows uses the previous child-only semantics; macOS is the formal lane.
export async function runExtensionHost(executable, args, options) {
  const { env, signal, timeoutMs, graceMs = 1_000, stdio = "inherit" } = options;
  const started = performance.now();
  const grouped = process.platform !== "win32";
  const child = spawn(executable, args, { env, stdio, detached: grouped });
  let exit;
  const completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, errorCode: error.code ?? "UNKNOWN" }));
    child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  }).then((result) => (exit = result));

  let timer;
  let onAbort;
  const stop = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (!signal) return;
    onAbort = () => resolve("interrupted");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const signalOwned = (kind) => {
    if (child.pid === undefined) return false;
    if (!grouped) return exit === undefined && child.kill(kind);
    try {
      process.kill(-child.pid, kind);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  try {
    const reason = await Promise.race([completion.then(() => "exit"), stop]);
    const elapsedMs = Math.round(performance.now() - started);
    let forced = false;
    if (signalOwned("SIGTERM")) {
      const graceEnd = performance.now() + graceMs;
      while (signalOwned(0) && performance.now() < graceEnd) await delay(20);
      forced = signalOwned("SIGKILL");
    }
    // Do not wait for a pipe held open by a descendant ('close' instead of
    // 'exit'), or indefinitely even if the OS does not report the exit.
    if (exit === undefined) {
      const reap = new globalThis.AbortController();
      try {
        await Promise.race([completion, delay(graceMs, undefined, { signal: reap.signal }).catch(() => {})]);
      } finally { reap.abort(); }
    }
    return { reason, elapsedMs, forced, reaped: exit !== undefined, ...exit };
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
