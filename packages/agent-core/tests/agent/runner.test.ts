import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner, AgentRunnerError } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"

const workspaceRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const contextBudget = calculateBudget({ contextWindow: 1_000, reservedOutput: 100, reservedToolHistory: 100 })
const task = { id: "task-1", mode: "BUILD" as const, instruction: "Inspect the fixture" }

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function createRunner(provider: ScriptedModelProvider, registry = createReadOnlyToolRegistry(), threshold = 3): AgentRunner {
  let event = 0
  return new AgentRunner({
    provider,
    registry,
    nonProgressThreshold: threshold,
    eventFactory: { createId: () => `event-${++event}`, now: () => "2026-08-18T12:00:00.000Z" },
  })
}

function input(overrides: Partial<Parameters<AgentRunner["run"]>[0]> = {}): Parameters<AgentRunner["run"]>[0] {
  return { task, workspaceRoot, maxTurns: 5, contextBudget, projectInstructions: [], ...overrides }
}

test("completes a direct answer with a deterministic compact trace", async () => {
  const runner = createRunner(new ScriptedModelProvider([response("The answer")]))
  const result = await runner.run(input())

  assert.equal(result.status, "COMPLETED")
  assert.equal(result.finalAnswer, "The answer")
  assert.equal(result.turns, 1)
  assert.deepEqual(result.events.map((event) => event.type), [
    "task.started", "context.compiled", "model.requested", "model.completed", "runtime_eval.started", "runtime_eval.completed", "task.completed",
  ])
  assert.deepEqual(result.toolCalls, [])
  await assert.rejects(runner.resume("APPROVE"), (error: unknown) => (error as AgentRunnerError).code === "TERMINAL_STATE")
})

test("executes multiple validated read-only tool turns and recompiles observations", async () => {
  const provider = new ScriptedModelProvider([
    response("search", [{ id: "search-1", name: "search_text", arguments: { query: "greet" } }]),
    response("read", [{ id: "read-1", name: "read_file", arguments: { path: "src/index.ts" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /observation.*read_file/s)
      assert.match(request.messages[0]!.content, /export function greet/)
      return response("The fixture exports greet.")
    },
  ])
  const result = await createRunner(provider).run(input())

  assert.equal(result.status, "COMPLETED")
  assert.equal(result.turns, 3)
  assert.deepEqual(result.toolCalls.map((call) => [call.name, call.outcome]), [["search_text", "COMPLETED"], ["read_file", "COMPLETED"]])
  assert.equal(result.contextDiagnostics.length, 3)
  assert.deepEqual(result.events.map((event) => event.type), [
    "task.started", "context.compiled", "model.requested", "model.completed", "tool.requested", "tool.completed",
    "context.compiled", "model.requested", "model.completed", "tool.requested", "tool.completed",
    "context.compiled", "model.requested", "model.completed", "runtime_eval.started", "runtime_eval.completed", "task.completed",
  ])
  const exposed = provider.requests[0]!.metadata?.tools as readonly { name: string }[]
  assert.deepEqual(exposed.map((tool) => tool.name), ["find_files", "list_directory", "read_file", "search_text"])
})

test("turns unknown and invalid calls into observations without executing a tool", async () => {
  const executions: unknown[] = []
  const registration: ToolRegistration = {
    definition: { name: "strict", description: "Accept one string.", action: "read_repository", inputSchema: {} },
    validate: (argumentsValue) => {
      if (!argumentsValue || typeof argumentsValue !== "object" || typeof (argumentsValue as Record<string, unknown>).value !== "string") {
        throw new TypeError("value must be a string")
      }
      return argumentsValue as Record<string, unknown>
    },
    execute: async (argumentsValue) => { executions.push(argumentsValue); return "unexpected" },
  }
  const provider = new ScriptedModelProvider([
    response("unknown", [{ id: "bad-1", name: "missing", arguments: {} }]),
    response("invalid", [{ id: "bad-2", name: "strict", arguments: { value: 1 } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /INVALID_ARGUMENTS/)
      return response("Recovered")
    },
  ])
  const result = await createRunner(provider, new ToolRegistry([registration])).run(input())

  assert.equal(result.status, "COMPLETED")
  assert.deepEqual(executions, [])
  assert.deepEqual(result.toolCalls.map((call) => call.outcome), ["REJECTED", "REJECTED"])
})

test("pauses for confirmation, executes only after approval, and resumes", async () => {
  let executions = 0
  const registration: ToolRegistration = {
    definition: { name: "inspect_sensitive", description: "Inspect synthetic data.", action: "git_commit", inputSchema: {} },
    validate: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new TypeError("no arguments expected")
      return {}
    },
    execute: async () => { executions += 1; return "approved evidence" },
  }
  const provider = new ScriptedModelProvider([
    response("need approval", [{ id: "confirm-1", name: "inspect_sensitive", arguments: {} }]),
    response("Approved result")
  ])
  const runner = createRunner(provider, new ToolRegistry([registration]))
  const paused = await runner.run(input())

  assert.equal(paused.status, "PAUSED")
  assert.equal(paused.confirmation?.toolName, "inspect_sensitive")
  assert.equal(executions, 0)
  const completed = await runner.resume("APPROVE")
  assert.equal(completed.status, "COMPLETED")
  assert.equal(completed.finalAnswer, "Approved result")
  assert.equal(executions, 1)
  assert.deepEqual(completed.events.map((event) => event.type).slice(4, 8), [
    "permission.requested", "permission.approved", "tool.requested", "tool.completed",
  ])
})

test("confirmation rejection never executes and returns a model-visible denial", async () => {
  let executions = 0
  const registration: ToolRegistration = {
    definition: { name: "confirm_tool", description: "Synthetic confirmation.", action: "run_known_test", inputSchema: {} },
    validate: () => ({}),
    execute: async () => { executions += 1 },
  }
  const provider = new ScriptedModelProvider([
    response("need approval", [{ id: "confirm-2", name: "confirm_tool", arguments: {} }]),
    (request) => {
      assert.match(request.messages[0]!.content, /PERMISSION_REJECTED/)
      return response("Continued safely")
    },
  ])
  const runner = createRunner(provider, new ToolRegistry([registration]))
  assert.equal((await runner.run(input())).status, "PAUSED")
  const result = await runner.resume("REJECT")

  assert.equal(result.status, "COMPLETED")
  assert.equal(executions, 0)
  assert.deepEqual(result.toolCalls.map((call) => call.outcome), ["REJECTED"])
})

test("DENY never executes and the model can recover", async () => {
  let executions = 0
  const registration: ToolRegistration = {
    definition: { name: "escape", description: "Synthetic denied action.", action: "repository_escape", inputSchema: {} },
    validate: () => ({}),
    execute: async () => { executions += 1 },
  }
  const provider = new ScriptedModelProvider([
    response("try", [{ id: "deny-1", name: "escape", arguments: {} }]),
    (request) => {
      assert.match(request.messages[0]!.content, /PERMISSION_DENIED/)
      return response("Denied safely")
    },
  ])
  const result = await createRunner(provider, new ToolRegistry([registration])).run(input())

  assert.equal(result.status, "COMPLETED")
  assert.equal(executions, 0)
  assert.equal(result.events.some((event) => event.type === "permission.denied"), true)
})

test("terminates model failure, maximum turns, and repeated non-progress distinctly", async () => {
  const modelFailure = await createRunner(new ScriptedModelProvider([new Error("offline")])).run(input())
  assert.equal(modelFailure.status, "FAILED")
  assert.equal(modelFailure.failureReason, "MODEL_ERROR")

  const limited = createRunner(new ScriptedModelProvider([
    response("read", [{ id: "one", name: "read_file", arguments: { path: "README.md" } }]),
    (request) => {
      const blob = request.messages.map((message) => message.content).join("\n")
      assert.match(blob, /README|read_file|observation|continuation/s)
      return response("Finished from the preserved observations.")
    },
    response("Finished from the preserved observations."),
  ]))
  const maxTurns = await limited.run(input({ maxTurns: 1 }))
  assert.equal(maxTurns.failureReason, "MAX_TURNS_EXCEEDED")
  assert.equal(maxTurns.events.at(-1)!.type, "task.max_turns")
  assert.equal(maxTurns.toolCalls[0]?.name, "read_file")
  const continued = await limited.continueFromLimit(2)
  assert.equal(continued.status, "COMPLETED")
  assert.equal(continued.toolCalls[0]?.name, "read_file")
  assert.match(continued.finalAnswer ?? "", /Finished from the preserved observations/)
  await assert.rejects(limited.continueFromLimit(40), /total turn budget cannot exceed 40|turn-budget pause/)

  const repeated = Array.from({ length: 3 }, (_, index) => response("again", [
    { id: `repeat-${index}`, name: "read_file", arguments: { path: "README.md" } },
  ]))
  const nonProgress = await createRunner(new ScriptedModelProvider(repeated), createReadOnlyToolRegistry(), 3).run(input())
  assert.equal(nonProgress.failureReason, "NON_PROGRESS")
  assert.equal(nonProgress.turns, 3)
  assert.equal(nonProgress.events.at(-1)!.type, "task.non_progress")
})

test("propagates cancellation through the model path as CANCELLED", async () => {
  const controller = new AbortController()
  const provider = new ScriptedModelProvider([
    async (request) => {
      controller.abort()
      request.signal!.throwIfAborted()
      return response("unreachable")
    },
  ])
  const result = await createRunner(provider).run(input({ signal: controller.signal }))

  assert.equal(result.status, "CANCELLED")
  assert.equal(result.failureReason, "CANCELLED")
  assert.equal(result.events.at(-1)!.type, "task.cancelled")
})

test("required context overflow fails safely before a model request", async () => {
  const provider = new ScriptedModelProvider([response("unreachable")])
  const result = await createRunner(provider).run(input({
    contextBudget: calculateBudget({ contextWindow: 2, reservedOutput: 0, reservedToolHistory: 0 }),
    projectInstructions: [{ id: "rules", path: "AGENTS.md", content: "x".repeat(100) }],
  }))

  assert.equal(result.status, "FAILED")
  assert.equal(result.failureReason, "CONTEXT_OVERFLOW")
  assert.equal(provider.requests.length, 0)
})

test("turns a tool runtime failure into a bounded observation and allows recovery", async () => {
  const registration: ToolRegistration = {
    definition: { name: "fragile", description: "Synthetic failing read.", action: "read_repository", inputSchema: {} },
    validate: () => ({}),
    execute: async () => { throw new Error("fixture read failed") },
  }
  const provider = new ScriptedModelProvider([
    response("try", [{ id: "failure-1", name: "fragile", arguments: {} }]),
    (request) => {
      assert.match(request.messages[0]!.content, /TOOL_RUNTIME_ERROR/)
      assert.match(request.messages[0]!.content, /fixture read failed/)
      return response("Recovered from the tool failure")
    },
  ])
  const result = await createRunner(provider, new ToolRegistry([registration])).run(input())

  assert.equal(result.status, "COMPLETED")
  assert.deepEqual(result.toolCalls.map((call) => call.outcome), ["FAILED"])
  assert.equal(result.events.some((event) => event.type === "tool.failed"), true)
})

test("propagates cancellation through tool invocation without reporting a tool failure", async () => {
  const controller = new AbortController()
  const registration: ToolRegistration = {
    definition: { name: "cancel_tool", description: "Synthetic cancellable read.", action: "read_repository", inputSchema: {} },
    validate: () => ({}),
    execute: async (_argumentsValue, context) => {
      controller.abort()
      context.signal.throwIfAborted()
    },
  }
  const provider = new ScriptedModelProvider([
    response("cancel", [{ id: "cancel-1", name: "cancel_tool", arguments: {} }]),
  ])
  const result = await createRunner(provider, new ToolRegistry([registration])).run(input({ signal: controller.signal }))

  assert.equal(result.status, "CANCELLED")
  assert.equal(result.events.at(-1)!.type, "task.cancelled")
  assert.equal(result.events.some((event) => event.type === "tool.failed"), false)
})

test("bounds large tool output in the recompiled model context and event trace", async () => {
  const registration: ToolRegistration = {
    definition: { name: "large_read", description: "Synthetic large read.", action: "read_repository", inputSchema: {} },
    validate: () => ({}),
    execute: async () => "x".repeat(10_000),
  }
  const provider = new ScriptedModelProvider([
    response("read", [{ id: "large-1", name: "large_read", arguments: {} }]),
    (request) => {
      assert.equal(Buffer.byteLength(request.messages[0]!.content) < 1_000, true)
      assert.match(request.messages[0]!.content, /"truncated":true/)
      return response("Bounded")
    },
  ])
  const events: unknown[] = []
  const runner = new AgentRunner({
    provider,
    registry: new ToolRegistry([registration]),
    observationMaxBytes: 32,
    eventSink: (event) => events.push(event),
  })
  const result = await runner.run(input())

  assert.equal(result.status, "COMPLETED")
  assert.equal(result.toolCalls[0]!.truncated, true)
  assert.deepEqual(events, result.events)
  assert.equal(JSON.stringify(events).includes("x".repeat(100)), false)
})

test("contains malformed tool-call objects as structured rejection observations", async () => {
  const malformed = response("bad", [null as never])
  const provider = new ScriptedModelProvider([
    malformed,
    (request) => {
      assert.match(request.messages[0]!.content, /MALFORMED_TOOL_CALL/)
      return response("Recovered")
    },
  ])
  const result = await createRunner(provider).run(input())

  assert.equal(result.status, "COMPLETED")
  assert.deepEqual(result.toolCalls, [{ id: "malformed-call-1", name: "unknown", outcome: "REJECTED", truncated: false }])
})
