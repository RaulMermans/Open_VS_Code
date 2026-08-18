import type { AgentState, AgentStatus, AgentTask } from "../contracts/agent.ts"
import type { AgentEventType, AgentLifecycleEvent } from "./events.ts"

export class AgentTransitionError extends Error {
  readonly code = "INVALID_TRANSITION"

  constructor(message: string) {
    super(message)
    this.name = "AgentTransitionError"
  }
}

const TERMINAL_STATES = new Set<AgentStatus>(["COMPLETED", "FAILED", "CANCELLED"])

const TRANSITIONS: Readonly<Record<AgentEventType, ReadonlySet<AgentStatus>>> = {
  "task.started": new Set(["IDLE"]),
  "context.compiled": new Set(["PREPARING"]),
  "model.requested": new Set(["PREPARING", "PLANNING", "OBSERVING"]),
  "model.completed": new Set(["WAITING_FOR_MODEL"]),
  "model.failed": new Set(["WAITING_FOR_MODEL"]),
  "tool.requested": new Set(["OBSERVING"]),
  "tool.completed": new Set(["WAITING_FOR_TOOL"]),
  "tool.failed": new Set(["WAITING_FOR_TOOL"]),
  "verification.started": new Set(["PLANNING", "OBSERVING"]),
  "task.completed": new Set(["PLANNING", "OBSERVING", "VERIFYING"]),
  "task.failed": new Set(["PREPARING", "PLANNING", "WAITING_FOR_MODEL", "WAITING_FOR_TOOL", "OBSERVING", "VERIFYING"]),
  "task.cancelled": new Set(["PREPARING", "PLANNING", "WAITING_FOR_MODEL", "WAITING_FOR_TOOL", "OBSERVING", "VERIFYING"]),
}

const NEXT_STATUS: Readonly<Record<AgentEventType, AgentStatus>> = {
  "task.started": "PREPARING",
  "context.compiled": "PLANNING",
  "model.requested": "WAITING_FOR_MODEL",
  "model.completed": "OBSERVING",
  "model.failed": "FAILED",
  "tool.requested": "WAITING_FOR_TOOL",
  "tool.completed": "OBSERVING",
  "tool.failed": "FAILED",
  "verification.started": "VERIFYING",
  "task.completed": "COMPLETED",
  "task.failed": "FAILED",
  "task.cancelled": "CANCELLED",
}

export function initialAgentState(): AgentState {
  return { status: "IDLE", events: [] }
}

function errorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const message = (payload as Record<string, unknown>).message
  return typeof message === "string" ? message : undefined
}

function startedTask(payload: unknown): AgentTask {
  if (!payload || typeof payload !== "object") throw new AgentTransitionError("task.started requires a task payload")
  const task = (payload as Record<string, unknown>).task
  if (!task || typeof task !== "object" || typeof (task as AgentTask).id !== "string") {
    throw new AgentTransitionError("task.started requires a valid task")
  }
  return task as AgentTask
}

export function applyAgentEvent(state: AgentState, event: AgentLifecycleEvent): AgentState {
  if (TERMINAL_STATES.has(state.status)) throw new AgentTransitionError(`Terminal state ${state.status} cannot accept ${event.type}`)
  if (!TRANSITIONS[event.type].has(state.status)) throw new AgentTransitionError(`Event ${event.type} is invalid from ${state.status}`)
  if (state.task && event.taskId !== state.task.id) throw new AgentTransitionError(`Event task ${event.taskId} does not match active task ${state.task.id}`)

  const task = event.type === "task.started" ? startedTask(event.payload) : state.task
  if (!task) throw new AgentTransitionError(`Event ${event.type} requires an active task`)
  if (event.type === "task.started" && task.id !== event.taskId) throw new AgentTransitionError("Started task ID does not match event task ID")
  const error = event.type === "model.failed" || event.type === "tool.failed" || event.type === "task.failed"
    ? errorMessage(event.payload) ?? "Agent task failed"
    : undefined
  return {
    status: NEXT_STATUS[event.type],
    task,
    events: [...state.events, event],
    ...(error ? { error } : {}),
  }
}
