export const AGENT_MODES = ["ASK", "PLAN", "BUILD", "DEBUG", "REVIEW"] as const
export type AgentMode = (typeof AGENT_MODES)[number]

import type { ToolAction } from "./tools.ts"

export type AgentStatus = "IDLE" | "PREPARING" | "PLANNING" | "WAITING_FOR_MODEL" | "WAITING_FOR_TOOL" | "WAITING_FOR_CONFIRMATION" | "OBSERVING" | "VERIFYING" | "COMPLETED" | "FAILED" | "CANCELLED"

export interface AgentTask {
  readonly id: string
  readonly mode: AgentMode
  readonly instruction: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AgentEvent<TPayload = unknown> {
  readonly id: string
  readonly type: string
  readonly taskId: string
  readonly timestamp: string
  readonly payload: TPayload
}

export interface AgentState {
  readonly status: AgentStatus
  readonly task?: AgentTask
  readonly events: readonly AgentEvent[]
  readonly error?: string
}

export type AgentResultStatus = "COMPLETED" | "FAILED" | "CANCELLED" | "PAUSED"
export type AgentFailureReason =
  | "MODEL_ERROR"
  | "CONTEXT_OVERFLOW"
  | "MAX_TURNS_EXCEEDED"
  | "NON_PROGRESS"
  | "CANCELLED"
  | "INTERNAL_ERROR"

export interface AgentContextDiagnostic {
  readonly turn: number
  readonly totalEstimatedTokens: number
  readonly omittedItemIds: readonly string[]
}

export type AgentToolCallOutcome = "COMPLETED" | "FAILED" | "REJECTED" | "DENIED"

export interface AgentToolCallRecord {
  readonly id: string
  readonly name: string
  readonly outcome: AgentToolCallOutcome
  readonly truncated?: boolean
}

export interface MutationReviewPayload {
  readonly id: string
  readonly operation: string
  readonly path: string
  readonly beforeHash: string
  readonly afterHash: string
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly bytesChanged: number
  readonly diff: string
}

export interface AgentConfirmationRequest {
  readonly callId: string
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly action: ToolAction
  readonly preparedMutation?: MutationReviewPayload
  readonly preparedCommand?: import("../tools/verification-contracts.ts").PreparedVerification
}

export interface VerificationPreparedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
  readonly path?: string
}

export interface VerificationConfirmationRequestedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
}

export interface VerificationApprovedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
}

export interface VerificationStartedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
}

export interface VerificationOutputEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
  readonly stream: "stdout" | "stderr"
  readonly chunk: string
}

export interface VerificationCompletedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
  readonly result: import("../tools/verification-contracts.ts").VerificationResult
}

export interface VerificationFailedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
  readonly message?: string
}

export interface VerificationRejectedEventPayload {
  readonly callId: string
  readonly name: string
  readonly mutationId: string
  readonly executionId: string
}

export interface AgentResult {
  readonly status: AgentResultStatus
  readonly finalAnswer?: string
  readonly failureReason?: AgentFailureReason
  readonly turns: number
  readonly finalState: AgentState
  readonly events: readonly AgentEvent[]
  readonly contextDiagnostics: readonly AgentContextDiagnostic[]
  readonly toolCalls: readonly AgentToolCallRecord[]
  readonly confirmation?: AgentConfirmationRequest
  readonly evalResults?: readonly import("../runtime-evals/contracts.ts").RuntimeEvalResult[]
  readonly evalSummary?: string
  readonly terminationSource?: "RUNTIME_EVAL" | "NON_PROGRESS_GUARD" | undefined
  readonly observations?: readonly import("../agent/observations.ts").ToolObservation[]
}
