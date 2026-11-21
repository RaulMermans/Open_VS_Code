import { isTestArtifactPath } from "../agent/tool-contract.ts"

/**
 * Compact failure summary from the reporter text the project already prints.
 * The approved command is unchanged: no extra reporter and no test-config edit.
 * A kind is set only when the text matches that kind. Otherwise the kind is unknown.
 */

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")

export type VerificationFailureKind =
  | "compilation"
  | "missing_import_or_export"
  | "test_discovery"
  | "assertion"
  | "runtime"
  | "timeout"
  | "environment"
  | "unknown"

export interface VerificationFailureGroup {
  readonly kind: VerificationFailureKind
  readonly summary: string
  readonly tests: readonly string[]
  readonly locations: readonly string[]
}

export interface VerificationSummary {
  readonly passed?: number
  readonly failed?: number
  readonly skipped?: number
  readonly groups: readonly VerificationFailureGroup[]
  readonly implicatedFiles: readonly string[]
  readonly text: string
}

const FAIL_LINE = /^\s*FAIL\s+(.+?)\s*$/
const LOCATION = /(?:❯|at)\s+([^\s:]+:\d+:\d+)/
const MAX_GROUPS = 6
const MAX_TESTS = 8
const MAX_TEXT = 1_600

function kindOf(message: string): VerificationFailureKind {
  if (/timed out|Test timed out|ETIMEDOUT/i.test(message)) return "timeout"
  if (/No test files found|No tests found|Collected 0 items/i.test(message)) return "test_discovery"
  if (/does not provide an export|has no exported member|is not exported|Cannot find module|cannot find module|Module not found|undefined was given|is not a constructor/i.test(message)) return "missing_import_or_export"
  if (/error TS\d+|SyntaxError|\bTS\d{4}:/.test(message)) return "compilation"
  if (/AssertionError|\bExpected\b|\bexpected\b/.test(message)) return "assertion"
  if (/TypeError|ReferenceError|\bError:/.test(message)) return "runtime"
  return "unknown"
}

function counts(text: string): { passed?: number; failed?: number; skipped?: number } {
  const vitest = /Tests\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+skipped)?/i.exec(text)
  if (vitest) {
    return {
      failed: Number(vitest[1]),
      ...(vitest[2] !== undefined ? { passed: Number(vitest[2]) } : {}),
      ...(vitest[3] !== undefined ? { skipped: Number(vitest[3]) } : {}),
    }
  }
  const pytest = /(\d+)\s+failed,\s+(\d+)\s+passed/.exec(text)
  if (pytest) return { failed: Number(pytest[1]), passed: Number(pytest[2]) }
  const nodeFail = /(?:#|ℹ)\s+fail\s+(\d+)/.exec(text)
  const nodePass = /(?:#|ℹ)\s+pass\s+(\d+)/.exec(text)
  if (nodeFail || nodePass) {
    return {
      ...(nodeFail ? { failed: Number(nodeFail[1]) } : {}),
      ...(nodePass ? { passed: Number(nodePass[1]) } : {}),
    }
  }
  return {}
}

export function summarizeVerification(output: string): VerificationSummary {
  const text = output.replace(ANSI, "")
  const lines = text.split("\n")
  const blocks: Array<{ name: string; body: string[] }> = []
  for (let index = 0; index < lines.length; index++) {
    const match = FAIL_LINE.exec(lines[index] ?? "")
    if (!match?.[1]) continue
    const body: string[] = []
    for (let next = index + 1; next < lines.length && next < index + 24; next++) {
      if (FAIL_LINE.test(lines[next] ?? "")) break
      body.push(lines[next] ?? "")
    }
    blocks.push({ name: match[1].trim().slice(0, 180), body })
  }
  const tally = counts(text)
  const groups = new Map<string, { kind: VerificationFailureKind; summary: string; tests: string[]; locations: string[] }>()
  const add = (name: string, body: string) => {
    const message = /^(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error):[^\n]*/m.exec(body)?.[0]?.replace(/\s+/g, " ").trim()
      ?? body.split("\n").map((line) => line.trim()).find((line) => line.length > 0)
      ?? "failed"
    const kind = kindOf(`${message}\n${body}`)
    const summary = message.slice(0, 220)
    const key = `${kind}\0${summary}`
    const group = groups.get(key) ?? { kind, summary, tests: [], locations: [] }
    if (group.tests.length < MAX_TESTS) group.tests.push(name.slice(0, 180))
    const location = LOCATION.exec(body)?.[1]
    if (location && !group.locations.includes(location)) group.locations.push(location)
    groups.set(key, group)
  }
  for (const block of blocks) add(block.name, block.body.join("\n"))
  if (blocks.length === 0) {
    const named = /^\s*(?:[×✗✘✕]|not ok\b|--- FAIL\b|FAILED\s+)(.*)$/i
    for (const line of lines) {
      const match = named.exec(line)
      const name = match?.[1]?.replace(/\s+\d+(?:\.\d+)?\s*m?s\s*$/i, "").trim()
      if (name && name.length >= 6) add(name.slice(0, 180), text)
    }
  }
  if (groups.size === 0 && /No test files found|No tests found|Collected 0 items/i.test(text)) {
    groups.set("test_discovery", { kind: "test_discovery", summary: "No tests were collected.", tests: [], locations: [] })
  }
  const listed = [...groups.values()].slice(0, MAX_GROUPS)
  const implicated = [...new Set(listed.flatMap((group) => group.locations.map((location) => location.replace(/:\d+:\d+$/, ""))))]
    .filter((file) => !file.includes("node_modules") && !file.startsWith("/"))
    .slice(0, 8)
  const countText = [
    tally.failed !== undefined ? `${tally.failed} failed` : "",
    tally.passed !== undefined ? `${tally.passed} passed` : "",
    tally.skipped !== undefined ? `${tally.skipped} skipped` : "",
  ].filter(Boolean).join(", ")
  const groupText = listed.map((group, index) => {
    const where = group.locations.slice(0, 3).join(", ")
    return `${index + 1}. ${group.kind} (${group.tests.length}): ${group.summary}${where ? `\n   at ${where}` : ""}\n   ${group.tests.join("\n   ")}`
  }).join("\n")
  const rendered = [
    countText ? `Tests: ${countText}.` : "",
    listed.length > 0 ? `Failure groups:\n${groupText}` : "",
    implicated.length > 0 ? `Implicated files: ${implicated.join(", ")}.` : "",
    listed.length > 0
      ? (implicated.length > 0 && implicated.every((file) => isTestArtifactPath(file))
        ? "These locations are assertions in tests. Change the implementation or the export they use. Do not edit the test unless the task says to, then run verification again."
        : "Edit the implementation these failures exercise, then run verification again.")
      : "",
  ].filter(Boolean).join("\n")
  return {
    ...tally,
    groups: listed,
    implicatedFiles: implicated,
    text: rendered.length > MAX_TEXT ? `${rendered.slice(0, MAX_TEXT)}\n[summary truncated]` : rendered,
  }
}
