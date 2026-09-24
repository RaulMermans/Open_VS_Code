/**
 * Production Recovery Integration E2E Tests
 * Sprint 4C.1 — Invariants & AgentRunner.resumeFromRecovery
 */

import { describe, test } from "node:test"
import assert from "node:assert"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AgentRunner } from "../../src/agent/runner.ts"
import { CheckpointCoordinator } from "../../src/recovery/checkpoint-coordinator.ts"
import { MutationEngine, sha256 } from "../../src/tools/mutation-engine.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

describe("Sprint 4C.1 — Production Recovery Integration (E2E)", () => {
  test("AgentRunner writes write-ahead checkpoints during normal lifecycle", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-rec-int-"))
    try {
      await writeFile(join(wsDir, "index.ts"), "const initial = true;\n", "utf8")

      const provider = new ScriptedModelProvider([
        { model: "scripted", message: { role: "assistant", content: "I have read index.ts" } },
      ])
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runner = new AgentRunner({
        provider,
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
      })

      const runId = "runner-write-ahead-1"
      const result = await runner.run({
        workspaceRoot: wsDir,
        task: {
          id: runId,
          instruction: "Inspect the fixture",
          mode: "ASK",
        },
        maxTurns: 3,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      assert.strictEqual(result.status, "COMPLETED")

      // Verify that checkpoints were durably persisted to .agent/checkpoints/
      const latest = await coord.checkpointStore.getLatestCheckpoint(runId)
      assert.ok(latest, "A latest checkpoint must exist for the run")
      assert.strictEqual(latest?.reason, "COMPLETED")
      assert.ok((latest?.sequence ?? 0) >= 1, "Sequence number should be monotonic >= 1")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("AgentRunner.resumeFromRecovery pauses with WAITING_FOR_CONFIRMATION on RECONFIRM / ASK_HUMAN without side effects", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-reconfirm-"))
    try {
      const runId = "runner-reconfirm-1"
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // Seed a checkpoint indicating a pending destructive confirmation
      await coord.checkpoint({
        runId,
        reason: "BEFORE_PAUSE",
        phase: "WAITING_FOR_CONFIRMATION",
        evidenceVersion: 1,
        runtimeState: {
          status: "WAITING_FOR_CONFIRMATION",
          pendingConfirmation: {
            callId: "call-destructive-1",
            toolName: "execute_command",
            action: "destructive_disk",
          },
        },
      })

      const provider = new ScriptedModelProvider([])
      const runner = new AgentRunner({
        provider,
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
      })

      const result = await runner.resumeFromRecovery(runId, { workspaceRoot: wsDir })

      // Invariant: across epoch / recovery, pending confirmations are not auto-approved or replayed
      assert.strictEqual(result.status, "PAUSED")
      assert.strictEqual(result.confirmation?.callId, "call-destructive-1")
      assert.strictEqual(result.confirmation?.action, "destructive_disk")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("AgentRunner.resumeFromRecovery terminates cleanly on STOP disposition", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-stop-"))
    try {
      const runId = "runner-stop-1"
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // Checkpoint at COMPLETED
      await coord.checkpoint({
        runId,
        reason: "COMPLETED",
        phase: "COMPLETED",
        evidenceVersion: 1,
        runtimeState: {
          status: "COMPLETED",
        },
      })

      const provider = new ScriptedModelProvider([])
      const runner = new AgentRunner({
        provider,
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
      })

      const result = await runner.resumeFromRecovery(runId, { workspaceRoot: wsDir })
      assert.strictEqual(result.status, "COMPLETED")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("Write-ahead operation invariant: Intent -> Checkpoint -> Authority -> Outcome -> Checkpoint", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-intent-seq-"))
    try {
      const targetFile = join(wsDir, "calc.ts")
      await writeFile(targetFile, "export const add = (a, b) => a + b;\n", "utf8")
      const beforeHash = sha256("export const add = (a, b) => a + b;\n")
      const afterContent = "export const add = (a: number, b: number): number => a + b;\n"
      const afterHash = sha256(afterContent)

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-intent-invariant-1"

      // 1. Prepare intent
      const prep = await mutationEngine.preparePatch({
        operation: "patch",
        path: "calc.ts",
        patch: { search: "(a, b) => a + b", replace: "(a: number, b: number): number => a + b" },
      })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: beforeHash, exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: afterHash, exists: true }],
        payload: { mutationId: prep.id },
      })

      // 2. Journal intent & record before checkpoint
      await coord.operationJournal.recordStarted(op.operationId, runId)
      const cp1 = await coord.checkpoint({
        runId,
        reason: "BEFORE_MUTATION",
        phase: "EXECUTING_TOOL",
        evidenceVersion: 1,
        runtimeState: {
          status: "RUNNING",
        },
        touchedFilePaths: [targetFile],
      })

      // 3. Authority applies mutation
      const appliedSnapshot = await mutationEngine.applyPreparedMutation(prep)

      // 4. Journal records durable outcome & record after checkpoint
      await coord.operationJournal.recordCompleted(op.operationId, runId, appliedSnapshot.id)
      const cp2 = await coord.checkpoint({
        runId,
        reason: "AFTER_MUTATION",
        phase: "EXECUTING_TOOL",
        evidenceVersion: 2,
        runtimeState: {
          status: "RUNNING",
        },
        touchedFilePaths: [targetFile],
      })

      // Verify sequence monotonicity and checkpoint integrity
      assert.ok(cp2.sequence > cp1.sequence, "Sequence number must increase monotonically")
      const plan = await coord.recoveryController.buildRecoveryPlan(runId)
      assert.strictEqual(plan.reconciledOperations.length, 1)
      assert.strictEqual(plan.reconciledOperations[0]?.reconciledStatus, "RECONCILED_APPLIED")
      assert.strictEqual(plan.divergenceClass, "EXACT_MATCH")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })
})
