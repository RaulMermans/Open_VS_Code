// Shared helpers for tests that spawn real process trees (Sprint 7C flake fix).
//
// A child that does `fs.writeFileSync(pidFile, pid)` creates the file before it
// writes the pid. A harness polling `existsSync` can therefore read "" and get
// NaN (or 0, which `process.kill(0, 0)` reports as alive). Children publish
// atomically instead, and the harness waits until the file holds a real pid.
import { existsSync, readFileSync } from "node:fs";

/** JavaScript for a child script: `publishPid(path, pid)` writes a temp file and renames it into place. */
export const PUBLISH_PID_SOURCE =
  "function publishPid(p, v) { const fs = require('node:fs'); fs.writeFileSync(p + '.tmp', String(v)); fs.renameSync(p + '.tmp', p); }";

/** One-line form for `node -e` children whose pid file path is process.argv[1]. */
export const PUBLISH_OWN_PID_INLINE =
  "const fs = require(\"node:fs\"); fs.writeFileSync(process.argv[1] + \".tmp\", String(process.pid)); fs.renameSync(process.argv[1] + \".tmp\", process.argv[1]);";

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Waits (by deadline, not by a fixed number of polls) until `path` holds a positive integer pid. */
export async function readPublishedPid(path: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    if (Date.now() > deadline) throw new Error(`pid file ${path} was not published within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Polls until every pid has exited or the deadline passes; returns which are still alive. */
export async function waitForExit(pids: number[], timeoutMs = 5_000): Promise<boolean[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.map(isAlive);
    if (!alive.some(Boolean) || Date.now() > deadline) return alive;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Failure-path cleanup: never leave a process tree running into the next scenario or run. */
export function killQuietly(pids: Array<number | undefined>): void {
  for (const pid of pids) {
    if (pid && isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}
