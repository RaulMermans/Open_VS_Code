/**
 * Sprint 25: a verification command that cannot run in the workspace (missing toolchain or dependencies,
 * or a download in the no-network sandbox) is reported as blocked, not as a code failure: no request to
 * revise code, no repeated runs (each would need a new approval), and a truthful unverified outcome.
 */
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
import { createVerificationToolRegistrations, environmentBlocker } from "../../src/tools/verification-registry.ts"

const COREPACK = `! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.28.0.tgz
Error: Error when performing the request to https://registry.npmjs.org/pnpm/-/pnpm-10.28.0.tgz
  [cause]: TypeError: fetch failed`

const call = (id: string, name: string, args: Record<string, unknown>): ModelResponse => ({ model: "scripted", message: { role: "assistant", content: "" }, toolCalls: [{ id, name, arguments: args }] })

test("environment blockers are recognized only from unambiguous signals", () => {
  assert.match(environmentBlocker(COREPACK) ?? "", /package manager is not installed/)
  assert.match(environmentBlocker("> vitest run\nsh: 1: vitest: not found\n") ?? "", /vitest is not installed/)
  assert.match(environmentBlocker("/usr/bin/python3: No module named pytest") ?? "", /pytest is not installed/)
  assert.match(environmentBlocker("npm ERR! network request to https://registry.npmjs.org/x failed") ?? "", /network access/)
  // Real failures of the code stay failures.
  assert.equal(environmentBlocker("FAIL tests/a.test.ts > adds\nAssertionError: expected 1 to be 2"), undefined)
  assert.equal(environmentBlocker("src/a.ts(3,20): error TS2307: Cannot find module './missing' or its corresponding type declarations."), undefined)
  assert.equal(environmentBlocker("E   ModuleNotFoundError: No module named 'clipping_desk.helpers'"), undefined)
  assert.equal(environmentBlocker("Error: getRecord is not a function"), undefined)
})

test("through the runner: blocked verification is not a code failure, is not re-run, and the outcome says unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-s25-env-"))
  try {
    const script = `node -e "console.error(${JSON.stringify(COREPACK.split("\n")[0])}); process.exit(1)"`
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: script } }, null, 2))
    await writeFile(join(root, "add.js"), "export const add = (a, b) => a - b\n")
    const seen: string[] = []
    const answer = (request: ModelRequest): ModelResponse => { seen.push(JSON.stringify(request.messages)); return { model: "scripted", message: { role: "assistant", content: "add now returns the sum; the tests could not run in this workspace." } } }
    const steps = [
      call("p1", "apply_patch", { path: "add.js", search: "a - b", replace: "a + b" }),
      (request: ModelRequest) => { seen.push(JSON.stringify(request.messages)); return call("v2", "run_verification", { action: "TEST" }) },
      answer, answer, answer, answer, answer, answer,
    ]
    const engine = new MutationEngine(root)
    const registry = new ToolRegistry([...createMutationToolRegistrations({ engine }), ...createVerificationToolRegistrations(root)])
    const agent = new AgentRunner({ provider: new ScriptedModelProvider(steps), registry, eventFactory: { createId: () => "e", now: () => "2026-11-17T12:00:00.000Z" } })
    let result = await agent.run({ task: { id: "t", mode: "BUILD", instruction: "Fix add.js so add returns the sum and run the tests." }, workspaceRoot: root, maxTurns: UNLIMITED_MAX_TURNS, contextBudget: calculateBudget({ contextWindow: 16_000, reservedOutput: 400, reservedToolHistory: 400 }), projectInstructions: [] })
    let approvals = 0
    for (let guard = 0; result.status === "PAUSED" && guard < 10; guard += 1) {
      approvals += 1
      result = await agent.resume("APPROVE")
    }
    assert.equal(approvals, 2, "one approval for the edit, one for the single verification run")
    const ran = result.observations?.filter((item) => item.content.startsWith("Verification Status:")) ?? []
    assert.equal(ran.length, 1, "the command ran once")
    const v1 = String(ran[0]?.content)
    assert.match(v1, /Verification Status: EXECUTION_ERROR/)
    assert.match(v1, /### Diagnosis\nENVIRONMENT: verification could not run in this workspace \(the package manager is not installed/)
    assert.doesNotMatch(seen.join(""), /propose a corrective mutation/, "no request to change code for an environment problem")
    assert.equal(result.toolCalls.find((item) => item.id === "v2")?.outcome, "DENIED", "not run again")
    assert.notEqual(result.status, "COMPLETED", "an unverified change is not reported as complete")
    assert.notEqual(result.failureReason, "MODEL_ERROR", "the run ends by itself, without exhausting the model script")
    assert.equal(result.failureReason, "VERIFICATION_UNAVAILABLE")
    assert.match(result.finalAnswer ?? "", /Tests did not run because verification is unavailable\. Incomplete: the edit is unverified\. Verification could not run in this workspace: the package manager is not installed/)
    assert.doesNotMatch(result.finalAnswer ?? "", /Tests (?:passed|failed)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
