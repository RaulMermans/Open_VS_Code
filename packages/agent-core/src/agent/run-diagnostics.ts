import type { AgentEvent, AgentFailureReason, AgentToolCallRecord } from "../contracts/agent.ts"

/** Structured, privacy-conscious account of why a run ended. Derived from the event log and evidence; no new state. */
export interface RunDiagnostics {
  readonly runId: string
  readonly failureReason: AgentFailureReason | undefined
  /** The earliest task.failed event: the first thing that went wrong, not the last label. */
  readonly firstFailure?: { readonly stage: string; readonly turn: number; readonly message: string; readonly afterTool?: string }
  readonly lastTool?: { readonly name: string; readonly callId: string; readonly outcome: string }
  readonly appliedMutationIds: readonly string[]
  readonly pendingApproval: boolean
  readonly verification: { readonly lastStatus?: string; readonly ranAfterLastMutation: boolean; /** Tests that failed identically before and after this run's edits (predate the task or the environment). */ readonly unchangedFailures?: readonly string[] }
  /** Safe to resume from the checkpoint without repeating applied writes. */
  readonly recoverable: boolean
  /** Contradictions the user would otherwise have to find by hand. */
  readonly inconsistencies: readonly string[]
}

const RECOVERABLE: ReadonlySet<string> = new Set(["INTERNAL_ERROR", "MODEL_ERROR", "MAX_TURNS_EXCEEDED", "NON_PROGRESS", "VERIFICATION_UNAVAILABLE"])

/** Removes home directories, credentials and long opaque tokens; bounds length. */
export function sanitizeDiagnosticText(text: string, max = 300): string {
  return text
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~")
    .replace(/(?:Bearer\s+|sk-|ghp_|api[_-]?key["'=:\s]+)[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

export function buildRunDiagnostics(input: {
  readonly runId: string
  readonly status: string
  readonly failureReason?: AgentFailureReason | undefined
  readonly finalAnswer?: string | undefined
  readonly events: readonly AgentEvent[]
  readonly toolCalls: readonly AgentToolCallRecord[]
  readonly mutations: readonly { readonly mutationId: string; readonly path: string; readonly status: string; readonly timestamp?: string }[]
  readonly verifications: readonly { readonly status: string; readonly timestamp?: string }[]
  readonly pendingApproval: boolean
  readonly hasCheckpoint: boolean
  readonly unchangedFailures?: readonly string[]
}): RunDiagnostics {
  let turn = 0
  let lastToolEvent: string | undefined
  let firstFailure: RunDiagnostics["firstFailure"]
  const open = new Set<string>()
  for (const event of input.events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    if (event.type === "model.requested") turn = typeof payload.turn === "number" ? payload.turn : turn + 1
    if (event.type === "tool.requested") {
      const id = String(payload.callId ?? payload.id ?? "")
      lastToolEvent = String(payload.name ?? payload.toolName ?? "")
      if (id) open.add(id)
    }
    if (["tool.completed", "tool.failed", "tool.rejected"].includes(event.type)) open.delete(String(payload.callId ?? payload.id ?? ""))
    if (!firstFailure && event.type === "task.failed") {
      firstFailure = {
        stage: lastToolEvent ? "tool" : "model-or-context",
        turn,
        message: sanitizeDiagnosticText(String(payload.message ?? "no message recorded")),
        ...(lastToolEvent ? { afterTool: lastToolEvent } : {}),
      }
    }
  }
  const applied = input.mutations.filter((mutation) => mutation.status === "APPLIED")
  const lastMutationAt = applied.map((mutation) => mutation.timestamp ?? "").toSorted().at(-1)
  const lastVerification = input.verifications.at(-1)
  const ranAfter = Boolean(lastVerification && (!lastMutationAt || (lastVerification.timestamp ?? "") >= lastMutationAt))
  const lastCall = input.toolCalls.at(-1)

  const inconsistencies: string[] = []
  if (input.failureReason === "INTERNAL_ERROR" && !firstFailure) inconsistencies.push("INTERNAL_ERROR without a recorded failure event")
  if (open.size > 0) inconsistencies.push(`${open.size} tool request(s) never produced an observation`)
  const answer = input.finalAnswer ?? ""
  for (const mutation of applied) {
    if (answer && !answer.includes(mutation.path)) inconsistencies.push(`applied edit to ${mutation.path} is missing from the final report`)
  }
  if (input.status === "COMPLETED" && applied.length > 0 && !ranAfter) inconsistencies.push("completed with applied edits and no verification after them")
  if (/not modified|No files were changed/i.test(answer) && applied.length > 0) inconsistencies.push("report says nothing changed but edits were applied")

  return {
    runId: input.runId,
    failureReason: input.failureReason,
    ...(firstFailure ? { firstFailure } : {}),
    ...(lastCall ? { lastTool: { name: lastCall.name, callId: lastCall.id, outcome: lastCall.outcome } } : {}),
    appliedMutationIds: applied.map((mutation) => mutation.mutationId),
    pendingApproval: input.pendingApproval,
    verification: { ...(lastVerification ? { lastStatus: lastVerification.status } : {}), ranAfterLastMutation: ranAfter, ...(input.unchangedFailures?.length ? { unchangedFailures: input.unchangedFailures.slice(0, 8) } : {}) },
    recoverable: input.hasCheckpoint && !input.pendingApproval && RECOVERABLE.has(input.failureReason ?? ""),
    inconsistencies,
  }
}
