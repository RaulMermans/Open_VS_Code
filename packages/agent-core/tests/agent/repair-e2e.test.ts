import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentRunner } from "../../src/agent/runner.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { VerificationEngine } from "../../src/tools/verification-engine.ts"
import { createVerificationToolRegistrations } from "../../src/tools/verification-registry.ts"
import { RepairOrchestrator } from "../../src/agent/repair-loop.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import type { AgentRunnerInput } from "../../src/agent/runner.ts"
import type { PreparedVerification } from "../../src/tools/verification-contracts.ts"

async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repair-e2e-"))
  const { realpath } = await import("node:fs/promises")
  return realpath(dir)
}

const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ModelResponse {
  return response("", [{ id, name, arguments: args }])
}

test("T-232 — Real-component one-attempt repair", async () => {
  const ws = await createTempWorkspace()
  try {
    // Setup fixture
    await writeFile(join(ws, "src.js"), "const x = 1;\nexport { x };", "utf8")
    const packageJson = JSON.stringify({ scripts: { test: "node test.js" } })
    await writeFile(join(ws, "package.json"), packageJson, "utf8")
    await writeFile(join(ws, "test.js"), "import { x } from './src.js'; if (x !== 2) { console.error('fail'); process.exit(1); }", "utf8")

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })
    
    const registry = new ToolRegistry([
      ...createMutationToolRegistrations({ engine: mutationEngine }),
      ...createVerificationToolRegistrations(ws)
    ])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", { path: "src.js", search: "const x = 1;", replace: "const x = 2;" }),
      makeToolCall("call-2", "run_verification", { action: "TEST" }),
      response("Fixed")
    ])

    const orchestrator = new RepairOrchestrator(
      { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
      verificationEngine,
      () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM", evidenceGate: false })
    )

    const input: AgentRunnerInput = { task: { id: "t-1", mode: "BUILD", instruction: "fix" }, workspaceRoot: ws, maxTurns: 10, contextBudget, projectInstructions: [] }

    // First we simulate the orchestrator starting with a failed test
    const preparedVerif = registry.prepare({ id: "v-1", name: "run_verification", arguments: { action: "TEST" } })
    const reviewableVerif = await preparedVerif.prepareForReview!({ workspaceRoot: ws, signal: new AbortController().signal })
    const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

    let res = await orchestrator.run(input, preparedVerification)
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")
    
    res = await orchestrator.resume("APPROVE") // runs test -> fails -> agent proposes patch
    assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")

    res = await orchestrator.resume("APPROVE") // applies patch -> agent proposes verif
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")

    res = await orchestrator.resume("APPROVE") // runs test -> passes
    assert.equal(res.status, "COMPLETED")
    
    // Assert real filesystem state
    const newSrc = await readFile(join(ws, "src.js"), "utf8")
    assert.equal(newSrc, "const x = 2;\nexport { x };")

    assert.equal(res.repairAttempts, 1)
    assert.equal(res.mutationsApplied, 1)
    assert.equal(res.verificationRuns, 2)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test("T-233 — Real-component stale mutation propagation", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "src.js"), "const x = 1;", "utf8")
    const packageJson = JSON.stringify({ scripts: { test: "node test.js" } })
    await writeFile(join(ws, "package.json"), packageJson, "utf8")
    await writeFile(join(ws, "test.js"), "process.exit(1);", "utf8")

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })
    
    const registry = new ToolRegistry([
      ...createMutationToolRegistrations({ engine: mutationEngine }),
      ...createVerificationToolRegistrations(ws)
    ])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", { path: "src.js", search: "const x = 1;", replace: "const x = 2;" })
    ])

    const orchestrator = new RepairOrchestrator(
      { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
      verificationEngine,
      () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM", evidenceGate: false })
    )

    const input: AgentRunnerInput = { task: { id: "t-1", mode: "BUILD", instruction: "fix" }, workspaceRoot: ws, maxTurns: 10, contextBudget, projectInstructions: [] }

    const preparedVerif = registry.prepare({ id: "v-1", name: "run_verification", arguments: { action: "TEST" } })
    const reviewableVerif = await preparedVerif.prepareForReview!({ workspaceRoot: ws, signal: new AbortController().signal })
    const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

    let res = await orchestrator.run(input, preparedVerification)
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")
    
    res = await orchestrator.resume("APPROVE") // runs test -> fails -> agent proposes patch
    assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")

    // Externally change target
    await writeFile(join(ws, "src.js"), "const x = 3;", "utf8")

    res = await orchestrator.resume("APPROVE") // applies patch -> fails (STALE_BASE)
    assert.equal(res.status, "STALE_BASE")

    // Assert actual filesystem state was not touched by patch
    const newSrc = await readFile(join(ws, "src.js"), "utf8")
    assert.equal(newSrc, "const x = 3;")

    assert.equal(res.mutationsApplied, 0)
    assert.equal(res.changedFiles.length, 0)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test("T-234 — Real-component stale verification propagation", async () => {
  const ws = await createTempWorkspace()
  try {
    const packageJson = JSON.stringify({ scripts: { test: "node test.js" } })
    await writeFile(join(ws, "package.json"), packageJson, "utf8")
    await writeFile(join(ws, "test.js"), "process.exit(1);", "utf8")

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })
    
    const registry = new ToolRegistry([
      ...createMutationToolRegistrations({ engine: mutationEngine }),
      ...createVerificationToolRegistrations(ws)
    ])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "run_verification", { action: "TEST" })
    ])

    const orchestrator = new RepairOrchestrator(
      { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
      verificationEngine,
      () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM", evidenceGate: false })
    )

    const input: AgentRunnerInput = { task: { id: "t-1", mode: "BUILD", instruction: "fix" }, workspaceRoot: ws, maxTurns: 10, contextBudget, projectInstructions: [] }

    const preparedVerif = registry.prepare({ id: "v-1", name: "run_verification", arguments: { action: "TEST" } })
    const reviewableVerif = await preparedVerif.prepareForReview!({ workspaceRoot: ws, signal: new AbortController().signal })
    const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

    let res = await orchestrator.run(input, preparedVerification)
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")

    // Externally change package.json
    await writeFile(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node other.js" } }), "utf8")
    
    res = await orchestrator.resume("APPROVE") // runs test -> STALE_VERIFICATION
    assert.equal(res.status, "STALE_VERIFICATION")
    
    // Original attempt shouldn't count as run
    assert.equal(res.verificationRuns, 0)

  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test("T-235 — Repair-level cancellation", async () => {
  const ws = await createTempWorkspace()
  try {
    const packageJson = JSON.stringify({ scripts: { test: "node test.js" } })
    await writeFile(join(ws, "package.json"), packageJson, "utf8")
    await writeFile(join(ws, "test.js"), "process.exit(1);", "utf8")

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })
    
    const registry = new ToolRegistry([
      ...createMutationToolRegistrations({ engine: mutationEngine }),
      ...createVerificationToolRegistrations(ws)
    ])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "run_verification", { action: "TEST" })
    ])

    const orchestrator = new RepairOrchestrator(
      { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
      verificationEngine,
      () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM", evidenceGate: false })
    )

    const abortController = new AbortController()
    const input: AgentRunnerInput = { task: { id: "t-1", mode: "BUILD", instruction: "fix" }, workspaceRoot: ws, maxTurns: 10, contextBudget, projectInstructions: [], signal: abortController.signal }

    const preparedVerif = registry.prepare({ id: "v-1", name: "run_verification", arguments: { action: "TEST" } })
    const reviewableVerif = await preparedVerif.prepareForReview!({ workspaceRoot: ws, signal: abortController.signal })
    const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

    let res = await orchestrator.run(input, preparedVerification)
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")
    
    // Cancel before resuming
    abortController.abort()

    res = await orchestrator.resume("APPROVE")
    assert.equal(res.status, "CANCELLED")

  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test("T-236 — Regression fixture", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "src.js"), "const a = 1; const b = 2;", "utf8")
    const packageJson = JSON.stringify({ scripts: { test: "node test.js" } })
    await writeFile(join(ws, "package.json"), packageJson, "utf8")
    await writeFile(join(ws, "test.js"), "import * as fs from 'node:fs'; const c = fs.readFileSync('./src.js', 'utf8'); if (!c.includes('const a = 2')) console.error('A fails'); if (!c.includes('const b = 2')) console.error('B fails'); process.exit(1);", "utf8")

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })
    
    const registry = new ToolRegistry([
      ...createMutationToolRegistrations({ engine: mutationEngine }),
      ...createVerificationToolRegistrations(ws)
    ])

    const provider2 = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", { path: "src.js", search: "const a = 1; const b = 2;", replace: "const a = 2; const b = 1;" }),
      makeToolCall("call-2", "run_verification", { action: "TEST" }),
    ])

    const orchestrator = new RepairOrchestrator(
      { maxRepairAttempts: 2, maxMutations: 3, maxVerificationRuns: 3, maxTotalAgentTurns: 10 },
      verificationEngine,
      () => new AgentRunner({ provider: provider2, registry, permissionEvaluator: () => "CONFIRM", evidenceGate: false })
    )

    const input: AgentRunnerInput = { task: { id: "t-1", mode: "BUILD", instruction: "fix" }, workspaceRoot: ws, maxTurns: 10, contextBudget, projectInstructions: [] }

    const preparedVerif = registry.prepare({ id: "v-1", name: "run_verification", arguments: { action: "TEST" } })
    const reviewableVerif = await preparedVerif.prepareForReview!({ workspaceRoot: ws, signal: new AbortController().signal })
    const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

    let res = await orchestrator.run(input, preparedVerification)
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")
    
    res = await orchestrator.resume("APPROVE") // runs test -> fails with 'A fails' -> agent proposes patch
    assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")

    res = await orchestrator.resume("APPROVE") // applies patch -> agent proposes verif
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")

    res = await orchestrator.resume("APPROVE") // runs test -> fails with 'B fails'. This is NOT non_progress because the output is different!
    // Since provider is empty after this, it will complete with "FAILED"
    assert.equal(res.status, "FAILED")
    assert.equal(res.failureReason, "MODEL_ERROR")
    
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test("T-238 — Real total-turn exhaustion E2E", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "src.js"), "const x = 1;", "utf8")
    const packageJson = JSON.stringify({ scripts: { test: "node test.js" } })
    await writeFile(join(ws, "package.json"), packageJson, "utf8")
    await writeFile(join(ws, "test.js"), "process.exit(1);", "utf8")

    const mutationEngine = new MutationEngine(ws)
    const verificationEngine = new VerificationEngine({ workspaceRoot: ws })
    
    const registry = new ToolRegistry([
      ...createMutationToolRegistrations({ engine: mutationEngine }),
      ...createVerificationToolRegistrations(ws)
    ])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", { path: "src.js", search: "const x = 1;", replace: "const x = 2;" }),
      makeToolCall("call-2", "apply_patch", { path: "src.js", search: "const x = 2;", replace: "const x = 3;" }),
      makeToolCall("call-3", "apply_patch", { path: "src.js", search: "const x = 3;", replace: "const x = 4;" })
    ])

    const orchestrator = new RepairOrchestrator(
      { maxRepairAttempts: 5, maxMutations: 5, maxVerificationRuns: 5, maxTotalAgentTurns: 2 }, // budget is 2
      verificationEngine,
      () => new AgentRunner({ provider, registry, permissionEvaluator: () => "CONFIRM", evidenceGate: false })
    )

    const input: AgentRunnerInput = { task: { id: "t-1", mode: "BUILD", instruction: "fix" }, workspaceRoot: ws, maxTurns: 10, contextBudget, projectInstructions: [] }

    const preparedVerif = registry.prepare({ id: "v-1", name: "run_verification", arguments: { action: "TEST" } })
    const reviewableVerif = await preparedVerif.prepareForReview!({ workspaceRoot: ws, signal: new AbortController().signal })
    const preparedVerification = reviewableVerif.reviewPayload as unknown as PreparedVerification

    let res = await orchestrator.run(input, preparedVerification) // this uses 0 turns
    assert.equal(res.status, "AWAITING_VERIFICATION_APPROVAL")
    
    res = await orchestrator.resume("APPROVE") // runs test -> fails -> agent starts, consumes 1 turn, proposes patch 1
    assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")
    assert.equal(res.totalAgentTurns, 1)
    
    res = await orchestrator.resume("APPROVE") // applies patch 1 -> agent resumes, takes turn 2 -> proposes patch 2
    assert.equal(res.status, "AWAITING_MUTATION_APPROVAL")
    assert.equal(res.totalAgentTurns, 2)
    
    res = await orchestrator.resume("APPROVE") // applies patch 2 -> agent resumes, but budget is 2, so runner returns MAX_TURNS_EXCEEDED
    assert.equal(res.status, "AGENT_TURN_BUDGET_EXCEEDED")

  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
