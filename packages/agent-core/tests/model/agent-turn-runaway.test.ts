/**
 * Sprint 25: a runaway reasoning turn (Qwen3.6 thinking) no longer kills the task by hitting the request
 * timeout. Agent turns get an output cap; a turn cut off while still reasoning, or a timed-out turn, is
 * retried once with reasoning off. No timeout is raised; cancellation and normal turns are not retried.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { ModelRequest } from "../../src/contracts/model.ts"
import { AGENT_TURN_MAX_OUTPUT_TOKENS, ModelProviderError, OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"

const TOOL = { name: "read_file", description: "Read a file.", action: "read_repository", inputSchema: { type: "object", properties: { path: { type: "string" } } } } as const
const agentTurn = (signal?: AbortSignal): ModelRequest => ({ messages: [{ role: "user", content: "Fix the bug." }], tools: [TOOL] as never, ...(signal ? { signal } : {}) })
const toolCall = { model: "m", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] } }] }
const cutOff = { model: "m", choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "", reasoning: "Let me think about this very carefully..." } }] }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

function recording(responses: Array<(init: RequestInit) => Promise<Response>>, timeoutMs = 2_000) {
  const bodies: Record<string, unknown>[] = []
  const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:11434", model: "qwen3.6:35b", timeoutMs, fetch: (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const next = responses.shift()
    if (!next) throw new Error("unexpected request")
    return next(init)
  }) as typeof fetch })
  return { provider, bodies }
}

// A hung endpoint. The keep-alive timer stands in for the open socket (AbortSignal.timeout's timer is unref'd).
const hang = (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  if (init.signal?.aborted) return reject(new DOMException("aborted", "AbortError"))
  const keepAlive = setTimeout(() => undefined, 10_000)
  init.signal?.addEventListener("abort", () => {
    clearTimeout(keepAlive)
    reject(new DOMException("aborted", "AbortError"))
  })
})

test("agent turns get the output cap; plain completions do not", async () => {
  const { provider, bodies } = recording([async () => json(toolCall), async () => json({ model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }] })])
  await provider.complete(agentTurn())
  await provider.complete({ messages: [{ role: "user", content: "hi" }] })
  assert.equal(bodies[0]!.max_tokens, AGENT_TURN_MAX_OUTPUT_TOKENS)
  assert.equal(bodies[1]!.max_tokens, undefined)
})

test("a normal agent turn is sent once, with reasoning left as configured", async () => {
  const { provider, bodies } = recording([async () => json(toolCall)])
  const response = await provider.complete(agentTurn())
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0]!.reasoning_effort, undefined)
  assert.equal(response.toolCalls?.[0]?.name, "read_file")
})

test("a turn cut off by the cap while still reasoning is retried once with reasoning off", async () => {
  const { provider, bodies } = recording([async () => json(cutOff), async () => json(toolCall)])
  const response = await provider.complete(agentTurn())
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1]!.reasoning_effort, "none")
  assert.equal(response.toolCalls?.[0]?.name, "read_file")
})

test("a timed-out agent turn is retried once with reasoning off; the timeout itself is not raised", async () => {
  const { provider, bodies } = recording([hang, async () => json(toolCall)], 50)
  const response = await provider.complete(agentTurn())
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1]!.reasoning_effort, "none")
  assert.equal(response.toolCalls?.[0]?.name, "read_file")
})

test("when the retry fails too, the original timeout is reported", async () => {
  const { provider, bodies } = recording([hang, hang], 50)
  await assert.rejects(provider.complete(agentTurn()), (error: unknown) => error instanceof ModelProviderError && error.code === "TIMEOUT")
  assert.equal(bodies.length, 2, "exactly one retry")
})

test("a cancelled turn is not retried", async () => {
  const controller = new AbortController()
  const { provider, bodies } = recording([async (init) => { controller.abort(); return hang(init) }], 5_000)
  await assert.rejects(provider.complete(agentTurn(controller.signal)), (error: unknown) => error instanceof ModelProviderError && error.code === "CANCELLED")
  assert.equal(bodies.length, 1)
})
