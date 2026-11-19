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

const call = (id: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name: "read_file", arguments: args }] })

test("a file the context budget has dropped is given again on a re-read, not refused as 'already above'", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-evict-"))
  try {
    await mkdir(join(root, "docs"))
    await writeFile(join(root, "docs/a.md"), "ALPHA-MARKER\n" + "alpha line of context\n".repeat(120))
    await writeFile(join(root, "docs/b.md"), "BETA\n" + "beta line of context\n".repeat(400))
    const budget = calculateBudget({ contextWindow: 24_000, reservedOutput: 300, reservedToolHistory: 300 })
    const steps = [call("1", { path: "docs/a.md" }), ...[2, 3, 4, 5, 6, 7].map((n) => call(String(n), { path: "docs/b.md", startLine: n })), ...[8, 9].map((n) => call(String(n), { path: "docs/a.md" }))]
    const provider = new ScriptedModelProvider(steps)
    const agent = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
    const result = await agent.run({ task: { id: "task", mode: "ASK", instruction: "Summarise docs/a.md." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    const diag = result.diagnostics
    assert.ok(diag, "diagnostics present")
    const last = JSON.stringify(provider.requests.at(-1))
    assert.doesNotMatch(last, /its result is already above/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
