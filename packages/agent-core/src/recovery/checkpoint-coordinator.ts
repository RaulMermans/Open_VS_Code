/**
 * Checkpoint Coordinator
 * Sprint 4C — Orchestrates durable checkpoints, write-ahead journaling, and recovery integration
 */

import { randomUUID } from "node:crypto"
import {
  type CheckpointRecord,
  type CheckpointReason,
  type RecoveryOperation,
  type WorkspaceRecoveryFootprint,
  type FileStateFootprint,
  CHECKPOINT_SCHEMA_VERSION,
} from "./contracts.ts"
import { CheckpointStore } from "./checkpoint-store.ts"
import { OperationJournal, computeOperationIdempotencyKey, computeIntentHash } from "./operation-journal.ts"
import { RecoveryArtifactStore } from "./recovery-artifacts.ts"
import { RecoveryController } from "./recovery-controller.ts"
import { getProcessEpochId } from "./process-epoch.ts"
import { observeFilePath } from "./reconciliation.ts"
import { MutationEngine } from "../tools/mutation-engine.ts"

export interface CheckpointCoordinatorOptions {
  readonly workspaceRoot: string
  readonly storageRoot?: string | undefined
  readonly mutationEngine: MutationEngine
  readonly maxCheckpoints?: number | undefined
}

export class CheckpointCoordinator {
  readonly #workspaceRoot: string
  readonly #storageRoot: string
  readonly #checkpointStore: CheckpointStore
  readonly #operationJournal: OperationJournal
  readonly #artifactStore: RecoveryArtifactStore
  readonly #recoveryController: RecoveryController
  readonly #mutationEngine: MutationEngine
  #sequence = 0

  constructor(options: CheckpointCoordinatorOptions) {
    this.#workspaceRoot = options.workspaceRoot
    this.#storageRoot = options.storageRoot ?? `${options.workspaceRoot}/.open-vs-code/recovery`
    this.#mutationEngine = options.mutationEngine

    this.#checkpointStore = new CheckpointStore({
      storageRoot: this.#storageRoot,
      maxCheckpoints: options.maxCheckpoints,
    })
    this.#operationJournal = new OperationJournal({
      storageRoot: this.#storageRoot,
    })
    this.#artifactStore = new RecoveryArtifactStore({
      storageRoot: this.#storageRoot,
    })
    this.#recoveryController = new RecoveryController({
      checkpointStore: this.#checkpointStore,
      operationJournal: this.#operationJournal,
      artifactStore: this.#artifactStore,
      mutationEngine: this.#mutationEngine,
    })
  }

  get workspaceRoot(): string {
    return this.#workspaceRoot
  }

  get storageRoot(): string {
    return this.#storageRoot
  }

  get checkpointStore(): CheckpointStore {
    return this.#checkpointStore
  }

  get operationJournal(): OperationJournal {
    return this.#operationJournal
  }

  get artifactStore(): RecoveryArtifactStore {
    return this.#artifactStore
  }

  get recoveryController(): RecoveryController {
    return this.#recoveryController
  }

  /**
   * Capture durable checkpoint at semantic transition
   */
  async checkpoint(params: {
    runId: string
    reason: CheckpointReason
    phase: string
    turnId?: number
    evidenceVersion: number
    runtimeState: CheckpointRecord["runtimeState"]
    touchedFilePaths?: readonly string[]
    planRef?: string
    currentStepRef?: string
    runtimeEvalRef?: string
  }): Promise<CheckpointRecord> {
    this.#sequence++
    const checkpointId = `cp_${randomUUID().slice(0, 8)}`
    const processEpochId = getProcessEpochId()

    // Bounded footprint calculation: only inspect explicitly touched / mutated files
    const fileFootprints: FileStateFootprint[] = []
    if (params.touchedFilePaths) {
      for (const p of params.touchedFilePaths) {
        const obs = await observeFilePath(p)
        fileFootprints.push({
          path: p,
          exists: obs.exists,
          hash: obs.hash,
        })
      }
    }

    const footprint: WorkspaceRecoveryFootprint = {
      files: fileFootprints,
    }

    // Pending operations from journal
    const allOps = await this.#operationJournal.getAllOperations(params.runId)
    const pendingOps = allOps.filter(
      (o) => o.status === "PREPARED" || o.status === "STARTED"
    )
    const completedOpRefs = allOps
      .filter((o) => o.status === "COMPLETED" || o.status === "RECONCILED_APPLIED")
      .map((o) => o.operationId)

    const recordWithoutChecksum: Omit<CheckpointRecord, "checksum"> = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointId,
      sequence: this.#sequence,
      runId: params.runId,
      processEpochId,
      turnId: params.turnId,
      evidenceVersion: params.evidenceVersion,
      phase: params.phase,
      reason: params.reason,
      createdAt: new Date().toISOString(),
      planRef: params.planRef,
      currentStepRef: params.currentStepRef,
      runtimeState: params.runtimeState,
      recoveryFootprint: footprint,
      pendingOperations: pendingOps,
      completedOperationRefs: completedOpRefs,
      runtimeEvalRef: params.runtimeEvalRef,
      workspaceState: {
        divergenceClass: "EXACT_MATCH",
      },
    }

    return this.#checkpointStore.saveCheckpoint(recordWithoutChecksum)
  }

  /**
   * Write-Ahead: record side-effect operation PREPARED
   */
  async prepareOperation(params: {
    runId: string
    evidenceVersion: number
    kind: RecoveryOperation["kind"]
    authorityId: string
    preconditions: RecoveryOperation["preconditions"]
    expectedPostconditions: RecoveryOperation["expectedPostconditions"]
    payload?: Record<string, unknown>
    replacesOperationId?: string
  }): Promise<RecoveryOperation> {
    const operationId = `op_${randomUUID().slice(0, 8)}`
    const processEpochId = getProcessEpochId()
    const latestCp = await this.#checkpointStore.getLatestCheckpoint(params.runId)
    const checkpointId = latestCp?.checkpointId ?? "init"

    const intentHash = computeIntentHash({
      kind: params.kind,
      preconditions: params.preconditions,
      expectedPostconditions: params.expectedPostconditions,
      payload: params.payload,
    })

    const idempotencyKey = computeOperationIdempotencyKey(
      params.runId,
      params.evidenceVersion,
      params.kind,
      params.authorityId,
      intentHash
    )

    return this.#operationJournal.recordPrepared({
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      operationId,
      idempotencyKey,
      runId: params.runId,
      processEpochId,
      checkpointId,
      evidenceVersion: params.evidenceVersion,
      kind: params.kind,
      authorityId: params.authorityId,
      intentHash,
      preconditions: params.preconditions,
      expectedPostconditions: params.expectedPostconditions,
      payload: params.payload,
      replacesOperationId: params.replacesOperationId,
    })
  }

  /**
   * Save original preimage before mutation executes to enable rollback
   */
  async savePreimage(
    runId: string,
    operationId: string,
    path: string,
    content: Buffer | string
  ) {
    return this.#artifactStore.storePreimage(runId, operationId, path, content)
  }
}
