/**
 * The single normalisation boundary for skill-candidate content (Sprint 5D closure, ADR-032).
 *
 *   external/model/curated draft → structure → reject secrets, hidden reasoning, authority
 *   overrides and executable markup → sanitise and bound → closed vocabulary → canonical draft
 *
 * Nothing reaches the learning store, a rendered SKILL.md or a rejection reason except through
 * here. Unsafe drafts are rejected, not partially redacted: a credential or an override inside a
 * reusable workflow means the proposal itself is malformed. Rejection evidence is a code and a
 * field name; it never quotes the rejected content.
 */
import { KNOWN_SKILL_TOOLS, SKILL_CAPABILITIES, SKILL_CATEGORIES, SKILL_LIMITS, SKILL_MODES, type SkillCategory } from "../skills/contracts.ts"
import { EXECUTABLE_BODY, SKILL_ID_PATTERN, containsSecret } from "../skills/schema.ts"
import { LEARNED_SKILL_CAPABILITY_CEILING, LEARNING_LIMITS, type LearnedSkillCandidate } from "./contracts.ts"
import { findAuthorityClaim, sanitizeLearningText } from "./policy.ts"

/** Every author-controlled candidate field. System-managed fields (ids, evidence, status, times) are excluded. */
export type SkillCandidateDraft = Omit<LearnedSkillCandidate, "id" | "status" | "createdAt" | "updatedAt" | "evidenceRefs" | "supportingTaskIds" | "updateOf" | "statusReason">

export type CandidateRejectionCode =
  | "INVALID_STRUCTURE"
  | "INPUT_TOO_LARGE"
  | "HIDDEN_REASONING"
  | "SECRET_DETECTED"
  | "AUTHORITY_OVERRIDE"
  | "EXECUTABLE_CONTENT"
  | "UNKNOWN_VOCABULARY"
  | "CAPABILITY_CEILING"

export type CandidateNormalization =
  | { readonly ok: true; readonly draft: SkillCandidateDraft }
  | { readonly ok: false; readonly code: CandidateRejectionCode; readonly field: string; readonly detail?: string }

type FieldRule =
  | { readonly kind: "text"; readonly maxChars: number }
  | { readonly kind: "list"; readonly maxItems: number; readonly maxChars: number }
  | { readonly kind: "recordId" | "skillId" | "category" | "triggers" | "capabilities" | "tools" | "modes" }

/**
 * Exhaustive by type: adding a field to LearnedSkillCandidate does not compile until it is given a
 * rule here, so a future free-text field cannot bypass the boundary.
 */
const FIELD_RULES: { readonly [K in keyof SkillCandidateDraft]-?: FieldRule } = {
  recordId: { kind: "recordId" },
  proposedSkillId: { kind: "skillId" },
  category: { kind: "category" },
  title: { kind: "text", maxChars: SKILL_LIMITS.maxNameChars },
  description: { kind: "text", maxChars: SKILL_LIMITS.maxDescriptionChars },
  intent: { kind: "text", maxChars: LEARNING_LIMITS.candidateLineChars },
  whenToUse: { kind: "text", maxChars: LEARNING_LIMITS.candidateLineChars },
  inputs: { kind: "text", maxChars: LEARNING_LIMITS.candidateLineChars },
  workflow: { kind: "list", maxItems: LEARNING_LIMITS.candidateListItems, maxChars: LEARNING_LIMITS.candidateLineChars },
  verification: { kind: "list", maxItems: LEARNING_LIMITS.candidateListItems, maxChars: LEARNING_LIMITS.candidateLineChars },
  failureModes: { kind: "list", maxItems: LEARNING_LIMITS.candidateListItems, maxChars: LEARNING_LIMITS.candidateLineChars },
  exitCriteria: { kind: "list", maxItems: LEARNING_LIMITS.candidateListItems, maxChars: LEARNING_LIMITS.candidateLineChars },
  triggers: { kind: "triggers" },
  proposedCapabilities: { kind: "capabilities" },
  proposedTools: { kind: "tools" },
  proposedModes: { kind: "modes" },
}

/** Raw-size ceilings, checked before any pattern runs: an oversized draft is rejected, not scanned. */
const MAX_RAW_CHARS = 16_000
const MAX_RAW_LIST_ITEMS = 64
const MAX_RECORD_ID_CHARS = 64

const HIDDEN_REASONING = /<\s*\/?\s*(?:think|thinking|reasoning)\b[^>]*>/i

/** The safety scan every candidate string (and the whole rendered SKILL.md) must pass. */
export function findContentSafetyIssue(text: string): Extract<CandidateRejectionCode, "HIDDEN_REASONING" | "SECRET_DETECTED" | "AUTHORITY_OVERRIDE" | "EXECUTABLE_CONTENT"> | undefined {
  if (HIDDEN_REASONING.test(text)) return "HIDDEN_REASONING"
  if (containsSecret(text)) return "SECRET_DETECTED"
  if (findAuthorityClaim(text)) return "AUTHORITY_OVERRIDE"
  if (EXECUTABLE_BODY.test(text)) return "EXECUTABLE_CONTENT"
  return undefined
}

const fail = (code: CandidateRejectionCode, field: string, detail?: string): CandidateNormalization => ({ ok: false, code, field, ...(detail ? { detail } : {}) })

/** One rendered line: sanitised, single-line, bounded, and unable to open a Markdown heading. */
function cleanLine(text: string, maxChars: number): string {
  return sanitizeLearningText(text.replace(/^[\s#]+/, ""), maxChars)
}

/**
 * Validates, scans, sanitises and bounds an author-controlled draft. Pure and idempotent, so it can
 * run at submission, at proposal and again at approval (a stored candidate is never trusted).
 */
export function normalizeSkillCandidate(input: unknown): CandidateNormalization {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("INVALID_STRUCTURE", "candidate")
  const raw = input as Record<string, unknown>

  // 1. structure and raw bounds; unknown keys are dropped, never persisted.
  const strings = new Map<string, string[]>()
  let total = 0
  for (const [field, rule] of Object.entries(FIELD_RULES) as [keyof SkillCandidateDraft, FieldRule][]) {
    const value = raw[field]
    const listLike = rule.kind === "list" || rule.kind === "triggers" || rule.kind === "capabilities" || rule.kind === "tools" || rule.kind === "modes"
    const values = listLike ? value : [value]
    if (!Array.isArray(values) || values.length > MAX_RAW_LIST_ITEMS || !values.every((item) => typeof item === "string")) return fail("INVALID_STRUCTURE", field)
    total += values.reduce((sum, item: string) => sum + item.length, 0)
    if (total > MAX_RAW_CHARS) return fail("INPUT_TOO_LARGE", field)
    strings.set(field, values as string[])
  }

  // 2. safety scan on the raw text of every field, structural ones included.
  for (const [field, values] of strings) {
    for (const value of values) {
      const issue = findContentSafetyIssue(value)
      if (issue) return fail(issue, field)
    }
  }

  // 3. closed vocabularies (permission-relevant values are never free text).
  const one = (field: keyof SkillCandidateDraft) => strings.get(field)![0]!
  const list = (field: keyof SkillCandidateDraft) => strings.get(field)!
  const recordId = one("recordId")
  if (!recordId || recordId.length > MAX_RECORD_ID_CHARS || !/^[\w.:-]+$/.test(recordId)) return fail("INVALID_STRUCTURE", "recordId")
  const proposedSkillId = one("proposedSkillId")
  if (proposedSkillId.length > 48 || !SKILL_ID_PATTERN.test(proposedSkillId)) return fail("INVALID_STRUCTURE", "proposedSkillId")
  const category = one("category")
  if (!(SKILL_CATEGORIES as readonly string[]).includes(category)) return fail("UNKNOWN_VOCABULARY", "category")
  const vocab: readonly [keyof SkillCandidateDraft, readonly string[]][] = [
    ["proposedCapabilities", SKILL_CAPABILITIES],
    ["proposedTools", KNOWN_SKILL_TOOLS],
    ["proposedModes", SKILL_MODES as readonly string[]],
  ]
  for (const [field, allowed] of vocab) {
    if (list(field).some((item) => !allowed.includes(item))) return fail("UNKNOWN_VOCABULARY", field)
  }
  // Safe to name: it is a member of the closed vocabulary, not author text.
  const aboveCeiling = list("proposedCapabilities").find((item) => !(LEARNED_SKILL_CAPABILITY_CEILING as readonly string[]).includes(item))
  if (aboveCeiling) return fail("CAPABILITY_CEILING", "proposedCapabilities", `'${aboveCeiling}' exceeds what a learned skill may declare`)
  const triggers = [...new Set(list("triggers").map((item) => item.trim().toLowerCase()))]
  if (triggers.some((item) => !item || item.length > SKILL_LIMITS.maxTriggerChars || !/^[a-z0-9][a-z0-9 '-]*$/.test(item))) return fail("INVALID_STRUCTURE", "triggers")

  // 4. sanitise and bound free text; every rendered section must remain non-empty.
  const text = (field: "title" | "description" | "intent" | "whenToUse" | "inputs"): string | undefined => {
    const rule = FIELD_RULES[field] as { maxChars: number }
    return cleanLine(one(field), rule.maxChars) || undefined
  }
  const items = (field: "workflow" | "verification" | "failureModes" | "exitCriteria"): string[] => {
    const rule = FIELD_RULES[field] as { maxItems: number; maxChars: number }
    return [...new Set(list(field).map((item) => cleanLine(item, rule.maxChars)).filter(Boolean))].slice(0, rule.maxItems)
  }
  const draft = {
    recordId,
    proposedSkillId,
    category: category as SkillCategory,
    title: text("title"),
    description: text("description"),
    intent: text("intent"),
    whenToUse: text("whenToUse"),
    inputs: text("inputs"),
    workflow: items("workflow"),
    verification: items("verification"),
    failureModes: items("failureModes"),
    exitCriteria: items("exitCriteria"),
    triggers: triggers.slice(0, SKILL_LIMITS.maxTriggers),
    proposedCapabilities: [...new Set(list("proposedCapabilities"))],
    proposedTools: [...new Set(list("proposedTools"))],
    proposedModes: [...new Set(list("proposedModes"))],
  }
  for (const [field, value] of Object.entries(draft)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0 && !OPTIONAL_LISTS.has(field))) return fail("INVALID_STRUCTURE", field)
  }
  return { ok: true, draft: draft as SkillCandidateDraft }
}

/** Lists that may be empty; every other field is a required section, or `allowed_modes`. */
const OPTIONAL_LISTS = new Set(["triggers", "proposedCapabilities", "proposedTools"])

/** Bounded rejection reason: a code, a field name and (only) fixed detail text. */
export function describeCandidateRejection(result: Extract<CandidateNormalization, { ok: false }>): string {
  return `${result.code} in ${result.field}${result.detail ? `: ${result.detail}` : ""}`
}

/**
 * The only form a candidate rejected at the boundary is stored in: status, a bounded reason and
 * ids. All author text is dropped. `recordId` must already be a known record id, and the skill id
 * is kept only when it is a valid, secret-free kebab id.
 */
export function rejectedCandidateEvidence(
  meta: Pick<LearnedSkillCandidate, "id" | "evidenceRefs" | "supportingTaskIds" | "createdAt" | "updatedAt"> & { readonly knownRecordId?: string },
  input: unknown,
  reason: string,
): LearnedSkillCandidate {
  const skillId = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["proposedSkillId"] : undefined
  const safeSkillId = typeof skillId === "string" && skillId.length <= 48 && SKILL_ID_PATTERN.test(skillId) && !containsSecret(skillId) ? skillId : "invalid"
  return {
    id: meta.id,
    recordId: meta.knownRecordId ?? "unknown",
    proposedSkillId: safeSkillId,
    title: "",
    description: "",
    category: SKILL_CATEGORIES[0],
    intent: "",
    whenToUse: "",
    inputs: "",
    workflow: [],
    verification: [],
    failureModes: [],
    exitCriteria: [],
    triggers: [],
    evidenceRefs: meta.evidenceRefs,
    supportingTaskIds: meta.supportingTaskIds,
    proposedCapabilities: [],
    proposedTools: [],
    proposedModes: [],
    status: "REJECTED",
    statusReason: reason,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}
