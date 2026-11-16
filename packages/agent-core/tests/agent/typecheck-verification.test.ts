import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })
const response = (content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse => ({ model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) })

async function run(typecheckResult: "PASS" | "FAIL", withScript = true) {
  const root = await mkdtemp(join(tmpdir(), "ovsc-typecheck-"))
  await mkdir(join(root, "lib"))
  await writeFile(join(root, "lib/format.ts"), "export function statusTone(n: number) {\n  return n > 80 ? 'ok' : 'bad'\n}\n")
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", ...(withScript ? { typecheck: "tsc --noEmit" } : {}) } }))
  const actions: string[] = []
  const verify: ToolRegistration = {
    definition: { name: "run_verification", description: "Run checks", action: "run_known_test", inputSchema: { type: "object" } },
    validate: (input) => ({ action: (input as { action?: string }).action ?? "TEST" }),
    execute: async (input) => {
      actions.push(String(input.action))
      return { status: input.action === "TYPECHECK" ? typecheckResult : "PASS", exitCode: 0, stdout: "", stderr: "" }
    },
  }
  const provider = new ScriptedModelProvider([
    response("", [{ id: "p", name: "apply_patch", arguments: { path: "lib/format.ts", search: "statusTone", replace: "scoreTone" } }]),
    response("Renamed and tests pass."),
    response("Done."),
  ])
  const runner = new AgentRunner({ provider, registry: new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(root) }), verify]), eventFactory: { createId: () => "e", now: () => "2026-11-16T12:00:00.000Z" } })
  let result = await runner.run({ task: { id: "t", mode: "BUILD", instruction: "Rename statusTone to scoreTone in lib/format.ts and run the tests." }, workspaceRoot: root, maxTurns: 6, contextBudget: budget, projectInstructions: [] })
  for (let i = 0; result.status === "PAUSED" && i < 10; i += 1) result = await runner.resume("APPROVE")
  await rm(root, { recursive: true, force: true })
  return { result, actions }
}

test("after a TypeScript edit in a project with a typecheck script, the runtime runs tests then typecheck", async () => {
  const { result, actions } = await run("PASS")
  assert.deepEqual(actions.slice(0, 2), ["TEST", "TYPECHECK"])
  assert.equal(result.status, "COMPLETED", result.finalAnswer)
})

test("a failing typecheck keeps a test-passing edit from completing", async () => {
  const { result, actions } = await run("FAIL")
  assert.ok(actions.includes("TYPECHECK"))
  assert.notEqual(result.status, "COMPLETED")
  assert.doesNotMatch(result.finalAnswer ?? "", /The requested edit was applied\./)
})

test("projects without a typecheck script keep test-only verification", async () => {
  const { result, actions } = await run("FAIL", false)
  assert.deepEqual(actions, ["TEST"])
  assert.equal(result.status, "COMPLETED", result.finalAnswer)
})
