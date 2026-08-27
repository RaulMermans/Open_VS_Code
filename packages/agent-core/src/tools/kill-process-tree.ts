import { spawn, ChildProcess } from "node:child_process"

export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", child.pid.toString(), "/T", "/F"], { stdio: "ignore" })
  } else {
    try {
      // If the process was spawned with detached: true, we can kill its process group
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // Fallback in case process is already dead or group doesn't exist
      try {
        child.kill("SIGKILL")
      } catch {
        // Ignore
      }
    }
  }
}
