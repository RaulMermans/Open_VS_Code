import test from "node:test"
import assert from "node:assert/strict"

import { AgentRunner } from "../../src/agent/runner.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import { RepairOrchestrator } from "../../src/agent/repair-loop.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import type { AgentRunnerInput } from "../../src/agent/runner.ts"
import type { PreparedVerification } from "../../src/tools/verification-contracts.ts"

const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ModelResponse {
  return response("", [{ id, name, arguments: args }])
}

// Mock VerificationEngine
class MockVerificationEngine extends VerificationEngine {
  public executeResult: any = { status: "PASS", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 }
  public executeCalls: any[] = []

  constructor() {
    super({ workspaceRoot: "/test" })
  }

  async execute(prepared: any, _signal?: any) {
    this.executeCalls.push(prepared)
    if (typeof this.executeResult === "function") {
      return this.executeResult(prepared)
    }
    return this.executeResult
  }
}

// Mock ToolRegistry
class MockRegistry extends ToolRegistry {
  public prepareResult: any

  constructor(private verificationMode = false) {
    super([])
  }

  prepare(call: any): any {
    if (call.name === "apply_patch") {
      return {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        definition: { action: "write_file" },
        prepareForReview: async () => ({
          id: "mut-1",
          reviewPayload: { path: call.arguments.path } as any,
          apply: async () => ({ status: "APPLIED", id: "mut-1", path: call.arguments.path, operation: "patch", observation: "ok" })
        }),
        invoke: async () => "ok"
      }
    }
    if (call.name === "run_verification") {
      return {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        definition: { action: "run_known_test" },
        prepareForReview: async () => ({
          id: "verif-2",
          reviewPayload: { verificationId: "verif-2", action: "TEST" } as any,
          apply: async () => ({ status: "PASS", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 })
        }),
        invoke: async () => "ok"
      }
    }
    throw new Error("Unknown tool")
  }
}

test("T-205 — One-attempt E2E repair", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()

  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "apply_patch", { path: "test.txt", search: "a", replace: "b" }),
    makeToolCall("call-2", "run_verification", { action: "TEST" }),
    response("done")
  ])

  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }

  const preparedVerif = { verificationId: "verif-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  // First verification fails
  engine.executeResult = { status: "FAIL", exitCode: 1, stdout: "fail", stderr: "", durationMs: 10 }
  let res = await orchestrator.run(input, preparedVerif)
  assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")
  
  res = await orchestrator.resume("APPROVE") // runs verif -> fails -> starts agent -> agent proposes patch
  assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")

  // Agent will next propose verification. We need the next verif execution to pass
  engine.executeResult = { status: "PASS", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 }
  res = await orchestrator.resume("APPROVE") // applies patch -> runner resumes -> agent proposes verif
  assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")

  res = await orchestrator.resume("APPROVE") // runs verif -> passes
  assert.equal(res.status, "COMPLETED")
  assert.equal(res.repairAttempts, 1)
  assert.equal(res.mutationsApplied, 1)
  assert.equal(res.verificationRuns, 2)
})

test("T-206 — Two-attempt E2E repair", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()

  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "apply_patch", { path: "test.txt", search: "a", replace: "b" }),
    makeToolCall("call-2", "run_verification", { action: "TEST" }),
    // Second attempt
    makeToolCall("call-3", "apply_patch", { path: "test.txt", search: "b", replace: "c" }),
    makeToolCall("call-4", "run_verification", { action: "TEST" }),
    response("done")
  ])

  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 5, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }

  const preparedVerif = { verificationId: "verif-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  let res = await orchestrator.run(input, preparedVerif)
  
  engine.executeResult = (p: any) => p.verificationId === "verif-1" ? { status: "FAIL", exitCode: 1, stdout: "fail1", stderr: "", durationMs: 10 } : 
                         p.verificationId === "verif-2" && engine.executeCalls.length === 2 ? { status: "FAIL", exitCode: 1, stdout: "fail2", stderr: "", durationMs: 10 } :
                         { status: "PASS", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 }

  res = await orchestrator.resume("APPROVE") // verif 1 fail -> attempt 1 patch
  res = await orchestrator.resume("APPROVE") // patch 1 -> attempt 1 verif
  res = await orchestrator.resume("APPROVE") // verif 2 fail -> attempt 2 patch
  res = await orchestrator.resume("APPROVE") // patch 2 -> attempt 2 verif
  res = await orchestrator.resume("APPROVE") // verif 3 pass -> complete
  
  assert.equal(res.status, "COMPLETED")
  assert.equal(res.repairAttempts, 2)
  assert.equal(res.mutationsApplied, 2)
  assert.equal(res.verificationRuns, 3)
})

test("T-207 — Mutation rejection E2E", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()

  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "apply_patch", { path: "test.txt", search: "a", replace: "b" })
  ])

  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  engine.executeResult = { status: "FAIL", exitCode: 1, stdout: "fail", stderr: "", durationMs: 10 }
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE") // fails -> patch
  assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")

  res = await orchestrator.resume("REJECT")
  assert.equal(res.status, "REJECTED_BY_USER")
  assert.equal(res.mutationsApplied, 0)
})

test("T-208 — Verification rejection E2E", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider: new ScriptedModelProvider([]), registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  let res = await orchestrator.run(input, preparedVerif)
  assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")

  res = await orchestrator.resume("REJECT")
  assert.equal(res.status, "REJECTED_BY_USER")
  assert.equal(res.verificationRuns, 0)
})

test("T-211 — Repair attempt exhaustion", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "run_verification", { action: "TEST" }),
    makeToolCall("call-2", "run_verification", { action: "TEST" })
  ])

  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 10, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  engine.executeResult = (p: any) => ({ status: "FAIL", exitCode: 1, stdout: `fail-${p.verificationId}-${engine.executeCalls.length}`, stderr: "", durationMs: 10 })
  
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE") // v-1 fails -> attempt 1 verif
  res = await orchestrator.resume("APPROVE") // attempt 1 verif fails -> attempt 2 verif
  res = await orchestrator.resume("APPROVE") // attempt 2 verif fails -> exhaustion
  
  assert.equal(res.status, "REPAIR_ATTEMPTS_EXCEEDED")
})

test("T-212 — Mutation budget exhaustion", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "apply_patch", { path: "test.txt", search: "a", replace: "b" }),
    makeToolCall("call-2", "apply_patch", { path: "test.txt", search: "b", replace: "c" }),
    makeToolCall("call-3", "apply_patch", { path: "test.txt", search: "c", replace: "d" })
  ])

  // Max mutations: 2
  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 2, maxVerificationRuns: 5, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  engine.executeResult = { status: "FAIL", exitCode: 1, stdout: "fail", stderr: "", durationMs: 10 }
  
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE") // v-1 fails -> patch 1
  res = await orchestrator.resume("APPROVE") // patch 1 -> patch 2
  res = await orchestrator.resume("APPROVE") // patch 2 -> patch 3 -> budget exceeded
  
  assert.equal(res.status, "MUTATION_BUDGET_EXCEEDED")
})

test("T-213 — Verification budget exhaustion", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "run_verification", { action: "TEST" }),
    makeToolCall("call-2", "run_verification", { action: "TEST" })
  ])

  // Max verification: 2
  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 5, maxMutations: 5, maxVerificationRuns: 2, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  engine.executeResult = (_p: any) => ({ status: "FAIL", exitCode: 1, stdout: `fail-${engine.executeCalls.length}`, stderr: "", durationMs: 10 })
  
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE") // runs v-1 (1st verif) -> fails -> attempt 1 proposes verif
  res = await orchestrator.resume("APPROVE") // runs attempt 1 verif (2nd verif) -> fails -> attempt 2 proposes verif
  res = await orchestrator.resume("APPROVE") // tries to run attempt 2 verif (3rd verif) -> exceeds budget
  
  assert.equal(res.status, "VERIFICATION_BUDGET_EXCEEDED")
})

test("T-215 — Non-progress repair detection", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const provider = new ScriptedModelProvider([
    makeToolCall("call-1", "run_verification", { action: "TEST" }),
    makeToolCall("call-2", "run_verification", { action: "TEST" })
  ])

  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 5, maxMutations: 5, maxVerificationRuns: 5, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  // Deterministic failure output causes non-progress
  engine.executeResult = { status: "FAIL", exitCode: 1, stdout: "exact same failure", stderr: "", durationMs: 10 }
  
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE") // v-1 fails -> fingerprint recorded
  res = await orchestrator.resume("APPROVE") // attempt 1 verif fails -> fingerprint same -> non progress
  
  assert.equal(res.status, "REPAIR_NON_PROGRESS")
})

test("T-217 — Timeout in repair workflow", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider: new ScriptedModelProvider([]), registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  engine.executeResult = { status: "TIMEOUT", exitCode: null, stdout: "", stderr: "", durationMs: 1000 }
  
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE")
  
  assert.equal(res.status, "TIMEOUT")
})

test("T-218 — Execution error in repair workflow", async () => {
  const engine = new MockVerificationEngine()
  const registry = new MockRegistry()
  const orchestrator = new RepairOrchestrator(
    { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
    engine,
    () => new AgentRunner({ provider: new ScriptedModelProvider([]), registry, permissionEvaluator: () => "CONFIRM" })
  )

  const input: AgentRunnerInput = { task: { id: "t-1", mode: "PLAN", instruction: "fix" }, workspaceRoot: "/test", maxTurns: 10, contextBudget, projectInstructions: [] }
  const preparedVerif = { verificationId: "v-1", action: "TEST", executable: "node", args: [], cwd: "/test", timeoutMs: 1000, commandPreview: "node", packageJsonPath: "/test/package.json", packageJsonHash: "hash", scriptName: "test", scriptBody: "exit 1" } as PreparedVerification

  engine.executeResult = { status: "EXECUTION_ERROR", exitCode: null, stdout: "", stderr: "EACCES", durationMs: 10 }
  
  let res = await orchestrator.run(input, preparedVerif)
  res = await orchestrator.resume("APPROVE")
  
  assert.equal(res.status, "EXECUTION_ERROR")
})
