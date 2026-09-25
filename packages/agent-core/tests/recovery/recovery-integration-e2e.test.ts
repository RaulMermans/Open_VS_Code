/**
 * Production Recovery Integration E2E Tests
 * Sprint 4C.1 — Invariants & AgentRunner.resumeFromRecovery
 */

import { describe, test } from "node:test"
import assert from "node:assert"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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

  test("AgentRunner live mutation and completion produces strict write-ahead checkpoint order", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-order-"))
    try {
      const targetFile = join(wsDir, "order.txt")
      await writeFile(targetFile, "first\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      const provider = new ScriptedModelProvider([
        { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "order.txt", search: "first", replace: "second" } }] },
        { model: "scripted", message: { role: "assistant", content: "Done" } },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createMutationToolRegistrations({ engine: mutationEngine })),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "runner-order-1"
      const res = await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "patch", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })
      assert.strictEqual(res.status, "PAUSED")

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "COMPLETED")

      // Inspect checkpoints
      const checkpoints = await coord.checkpointStore.listCheckpoints(runId)
      const reasons = checkpoints.map((c) => c.reason)
      assert.deepStrictEqual(reasons, ["RUN_STARTED", "BEFORE_MUTATION", "AFTER_MUTATION", "COMPLETED"])

      // Sequences must be strictly increasing
      const sequences = checkpoints.map((c) => c.sequence)
      assert.deepStrictEqual(sequences, [1, 2, 3, 4])
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("AgentRunner durability gate blocks mutation and fails closed with INTERNAL_ERROR if prepareOperation throws", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-dur-gate-"))
    try {
      const targetFile = join(wsDir, "fail_closed.txt")
      await writeFile(targetFile, "safe_data\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      coord.prepareOperation = async () => {
        throw new Error("Journal write failed: DURABILITY_UNAVAILABLE")
      }

      const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      const provider = new ScriptedModelProvider([
        { model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "fail_closed.txt", search: "safe_data", replace: "corrupted_data" } }] },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createMutationToolRegistrations({ engine: mutationEngine })),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "runner-dur-gate-1"
      await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "patch", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "FAILED")
      assert.strictEqual(resumeRes.failureReason, "INTERNAL_ERROR")

      // File on disk must remain uncorrupted and untouched
      const { readFile } = await import("node:fs/promises")
      const diskContent = await readFile(targetFile, "utf8")
      assert.strictEqual(diskContent, "safe_data\n")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5101/T-5102: RECOVERY_RECONCILED checkpoint failure stops resume fail closed with INTERNAL_ERROR", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-rec-fail-"))
    try {
      const runId = "runner-rec-fail-1"
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      await coord.checkpoint({
        runId,
        reason: "BEFORE_PAUSE",
        phase: "PLANNING",
        turnId: 1,
        evidenceVersion: 1,
        runtimeState: { status: "PLANNING" },
      })

      const origCheckpoint = coord.checkpoint.bind(coord)
      let checkpointAttempts = 0
      coord.checkpoint = async (params) => {
        checkpointAttempts++
        if (params.reason === "RECOVERY_RECONCILED") {
          throw new Error("Disk full: DURABILITY_UNAVAILABLE")
        }
        return origCheckpoint(params)
      }

      let modelCalled = false
      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "Should never run" },
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
        eventSink: (event) => {
          if (event.type === "model.completed") modelCalled = true
        },
      })

      const result = await runner.resumeFromRecovery(runId, { workspaceRoot: wsDir })
      assert.strictEqual(result.status, "FAILED")
      assert.strictEqual(result.failureReason, "INTERNAL_ERROR")
      assert.strictEqual(modelCalled, false, "Model calls must be 0")
      assert.ok(checkpointAttempts > 0, "Checkpoint attempt occurred")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5103: REVERIFY persistence failure blocks VerificationEngine start", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-reverify-fail-"))
    try {
      const runId = "runner-reverify-fail-1"
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      await coord.checkpoint({
        runId,
        reason: "BEFORE_VERIFICATION",
        phase: "VERIFYING",
        turnId: 1,
        evidenceVersion: 1,
        runtimeState: { status: "VERIFYING" },
      })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "VERIFICATION",
        authorityId: "verification-engine",
        preconditions: [],
        expectedPostconditions: [],
        payload: { executionId: "verif-int-1" },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)

      coord.checkpoint = async (params) => {
        if (params.reason === "RECOVERY_RECONCILED") {
          throw new Error("Persistence error")
        }
        return coord.checkpointStore.getLatestCheckpoint(runId) as any
      }

      let verificationStarted = false
      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([]),
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
        eventSink: (event) => {
          if (event.type === "verification.started") verificationStarted = true
        },
      })

      const res = await runner.resumeFromRecovery(runId, { workspaceRoot: wsDir })
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(res.failureReason, "INTERNAL_ERROR")
      assert.strictEqual(verificationStarted, false, "Verification must NOT start if recovery persistence fails")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5104: ASK_HUMAN fails closed with durability failure if recovery checkpoint persistence fails", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-askhuman-fail-"))
    try {
      const runId = "runner-askhuman-fail-1"
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      await coord.checkpoint({
        runId,
        reason: "BEFORE_PAUSE",
        phase: "PLANNING",
        turnId: 1,
        evidenceVersion: 1,
        runtimeState: {
          status: "WAITING_FOR_CONFIRMATION",
          pendingConfirmation: {
            callId: "call-1",
            toolName: "destructive_tool",
            action: "delete",
          },
        },
      })

      coord.checkpoint = async (params) => {
        if (params.reason === "RECOVERY_RECONCILED") {
          throw new Error("DURABILITY_UNAVAILABLE: Checkpoint disk corrupted")
        }
        return coord.checkpointStore.getLatestCheckpoint(runId) as any
      }

      const runner = new AgentRunner({
        provider: new ScriptedModelProvider([]),
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
      })

      const res = await runner.resumeFromRecovery(runId, { workspaceRoot: wsDir })
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(res.failureReason, "INTERNAL_ERROR")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5125: Critic CONTINUE decision cannot resume after recovery persistence failure", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-critic-fail-"))
    try {
      const runId = "runner-critic-fail-1"
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      await coord.checkpoint({
        runId,
        reason: "BEFORE_PAUSE",
        phase: "PLANNING",
        turnId: 1,
        evidenceVersion: 1,
        runtimeState: { status: "PLANNING" },
      })

      coord.checkpoint = async (params) => {
        if (params.reason === "RECOVERY_RECONCILED") {
          throw new Error("DURABILITY_UNAVAILABLE")
        }
        return coord.checkpointStore.getLatestCheckpoint(runId) as any
      }

      let modelCalled = false
      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "critic text" },
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: createReadOnlyToolRegistry(),
        checkpointCoordinator: coord,
        eventSink: (event) => {
          if (event.type === "model.completed") modelCalled = true
        },
      })

      const res = await runner.resumeFromRecovery(runId, { workspaceRoot: wsDir })
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(res.failureReason, "INTERNAL_ERROR")
      assert.strictEqual(modelCalled, false, "Model calls must be 0")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5105: Mutation failure + recordFailed failure stops execution immediately fail closed", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-mut-recfailed-"))
    try {
      const targetFile = join(wsDir, "data.txt")
      await writeFile(targetFile, "original\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      mutationEngine.applyPreparedMutation = async () => {
        throw new Error("Filesystem write fault")
      }

      coord.operationJournal.recordFailed = async () => {
        throw new Error("Journal write fault: DURABILITY_UNAVAILABLE")
      }

      const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "" },
          toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "data.txt", search: "original", replace: "updated" } }],
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createMutationToolRegistrations({ engine: mutationEngine })),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "run-mut-recfail-1"
      await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "patch", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "FAILED")
      assert.strictEqual(resumeRes.failureReason, "INTERNAL_ERROR")
      assert.strictEqual(await readFile(targetFile, "utf8"), "original\n")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5106: Verification failure + recordFailed failure stops execution immediately fail closed", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-verif-recfailed-"))
    try {
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      coord.operationJournal.recordFailed = async () => {
        throw new Error("Journal failure persistence failed")
      }

      const { createVerificationToolRegistrations } = await import("../../src/tools/verification-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      await writeFile(join(wsDir, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }), "utf8")

      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "" },
          toolCalls: [{ id: "c1", name: "run_verification", arguments: { action: "TEST" } }],
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createVerificationToolRegistrations(wsDir)),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "run-verif-recfail-1"
      await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "test", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "FAILED")
      assert.strictEqual(resumeRes.failureReason, "INTERNAL_ERROR")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5121: Mutation recordStarted failure blocks MutationEngine calls and fails closed", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-mut-recstarted-"))
    try {
      const targetFile = join(wsDir, "app.ts")
      await writeFile(targetFile, "const v = 1;\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      let mutationEngineCalls = 0
      const origApply = mutationEngine.applyPreparedMutation.bind(mutationEngine)
      mutationEngine.applyPreparedMutation = async (...args) => {
        mutationEngineCalls++
        return origApply(...args)
      }

      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      coord.operationJournal.recordStarted = async () => {
        throw new Error("Journal write failed on recordStarted")
      }

      const { createMutationToolRegistrations } = await import("../../src/tools/mutation-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "" },
          toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "app.ts", search: "1", replace: "2" } }],
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createMutationToolRegistrations({ engine: mutationEngine })),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "run-mut-recstart-1"
      await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "patch", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "FAILED")
      assert.strictEqual(resumeRes.failureReason, "INTERNAL_ERROR")
      assert.strictEqual(mutationEngineCalls, 0, "MutationEngine calls must be 0")
      assert.strictEqual(await readFile(targetFile, "utf8"), "const v = 1;\n")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5122: Verification recordStarted failure blocks VerificationEngine and fails closed", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-verif-recstarted-"))
    try {
      await writeFile(join(wsDir, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }), "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      coord.operationJournal.recordStarted = async () => {
        throw new Error("Journal recordStarted error")
      }

      const { createVerificationToolRegistrations } = await import("../../src/tools/verification-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "" },
          toolCalls: [{ id: "c1", name: "run_verification", arguments: { action: "TEST" } }],
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createVerificationToolRegistrations(wsDir)),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "run-verif-recstart-1"
      await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "verify", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "FAILED")
      assert.strictEqual(resumeRes.failureReason, "INTERNAL_ERROR")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5123: Rollback recordStarted failure blocks reverse MutationEngine call", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-rb-recstarted-"))
    try {
      const targetFile = join(wsDir, "state.txt")
      await writeFile(targetFile, "original\n", "utf8")
      const beforeHash = sha256("original\n")
      const afterHash = sha256("mutated\n")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-rb-recstart-1"

      const prep = await mutationEngine.preparePatch({
        operation: "patch",
        path: "state.txt",
        patch: { search: "original", replace: "mutated" },
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
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from("original\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      let reverseMutationCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseMutationCalls++
        return origRollback(...args)
      }

      const origRecordStarted = coord.operationJournal.recordStarted.bind(coord.operationJournal)
      coord.operationJournal.recordStarted = async (opId, rId) => {
        if (opId.startsWith("op_rb_")) {
          throw new Error("DURABILITY_UNAVAILABLE: Rollback start persistence failed")
        }
        return origRecordStarted(opId, rId)
      }

      const candidate = {
        mutationId: prep.id,
        operationId: op.operationId,
        path: targetFile,
        beforeHash,
        afterHash,
        artifactAvailable: true,
        safeToRollback: true,
      }

      const res = await coord.recoveryController.rollbackManager.executeRollback(runId, candidate)
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(reverseMutationCalls, 0, "Reverse mutation calls must be 0")
      assert.strictEqual(await readFile(targetFile, "utf8"), "mutated\n")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5110/T-5111/T-5112: Modify, create, delete rollback full journal lifecycle", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-rb-lifecycle-"))
    try {
      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // 1. Modify rollback lifecycle (T-5110)
      const file1 = join(wsDir, "mod.txt")
      await writeFile(file1, "A\n", "utf8")
      const prep1 = await mutationEngine.preparePatch({ operation: "patch", path: "mod.txt", patch: { search: "A", replace: "B" } })
      const op1 = await coord.prepareOperation({
        runId: "run-rb-mod",
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file1, expectedHash: sha256("A\n"), exists: true }],
        expectedPostconditions: [{ path: file1, expectedHash: sha256("B\n"), exists: true }],
        payload: { mutationId: prep1.id },
      })
      await coord.operationJournal.recordStarted(op1.operationId, "run-rb-mod")
      await coord.artifactStore.storePreimage("run-rb-mod", op1.operationId, file1, Buffer.from("A\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep1)
      await coord.operationJournal.recordCompleted(op1.operationId, "run-rb-mod", prep1.id)
      await coord.checkpoint({ runId: "run-rb-mod", reason: "AFTER_MUTATION", phase: "MUTATION", evidenceVersion: 1, runtimeState: { status: "OBSERVING" }, touchedFilePaths: [file1] })

      const cand1 = { mutationId: prep1.id, operationId: op1.operationId, path: file1, beforeHash: sha256("A\n"), afterHash: sha256("B\n"), artifactAvailable: true, safeToRollback: true }
      const res1 = await coord.recoveryController.rollbackManager.executeRollback("run-rb-mod", cand1)
      assert.strictEqual(res1.success, true)
      assert.strictEqual(res1.status, "ROLLED_BACK")
      assert.strictEqual(await readFile(file1, "utf8"), "A\n")

      const ops1 = await coord.operationJournal.getAllOperations("run-rb-mod")
      const rbOp1 = ops1.find((o) => o.kind === "ROLLBACK_MUTATION")
      assert.ok(rbOp1)
      assert.strictEqual(rbOp1?.status, "COMPLETED")

      // 2. Create rollback lifecycle (T-5111)
      const file2 = join(wsDir, "created.txt")
      const prep2 = await mutationEngine.prepareCreate({ operation: "create", path: "created.txt", content: "new_file\n" })
      const op2 = await coord.prepareOperation({
        runId: "run-rb-cr",
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file2, expectedHash: "", exists: false }],
        expectedPostconditions: [{ path: file2, expectedHash: sha256("new_file\n"), exists: true }],
        payload: { mutationId: prep2.id },
      })
      await coord.operationJournal.recordStarted(op2.operationId, "run-rb-cr")
      await mutationEngine.applyPreparedMutation(prep2)
      await coord.operationJournal.recordCompleted(op2.operationId, "run-rb-cr", prep2.id)

      const cand2 = { mutationId: prep2.id, operationId: op2.operationId, path: file2, beforeHash: "", afterHash: sha256("new_file\n"), artifactAvailable: true, safeToRollback: true }
      const res2 = await coord.recoveryController.rollbackManager.executeRollback("run-rb-cr", cand2)
      assert.strictEqual(res2.success, true)
      assert.strictEqual(res2.status, "ROLLED_BACK")
      const { access } = await import("node:fs/promises")
      let file2Exists = true
      try { await access(file2) } catch { file2Exists = false }
      assert.strictEqual(file2Exists, false, "Created file must be deleted on rollback")

      // 3. Delete rollback lifecycle (T-5112)
      const file3 = join(wsDir, "to_delete.txt")
      await writeFile(file3, "pre_delete\n", "utf8")
      const op3 = await coord.prepareOperation({
        runId: "run-rb-del",
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: file3, expectedHash: sha256("pre_delete\n"), exists: true }],
        expectedPostconditions: [{ path: file3, expectedHash: "", exists: false }],
        payload: { mutationId: "mut-del-1" },
      })
      await coord.operationJournal.recordStarted(op3.operationId, "run-rb-del")
      await coord.artifactStore.storePreimage("run-rb-del", op3.operationId, file3, Buffer.from("pre_delete\n", "utf8"))
      const { unlink } = await import("node:fs/promises")
      await unlink(file3)
      await coord.operationJournal.recordCompleted(op3.operationId, "run-rb-del", "mut-del-1")

      const cand3 = { mutationId: "mut-del-1", operationId: op3.operationId, path: file3, beforeHash: sha256("pre_delete\n"), afterHash: "", artifactAvailable: true, safeToRollback: true }
      const res3 = await coord.recoveryController.rollbackManager.executeRollback("run-rb-del", cand3)
      assert.strictEqual(res3.success, true)
      assert.strictEqual(res3.status, "ROLLED_BACK")
      assert.strictEqual(await readFile(file3, "utf8"), "pre_delete\n")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5113: Rollback PREPARED durability failure blocks reverse MutationEngine call", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-rb-dur-fail-"))
    try {
      const targetFile = join(wsDir, "locked.txt")
      await writeFile(targetFile, "state1\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-rb-dur-fail-1"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "locked.txt", patch: { search: "state1", replace: "state2" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256("state1\n"), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256("state2\n"), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from("state1\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const origRecordPrepared = coord.operationJournal.recordPrepared.bind(coord.operationJournal)
      coord.operationJournal.recordPrepared = async (opRecord) => {
        if (opRecord.kind === "ROLLBACK_MUTATION") {
          throw new Error("Journal write failed on PREPARED")
        }
        return origRecordPrepared(opRecord)
      }

      let reverseCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      const cand = { mutationId: prep.id, operationId: op.operationId, path: targetFile, beforeHash: sha256("state1\n"), afterHash: sha256("state2\n"), artifactAvailable: true, safeToRollback: true }
      const res = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(res.success, false)
      assert.strictEqual(res.status, "FAILED")
      assert.strictEqual(reverseCalls, 0, "MutationEngine reverse call must be 0")
      assert.strictEqual(await readFile(targetFile, "utf8"), "state2\n")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5118: Duplicate completed rollback suppression produces zero reverse MutationEngine calls", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "runner-rb-dup-"))
    try {
      const targetFile = join(wsDir, "dup.txt")
      await writeFile(targetFile, "A\n", "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const runId = "run-rb-dup-1"

      const prep = await mutationEngine.preparePatch({ operation: "patch", path: "dup.txt", patch: { search: "A", replace: "B" } })
      const op = await coord.prepareOperation({
        runId,
        evidenceVersion: 1,
        kind: "MUTATION",
        authorityId: "mutation-engine",
        preconditions: [{ path: targetFile, expectedHash: sha256("A\n"), exists: true }],
        expectedPostconditions: [{ path: targetFile, expectedHash: sha256("B\n"), exists: true }],
        payload: { mutationId: prep.id },
      })
      await coord.operationJournal.recordStarted(op.operationId, runId)
      await coord.artifactStore.storePreimage(runId, op.operationId, targetFile, Buffer.from("A\n", "utf8"))
      await mutationEngine.applyPreparedMutation(prep)
      await coord.operationJournal.recordCompleted(op.operationId, runId, prep.id)

      const cand = { mutationId: prep.id, operationId: op.operationId, path: targetFile, beforeHash: sha256("A\n"), afterHash: sha256("B\n"), artifactAvailable: true, safeToRollback: true }

      const res1 = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(res1.success, true)
      assert.strictEqual(res1.status, "ROLLED_BACK")

      let reverseCalls = 0
      const origRollback = mutationEngine.rollback.bind(mutationEngine)
      mutationEngine.rollback = async (...args) => {
        reverseCalls++
        return origRollback(...args)
      }

      const res2 = await coord.recoveryController.rollbackManager.executeRollback(runId, cand)
      assert.strictEqual(res2.success, true)
      assert.strictEqual(res2.status, "ROLLED_BACK")
      assert.strictEqual(reverseCalls, 0, "Duplicate rollback reverse mutation calls must be 0")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-5119/T-5120: Real AgentRunner verification durability and completion surviving restart", async () => {
    const wsDir = await realpath(await mkdtemp(join(tmpdir(), "runner-verif-dur-")))
    try {
      await writeFile(join(wsDir, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }), "utf8")

      const mutationEngine = new MutationEngine(wsDir)
      const coord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })
      const { createVerificationToolRegistrations } = await import("../../src/tools/verification-registry.ts")
      const { ToolRegistry } = await import("../../src/tools/registry.ts")

      const callOrder: string[] = []
      const origPrepareOp = coord.prepareOperation.bind(coord)
      coord.prepareOperation = async (params) => {
        if (params.kind === "VERIFICATION") callOrder.push("VERIFICATION_PREPARED")
        return origPrepareOp(params)
      }
      const origCheckpoint = coord.checkpoint.bind(coord)
      coord.checkpoint = async (params) => {
        callOrder.push(`CHECKPOINT_${params.reason}`)
        return origCheckpoint(params)
      }
      const origRecordStarted = coord.operationJournal.recordStarted.bind(coord.operationJournal)
      coord.operationJournal.recordStarted = async (opId, rId) => {
        callOrder.push("VERIFICATION_STARTED")
        return origRecordStarted(opId, rId)
      }
      const origRecordCompleted = coord.operationJournal.recordCompleted.bind(coord.operationJournal)
      coord.operationJournal.recordCompleted = async (opId, rId, ref) => {
        callOrder.push("VERIFICATION_COMPLETED")
        return origRecordCompleted(opId, rId, ref)
      }

      const provider = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "" },
          toolCalls: [{ id: "c1", name: "run_verification", arguments: { action: "TEST" } }],
        },
        {
          model: "scripted",
          message: { role: "assistant", content: "Verification finished" },
        },
      ])
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(createVerificationToolRegistrations(wsDir)),
        checkpointCoordinator: coord,
        permissionEvaluator: () => "CONFIRM",
      })

      const runId = "run-verif-dur-1"
      await runner.run({
        workspaceRoot: wsDir,
        task: { id: runId, instruction: "verify", mode: "BUILD" },
        maxTurns: 5,
        contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 1000, availableContext: 6000 },
        projectInstructions: [],
      })

      const resumeRes = await runner.resume("APPROVE")
      assert.strictEqual(resumeRes.status, "COMPLETED")

      assert.ok(callOrder.includes("VERIFICATION_PREPARED"))
      assert.ok(callOrder.includes("VERIFICATION_STARTED"))
      assert.ok(callOrder.includes("CHECKPOINT_BEFORE_VERIFICATION"))
      assert.ok(callOrder.includes("VERIFICATION_COMPLETED"))
      assert.ok(callOrder.includes("CHECKPOINT_AFTER_VERIFICATION"))

      const prepIdx = callOrder.indexOf("VERIFICATION_PREPARED")
      const startIdx = callOrder.indexOf("VERIFICATION_STARTED")
      const beforeCpIdx = callOrder.indexOf("CHECKPOINT_BEFORE_VERIFICATION")
      const compIdx = callOrder.indexOf("VERIFICATION_COMPLETED")
      const afterCpIdx = callOrder.indexOf("CHECKPOINT_AFTER_VERIFICATION")

      assert.ok(prepIdx < startIdx, "PREPARED before STARTED")
      assert.ok(startIdx < beforeCpIdx, "STARTED before BEFORE_VERIFICATION checkpoint")
      assert.ok(beforeCpIdx < compIdx, "BEFORE_VERIFICATION before COMPLETED")
      assert.ok(compIdx < afterCpIdx, "COMPLETED before AFTER_VERIFICATION checkpoint")

      // T-5120: Completed verification survives restart without being classified INTERRUPTED
      const newCoord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine: new MutationEngine(wsDir) })
      const plan = await newCoord.recoveryController.buildRecoveryPlan(runId)
      const verifOp = plan.reconciledOperations.find((o) => o.kind === "VERIFICATION")
      assert.ok(verifOp, "Verification operation must exist in reconciled operations")
      assert.strictEqual(verifOp?.reconciledStatus, "COMPLETED", "Completed verification must remain COMPLETED, not INTERRUPTED")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })
})
