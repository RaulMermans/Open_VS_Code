import type { AgentEvent } from "../contracts/agent.ts"

export const AGENT_EVENT_TYPES = [
  "task.started",
  "context.compiled",
  "model.requested",
  "model.completed",
  "model.failed",
  "tool.requested",
  "tool.completed",
  "tool.failed",
  "tool.rejected",
  "permission.requested",
  "permission.approved",
  "permission.rejected",
  "permission.denied",
  "verification.requested",
  "verification.prepared",
  "verification.confirmation_requested",
  "verification.approved",
  "verification.started",
  "verification.output",
  "verification.completed",
  "verification.failed",
  "verification.timeout",
  "verification.cancelled",
  "verification.rejected",
  "mutation.prepared",
  "mutation.confirmation_requested",
  "mutation.approved",
  "mutation.rejected",
  "mutation.applied",
  "mutation.failed",
  "mutation.rollback_started",
  "mutation.rolled_back",
  "mutation.rollback_failed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.max_turns",
  "task.non_progress",
  "runtime_eval.started",
  "runtime_eval.completed",
  "runtime_eval.intervention",
  "runtime_eval.outcome",
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]
export type AgentLifecycleEvent = AgentEvent<unknown> & { readonly type: AgentEventType }

export interface AgentEventFactory {
  readonly createId: () => string
  readonly now: () => string
}

export function createAgentEvent(
  type: AgentEventType,
  taskId: string,
  payload: unknown,
  factory: AgentEventFactory,
): AgentLifecycleEvent {
  if (!taskId.trim()) throw new TypeError("Agent event taskId must not be empty")
  return { id: factory.createId(), type, taskId, timestamp: factory.now(), payload }
}
