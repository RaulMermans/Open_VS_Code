/**
 * Adapters from the workflow to existing infrastructure. The workflow core depends only on these
 * interfaces: verification goes through the canonical discovery + VerificationEngine, and state goes
 * through the existing atomic, checksummed CheckpointStore. No second verifier or persistence layer.
 */
import { CheckpointStore } from "../recovery/checkpoint-store.ts"
import { getProcessEpochId } from "../recovery/process-epoch.ts"
import { VerificationEngine } from "../tools/verification-engine.ts"
import { discoverVerificationCommand } from "../tools/verification-discovery.ts"
import { ACTION_TIMEOUTS } from "../tools/verification-registry.ts"
import type { PreparedVerification, VerificationAction, VerificationResult } from "../tools/verification-contracts.ts"
import type { WorkflowState } from "./contracts.ts"

export interface WorkflowVerifier {
  /** The command the repository defines for `action`, or undefined when it defines none. */
  discover(action: VerificationAction): Promise<string | undefined>
  run(action: VerificationAction, signal?: AbortSignal): Promise<{ readonly command: string; readonly result: VerificationResult }>
}

/** Default verifier: repository-defined commands only, frozen and stale-checked by VerificationEngine. */
export function createWorkspaceVerifier(workspaceRoot: string, engine = new VerificationEngine({ workspaceRoot })): WorkflowVerifier {
  let sequence = 0
  return {
    async discover(action) {
      try {
        const command = await discoverVerificationCommand(workspaceRoot, action)
        return `${command.executable} ${command.args.join(" ")}`
      } catch {
        return undefined
      }
    },
    async run(action, signal) {
      const command = await discoverVerificationCommand(workspaceRoot, action)
      sequence += 1
      const prepared: PreparedVerification = {
        verificationId: `workflow-verification-${Date.now()}-${sequence}`,
        action,
        executable: command.executable,
        args: command.args,
        cwd: workspaceRoot,
        timeoutMs: ACTION_TIMEOUTS[action],
        commandPreview: `${command.executable} ${command.args.join(" ")}`,
        packageJsonPath: command.packageJsonPath,
        packageJsonHash: command.packageJsonHash,
        scriptName: command.scriptName,
        scriptBody: command.scriptBody,
      }
      return { command: prepared.commandPreview, result: await engine.execute(prepared, signal) }
    },
  }
}

export interface WorkflowStateStore {
  save(state: WorkflowState): Promise<void>
  load(workflowId: string): Promise<WorkflowState | null>
}

export function workflowRunId(workflowId: string): string {
  return `workflow-${workflowId}`
}

/** Persists workflow state as WORKFLOW_STAGE checkpoints in the existing recovery store. */
export class CheckpointWorkflowStore implements WorkflowStateStore {
  readonly #store: CheckpointStore
  readonly #sequences = new Map<string, number>()

  constructor(store: CheckpointStore) {
    this.#store = store
  }

  static forWorkspace(workspaceRoot: string): CheckpointWorkflowStore {
    return new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: `${workspaceRoot}/.open-vs-code/recovery` }))
  }

  async save(state: WorkflowState): Promise<void> {
    const runId = workflowRunId(state.workflowId)
    let sequence = this.#sequences.get(runId)
    if (sequence === undefined) sequence = (await this.#store.getLatestCheckpoint(runId))?.sequence ?? 0
    sequence += 1
    this.#sequences.set(runId, sequence)
    await this.#store.saveCheckpoint({
      schemaVersion: 1,
      checkpointId: `wf-${sequence}`,
      sequence,
      runId,
      processEpochId: getProcessEpochId(),
      evidenceVersion: sequence,
      phase: state.currentStage,
      reason: "WORKFLOW_STAGE",
      createdAt: state.updatedAt,
      runtimeState: { status: state.status },
      recoveryFootprint: { files: [] },
      pendingOperations: [],
      completedOperationRefs: [],
      workspaceState: {},
      workflow: state as unknown as Readonly<Record<string, unknown>>,
    })
  }

  async load(workflowId: string): Promise<WorkflowState | null> {
    const record = await this.#store.getLatestCheckpoint(workflowRunId(workflowId))
    const state = record?.workflow as WorkflowState | undefined
    if (!state || state.schemaVersion !== 1 || state.workflowId !== workflowId) return null
    this.#sequences.set(workflowRunId(workflowId), record!.sequence)
    return state
  }
}
