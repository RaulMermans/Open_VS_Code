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
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import type { AgentEvent } from "../../src/contracts/agent.ts"

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mutation-int-"))
}

const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ModelResponse {
  return response("", [{ id, name, arguments: args }])
}

test("scripted model mutation flow: read → patch → approve → complete", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "greeting.txt"), "Hello World", "utf8")

    const engine = new MutationEngine(ws)
    const mutationRegistrations = createMutationToolRegistrations({ engine })
    const registry = new ToolRegistry([...mutationRegistrations])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", {
        path: "greeting.txt",
        search: "Hello",
        replace: "Welcome",
      }),
      response("Updated greeting from Hello to Welcome."),
    ])

    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      provider,
      registry,
      eventSink: (e) => events.push(e),
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-1", mode: "BUILD", instruction: "Change Hello to Welcome" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    // Should pause for confirmation
    assert.equal(result.status, "PAUSED")
    assert.ok(result.confirmation)
    assert.equal(result.confirmation!.toolName, "apply_patch")
    assert.equal(result.confirmation!.action, "write_file")

    // Approve the mutation
    const finalResult = await runner.resume("APPROVE")

    assert.equal(finalResult.status, "COMPLETED")
    assert.equal(finalResult.finalAnswer, "Updated greeting from Hello to Welcome.")

    // Verify file was actually changed
    const content = await readFile(join(ws, "greeting.txt"), "utf8")
    assert.equal(content, "Welcome World")

    // Check events include permission flow
    const eventTypes = events.map((e) => e.type)
    assert.ok(eventTypes.includes("mutation.confirmation_requested"))
    assert.ok(eventTypes.includes("mutation.approved"))
    assert.ok(eventTypes.includes("mutation.applied"))
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("rejection flow: caller rejects mutation, filesystem unchanged", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "keep.txt"), "original content", "utf8")

    const engine = new MutationEngine(ws)
    const mutationRegistrations = createMutationToolRegistrations({ engine })
    const registry = new ToolRegistry([...mutationRegistrations])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", {
        path: "keep.txt",
        search: "original",
        replace: "modified",
      }),
      response("Mutation was rejected."),
    ])

    const runner = new AgentRunner({
      provider,
      registry,
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-2", mode: "BUILD", instruction: "Modify the file" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    assert.equal(result.status, "PAUSED")

    // REJECT the mutation
    const finalResult = await runner.resume("REJECT")
    assert.equal(finalResult.status, "COMPLETED")

    // Filesystem MUST be unchanged
    const content = await readFile(join(ws, "keep.txt"), "utf8")
    assert.equal(content, "original content")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("ASK mode denies write tool before it reaches confirmation", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "readonly.txt"), "content", "utf8")

    const engine = new MutationEngine(ws)
    const mutationRegistrations = createMutationToolRegistrations({ engine })
    const registry = new ToolRegistry([...mutationRegistrations])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", {
        path: "readonly.txt",
        search: "content",
        replace: "hacked",
      }),
      response("Denied in ASK mode."),
    ])

    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      provider,
      registry,
      eventSink: (e) => events.push(e),
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-3", mode: "ASK", instruction: "Try to modify" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    // Should complete (not pause) because ASK mode DENIES write
    assert.equal(result.status, "COMPLETED")
    assert.equal(result.finalAnswer, "Denied in ASK mode.")

    // Verify permission.denied event
    const eventTypes = events.map((e) => e.type)
    assert.ok(eventTypes.includes("permission.denied"), "Expected permission.denied event")
    assert.ok(!eventTypes.includes("permission.requested"), "Should NOT request confirmation in ASK mode")

    // File unchanged
    assert.equal(await readFile(join(ws, "readonly.txt"), "utf8"), "content")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("PLAN mode denies write tool", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "plan.txt"), "plan content", "utf8")

    const engine = new MutationEngine(ws)
    const mutationRegistrations = createMutationToolRegistrations({ engine })
    const registry = new ToolRegistry([...mutationRegistrations])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", {
        path: "plan.txt",
        search: "plan",
        replace: "modified",
      }),
      response("Denied in PLAN mode."),
    ])

    const runner = new AgentRunner({
      provider,
      registry,
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-4", mode: "PLAN", instruction: "Try to modify" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    assert.equal(result.status, "COMPLETED")
    assert.equal(await readFile(join(ws, "plan.txt"), "utf8"), "plan content")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("BUILD mode write requires confirmation (does not auto-allow)", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "build.txt"), "build content", "utf8")

    const engine = new MutationEngine(ws)
    const mutationRegistrations = createMutationToolRegistrations({ engine })
    const registry = new ToolRegistry([...mutationRegistrations])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", {
        path: "build.txt",
        search: "build",
        replace: "deployed",
      }),
      response("Done."),
    ])

    const runner = new AgentRunner({
      provider,
      registry,
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-5", mode: "BUILD", instruction: "Modify file" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    // Must PAUSE for confirmation, not auto-apply
    assert.equal(result.status, "PAUSED")
    assert.ok(result.confirmation)

    // File still unchanged until approval
    assert.equal(await readFile(join(ws, "build.txt"), "utf8"), "build content")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("create_file through scripted model flow", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = new MutationEngine(ws)
    const mutationRegistrations = createMutationToolRegistrations({ engine })
    const registry = new ToolRegistry([...mutationRegistrations])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "create_file", {
        path: "new-module.ts",
        content: "export const VERSION = \"1.0.0\"\n",
      }),
      response("Created new module."),
    ])

    const runner = new AgentRunner({
      provider,
      registry,
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-6", mode: "BUILD", instruction: "Create a new module" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    assert.equal(result.status, "PAUSED")

    const finalResult = await runner.resume("APPROVE")
    assert.equal(finalResult.status, "COMPLETED")

    const content = await readFile(join(ws, "new-module.ts"), "utf8")
    assert.equal(content, "export const VERSION = \"1.0.0\"\n")
  } finally {
    await rm(ws, { recursive: true })
  }
})
