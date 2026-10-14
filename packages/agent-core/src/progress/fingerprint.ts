/**
 * Deterministic fingerprints (Sprint 5C, ADR-031). One normalizer for failure output, used by the
 * workflow's check fingerprints and by the non-progress monitor alike.
 *
 * Normalization removes run-specific noise (ANSI codes, timestamps, durations, temp paths, request
 * ids, random ports, stack-frame line/column numbers) but keeps the content that distinguishes one
 * failure from another: assertion text, expected/actual values, test names and messages.
 */
import { createHash } from "node:crypto"

import { redactRuntimeEvalSecrets } from "../runtime-evals/evidence.ts"

export function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

export function normalizeFailureOutput(output: string): string {
  return output
    .replace(ANSI, "")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(request[-_ ]?id|req[-_]?id|trace[-_ ]?id|correlation[-_ ]?id)\s*[:=]\s*["']?[\w-]+/gi, "$1=<id>")
    .replace(/(\.[cm]?[jt]sx?|\.py|\.rs|\.go|\.java):\d+(?::\d+)?/g, "$1:<l>")
    .replace(/(?:\/private)?\/(?:var\/folders|tmp|temp)\/[^\s:'")]+/gi, "<tmp>")
    .replace(/[A-Za-z]:\\(?:Users\\[^\\]+\\AppData\\Local\\)?Temp\\[^\s:'")]+/gi, "<tmp>")
    .replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/gi, "$1:<port>")
    .replace(/\b(port)\s+\d{2,5}\b/gi, "$1 <port>")
    .replace(/\bline \d+\b/gi, "line <l>")
    .replace(/\b(duration_ms|duration|elapsed|time)([:=]?\s*)\d+(\.\d+)?/gi, "$1$2<t>")
    .replace(/\(\d+(\.\d+)?\s?(ms|s|sec|seconds|µs|us|ns)\)/gi, "(<t>)")
    .replace(/\b\d+(\.\d+)?\s?(ms|sec|seconds|µs|us|ns)\b/gi, "<t>")
    .replace(/\b\d+\.\d+s\b/g, "<t>")
    .replace(/\b0x[0-9a-f]{6,}\b/gi, "<addr>")
    .replace(/\bpid[:= ]\s*\d+\b/gi, "pid=<pid>")
    .replace(/\s+/g, " ")
    .trim()
}

export function errorFingerprint(output: string): string {
  return shortHash(normalizeFailureOutput(output))
}

function stable(value: unknown, depth = 0): unknown {
  if (depth > 8) return "<deep>"
  if (Array.isArray(value)) return value.map((item) => stable(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).toSorted().map((key) => [key, stable((value as Record<string, unknown>)[key], depth + 1)]))
  }
  if (typeof value === "string") return value.replace(/\r\n/g, "\n")
  return value
}

/** Normalized, order-independent tool-call fingerprint. Secrets are redacted before hashing. */
export function toolFingerprint(name: string, args: unknown): string {
  return shortHash(`${name}\0${redactRuntimeEvalSecrets(JSON.stringify(stable(args) ?? null))}`)
}

/** Order-independent fingerprint of a set of fingerprints (e.g. failing tests, blocking findings). */
export function setFingerprint(items: readonly string[]): string | undefined {
  if (items.length === 0) return undefined
  return shortHash([...new Set(items)].toSorted().join("\n"))
}

export interface ParsedTestCounts {
  readonly total?: number
  readonly passed?: number
  readonly failed?: number
  /** Fingerprints of individual failing tests (bounded). Empty when names are not recognizable. */
  readonly failures: readonly string[]
}

const MAX_FAILURE_NAMES = 20

/**
 * Best-effort, deterministic parse of common test-runner summaries (node:test/TAP, Jest/Vitest,
 * Mocha, pytest). Unknown formats yield no counts rather than a guess.
 */
export function parseTestCounts(output: string): ParsedTestCounts {
  const text = output.replace(ANSI, "")
  let total: number | undefined
  let passed: number | undefined
  let failed: number | undefined
  const tapPass = text.match(/^#\s*pass\s+(\d+)/im)
  const tapFail = text.match(/^#\s*fail\s+(\d+)/im)
  const tapTests = text.match(/^#\s*tests\s+(\d+)/im)
  if (tapFail) {
    failed = Number(tapFail[1])
    if (tapPass) passed = Number(tapPass[1])
    if (tapTests) total = Number(tapTests[1])
  }
  const jest = text.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+\w+,\s*)*?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/i)
  if (failed === undefined && jest) {
    failed = Number(jest[1] ?? 0)
    if (jest[2]) passed = Number(jest[2])
    total = Number(jest[3])
  }
  const mochaPassing = text.match(/(\d+)\s+passing\b/i)
  const mochaFailing = text.match(/(\d+)\s+failing\b/i)
  if (failed === undefined && (mochaPassing || mochaFailing)) {
    failed = Number(mochaFailing?.[1] ?? 0)
    if (mochaPassing) passed = Number(mochaPassing[1])
  }
  const pytest = text.match(/=+\s*(?:(\d+)\s+failed)?(?:,\s*)?(?:(\d+)\s+passed)?[^=\n]*\bin\b[^=\n]*=+/i)
  if (failed === undefined && pytest && (pytest[1] || pytest[2])) {
    failed = Number(pytest[1] ?? 0)
    if (pytest[2]) passed = Number(pytest[2])
  }
  const names: string[] = []
  for (const match of text.matchAll(/^\s*(?:not ok \d+ - |✖ |✗ |× |FAIL(?:ED)?:? |● )(.+?)\s*$/gm)) {
    const name = normalizeFailureOutput(match[1]!).replace(/\(<t>\)$/, "").trim()
    if (name && !/^\d+ (tests?|failed)/i.test(name)) names.push(name)
    if (names.length >= MAX_FAILURE_NAMES) break
  }
  return {
    ...(total !== undefined ? { total } : {}),
    ...(passed !== undefined ? { passed } : {}),
    ...(failed !== undefined ? { failed } : {}),
    failures: [...new Set(names)].map((name) => shortHash(name)),
  }
}
