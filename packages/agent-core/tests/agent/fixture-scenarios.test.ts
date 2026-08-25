import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider, type ScriptedModelStep } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

const fixtures = join(import.meta.dirname, "..", "fixtures", "agent-scenarios")
const contextBudget = calculateBudget({ contextWindow: 2_000, reservedOutput: 200, reservedToolHistory: 200 })

function tool(name: string, argumentsValue: unknown, id = name): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content: `Inspect with ${name}` }, toolCalls: [{ id, name, arguments: argumentsValue }] }
}

function grounded(patterns: readonly RegExp[], answer: string): (request: ModelRequest) => ModelResponse {
  return (request) => {
    for (const pattern of patterns) assert.match(request.messages[0]!.content, pattern)
    return { model: "scripted", message: { role: "assistant", content: answer } }
  }
}

async function runScenario(name: string, instruction: string, steps: readonly ScriptedModelStep[]) {
  const runner = new AgentRunner({ provider: new ScriptedModelProvider(steps), registry: createReadOnlyToolRegistry() })
  return runner.run({
    task: { id: name, mode: "ASK", instruction },
    workspaceRoot: join(fixtures, name),
    maxTurns: 6,
    contextBudget,
    projectInstructions: [],
  })
}

test("finds authentication implementation and explains the observed flow", async () => {
  const result = await runScenario("auth-flow", "Find where authentication is implemented and explain the flow.", [
    tool("search_text", { query: "authenticate" }, "auth-search"),
    tool("read_file", { path: "src/auth.ts" }, "auth-read"),
    tool("read_file", { path: "src/middleware.ts" }, "middleware-read"),
    grounded([/token ===/, /header\?\.replace/], "authorize extracts the bearer token and authenticate checks it against the local token."),
  ])

  assert.equal(result.status, "COMPLETED", JSON.stringify({ reason: result.failureReason, events: result.events.map((event) => event.type) }))
  assert.match(result.finalAnswer!, /bearer token/)
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["search_text", "read_file", "read_file"])
})

test("diagnoses the fixture failure from the test and implementation", async () => {
  const result = await runScenario("failing-test", "Explain why this fixture test is likely failing.", [
    tool("find_files", { pattern: "**/*.case.ts" }, "test-find"),
    tool("read_file", { path: "tests/math.case.ts" }, "test-read"),
    tool("read_file", { path: "src/math.ts" }, "implementation-read"),
    grounded([/sum\(1, 2\) !== 4/, /return left \+ right/], "The implementation correctly returns 3; the test incorrectly expects 4."),
  ])

  assert.equal(result.status, "COMPLETED")
  assert.match(result.finalAnswer!, /incorrectly expects 4/)
})

test("summarizes a tiny repository only after listing and reading it", async () => {
  const result = await runScenario("tiny-repository", "Summarize this tiny repository.", [
    tool("list_directory", {}, "root-list"),
    tool("read_file", { path: "README.md" }, "readme-read"),
    tool("read_file", { path: "src/index.ts" }, "source-read"),
    grounded([/minimal greeting library/, /Hello, \$\{name\}!/], "This is a minimal TypeScript greeting library exporting greet(name)."),
  ])

  assert.equal(result.status, "COMPLETED")
  assert.match(result.finalAnswer!, /greeting library/)
})
