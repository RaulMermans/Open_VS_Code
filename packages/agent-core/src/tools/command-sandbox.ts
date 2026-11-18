import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, readlinkSync, realpathSync } from "node:fs"
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
  /** Resource limits applied through a user cgroup scope, when available. */
  readonly limits?: string
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

/** Test seam: forget the cached probe, or force its result (e.g. bubblewrap unavailable). */
export function resetBubblewrapProbe(forced?: { available: boolean; path?: string; reason?: string }): void {
  probeCache = forced
  limitsCache = undefined
}

export const SANDBOX_LIMITS = { memory: "4G", tasks: 512 } as const
let limitsCache: { available: boolean; path?: string; env?: Record<string, string> } | undefined

/**
 * Hard memory (no swap) and process-count caps through an unprivileged systemd user scope (cgroup v2
 * delegation). Probed once; when unavailable the sandbox still runs and its status says so.
 */
export function detectResourceLimits(): { available: boolean; path?: string; env?: Record<string, string> } {
  if (limitsCache) return limitsCache
  const systemdRun = ["/usr/bin/systemd-run", "/bin/systemd-run"].find((candidate) => existsSync(candidate))
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (!systemdRun || !runtimeDir) return (limitsCache = { available: false })
  const env: Record<string, string> = { XDG_RUNTIME_DIR: runtimeDir, PATH: "/usr/bin:/bin" }
  if (process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS
  const probe = spawnSync(systemdRun, ["--user", "--scope", "--quiet", "-p", "MemoryMax=64M", "-p", "TasksMax=8", "--", "/bin/true"], { timeout: 5_000, stdio: "pipe", env })
  return (limitsCache = probe.status === 0 ? { available: true, path: systemdRun, env } : { available: false })
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

/**
 * Each hop of the executable's symlink chain that lives under the hidden HOME (a virtualenv's bin/python ->
 * ~/tools/python/cpython-3.12/bin/python3.12, itself a symlinked directory): that hop's install prefix
 * (the parent of its bin/), exposed read-only at the path the link uses, so the chain resolves in the
 * sandbox. Returns [source, destination] pairs; nothing outside the interpreter's own installation.
 */
function symlinkChainBinds(home: string, executable: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  let current = executable
  for (let hop = 0; hop < 8; hop += 1) {
    let target: string
    try {
      target = readlinkSync(current)
    } catch {
      break
    }
    const next = path.resolve(path.dirname(current), target)
    const dir = path.dirname(next)
    const prefix = path.basename(dir) === "bin" ? path.dirname(dir) : dir
    const real = realOrUndefined(prefix)
    if (real && prefix !== home && isInside(home, prefix) && real !== home && isInside(home, real)) pairs.push([real, prefix])
    current = next
  }
  return pairs
}

export function planSandboxedCommand(input: {
  readonly mode: CommandSandboxMode
  readonly workspaceRoot: string
  readonly cwd: string
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
  /** Extra host directories exposed read-only (validated by the caller), e.g. a cached package manager. */
  readonly readOnlyBinds?: readonly string[]
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
  for (const dir of input.readOnlyBinds ?? []) args.push("--ro-bind", dir, dir)
  for (const [source, destination] of symlinkChainBinds(home, input.executable)) {
    if (source !== destination) args.push("--ro-bind", source, destination)
  }
  // The workspace is the only writable host path. It may live outside HOME (for example under /tmp).
  args.push("--bind", workspace, workspace)
  args.push("--chdir", cwd)
  const env: Record<string, string> = { ...input.env, HOME: home, TMPDIR: "/tmp", LANG: input.env.LANG ?? "C.UTF-8" }
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value)
  args.push("--", input.executable, ...input.args)
  const limits = detectResourceLimits()
  if (limits.available && limits.path) {
    // systemd-run execs bwrap inside a new cgroup scope; its D-Bus variables never enter the sandbox (--clearenv).
    return {
      executable: limits.path,
      args: ["--user", "--scope", "--quiet", "-p", `MemoryMax=${SANDBOX_LIMITS.memory}`, "-p", "MemorySwapMax=0", "-p", `TasksMax=${SANDBOX_LIMITS.tasks}`, "--", bwrap.path, ...args],
      env: { ...env, ...limits.env },
      status: { mode: input.mode, sandboxed: true, backend: "bubblewrap", limits: `memory ${SANDBOX_LIMITS.memory}B, ${SANDBOX_LIMITS.tasks} tasks` },
    }
  }
  return { executable: bwrap.path, args, env, status: { mode: input.mode, sandboxed: true, backend: "bubblewrap", limits: "none (user cgroups unavailable)" } }
}

/** What execution would do under this mode, for the approval card. */
export function predictSandbox(mode: CommandSandboxMode): SandboxStatus {
  if (mode === "off") return { mode, sandboxed: false, reason: "command sandbox is turned off" }
  const bwrap = detectBubblewrap()
  if (bwrap.available) {
    const limits = detectResourceLimits()
    return { mode, sandboxed: true, backend: "bubblewrap", limits: limits.available ? `memory ${SANDBOX_LIMITS.memory}B, ${SANDBOX_LIMITS.tasks} tasks` : "none (user cgroups unavailable)" }
  }
  return { mode, sandboxed: false, reason: mode === "required" ? `required but ${bwrap.reason ?? "unavailable"}; the command will not run` : (bwrap.reason ?? "bubblewrap is unavailable") }
}

export function describeSandbox(status: SandboxStatus): string {
  return status.sandboxed
    ? `Sandbox: bubblewrap (no network, workspace-only writes, private HOME and /tmp; limits: ${status.limits ?? "none"})`
    : `Sandbox: none (${status.reason ?? "not sandboxed"})`
}
