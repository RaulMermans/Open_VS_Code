/**
 * Sprint 25: repeated read-only lookups are answered from the task-scoped observation registry
 * (ALREADY_OBSERVED), refreshed after workspace changes, bounded, and never replayed for writes.
 */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { UNLIMITED_MAX_TURNS } from "../../src/agent/acceptance-budget.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

const budget = calculateBudget({ contextWindow: 16_000, reservedOutput: 400, reservedToolHistory: 400 })
const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })
const answer = (text: string): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: text } })
const events = { createId: () => "event", now: () => "2026-11-17T12:00:00.000Z" }

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-s25-"))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/add.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
  await writeFile(join(root, "README.md"), "# Fixture\n")
  return root
}

/** The read-only tools plus mutation tools. */
function countingRegistry(root: string): ToolRegistry {
  const registry = createReadOnlyToolRegistry()
  for (const registration of createMutationToolRegistrations({ engine: new MutationEngine(root) })) registry.register(registration)
  return registry
}

/** Executions per tool: tool.requested is emitted only when a tool actually runs. */
function executions(result: { events: readonly { type: string; payload: unknown }[] }, name: string): number {
  return result.events.filter((event) => event.type === "tool.requested" && (event.payload as { name?: string }).name === name).length
}

async function run(root: string, steps: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>, instruction: string, registry: ToolRegistry) {
  const provider = new ScriptedModelProvider(steps)
  const agent = new AgentRunner({ provider, registry, eventFactory: events })
  let result = await agent.run({ task: { id: "task", mode: "BUILD", instruction }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
  for (let guard = 0; result.status === "PAUSED" && guard < 20; guard += 1) result = await agent.resume("APPROVE")
  return { result, provider }
}

test("a repeated directory listing returns the earlier result as ALREADY_OBSERVED without listing again", async () => {
  const root = await fixture()
  try {
    let replay = ""
    const { result } = await run(root, [
      call("l1", "list_directory", { path: "src" }),
      call("l2", "list_directory", { path: "src" }),
      (request) => { replay = JSON.stringify(request.messages); return answer("src holds add.ts.") },
    ], "Which files are in src? Do not edit files.", countingRegistry(root))
    assert.equal(executions(result, "list_directory"), 1, "the second identical listing did not touch the filesystem")
    const second = result.toolCalls.find((item) => item.id === "l2")!
    assert.equal(second.outcome, "COMPLETED", "not a refusal or failure")
    assert.equal(second.alreadyObserved, true)
    assert.match(replay, /ALREADY_OBSERVED: This lookup already ran/)
    assert.match(replay, /Earlier result:.*src\/add\.ts/s)
    assert.equal(result.status, "COMPLETED")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an applied edit invalidates earlier lookups, so the same listing runs again", async () => {
  const root = await fixture()
  try {
    const { result } = await run(root, [
      call("l1", "list_directory", { path: "src" }),
      call("c1", "create_file", { path: "src/sub.ts", content: "export const sub = (a: number, b: number) => a - b\n" }),
      call("l2", "list_directory", { path: "src" }),
      answer("Created src/sub.ts."),
    ], "Create src/sub.ts exporting sub.", countingRegistry(root))
    assert.equal(executions(result, "list_directory"), 2, "a stale listing is never replayed")
    const second = result.toolCalls.find((item) => item.id === "l2")!
    assert.notEqual(second.alreadyObserved, true)
    assert.match(String(result.observations?.find((item) => item.callId === "l2")?.content), /src\/sub\.ts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("re-reading an unchanged file is marked ALREADY_OBSERVED and still returns its content", async () => {
  const root = await fixture()
  try {
    const { result } = await run(root, [
      call("r1", "read_file", { path: "README.md" }),
      call("r2", "read_file", { path: "README.md" }),
      answer("The README is a heading."),
    ], "What does README.md say? Do not edit files.", countingRegistry(root))
    const r2 = result.toolCalls.find((item) => item.id === "r2")!
    assert.equal(r2.outcome, "COMPLETED")
    assert.equal(r2.alreadyObserved, true)
    assert.match(String(result.observations?.find((item) => item.callId === "r2")?.content), /^ALREADY_OBSERVED: This file is unchanged.*Earlier result:.*# Fixture/s)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a file changed outside the agent between two reads is read fresh, not replayed stale", async () => {
  const root = await fixture()
  try {
    const { result } = await run(root, [
      call("r1", "read_file", { path: "README.md" }),
      () => {
        writeFileSync(join(root, "README.md"), "# Fixture v2\n") // e.g. the user saved the file
        return call("r2", "read_file", { path: "README.md" })
      },
      answer("The README heading is Fixture v2."),
    ], "What does README.md say? Do not edit files.", countingRegistry(root))
    const r2 = result.observations?.find((item) => item.callId === "r2")
    assert.notEqual(r2?.alreadyObserved, true)
    assert.match(String(r2?.content), /# Fixture v2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("repeated identical lookups are bounded: one full replay, then brief answers, then a truthful stop", async () => {
  const root = await fixture()
  try {
    const steps = Array.from({ length: 12 }, (_, index) => call(`l${index}`, "list_directory", { path: "." }))
    const { result } = await run(root, steps, "Fix src/add.ts so add returns the sum.", countingRegistry(root))
    assert.equal(executions(result, "list_directory"), 1)
    assert.equal(result.failureReason, "NON_PROGRESS")
    assert.equal(result.terminationSource, "NON_PROGRESS_GUARD")
    assert.ok(result.toolCalls.length <= 6, `stopped after ${result.toolCalls.length} calls`)
    assert.ok(result.toolCalls.every((item) => item.outcome === "COMPLETED"), "no call is reported as refused or failed")
    assert.match(result.finalAnswer ?? "", /list_directory was repeated \d+ times with the same arguments and returned no new information/)
    assert.doesNotMatch(result.finalAnswer ?? "", /refused/)
    const brief = result.observations?.filter((item) => item.alreadyObserved).at(-1)
    assert.doesNotMatch(String(brief?.content), /Earlier result:/, "later repeats do not repeat the output")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("different arguments are different lookups and are not replayed", async () => {
  const root = await fixture()
  try {
    const { result } = await run(root, [
      call("s1", "search_text", { query: "add" }),
      call("s2", "search_text", { query: "sub" }),
      call("s3", "search_text", { query: "add", rootPath: "src" }),
      answer("add is defined in src/add.ts."),
    ], "Where is add defined? Do not edit files.", countingRegistry(root))
    assert.equal(executions(result, "search_text"), 3)
    assert.ok(result.toolCalls.every((item) => item.alreadyObserved !== true))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("side-effecting calls are never answered from the registry", async () => {
  const root = await fixture()
  try {
    const patch = { path: "src/add.ts", search: "return a - b", replace: "return a + b" }
    const { result } = await run(root, [
      call("p1", "apply_patch", patch),
      call("p2", "apply_patch", patch),
      answer("add returns the sum."),
    ], "Fix src/add.ts so add returns the sum.", countingRegistry(root))
    assert.ok(result.toolCalls.filter((item) => item.name === "apply_patch").every((item) => item.alreadyObserved !== true))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a repeated lookup names only requested edit targets, never files the request said to read", async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, "AGENTS.md"), "# Rules\n")
    let replay = ""
    await run(root, [
      call("l1", "list_directory", { path: "." }),
      call("l2", "list_directory", { path: "." }),
      (request) => { replay = JSON.stringify(request.messages); return answer("Not done.") },
    ], "Read AGENTS.md first. Then fix src/add.ts so add returns the sum.", countingRegistry(root))
    assert.match(replay, /src\/add\.ts as a file to create or update/)
    assert.doesNotMatch(replay, /AGENTS\.md as a file to create or update/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a lookup refused for path traversal is never cached: each repeat is checked and refused again", async () => {
  const root = await fixture()
  try {
    const { result } = await run(root, [
      call("t1", "list_directory", { path: "../" }),
      call("t2", "list_directory", { path: "../" }),
      answer("That path is outside the workspace."),
    ], "List the parent directory. Do not edit files.", countingRegistry(root))
    const calls = result.toolCalls.filter((item) => item.name === "list_directory")
    assert.equal(calls.length, 2)
    assert.ok(calls.every((item) => item.outcome !== "COMPLETED" && item.alreadyObserved !== true), JSON.stringify(calls))
    assert.equal(executions(result, "list_directory"), 2, "the second call was evaluated, not answered from a cache")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed lookup (missing path) is not cached, so it can succeed once the path exists", async () => {
  const root = await fixture()
  try {
    const { result } = await run(root, [
      call("m1", "list_directory", { path: "lib" }),
      () => {
        mkdirSync(join(root, "lib"))
        writeFileSync(join(root, "lib/new.ts"), "export {}\n")
        return call("m2", "list_directory", { path: "lib" })
      },
      answer("lib now has new.ts."),
    ], "What is in lib? Do not edit files.", countingRegistry(root))
    assert.equal(result.toolCalls.find((item) => item.id === "m1")?.outcome, "FAILED")
    const second = result.observations?.find((item) => item.callId === "m2")
    assert.equal(second?.ok, true)
    assert.notEqual(second?.alreadyObserved, true)
    assert.match(String(second?.content), /lib\/new\.ts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a lookup the permission policy denies is never answered from the registry", async () => {
  const root = await fixture()
  try {
    const provider = new ScriptedModelProvider([
      call("d1", "search_text", { query: "add" }),
      call("d2", "search_text", { query: "add" }),
      answer("Search is not allowed here."),
    ])
    const agent = new AgentRunner({ provider, registry: countingRegistry(root), eventFactory: events, permissionEvaluator: (input) => input.action === "search_repository" ? "DENY" : "ALLOW" })
    const result = await agent.run({ task: { id: "task", mode: "BUILD", instruction: "Where is add defined? Do not edit files." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: budget, projectInstructions: [] })
    const searches = result.toolCalls.filter((item) => item.name === "search_text")
    assert.ok(searches.every((item) => item.outcome === "DENIED" && item.alreadyObserved !== true), JSON.stringify(searches))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
