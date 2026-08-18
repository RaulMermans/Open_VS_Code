export const AGENT_MODES = ["ASK", "PLAN", "BUILD", "DEBUG", "REVIEW"] as const
export type AgentMode = (typeof AGENT_MODES)[number]

export type AgentStatus = "IDLE" | "PREPARING" | "PLANNING" | "WAITING_FOR_MODEL" | "WAITING_FOR_TOOL" | "OBSERVING" | "VERIFYING" | "COMPLETED" | "FAILED" | "CANCELLED"

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
