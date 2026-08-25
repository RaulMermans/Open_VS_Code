import assert from "node:assert/strict"
import test from "node:test"

import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelError, ScriptedModelProvider } from "../../src/testing/scripted-model.ts"

const request: ModelRequest = { messages: [{ role: "user", content: "Inspect the repository" }] }
const answer: ModelResponse = { model: "scripted", message: { role: "assistant", content: "Done" } }

test("returns scripted responses in order and captures real provider requests", async () => {
  const toolTurn: ModelResponse = {
    model: "scripted",
    message: { role: "assistant", content: "I will inspect it." },
    toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }],
  }
  const provider = new ScriptedModelProvider([toolTurn, answer])

  assert.deepEqual(await provider.complete(request), toolTurn)
  assert.deepEqual(await provider.complete(request), answer)
  assert.deepEqual(provider.requests, [request, request])
  assert.equal(provider.capabilities.has("tools"), true)
})

test("supports deliberate failures and deterministic request-aware steps", async () => {
  const provider = new ScriptedModelProvider([
    new Error("model offline"),
    (input) => ({ model: "scripted", message: { role: "assistant", content: input.messages[0]!.content } }),
  ])

  await assert.rejects(provider.complete(request), /model offline/)
  assert.equal((await provider.complete(request)).message.content, "Inspect the repository")
  assert.equal(provider.requests.length, 2)
})

test("fails explicitly when its script is exhausted", async () => {
  const provider = new ScriptedModelProvider([])
  await assert.rejects(provider.complete(request), (error: unknown) => {
    assert.equal(error instanceof ScriptedModelError, true)
    assert.equal((error as ScriptedModelError).code, "SCRIPT_EXHAUSTED")
    return true
  })
})
