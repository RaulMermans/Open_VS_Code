/**
 * Stage artifact parsing and bounding. Model output is untrusted data: it is parsed into bounded
 * structured artifacts, and only those artifacts move between stages.
 */
import { createHash } from "node:crypto"

import type { MutationReviewPayload } from "../contracts/agent.ts"
import type { VerificationAction, VerificationResult } from "../tools/verification-contracts.ts"
import {
  ARTIFACT_LIMITS,
  BLOCKING_SEVERITIES,
  REVIEW_SEVERITIES,
  type ChangedFile,
  type CheckOutcome,
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

/** The bounded combined diff the reviewer sees. */
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

// ---- TEST / VERIFY --------------------------------------------------------------------------------

/** Removes timing and other run-specific noise so equal failures share a fingerprint. */
export function normalizeOutput(output: string): string {
  return output
    .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/gi, "<t>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>")
    .replace(/\s+/g, " ")
    .trim()
}

export function fingerprint(output: string): string {
  return createHash("sha256").update(normalizeOutput(output), "utf8").digest("hex").slice(0, 16)
}

export function checkOutcome(action: VerificationAction, command: string, result: VerificationResult): CheckOutcome {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n")
  return {
    action,
    command,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    fingerprint: fingerprint(combined),
    excerpt: combined.length <= ARTIFACT_LIMITS.outputExcerptChars ? combined : `…${combined.slice(-(ARTIFACT_LIMITS.outputExcerptChars - 1))}`,
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
