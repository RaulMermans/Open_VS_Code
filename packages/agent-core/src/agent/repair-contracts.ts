import { FailureClassification } from "./failure-classification.ts"
import type { AgentResult } from "../contracts/agent.ts"
import type { PreparedVerification } from "../tools/verification-contracts.ts"

export interface RepairBudget {
  readonly maxAttempts: number
  readonly maxTurnsPerAttempt: number
}

export interface RepairInvestigationPrompt {
  readonly failure: FailureClassification
  readonly systemPrompt: string
  readonly instruction: string
}

export interface RepairState {
  readonly originalTask: string
  readonly attempts: number
  readonly budget: RepairBudget
  readonly history: RepairAttemptRecord[]
}

export interface RepairAttemptRecord {
  readonly attemptNumber: number
  readonly failure: FailureClassification
  readonly result: AgentResult
  readonly mutationApplied: boolean
}

export type RepairDecision = "APPROVE" | "REJECT" | "SKIP"

export interface BoundedRepairLifecycle {
  executeRepairLoop(
    originalInput: any, // We will use 'any' to avoid circular/hard to find type
    preparedVerification: PreparedVerification,
    verificationId: string,
    onMutationReady: (mutationPayload: unknown) => Promise<RepairDecision>
  ): Promise<AgentResult>
}

