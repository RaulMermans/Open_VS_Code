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
  "verification.started",
  "task.completed",
  "task.failed",
  "task.cancelled",
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
