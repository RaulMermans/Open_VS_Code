import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"

// Sprint 33 P0: once Stop is acknowledged, no further tool may start.
const workspaceRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const contextBudget = calculateBudget({ contextWindow: 1_000, reservedOutput: 100, reservedToolHistory: 100 })
const task = { id: "cancel-1", mode: "BUILD" as const, instruction: "Inspect the fixture" }

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function counting(name: string, onExecute: () => void): ToolRegistration {
  return {
    definition: { name, description: "Count executions.", action: "read_repository", inputSchema: {} },
    validate: () => ({}),
    execute: async () => { onExecute(); return "ok" },
  }
}

test("Stop that lands while the model returns a tool batch starts none of the batch", async () => {
  const controller = new AbortController()
  let executions = 0
  const provider = new ScriptedModelProvider([
    () => {
      controller.abort()
      return response("tools", [{ id: "a", name: "probe", arguments: {} }, { id: "b", name: "probe", arguments: {} }])
    },
  ])
  const runner = new AgentRunner({ provider, registry: new ToolRegistry([counting("probe", () => { executions += 1 })]) })
  const result = await runner.run({ task, workspaceRoot, maxTurns: 5, contextBudget, projectInstructions: [], signal: controller.signal })
  assert.equal(result.status, "CANCELLED")
  assert.equal(executions, 0)
})

test("Stop during the first tool of a batch prevents the second from starting", async () => {
  const controller = new AbortController()
  let executions = 0
  const provider = new ScriptedModelProvider([
    response("tools", [{ id: "a", name: "probe", arguments: {} }, { id: "b", name: "probe", arguments: {} }]),
    response("should not be asked"),
  ])
  const registry = new ToolRegistry([counting("probe", () => { executions += 1; controller.abort() })])
  const runner = new AgentRunner({ provider, registry })
  const result = await runner.run({ task, workspaceRoot, maxTurns: 5, contextBudget, projectInstructions: [], signal: controller.signal })
  assert.equal(result.status, "CANCELLED")
  assert.equal(executions, 1)
})
