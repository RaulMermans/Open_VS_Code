import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AgentRunner } from "../../src/agent/runner.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { MutationEngine, sha256 } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { AgentEvent } from "../../src/contracts/agent.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"

const contextBudget = calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>): ModelResponse {
  return response("", [{ id, name, arguments: args }])
}

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mutation-prep-"))
}

test("prepareForReview creates exact diff without modifying filesystem", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "target.txt"), "Original content", "utf8")
    const originalHash = sha256("Original content")

    const engine = new MutationEngine(ws)
    const registrations = createMutationToolRegistrations({ engine })
    const patchTool = registrations.find(r => r.definition.name === "apply_patch")!

    const reviewable = await patchTool.prepareForReview!({
      path: "target.txt",
      search: "Original",
      replace: "New"
    }, { workspaceRoot: ws, signal: new AbortController().signal })

    // 1. Confirmation includes exact diff, mutation ID, before/after hashes
    assert.ok(reviewable.id)
    assert.equal(reviewable.reviewPayload.beforeHash, originalHash)
    assert.equal(reviewable.reviewPayload.afterHash, sha256("New content"))
    assert.ok(typeof reviewable.reviewPayload.diff === "string")
    assert.ok((reviewable.reviewPayload.diff as string).includes("+New content"))
    assert.ok((reviewable.reviewPayload.diff as string).includes("-Original content"))

    // 2. Prepare does not change filesystem
    const current = await readFile(join(ws, "target.txt"), "utf8")
    assert.equal(current, "Original content")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("ReviewableExecution single-use enforcement", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "target.txt"), "Original content", "utf8")

    const engine = new MutationEngine(ws)
    const registrations = createMutationToolRegistrations({ engine })
    const patchTool = registrations.find(r => r.definition.name === "apply_patch")!

    const reviewable = await patchTool.prepareForReview!({
      path: "target.txt",
      search: "Original",
      replace: "New"
    }, { workspaceRoot: ws, signal: new AbortController().signal })

    // 3. APPROVE applies same reviewed prepared mutation
    const result = await reviewable.apply({ workspaceRoot: ws, signal: new AbortController().signal }) as any
    assert.equal(result.status, "APPLIED")
    
    // 10. Diff reviewed == diff of actual applied result
    assert.deepEqual(result.diff.unified, reviewable.reviewPayload.diff)

    // 11. Hash reviewed == resulting file hash
    const current = await readFile(join(ws, "target.txt"), "utf8")
    assert.equal(sha256(current), reviewable.reviewPayload.afterHash)

    // 8. APPLY -> second approval impossible
    await assert.rejects(
      reviewable.apply({ workspaceRoot: ws, signal: new AbortController().signal }),
      /already consumed/
    )
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("Target modification after prepare -> STALE_BASE", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "target.txt"), "Original content", "utf8")

    const engine = new MutationEngine(ws)
    const registrations = createMutationToolRegistrations({ engine })
    const patchTool = registrations.find(r => r.definition.name === "apply_patch")!

    const reviewable = await patchTool.prepareForReview!({
      path: "target.txt",
      search: "Original",
      replace: "New"
    }, { workspaceRoot: ws, signal: new AbortController().signal })

    // 5. Target modification after prepare
    await writeFile(join(ws, "target.txt"), "Changed content", "utf8")

    const result = await reviewable.apply({ workspaceRoot: ws, signal: new AbortController().signal }) as any
    assert.equal(result.status, "STALE_BASE")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("CREATE -> destination appears before approval -> conflict", async () => {
  const ws = await createTempWorkspace()
  try {
    const engine = new MutationEngine(ws)
    const registrations = createMutationToolRegistrations({ engine })
    const createTool = registrations.find(r => r.definition.name === "create_file")!

    const reviewable = await createTool.prepareForReview!({
      path: "target.txt",
      content: "New content"
    }, { workspaceRoot: ws, signal: new AbortController().signal })

    // 9. CREATE destination appears before approval
    await writeFile(join(ws, "target.txt"), "Surprise content", "utf8")

    const result = await reviewable.apply({ workspaceRoot: ws, signal: new AbortController().signal }) as any
    assert.equal(result.status, "FAILED")
    assert.equal(result.error.code, "FILE_EXISTS")
  } finally {
    await rm(ws, { recursive: true })
  }
})

test("Integration flow with mutation.prepared and events", async () => {
  const ws = await createTempWorkspace()
  try {
    await writeFile(join(ws, "target.txt"), "Original content", "utf8")

    const engine = new MutationEngine(ws)
    const registry = new ToolRegistry([...createMutationToolRegistrations({ engine })])

    const provider = new ScriptedModelProvider([
      makeToolCall("call-1", "apply_patch", {
        path: "target.txt",
        search: "Original",
        replace: "New",
      }),
      response("Done.")
    ])

    const events: AgentEvent[] = []
    const runner = new AgentRunner({
      provider,
      registry,
      eventSink: (e) => events.push(e),
      evidenceGate: false,
    })

    const result = await runner.run({
      task: { id: "task-1", mode: "BUILD", instruction: "Change it" },
      workspaceRoot: ws,
      maxTurns: 5,
      contextBudget,
      projectInstructions: [],
    })

    assert.equal(result.status, "PAUSED")
    assert.ok(result.confirmation)
    assert.ok(result.confirmation.preparedMutation)
    
    const prepId = result.confirmation.preparedMutation.id
    assert.ok(prepId)

    // 12. Mutation events occur in correct order
    const types = events.map(e => e.type)
    
    // Check order
    const modelReqIdx = types.indexOf("model.requested")
    const modelCompIdx = types.indexOf("model.completed")
    const mutPrepIdx = types.indexOf("mutation.prepared")
    const mutConfReqIdx = types.indexOf("mutation.confirmation_requested")

    assert.ok(modelReqIdx < modelCompIdx)
    assert.ok(modelCompIdx < mutPrepIdx)
    assert.ok(mutPrepIdx < mutConfReqIdx)

    await runner.resume("REJECT")
    
    // 6. REJECT -> no write
    const current = await readFile(join(ws, "target.txt"), "utf8")
    assert.equal(current, "Original content")

    const typesAfter = events.map(e => e.type)
    assert.ok(typesAfter.includes("mutation.rejected"))
  } finally {
    await rm(ws, { recursive: true })
  }
})
