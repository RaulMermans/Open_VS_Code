/**
 * Sprint 7C — read-only recovery inspection for the editor's recovery view.
 * The inspection must classify truthfully through RecoveryController and leave
 * the journal and checkpoints byte-identical.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, stat } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CheckpointCoordinator } from "../../src/recovery/checkpoint-coordinator.ts"
import { inspectRunRecovery } from "../../src/recovery/recovery-inspection.ts"
import { resetProcessEpochId } from "../../src/recovery/process-epoch.ts"
import { MutationEngine, sha256 } from "../../src/tools/mutation-engine.ts"

async function workspace() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "ovsc-7c-inspect-")))
  await writeFile(join(root, "a.ts"), "export const a = 1\n")
  const coordinator = new CheckpointCoordinator({ workspaceRoot: root, mutationEngine: new MutationEngine(root) })
  return { root, coordinator, storage: join(root, ".open-vs-code", "recovery") }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(d: string): Promise<void> {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out[p] = createHash("sha256").update(await readFile(p)).digest("hex")
    }
  }
  await walk(dir)
  return out
}

async function recordMutation(coordinator: CheckpointCoordinator, root: string, runId: string, opts: { before: string; after: string; status: "STARTED" | "COMPLETED" }) {
  const path = join(root, "a.ts")
  const cp = await coordinator.checkpoint({ runId, reason: "BEFORE_MUTATION", phase: "EXECUTING", evidenceVersion: 1, runtimeState: { status: "RUNNING" }, touchedFilePaths: [path] })
  const journal = coordinator.operationJournal
  await journal.recordPrepared({
    schemaVersion: 1, operationId: `op-${runId}`, idempotencyKey: `idem-${runId}`, runId, processEpochId: cp.processEpochId,
    checkpointId: cp.checkpointId, evidenceVersion: 1, kind: "MUTATION", authorityId: "confirm-1", intentHash: "h",
    preconditions: [{ path, expectedHash: sha256(opts.before), exists: true }],
    expectedPostconditions: [{ path, expectedHash: sha256(opts.after), exists: true }],
  })
  await journal.recordStarted(`op-${runId}`, runId)
  if (opts.status === "COMPLETED") await journal.recordCompleted(`op-${runId}`, runId)
}

test("7C-R1: an unknown run is NO_RECORD and creates nothing on disk", async () => {
  const { root, storage } = await workspace()
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-123" })
  assert.equal(result.state, "NO_RECORD")
  assert.equal(result.executableResume, false)
  await assert.rejects(stat(storage), { code: "ENOENT" })
})

test("7C-R2: run ids that could traverse are refused before any filesystem access", async () => {
  const { root, storage } = await workspace()
  for (const runId of ["../x", "a/b", "..", ".hidden", "", "x".repeat(81), "a\\b", "run\u0000"]) {
    const result = await inspectRunRecovery({ workspaceRoot: root, runId })
    assert.equal(result.state, "UNREADABLE", runId)
    assert.deepEqual(result.reasons, ["INVALID_RUN_ID"])
  }
  await assert.rejects(stat(storage), { code: "ENOENT" })
})

test("7C-R3: an interrupted mutation observed as applied is REVERIFY, and inspection writes nothing", async () => {
  const { root, coordinator, storage } = await workspace()
  await recordMutation(coordinator, root, "session-r3", { before: "export const a = 0\n", after: "export const a = 1\n", status: "STARTED" })
  const before = await snapshot(storage)
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-r3" })
  assert.equal(result.state, "REVERIFY")
  assert.equal(result.disposition, "REVERIFY")
  assert.deepEqual(result.operations, [{ kind: "MUTATION", journalStatus: "STARTED", observedStatus: "RECONCILED_APPLIED", blocked: false, path: "a.ts" }])
  assert.deepEqual(result.files, ["a.ts"])
  assert.deepEqual(await snapshot(storage), before, "journal and checkpoints are byte-identical after inspection")

  // Negative comparator: the default (persisting) planner does append a reconciliation record.
  await coordinator.recoveryController.buildRecoveryPlan("session-r3")
  assert.notDeepEqual(await snapshot(storage), before)
})

test("7C-R4: a run waiting for approval in an earlier process is RECONFIRM, never resumable", async () => {
  const { root, coordinator } = await workspace()
  await coordinator.checkpoint({
    runId: "session-r4", reason: "BEFORE_PAUSE", phase: "WAITING", evidenceVersion: 1,
    runtimeState: { status: "WAITING_FOR_CONFIRMATION", pendingConfirmation: { callId: "c1", toolName: "write_file", action: "patch" } },
  })
  resetProcessEpochId()
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-r4" })
  assert.equal(result.state, "RECONFIRM")
  assert.equal(result.checkpoint?.awaitingApproval, true)
  assert.equal(result.checkpoint?.fromEarlierProcess, true)
  assert.equal(result.executableResume, false)
})

test("7C-R5: a completed run is COMPLETED", async () => {
  const { root, coordinator } = await workspace()
  await coordinator.checkpoint({ runId: "session-r5", reason: "COMPLETED", phase: "DONE", evidenceVersion: 1, runtimeState: { status: "COMPLETED" } })
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-r5" })
  assert.equal(result.state, "COMPLETED")
  assert.equal(result.manualInspectionRequired, false)
})

test("7C-R6: a file that diverged from both pre- and post-image requires manual inspection", async () => {
  const { root, coordinator } = await workspace()
  await recordMutation(coordinator, root, "session-r6", { before: "old\n", after: "new\n", status: "STARTED" })
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-r6" })
  assert.equal(result.state, "MANUAL_INSPECTION")
  assert.equal(result.manualInspectionRequired, true)
  assert.equal(result.operations[0]?.blocked, true)
})

test("7C-R7: a corrupt journal is UNREADABLE with a code only, not content", async () => {
  const { root, coordinator, storage } = await workspace()
  await recordMutation(coordinator, root, "session-r7", { before: "export const a = 0\n", after: "export const a = 1\n", status: "COMPLETED" })
  await writeFile(join(storage, "runs", "session-r7", "operations.jsonl"), "{not json secret=hunter2\n")
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-r7" })
  assert.equal(result.state, "UNREADABLE")
  assert.deepEqual(result.reasons, ["JOURNAL_CORRUPT"])
  assert.equal(result.manualInspectionRequired, true)
})

test("7C-R8: a runs directory symlinked outside the storage root is not read", async () => {
  const { root, storage } = await workspace()
  const outside = realpathSync(await mkdtemp(join(tmpdir(), "ovsc-7c-outside-")))
  await mkdir(join(outside, "session-r8"), { recursive: true })
  await writeFile(join(outside, "session-r8", "operations.jsonl"), "")
  await mkdir(storage, { recursive: true })
  await symlink(outside, join(storage, "runs"), "dir")
  const result = await inspectRunRecovery({ workspaceRoot: root, runId: "session-r8" })
  assert.ok(result.state === "UNREADABLE" || result.state === "NO_RECORD", result.state)
  assert.deepEqual(result.operations, [])
})
