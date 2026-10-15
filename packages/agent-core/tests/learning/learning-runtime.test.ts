/**
 * Sprint 5D runtime integration: only APPROVED learning reaches a real compiled prompt, a candidate
 * never does, and learning off leaves the runtime exactly as before (ADR-032).
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createAgentRuntime } from "../../src/agent/runtime.ts"
import { openWorkspaceLearning } from "../../src/learning/node.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { BUILTIN_IDS } from "./helpers.ts"

const answer = { model: "scripted", message: { role: "assistant" as const, content: "Done." } }

async function seededWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-learn-rt-"))
  const service = await openWorkspaceLearning({ workspaceRoot: root, enabled: true, workspaceTrusted: true, builtinSkillIds: BUILTIN_IDS })
  await service.recordUserDecision({ title: "Use PostgreSQL 16 for the subtract service", summary: "APPROVED-MARKER: platform contract." })
  const pending = { kind: "PROJECT_PATTERN" as const, source: "OBSERVED_OUTCOME" as const, title: "Subtract service caches results", summary: "CANDIDATE-MARKER", evidenceRefs: ["workflow:x#VERIFY"], outcome: "SUCCESS" as const }
  await service.observe([{ ...pending, taskId: "t1" }, { ...pending, taskId: "t2" }])
  assert.equal(service.data.records.find((record) => record.summary === "CANDIDATE-MARKER")?.status, "CANDIDATE")
  return root
}

async function run(root: string, enabled: boolean) {
  const provider = new ScriptedModelProvider([answer])
  const runtime = await createAgentRuntime({ workspaceRoot: root, mode: "BUILD", instruction: "Explain the subtract service", eventSink: () => {}, isTrusted: true, providerOverride: provider, ...(enabled ? { learning: { enabled: true } } : {}) })
  const result = await runtime.runner.run(runtime.runnerInput as never)
  await runtime.cleanup()
  return { runtime, result, prompt: String(provider.requests[0]?.messages[0]?.content ?? "") }
}

test("L-10b: approved memory reaches the compiled prompt; a candidate never does", async () => {
  const root = await seededWorkspace()
  try {
    const { runtime, prompt } = await run(root, true)
    assert.ok(runtime.learningRetrieval)
    assert.equal(runtime.learningRetrieval.items.length, 1)
    assert.ok(prompt.includes("APPROVED-MARKER"), "approved decision is in the prompt")
    assert.ok(!prompt.includes("CANDIDATE-MARKER"), "a candidate never influences the run")
    assert.ok(runtime.learningRetrieval.retrievedTokens <= runtime.learningRetrieval.budgetTokens)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("L-25b: with learning off the runtime retrieves nothing and the prompt is unchanged", async () => {
  const root = await seededWorkspace()
  try {
    const off = await run(root, false)
    assert.equal(off.runtime.learning, undefined)
    assert.equal(off.runtime.learningRetrieval, undefined)
    assert.ok(!off.prompt.includes("APPROVED-MARKER"))
    assert.equal((off.runtime.runnerInput as { learnedMemory?: unknown }).learnedMemory, undefined)
    const step = await off.runtime.learnAfter({ kind: "direct", taskId: "x", mode: "BUILD", result: off.result })
    assert.equal(step.ran, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
