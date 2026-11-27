import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createCodeIntelligenceToolRegistrations } from "../../src/tools/code-intelligence.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { TypeScriptCodeIntelligence } from "../../src/tools/typescript-code-intelligence.ts"

// Sprint 33: S34-01 answers named invalidateProducts but never its caller updateProduct (4/4, both models).
const contextBudget = calculateBudget({ contextWindow: 4_000, reservedOutput: 200, reservedToolHistory: 200 })
const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022", allowImportingTsExtensions: true, noEmit: true } }),
  "src/cache/products.ts": "export const TTL_SECONDS = 300\nlet cached: string[] | undefined\nexport function invalidateProducts(): void {\n  cached = undefined\n}\n",
  "src/admin.ts": "import { invalidateProducts } from \"./cache/products.ts\"\n\nexport function updateProduct(name: string): string {\n  invalidateProducts()\n  return name\n}\n",
}

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

async function run(mode: "ASK" | "BUILD", steps: Array<ModelResponse | ((request: ModelRequest) => ModelResponse)>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "check-callers-")))
  try {
    for (const [path, body] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), body)
    }
    const registry = createReadOnlyToolRegistry()
    for (const registration of createCodeIntelligenceToolRegistrations(new TypeScriptCodeIntelligence(root))) registry.register(registration)
    const runner = new AgentRunner({ provider: new ScriptedModelProvider(steps), registry })
    return await runner.run({
      task: { id: "callers", mode, instruction: "How long are products cached, and what clears that cache? Name the file and function for each." },
      workspaceRoot: root,
      maxTurns: 8,
      contextBudget,
      projectInstructions: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const readDefinition = response("read", [{ id: "r1", name: "read_file", arguments: { path: "src/cache/products.ts" } }])
const draft = response("Products are cached for 300 seconds (`TTL_SECONDS` in src/cache/products.ts). `invalidateProducts()` clears it.")

for (const mode of ["BUILD", "ASK"] as const) {
  test(`${mode}: an answer naming a function shown its callers in files the agent never read`, async () => {
    const result = await run(mode, [
      readDefinition,
      draft,
      (request) => {
        const blob = request.messages.map((message) => message.content).join("\n")
        assert.match(blob, /CHECK CALLERS/)
        assert.match(blob, /src\/admin\.ts/)
        return response("Cached 300 s (TTL_SECONDS). updateProduct in src/admin.ts calls invalidateProducts, which clears it.")
      },
    ])
    assert.equal(result.status, "COMPLETED")
    assert.match(result.finalAnswer ?? "", /updateProduct/)
    assert.ok(result.toolCalls.some((call) => call.name === "find_symbol"))
  })
}

test("no extra turn when every reference is in a file already read", async () => {
  const result = await run("BUILD", [
    readDefinition,
    response("read", [{ id: "r2", name: "read_file", arguments: { path: "src/admin.ts" } }]),
    response("Cached 300 s (`TTL_SECONDS`); `updateProduct` in src/admin.ts calls `invalidateProducts`."),
  ])
  assert.equal(result.status, "COMPLETED")
  assert.match(result.finalAnswer ?? "", /updateProduct/)
})
