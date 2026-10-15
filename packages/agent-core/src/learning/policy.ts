/**
 * Deterministic learning policy (Sprint 5D, ADR-032): normalisation and deduplication, project vs
 * reusable scope, trust, privacy and evidence scoring. No embeddings, no model calls.
 */
import { createHash } from "node:crypto"

import { findUnsafeDirective } from "../skills/schema.ts"
import { sanitizePersistedText } from "../workflow/persistence.ts"
import {
  LEARNING_LIMITS,
  LEARNING_THRESHOLDS,
  type LearningConfidence,
  type LearningKind,
  type LearningObservation,
  type LearningRecord,
  type LearningScope,
} from "./contracts.ts"

export function shortDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

// ---- privacy ---------------------------------------------------------------------------------------

/** The 5B/5C persistence boundary (canonical redactor + reasoning strip), then a field bound. */
export function sanitizeLearningText(text: string, maxChars: number): string {
  const clean = sanitizePersistedText(text).replace(/\s+/g, " ").trim()
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`
}

// ---- normalisation and dedupe ----------------------------------------------------------------------

const STOPWORDS = new Set(["a", "an", "the", "to", "of", "and", "or", "in", "on", "for", "with", "when", "while", "this", "that", "it", "is", "are", "be", "should", "always", "do", "does", "you", "we", "then", "any", "all", "its", "into", "by", "at", "as"])

/** Small, explicit synonym map: same intent, different phrasing. */
const SYNONYMS: Readonly<Record<string, string>> = {
  use: "run", execute: "run", running: "run", ran: "run",
  tests: "test", testing: "test", tested: "test", spec: "test", specs: "test",
  first: "before", prior: "before", ahead: "before",
  refactor: "refactor", refactoring: "refactor", refactors: "refactor", restructure: "refactor",
  fix: "repair", fixes: "repair", fixing: "repair", repairing: "repair",
  edit: "change", edits: "change", editing: "change", modify: "change", modifying: "change",
  failing: "fail", failed: "fail", failure: "fail", failures: "fail", fails: "fail",
  check: "verify", checks: "verify", verification: "verify", verifying: "verify",
}

function stem(word: string): string {
  if (SYNONYMS[word]) return SYNONYMS[word]!
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length)
      return SYNONYMS[base] ?? base
    }
  }
  return word
}

export function normalizedTokens(text: string): string[] {
  const tokens = text.toLowerCase().replace(/[`'"]/g, "").split(/[^a-z0-9.@/-]+/).filter(Boolean)
  return [...new Set(tokens.filter((token) => !STOPWORDS.has(token)).map(stem))].toSorted()
}

/** Stable, order-independent key: kind group + normalised title tokens. */
export function dedupeKey(kind: LearningKind, title: string): string {
  return `${kindGroup(kind)}:${normalizedTokens(title).join(" ")}`
}

function kindGroup(kind: LearningKind): string {
  return kind === "PROJECT_FACT" || kind === "PROJECT_DECISION" ? "project" : kind === "FAILURE_PATTERN" ? "failure" : "pattern"
}

export function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1
  const a = new Set(left)
  const b = new Set(right)
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

export const DEDUPE_SIMILARITY = 0.6

/** The existing record an observation duplicates, if any: same pattern key, or a near-identical title. */
export function findDuplicate(records: readonly LearningRecord[], observation: { readonly kind: LearningKind; readonly title: string; readonly patternKey?: string }): LearningRecord | undefined {
  if (observation.patternKey) {
    const byPattern = records.find((record) => record.patternKey === observation.patternKey)
    if (byPattern) return byPattern
  }
  const key = dedupeKey(observation.kind, observation.title)
  const exact = records.find((record) => record.dedupeKey === key)
  if (exact) return exact
  const group = kindGroup(observation.kind)
  const tokens = normalizedTokens(observation.title)
  let best: { record: LearningRecord; score: number } | undefined
  for (const record of records) {
    if (kindGroup(record.kind) !== group) continue
    const score = jaccard(tokens, normalizedTokens(record.title))
    if (score >= DEDUPE_SIMILARITY && (!best || score > best.score)) best = { record, score }
  }
  return best?.record
}

// ---- scope -----------------------------------------------------------------------------------------

/** Markers that tie a lesson to this repository: paths, file names, versions, toolchain names. */
const PROJECT_SPECIFIC = [
  /(?:^|\s)(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+/, // a path such as src/auth or packages/x
  /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|toml|md|py|rs|go|java|lock)\b/i,
  /\b\d+\.\d+(?:\.\d+)?\b/, // version numbers
  /\b(?:pnpm|yarn|npm|bun|deno|poetry|pipenv|cargo|gradle|maven|postgres(?:ql)?|mysql|redis|docker)\b/i,
  /\bthis (?:repo(?:sitory)?|project|codebase)\b/i,
]

export function isProjectSpecific(text: string): boolean {
  return PROJECT_SPECIFIC.some((pattern) => pattern.test(text))
}

/**
 * Project facts and decisions are always PROJECT. A pattern is REUSABLE only when its text carries no
 * project-specific marker and it depends on no workspace path; otherwise it is demoted to
 * PROJECT_PATTERN, so a project fact can never be promoted into a global skill.
 */
export function classifyScope(observation: Pick<LearningObservation, "kind" | "title" | "summary" | "relevantPaths">): { kind: LearningObservation["kind"]; scope: LearningScope } {
  if (observation.kind === "PROJECT_FACT" || observation.kind === "PROJECT_DECISION" || observation.kind === "PROJECT_PATTERN") return { kind: observation.kind, scope: "PROJECT" }
  const specific = (observation.relevantPaths?.length ?? 0) > 0 || isProjectSpecific(`${observation.title}\n${observation.summary}`)
  if (specific) return { kind: "PROJECT_PATTERN", scope: "PROJECT" }
  return { kind: observation.kind, scope: "REUSABLE" }
}

// ---- trust -----------------------------------------------------------------------------------------

/** Text that tries to grant the agent authority. Learning is guidance; it can never carry a grant. */
const AUTHORITY_CLAIM = [
  /\b(?:may|can|allowed to|permitted to|authori[sz]ed to|free to)\s+(?:always\s+)?(?:run|execute|use|access|call|enable|install|download|push|deploy|delete)\s+(?:\w+\s+){0,2}(?:shell|terminal|commands?|network|internet|cloud|secrets?|credentials?|sudo|root|anything|models?|weights)\b/i,
  /\b(?:no|without)\s+(?:need\s+(?:for|to)\s+)?(?:approval|confirmation|permission|review)s?\b/i,
]

export type TrustVerdict =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly reason: string; readonly reject: boolean }

/**
 * Only an explicit user decision is trusted on arrival; observed outcomes earn trust through
 * repeated independent evidence. Repository text and unsupported model statements never do, and
 * text that claims authority is rejected outright whatever its source.
 */
export function assessTrust(observation: Pick<LearningObservation, "source" | "title" | "summary" | "evidenceRefs">): TrustVerdict {
  const text = `${observation.title}\n${observation.summary}`
  const unsafe = findUnsafeDirective(text) ?? AUTHORITY_CLAIM.map((pattern) => pattern.exec(text)?.[0]).find(Boolean)
  if (unsafe) return { trusted: false, reject: true, reason: `claims authority ("${unsafe.slice(0, 60)}"); learning can never grant permissions` }
  if (observation.source === "REPOSITORY_TEXT") return { trusted: false, reject: false, reason: "repository text is data, not a decision; it cannot establish trusted learning" }
  if (observation.source === "MODEL_PROPOSAL" && observation.evidenceRefs.length === 0) return { trusted: false, reject: true, reason: "a model statement without evidence is not evidence" }
  return { trusted: true }
}

// ---- evidence scoring ------------------------------------------------------------------------------

/** Counted, explainable confidence. No opaque score. */
export function confidenceFor(successes: number, failures: number): LearningConfidence {
  if (successes >= LEARNING_THRESHOLDS.skillProposalSuccesses && supportRatio(successes, failures) >= LEARNING_THRESHOLDS.minSupportRatio) return "HIGH"
  if (successes >= LEARNING_THRESHOLDS.candidateSuccesses && successes > failures) return "MEDIUM"
  return "LOW"
}

export function supportRatio(successes: number, failures: number): number {
  return successes + failures === 0 ? 0 : successes / (successes + failures)
}

/** Repeated contradictory evidence: at least N failures and no more successes than failures. */
export function isContradicted(successes: number, failures: number): boolean {
  return failures >= LEARNING_THRESHOLDS.contradictionFailures && failures >= successes
}

/** Reusable records need repeated, independent, mostly-successful support before a skill proposal. */
export function isPromotable(record: Pick<LearningRecord, "scope" | "status" | "source" | "successfulOccurrences" | "failedOccurrences" | "sourceTaskIds">): boolean {
  return record.scope === "REUSABLE"
    && record.source === "OBSERVED_OUTCOME"
    && (record.status === "CANDIDATE" || record.status === "APPROVED")
    && record.successfulOccurrences >= LEARNING_THRESHOLDS.skillProposalSuccesses
    && record.sourceTaskIds.length >= LEARNING_THRESHOLDS.skillProposalSuccesses
    && supportRatio(record.successfulOccurrences, record.failedOccurrences) >= LEARNING_THRESHOLDS.minSupportRatio
}

export function boundList(values: readonly string[], max: number, chars: number = LEARNING_LIMITS.refChars): string[] {
  const out: string[] = []
  for (const value of values) {
    const clean = sanitizeLearningText(value, chars)
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out.slice(-max)
}
