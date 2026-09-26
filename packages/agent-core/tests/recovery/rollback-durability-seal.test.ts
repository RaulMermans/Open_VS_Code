/**
 * Rollback Durability Final Seal Test Suite
 * Sprint 4C.4 — Micro-closure: Sealing rollback durability invariants
 * Tasks: T-5200 through T-5222
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { CheckpointCoordinator } from "../../src/recovery/checkpoint-coordinator.ts"
import { RollbackManager } from "../../src/recovery/rollback.ts"
import { MutationEngine, sha256 } from "../../src/tools/mutation-engine.ts"
import { RecoveryArtifactStore } from "../../src/recovery/recovery-artifacts.ts"
import { OperationJournal } from "../../src/recovery/operation-journal.ts"
import { CheckpointStore } from "../../src/recovery/checkpoint-store.ts"
import type { RollbackCandidate } from "../../src/recovery/contracts.ts"

describe("Sprint 4C.4 — Rollback Durability Final Seal", () => {
  // -------------------------------------------------------------------------
  // T-5200 / T-5201: No Journal = No Rollback
  // -------------------------------------------------------------------------
  test("T-5200/T-5201: RollbackManager without OperationJournal fails closed with zero reverse writes", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-no-journal-"))
    try {
      const targetFile = join(wsDir, "file.txt")
      await writeFile(targetFile, "mutated_content\n", "utf8")

      let reverseCalls = 0
      const mutationEngine = new MutationEngine(wsDir)
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      const artifactStore = new RecoveryArtifactStore({ storageRoot: join(wsDir, ".checkpoints", "artifacts") })
      const checkpointStore = new CheckpointStore({ storageRoot: join(wsDir, ".checkpoints") })

      // Instantiate RollbackManager without OperationJournal
      const rollbackManager = new RollbackManager({
        mutationEngine,
        artifactStore,
        operationJournal: undefined as any,
        checkpointStore,
      })

      const cand: RollbackCandidate = {
        mutationId: "mut-1",
        operationId: "op-1",
        path: targetFile,
        beforeHash: sha256("original_content\n"),
        afterHash: sha256("mutated_content\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }

      const res = await rollbackManager.executeRollback("run-no-journal", cand)

      assert.strictEqual(res.success, false, "Must not report success without journal")
      assert.strictEqual(res.durableSuccess, false, "Durable success must be false")
      assert.strictEqual(res.durabilityFailure, true, "Must flag durability failure")
      assert.strictEqual(res.status, "FAILED", "Status must be FAILED")
      assert.strictEqual(reverseCalls, 0, "MutationEngine reverse calls must be exactly 0")
      assert.strictEqual(await readFile(targetFile, "utf8"), "mutated_content\n", "Workspace file must remain unchanged")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5202: No CheckpointStore = No Rollback
  // -------------------------------------------------------------------------
  test("T-5202: RollbackManager without CheckpointStore fails closed with zero reverse writes", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-no-checkpoint-"))
    try {
      const targetFile = join(wsDir, "file.txt")
      await writeFile(targetFile, "mutated_content\n", "utf8")

      let reverseCalls = 0
      const mutationEngine = new MutationEngine(wsDir)
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      const artifactStore = new RecoveryArtifactStore({ storageRoot: join(wsDir, ".checkpoints", "artifacts") })
      const operationJournal = new OperationJournal({ storageRoot: join(wsDir, ".checkpoints") })

      // Instantiate RollbackManager without CheckpointStore
      const rollbackManager = new RollbackManager({
        mutationEngine,
        artifactStore,
        operationJournal,
        checkpointStore: undefined as any,
      })

      const cand: RollbackCandidate = {
        mutationId: "mut-2",
        operationId: "op-2",
        path: targetFile,
        beforeHash: sha256("original_content\n"),
        afterHash: sha256("mutated_content\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }

      const res = await rollbackManager.executeRollback("run-no-checkpoint", cand)

      assert.strictEqual(res.success, false)
      assert.strictEqual(res.durableSuccess, false)
      assert.strictEqual(res.durabilityFailure, true)
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(reverseCalls, 0, "MutationEngine reverse calls must be exactly 0")
      assert.strictEqual(await readFile(targetFile, "utf8"), "mutated_content\n", "Workspace file must remain unchanged")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5203 / T-5204: Journal History Read Failure Fails Closed
  // -------------------------------------------------------------------------
  test("T-5203/T-5204: Journal history read failure aborts rollback without writing or bypassing duplicate suppression", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-journal-read-fail-"))
    try {
      const targetFile = join(wsDir, "app.ts")
      const original = "const x = 1\n"
      const mutated = "const x = 2\n"
      await writeFile(targetFile, original, "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-jread-fail"

      // 1. Initial forward mutation
      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "app.ts", patch: { search: "1", replace: "2" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256(original), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256(mutated), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from(original, "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand: RollbackCandidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash: sha256(original),
        afterHash: sha256(mutated),
        artifactAvailable: true,
        safeToRollback: true,
      }

      // 2. Inject journal read failure (getAllOperations throws)
      let reverseCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      let preparedCalls = 0
      const origRecordPrepared = coord.operationJournal.recordPrepared.bind(coord.operationJournal)
      coord.operationJournal.recordPrepared = async (...args) => {
        preparedCalls++
        return origRecordPrepared(...args)
      }

      const eioErr = new Error("EIO: hardware i/o failure on journal sector")
      ;(eioErr as any).code = "EIO"
      coord.operationJournal.setReadFileFnForTesting(async () => {
        throw eioErr
      })

      const res = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)

      // Restore methods
      coord.operationJournal.setReadFileFnForTesting(undefined)
      coord.operationJournal.recordPrepared = origRecordPrepared
      mutationEngine.rollback = origRollback

      assert.strictEqual(res.success, false, "Must fail closed on journal read failure")
      assert.strictEqual(res.durableSuccess, false)
      assert.strictEqual(res.durabilityFailure, true, "Must flag durabilityFailure")
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(reverseCalls, 0, "MutationEngine reverse calls must be exactly 0")
      assert.strictEqual(preparedCalls, 0, "PREPARED journal writes must be 0")
      assert.strictEqual(await readFile(targetFile, "utf8"), mutated, "Disk remains in post-mutation state")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5205 / T-5206: Pre-Write Durability (PREPARED & STARTED Failures)
  // -------------------------------------------------------------------------
  test("T-5205/T-5206: Pre-write PREPARED and STARTED persistence failures block MutationEngine", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-pre-write-"))
    try {
      const targetFile = join(wsDir, "pre.txt")
      await writeFile(targetFile, "v1\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-pre-write"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "pre.txt", patch: { search: "v1", replace: "v2" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256("v1\n"), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256("v2\n"), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from("v1\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand: RollbackCandidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash: sha256("v1\n"),
        afterHash: sha256("v2\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }

      let reverseCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      // Test PREPARED failure (T-5205)
      const origPrep = coord.operationJournal.recordPrepared.bind(coord.operationJournal)
      coord.operationJournal.recordPrepared = async (r) => {
        if (r.kind === "ROLLBACK_MUTATION") throw new Error("Disk full: cannot prepare rollback")
        return origPrep(r)
      }
      const resPrep = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(resPrep.success, false)
      assert.strictEqual(resPrep.durableSuccess, false)
      assert.strictEqual(resPrep.durabilityFailure, true)
      assert.strictEqual(reverseCalls, 0, "MutationEngine calls must be 0 after PREPARED failure")
      coord.operationJournal.recordPrepared = origPrep

      // Test STARTED failure (T-5206)
      const origStart = coord.operationJournal.recordStarted.bind(coord.operationJournal)
      coord.operationJournal.recordStarted = async (id, rId) => {
        if (id.startsWith("op_rb_")) throw new Error("Disk full: cannot start rollback")
        return origStart(id, rId)
      }
      const resStart = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(resStart.success, false)
      assert.strictEqual(resStart.durableSuccess, false)
      assert.strictEqual(resStart.durabilityFailure, true)
      assert.strictEqual(reverseCalls, 0, "MutationEngine calls must be 0 after STARTED failure")
      coord.operationJournal.recordStarted = origStart
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5207 / T-5208: Post-Write recordCompleted Persistence Failure
  // -------------------------------------------------------------------------
  test("T-5207/T-5208: recordCompleted persistence failure after write returns RECOVERY_REQUIRED with zero replay", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-rec-completed-fail-"))
    try {
      const targetFile = join(wsDir, "db.ts")
      const original = "host: 127.0.0.1\n"
      const mutated = "host: 192.168.1.1\n"
      await writeFile(targetFile, original, "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-comp-fail"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "db.ts", patch: { search: "127.0.0.1", replace: "192.168.1.1" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256(original), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256(mutated), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from(original, "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand: RollbackCandidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash: sha256(original),
        afterHash: sha256(mutated),
        artifactAvailable: true,
        safeToRollback: true,
      }

      // Track reverse mutation calls
      let reverseCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      // Inject recordCompleted failure on the rollback operation
      const origRecordCompleted = coord.operationJournal.recordCompleted.bind(coord.operationJournal)
      coord.operationJournal.recordCompleted = async (opId, rId, resId) => {
        if (opId.startsWith("op_rb_")) {
          throw new Error("Disk corruption during recordCompleted")
        }
        return origRecordCompleted(opId, rId, resId)
      }

      const res = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)

      // Expected T-5207 invariants:
      assert.strictEqual(res.success, false, "Must not report normal durable success")
      assert.strictEqual(res.durableSuccess, false, "durableSuccess must be false")
      assert.strictEqual(res.recoveryRequired, true, "Must flag recoveryRequired")
      assert.strictEqual(res.durabilityFailure, true, "Must flag durabilityFailure")
      assert.strictEqual(res.status, "RECOVERY_REQUIRED")
      assert.strictEqual(reverseCalls, 1, "Reverse mutation write occurred exactly once")
      assert.strictEqual(await readFile(targetFile, "utf8"), original, "File was restored to preimage A")

      // Second rollback attempt in same process must NOT replay reverse mutation (T-5207)
      const resSecond = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(reverseCalls, 1, "Automatic replay must be 0")
      assert.strictEqual(resSecond.success, true, "Idempotently resolves restored disk")

      // Restart reconciliation (T-5208):
      // In new process instance, journal still has STARTED, but disk has restored state A.
      const restartCoord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const plan = await restartCoord.recoveryController.buildRecoveryPlan(runId)
      const rbOp = plan.reconciledOperations.find((o) => o.kind === "ROLLBACK_MUTATION")
      assert.ok(rbOp, "Rollback operation must be reconciled")
      assert.strictEqual(rbOp?.reconciledStatus, "RECONCILED_APPLIED", "Must reconcile as RECONCILED_APPLIED based on disk state")
      assert.strictEqual(rbOp?.writeReplayCount, 0, "Duplicate rollback writes must be 0")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5209 / T-5210: Post-Write ROLLBACK_COMPLETED Checkpoint Failure
  // -------------------------------------------------------------------------
  test("T-5209/T-5210: ROLLBACK_COMPLETED checkpoint persistence failure returns RECOVERY_REQUIRED with zero replay", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-checkpoint-fail-"))
    try {
      const targetFile = join(wsDir, "config.json")
      const original = JSON.stringify({ mode: "prod" })
      const mutated = JSON.stringify({ mode: "dev" })
      await writeFile(targetFile, original, "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-cp-fail"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "config.json", patch: { search: "prod", replace: "dev" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256(original), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256(mutated), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from(original, "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand: RollbackCandidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash: sha256(original),
        afterHash: sha256(mutated),
        artifactAvailable: true,
        safeToRollback: true,
      }

      let reverseCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      // Inject checkpointStore.saveCheckpoint failure on ROLLBACK_COMPLETED
      const origSaveCp = coord.checkpointStore.saveCheckpoint.bind(coord.checkpointStore)
      coord.checkpointStore.saveCheckpoint = async (rec) => {
        if (rec.reason === "ROLLBACK_COMPLETED") {
          throw new Error("Disk full: cannot save ROLLBACK_COMPLETED checkpoint")
        }
        return origSaveCp(rec)
      }

      const res = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)

      // Expected T-5209 invariants:
      assert.strictEqual(res.success, false, "Must not report normal durable success")
      assert.strictEqual(res.durableSuccess, false, "durableSuccess must be false")
      assert.strictEqual(res.recoveryRequired, true, "Must flag recoveryRequired")
      assert.strictEqual(res.durabilityFailure, true, "Must flag durabilityFailure")
      assert.strictEqual(res.status, "RECOVERY_REQUIRED")
      assert.strictEqual(reverseCalls, 1, "Reverse mutation occurred exactly once")
      assert.strictEqual(await readFile(targetFile, "utf8"), original, "Workspace restored to state A")

      // Second rollback attempt in same process does NOT replay reverse mutation
      await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(reverseCalls, 1, "No same-process replay")

      // Restart reconciliation (T-5210):
      // Journal says rollback COMPLETED, disk is restored A, checkpoint missing/failed
      const restartCoord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const plan = await restartCoord.recoveryController.buildRecoveryPlan(runId)
      const rbOp = plan.reconciledOperations.find((o) => o.kind === "ROLLBACK_MUTATION")
      assert.ok(rbOp, "Rollback operation recognized from authoritative journal")
      assert.strictEqual(rbOp?.reconciledStatus, "RECONCILED_APPLIED")
      assert.strictEqual(rbOp?.writeReplayCount, 0, "Reverse writes remain 0")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5211 / T-5212 / T-5213: Reverse Mutation Fails + recordFailed
  // -------------------------------------------------------------------------
  test("T-5211/T-5212/T-5213: Reverse mutation failure and recordFailed persistence behavior", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-fail-paths-"))
    try {
      const targetFile = join(wsDir, "fail.txt")
      await writeFile(targetFile, "mutated\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // Case 1 (T-5211): MutationEngine fails, recordFailed succeeds
      const runId1 = "run-fail-rec-ok"
      const cand1: RollbackCandidate = {
        mutationId: "mut-f1",
        operationId: "op-f1",
        path: targetFile,
        beforeHash: sha256("orig\n"),
        afterHash: sha256("mutated\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }
      await coord.artifactStore.storePreimage(runId1, cand1.operationId, targetFile, Buffer.from("orig\n", "utf8"))

      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = (async () => {
        return { status: "FAILED", error: new Error("Simulated mutation engine failure") }
      }) as any

      const res1 = await coord.recoveryController.rollbackManager.executeRollback(runId1, cand1)
      assert.strictEqual(res1.success, false)
      assert.strictEqual(res1.status, "FAILED")
      assert.strictEqual(res1.recoveryRequired, false)
      assert.strictEqual(res1.durabilityFailure, false)

      const ops1 = await coord.operationJournal.getAllOperations(runId1)
      const opRecord1 = ops1.find((o) => o.kind === "ROLLBACK_MUTATION")
      assert.strictEqual(opRecord1?.status, "FAILED", "Journal correctly records FAILED state")

      // Case 2 (T-5212 / T-5213): MutationEngine fails AND recordFailed also fails
      const runId2 = "run-fail-rec-fail"
      const cand2: RollbackCandidate = {
        mutationId: "mut-f2",
        operationId: "op-f2",
        path: targetFile,
        beforeHash: sha256("orig\n"),
        afterHash: sha256("mutated\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }
      await coord.artifactStore.storePreimage(runId2, cand2.operationId, targetFile, Buffer.from("orig\n", "utf8"))

      let reverseCalls2 = 0
      mutationEngine.rollback = async () => {
        reverseCalls2++
        throw new Error("MutationEngine crash")
      }

      const origRecordFailed = coord.operationJournal.recordFailed.bind(coord.operationJournal)
      coord.operationJournal.recordFailed = async () => {
        throw new Error("Disk corruption: cannot record failure")
      }

      const res2 = await coord.recoveryController.rollbackManager.executeRollback(runId2, cand2)
      assert.strictEqual(res2.success, false)
      assert.strictEqual(res2.status, "RECOVERY_REQUIRED")
      assert.strictEqual(res2.recoveryRequired, true)
      assert.strictEqual(res2.durabilityFailure, true)
      assert.ok(res2.error?.startsWith("RECOVERY_PERSISTENCE_FAILED:"), "Must report explicit RECOVERY_PERSISTENCE_FAILED")

      // T-5213: No same-process replay after failed failure-persistence
      const res2Retry = await coord.recoveryController.rollbackManager.executeRollback(runId2, cand2)
      assert.strictEqual(reverseCalls2, 1, "Reverse MutationEngine call count does not increase")
      assert.strictEqual(res2Retry.recoveryRequired, true)

      // Journal remains conservatively STARTED
      const ops2 = await coord.operationJournal.getAllOperations(runId2)
      const opRecord2 = ops2.find((o) => o.kind === "ROLLBACK_MUTATION")
      assert.strictEqual(opRecord2?.status, "STARTED", "Journal conservatively preserved in STARTED state")

      coord.operationJournal.recordFailed = origRecordFailed
      mutationEngine.rollback = origRollback
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5214: Full Lifecycle Durable Success
  // -------------------------------------------------------------------------
  test("T-5214: Durable success requires full lifecycle passing all 6 phases", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-full-lifecycle-"))
    try {
      const targetFile = join(wsDir, "full.txt")
      const original = "v1\n"
      const mutated = "v2\n"
      await writeFile(targetFile, original, "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-full-life"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "full.txt", patch: { search: "v1", replace: "v2" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256(original), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256(mutated), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from(original, "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand: RollbackCandidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash: sha256(original),
        afterHash: sha256(mutated),
        artifactAvailable: true,
        safeToRollback: true,
      }

      const res = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)

      assert.strictEqual(res.success, true)
      assert.strictEqual(res.durableSuccess, true, "durableSuccess must be true when all phases pass")
      assert.strictEqual(res.durabilityFailure, false)
      assert.strictEqual(res.recoveryRequired, false)
      assert.strictEqual(res.status, "ROLLED_BACK")

      const ops = await coord.operationJournal.getAllOperations(runId)
      const rbOp = ops.find((o) => o.kind === "ROLLBACK_MUTATION")
      assert.ok(rbOp)
      assert.strictEqual(rbOp?.status, "COMPLETED")

      const latestCp = await coord.checkpointStore.getLatestCheckpoint(runId)
      assert.strictEqual(latestCp?.reason, "ROLLBACK_COMPLETED")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5215 / T-5216 / T-5217 / T-5218: Exactly-Once Reconciliation Matrix
  // -------------------------------------------------------------------------
  test("T-5215/T-5216/T-5217/T-5218: Exactly-once duplicate suppression and state reconciliation", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-reconciliation-"))
    try {
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // T-5215: COMPLETED rollback replay with restored disk -> 0 reverse writes
      const file15 = join(wsDir, "t5215.txt")
      await writeFile(file15, "A\n", "utf8")
      const prep15 = await mutationEngine.preparePatch({ operation: "patch", path: "t5215.txt", patch: { search: "A", replace: "B" } })
      const op15 = await coord.prepareOperation({
        runId: "run-5215",
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file15, expectedHash: sha256("A\n"), exists: true }],
        expectedPostconditions: [{ path: file15, expectedHash: sha256("B\n"), exists: true }],
        payload: { mutationId: prep15.id },
      })
      await coord.operationJournal.recordStarted(op15.operationId, "run-5215")
      await coord.artifactStore.storePreimage("run-5215", op15.operationId, file15, Buffer.from("A\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep15)
      await coord.operationJournal.recordCompleted(op15.operationId, "run-5215", prep15.id)

      const cand15: RollbackCandidate = {
        mutationId: prep15.id,
        operationId: op15.operationId,
        path: file15,
        beforeHash: sha256("A\n"),
        afterHash: sha256("B\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }
      await coord.recoveryController.rollbackManager.executeRollback("run-5215", cand15)

      let reverseCalls15 = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls15++
        return origRollback(...args)
      }
      const replayRes = await coord.recoveryController.rollbackManager.executeRollback("run-5215", cand15)
      assert.strictEqual(replayRes.success, true)
      assert.strictEqual(reverseCalls15, 0, "Duplicate rollback calls must produce 0 reverse writes")
      mutationEngine.rollback = origRollback

      // T-5216: STARTED rollback + restored disk -> reconciles APPLIED, 0 replay
      const file16 = join(wsDir, "t5216.txt")
      await writeFile(file16, "A_restored\n", "utf8")
      const op16 = await coord.prepareOperation({
        runId: "run-5216",
        evidenceVersion: 1,
        kind: "ROLLBACK_MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file16, expectedHash: sha256("B_mutated\n"), exists: true }],
        expectedPostconditions: [{ path: file16, expectedHash: sha256("A_restored\n"), exists: true }],
      })
      await coord.operationJournal.recordStarted(op16.operationId, "run-5216")
      const plan16 = await coord.recoveryController.buildRecoveryPlan("run-5216")
      const rec16 = plan16.reconciledOperations.find((o) => o.operationId === op16.operationId)
      assert.strictEqual(rec16?.reconciledStatus, "RECONCILED_APPLIED")
      assert.strictEqual(rec16?.writeReplayCount, 0)

      // T-5217: STARTED rollback + post-mutation disk (B) -> reconciles NOT_APPLIED, 0 replay
      const file17 = join(wsDir, "t5217.txt")
      await writeFile(file17, "B_mutated\n", "utf8")
      const op17 = await coord.prepareOperation({
        runId: "run-5217",
        evidenceVersion: 1,
        kind: "ROLLBACK_MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file17, expectedHash: sha256("B_mutated\n"), exists: true }],
        expectedPostconditions: [{ path: file17, expectedHash: sha256("A_restored\n"), exists: true }],
      })
      await coord.operationJournal.recordStarted(op17.operationId, "run-5217")
      const plan17 = await coord.recoveryController.buildRecoveryPlan("run-5217")
      const rec17 = plan17.reconciledOperations.find((o) => o.operationId === op17.operationId)
      assert.strictEqual(rec17?.reconciledStatus, "RECONCILED_NOT_APPLIED")
      assert.strictEqual(rec17?.writeReplayCount, 0)

      // T-5218: STARTED rollback + third-party divergence (C) -> blocks as DIVERGENCE, 0 replay
      const file18 = join(wsDir, "t5218.txt")
      await writeFile(file18, "C_diverged\n", "utf8")
      const op18 = await coord.prepareOperation({
        runId: "run-5218",
        evidenceVersion: 1,
        kind: "ROLLBACK_MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file18, expectedHash: sha256("B_mutated\n"), exists: true }],
        expectedPostconditions: [{ path: file18, expectedHash: sha256("A_restored\n"), exists: true }],
      })
      await coord.operationJournal.recordStarted(op18.operationId, "run-5218")
      const plan18 = await coord.recoveryController.buildRecoveryPlan("run-5218")
      const blocked18 = plan18.blockedOperations.find((o) => o.operationId === op18.operationId)
      assert.ok(blocked18, "Divergent rollback operation must be blocked")
      assert.strictEqual(plan18.divergenceClass, "BLOCKED_DIVERGENCE")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // Section 33: Fail-Closed Read/Write Failure Matrix
  // -------------------------------------------------------------------------
  test("Section 33: Compact Fail-Closed Read/Write Failure Matrix", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-failure-matrix-"))
    try {
      const file = join(wsDir, "matrix.txt")
      await writeFile(file, "original\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // Helper to setup forward mutation
      async function setupMutation(runId: string) {
        mutationEngine.resetStepCounter()
        await writeFile(file, "original\n", "utf8")
        const prep = await mutationEngine.preparePatch({ operation: "patch", path: "matrix.txt", patch: { search: "original", replace: "mutated" } })
        const op = await coord.prepareOperation({
          runId,
          evidenceVersion: 1,
          kind: "MUTATION",
          authorityId: "mutation-engine",
          preconditions: [{ path: file, expectedHash: sha256("original\n"), exists: true }],
          expectedPostconditions: [{ path: file, expectedHash: sha256("mutated\n"), exists: true }],
          payload: { mutationId: prep.id },
        })
        await coord.operationJournal.recordStarted(op.operationId, runId)
        await coord.artifactStore.storePreimage(runId, op.operationId, file, Buffer.from("original\n", "utf8"))
        await mutationEngine.applyPreparedMutation(prep)
        await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

        const cand: RollbackCandidate = {
          mutationId: prep.id,
          operationId: op.operationId,
          path: file,
          beforeHash: sha256("original\n"),
          afterHash: sha256("mutated\n"),
          artifactAvailable: true,
          safeToRollback: true,
        }
        return { prep, op, cand }
      }

      // Matrix stages:
      // 1. journal read failure
      {
        const { cand } = await setupMutation("m-jread")
        let writes = 0
        const orig = mutationEngine.rollback.bind(mutationEngine)
        mutationEngine.rollback = async (...a) => { writes++; return orig(...a) }
        coord.operationJournal.setReadFileFnForTesting(async () => {
          const err = new Error("EIO: disk read fault")
          ;(err as any).code = "EIO"
          throw err
        })
        const res = await coord.recoveryController.rollbackManager.executeRollback("m-jread", cand)
        coord.operationJournal.setReadFileFnForTesting(undefined)
        mutationEngine.rollback = orig
        assert.strictEqual(writes, 0, "Journal read failure: reverse writes must be 0")
        assert.strictEqual(res.durabilityFailure, true)
      }

      // 2. PREPARED failure
      {
        const { cand } = await setupMutation("m-prep")
        let writes = 0
        const orig = mutationEngine.rollback.bind(mutationEngine)
        mutationEngine.rollback = async (...a) => { writes++; return orig(...a) }
        const origP = coord.operationJournal.recordPrepared.bind(coord.operationJournal)
        coord.operationJournal.recordPrepared = async (r) => { if (r.kind === "ROLLBACK_MUTATION") throw new Error("prep fail"); return origP(r) }
        const res = await coord.recoveryController.rollbackManager.executeRollback("m-prep", cand)
        coord.operationJournal.recordPrepared = origP
        mutationEngine.rollback = orig
        assert.strictEqual(writes, 0, "PREPARED failure: reverse writes must be 0")
        assert.strictEqual(res.durabilityFailure, true)
      }

      // 3. STARTED failure
      {
        const { cand } = await setupMutation("m-start")
        let writes = 0
        const orig = mutationEngine.rollback.bind(mutationEngine)
        mutationEngine.rollback = async (...a) => { writes++; return orig(...a) }
        const origS = coord.operationJournal.recordStarted.bind(coord.operationJournal)
        coord.operationJournal.recordStarted = async (id, r) => { if (id.startsWith("op_rb_")) throw new Error("start fail"); return origS(id, r) }
        const res = await coord.recoveryController.rollbackManager.executeRollback("m-start", cand)
        coord.operationJournal.recordStarted = origS
        mutationEngine.rollback = orig
        assert.strictEqual(writes, 0, "STARTED failure: reverse writes must be 0")
        assert.strictEqual(res.durabilityFailure, true)
      }

      // 4. COMPLETED persistence failure
      {
        const { cand } = await setupMutation("m-comp")
        let writes = 0
        const orig = mutationEngine.rollback.bind(mutationEngine)
        mutationEngine.rollback = async (...a) => { writes++; return orig(...a) }
        const origC = coord.operationJournal.recordCompleted.bind(coord.operationJournal)
        coord.operationJournal.recordCompleted = async (id, r, resId) => { if (id.startsWith("op_rb_")) throw new Error("comp fail"); return origC(id, r, resId) }
        const res = await coord.recoveryController.rollbackManager.executeRollback("m-comp", cand)
        coord.operationJournal.recordCompleted = origC
        mutationEngine.rollback = orig
        assert.strictEqual(writes, 1, "COMPLETED persistence failure: reverse writes must be 1")
        assert.strictEqual(res.success, false, "Normal success must be false")
        assert.strictEqual(res.recoveryRequired, true)
      }

      // 5. final checkpoint failure
      {
        const { cand } = await setupMutation("m-cp")
        let writes = 0
        const orig = mutationEngine.rollback.bind(mutationEngine)
        mutationEngine.rollback = async (...a) => { writes++; return orig(...a) }
        const origSave = coord.checkpointStore.saveCheckpoint.bind(coord.checkpointStore)
        coord.checkpointStore.saveCheckpoint = async (r) => { if (r.reason === "ROLLBACK_COMPLETED") throw new Error("cp fail"); return origSave(r) }
        const res = await coord.recoveryController.rollbackManager.executeRollback("m-cp", cand)
        coord.checkpointStore.saveCheckpoint = origSave
        mutationEngine.rollback = orig
        assert.strictEqual(writes, 1, "Final checkpoint failure: reverse writes must be 1")
        assert.strictEqual(res.success, false, "Normal success must be false")
        assert.strictEqual(res.recoveryRequired, true)
      }

      // 6. recordFailed failure
      {
        const { cand } = await setupMutation("m-recfail")
        const orig = mutationEngine.rollback.bind(mutationEngine)
        mutationEngine.rollback = async () => { throw new Error("mut fail") }
        const origF = coord.operationJournal.recordFailed.bind(coord.operationJournal)
        coord.operationJournal.recordFailed = async () => { throw new Error("rec fail") }
        const res = await coord.recoveryController.rollbackManager.executeRollback("m-recfail", cand)
        coord.operationJournal.recordFailed = origF
        mutationEngine.rollback = orig
        assert.strictEqual(res.recoveryRequired, true)
        assert.strictEqual(res.durabilityFailure, true)
        assert.ok(res.error?.startsWith("RECOVERY_PERSISTENCE_FAILED:"))
      }
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // T-5222: Checkpoint Failure Analytics
  // -------------------------------------------------------------------------
  test("T-5222: Checkpoint failure increments rollbackDurabilityFailures without falsely incrementing rollbackSuccesses", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "seal-analytics-"))
    try {
      const targetFile = join(wsDir, "an.txt")
      await writeFile(targetFile, "orig\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-an-fail"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "an.txt", patch: { search: "orig", replace: "mut" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256("orig\n"), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256("mut\n"), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from("orig\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand: RollbackCandidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash: sha256("orig\n"),
        afterHash: sha256("mut\n"),
        artifactAvailable: true,
        safeToRollback: true,
      }

      // Inject checkpointStore failure on final checkpoint
      const origSave = coord.checkpointStore.saveCheckpoint.bind(coord.checkpointStore)
      coord.checkpointStore.saveCheckpoint = async (r) => {
        if (r.reason === "ROLLBACK_COMPLETED") throw new Error("checkpoint store failure")
        return origSave(r)
      }

      await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      coord.checkpointStore.saveCheckpoint = origSave

      const metrics = coord.recoveryController.rollbackManager.metrics
      assert.strictEqual(metrics.rollbackAttempts, 1)
      assert.strictEqual(metrics.rollbackSuccesses, 0, "rollbackSuccesses must NOT count checkpoint failure as success")
      assert.strictEqual(metrics.rollbackDurabilityFailures, 1, "rollbackDurabilityFailures must increment")
      assert.strictEqual(metrics.rollbackFailures, 1, "rollbackFailures must increment")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })
})
