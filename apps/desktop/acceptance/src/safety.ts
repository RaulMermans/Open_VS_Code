import { realpathSync, existsSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

const LIVE_PROFILE_NAMES = [
  "Open VS Code",
  "open-vs-code",
  "VSCodium",
  "Code",
]

export function liveProfileDirs(): string[] {
  const home = homedir()
  const dirs = [
    ...LIVE_PROFILE_NAMES.map((name) => resolve(home, ".config", name)),
    resolve(home, ".open-vs-code-desktop"),
    resolve(home, ".vscode"),
  ]
  return dirs.filter((dir) => existsSync(dir))
}

export function isInside(child: string, parent: string): boolean {
  const root = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(root)
}

export function liveProfileFingerprint(): Record<string, { mtimeMs: number; size: number }> {
  const result: Record<string, { mtimeMs: number; size: number }> = {}
  for (const dir of liveProfileDirs()) {
    for (const relative of ["User/settings.json"]) {
      const path = join(dir, relative)
      if (!existsSync(path)) continue
      const stat = statSync(path)
      result[path] = { mtimeMs: stat.mtimeMs, size: stat.size }
    }
  }
  return result
}

export function fingerprintDrift(before: Record<string, { mtimeMs: number; size: number }>, after: Record<string, { mtimeMs: number; size: number }>): string[] {
  const problems: string[] = []
  for (const [path, prior] of Object.entries(before)) {
    const next = after[path]
    if (!next) {
      problems.push(`live profile path missing: ${path}`)
      continue
    }
    if (next.mtimeMs !== prior.mtimeMs || next.size !== prior.size) problems.push(`live profile changed: ${path}`)
  }
  return problems
}

export function assertIsolatedPath(target: string, label: string): string {
  const resolved = resolve(target)
  const real = existsSync(resolved) ? realpathSync(resolved) : resolved
  const temp = realpathSync(tmpdir())
  if (!isInside(real, temp)) {
    throw new Error(`${label} must stay under the system temp directory: ${real}`)
  }
  for (const live of liveProfileDirs()) {
    const liveReal = realpathSync(live)
    if (isInside(real, liveReal) || isInside(liveReal, real)) {
      throw new Error(`${label} overlaps a live editor profile: ${liveReal}`)
    }
  }
  return real
}

export function assertLabWorkspace(workspace: string, repositoryRoot: string): string {
  const real = assertIsolatedPath(workspace, "Acceptance workspace")
  const repo = realpathSync(repositoryRoot)
  if (isInside(real, repo)) {
    throw new Error(`Acceptance workspace must not be inside the product repository: ${real}`)
  }
  return real
}

export function assertApprovalTarget(workspace: string, repositoryRoot: string, decision: "approve" | "reject" | "none"): void {
  if (decision === "none") return
  assertLabWorkspace(workspace, repositoryRoot)
}

export function chromeSandboxMode(binaryPath: string): string {
  const sandbox = resolve(binaryPath, "..", "chrome-sandbox")
  if (!existsSync(sandbox)) throw new Error(`chrome-sandbox is missing beside ${binaryPath}`)
  return (statSync(sandbox).mode & 0o7777).toString(8)
}
