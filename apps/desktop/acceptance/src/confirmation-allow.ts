import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

export interface StructuredConfirmation {
  readonly id: string
  readonly kind: "mutation" | "command" | "unknown"
  readonly operation: string
  readonly path: string
  readonly cwd: string
  readonly executable: string
  readonly args: string
  readonly command: string
}

const DENIED_EXECUTABLES = new Set([
  "rm",
  "rmdir",
  "dd",
  "mkfs",
  "mkfs.ext4",
  "shred",
  "shutdown",
  "reboot",
  "poweroff",
])

export function resolveInsideWorkspace(workspace: string, requested: string): string | null {
  if (!workspace || !requested || requested.includes("\0")) return null
  const normalized = requested.replaceAll("\\", "/").trim()
  if (!normalized || normalized.split("/").includes("..")) return null
  const root = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace)
  const absolute = isAbsolute(normalized) ? resolve(normalized) : resolve(root, normalized)
  if (!isInside(root, absolute)) return null
  if (existsSync(absolute)) {
    const real = realpathSync(absolute)
    return isInside(root, real) ? real : null
  }
  const parent = resolve(absolute, "..")
  if (existsSync(parent)) {
    const realParent = realpathSync(parent)
    if (!isInside(root, realParent)) return null
    const name = absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))
    if (!name || name.includes("/") || name.includes("..")) return null
  }
  return absolute
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

function baseName(executable: string): string {
  const normalized = executable.replaceAll("\\", "/").trim()
  const parts = normalized.split("/")
  return parts[parts.length - 1] ?? normalized
}

export function permitConfirmation(input: {
  readonly confirmation: StructuredConfirmation
  readonly workspace: string
  readonly decision: "approve" | "reject"
}): { readonly permit: boolean; readonly reason: string; readonly resolved: string } {
  const confirmation = input.confirmation
  if (!confirmation.id) return { permit: false, reason: "confirmation has no id", resolved: "" }
  if (input.decision === "reject") {
    return { permit: true, reason: "rejection does not apply the operation", resolved: "" }
  }
  if (confirmation.kind === "command" || confirmation.operation === "command") {
    const executable = baseName(confirmation.executable || confirmation.command.split(/\s+/)[0] || "")
    const command = `${confirmation.command} ${confirmation.args}`.toLowerCase()
    if (DENIED_EXECUTABLES.has(executable) || /\brm\b/.test(command) || command.includes("mkfs")) {
      return { permit: false, reason: `command ${executable || "unknown"} is not on the fixture allowlist`, resolved: "" }
    }
    const cwd = resolveInsideWorkspace(input.workspace, confirmation.cwd || ".")
    if (!cwd) return { permit: false, reason: "command directory is outside the fixture", resolved: "" }
    return { permit: true, reason: "command cwd is inside the fixture", resolved: cwd }
  }
  if (confirmation.kind !== "mutation") {
    return { permit: false, reason: "confirmation has no structured operation", resolved: "" }
  }
  if (confirmation.operation !== "patch" && confirmation.operation !== "create") {
    return { permit: false, reason: `mutation operation ${confirmation.operation || "unknown"} is not allowlisted`, resolved: "" }
  }
  if (!confirmation.path) return { permit: false, reason: "mutation has no target path", resolved: "" }
  const resolved = resolveInsideWorkspace(input.workspace, confirmation.path)
  if (!resolved) return { permit: false, reason: `path ${confirmation.path} is outside the fixture`, resolved: "" }
  return { permit: true, reason: `${confirmation.operation} ${confirmation.path}`, resolved }
}
