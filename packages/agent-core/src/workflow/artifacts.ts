/**
 * Stage artifact parsing and bounding. Model output is untrusted data: it is parsed into bounded
 * structured artifacts, and only those artifacts move between stages.
 */
import type { MutationReviewPayload } from "../contracts/agent.ts"
import { normalizeFailureOutput, parseTestCounts, shortHash } from "../progress/fingerprint.ts"
import { generateCreateDiff, generateUnifiedDiff, sha256 } from "../tools/mutation-engine.ts"
import type { VerificationAction, VerificationResult } from "../tools/verification-contracts.ts"
import {
  ARTIFACT_LIMITS,
  BLOCKING_SEVERITIES,
  REVIEW_SEVERITIES,
  type ChangedFile,
  type CheckOutcome,
  type NetChange,
  type PlanArtifact,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewSeverity,
} from "./contracts.ts"

/** Removes model reasoning blocks; reasoning is never persisted or handed to another stage. */
export function stripReasoning(text: string): string {
  return text.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "")
}

export function boundText(value: unknown, maxChars: number = ARTIFACT_LIMITS.textChars): string {
  if (typeof value !== "string") return ""
  const trimmed = stripReasoning(value).trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`
}

function boundList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => boundText(item)).filter((item) => item.length > 0).slice(0, ARTIFACT_LIMITS.listItems)
}

/** Extracts the last JSON object from model output, preferring a fenced ```json block. */
export function extractJsonObject(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined
  const text = stripReasoning(input)
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1]!)
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates.toReversed()) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

// ---- PLAN -----------------------------------------------------------------------------------------

export function parsePlanArtifact(text: string | undefined): PlanArtifact | undefined {
  const raw = extractJsonObject(text)
  if (!raw) return undefined
  const plan: PlanArtifact = {
    goal: boundText(raw.goal),
    files: boundList(raw.files),
    steps: boundList(raw.steps),
    tests: boundList(raw.tests),
    risks: boundList(raw.risks),
    acceptanceCriteria: boundList(raw.acceptanceCriteria ?? raw.acceptance_criteria),
  }
  return plan.goal && plan.steps.length > 0 && plan.acceptanceCriteria.length > 0 ? plan : undefined
}

function list(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)"
}

export function renderPlan(plan: PlanArtifact): string {
  return [
    `Goal: ${plan.goal}`,
    `Files/areas:\n${list(plan.files)}`,
    `Steps:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    `Tests required:\n${list(plan.tests)}`,
    `Risks:\n${list(plan.risks)}`,
  ].join("\n\n")
}

// ---- IMPLEMENT ------------------------------------------------------------------------------------

export function changedFileFromMutation(payload: MutationReviewPayload, pass: number): ChangedFile {
  const diff = typeof payload.diff === "string" ? payload.diff : ""
  const truncated = diff.length > ARTIFACT_LIMITS.diffPerFileChars || (payload as { truncated?: boolean }).truncated === true
  return {
    pass,
    path: payload.path,
    operation: payload.operation,
    beforeHash: payload.beforeHash,
    afterHash: payload.afterHash,
    linesAdded: payload.linesAdded,
    linesRemoved: payload.linesRemoved,
    diff: diff.slice(0, ARTIFACT_LIMITS.diffPerFileChars),
    diffTruncated: truncated,
  }
}

/** Bounded combined rendering of the internal mutation history. Never shown to REVIEW as the final diff. */
export function renderDiff(changes: readonly ChangedFile[]): { text: string; truncated: boolean } {
  let text = ""
  let truncated = false
  for (const change of changes) {
    const block = `### ${change.operation} ${change.path} (+${change.linesAdded} −${change.linesRemoved})\n${change.diff}${change.diffTruncated ? "\n[diff truncated]" : ""}\n`
    if (text.length + block.length > ARTIFACT_LIMITS.diffChars) {
      truncated = true
      break
    }
    text += block
    truncated ||= change.diffTruncated
  }
  return { text: text.trimEnd(), truncated }
}

export function uniquePaths(changes: readonly ChangedFile[]): string[] {
  return [...new Set(changes.map((change) => change.path))]
}

function boundedDiff(diff: string, truncated: boolean): { diff: string; diffTruncated: boolean } {
  return { diff: diff.slice(0, ARTIFACT_LIMITS.diffPerFileChars), diffTruncated: truncated || diff.length > ARTIFACT_LIMITS.diffPerFileChars }
}

/**
 * The net change of one file from the workflow start state to its current content.
 *
 * `baseline` is the content at workflow start (null: the file did not exist; undefined: not
 * captured in this process). Returns undefined when the file has no net change (e.g. reverted).
 */
export function computeNetChange(path: string, baseline: string | null | undefined, current: string | undefined, history: readonly ChangedFile[]): NetChange | undefined {
  const currentHash = current === undefined ? "" : sha256(current)
  const changes = history.filter((change) => change.path === path)
  if (baseline !== undefined) {
    const baselineHash = baseline === null ? "" : sha256(baseline)
    if (baselineHash === currentHash) return undefined
    if (current === undefined) {
      const lines = baseline === null ? 0 : baseline.split("\n").length
      return { path, operation: "delete", baselineHash, currentHash, linesAdded: 0, linesRemoved: lines, diff: `--- a/${path}\n+++ /dev/null`, diffTruncated: false, source: "BASELINE" }
    }
    const generated = baseline === null
      ? generateCreateDiff(path, current, ARTIFACT_LIMITS.diffPerFileChars)
      : generateUnifiedDiff(path, baseline, current, ARTIFACT_LIMITS.diffPerFileChars)
    return { path, operation: baseline === null ? "create" : "modify", baselineHash, currentHash, linesAdded: generated.linesAdded, linesRemoved: generated.linesRemoved, ...boundedDiff(generated.unified, generated.truncated), source: "BASELINE" }
  }
  // The start content is not available (e.g. after a restart). Never fall back to stale history.
  const first = changes[0]
  const baselineHash = first?.beforeHash ?? ""
  if (baselineHash === currentHash) return undefined
  const operation = current === undefined ? "delete" : first?.operation === "create" ? "create" : "modify"
  if (changes.length === 1 && first && first.afterHash === currentHash) {
    return { path, operation, baselineHash, currentHash, linesAdded: first.linesAdded, linesRemoved: first.linesRemoved, ...boundedDiff(first.diff, first.diffTruncated), source: "SINGLE_CHANGE" }
  }
  const content = current ?? ""
  const shown = content.split("\n").map((line) => ` ${line}`).join("\n")
  return {
    path,
    operation,
    baselineHash,
    currentHash,
    linesAdded: 0,
    linesRemoved: 0,
    ...boundedDiff(`[net diff unavailable after restart; current content of ${path}]\n${shown}`, false),
    source: "CURRENT_CONTENT",
  }
}

/** The bounded net diff the reviewer sees: workflow start → current workspace. */
export function renderNetDiff(changes: readonly NetChange[]): { text: string; truncated: boolean } {
  let text = ""
  let truncated = false
  for (const change of changes) {
    const block = `### ${change.operation} ${change.path} (+${change.linesAdded} −${change.linesRemoved})\n${change.diff}${change.diffTruncated ? "\n[diff truncated]" : ""}\n`
    if (text.length + block.length > ARTIFACT_LIMITS.diffChars) {
      truncated = true
      break
    }
    text += block
    truncated ||= change.diffTruncated
  }
  return { text: text.trimEnd(), truncated }
}

/** Deterministic fingerprint of the net diff (empty net diff included). */
export function netDiffFingerprint(changes: readonly NetChange[]): string {
  return shortHash(changes.map((change) => `${change.path}\0${change.currentHash}`).toSorted().join("\n"))
}

// ---- TEST / VERIFY --------------------------------------------------------------------------------

/** Removes run-specific noise so equal failures share a fingerprint (one normalizer, ADR-031). */
export function normalizeOutput(output: string): string {
  return normalizeFailureOutput(output)
}

export function fingerprint(output: string): string {
  return shortHash(normalizeFailureOutput(output))
}

export function checkOutcome(action: VerificationAction, command: string, result: VerificationResult): CheckOutcome {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n")
  // Parsed from the full output before the excerpt is bounded.
  const counts = action === "TEST" ? parseTestCounts(combined) : undefined
  const testCounts = counts && (counts.total !== undefined || counts.passed !== undefined || counts.failed !== undefined)
    ? { ...(counts.total !== undefined ? { total: counts.total } : {}), ...(counts.passed !== undefined ? { passed: counts.passed } : {}), ...(counts.failed !== undefined ? { failed: counts.failed } : {}) }
    : undefined
  return {
    action,
    command,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    fingerprint: fingerprint(combined),
    excerpt: combined.length <= ARTIFACT_LIMITS.outputExcerptChars ? combined : `…${combined.slice(-(ARTIFACT_LIMITS.outputExcerptChars - 1))}`,
    ...(testCounts ? { testCounts } : {}),
    ...(counts && counts.failures.length > 0 && result.status !== "PASS" ? { failingTests: counts.failures } : {}),
  }
}

// ---- REVIEW ---------------------------------------------------------------------------------------

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export interface ReviewGrounding {
  readonly diff: string
  readonly changedFiles: readonly string[]
  /** Current contents of changed files, keyed by path (bounded). */
  readonly fileContents: ReadonlyMap<string, string>
}

/**
 * A finding is grounded when it names a changed file and quotes evidence that occurs verbatim
 * (whitespace-normalized) in the diff or that file's current content. Generic advice without a
 * quotable source is not a finding.
 */
export function isGrounded(finding: ReviewFinding, grounding: ReviewGrounding): boolean {
  if (!grounding.changedFiles.includes(finding.file)) return false
  const quote = normalizeForMatch(finding.evidence)
  if (quote.length < 4) return false
  if (normalizeForMatch(grounding.diff).includes(quote)) return true
  const content = grounding.fileContents.get(finding.file)
  return content !== undefined && normalizeForMatch(content).includes(quote)
}

function emptyCounts(): Record<ReviewSeverity, number> {
  return { BLOCKER: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NOTE: 0 }
}

/**
 * Parses and validates reviewer output. Returns undefined when the output carries no verdict at all
 * (the stage may be retried); NO_FINDINGS is a valid, first-class result.
 */
export function parseReviewEvidence(text: string | undefined, attempt: number, grounding: ReviewGrounding): ReviewEvidence | undefined {
  const raw = extractJsonObject(text)
  if (!raw || (raw.verdict !== "NO_FINDINGS" && raw.verdict !== "FINDINGS")) return undefined
  const findings: ReviewFinding[] = []
  let rejectedUngrounded = 0
  let rejectedMalformed = 0
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : []
  for (const [index, item] of rawFindings.entries()) {
    if (findings.length >= ARTIFACT_LIMITS.findings) break
    if (!item || typeof item !== "object") {
      rejectedMalformed += 1
      continue
    }
    const record = item as Record<string, unknown>
    const severity = typeof record.severity === "string" ? record.severity.toUpperCase() : ""
    const finding: ReviewFinding = {
      id: boundText(record.id, 32) || `F${index + 1}`,
      severity: severity as ReviewSeverity,
      file: boundText(record.file, 260),
      ...(typeof record.location === "string" && record.location.trim() ? { location: boundText(record.location, 80) } : {}),
      claim: boundText(record.claim, ARTIFACT_LIMITS.findingTextChars),
      evidence: boundText(record.evidence, ARTIFACT_LIMITS.findingTextChars),
      recommendedAction: boundText(record.recommendedAction ?? record.recommended_action, ARTIFACT_LIMITS.findingTextChars),
    }
    if (!(REVIEW_SEVERITIES as readonly string[]).includes(severity) || !finding.file || !finding.claim) {
      rejectedMalformed += 1
      continue
    }
    if (!isGrounded(finding, grounding)) {
      rejectedUngrounded += 1
      continue
    }
    findings.push(finding)
  }
  const counts = emptyCounts()
  for (const finding of findings) counts[finding.severity] += 1
  return {
    attempt,
    verdict: findings.length === 0 ? "NO_FINDINGS" : "FINDINGS",
    findings,
    blocking: findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity)).length,
    rejectedUngrounded,
    rejectedMalformed,
    counts,
  }
}
