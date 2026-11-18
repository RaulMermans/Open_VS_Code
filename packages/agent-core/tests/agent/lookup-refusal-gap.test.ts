import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })

test("a repeated lookup (ALREADY_OBSERVED) names the part of the request that is still missing (the tests)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-gap-"))
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/add.ts"), "export function add(left: number, right: number) {\n  return left - right\n}\n")
    const search: ToolRegistration = {
      definition: { name: "search_text", description: "Search text.", action: "read_repository", inputSchema: { type: "object" } },
      validate: (input) => ({ query: String((input as { query?: unknown }).query ?? "") }),
      execute: async () => ({ matches: [] }),
    }
    const patch = call("p1", "apply_patch", { path: "src/add.ts", search: "return left - right", replace: "return left + right" })
    const provider = new ScriptedModelProvider([patch, call("s1", "search_text", { query: "add" }), call("s2", "search_text", { query: "add" }), call("s3", "search_text", { query: "add" })])
    const agent = new AgentRunner({ provider, registry: new ToolRegistry([search, ...createMutationToolRegistrations({ engine: new MutationEngine(root) })]), eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    let result = await agent.run({ task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum, and add a unit test for it." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    for (let guard = 0; result.status === "PAUSED" && guard < 20; guard += 1) result = await agent.resume("APPROVE")
    const seen = JSON.stringify(provider.requests.at(-1))
    assert.match(seen, /ALREADY_OBSERVED: This lookup already ran.*Still missing from the request: .*test/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
