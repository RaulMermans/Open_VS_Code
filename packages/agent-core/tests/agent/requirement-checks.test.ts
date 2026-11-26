import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { requirementGaps } from "../../src/agent/requirement-checks.ts"
import { isTestArtifactPath } from "../../src/agent/tool-contract.ts"
import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { ToolRegistry } from "../../src/tools/registry.ts"

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-reqs-"))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  return root
}

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

const check = (root: string, instruction: string, appliedPaths: string[]) => requirementGaps({ workspaceRoot: root, instruction, appliedPaths, isTestPath: isTestArtifactPath })

test("a requested rename that was not carried out is reported; an unrelated local helper with the same name is not", async () => {
  const root = await fixture({
    "src/money.ts": "export function toCents(v: number) {\n  return Math.round(v * 100)\n}\n",
    "src/cart.ts": "import { toCents } from './money.ts'\nexport const total = (v: number) => toCents(v)\n",
    "src/legacy.ts": "function toCents(s: string) {\n  return s.length\n}\nexport const size = toCents\n",
  })
  try {
    const instruction = "Rename toCents to amountInCents in src/money.ts and update its importers."
    const gaps = await check(root, instruction, ["src/money.ts"])
    assert.equal(gaps.length, 1)
    assert.match(gaps[0]!, /rename of toCents to amountInCents is not done/)
    assert.match(gaps[0]!, /src\/money\.ts:1/)
    assert.match(gaps[0]!, /src\/cart\.ts:1/)
    assert.doesNotMatch(gaps[0]!, /legacy/)
    await writeFile(join(root, "src/money.ts"), "export function amountInCents(v: number) {\n  return Math.round(v * 100)\n}\n")
    await writeFile(join(root, "src/cart.ts"), "import { amountInCents } from './money.ts'\nexport const total = (v: number) => amountInCents(v)\n")
    assert.deepEqual(await check(root, instruction, ["src/money.ts", "src/cart.ts"]), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("requested tests must exist, and a named helper that is imported must also be used", async () => {
  const root = await fixture({
    "lib/text.py": "def shout_text(s):\n    return s.upper()\n",
    "app/view.py": "from lib.text import shout_text\n\ndef render(s):\n    return s\n",
  })
  try {
    const instruction = "Add a shout_text helper in lib/text.py, call it from render in app/view.py, and write unit tests for it."
    const gaps = await check(root, instruction, ["lib/text.py", "app/view.py"])
    assert.ok(gaps.some((gap) => /asks for tests/.test(gap)))
    assert.ok(gaps.some((gap) => /shout_text is imported in app\/view\.py but never used/.test(gap)))
    await writeFile(join(root, "app/view.py"), "from lib.text import shout_text\n\ndef render(s):\n    return shout_text(s)\n")
    await writeFile(join(root, "tests/test_text.py"), "def test_shout_text():\n    assert True\n").catch(async () => {
      await mkdir(join(root, "tests"))
      await writeFile(join(root, "tests/test_text.py"), "def test_shout_text():\n    assert True\n")
    })
    assert.deepEqual(await check(root, instruction, ["lib/text.py", "app/view.py", "tests/test_text.py"]), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a partially done request is nudged with the specific gap and never completes while the gap remains", async () => {
  const root = await fixture({ "src/money.ts": "export function toCents(v: number) {\n  return Math.round(v * 100)\n}\n" })
  const provider = new ScriptedModelProvider([
    response("", [{ id: "p1", name: "apply_patch", arguments: { path: "src/money.ts", search: "return Math.round(v * 100)", replace: "return Math.round(v * 100) | 0" } }]),
    response("Done: renamed and updated."),
    response("Done."),
    response("Done."),
    response("Done."),
  ])
  try {
    const runner = new AgentRunner({ provider, registry: new ToolRegistry([...createMutationToolRegistrations({ engine: new MutationEngine(root) })]), eventFactory: { createId: () => "e", now: () => "2026-11-16T12:00:00.000Z" } })
    let result = await runner.run({ task: { id: "t", mode: "BUILD", instruction: "Rename toCents to amountInCents in src/money.ts." }, workspaceRoot: root, maxTurns: 8, contextBudget: calculateBudget({ contextWindow: 8_000, reservedOutput: 400, reservedToolHistory: 400 }), projectInstructions: [] })
    for (let i = 0; result.status === "PAUSED" && i < 6; i += 1) result = await runner.resume("APPROVE")
    assert.notEqual(result.status, "COMPLETED")
    assert.match(result.finalAnswer ?? "", /rename of toCents to amountInCents is not done/)
    assert.ok(provider.requests.some((request) => JSON.stringify(request.messages).includes("NOT DONE YET")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function gapsFor(files: Record<string, string>, instruction: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-rename-protected-"))
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true })
      await writeFile(join(root, rel), content)
    }
    return await requirementGaps({ workspaceRoot: root, instruction, appliedPaths: Object.keys(files), isTestPath: isTestArtifactPath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("a protected file's same-named symbol, and imports from it, are not rename work", async () => {
  const ts = {
    "src/dates.ts": "export function displayDate(d: Date): string { return d.toISOString() }\n",
    "src/view.ts": "import { displayDate } from \"./dates.ts\"\nexport const show = (d: Date) => displayDate(d)\n",
    "lib/old/format.ts": "export function formatDate(s: string): string { return s.trim() }\n",
    "test/view.test.ts": "import { formatDate as legacyFormat } from \"../lib/old/format.ts\"\nimport { displayDate } from \"../src/dates.ts\"\nlegacyFormat(displayDate(new Date(0)))\n",
  }
  assert.deepEqual(await gapsFor(ts, "Rename formatDate to displayDate in src. lib/old/format.ts keeps its own formatDate; leave it alone."), [])
  const py = {
    "billing/core.py": "def net_amount(lines):\n    return sum(lines)\n",
    "billing/api.py": "from .core import net_amount\n\n\ndef total(lines):\n    return net_amount(lines)\n",
    "billing/archive.py": "def gross(rows):\n    return sum(rows)\n",
    "billing/report.py": "from .archive import gross as archived\n\n\ndef old(rows):\n    return archived(rows)\n",
  }
  assert.deepEqual(await gapsFor(py, "Rename gross to net_amount in billing. Never edit billing/archive.py."), [])
})

test("an unrenamed caller outside protected files is still reported", async () => {
  const gaps = await gapsFor({
    "billing/core.py": "def net_amount(lines):\n    return sum(lines)\n",
    "billing/api.py": "from billing.core import gross\n\n\ndef total(lines):\n    return gross(lines)\n",
    "billing/archive.py": "def gross(rows):\n    return sum(rows)\n",
  }, "Rename gross to net_amount. Do not edit billing/archive.py.")
  assert.equal(gaps.length, 1)
  assert.match(gaps[0]!, /billing\/api\.py:1/)
})
