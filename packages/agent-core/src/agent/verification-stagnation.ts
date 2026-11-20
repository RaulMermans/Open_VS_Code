import type { ToolObservation } from "./observations.ts"

const ANSI = /\u001b\[[0-9;]*m/g
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

/**
 * Tests that failed in each of the last two failing verification runs although the agent applied an edit in
 * between: the same failure before and after this task's work, so more edits will not clear it.
 */
export function unchangedFailures(observations: readonly ToolObservation[]): string[] {
  const runs: number[] = []
  observations.forEach((observation, index) => { if (observation.toolName === "run_verification" && /Status: FAIL\b/.test(observation.content)) runs.push(index) })
  if (runs.length < 2) return []
  const [earlier, later] = [runs.at(-2)!, runs.at(-1)!]
  const edited = observations.slice(earlier + 1, later).some((item) => MUTATING.has(item.toolName) && item.ok)
  if (!edited) return []
  const before = new Set(failureFingerprint(observations[earlier]!.content))
  const after = failureFingerprint(observations[later]!.content)
  return after.length > 0 && after.every((name) => before.has(name)) ? after : []
}
