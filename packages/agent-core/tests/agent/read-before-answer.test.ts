import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

const tool = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })
const answer = (text: string): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: text } })

async function ask(steps: ModelResponse[], instruction: string) {
  const root = await mkdtemp(join(tmpdir(), "ovsc-read-first-"))
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/session.ts"), "export const IDLE_MINUTES = 45\nexport function expireIdle() {}\n")
    const provider = new ScriptedModelProvider(steps)
    const agent = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), evidenceGate: false, eventFactory: { createId: () => "e", now: () => "2026-11-26T00:00:00.000Z" } })
    const result = await agent.run({ task: { id: "t", mode: "ASK", instruction }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: calculateBudget({ contextWindow: 32_000, reservedOutput: 2_000, reservedToolHistory: 2_000 }), projectInstructions: [] })
    return { result, provider }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("an Ask answer built only from search hits is asked once to read the file first", async () => {
  const { result, provider } = await ask([
    tool("1", "search_text", { query: "expireIdle" }),
    answer("Sessions expire in src/session.ts; the exact time is configured there."),
    tool("2", "read_file", { path: "src/session.ts" }),
    answer("Idle sessions expire after IDLE_MINUTES = 45 minutes (src/session.ts)."),
  ], "How long before idle sessions expire?")
  assert.equal(result.status, "COMPLETED")
  assert.match(result.finalAnswer ?? "", /45 minutes/)
  assert.match(JSON.stringify(provider.requests[2]), /READ BEFORE ANSWERING[^"]*src\/session\.ts/)
  assert.equal(provider.requests.length, 4)
})

test("the nudge is given at most once, and not to an answer with no repository lookups", async () => {
  const once = await ask([
    tool("1", "search_text", { query: "idle timeout" }),
    answer("I could not find it."),
    answer("Still not found."),
  ], "How long before idle sessions expire?")
  assert.equal(once.result.status, "COMPLETED")
  assert.equal(once.provider.requests.length, 3)
  assert.match(JSON.stringify(once.provider.requests[1]), /search_text matches literal text/)
  const direct = await ask([answer("pong")], "Reply with the single word pong.")
  assert.equal(direct.result.finalAnswer, "pong")
  assert.equal(direct.provider.requests.length, 1)
})
