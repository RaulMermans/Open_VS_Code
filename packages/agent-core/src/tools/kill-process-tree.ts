import { spawn, execFileSync, type ChildProcess } from "node:child_process"

export interface ProcessProbeResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/**
 * Executes a bounded, read-only OS binary probe with shell:false.
 * Centralizes child_process usage inside the canonical OS process boundary module.
 */
export function execProcessProbe(
  file: string,
  args: readonly string[],
  timeoutMs: number = 3000,
): ProcessProbeResult {
  try {
    const stdout = execFileSync(file, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    })
    return { ok: true, stdout, stderr: "" }
  } catch (err: any) {
    const stdout = err?.stdout ? String(err.stdout) : ""
    const stderr = err?.stderr ? String(err.stderr).trim() : err?.message || String(err)
    return { ok: false, stdout, stderr }
  }
}

export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", child.pid.toString(), "/T", "/F"], { stdio: "ignore" })
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore
    }
    try {
      // If the process was spawned with detached: true, we can kill its process group
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Ignore
    }
  }
}
