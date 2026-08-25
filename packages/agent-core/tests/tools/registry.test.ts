import assert from "node:assert/strict"
import test from "node:test"

import type { ToolRegistration } from "../../src/tools/registry.ts"
import { ToolRegistry, ToolRegistryError } from "../../src/tools/registry.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import type { ToolCall } from "../../src/contracts/tools.ts"

function echoRegistration(executions: unknown[]): ToolRegistration {
  return {
    definition: {
      name: "echo",
      description: "Return one value.",
      action: "read_repository",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("arguments must be an object")
      const record = input as Record<string, unknown>
      if (typeof record.value !== "string") throw new TypeError("value must be a string")
      if (Object.keys(record).some((key) => key !== "value")) throw new TypeError("unexpected argument")
      return { value: record.value }
    },
    execute: async (input, context) => {
      executions.push(input)
      assert.equal(context.workspaceRoot, "C:/fixture")
      return input.value
    },
  }
}

test("registers unique tools and exposes sorted definitions without implementations", () => {
  const registry = new ToolRegistry()
  registry.register(echoRegistration([]))
  registry.register({ ...echoRegistration([]), definition: { ...echoRegistration([]).definition, name: "alpha" } })

  assert.deepEqual(registry.listDefinitions().map((tool) => tool.name), ["alpha", "echo"])
  assert.equal("execute" in registry.listDefinitions()[0]!, false)
  assert.throws(() => registry.register(echoRegistration([])), (error: unknown) => {
    assert.equal((error as ToolRegistryError).code, "DUPLICATE_TOOL")
    return true
  })
})

test("rejects unknown and malformed calls before execution", async () => {
  const executions: unknown[] = []
  const registry = new ToolRegistry([echoRegistration(executions)])

  assert.throws(() => registry.prepare({ id: "call-1", name: "missing", arguments: {} }), { code: "UNKNOWN_TOOL" })
  for (const argumentsValue of [undefined, null, {}, { value: 1 }, { value: "ok", hidden: true }]) {
    assert.throws(() => registry.prepare({ id: "call-2", name: "echo", arguments: argumentsValue }), { code: "INVALID_ARGUMENTS" })
  }
  assert.deepEqual(executions, [])

  const prepared = registry.prepare({ id: "call-3", name: "echo", arguments: { value: "hello" } })
  assert.equal(await prepared.invoke({ workspaceRoot: "C:/fixture", signal: new AbortController().signal }), "hello")
  assert.deepEqual(executions, [{ value: "hello" }])
})

test("the production read-only registry exposes only compact repository tools", () => {
  const definitions = createReadOnlyToolRegistry().listDefinitions()
  assert.deepEqual(definitions.map((tool) => tool.name), ["find_files", "list_directory", "read_file", "search_text"])
  assert.deepEqual(definitions.map((tool) => tool.action), ["search_repository", "read_repository", "read_repository", "search_repository"])
  assert.equal(definitions.every((tool) => tool.description.length < 100), true)
  assert.equal(JSON.stringify(definitions).includes(process.cwd()), false)
})

test("aborted prepared calls never reach the executor", async () => {
  const executions: unknown[] = []
  const registry = new ToolRegistry([echoRegistration(executions)])
  const prepared = registry.prepare({ id: "call-4", name: "echo", arguments: { value: "hello" } })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(prepared.invoke({ workspaceRoot: "C:/fixture", signal: controller.signal }), { name: "AbortError" })
  assert.deepEqual(executions, [])
})

test("rejects malformed tool-call payloads without dereferencing them", () => {
  const registry = new ToolRegistry([echoRegistration([])])
  for (const malformed of [null, [], {}, { id: 1, name: "echo", arguments: {} }, { id: "call", arguments: {} }]) {
    assert.throws(() => registry.prepare(malformed as unknown as ToolCall), { code: "MALFORMED_TOOL_CALL" })
  }
})
