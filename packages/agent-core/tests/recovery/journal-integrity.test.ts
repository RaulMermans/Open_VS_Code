/**
 * Journal Integrity & Fail-Closed Durability Test Suite
 * Sprint 4D.2 — Tasks T-6200 through T-6207
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises"

import {
  OperationJournal,
  assertValidOperationRecord,
} from "../../src/recovery/operation-journal.ts"
import { RollbackManager } from "../../src/recovery/rollback.ts"
import { MutationEngine, sha256 } from "../../src/tools/mutation-engine.ts"
import { RecoveryArtifactStore } from "../../src/recovery/recovery-artifacts.ts"
import { CheckpointStore } from "../../src/recovery/checkpoint-store.ts"
import { RecoveryController } from "../../src/recovery/recovery-controller.ts"
import type { RecoveryOperation, RollbackCandidate } from "../../src/recovery/contracts.ts"

function createMockOperation(runId: string, operationId = "op-test-1"): RecoveryOperation {
  return {
    schemaVersion: 1,
    operationId,
    idempotencyKey: `idem-${operationId}`,
    runId,
    processEpochId: "epoch-1",
    checkpointId: "cp-1",
    evidenceVersion: 1,
    kind: "MUTATION",
    authorityId: "agent-1",
    intentHash: "hash-1",
    status: "PREPARED",
    preparedAt: new Date().toISOString(),
    preconditions: [],
    expectedPostconditions: [],
  }
}

describe("Sprint 4D.2 — Journal Read Integrity & Fail-Closed Durability (T-6200 .. T-6207)", () => {
  // -------------------------------------------------------------------------
  // T-6200 / T-6205: Journal Absence vs Journal Read Failure
  // -------------------------------------------------------------------------
  test("T-6200 / T-6205: Absent journal returns [] (valid empty history) without side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "journal-absent-"))
    try {
      const journal = new OperationJournal({ storageRoot: root })
      const ops = await journal.getAllOperations("non-existent-run")
      assert.deepEqual(ops, [], "Absent journal must return []")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("T-6200: Journal read failure (EACCES / EIO / EPERM) throws JOURNAL_READ_FAILURE and does NOT return []", async () => {
    const root = await mkdtemp(join(tmpdir(), "journal-fail-"))
    try {
      const eioError = new Error("EIO: i/o error on device")
      ;(eioError as any).code = "EIO"

      const journal = new OperationJournal({
        storageRoot: root,
        readFileFn: async () => {
          throw eioError
        },
      })

      await assert.rejects(
        async () => {
          await journal.getAllOperations("run-eio")
        },
        (err: any) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes("JOURNAL_READ_FAILURE"), "Must fail with JOURNAL_READ_FAILURE")
          assert.equal(err.cause, eioError)
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6201: Malformed Journal Line Fails Closed
  // -------------------------------------------------------------------------
  test("T-6201: Malformed non-empty JSON line throws JOURNAL_CORRUPT and does not skip line", async () => {
    const root = await mkdtemp(join(tmpdir(), "journal-corrupt-"))
    try {
      const runDir = join(root, "runs", "run-corrupt")
      await mkdir(runDir, { recursive: true })
      const journalFile = join(runDir, "operations.jsonl")

      const validOp = createMockOperation("run-corrupt", "op-valid-1")
      // Valid record followed by broken JSON syntax
      const content = `${JSON.stringify(validOp)}\n{ broken json syntax !!!\n`
      await writeFile(journalFile, content, "utf8")

      const journal = new OperationJournal({ storageRoot: root })
      await assert.rejects(
        async () => {
          await journal.getAllOperations("run-corrupt")
        },
        (err: any) => {
          assert.ok(err instanceof Error)
          assert.ok(err.message.includes("JOURNAL_CORRUPT"), "Must fail with JOURNAL_CORRUPT")
          assert.ok(err.message.includes("Malformed JSON line"))
          return true
        },
      )
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  test("T-6201: Blank trailing line or empty lines are tolerated", async () => {
    const root = await mkdtemp(join(tmpdir(), "journal-blank-"))
    try {
      const runDir = join(root, "runs", "run-blank")
      await mkdir(runDir, { recursive: true })
      const journalFile = join(runDir, "operations.jsonl")

      const validOp = createMockOperation("run-blank", "op-valid-1")
      const content = JSON.stringify(validOp) + "\n\n  \n"
      await writeFile(journalFile, content, "utf8")

      const journal = new OperationJournal({ storageRoot: root })
      const ops = await journal.getAllOperations("run-blank")
      assert.equal(ops.length, 1)
      assert.equal(ops[0]?.operationId, "op-valid-1")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6202: Journal Schema Validation
  // -------------------------------------------------------------------------
  test("T-6202: Schema validation rejects structurally invalid records", async () => {
    const runId = "run-schema"

    // Non-object
    assert.throws(() => assertValidOperationRecord(null, runId), /must be a non-null object/)
    assert.throws(() => assertValidOperationRecord("string", runId), /must be a non-null object/)

    // Missing operationId
    const base = createMockOperation(runId)
    assert.throws(
      () => assertValidOperationRecord({ ...base, operationId: "" }, runId),
      /Missing or invalid operationId/,
    )

    // Mismatched runId
    assert.throws(
      () => assertValidOperationRecord({ ...base, runId: "other-run" }, runId),
      /Mismatched or invalid runId/,
    )

    // Invalid status
    assert.throws(
      () => assertValidOperationRecord({ ...base, status: "NOT_A_STATUS" }, runId),
      /Invalid operation status/,
    )

    // Invalid kind
    assert.throws(
      () => assertValidOperationRecord({ ...base, kind: "NOT_A_KIND" }, runId),
      /Invalid operation kind/,
    )

    // Missing epoch or authority
    assert.throws(
      () => assertValidOperationRecord({ ...base, processEpochId: "" }, runId),
      /Missing or invalid processEpochId/,
    )
    assert.throws(
      () => assertValidOperationRecord({ ...base, authorityId: "" }, runId),
      /Missing or invalid authorityId/,
    )
  })

  // -------------------------------------------------------------------------
  // T-6203: Real Journal Read Failure E2E with RollbackManager
  // -------------------------------------------------------------------------
  test("T-6203: RollbackManager fails closed on EIO journal read with 0 reverse writes and 0 file changes", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "t6203-ws-"))
    try {
      const targetFile = join(wsDir, "app.ts")
      const originalContent = "const x = 1;\n"
      const mutatedContent = "const x = 2;\n"
      await writeFile(targetFile, mutatedContent, "utf8")

      let reverseMutationCalls = 0
      const mutationEngine = new MutationEngine(wsDir)
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseMutationCalls++
        return origRollback(...args)
      }

      const eioErr = new Error("EIO: hardware i/o failure on journal sector")
      ;(eioErr as any).code = "EIO"

      const journal = new OperationJournal({
        storageRoot: join(wsDir, ".checkpoints"),
        readFileFn: async () => {
          throw eioErr
        },
      })

      const artifactStore = new RecoveryArtifactStore({ storageRoot: join(wsDir, ".checkpoints", "artifacts") })
      const checkpointStore = new CheckpointStore({ storageRoot: join(wsDir, ".checkpoints") })

      const rollbackManager = new RollbackManager({
        mutationEngine,
        artifactStore,
        operationJournal: journal,
        checkpointStore,
      })

      const cand: RollbackCandidate = {
        mutationId: "mut-1",
        operationId: "op-1",
        path: targetFile,
        beforeHash: sha256(originalContent),
        afterHash: sha256(mutatedContent),
        artifactAvailable: true,
        safeToRollback: true,
      }

      const result = await rollbackManager.executeRollback("run-t6203", cand)

      assert.equal(result.success, false, "Rollback must fail")
      assert.equal(result.durabilityFailure, true, "Must flag durability failure")
      assert.ok(result.error?.includes("DURABILITY_UNAVAILABLE"), "Error must state durability unavailable")
      assert.equal(reverseMutationCalls, 0, "Reverse mutation calls must be exactly 0")

      const fileAfter = await readFile(targetFile, "utf8")
      assert.equal(fileAfter, mutatedContent, "Workspace file must remain untouched")
    } finally {
      await rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6204: Real Corrupt Journal E2E
  // -------------------------------------------------------------------------
  test("T-6204: Real corrupt journal prevents replay, recovery, and reverse mutation without partial read", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "t6204-ws-"))
    try {
      const storageRoot = join(wsDir, ".checkpoints")
      const journal = new OperationJournal({ storageRoot })

      // 1. Write one valid record
      const op1 = await journal.recordPrepared({
        schemaVersion: 1,
        operationId: "op-corrupt-1",
        idempotencyKey: "idem-1",
        runId: "run-corrupt-e2e",
        processEpochId: "epoch-1",
        checkpointId: "cp-1",
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "agent-1",
        intentHash: "intent-1",
        preconditions: [],
        expectedPostconditions: [],
      })
      assert.ok(op1)

      // 2. Corrupt the file by writing a malformed line
      const journalPath = join(storageRoot, "runs", "run-corrupt-e2e", "operations.jsonl")
      const raw = await readFile(journalPath, "utf8")
      await writeFile(journalPath, raw + "{ INVALID NON-JSON LINE }\n", "utf8")

      // 3. Re-open / restart journal in a fresh instance
      const freshJournal = new OperationJournal({ storageRoot })

      // getAllOperations must throw fail-closed
      await assert.rejects(
        async () => {
          await freshJournal.getAllOperations("run-corrupt-e2e")
        },
        /JOURNAL_CORRUPT/,
      )

      // RecoveryController using this fresh journal must fail closed
      const checkpointStore = new CheckpointStore({ storageRoot })
      const artifactStore = new RecoveryArtifactStore({ storageRoot: join(storageRoot, "artifacts") })
      const mutationEngine = new MutationEngine(wsDir)

      const controller = new RecoveryController({
        checkpointStore,
        operationJournal: freshJournal,
        artifactStore,
        mutationEngine,
      })

      await assert.rejects(
        async () => {
          await controller.buildRecoveryPlan("run-corrupt-e2e")
        },
        /JOURNAL_CORRUPT/,
      )
    } finally {
      await rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6206: Durable Write Regression (append + sync + close)
  // -------------------------------------------------------------------------
  test("T-6206: Durable write sync failure truncates file and fails closed before protected side effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6206-sync-"))
    try {
      let effectExecuted = false
      const syncError = new Error("EIO: disk controller write timeout during fsync")

      const journal = new OperationJournal({
        storageRoot: root,
        syncFn: async () => {
          throw syncError
        },
      })

      await assert.rejects(
        async () => {
          await journal.recordPrepared({
            schemaVersion: 1,
            operationId: "op-sync-fail",
            idempotencyKey: "idem-sync",
            runId: "run-sync-fail",
            processEpochId: "epoch-1",
            checkpointId: "cp-1",
            evidenceVersion: 1,
            kind: "MUTATION",
            authorityId: "agent-1",
            intentHash: "intent-1",
            preconditions: [],
            expectedPostconditions: [],
          })
          effectExecuted = true
        },
        (err) => err === syncError,
      )

      assert.equal(effectExecuted, false, "Protected side effect must not execute after sync failure")

      // File was truncated back to pre-append length (0 bytes)
      const journalFile = join(root, "runs", "run-sync-fail", "operations.jsonl")
      const content = await readFile(journalFile, "utf8").catch(() => "")
      assert.equal(content.trim(), "", "File must be truncated to 0 bytes on sync failure")
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6207: Secondary Index Remains Strictly Non-Authoritative
  // -------------------------------------------------------------------------
  test("T-6207: Secondary index purge safely rebuilds from authoritative journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6207-index-"))
    try {
      const journal = new OperationJournal({ storageRoot: root })

      await journal.recordPrepared({
        schemaVersion: 1,
        operationId: "op-auth-1",
        idempotencyKey: "idem-auth",
        runId: "run-auth-1",
        processEpochId: "epoch-1",
        checkpointId: "cp-1",
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "agent-1",
        intentHash: "intent-1",
        preconditions: [],
        expectedPostconditions: [],
      })

      // Corrupt/purge index cache
      journal.rebuildIndex("run-auth-1")

      // Lookup must re-read authoritative disk log and find operation
      const fetched = await journal.getOperation("run-auth-1", "op-auth-1")
      assert.ok(fetched)
      assert.equal(fetched.operationId, "op-auth-1")

      // If authoritative disk journal is corrupted: index CANNOT rescue it!
      const journalPath = join(root, "runs", "run-auth-1", "operations.jsonl")
      await writeFile(journalPath, "CORRUPT RAW BYTES\n", "utf8")

      journal.rebuildIndex("run-auth-1")
      await assert.rejects(
        async () => {
          await journal.getOperation("run-auth-1", "op-auth-1")
        },
        /JOURNAL_CORRUPT/,
      )
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
