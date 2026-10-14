/**
 * Pure, deterministic workflow policy: eligibility, stage capability envelopes and transition rules.
 */
import type { AgentMode } from "../contracts/agent.ts"
import type { ToolAction, ToolPermission } from "../contracts/tools.ts"
import {
  TERMINAL_STAGES,
  WorkflowTransitionError,
  type EngineeringStage,
  type WorkflowEligibility,
  type WorkflowPolicy,
  type WorkflowState,
  type WorkStage,
} from "./contracts.ts"

// ---- Eligibility ----------------------------------------------------------------------------------

const MUTATING_MODES: ReadonlySet<AgentMode> = new Set(["BUILD", "DEBUG"])

/**
 * Requests that ask only to explain, locate or review. They run on the direct path even in a
 * mutating mode, because the workflow exists to deliver verified changes.
 */
const READ_ONLY_PATTERNS: readonly RegExp[] = [
  /^\s*(explain|describe|summari[sz]e|what|why|how does|how do|where|which|who|show me|list|find)\b/i,
  /\b(review only|only review|just review|review (this|the) (diff|patch|pr|pull request|change))\b/i,
  // "do not modify any files" is read-only; "do not modify behaviour" (a refactor constraint) is not.
  /\b(do not|don't|dont|without) (change|modify|edit|touch|write) (any |the )?(files?|code|repository|repo|workspace|anything)\b/i,
  /\bread[- ]only\b/i,
]

export interface EligibilityInput {
  readonly enabled: boolean
  readonly mode: AgentMode
  readonly instruction: string
  readonly isTrusted: boolean
}

export function assessWorkflowEligibility(input: EligibilityInput): WorkflowEligibility {
  if (!input.enabled) return { eligible: false, reason: "DISABLED" }
  if (!MUTATING_MODES.has(input.mode)) return { eligible: false, reason: "MODE_NOT_MUTATING" }
  if (!input.isTrusted) return { eligible: false, reason: "UNTRUSTED_WORKSPACE" }
  if (READ_ONLY_PATTERNS.some((pattern) => pattern.test(input.instruction))) return { eligible: false, reason: "READ_ONLY_REQUEST" }
  return { eligible: true, reason: "ELIGIBLE" }
}

// ---- Capability envelopes -------------------------------------------------------------------------

export interface StageEnvelope {
  /** Agent mode the stage runs under; the PermissionGate evaluates every call in this mode. */
  readonly mode: AgentMode
  /** Tool actions the stage may even see. An envelope only narrows; it never grants. */
  readonly actions: ReadonlySet<ToolAction>
  /** Whether the stage invokes a model (PLAN/IMPLEMENT/REVIEW) or runs deterministic checks (TEST/VERIFY). */
  readonly model: boolean
}

const READ: readonly ToolAction[] = ["read_repository", "search_repository", "read_markdown"]

export const STAGE_ENVELOPES: Readonly<Record<WorkStage, StageEnvelope>> = {
  PLAN: { mode: "PLAN", actions: new Set(READ), model: true },
  IMPLEMENT: { mode: "BUILD", actions: new Set([...READ, "write_file", "delete_file", "terminal_command"]), model: true },
  TEST: { mode: "BUILD", actions: new Set([...READ, "run_known_test"]), model: false },
  REVIEW: { mode: "REVIEW", actions: new Set(READ), model: true },
  VERIFY: { mode: "BUILD", actions: new Set([...READ, "run_known_test"]), model: false },
}

export type PermissionEvaluator = (input: { readonly action: ToolAction; readonly mode: AgentMode }) => ToolPermission

/**
 * The stage's effective permission: DENY outside its envelope, otherwise exactly what the base
 * PermissionGate says for the stage mode. It can only return the base answer or DENY, never upgrade.
 */
export function stagePermission(stage: WorkStage, base: PermissionEvaluator): PermissionEvaluator {
  const envelope = STAGE_ENVELOPES[stage]
  return ({ action }) => (envelope.actions.has(action) ? base({ action, mode: envelope.mode }) : "DENY")
}

// ---- Transitions ----------------------------------------------------------------------------------

/** Returns a reason string if `from → to` is illegal for `state`, otherwise undefined. */
export function transitionViolation(state: WorkflowState, to: EngineeringStage, policy: WorkflowPolicy): string | undefined {
  const from = state.currentStage
  if (TERMINAL_STAGES.has(from)) return "workflow already terminal"
  if (to === "BLOCKED" || to === "CANCELLED") return undefined
  const latestReview = state.reviews.at(-1)
  switch (`${from}->${to}`) {
    case "PLAN->IMPLEMENT": {
      const plan = state.plan
      if (!plan) return "no plan artifact"
      if (!plan.goal || plan.steps.length === 0 || plan.acceptanceCriteria.length === 0) return "plan is not actionable"
      return undefined
    }
    case "IMPLEMENT->TEST":
      if (state.pending) return "unresolved confirmation"
      if (!state.implementation || state.implementation.changedFiles.length === 0) return "no applied changes"
      return undefined
    case "TEST->REVIEW":
      if (!state.test?.attempted) return "no test attempt recorded"
      if (!state.test.passed) return "tests did not pass"
      return undefined
    case "TEST->IMPLEMENT":
      if (!state.test?.attempted || state.test.passed) return "repair requires a failed test attempt"
      if (state.retryCounts.testRepairs >= policy.maxTestRepairs) return "test repair limit reached"
      return undefined
    case "REVIEW->VERIFY":
      if (!latestReview) return "fresh review has not run"
      if (latestReview.blocking > 0) return "unresolved blocking review finding"
      return undefined
    case "REVIEW->IMPLEMENT":
      if (!latestReview || latestReview.blocking === 0) return "repair requires a blocking review finding"
      if (state.retryCounts.reviewRepairs >= policy.maxReviewRepairs) return "review repair limit reached"
      return undefined
    case "VERIFY->COMPLETE":
      if (state.verification?.verdict !== "READY") return "verification is not READY"
      return undefined
    default:
      return "no such transition"
  }
}

export function assertTransition(state: WorkflowState, to: EngineeringStage, policy: WorkflowPolicy): void {
  const violation = transitionViolation(state, to, policy)
  if (violation) throw new WorkflowTransitionError(state.currentStage, to, violation)
}
