import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test from "node:test"

import { HaloProvider, HaloProviderError, capabilityForAgentMode, probeHalo, selectInferenceBackend } from "../../src/model/halo.ts"
import type { ModelProvider } from "../../src/contracts/model.ts"
import { AgentRunner } from "../../src/agent/runner.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { calculateBudget } from "../../src/context/budget.ts"

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

test("uses HALO's capability endpoint, normalized base URL, bearer auth, and canonical request shape", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.url, "/inference/capability/chat")
    assert.equal(request.headers.authorization, "Bearer test-token")
    assert.deepEqual(await readJson(request), {
      capability: "coding",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      maxTokens: 64,
    })
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ modelId: "halo-model-id", output: { role: "assistant", content: "hi" }, finishReason: "stop", usage: { inputTokens: 3, outputTokens: 1 } }))
  }, async (coreUrl) => {
    const provider = new HaloProvider({ coreUrl, capability: "coding", token: "test-token" })
    const result = await provider.complete({ messages: [{ role: "user", content: "hello" }], temperature: 0.2, maxOutputTokens: 64 })
    assert.deepEqual(result, {
      model: "halo-model-id",
      message: { role: "assistant", content: "hi" },
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1 },
      metadata: { backend: "halo", capability: "coding" },
    })
  })
})

test("maps every agent mode to its documented deterministic HALO capability", () => {
  assert.equal(capabilityForAgentMode("ASK"), "coding")
  assert.equal(capabilityForAgentMode("PLAN"), "reasoning")
  assert.equal(capabilityForAgentMode("BUILD"), "coding")
  assert.equal(capabilityForAgentMode("DEBUG"), "reasoning")
  assert.equal(capabilityForAgentMode("REVIEW"), "reasoning")
})

test("probes HALO health without generating inference", async () => {
  await withServer((request, response) => {
    assert.equal(request.url, "/health")
    response.end("ok")
  }, async (coreUrl) => {
    assert.equal(await probeHalo(coreUrl), true)
  })
})

test("does not leak tokens while mapping HALO authorization failures", async () => {
  await withServer((_request, response) => {
    response.statusCode = 401
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ code: "APPLICATION_UNAUTHORIZED", message: "secret-token-must-not-leak" }))
  }, async (coreUrl) => {
    const provider = new HaloProvider({ coreUrl, capability: "coding", token: "secret-token-must-not-leak" })
    await assert.rejects(provider.complete({ messages: [{ role: "user", content: "hello" }] }), (error: unknown) => {
      assert(error instanceof HaloProviderError)
      assert.equal(error.code, "APPLICATION_UNAUTHORIZED")
      assert.equal(error.message.includes("secret-token-must-not-leak"), false)
      return true
    })
  })
})

test("maps capability and inference failures at one safe boundary", async () => {
  for (const [status, code] of [[403, "APPLICATION_CAPABILITY_FORBIDDEN"], [404, "ROUTE_NOT_CONFIGURED"], [503, "INFERENCE_DISABLED"]] as const) {
    await withServer((_request, response) => {
      response.statusCode = status
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ code }))
    }, async (coreUrl) => {
      await assert.rejects(new HaloProvider({ coreUrl, capability: "coding", token: "token" }).complete({ messages: [{ role: "user", content: "hello" }] }), { code })
    })
  }
})

test("is consumable through the existing ModelProvider and AgentRunner boundary", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ modelId: "halo-model-id", output: { role: "assistant", content: "HALO answer" }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }))
  }, async (coreUrl) => {
    const runner = new AgentRunner({ provider: new HaloProvider({ coreUrl, capability: "coding", token: "token" }), registry: createReadOnlyToolRegistry() })
    const result = await runner.run({
      task: { id: "halo-provider-contract", mode: "ASK", instruction: "Answer safely" },
      workspaceRoot: "/workspace",
      maxTurns: 1,
      contextBudget: calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 }),
      projectInstructions: [],
    })
    assert.equal(result.status, "COMPLETED")
    assert.equal(result.finalAnswer, "HALO answer")
  })
})

test("rejects malformed HALO responses, network failure, timeout, and caller cancellation", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ output: { role: "assistant", content: "missing model id" } }))
  }, async (coreUrl) => {
    await assert.rejects(new HaloProvider({ coreUrl, capability: "coding", token: "token" }).complete({ messages: [{ role: "user", content: "hello" }] }), { code: "HALO_INVALID_RESPONSE" })
  })

  await assert.rejects(new HaloProvider({ coreUrl: "http://127.0.0.1:1", capability: "coding", token: "token" }).complete({ messages: [{ role: "user", content: "hello" }] }), { code: "HALO_UNAVAILABLE" })

  await withServer(() => {}, async (coreUrl) => {
    await assert.rejects(new HaloProvider({ coreUrl, capability: "coding", token: "token", timeoutMs: 20 }).complete({ messages: [{ role: "user", content: "hello" }] }), { code: "HALO_TIMEOUT" })
    const controller = new AbortController()
    const result = new HaloProvider({ coreUrl, capability: "coding", token: "token", timeoutMs: 5_000 }).complete({ messages: [{ role: "user", content: "hello" }], signal: controller.signal })
    controller.abort()
    await assert.rejects(result, { code: "HALO_CANCELLED" })
  })
})

test("HALO selection never falls back to the standalone provider after a HALO failure", async () => {
  let standaloneCalls = 0
  const standalone: ModelProvider = { capabilities: new Set(["chat"]), complete: async () => { standaloneCalls += 1; return { model: "local", message: { role: "assistant", content: "unexpected" } } } }
  const halo = new HaloProvider({ coreUrl: "http://127.0.0.1:1", capability: "coding", token: "token" })
  const selected = selectInferenceBackend({ backend: "halo", halo, standalone })
  await assert.rejects(selected.complete({ messages: [{ role: "user", content: "hello" }] }), { code: "HALO_UNAVAILABLE" })
  assert.equal(standaloneCalls, 0)
})
