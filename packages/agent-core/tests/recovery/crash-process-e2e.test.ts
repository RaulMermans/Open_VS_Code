/**
 * Crash Process Boundary E2E Test
 * Sprint 4C — T-4840 & T-4841: Mid-write and pre-write crash simulation across actual process boundary
 */

import { describe, test } from "node:test"
import assert from "node:assert"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fork } from "node:child_process"
import { CheckpointCoordinator } from "../../src/recovery/checkpoint-coordinator.js"
import { MutationEngine, sha256 } from "../../src/tools/mutation-engine.js"

const coordModuleUrl = new URL("../../src/recovery/checkpoint-coordinator.ts", import.meta.url).href
const mutationModuleUrl = new URL("../../src/tools/mutation-engine.ts", import.meta.url).href

describe("Sprint 4C — Real Process-Boundary Crash Tests (E2E)", () => {
  test("T-4840: Mid-write crash: Child crashes after writing file before recordCompleted -> Reconciles to RECONCILED_APPLIED without duplicate write", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "crash-mid-write-"))
    try {
      const targetFile = join(wsDir, "product.ts")
      await writeFile(targetFile, "export const version = 1\n", "utf8")
      const beforeHash = sha256("export const version = 1\n")
      const afterContent = "export const version = 2\n"
      const afterHash = sha256(afterContent)

      const runId = "run-crash-mid-1"

      // Worker script running in child process:
      // Prepares operation, mutates file through canonical MutationEngine, and immediately exits (crash simulation)
      const workerCode = `
        import { CheckpointCoordinator } from ${JSON.stringify(coordModuleUrl)};
        import { MutationEngine } from ${JSON.stringify(mutationModuleUrl)};

        const mutationEngine = new MutationEngine(${JSON.stringify(wsDir)});
        const coord = new CheckpointCoordinator({ workspaceRoot: ${JSON.stringify(wsDir)}, mutationEngine });
        const prep = await mutationEngine.preparePatch({
          operation: "patch",
          path: "product.ts",
          patch: { search: "version = 1", replace: "version = 2" },
        });
        const op = await coord.prepareOperation({
          runId: ${JSON.stringify(runId)},
          evidenceVersion: 1,
          kind: "MUTATION",
          authorityId: "mutation-engine",
          preconditions: [{ path: ${JSON.stringify(targetFile)}, expectedHash: ${JSON.stringify(beforeHash)}, exists: true }],
          expectedPostconditions: [{ path: ${JSON.stringify(targetFile)}, expectedHash: ${JSON.stringify(afterHash)}, exists: true }],
          payload: { mutationId: prep.id },
        });

        await coord.operationJournal.recordStarted(op.operationId, ${JSON.stringify(runId)});

        // File is mutated on disk via canonical MutationEngine
        await mutationEngine.applyPreparedMutation(prep);

        // PROCESS CRASHES ABRUPTLY BEFORE recordCompleted OR checkpoint
        process.exit(0);
      `


      // Execute child process
      await new Promise<void>((resolve, reject) => {
        const child = fork("-e", [workerCode], {
          stdio: "inherit",
          execArgv: ["--import", "tsx"],
        })
        child.on("exit", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Child exited with code ${code}`))
        })
      })

      // Child has crashed. Now Parent / Process 2 boots up in a new process epoch:
      const mutationEngine = new MutationEngine(wsDir)
      const parentCoord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      // Build recovery plan
      const plan = await parentCoord.recoveryController.buildRecoveryPlan(runId)

      assert.strictEqual(plan.reconciledOperations.length, 1)
      const rec = plan.reconciledOperations[0]!
      assert.strictEqual(rec.reconciledStatus, "RECONCILED_APPLIED", "Must observe and deduce mutation was already applied on disk")
      assert.strictEqual(rec.writeReplayCount, 0, "Must NEVER replay an already-applied write (replay count = 0)")

      // Verification of file content on disk: untouched since child crashed
      const currentDiskContent = await readFile(targetFile, "utf8")
      assert.strictEqual(currentDiskContent, afterContent)
      assert.strictEqual(plan.divergenceClass, "EXACT_MATCH")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("T-4841: Pre-write crash: Child prepares operation but crashes before writing file -> Reconciles to RECONCILED_NOT_APPLIED", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "crash-pre-write-"))
    try {
      const targetFile = join(wsDir, "config.json")
      const originalContent = '{"enabled": false}\n'
      await writeFile(targetFile, originalContent, "utf8")
      const beforeHash = sha256(originalContent)
      const afterContent = '{"enabled": true}\n'
      const afterHash = sha256(afterContent)

      const runId = "run-crash-pre-1"

      const workerCode = `
        import { CheckpointCoordinator } from ${JSON.stringify(coordModuleUrl)};

        const coord = new CheckpointCoordinator({ workspaceRoot: ${JSON.stringify(wsDir)} });
        const op = await coord.prepareOperation({
          runId: ${JSON.stringify(runId)},
          evidenceVersion: 1,
          kind: "MUTATION",
          authorityId: "mutation-engine",
          preconditions: [{ path: ${JSON.stringify(targetFile)}, expectedHash: ${JSON.stringify(beforeHash)}, exists: true }],
          expectedPostconditions: [{ path: ${JSON.stringify(targetFile)}, expectedHash: ${JSON.stringify(afterHash)}, exists: true }],
        });

        // CRASH BEFORE WRITING FILE TO DISK
        process.exit(0);
      `

      await new Promise<void>((resolve, reject) => {
        const child = fork("-e", [workerCode], {
          stdio: "inherit",
          execArgv: ["--import", "tsx"],
        })
        child.on("exit", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Child exited with code ${code}`))
        })
      })

      // Parent boots up in new epoch
      const mutationEngine = new MutationEngine(wsDir)
      const parentCoord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      const plan = await parentCoord.recoveryController.buildRecoveryPlan(runId)

      assert.strictEqual(plan.reconciledOperations.length, 1)
      const rec = plan.reconciledOperations[0]!
      assert.strictEqual(rec.reconciledStatus, "RECONCILED_NOT_APPLIED", "Must truthfully detect disk was not modified")

      const diskContent = await readFile(targetFile, "utf8")
      assert.strictEqual(diskContent, originalContent, "Disk content remains original")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("Cross-process epoch invalidates approvals across process restarts", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "crash-approval-"))
    try {
      const runId = "run-approval-restart"

      const workerCode = `
        import { CheckpointCoordinator } from ${JSON.stringify(coordModuleUrl)};

        const coord = new CheckpointCoordinator({ workspaceRoot: ${JSON.stringify(wsDir)} });
        await coord.checkpoint({
          runId: ${JSON.stringify(runId)},
          reason: "BEFORE_PAUSE",
          phase: "WAITING_FOR_CONFIRMATION",
          evidenceVersion: 1,
          runtimeState: {
            status: "WAITING_FOR_CONFIRMATION",
            pendingConfirmation: {
              callId: "call-sec-99",
              toolName: "execute_command",
              action: "rm -rf /",
            },
          },
        });

        process.exit(0);
      `

      await new Promise<void>((resolve, reject) => {
        const child = fork("-e", [workerCode], {
          stdio: "inherit",
          execArgv: ["--import", "tsx"],
        })
        child.on("exit", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Child exited with code ${code}`))
        })
      })

      // In Process 2 (current process): epoch is naturally different from child's epoch
      const mutationEngine = new MutationEngine(wsDir)
      const parentCoord = new CheckpointCoordinator({ workspaceRoot: wsDir, mutationEngine })

      const plan = await parentCoord.recoveryController.buildRecoveryPlan(runId)
      assert.strictEqual(plan.disposition, "RECONFIRM")
      assert.ok(plan.requiredApprovals.includes("NEW_EPOCH_AUTHORITY_REQUIRED"), "Must require re-approval across epoch")
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })
})
