import test from "node:test"
import assert from "node:assert/strict"
import { probeBackend } from "../../src/model/probe.ts"

const healthyFetch: typeof fetch = async (input) => {
  const url = String(input)
  if (url.includes("/models")) {
    return new Response(JSON.stringify({
      data: [{ id: "qwen2.5-coder:7b" }, { id: "llama3.2:3b" }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  if (url.includes("/chat/completions")) {
    return new Response(JSON.stringify({
      model: "qwen2.5-coder:7b",
      choices: [{ message: { role: "assistant", content: "pong" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } })
  }
  return new Response("Not found", { status: 404 })
}

test("probeBackend succeeds against mock healthy backend with tools", async () => {
  const result = await probeBackend({
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder:7b",
    fetch: healthyFetch,
  })

  assert.equal(result.reachable, true)
  assert.equal(result.modelAvailable, true)
  assert.equal(result.chatFunctional, true)
  assert.equal(result.toolsAccepted, true)
  assert.equal(result.usageReporting, true)
  assert.equal(result.error, undefined)
  assert.ok(result.latencyMs >= 0)
  assert.deepEqual(result.availableModels, ["qwen2.5-coder:7b", "llama3.2:3b"])
})

const unreachableFetch: typeof fetch = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:11434")
}

test("probeBackend reports diagnostic failure when endpoint is unreachable", async () => {
  const result = await probeBackend({
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder:7b",
    fetch: unreachableFetch,
  })

  assert.equal(result.reachable, false)
  assert.equal(result.modelAvailable, false)
  assert.equal(result.chatFunctional, false)
  assert.equal(result.toolsAccepted, false)
  assert.ok(result.error?.includes("ECONNREFUSED"))
})
