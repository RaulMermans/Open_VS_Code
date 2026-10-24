/**
 * Read-only Recovery Inspection
 * Sprint 7C — What an editor may show about an earlier run, without acting on it.
 *
 * Composes CheckpointStore, OperationJournal and RecoveryController.buildRecoveryPlan
 * (with persistReconciliation: false), so the disposition comes from the one
 * authoritative recovery planner. Nothing here resumes, replays, rolls back or
 * approves anything, and the journal and checkpoint files are left byte-identical.
 */

import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import type { RecoveryDisposition, RecoveryOperation } from "./contracts.ts"
import { CheckpointStore } from "./checkpoint-store.ts"
import { OperationJournal } from "./operation-journal.ts"
import { RecoveryArtifactStore } from "./recovery-artifacts.ts"
import { RecoveryController } from "./recovery-controller.ts"
import { getProcessEpochId } from "./process-epoch.ts"
import { reconcileOperation } from "./reconciliation.ts"
import { assertSafeStoragePath } from "./storage-path-safety.ts"
import { MutationEngine } from "../tools/mutation-engine.ts"

/** Run ids are produced by the runtime (`session-<ms>`); anything else is refused before touching disk. */
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export const MAX_INSPECTED_OPERATIONS = 20
export const MAX_INSPECTED_FILES = 20

export type RunRecoveryState =
  | "NO_RECORD"
  | "COMPLETED"
  | "STOPPED"
  | "INTERRUPTED"
  | "REVERIFY"
  | "RECONFIRM"
  | "MANUAL_INSPECTION"
  | "UNREADABLE"

export interface InspectedOperation {
  readonly kind: RecoveryOperation["kind"]
  readonly journalStatus: RecoveryOperation["status"]
  readonly observedStatus: RecoveryOperation["status"]
  readonly blocked: boolean
  readonly path?: string
}

export interface RunRecoveryInspection {
  readonly runId: string
  readonly state: RunRecoveryState
  /** RecoveryController's own disposition, when a plan could be built. */
  readonly disposition?: RecoveryDisposition
  readonly reasons: readonly string[]
  readonly manualInspectionRequired: boolean
  /** Always false: an inspection never authorizes execution. */
  readonly executableResume: false
  readonly checkpoint?: {
    readonly checkpointId: string
    readonly sequence: number
    readonly reason: string
    readonly phase: string
    readonly status: string
    readonly createdAt: string
    readonly fromEarlierProcess: boolean
    readonly awaitingApproval: boolean
  }
  readonly operations: readonly InspectedOperation[]
  readonly operationsTruncated: boolean
  /** Workspace-relative paths recorded in the checkpoint footprint or journal. */
  readonly files: readonly string[]
}

export interface InspectRunRecoveryOptions {
  readonly workspaceRoot: string
  readonly runId: string
  readonly storageRoot?: string
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const st = await lstat(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code
  if (typeof code === "string" && /^[A-Z_]{2,40}$/.test(code)) return code
  const message = (err as { message?: unknown })?.message
  const prefix = typeof message === "string" ? /^([A-Z_]{4,40}):/.exec(message)?.[1] : undefined
  return prefix ?? "UNREADABLE_RECORD"
}

function bounded(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export async function inspectRunRecovery(options: InspectRunRecoveryOptions): Promise<RunRecoveryInspection> {
  const { runId } = options
  const base = {
    runId,
    executableResume: false as const,
    operations: [] as InspectedOperation[],
    operationsTruncated: false,
    files: [] as string[],
  }
  if (!SAFE_RUN_ID.test(runId)) {
    return { ...base, state: "UNREADABLE", reasons: ["INVALID_RUN_ID"], manualInspectionRequired: true }
  }

  const storageRoot = options.storageRoot ?? join(options.workspaceRoot, ".open-vs-code", "recovery")
  const runDir = join(storageRoot, "runs", runId)
  try {
    await assertSafeStoragePath(storageRoot, runDir)
  } catch (err) {
    return { ...base, state: "UNREADABLE", reasons: [errorCode(err)], manualInspectionRequired: true }
  }
  // Gate on existence first so inspecting an unknown or pruned run creates nothing.
  if (!(await isRealDirectory(join(storageRoot, "runs"))) || !(await isRealDirectory(runDir))) {
    return { ...base, state: "NO_RECORD", reasons: ["No durable checkpoint or journal is recorded for this run."], manualInspectionRequired: false }
  }

  let workspaceReal: string
  try {
    workspaceReal = await realpath(options.workspaceRoot)
  } catch {
    workspaceReal = options.workspaceRoot
  }
  const toRelative = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    const rel = isAbsolute(p) ? relative(workspaceReal, p) : p
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined
    return rel.split("\\").join("/")
  }

  const checkpointStore = new CheckpointStore({ storageRoot })
  const operationJournal = new OperationJournal({ storageRoot })
  const controller = new RecoveryController({
    checkpointStore,
    operationJournal,
    artifactStore: new RecoveryArtifactStore({ storageRoot }),
    mutationEngine: new MutationEngine(options.workspaceRoot),
  })

  try {
    const latest = (await isRealDirectory(join(runDir, "checkpoints")))
      ? await checkpointStore.getLatestCheckpoint(runId)
      : null
    const allOps = await operationJournal.getAllOperations(runId)
    const plan = await controller.buildRecoveryPlan(runId, { persistReconciliation: false })

    const currentEpoch = getProcessEpochId()
    const operations: InspectedOperation[] = []
    const files = new Set<string>()
    for (const p of latest?.recoveryFootprint.files ?? []) {
      const rel = toRelative(p.path)
      if (rel) files.add(rel)
    }
    for (const op of allOps) {
      const observed = await reconcileOperation(op, currentEpoch)
      const path = toRelative(op.expectedPostconditions[0]?.path ?? op.preconditions[0]?.path)
      if (path) files.add(path)
      if (operations.length < MAX_INSPECTED_OPERATIONS) {
        operations.push({
          kind: op.kind,
          journalStatus: op.status,
          observedStatus: observed.summary.reconciledStatus,
          blocked: observed.isBlocked,
          ...(path ? { path } : {}),
        })
      }
    }

    const checkpoint = latest
      ? {
          checkpointId: latest.checkpointId,
          sequence: latest.sequence,
          reason: latest.reason,
          phase: latest.phase,
          status: latest.runtimeState.status,
          createdAt: latest.createdAt,
          fromEarlierProcess: latest.processEpochId !== currentEpoch,
          awaitingApproval: latest.runtimeState.status === "WAITING_FOR_CONFIRMATION" || Boolean(latest.runtimeState.pendingConfirmation),
        }
      : undefined

    let state: RunRecoveryState
    if (!latest && allOps.length === 0) state = "NO_RECORD"
    else if (latest && (latest.runtimeState.status === "COMPLETED" || latest.reason === "COMPLETED")) state = "COMPLETED"
    else if (plan.disposition === "ASK_HUMAN" || plan.divergenceClass === "BLOCKED_DIVERGENCE") state = "MANUAL_INSPECTION"
    else if (plan.disposition === "STOP") state = "STOPPED"
    else if (plan.disposition === "RECONFIRM") state = "RECONFIRM"
    else if (plan.disposition === "REVERIFY") state = "REVERIFY"
    else state = "INTERRUPTED"

    return {
      ...base,
      state,
      disposition: plan.disposition,
      reasons: plan.reasons.slice(0, 5).map((r) => bounded(r)),
      manualInspectionRequired: state === "MANUAL_INSPECTION",
      ...(checkpoint ? { checkpoint } : {}),
      operations,
      operationsTruncated: allOps.length > operations.length,
      files: Array.from(files).slice(0, MAX_INSPECTED_FILES),
    }
  } catch (err) {
    return { ...base, state: "UNREADABLE", reasons: [errorCode(err)], manualInspectionRequired: true }
  }
}
