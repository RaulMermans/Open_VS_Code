import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Sandboxing for agent-initiated commands (ADR-046).
 *
 * The Electron/Chromium sandbox protects the renderer, not the processes the agent starts. Verification
 * commands are therefore wrapped in bubblewrap when it is available:
 *   - no network (all namespaces unshared, including net),
 *   - an empty tmpfs HOME, so ~/.ssh, ~/.config, keyrings and other projects are not visible,
 *   - read-only system directories and read-only toolchains found on PATH,
 *   - the workspace is the only writable host path; /tmp is a private tmpfs,
 *   - a cleared environment, a new session, and death with the parent process.
 *
 * Wrapping happens after the engine's own containment checks; it narrows what an approved command can do.
 */
export type CommandSandboxMode = "auto" | "required" | "off"

export interface SandboxStatus {
  readonly mode: CommandSandboxMode
  readonly sandboxed: boolean
  readonly backend?: "bubblewrap"
  /** Why the command was not sandboxed, when it was not. */
  readonly reason?: string
}

export interface SandboxPlan {
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
  readonly status: SandboxStatus
}

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap"]
let probeCache: { available: boolean; path?: string; reason?: string } | undefined

/** Finds a working bubblewrap. The probe runs once per process; AppArmor or kernel policy can block it. */
export function detectBubblewrap(): { available: boolean; path?: string; reason?: string } {
  if (probeCache) return probeCache
  if (process.platform !== "linux") return (probeCache = { available: false, reason: "bubblewrap is Linux-only" })
  const bwrap = BWRAP_CANDIDATES.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  if (!bwrap) return (probeCache = { available: false, reason: "bubblewrap (bwrap) is not installed" })
  const probe = spawnSync(bwrap, ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "--", "/bin/true"], { timeout: 5_000, stdio: "pipe" })
  if (probe.status !== 0) {
    const detail = String(probe.stderr ?? "").trim().split("\n")[0] || `exit ${String(probe.status)}`
    return (probeCache = { available: false, path: bwrap, reason: `bubblewrap cannot create namespaces here: ${detail}` })
  }
  return (probeCache = { available: true, path: bwrap })
}

/** Test seam: forget the cached probe. */
export function resetBubblewrapProbe(): void {
  probeCache = undefined
}

function realOrUndefined(target: string): string | undefined {
  try {
    return realpathSync(target)
  } catch {
    return undefined
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/**
 * Read-only toolchain directories under HOME that commands need (nvm, ~/.local, pyenv...). A PATH entry
 * ending in /bin also exposes its prefix (node needs ../lib). HOME itself is never exposed.
 */
function toolchainBinds(home: string, pathEntries: readonly string[], executable: string): string[] {
  const dirs = new Set<string>()
  const add = (dir: string | undefined) => {
    if (!dir || !existsSync(dir)) return
    const real = realOrUndefined(dir) ?? dir
    if (real === home || !isInside(home, real)) return
    dirs.add(real)
  }
  for (const entry of [...pathEntries, path.dirname(executable), path.dirname(realOrUndefined(executable) ?? executable)]) {
    if (!path.isAbsolute(entry) || !isInside(home, entry)) continue
    add(entry)
    if (path.basename(entry) === "bin") add(path.dirname(entry))
  }
  add(path.join(home, ".local", "lib"))
  // Drop directories already covered by a parent bind.
  const sorted = [...dirs].toSorted((a, b) => a.length - b.length)
  return sorted.filter((dir, index) => !sorted.slice(0, index).some((parent) => isInside(parent, dir)))
}

export function planSandboxedCommand(input: {
  readonly mode: CommandSandboxMode
  readonly workspaceRoot: string
  readonly cwd: string
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
}): SandboxPlan | { readonly error: string; readonly status: SandboxStatus } {
  const unsandboxed = (reason: string): SandboxPlan => ({
    executable: input.executable,
    args: input.args,
    env: input.env,
    status: { mode: input.mode, sandboxed: false, reason },
  })
  if (input.mode === "off") return unsandboxed("command sandbox is turned off")
  const bwrap = detectBubblewrap()
  if (!bwrap.available || !bwrap.path) {
    const reason = bwrap.reason ?? "bubblewrap is unavailable"
    if (input.mode === "required") return { error: `Command sandbox is required but ${reason}.`, status: { mode: input.mode, sandboxed: false, reason } }
    return unsandboxed(reason)
  }

  const home = realOrUndefined(os.homedir()) ?? os.homedir()
  const workspace = realOrUndefined(input.workspaceRoot) ?? input.workspaceRoot
  const cwd = realOrUndefined(input.cwd) ?? input.cwd
  const args: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
  ]
  for (const dir of ["/usr", "/etc", "/opt", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"]) {
    if (existsSync(dir)) args.push("--ro-bind", dir, dir)
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run")
  // An empty HOME hides credentials, other projects and editor state. Toolchains are re-exposed read-only.
  args.push("--tmpfs", home)
  const pathEntries = (input.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  for (const dir of toolchainBinds(home, pathEntries, input.executable)) args.push("--ro-bind", dir, dir)
  // The workspace is the only writable host path. It may live outside HOME (for example under /tmp).
  args.push("--bind", workspace, workspace)
  args.push("--chdir", cwd)
  const env: Record<string, string> = { ...input.env, HOME: home, TMPDIR: "/tmp", LANG: input.env.LANG ?? "C.UTF-8" }
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value)
  args.push("--", input.executable, ...input.args)
  return { executable: bwrap.path, args, env, status: { mode: input.mode, sandboxed: true, backend: "bubblewrap" } }
}

/** What execution would do under this mode, for the approval card. */
export function predictSandbox(mode: CommandSandboxMode): SandboxStatus {
  if (mode === "off") return { mode, sandboxed: false, reason: "command sandbox is turned off" }
  const bwrap = detectBubblewrap()
  if (bwrap.available) return { mode, sandboxed: true, backend: "bubblewrap" }
  return { mode, sandboxed: false, reason: mode === "required" ? `required but ${bwrap.reason ?? "unavailable"}; the command will not run` : (bwrap.reason ?? "bubblewrap is unavailable") }
}

export function describeSandbox(status: SandboxStatus): string {
  return status.sandboxed
    ? "Sandbox: bubblewrap (no network, workspace-only writes, private HOME and /tmp)"
    : `Sandbox: none (${status.reason ?? "not sandboxed"})`
}
