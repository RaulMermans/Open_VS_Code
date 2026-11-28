import { spawnSync } from "node:child_process"
import { realpathSync, existsSync, readFileSync, statSync } from "node:fs"
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

/** Marker every fictional benchmark repository carries at its root (AGENTS.md, docs/evals/BENCHMARK_POLICY.md). */
export const BENCHMARK_MARKER = ".ovsc-benchmark.json"

export function benchmarkRoot(): string {
  return resolve(process.env.OPEN_VS_CODE_BENCHMARK_ROOT?.trim() || join(homedir(), "ovsc-benchmarks"))
}

/**
 * Benchmarks run only on fictional repositories: the workspace must carry the benchmark marker with
 * "fictional": true, and a git origin, if any, must lie inside the benchmark root. A clone of a real project has
 * neither, so it is refused before the app starts.
 */
export function assertBenchmarkWorkspace(workspace: string, root = benchmarkRoot()): void {
  const marker = join(workspace, BENCHMARK_MARKER)
  const refuse = (why: string) => new Error(`Benchmark workspace refused: ${why}. Benchmarks use fictional repositories only (AGENTS.md).`)
  if (!existsSync(marker)) throw refuse(`${BENCHMARK_MARKER} is missing`)
  let meta: { fictional?: unknown }
  try { meta = JSON.parse(readFileSync(marker, "utf8")) } catch { throw refuse(`${BENCHMARK_MARKER} is not valid JSON`) }
  if (meta.fictional !== true) throw refuse(`${BENCHMARK_MARKER} does not declare "fictional": true`)
  const origin = spawnSync("git", ["-C", workspace, "remote", "get-url", "origin"], { encoding: "utf8" })
  if (origin.status === 0) {
    const url = origin.stdout.trim()
    const local = url.replace(/^file:\/\//, "")
    if (!existsSync(local) || !existsSync(root) || !isInside(realpathSync(local), realpathSync(root))) throw refuse(`git origin ${url} is outside ${root}`)
  }
}
