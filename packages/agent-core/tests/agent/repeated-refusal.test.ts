import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import type { AgentResult } from "../../src/contracts/agent.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { readRepositoryFile } from "../../src/tools/read-file.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

const verify = (id: string) => response("", [{ id, name: "run_verification", arguments: {} }])
const read = (id: string) => response("", [{ id, name: "read_file", arguments: { path: "src/add.ts" } }])

function tools(root: string): ToolRegistry {
  const failing: ToolRegistration = {
    definition: { name: "run_verification", description: "Run the project tests.", action: "run_known_test", inputSchema: { type: "object" } },
    validate: () => ({}),
    execute: async () => ({ status: "FAIL", exitCode: 1, stdout: "not ok 1 - add\n# tests 1\n# fail 1\n", stderr: "" }),
  }
  const reader: ToolRegistration = {
    definition: { name: "read_file", description: "Read one repository file.", action: "read_repository", inputSchema: { type: "object" } },
    validate: (input) => ({ path: String((input as { path?: unknown }).path ?? "") }),
    execute: (input, context) => readRepositoryFile(context.workspaceRoot, input.path as string),
  }
  return new ToolRegistry([reader, ...createMutationToolRegistrations({ engine: new MutationEngine(root) }), failing])
}

async function run(root: string, script: ModelResponse[]): Promise<{ result: AgentResult; provider: ScriptedModelProvider }> {
  // Pad the script so an unbounded loop would show up as many turns rather than a script exhaustion.
  const provider = new ScriptedModelProvider([...script, ...Array.from({ length: 40 }, (_, index) => verify(`pad-${index}`))])
  const agent = new AgentRunner({ provider, registry: tools(root), eventFactory: { createId: () => "event", now: () => "2026-11-16T12:00:00.000Z" } })
  let result = await agent.run({
    task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum and run the tests." },
    workspaceRoot: root,
    maxTurns: UNLIMITED_MAX_TURNS,
    contextBudget: budget,
    projectInstructions: [],
  })
  for (let guard = 0; result.status === "PAUSED" && guard < 20; guard += 1) result = await agent.resume("APPROVE")
  return { result, provider }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-refusal-"))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/add.ts"), "export function add(left: number, right: number) {\n  return left - right\n}\n")
  return root
}

test("the same refused verification without any code change stops as NON_PROGRESS on an unlimited budget", async () => {
  const root = await workspace()
  try {
    const { result } = await run(root, [
      response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left * right" } }]),
      verify("v1"),
    ])
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "NON_PROGRESS")
    const denied = result.toolCalls.filter((call) => call.name === "run_verification" && call.outcome === "DENIED" && !call.id.startsWith("auto-verify-"))
    assert.equal(denied.length, 4)
    assert.ok(result.turns < 12, `stopped after ${result.turns} turns`)
    assert.match(result.finalAnswer ?? "", /refused 4 times with the same reason/)
    assert.doesNotMatch(result.finalAnswer ?? "", /tests passed/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reading files between identical refusals does not reset the bound", async () => {
  const root = await workspace()
  try {
    const { result } = await run(root, [
      response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left * right" } }]),
      verify("v1"),
      verify("v2"), read("r1"), verify("v3"), read("r2"), verify("v4"), read("r3"), verify("v5"),
    ])
    assert.equal(result.failureReason, "NON_PROGRESS")
    assert.equal(result.toolCalls.filter((call) => call.outcome === "DENIED" && !call.id.startsWith("auto-verify-")).length, 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a real code change between refusals resets the bound", async () => {
  const root = await workspace()
  try {
    const { result } = await run(root, [
      response("", [{ id: "p1", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left * right" } }]),
      // The runtime verifies right after p1, so v1, d1 and d2 are three identical refusals.
      verify("v1"), verify("d1"), verify("d2"),
      response("", [{ id: "p2", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left * right", replace: "return left / right" } }]),
      verify("v2"), verify("e1"), verify("e2"),
    ])
    // Three denials before the edit and the post-edit denials are counted separately.
    const deniedBeforeEdit = result.toolCalls.slice(0, result.toolCalls.findIndex((call) => call.id === "p2")).filter((call) => call.outcome === "DENIED" && !call.id.startsWith("auto-verify-")).length
    assert.equal(deniedBeforeEdit, 3)
    assert.match(await readFile(join(root, "src/add.ts"), "utf8"), /left \/ right/)
    assert.equal(result.failureReason, "NON_PROGRESS")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a refused patch that also emits tool.rejected stops cleanly instead of throwing a transition error", async () => {
  const root = await workspace()
  try {
    await writeFile(join(root, "src/greet.ts"), "export function greet(name: string): string {\n  return name\n}\n")
    const badImport = (id: string) => response("", [{ id, name: "apply_patch", arguments: { path: "src/greet.ts", search: "export function greet(name: string): string {", replace: "import { missing } from './nowhere.ts'\nexport function greet(name: string): string {" } }])
    const { result } = await run(root, [badImport("i1"), badImport("i2"), badImport("i3"), badImport("i4"), badImport("i5")])
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "NON_PROGRESS")
    assert.match(result.finalAnswer ?? "", /refused 4 times/)
    assert.equal(await readFile(join(root, "src/greet.ts"), "utf8"), "export function greet(name: string): string {\n  return name\n}\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
