import type { AgentMode } from "../contracts/agent.ts"
import type { ToolAction, ToolPermission } from "../contracts/tools.ts"
import { classifyPermission } from "../tools/permissions.ts"
import {
  CAPABILITY_ACTIONS,
  SKILL_LIMITS,
  SKILL_RISK_LEVELS,
  type SkillCandidate,
  type SkillIndexEntry,
  type SkillRejectionReason,
  type SkillSelection,
  type SkillSelectionReason,
} from "./contracts.ts"

/**
 * Deterministic skill selection (Sprint 5A, ADR-029).
 *
 * Inputs are the task text, the active mode, compact index metadata, the tools actually registered
 * for this run, and the existing PermissionGate. No model call, embedding or learned ranking is used.
 * "No skill" is a first-class outcome: weak or ambiguous matches select nothing.
 */

export const SKILL_SELECTION_THRESHOLD = 3
const TRIGGER_WEIGHT = 3
const MAX_TRIGGER_MATCHES = 3
const MAX_DESCRIPTION_OVERLAP = 3
const EXPLICIT_REQUEST = /\bskill:([a-z0-9-]+)\b/g

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "how", "why", "can", "you", "not", "but", "are", "have", "has",
  "had", "will", "would", "could", "should", "does", "did", "into", "before", "after", "only", "when", "then", "than", "them",
  "its", "our", "your", "any", "all", "use", "using", "code", "change", "changes", "file", "files", "make", "please", "about",
])

export function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3)
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2)
  if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1)
  return token
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).map(stemToken)
}

function containsPhrase(taskTokens: readonly string[], phrase: string): boolean {
  const phraseTokens = tokenize(phrase)
  if (phraseTokens.length === 0) return false
  for (let start = 0; start + phraseTokens.length <= taskTokens.length; start += 1) {
    if (phraseTokens.every((token, offset) => taskTokens[start + offset] === token)) return true
  }
  return false
}

export interface SkillSelectorInput {
  readonly task: string
  readonly mode: AgentMode
  readonly entries: readonly SkillIndexEntry[]
  /** Names of tools actually registered for this run. */
  readonly availableTools: Iterable<string>
  readonly permissionEvaluator?: (input: { readonly action: ToolAction; readonly mode: AgentMode }) => ToolPermission
  /** Defaults to 1. Clamped to the hard cap of 2; a second skill also requires an explicit composes_with rule. */
  readonly maxSkills?: number
}

interface Scored {
  readonly entry: SkillIndexEntry
  readonly score: number
  readonly triggerMatches: number
  readonly reason: SkillSelectionReason | SkillRejectionReason
  readonly eligible: boolean
}

function compatibility(entry: SkillIndexEntry, input: SkillSelectorInput, tools: ReadonlySet<string>): SkillRejectionReason | undefined {
  if (!entry.allowedModes.includes(input.mode)) return "MODE_INCOMPATIBLE"
  if (entry.requiredTools.some((tool) => !tools.has(tool))) return "MISSING_REQUIRED_TOOL"
  const permission = input.permissionEvaluator ?? classifyPermission
  // A capability the PermissionGate denies in this mode makes the skill unusable; it never widens access.
  if (entry.capabilities.some((capability) => permission({ action: CAPABILITY_ACTIONS[capability], mode: input.mode }) === "DENY")) return "CAPABILITY_DENIED"
  return undefined
}

function relevance(entry: SkillIndexEntry, taskTokens: readonly string[], explicitIds: ReadonlySet<string>): { score: number; triggerMatches: number; reason: SkillSelectionReason } {
  if (explicitIds.has(entry.id)) return { score: 100, triggerMatches: 0, reason: "explicit_request" }
  const triggerMatches = Math.min(MAX_TRIGGER_MATCHES, entry.triggers.filter((trigger) => containsPhrase(taskTokens, trigger)).length)
  const taskTerms = new Set(taskTokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token)))
  const descriptionTerms = new Set(tokenize(`${entry.name} ${entry.description}`).filter((token) => token.length > 2 && !STOP_WORDS.has(token)))
  const overlap = Math.min(MAX_DESCRIPTION_OVERLAP, [...descriptionTerms].filter((term) => taskTerms.has(term)).length)
  return {
    score: triggerMatches * TRIGGER_WEIGHT + overlap,
    triggerMatches,
    reason: triggerMatches > 0 ? "trigger_match" : "description_overlap",
  }
}

export function selectSkill(input: SkillSelectorInput): SkillSelection {
  const maxSkills = Math.max(0, Math.min(SKILL_LIMITS.maxSkillsPerTask, Math.trunc(input.maxSkills ?? 1)))
  const tools = new Set(input.availableTools)
  const taskTokens = tokenize(input.task)
  const explicitIds = new Set([...input.task.toLowerCase().matchAll(EXPLICIT_REQUEST)].map((match) => match[1]!))

  const scored: Scored[] = input.entries.map((entry) => {
    const { score, triggerMatches, reason } = relevance(entry, taskTokens, explicitIds)
    const rejected = compatibility(entry, input, tools)
    if (rejected) return { entry, score, triggerMatches, reason: rejected, eligible: false }
    if (score < SKILL_SELECTION_THRESHOLD) return { entry, score, triggerMatches, reason: "BELOW_THRESHOLD", eligible: false }
    return { entry, score, triggerMatches, reason, eligible: true }
  })

  const ranked = scored
    .filter((candidate) => candidate.eligible)
    .toSorted((left, right) =>
      right.score - left.score
      || right.triggerMatches - left.triggerMatches
      || SKILL_RISK_LEVELS.indexOf(left.entry.riskLevel) - SKILL_RISK_LEVELS.indexOf(right.entry.riskLevel)
      || left.entry.id.localeCompare(right.entry.id))

  const selected: SkillIndexEntry[] = []
  const reasons: SkillSelectionReason[] = []
  const primary = ranked[0]
  const runnerUp = ranked[1]
  // An exact tie between unrelated skills is ambiguous: select nothing rather than guess.
  const ambiguous = primary !== undefined && runnerUp !== undefined && primary.score === runnerUp.score
    && primary.triggerMatches === runnerUp.triggerMatches && primary.reason !== "explicit_request"
    && !primary.entry.composesWith.includes(runnerUp.entry.id) && !runnerUp.entry.composesWith.includes(primary.entry.id)

  if (primary && maxSkills >= 1 && !ambiguous) {
    selected.push(primary.entry)
    reasons.push(primary.reason as SkillSelectionReason)
    if (maxSkills >= 2) {
      const companion = ranked.slice(1).find((candidate) => primary.entry.composesWith.includes(candidate.entry.id))
      if (companion) {
        selected.push(companion.entry)
        reasons.push("composition")
      }
    }
  }

  const selectedIds = new Set(selected.map((entry) => entry.id))
  const candidates: SkillCandidate[] = scored.map((candidate) => ({
    id: candidate.entry.id,
    score: candidate.score,
    eligible: candidate.eligible,
    reason: !candidate.eligible || selectedIds.has(candidate.entry.id) ? candidate.reason : ambiguous ? "AMBIGUOUS" : "OUTRANKED",
  }))
  return { selected, reasons, candidates }
}
