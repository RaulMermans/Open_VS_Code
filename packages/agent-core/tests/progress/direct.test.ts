/**
 * Sprint 5C: the lighter non-progress guard on the direct AgentRunner path (ADR-031).
 */
import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

const workspaceRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const contextBudget = calculateBudget({ contextWindow: 4_000, reservedOutput: 200, reservedToolHistory: 200 })
const task = { id: "task-np", mode: "BUILD" as const, instruction: "Inspect the fixture" }

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return { model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) }
}

const read = (id: string, path: string) => response("read", [{ id, name: "read_file", arguments: { path } }])

/** A model that cycles through `paths` forever (A, B, A, B, …): invisible to a consecutive-repeat guard. */
function cycling(paths: readonly string[]): (request: ModelRequest) => ModelResponse {
  let turn = 0
  return () => {
    turn += 1
    return read(`c${turn}`, paths[(turn - 1) % paths.length]!)
  }
}

function runner(steps: ConstructorParameters<typeof ScriptedModelProvider>[0], enabled: boolean): { runner: AgentRunner; provider: ScriptedModelProvider } {
  const provider = new ScriptedModelProvider(steps)
  let event = 0
  return {
    provider,
    runner: new AgentRunner({
      provider,
      registry: createReadOnlyToolRegistry(),
      runtimeEvals: false,
      eventFactory: { createId: () => `event-${++event}`, now: () => "2026-10-14T12:00:00.000Z" },
      ...(enabled ? { progressMonitor: { enabled: true } } : {}),
    }),
  }
}

const input = (maxTurns = 15) => ({ task, workspaceRoot, maxTurns, contextBudget, projectInstructions: [] })

test("NP-D-01: a non-consecutive A/B/A/B loop runs to the turn limit without the guard and is stopped early with it", async () => {
  const step = cycling(["README.md", "src/index.ts"])
  const baseline = runner(Array.from({ length: 15 }, () => step), false)
  const off = await baseline.runner.run(input())
  assert.equal(off.failureReason, "MAX_TURNS_EXCEEDED", "the consecutive-repeat guard cannot see the cycle")
  assert.equal(off.turns, 15)
  assert.equal(off.nonProgress, undefined)

  const step2 = cycling(["README.md", "src/index.ts"])
  const guarded = runner(Array.from({ length: 15 }, () => step2), true)
  const on = await guarded.runner.run(input())
  assert.equal(on.failureReason, "NON_PROGRESS")
  assert.equal(on.terminationSource, "NON_PROGRESS_GUARD")
  assert.equal(on.nonProgress?.recoveryCount, 1, "one bounded recovery turn")
  assert.equal(on.nonProgress?.recoveryOutcome, "NOT_RECOVERED")
  assert.equal(on.nonProgress?.finalBlocker?.kind, "BLOCKED_NON_PROGRESS")
  assert.equal(on.nonProgress?.recoveryPlan?.failureClass, "CONTEXT_DEGRADATION")
  assert.ok(on.turns <= 5, `stopped after ${on.turns} turns`)
  assert.ok(on.events.some((event) => event.type === "recovery.non_progress"))
  const last = on.events.at(-1)!.payload as { message?: string }
  assert.match(String(last.message), /^Blocked after bounded recovery/)
})

test("NP-D-02: the recovery turn sees each observation once plus one bounded recovery directive", async () => {
  const seen: string[] = []
  const steps = [
    read("a", "README.md"),
    read("b", "README.md"),
    (request: ModelRequest) => {
      seen.push(request.messages[0]!.content)
      return response("The fixture README describes the project.")
    },
  ]
  const { runner: r } = runner(steps, true)
  const result = await r.run(input())
  assert.equal(result.status, "COMPLETED")
  const prompt = seen[0]!
  assert.ok(prompt.includes("NON_PROGRESS_RECOVERY"))
  assert.ok(prompt.includes("Do not repeat the previous call"))
  assert.equal(result.nonProgress?.observationsDropped, 1, "the repeated observation was dropped")
  // No new evidence was gathered after the recovery, so it is not claimed as recovered.
  assert.equal(result.nonProgress?.recoveryOutcome, "NOT_RECOVERED")
})

test("NP-D-03: recovery is RECOVERED only when new evidence follows it", async () => {
  const steps = [
    read("a", "README.md"),
    read("b", "README.md"),
    read("c", "src/index.ts"),
    response("index.ts exports greet."),
  ]
  const { runner: r } = runner(steps, true)
  const result = await r.run(input())
  assert.equal(result.status, "COMPLETED")
  assert.equal(result.nonProgress?.recoveryOutcome, "RECOVERED")
})

test("NP-D-04: repeated identical tool errors with different arguments stop with a TOOL_FAILURE report", async () => {
  const bad = (id: string, n: number) => response("x", [{ id, name: "read_file", arguments: { path: `missing-${n}.ts` } }])
  const steps = Array.from({ length: 15 }, (_, index) => bad(`e${index}`, index))
  const { runner: off } = runner(steps, false)
  const baseline = await off.run(input())
  const { runner: on } = runner(Array.from({ length: 15 }, (_, index) => bad(`e${index}`, index)), true)
  const guarded = await on.run(input())
  assert.equal(guarded.failureReason, "NON_PROGRESS")
  assert.ok(guarded.turns < baseline.turns, `${guarded.turns} < ${baseline.turns}`)
  assert.ok(["TOOL_FAILURE", "STATE_MISMATCH", "UNKNOWN"].includes(guarded.nonProgress!.recoveryPlan!.failureClass), guarded.nonProgress!.recoveryPlan!.failureClass)
})

test("NP-D-05: productive direct work is never interrupted", async () => {
  const steps = [read("a", "README.md"), read("b", "src/index.ts"), read("c", "src/nested/value.ts"), response("Done.")]
  const { runner: r } = runner(steps, true)
  const result = await r.run(input())
  assert.equal(result.status, "COMPLETED")
  assert.equal(result.nonProgress, undefined)
})

test("NP-D-06: the direct guard grants nothing: a denied tool stays denied and repeated denials stop as PERMISSION_BLOCK", async () => {
  const provider = new ScriptedModelProvider(Array.from({ length: 6 }, (_, index) => read(`d${index}`, `f${index}.ts`)))
  const r = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), runtimeEvals: false, permissionEvaluator: () => "DENY", progressMonitor: { enabled: true } })
  const result = await r.run(input())
  assert.equal(result.failureReason, "NON_PROGRESS")
  assert.equal(result.nonProgress?.recoveryPlan?.failureClass, "PERMISSION_BLOCK")
  assert.equal(result.nonProgress?.recoveryCount, 0, "a permission block is escalated, not retried")
  assert.ok(result.toolCalls.every((call) => call.outcome === "DENIED"))
})

test("NP-D-07: turn exhaustion without new evidence is reported as a bounded blocker", async () => {
  const steps = [read("a", "README.md"), read("b", "src/index.ts")]
  const { runner: r } = runner(steps, true)
  const result = await r.run(input(2))
  assert.equal(result.failureReason, "MAX_TURNS_EXCEEDED")
  assert.equal(result.nonProgress, undefined, "the last turns produced new evidence: no non-progress claim")
  // The same content through different paths: valid calls, but no new evidence after turn 1.
  const { runner: r2 } = runner([read("a", "README.md"), read("b", "./README.md"), read("c", "src/../README.md")], true)
  const exhausted = await r2.run(input(3))
  assert.equal(exhausted.failureReason, "MAX_TURNS_EXCEEDED", "the turn-limit outcome is unchanged")
  assert.equal(exhausted.nonProgress?.finalBlocker?.kind, "BLOCKED_NON_PROGRESS")
  assert.equal(exhausted.nonProgress?.finalBlocker?.failureClass, "CONTEXT_DEGRADATION")
  assert.match(exhausted.nonProgress!.finalBlocker!.repeatedPattern, /turn budget ran out after 2 turn\(s\) without new evidence/)
})

test("NP-D-08: cancellation supersedes the direct guard", async () => {
  const controller = new AbortController()
  const steps = [read("a", "README.md"), () => (controller.abort(), read("b", "README.md"))]
  const provider = new ScriptedModelProvider(steps)
  const r = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), runtimeEvals: false, progressMonitor: { enabled: true } })
  const result = await r.run({ ...input(), signal: controller.signal })
  assert.equal(result.status, "CANCELLED")
  assert.equal(result.nonProgress?.recoveryCount ?? 0, 0)
  assert.equal(provider.requests.length, 2, "no recovery turn after cancellation")
})
