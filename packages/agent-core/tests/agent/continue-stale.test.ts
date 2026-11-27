import assert from "node:assert/strict"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { CheckpointCoordinator } from "../../src/recovery/checkpoint-coordinator.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

// Sprint 33 P0: a pause before the agent's first write must still protect files it read.
const contextBudget = calculateBudget({ contextWindow: 1_000, reservedOutput: 100, reservedToolHistory: 100 })
const task = { id: "stale-1", mode: "BUILD" as const, instruction: "Inspect src/a.ts" }

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "continue-stale-"))
  await writeFile(join(dir, "a.ts"), "export const a = 1\n")
  await writeFile(join(dir, "b.ts"), "export const b = 2\n")
  return dir
}

function runner(provider: ScriptedModelProvider, checkpointCoordinator?: CheckpointCoordinator): AgentRunner {
  return new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), ...(checkpointCoordinator ? { checkpointCoordinator } : {}) })
}

const readA = () => response("read", [{ id: "r1", name: "read_file", arguments: { path: "a.ts" } }])

async function pausedAfterRead(dir: string, after: ModelResponse[] = [], coordinator?: CheckpointCoordinator) {
  const provider = new ScriptedModelProvider([readA(), ...after])
  const r = runner(provider, coordinator)
  const paused = await r.run({ task, workspaceRoot: dir, maxTurns: 1, contextBudget, projectInstructions: [] })
  assert.equal(paused.failureReason, "MAX_TURNS_EXCEEDED")
  return r
}

test("in-process Continue stops when a file the agent only read changed during the pause", async () => {
  const dir = await workspace()
  try {
    const r = await pausedAfterRead(dir)
    await writeFile(join(dir, "a.ts"), "export const a = 1\nexport const USER = true\n")
    const result = await r.continueFromLimit(2)
    assert.equal(result.status, "FAILED")
    assert.match(result.finalAnswer ?? "", /changed since.*a\.ts/s)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("in-process Continue stops when a read file was deleted during the pause", async () => {
  const dir = await workspace()
  try {
    const r = await pausedAfterRead(dir)
    await unlink(join(dir, "a.ts"))
    const result = await r.continueFromLimit(2)
    assert.equal(result.status, "FAILED")
    assert.match(result.finalAnswer ?? "", /a\.ts/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("in-process Continue proceeds when only an unrelated file changed", async () => {
  const dir = await workspace()
  try {
    const r = await pausedAfterRead(dir, [response("Done."), response("Done.")])
    await writeFile(join(dir, "b.ts"), "export const b = 3\n")
    const result = await r.continueFromLimit(2)
    assert.equal(result.status, "COMPLETED")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Continue after restart blocks when a file the agent only read changed", async () => {
  const dir = await workspace()
  try {
    const coordinator = () => new CheckpointCoordinator({ workspaceRoot: dir, mutationEngine: new MutationEngine(dir) })
    await pausedAfterRead(dir, [], coordinator())
    await writeFile(join(dir, "a.ts"), "export const a = 1\nexport const USER = true\n")
    const fresh = runner(new ScriptedModelProvider([]), coordinator())
    const result = await fresh.resumeFromRecovery(task.id, { workspaceRoot: dir, instruction: task.instruction })
    assert.equal(result.status, "FAILED")
    assert.equal(result.recoveryPlan?.divergenceClass, "BLOCKED_DIVERGENCE")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
