import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { HaloProvider, HaloProviderError } from "../../src/model/halo.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500
      response.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("Expected TCP address")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

test("HaloProvider round-trips structured tool calls and tool results without executing tools itself", async () => {
  const bodies: Record<string, unknown>[] = []
  await withServer(async (request, response) => {
    const body = await readJson(request)
    bodies.push(body)
    response.setHeader("content-type", "application/json")
    const messages = Array.isArray(body.messages) ? body.messages : []
    const hasToolResult = messages.some((message) => typeof message === "object" && message !== null && (message as { role?: string }).role === "tool")
    if (hasToolResult) {
      response.end(JSON.stringify({
        modelId: "x3-qwen3-14b-vulkan",
        output: { role: "assistant", content: "Updated add.ts" },
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      }))
      return
    }
    response.end(JSON.stringify({
      modelId: "x3-qwen3-14b-vulkan",
      output: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "apply_patch", arguments: JSON.stringify({ path: "add.ts", search: "return a - b", replace: "return a + b" }) }],
      },
      finishReason: "tool_calls",
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }))
  }, async (coreUrl) => {
    const workspace = await mkdtemp(join(tmpdir(), "halo-vc07b-"))
    await writeFile(join(workspace, "add.ts"), "export function add(a: number, b: number): number {\n  return a - b\n}\n", "utf8")
    const registry = new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(workspace) })])
    const runner = new AgentRunner({
      provider: new HaloProvider({ coreUrl, capability: "coding", token: "token" }),
      registry,
      evidenceGate: false,
      conversationEncoding: "native-tool-messages",
    })
    const paused = await runner.run({
      task: { id: "vc07b-coding", mode: "BUILD", instruction: "Fix add() so it adds." },
      workspaceRoot: workspace,
      maxTurns: 4,
      contextBudget: calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 }),
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    assert.equal(paused.confirmation?.toolName, "apply_patch")
    const completed = await runner.resume("APPROVE")
    assert.equal(completed.status, "COMPLETED")
    assert.equal(completed.finalAnswer, "Updated add.ts")
    assert.equal(await readFile(join(workspace, "add.ts"), "utf8"), "export function add(a: number, b: number): number {\n  return a + b\n}\n")
    assert.ok(bodies[0]?.tools)
    assert.ok((bodies[1]?.messages as { role?: string }[]).some((message) => message.role === "tool"))
    assert.equal((bodies[1]?.messages as { role?: string; toolCallId?: string }[]).find((message) => message.role === "tool")?.toolCallId, "call_1")
  })
})

test("HaloProvider refuses a tool-capable request that HALO cannot support and never invents tool-call IDs", async () => {
  await withServer((_request, response) => {
    response.statusCode = 422
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ code: "UNSUPPORTED_INFERENCE_FEATURE" }))
  }, async (coreUrl) => {
    await assert.rejects(
      new HaloProvider({ coreUrl, capability: "coding", token: "token" }).complete({
        messages: [{ role: "user", content: "edit" }],
        tools: [{ name: "read_file", description: "Read a file", action: "read_repository", inputSchema: { type: "object" } }],
      }),
      { code: "UNSUPPORTED_INFERENCE_FEATURE" },
    )
  })

  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      modelId: "x3-qwen3-14b-vulkan",
      output: { role: "assistant", content: "", toolCalls: [{ name: "read_file", arguments: "{}" }] },
      finishReason: "tool_calls",
    }))
  }, async (coreUrl) => {
    await assert.rejects(
      new HaloProvider({ coreUrl, capability: "coding", token: "token" }).complete({ messages: [{ role: "user", content: "read" }] }),
      (error: unknown) => error instanceof HaloProviderError && error.code === "HALO_INVALID_RESPONSE",
    )
  })
})
