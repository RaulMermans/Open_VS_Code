import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ModelProviderError } from "../../src/model/openai-compatible.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })
const run = async (root: string, steps: ConstructorParameters<typeof ScriptedModelProvider>[0], instruction: string) => {
  const provider = new ScriptedModelProvider(steps)
  const registry = new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(root) })])
  const agent = new AgentRunner({ provider, registry, eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
  let result = await agent.run({ task: { id: "task", mode: "BUILD", instruction }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
  for (let guard = 0; result.status === "PAUSED" && guard < 10; guard += 1) result = await agent.resume("APPROVE")
  return { result, provider }
}

test("fault: the model provider times out after an approved write — the edit is kept and the failure is reported with its applied edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-fault-"))
  try {
    await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a - b\n")
    const { result } = await run(root, [
      call("p1", "apply_patch", { path: "add.ts", search: "a - b", replace: "a + b" }),
      new ModelProviderError("TIMEOUT", "Model request exceeded 180000ms"),
    ], "Fix add.ts so add returns the sum, and add a unit test for it.")
    assert.equal(result.failureReason, "MODEL_ERROR")
    assert.match(await readFile(join(root, "add.ts"), "utf8"), /a \+ b/, "the approved edit survives the provider failure")
    assert.equal(result.diagnostics?.failureReason, "MODEL_ERROR") // "recoverable" additionally needs a durable checkpoint (covered by tests/recovery)
    assert.ok((result.diagnostics?.appliedMutationIds.length ?? 0) >= 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fault: the file changed under the agent before its patch — the stale patch is refused and nothing is overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-fault-"))
  try {
    await writeFile(join(root, "add.ts"), "export const add = (a: number, b: number) => a - b\n")
    const external = "export const add = (a: number, b: number) => a * b // edited elsewhere\n"
    const provider: ConstructorParameters<typeof ScriptedModelProvider>[0] = [
      async () => { await writeFile(join(root, "add.ts"), external); return call("p1", "apply_patch", { path: "add.ts", search: "a - b", replace: "a + b" }) },
      { model: "scripted", message: { role: "assistant", content: "Could not apply the patch." } },
    ]
    const { result } = await run(root, provider, "Fix add.ts so add returns the sum.")
    assert.equal(await readFile(join(root, "add.ts"), "utf8"), external, "the external change was not overwritten")
    assert.notEqual(result.status, "COMPLETED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
