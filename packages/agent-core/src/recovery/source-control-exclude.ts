import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

/** Runtime files that must stay on disk and stay out of an ordinary git status. */
const RULES = [
  ".open-vs-code/recovery/",
  ".open-vs-code/model-performance-ledger.json",
]

/**
 * Adds local git exclude rules for recovery and telemetry files.
 * This does not edit a committed .gitignore and does not delete anything.
 */
export function excludeRuntimeArtifactsFromSourceControl(workspaceRoot: string): void {
  const gitDir = join(workspaceRoot, ".git")
  if (!existsSync(gitDir)) return
  try {
    if (!statSync(gitDir).isDirectory()) return
  } catch {
    return
  }
  const excludePath = join(gitDir, "info", "exclude")
  mkdirSync(dirname(excludePath), { recursive: true })
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
  const present = new Set(current.split("\n").map((line) => line.trim()))
  const missing = RULES.filter((rule) => !present.has(rule))
  if (missing.length === 0) return
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n"
  appendFileSync(excludePath, `${prefix}${missing.join("\n")}\n`)
}
