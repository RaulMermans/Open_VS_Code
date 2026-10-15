/**
 * Sprint 5D test helpers: an in-memory learning store and workspace, and compact WorkflowState
 * builders for terminal workflow outcomes. Shared by the unit tests and `eval:learning`.
 */
import type { AgentMode } from "../../src/contracts/agent.ts"
import type { FailurePatternCandidate, NonProgressReport } from "../../src/progress/contracts.ts"
import { LearningService } from "../../src/learning/service.ts"
import type { WorkflowState } from "../../src/workflow/contracts.ts"

export const BUILTIN_IDS = ["bug-triage", "refactor-with-guards", "security-review", "tdd", "verification"]

export interface MemoryWorkspace {
  readonly files: Map<string, string>
  readonly writes: string[]
  store(): string | undefined
  open(options?: { enabled?: boolean; trusted?: boolean; projectId?: string; clock?: () => string }): Promise<LearningService>
}

export function memoryWorkspace(initial: Readonly<Record<string, string>> = {}): MemoryWorkspace {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  let store: string | undefined
  let tick = 0
  return {
    files,
    writes,
    store: () => store,
    open: (options = {}) =>
      LearningService.open({
        enabled: options.enabled ?? true,
        projectId: options.projectId ?? "p-test",
        builtinSkillIds: BUILTIN_IDS,
        workspaceTrusted: options.trusted ?? true,
        clock: options.clock ?? (() => `2026-10-15T00:00:${String(tick++ % 60).padStart(2, "0")}.000Z`),
        storage: { read: async () => store, write: async (text) => void (store = text) },
        files: {
          exists: async (path) => files.has(path),
          readText: async (path) => files.get(path),
          writeText: async (path, content) => {
            writes.push(path)
            files.set(path, content)
          },
        },
      }),
  }
}

interface WorkflowShape {
  readonly id: string
  readonly status?: WorkflowState["status"]
  readonly verdict?: "READY" | "NOT_READY" | "BLOCKED"
  readonly testRepairs?: number
  readonly reviewRepairs?: number
  readonly blockingReview?: boolean
  readonly blocker?: WorkflowState["blocker"]
  readonly mode?: AgentMode
  readonly task?: string
  readonly command?: string
  readonly recovery?: { readonly outcome: "RECOVERED" | "NOT_RECOVERED"; readonly candidate: FailurePatternCandidate }
  readonly finalBlocker?: NonProgressReport
}

export function workflowState(shape: WorkflowShape): WorkflowState {
  const status = shape.status ?? "COMPLETE"
  const verdict = shape.verdict ?? (status === "COMPLETE" ? "READY" : "NOT_READY")
  return {
    schemaVersion: 1,
    workflowId: `wf-${shape.id}`,
    taskId: `task-${shape.id}`,
    mode: shape.mode ?? "DEBUG",
    task: shape.task ?? "Fix the failing subtract test",
    status,
    currentStage: status === "COMPLETE" ? "COMPLETE" : "BLOCKED",
    completedStages: [],
    selectedSkillIds: [],
    reviews: shape.blockingReview ? [{ attempt: 1, verdict: "FINDINGS", findings: [], blocking: 1, rejectedUngrounded: 0, rejectedMalformed: 0, counts: { BLOCKER: 0, HIGH: 1, MEDIUM: 0, LOW: 0, NOTE: 0 } }] : [],
    verification: { verdict, outcomes: [{ action: "TEST", command: shape.command ?? "npm test", status: verdict === "READY" ? "PASS" : "FAIL", exitCode: verdict === "READY" ? 0 : 1, durationMs: 5, fingerprint: "f", excerpt: "" }], diffIntegrity: "INTACT", divergedFiles: [] },
    retryCounts: { plan: 0, implement: 0, review: 0, testRepairs: shape.testRepairs ?? 0, reviewRepairs: shape.reviewRepairs ?? 0 },
    ...(shape.blocker ? { blocker: shape.blocker } : {}),
    stages: [],
    ...(shape.recovery || shape.finalBlocker
      ? {
          progress: {
            monitor: { lastByPoint: {}, counters: { test: { count: 0 }, review: { count: 0 }, diff: { count: 0 }, error: { count: 0 }, noAdvanceWindow: 0 }, observations: 0 },
            assessments: [],
            stallSignals: [],
            recoveryCount: shape.recovery ? 1 : 0,
            recoveryAttempted: Boolean(shape.recovery),
            diagnosticRun: Boolean(shape.recovery),
            ...(shape.recovery ? { recoveryOutcome: shape.recovery.outcome, patternCandidate: shape.recovery.candidate } : {}),
            ...(shape.finalBlocker ? { finalBlocker: shape.finalBlocker } : {}),
          },
        }
      : {}),
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  }
}

/** A verified bug fix that needed one test repair: the repair-against-failing-assertion pattern held. */
export const repairSuccess = (id: string) => workflowState({ id, testRepairs: 1 })
/** The same pattern followed, but the workflow hit its repair limit. */
export const repairFailure = (id: string) => workflowState({ id, status: "BLOCKED", verdict: "NOT_READY", testRepairs: 2, blocker: "TEST_REPAIR_LIMIT" })
