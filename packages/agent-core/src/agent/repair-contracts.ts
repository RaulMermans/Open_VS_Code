import { FailureClassification } from "./failure-classification.ts"
import type { AgentResult } from "../contracts/agent.ts"
import type { AgentRunnerInput } from "./runner.ts"
import type { PreparedVerification, VerificationResult } from "../tools/verification-contracts.ts"

export interface RepairBudget {
  readonly maxRepairAttempts: number
  readonly maxMutations: number
  readonly maxVerificationRuns: number
  readonly maxTotalAgentTurns: number
}

export interface RepairInvestigationPrompt {
  readonly failure: FailureClassification
  readonly systemPrompt: string
  readonly instruction: string
}

export type RepairStatus = 
  | "INVESTIGATING"
  | "AWAITING_MUTATION_APPROVAL"
  | "AWAITING_VERIFICATION_APPROVAL"
  | "ANALYZING_FAILURE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "REJECTED_BY_USER"
  | "REPAIR_ATTEMPTS_EXCEEDED"
  | "MUTATION_BUDGET_EXCEEDED"
  | "VERIFICATION_BUDGET_EXCEEDED"
  | "AGENT_TURN_BUDGET_EXCEEDED"
  | "REPAIR_NON_PROGRESS"
  | "STALE_BASE"
  | "STALE_VERIFICATION"
  | "TIMEOUT"
  | "EXECUTION_ERROR"

export interface RepairAttemptRecord {
  readonly attemptNumber: number
  readonly failure: FailureClassification
  readonly result: AgentResult
  readonly mutationApplied: boolean
}

export interface RepairResult {
  readonly status: RepairStatus
  readonly task: string
  readonly repairAttempts: number
  readonly mutationsPrepared: number
  readonly mutationsApplied: number
  readonly verificationRuns: number
  readonly totalAgentTurns: number
  readonly changedFiles: string[]
  readonly finalVerification?: VerificationResult
  readonly failureReason?: string
  readonly events: any[]
  readonly pendingReview?: unknown
}

export type RepairDecision = "APPROVE" | "REJECT"

export interface BoundedRepairLifecycle {
  run(
    originalInput: AgentRunnerInput,
    preparedVerification: PreparedVerification
  ): Promise<RepairResult>
  
  resume(decision: RepairDecision): Promise<RepairResult>
}
