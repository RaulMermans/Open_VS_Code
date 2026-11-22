import test from "node:test"
import assert from "node:assert/strict"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { ModelProviderError } from "../../src/model/openai-compatible.ts"

const ok = () => new Response(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } })

function provider(responses: Array<() => Response | Promise<Response>>) {
  let calls = 0
  const fetch = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!
    calls += 1
    return next()
  }) as typeof globalThis.fetch
  return { model: new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:9", model: "m", fetch, timeoutMs: 30_000 }), calls: () => calls }
}

const request = (signal?: AbortSignal) => ({ messages: [{ role: "user" as const, content: "ping" }], ...(signal ? { signal } : {}) })

test("a transient 500 from a restarting endpoint is retried and the request succeeds", async () => {
  const p = provider([() => new Response("down", { status: 500 }), ok])
  const response = await p.model.complete(request())
  assert.equal(response.message.content, "pong")
  assert.equal(p.calls(), 2)
})

test("a dropped connection is retried", async () => {
  const p = provider([() => { throw new TypeError("fetch failed: ECONNREFUSED") }, ok])
  assert.equal((await p.model.complete(request())).message.content, "pong")
})

test("client errors are not retried", async () => {
  const p = provider([() => new Response("bad", { status: 400 }), ok])
  await assert.rejects(p.model.complete(request()), (error: unknown) => error instanceof ModelProviderError && error.code === "HTTP_ERROR")
  assert.equal(p.calls(), 1)
})

test("Stop during the retry wait cancels promptly instead of retrying", async () => {
  const controller = new AbortController()
  const p = provider([() => new Response("down", { status: 503 }), ok])
  const started = Date.now()
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(p.model.complete(request(controller.signal)), (error: unknown) => error instanceof ModelProviderError && error.code === "CANCELLED")
  assert.ok(Date.now() - started < 900, "did not wait out the backoff")
  assert.equal(p.calls(), 1)
})
