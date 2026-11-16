import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import type { AgentResult } from "../../src/contracts/agent.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })
const FILES = ["a", "b", "c", "d"]

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

const patch = (name: string) => ({ id: `p-${name}`, name: "apply_patch", arguments: { path: `src/${name}.ts`, search: "return 0", replace: "return 1" } })

async function run(script: ModelResponse[]): Promise<{ root: string; result: AgentResult }> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-step-"))
  await mkdir(join(root, "src"))
  for (const name of FILES) await writeFile(join(root, `src/${name}.ts`), `export function ${name}() {\n  return 0\n}\n`)
  const engine = new MutationEngine(root)
  const runner = new AgentRunner({
    provider: new ScriptedModelProvider(script),
    registry: new ToolRegistry([...createMutationToolRegistrations({ engine })]),
    mutationStep: engine,
    eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" },
  })
  let result = await runner.run({
    task: { id: "task", mode: "BUILD", instruction: "Change src/a.ts, src/b.ts, src/c.ts and src/d.ts so each function returns 1." },
    workspaceRoot: root,
    maxTurns: 12,
    contextBudget: budget,
    projectInstructions: [],
  })
  for (let guard = 0; result.status === "PAUSED" && guard < 12; guard += 1) result = await runner.resume("APPROVE")
  return { root, result }
}

test("a task can apply more than three files when they are written across model responses", async () => {
  const { root, result } = await run([...FILES.map((name) => response("", [patch(name)])), response("All four updated.")])
  try {
    for (const name of FILES) assert.match(await readFile(join(root, `src/${name}.ts`), "utf8"), /return 1/, name)
    assert.equal(result.toolCalls.filter((call) => call.name === "apply_patch" && call.outcome === "COMPLETED").length, 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
