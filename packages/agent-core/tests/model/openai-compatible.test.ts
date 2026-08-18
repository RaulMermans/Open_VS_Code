import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test from "node:test"

import { ModelProviderError, OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  try {
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

test("constructs a configurable chat completion request and parses the response", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions")
    assert.equal(request.headers["x-local-test"], "enabled")
    assert.deepEqual(await readJson(request), {
      model: "local-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      max_tokens: 64,
    })
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      model: "served-model",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }))
  }, async (baseUrl) => {
    const provider = new OpenAICompatibleProvider({
      baseUrl,
      model: "local-model",
      headers: { "x-local-test": "enabled" },
    })
    const result = await provider.complete({
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      maxOutputTokens: 64,
    })
    assert.deepEqual(result, {
      model: "served-model",
      message: { role: "assistant", content: "hi" },
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1 },
    })
  })
})

test("reports HTTP failures without leaking configured headers", async () => {
  await withServer((_request, response) => {
    response.statusCode = 503
    response.end("offline")
  }, async (baseUrl) => {
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "local", headers: { Authorization: "secret-token" } })
    await assert.rejects(provider.complete({ messages: [] }), (error: unknown) => {
      assert(error instanceof ModelProviderError)
      assert.equal(error.code, "HTTP_ERROR")
      assert.equal(error.status, 503)
      assert.equal(error.message.includes("secret-token"), false)
      return true
    })
  })
})

test("rejects malformed successful responses", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ choices: [] }))
  }, async (baseUrl) => {
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "local" })
    await assert.rejects(provider.complete({ messages: [] }), { code: "MALFORMED_RESPONSE" })
  })
})

test("times out stalled requests", async () => {
  await withServer(() => {}, async (baseUrl) => {
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "local", timeoutMs: 20 })
    await assert.rejects(provider.complete({ messages: [] }), { code: "TIMEOUT" })
  })
})

test("honors caller cancellation", async () => {
  await withServer(() => {}, async (baseUrl) => {
    const controller = new AbortController()
    const provider = new OpenAICompatibleProvider({ baseUrl, model: "local", timeoutMs: 5_000 })
    const result = provider.complete({ messages: [], signal: controller.signal })
    controller.abort()
    await assert.rejects(result, { code: "CANCELLED" })
  })
})

test("validates provider configuration and requests", async () => {
  assert.throws(() => new OpenAICompatibleProvider({ baseUrl: "ftp://local/v1", model: "local" }), /http/i)
  assert.throws(() => new OpenAICompatibleProvider({ baseUrl: "http://local/v1", model: " " }), /model/i)
  const provider = new OpenAICompatibleProvider({ baseUrl: "http://local/v1", model: "local" })
  await assert.rejects(provider.complete({ messages: [], temperature: -1 }), { code: "INVALID_REQUEST" })
})
