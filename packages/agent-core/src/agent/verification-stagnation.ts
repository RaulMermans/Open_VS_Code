import type { ToolObservation } from "./observations.ts"

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")
// Lines that name a failing test or suite in the common runners (vitest/jest, node:test/TAP, pytest, go test).
const FAILING = /^\s*(?:[×✗✘✕]|FAIL(?:ED)?\b|not ok\b|--- FAIL\b|ERROR\b)\s*(.*)$/i

/** The failing tests a verification output names, normalised so durations and markers do not make two runs differ. */
export function failureFingerprint(output: string): string[] {
  const names = new Set<string>()
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const match = FAILING.exec(raw)
    if (!match) continue
    const name = (match[1] ?? "").replace(/\s+\d+(?:\.\d+)?\s*m?s\s*$/i, "").replace(/\s+/g, " ").trim()
    if (name.length >= 6 && !/^(?:exit code|test files|tests|duration|\d+ (?:failed|passed))/i.test(name)) names.add(name.slice(0, 160))
  }
  return [...names]
}

const MUTATING = new Set(["apply_patch", "create_file", "rename_symbol"])

/** Name plus the first assertion, so the same test title with a different error is not the same failure. */
function failureSignatures(output: string): string[] {
  const cause = (output.replace(ANSI, "").match(/^(?:AssertionError|TypeError|ReferenceError|SyntaxError):[^\n]*/m)?.[0] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140)
  return failureFingerprint(output).map((name) => (cause ? `${name} :: ${cause}` : name))
}

/**
 * Failures that already failed before this task's first edit and still fail the same way.
 * Two identical failures after the task has started editing are an unsuccessful repair, not a pre-existing failure.
 * No pre-edit failing run means the provenance is unknown, which is not recorded as pre-existing.
 */
export function unchangedFailures(observations: readonly ToolObservation[]): string[] {
  const firstEdit = observations.findIndex((item) => MUTATING.has(item.toolName) && item.ok)
  if (firstEdit < 0) return []
  const baseline = observations.slice(0, firstEdit).filter((item) => item.toolName === "run_verification" && /Status: FAIL\b/.test(item.content))
  if (baseline.length === 0) return []
  const later = observations.slice(firstEdit + 1).filter((item) => item.toolName === "run_verification" && /Status: FAIL\b/.test(item.content))
  const latest = later.at(-1)
  if (!latest) return []
  const before = new Set(failureSignatures(baseline.at(-1)!.content))
  const after = failureSignatures(latest.content)
  const names = failureFingerprint(latest.content)
  return after.length > 0 && after.every((signature) => before.has(signature)) ? names : []
}
