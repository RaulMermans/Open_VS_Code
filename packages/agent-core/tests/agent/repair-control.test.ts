import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { createVerificationToolRegistrations } from "../../src/tools/verification-registry.ts"

const budget = calculateBudget({ contextWindow: 16_000, reservedOutput: 1_000, reservedToolHistory: 1_000 })
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({
  model: "scripted",
  message: { role: "assistant", content: "" },
  toolCalls: [{ id, name, arguments: args }],
})

async function approve(agent: AgentRunner, workspaceRoot: string) {
  let result = await agent.run({
    task: { id: "repair", mode: "BUILD", instruction: "Make src.js export 2 so the test passes." },
    workspaceRoot,
    projectInstructions: [],
    maxTurns: 8,
    contextBudget: budget,
  })
  for (let guard = 0; result.status === "PAUSED" && guard < 8; guard += 1) result = await agent.resume("APPROVE")
  return result
}

test("scripted repair from a failed test applies one edit, reruns, and completes only when tests pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-repair-control-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.js" } }))
    await writeFile(join(root, "src.js"), "export const value = 1\n")
    await writeFile(join(root, "test.js"), "import { value } from './src.js'\nif (value !== 2) { console.log('AssertionError: expected 2'); console.log('FAIL  test.js > exports two'); process.exit(1) }\nconsole.log('ok')\n")
    const provider = new ScriptedModelProvider([
      call("v1", "run_verification", { action: "TEST" }),
      call("p1", "apply_patch", { path: "src.js", search: "export const value = 1", replace: "export const value = 2" }),
      call("v2", "run_verification", { action: "TEST" }),
      { model: "scripted", message: { role: "assistant", content: "The test passes." } },
    ])
    const agent = new AgentRunner({
      provider,
      registry: new ToolRegistry([
        ...createMutationToolRegistrations({ engine: new MutationEngine(root) }),
        ...createVerificationToolRegistrations(root),
      ]),
      eventFactory: { createId: () => "event", now: () => "2026-11-21T08:00:00.000Z" },
    })
    const result = await approve(agent, root)
    assert.match(JSON.stringify(provider.requests[1]), /AssertionError: expected 2/)
    assert.match(JSON.stringify(provider.requests[1]), /apply_patch/)
    assert.equal((await readFile(join(root, "src.js"), "utf8")).includes("value = 2"), true)
    assert.equal(result.toolCalls.filter((item) => item.name === "apply_patch" && item.outcome === "COMPLETED").length, 1)
    assert.equal(result.status, "COMPLETED")
    assert.equal(result.failureReason, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed test blocks a verified completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-repair-block-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.js" } }))
    await writeFile(join(root, "test.js"), "console.log('AssertionError: expected 2'); process.exit(1)\n")
    const provider = new ScriptedModelProvider([
      call("v1", "run_verification", { action: "TEST" }),
      { model: "scripted", message: { role: "assistant", content: "Done. Tests passed." } },
    ])
    const agent = new AgentRunner({
      provider,
      registry: new ToolRegistry([...createVerificationToolRegistrations(root)]),
      eventFactory: { createId: () => "event", now: () => "2026-11-21T08:00:00.000Z" },
    })
    const result = await approve(agent, root)
    assert.notEqual(result.status, "COMPLETED")
    assert.match(`${result.failureReason} ${result.finalAnswer}`, /VERIFICATION_FAILED|failed|not complete/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
