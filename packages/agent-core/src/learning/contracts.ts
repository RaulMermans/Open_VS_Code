/**
 * Bounded memory-to-skill learning contracts (Sprint 5D, ADR-032).
 *
 *   completed task → evidence-backed observation → classify → dedupe/accumulate → candidate
 *   → human review → APPROVED memory, or an approved learned SKILL.md
 *
 * The system may propose learning; it never promotes it. Only APPROVED records (and approved
 * learned skills, which are ordinary workspace skills) can influence a later prompt. Every
 * persisted field is a short redacted summary, an id, a hash or a count — never a transcript,
 * prompt, reasoning, source code or raw log.
 */
import type { AgentMode } from "../contracts/agent.ts"
import type { SkillCapability, SkillCategory } from "../skills/contracts.ts"

export const LEARNING_KINDS = ["PROJECT_FACT", "PROJECT_DECISION", "PROJECT_PATTERN", "REUSABLE_PATTERN", "FAILURE_PATTERN", "SKILL_CANDIDATE"] as const
export type LearningKind = (typeof LEARNING_KINDS)[number]

export type LearningScope = "PROJECT" | "REUSABLE"

export type LearningStatus = "OBSERVED" | "CANDIDATE" | "APPROVED" | "REJECTED" | "STALE"

/** Derived from counted evidence, never from model self-assessment. */
export type LearningConfidence = "LOW" | "MEDIUM" | "HIGH"

/**
 * Where an observation came from. Only USER_DECISION is trusted on arrival. OBSERVED_OUTCOME needs
 * repeated, independent support. REPOSITORY_TEXT and MODEL_PROPOSAL can never establish authority:
 * repository text is untrusted data, and a model statement alone is not evidence.
 */
export type LearningSource = "USER_DECISION" | "OBSERVED_OUTCOME" | "REPOSITORY_TEXT" | "MODEL_PROPOSAL"

/** A pointer to durable evidence: `<kind>:<id>`, e.g. `workflow:wf-12#VERIFY`, `file:pnpm-lock.yaml`. */
export type EvidenceRef = string

/** One evidence-backed observation produced at task completion (deterministic extractors only). */
export interface LearningObservation {
  readonly kind: Exclude<LearningKind, "SKILL_CANDIDATE">
  readonly source: LearningSource
  /** Stable identity of a recognised pattern (e.g. `reusable:repair-against-failing-assertion`). */
  readonly patternKey?: string
  readonly title: string
  readonly summary: string
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly taskId: string
  /** true = the pattern held (task verified), false = it was followed and did not hold. */
  readonly outcome: "SUCCESS" | "FAILURE"
  readonly tags?: readonly string[]
  /** Workspace-relative paths the record depends on; a missing path makes the record STALE. */
  readonly relevantPaths?: readonly string[]
  readonly modes?: readonly AgentMode[]
}

export interface LearningRecord {
  readonly id: string
  readonly projectId?: string
  readonly kind: Exclude<LearningKind, "SKILL_CANDIDATE">
  readonly source: LearningSource
  readonly patternKey?: string
  /** Normalised dedupe key (see dedupe.ts). */
  readonly dedupeKey: string
  readonly title: string
  readonly summary: string
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly sourceTaskIds: readonly string[]
  readonly successfulOccurrences: number
  readonly failedOccurrences: number
  readonly confidence: LearningConfidence
  readonly scope: LearningScope
  readonly status: LearningStatus
  readonly tags: readonly string[]
  readonly relevantPaths: readonly string[]
  readonly modes: readonly AgentMode[]
  /** Why the record is untrusted/stale/rejected, when it is. Bounded text. */
  readonly statusReason?: string
  readonly supersededBy?: string
  readonly approvedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type LearnedSkillCandidateStatus = "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "REJECTED"

/** The intermediate representation between a reusable record and a SKILL.md. Not yet a skill. */
export interface LearnedSkillCandidate {
  readonly id: string
  readonly recordId: string
  readonly proposedSkillId: string
  readonly title: string
  readonly description: string
  readonly category: SkillCategory
  readonly intent: string
  readonly whenToUse: string
  readonly inputs: string
  readonly workflow: readonly string[]
  readonly verification: readonly string[]
  readonly failureModes: readonly string[]
  readonly exitCriteria: readonly string[]
  readonly triggers: readonly string[]
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly supportingTaskIds: readonly string[]
  readonly proposedCapabilities: readonly string[]
  readonly proposedTools: readonly string[]
  readonly proposedModes: readonly string[]
  readonly status: LearnedSkillCandidateStatus
  /** Present when the candidate updates an existing learned skill. */
  readonly updateOf?: { readonly skillId: string; readonly fromVersion: number }
  readonly statusReason?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Compact provenance for an approved learned skill: why it exists, from which tasks, when approved. */
export interface LearnedSkillProvenance {
  readonly skillId: string
  readonly version: number
  readonly candidateId: string
  readonly recordId: string
  readonly supportingTaskIds: readonly string[]
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly approvedAt: string
  /** sha256 (16 hex) of the generated SKILL.md, to detect hand edits before an update. */
  readonly contentHash: string
  /** Workspace-relative paths of archived earlier versions. */
  readonly history: readonly string[]
}

/** A rejected proposal's fingerprint: suppresses the same proposal until evidence materially changes. */
export interface RejectionFingerprint {
  readonly fingerprint: string
  readonly successesAtRejection: number
  readonly rejectedAt: string
  readonly reason: string
}

export interface LearningStoreData {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly records: readonly LearningRecord[]
  readonly candidates: readonly LearnedSkillCandidate[]
  readonly rejections: readonly RejectionFingerprint[]
  readonly learnedSkills: readonly LearnedSkillProvenance[]
}

/** Evidence thresholds (the "one lucky task" invariant). */
export const LEARNING_THRESHOLDS = {
  /** Independent successful tasks before a reusable record becomes a CANDIDATE. */
  candidateSuccesses: 2,
  /** Independent successful tasks before a skill proposal may be drafted. */
  skillProposalSuccesses: 3,
  /** Minimum share of successes among all occurrences for a proposal (successes / total). */
  minSupportRatio: 0.75,
  /** Failures at or above successes (with at least this many failures) make the record STALE. */
  contradictionFailures: 2,
  /** New independent successes needed before a rejected proposal may resurface. */
  resurfaceAfterSuccesses: 3,
} as const

export const LEARNING_LIMITS = {
  maxProjectRecords: 100,
  maxReusableRecords: 50,
  maxCandidates: 20,
  maxRejections: 200,
  maxEvidenceRefs: 12,
  maxSourceTaskIds: 24,
  maxTags: 8,
  maxPaths: 8,
  titleChars: 120,
  summaryChars: 400,
  refChars: 160,
  candidateLineChars: 200,
  candidateListItems: 8,
  /** Share of the available context that approved learning may occupy. */
  memoryBudgetRatio: 0.1,
} as const

/** Learned skills may only declare these capabilities; anything else rejects the candidate. */
export const LEARNED_SKILL_CAPABILITY_CEILING: readonly SkillCapability[] = ["read", "search", "write", "verify"]

export const LEARNING_STORE_PATH = ".open-vs-code/learning/learning.json"
export const LEARNING_HISTORY_DIR = ".open-vs-code/learning/history"

/** Approved learning selected for one task, with the measurements the eval and evidence report. */
export interface LearningRetrieval {
  readonly items: readonly { readonly id: string; readonly kind: LearningKind; readonly content: string; readonly estimatedTokens: number }[]
  readonly budgetTokens: number
  readonly retrievedTokens: number
  readonly indexTokens: number
  readonly considered: number
  readonly excludedStale: number
  readonly excludedUnapproved: number
  readonly droppedForBudget: number
}
