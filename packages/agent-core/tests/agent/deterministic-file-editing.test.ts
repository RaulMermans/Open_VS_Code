import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { readRepositoryFile } from "../../src/tools/read-file.ts"
import { ToolRegistry, type ToolRegistration } from "../../src/tools/registry.ts"

const budget = calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 })

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

function readTool(): ToolRegistration {
  return {
    definition: { name: "read_file", description: "Read one repository file.", action: "read_repository", inputSchema: { type: "object" } },
    validate: (input) => {
      const path = input && typeof input === "object" && !Array.isArray(input) ? (input as { path?: unknown }).path : undefined
      if (typeof path !== "string" || !path.trim()) throw new TypeError("path must be a non-empty string")
      return { path }
    },
    execute: (input, context) => readRepositoryFile(context.workspaceRoot, input.path as string),
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-edit-20-"))
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src/add.ts"), "export function add(left: number, right: number) {\n  return left - right\n}\n")
  await writeFile(join(root, "src/format.ts"), "export function formatName(first: string, last: string): string {\n  return `${first} ${last}`\n}\n")
  await writeFile(join(root, "src/greet.ts"), "export function greet(first: string, last: string): string {\n  throw new Error('not implemented')\n}\n")
  return root
}

function registry(root: string): ToolRegistry {
  const engine = new MutationEngine(root)
  return new ToolRegistry([readTool(), ...createMutationToolRegistrations({ engine })])
}

function agent(provider: ScriptedModelProvider, tools: ToolRegistry): AgentRunner {
  return new AgentRunner({
    provider,
    registry: tools,
    eventFactory: { createId: () => "event", now: () => "2026-11-14T12:00:00.000Z" },
  })
}

test("create_file on a missing file succeeds after approval", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "create", name: "create_file", arguments: { path: "src/clamp.ts", content: "export function clamp(n: number, min: number, max: number) {\n  return Math.min(max, Math.max(min, n))\n}\n" } }]),
    response("created clamp"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const paused = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Create the file src/clamp.ts exporting clamp." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    const result = await runner.resume("APPROVE")
    assert.equal(result.status, "COMPLETED")
    assert.match(await readFile(join(root, "src/clamp.ts"), "utf8"), /export function clamp/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("create_file on an existing file never overwrites it", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "create", name: "create_file", arguments: { path: "src/add.ts", content: "destroyed\n" } }]),
    response("stopped"),
  ])
  try {
    const runner = agent(provider, registry(root))
    await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 3,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("existing identical content produces no duplicate write", async () => {
  const root = await workspace()
  const content = "export function add(left: number, right: number) {\n  return left + right\n}\n"
  await writeFile(join(root, "src/add.ts"), content)
  const provider = new ScriptedModelProvider([
    response("", [{ id: "create", name: "create_file", arguments: { path: "src/add.ts", content } }]),
    response("already correct"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const paused = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    const result = await runner.resume("APPROVE")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), content)
    assert.equal(result.toolCalls.some((call) => call.name === "create_file" && call.outcome === "COMPLETED"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("wrong-tool selection produces actionable correction feedback", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "create", name: "create_file", arguments: { path: "src/add.ts", content: "destroyed\n" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /FILE_ALREADY_EXISTS: create_file cannot overwrite src\/add\.ts/)
      assert.match(request.messages[0]!.content, /apply_patch/)
      assert.match(request.messages[0]!.content, /return left - right/)
      return response("need a patch")
    },
  ])
  try {
    const runner = agent(provider, registry(root))
    await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 3,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the agent can recover from create_file by using apply_patch", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "create", name: "create_file", arguments: { path: "src/add.ts", content: "destroyed\n" } }]),
    (request) => {
      assert.match(request.messages[0]!.content, /FILE_ALREADY_EXISTS/)
      return response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }])
    },
    response("fixed"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const paused = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    assert.equal(paused.confirmation?.toolName, "apply_patch")
    const result = await runner.resume("APPROVE")
    assert.equal(result.status, "COMPLETED")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), "export function add(left: number, right: number) {\n  return left + right\n}\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a repeated invalid create does not loop indefinitely", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "c1", name: "create_file", arguments: { path: "src/add.ts", content: "nope\n" } }]),
    response("", [{ id: "c2", name: "create_file", arguments: { path: "src/add.ts", content: "still nope\n" } }]),
    response("should not run"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const result = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 8,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(result.status, "FAILED")
    assert.equal(result.failureReason, "INCOMPLETE")
    assert.match(result.finalAnswer ?? "", /repeated tool-contract error/)
    assert.equal(provider.requests.length, 2)
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stale-file changes prevent unsafe patch application", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response("done"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const paused = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    await writeFile(join(root, "src/add.ts"), "export function add(left: number, right: number) {\n  return left * right\n}\n")
    const result = await runner.resume("APPROVE")
    assert.notEqual(result.status, "COMPLETED")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), "export function add(left: number, right: number) {\n  return left * right\n}\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejection leaves the filesystem unchanged", async () => {
  const root = await workspace()
  const before = await readFile(join(root, "src/add.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "patch", name: "apply_patch", arguments: { path: "src/add.ts", search: "return left - right", replace: "return left + right" } }]),
    response(""),
  ])
  try {
    const runner = agent(provider, registry(root))
    const paused = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Fix src/add.ts so add returns the sum." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(paused.status, "PAUSED")
    const result = await runner.resume("REJECT")
    assert.equal(result.failureReason, "REJECTED")
    assert.equal(await readFile(join(root, "src/add.ts"), "utf8"), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("path traversal remains blocked", async () => {
  const root = await workspace()
  const provider = new ScriptedModelProvider([
    response("", [{ id: "bad", name: "create_file", arguments: { path: "../pwned.ts", content: "nope\n" } }]),
    response("blocked"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const result = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Create src/safe.ts." },
      workspaceRoot: root,
      maxTurns: 3,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(["FAILED", "REJECTED"].includes(result.toolCalls[0]?.outcome ?? ""), true)
    assert.match(provider.requests[1]?.messages[0]?.content ?? "", /INVALID_PATH/)
    await assert.rejects(readFile(join(root, "..", "pwned.ts")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an extensionless TypeScript import is rejected when only a .ts file exists", async () => {
  const root = await workspace()
  const greetBefore = await readFile(join(root, "src/greet.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read", name: "read_file", arguments: { path: "src/format.ts" } }]),
    response("", [{
      id: "patch",
      name: "apply_patch",
      arguments: {
        path: "src/greet.ts",
        search: "export function greet(first: string, last: string): string {\n  throw new Error('not implemented')\n}",
        replace: "import { formatName } from './format'\nexport function greet(first: string, last: string): string {\n  return `Hello, ${formatName(first, last)}`\n}",
      },
    }]),
    response("need the .ts import"),
  ])
  try {
    const runner = agent(provider, registry(root))
    await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Implement greet in src/greet.ts using formatName from src/format.ts." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.equal(await readFile(join(root, "src/greet.ts"), "utf8"), greetBefore)
    assert.match(provider.requests.at(-1)?.messages[0]?.content ?? "", /"\.\/format" must be written "\.\/format\.ts"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const GREET_SEARCH = "export function greet(first: string, last: string): string {\n  throw new Error('not implemented')\n}"

async function patchGreetImport(root: string, specifier: string, readsBefore = 1) {
  const reads = Array.from({ length: readsBefore }, (_, index) => response("", [{ id: `read-${index}`, name: "read_file", arguments: { path: "src/format.ts" } }]))
  const provider = new ScriptedModelProvider([
    ...reads,
    response("", [{
      id: "patch",
      name: "apply_patch",
      arguments: { path: "src/greet.ts", search: GREET_SEARCH, replace: `import { formatName } from '${specifier}'\nexport function greet(first: string, last: string): string {\n  return \`Hello, \${formatName(first, last)}\`\n}` },
    }]),
    response("done"),
  ])
  const runner = agent(provider, registry(root))
  const first = await runner.run({
    task: { id: "task", mode: "BUILD", instruction: "Implement greet in src/greet.ts using formatName." },
    workspaceRoot: root,
    maxTurns: readsBefore + 3,
    contextBudget: budget,
    projectInstructions: [],
  })
  const result = first.status === "PAUSED" ? await runner.resume("APPROVE") : first
  return { provider, result, greet: await readFile(join(root, "src/greet.ts"), "utf8") }
}

test("a tsc or bundler TypeScript project accepts extensionless and .js spellings of an existing .ts file", async () => {
  for (const specifier of ["./format", "./format.js"]) {
    const root = await workspace()
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }))
      const { greet } = await patchGreetImport(root, specifier)
      assert.match(greet, new RegExp(`from '${specifier.replace(".", "\\.")}'`), specifier)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("a project that runs TypeScript natively gets the exact .ts specifier even after repeated reads", async () => {
  const root = await workspace()
  try {
    await writeFile(join(root, "tsconfig.json"), "{}")
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --experimental-strip-types --test" } }))
    const before = await readFile(join(root, "src/greet.ts"), "utf8")
    const { provider, greet } = await patchGreetImport(root, "./format", 3)
    assert.equal(greet, before)
    assert.match(provider.requests.at(-1)?.messages[0]?.content ?? "", /"\.\/format" must be written "\.\/format\.ts"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an import of a file that does not exist names the real file when exactly one matches", async () => {
  const root = await workspace()
  try {
    const before = await readFile(join(root, "src/greet.ts"), "utf8")
    const { provider, greet } = await patchGreetImport(root, "../lib/format.ts", 3)
    assert.equal(greet, before)
    assert.match(provider.requests.at(-1)?.messages[0]?.content ?? "", /"\.\.\/lib\/format\.ts" does not exist \(the named file is "\.\/format\.ts"\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a multi-file task never applies a patch to an unintended path", async () => {
  const root = await workspace()
  const formatBefore = await readFile(join(root, "src/format.ts"), "utf8")
  const greetBefore = await readFile(join(root, "src/greet.ts"), "utf8")
  const provider = new ScriptedModelProvider([
    response("", [{ id: "read-g", name: "read_file", arguments: { path: "src/greet.ts" } }]),
    response("", [{
      id: "bad-patch",
      name: "apply_patch",
      arguments: {
        path: "src/format.ts",
        search: "export function formatName(first: string, last: string): string {\n  return `${first} ${last}`\n}",
        replace: "export function formatName(first: string, last: string): string {\n  return `${first} ${last}`\n}\nexport function greet(first: string, last: string): string {\n  return `Hello, ${first}`\n}",
      },
    }]),
    response("should continue"),
  ])
  try {
    const runner = agent(provider, registry(root))
    const result = await runner.run({
      task: { id: "task", mode: "BUILD", instruction: "Implement formatName in src/format.ts and greet in src/greet.ts." },
      workspaceRoot: root,
      maxTurns: 4,
      contextBudget: budget,
      projectInstructions: [],
    })
    assert.notEqual(result.confirmation?.toolName, "apply_patch")
    assert.equal(await readFile(join(root, "src/format.ts"), "utf8"), formatBefore)
    assert.equal(await readFile(join(root, "src/greet.ts"), "utf8"), greetBefore)
    assert.match(provider.requests.at(-1)?.messages[0]?.content ?? "", /WRONG_FILE|src\/greet\.ts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
