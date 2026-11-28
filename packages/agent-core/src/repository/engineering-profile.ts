/**
 * Compact, evidence-backed repository engineering profile. Reads only well-known
 * manifests. Does not walk the tree and does not execute repository scripts.
 */
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { resolvePackageManager, type PackageManagerResolution } from "../tools/verification-discovery.ts"

export interface RepositoryEngineeringProfile {
  readonly root: string
  readonly packageManager: PackageManagerResolution
  readonly workspaces: readonly string[]
  readonly turbo: boolean
  readonly languages: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
  readonly agentsMd: boolean
  readonly missing: readonly string[]
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function loadRepositoryEngineeringProfile(workspaceRoot: string): RepositoryEngineeringProfile | undefined {
  const pkgPath = join(workspaceRoot, "package.json")
  if (!isFile(pkgPath) && !isFile(join(workspaceRoot, "pyproject.toml")) && !isFile(join(workspaceRoot, "AGENTS.md"))) {
    return undefined
  }
  const pkg = readJson(pkgPath) ?? {}
  const packageManager = resolvePackageManager(workspaceRoot, pkg)
  const missing: string[] = []
  if (packageManager.conflicts.length > 0) missing.push(`conflicting package managers: ${packageManager.conflicts.join("; ")}`)
  const workspaces: string[] = []
  if (isFile(join(workspaceRoot, "pnpm-workspace.yaml"))) workspaces.push("pnpm")
  const npmWorkspaces = pkg.workspaces
  if (Array.isArray(npmWorkspaces) || (npmWorkspaces && typeof npmWorkspaces === "object")) workspaces.push("npm")
  if (isFile(join(workspaceRoot, "turbo.json"))) workspaces.push("turbo")
  const scripts: Record<string, string> = {}
  const rawScripts = pkg.scripts
  if (rawScripts && typeof rawScripts === "object") {
    for (const name of ["test", "test:unit", "typecheck", "lint", "build"]) {
      const value = (rawScripts as Record<string, unknown>)[name]
      if (typeof value === "string" && value.trim()) scripts[name] = value.trim()
    }
  }
  const languages: string[] = []
  if (isFile(pkgPath)) languages.push("javascript")
  if (isFile(join(workspaceRoot, "tsconfig.json")) || isFile(join(workspaceRoot, "tsconfig.base.json"))) languages.push("typescript")
  if (isFile(join(workspaceRoot, "pyproject.toml")) || isFile(join(workspaceRoot, "requirements.txt"))) languages.push("python")
  if (!scripts.test && !scripts["test:unit"]) missing.push("no test script")
  return {
    root: workspaceRoot,
    packageManager,
    workspaces: [...new Set(workspaces)],
    turbo: isFile(join(workspaceRoot, "turbo.json")),
    languages,
    scripts,
    agentsMd: isFile(join(workspaceRoot, "AGENTS.md")),
    missing,
  }
}

export function formatEngineeringProfile(profile: RepositoryEngineeringProfile): string {
  const lines = [
    `Repository: ${profile.languages.join(", ") || "unknown languages"}`,
    `Package manager: ${profile.packageManager.name}${profile.packageManager.version ? `@${profile.packageManager.version}` : ""} (${profile.packageManager.signals.join(", ") || "default"})`,
    profile.workspaces.length > 0 ? `Workspaces: ${profile.workspaces.join(", ")}` : "",
    profile.turbo ? "Build system: turborepo" : "",
    Object.keys(profile.scripts).length > 0
      ? `Scripts: ${Object.entries(profile.scripts).map(([name, body]) => `${name}=${body}`).join("; ")}`
      : "Scripts: none declared",
    profile.agentsMd ? "Instructions: AGENTS.md present" : "",
    profile.missing.length > 0 ? `Gaps: ${profile.missing.join("; ")}` : "",
    profile.packageManager.conflicts.length > 0 ? `Conflicts: ${profile.packageManager.conflicts.join("; ")}` : "",
  ].filter(Boolean)
  return lines.join("\n")
}
