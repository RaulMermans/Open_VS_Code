import type { AgentEvent, AgentFailureReason, AgentResult, AgentResultStatus, AgentState, MutationReviewPayload } from "../contracts/agent.ts"
import type { RepairResult, RepairStatus } from "./repair-contracts.ts"
import type { PreparedVerification, VerificationResult } from "../tools/verification-contracts.ts"

const VERIFICATION_ACTIONS = new Set(["TEST", "TYPECHECK", "LINT", "BUILD"])

export function appliedPathsFromAgentResult(result: AgentResult): string[] {
  const answer = result.finalAnswer ?? ""
  const match = answer.match(/Changed: ([^.]+)\./)
  if (!match || match[1] === undefined) return []
  if (match[1].startsWith("unrelated")) return []
  return match[1].split(",").map((path) => path.trim()).filter((path) => path.length > 0 && !path.includes(" "))
}

export function lastFailedVerification(result: AgentResult): VerificationResult | undefined {
  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    const event: AgentEvent | undefined = result.events[index]
    if (!event || event.type !== "verification.completed") continue
    const verification = readVerificationResult(event.payload)
    if (verification && verification.status !== "PASS") return verification
  }
  return undefined
}

export function readMutationReview(value: unknown): Pick<MutationReviewPayload, "path" | "operation"> | undefined {
  const record = asRecord(value)
  if (!record || typeof record.path !== "string" || record.path.trim().length === 0) return undefined
  const operation = typeof record.operation === "string" && record.operation.trim().length > 0 ? record.operation : "edit"
  return { path: record.path, operation }
}

export function readVerificationReview(value: unknown): Pick<PreparedVerification, "verificationId" | "action"> | undefined {
  const record = asRecord(value)
  if (!record || typeof record.verificationId !== "string" || record.verificationId.trim().length === 0) return undefined
  if (typeof record.action !== "string" || !VERIFICATION_ACTIONS.has(record.action)) return undefined
  return { verificationId: record.verificationId, action: record.action as PreparedVerification["action"] }
}

/**
 * One coding task, one result. Repair evidence is attached to the original task.
 * A repair status is never cast into an agent status.
 */
export function integrateRepairOutcome(original: AgentResult, repair: RepairResult): AgentResult {
  const mapped = mapRepairStatus(repair.status)
  const prior = appliedPathsFromAgentResult(original)
  const extra = repair.changedFiles.filter((path) => !prior.includes(path))
  const changed = [...prior, ...extra]
  const changedLine = changed.length > 0 ? `Changed: ${changed.join(", ")}.` : "No files were changed."
  const tests = describeRepairTests(repair)
  const approval = repair.status === "REJECTED_BY_USER"
    ? "A later repair change was rejected. Earlier applied edits remain."
    : changed.length > 0
      ? "Approval was granted for the applied edit."
      : "No edit was approved."
  const outcome = mapped.status === "COMPLETED"
    ? "The requested edit was applied."
    : mapped.status === "CANCELLED"
      ? "The repair was cancelled."
      : `Incomplete: repair ended as ${repair.status}.`
  const task = original.finalState.task
  const finalState: AgentState = {
    status: mapped.state,
    ...(task ? { task } : {}),
    events: original.events,
    ...(original.finalState.error ? { error: original.finalState.error } : {}),
  }
  return {
    status: mapped.status,
    finalAnswer: `${changedLine} ${approval} ${tests} ${outcome}`,
    ...(mapped.failureReason ? { failureReason: mapped.failureReason } : {}),
    turns: original.turns + repair.totalAgentTurns,
    finalState,
    events: original.events,
    contextDiagnostics: original.contextDiagnostics,
    toolCalls: original.toolCalls,
    ...(original.observations ? { observations: original.observations } : {}),
    ...(original.terminationSource ? { terminationSource: original.terminationSource } : {}),
  }
}

function describeRepairTests(repair: RepairResult): string {
  const status = repair.finalVerification?.status
  if (status === "PASS") return "Tests passed."
  if (status === "FAIL") return "Tests failed."
  if (status === "CANCELLED" || repair.status === "CANCELLED") return "Verification was cancelled."
  return "Tests did not run."
}

function mapRepairStatus(status: RepairStatus): { status: AgentResultStatus; state: AgentState["status"]; failureReason?: AgentFailureReason } {
  switch (status) {
    case "COMPLETED":
      return { status: "COMPLETED", state: "COMPLETED" }
    case "CANCELLED":
      return { status: "CANCELLED", state: "CANCELLED", failureReason: "CANCELLED" }
    case "REJECTED_BY_USER":
      return { status: "FAILED", state: "FAILED", failureReason: "REJECTED" }
    case "AWAITING_MUTATION_APPROVAL":
    case "AWAITING_VERIFICATION_APPROVAL":
    case "INVESTIGATING":
    case "ANALYZING_FAILURE":
      return { status: "PAUSED", state: "WAITING_FOR_CONFIRMATION" }
    default:
      return { status: "FAILED", state: "FAILED", failureReason: "VERIFICATION_FAILED" }
  }
}

function readVerificationResult(payload: unknown): VerificationResult | undefined {
  const record = asRecord(payload)
  if (!record) return undefined
  return asVerificationResult(record.result)
}

function asVerificationResult(value: unknown): VerificationResult | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const status = record.status
  if (
    status !== "PASS" && status !== "FAIL" && status !== "TIMEOUT"
    && status !== "CANCELLED" && status !== "EXECUTION_ERROR" && status !== "STALE_VERIFICATION"
  ) return undefined
  if (record.exitCode !== null && typeof record.exitCode !== "number") return undefined
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string" || typeof record.durationMs !== "number") return undefined
  return {
    status,
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
    durationMs: record.durationMs,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}
