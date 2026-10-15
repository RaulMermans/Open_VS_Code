/**
 * Sprint 5D closure of Sprint 5C: progress epochs. Repetition counters are scoped to the current
 * epoch, so an old action or error seen again after measurable progress does not inherit a stale
 * count, while genuine loops (and the same stall after recovery) are still caught.
 */
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelResponse } from "../../src/contracts/model.ts"
import type { ProgressSnapshot } from "../../src/progress/contracts.ts"
import { DirectProgressGuard } from "../../src/progress/direct-guard.ts"
import { setFingerprint } from "../../src/progress/fingerprint.ts"
import { ProgressMonitor, initialMonitorState } from "../../src/progress/monitor.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"

const readA = { name: "read_file", args: { path: "a.ts" }, ok: true, content: "export const a = 1" }
const readB = { name: "read_file", args: { path: "b.ts" }, ok: true, content: "export const b = 2" }
const write = (hash: string) => ({ name: "write_file", args: { path: "c.ts", hash }, ok: true, content: "written", mutation: { path: "c.ts", beforeHash: "h0", afterHash: hash } })
const failingRun = (failed: number) => ({ name: "run_command", args: { command: "npm test", failed }, ok: false, content: `not ok 1 - x\n# pass 0\n# fail ${failed}`, errorCategory: "COMMAND_FAILED" })
const missing = (n: number) => ({ name: "read_file", args: { path: `gone-${n}.ts` }, ok: false, content: "ENOENT: no such file", errorCategory: "NOT_FOUND" })

test("EP-01: A → meaningful workspace change → A does not stall", () => {
  const guard = new DirectProgressGuard()
  assert.deepEqual(guard.observeTool(readA), [])
  assert.deepEqual(guard.observeTool(write("h1")), [])
  assert.equal(guard.epoch, 2)
  assert.deepEqual(guard.observeTool(readA), [], "the re-read after a real change starts a fresh count")
  // Control: without the change the same re-read is a repeat.
  const control = new DirectProgressGuard()
  control.observeTool(readA)
  assert.equal(control.observeTool(readA)[0]?.kind, "REPEATED_TOOL_ACTION")
})

test("EP-02: same error → fewer failed checks → same error does not inherit the old count", () => {
  const guard = new DirectProgressGuard()
  guard.observeTool(failingRun(3))
  assert.deepEqual(guard.observeTool(missing(1)), [])
  assert.deepEqual(guard.observeTool(failingRun(1)), [], "3 → 1 failed checks is measurable progress")
  assert.equal(guard.epochReasons.at(-1), "FAILED_CHECKS_REDUCED")
  assert.deepEqual(guard.observeTool(missing(2)), [], "the same error after progress starts at one")
  // Control: no progress in between → the repeated error is detected.
  const control = new DirectProgressGuard()
  control.observeTool(missing(1))
  assert.equal(control.observeTool(missing(2))[0]?.kind, "REPEATED_ERROR")
})

test("EP-02b: a workspace change is not progress for a failure that survives it (repair did not help)", () => {
  const guard = new DirectProgressGuard()
  guard.observeTool(failingRun(2))
  guard.observeTool(write("h1"))
  const signals = guard.observeTool(failingRun(2))
  assert.equal(signals[0]?.kind, "REPEATED_TOOL_ACTION", "edit → identical failing run is still a stall")
})

test("EP-05: A → B → A → B without durable progress is still detected", () => {
  const guard = new DirectProgressGuard()
  guard.observeTool(readA)
  guard.observeTool(readB)
  assert.equal(guard.epoch, 1, "first-time reads are evidence, not an epoch boundary")
  assert.equal(guard.observeTool(readA)[0]?.kind, "REPEATED_TOOL_ACTION")
})

test("EP-06: global safety state survives an epoch advance", () => {
  const guard = new DirectProgressGuard()
  guard.recoveryCount = 1
  guard.observeTool(readA)
  assert.equal(guard.epochReasons.at(-1), "EVIDENCE_AFTER_RECOVERY")
  guard.observeTool(write("h1"))
  assert.equal(guard.recoveryCount, 1, "the consumed recovery attempt is never refunded")
})

const snap = (patch: Partial<ProgressSnapshot>): ProgressSnapshot => ({ workflowId: "wf", stage: "TEST", point: "TEST", changedFileHashes: {}, timestamp: "t", ...patch })

test("EP-07: workflow monitor — an old error after an ADVANCED observation is not an inherited repeat", () => {
  const monitor = new ProgressMonitor()
  monitor.observe(snap({ failingCheckCount: 3, testFingerprint: setFingerprint(["a", "b", "c"])!, errorFingerprint: "E" }))
  const before = monitor.state.epoch!
  const after = monitor.observe(snap({ failingCheckCount: 1, testFingerprint: setFingerprint(["a"])!, errorFingerprint: "E" }))
  assert.equal(after.status, "ADVANCED")
  assert.deepEqual(after.signals, [])
  assert.equal(monitor.state.epoch, before + 1)
  // Without progress the same error after a repair is still caught.
  const stuck = new ProgressMonitor()
  stuck.observe(snap({ failingCheckCount: 2, testFingerprint: "t", errorFingerprint: "E" }))
  stuck.observe({ ...snap({ diffFingerprint: "d2" }), stage: "IMPLEMENT", point: "MUTATION" })
  assert.ok(stuck.observe(snap({ failingCheckCount: 2, testFingerprint: "t", errorFingerprint: "E" })).signals.length > 0)
  // States persisted before epochs existed restore cleanly.
  const { epoch: _epoch, ...legacy } = initialMonitorState()
  const restored = new ProgressMonitor({ state: legacy })
  restored.observe(snap({ failingCheckCount: 1, testFingerprint: "x" }))
  assert.equal(restored.state.epoch, 2, "a legacy state starts at epoch 1 and advances normally")
})

// ---- runner-level: recovery interaction --------------------------------------------------------

const workspaceRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const contextBudget = calculateBudget({ contextWindow: 4_000, reservedOutput: 200, reservedToolHistory: 200 })
const reply = (content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse => ({ model: "scripted", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}) })
const read = (id: string, path: string) => reply("read", [{ id, name: "read_file", arguments: { path } }])
const run = (steps: ModelResponse[]) =>
  new AgentRunner({ provider: new ScriptedModelProvider(steps), registry: createReadOnlyToolRegistry(), runtimeEvals: false, progressMonitor: { enabled: true } })
    .run({ task: { id: "task-epoch", mode: "BUILD", instruction: "Inspect" }, workspaceRoot, maxTurns: 10, contextBudget, projectInstructions: [] })

test("EP-03: stall → recovery → measurable progress → old action reused does not BLOCK", async () => {
  const result = await run([read("a", "README.md"), read("b", "README.md"), read("c", "src/index.ts"), read("d", "README.md"), reply("Done.")])
  assert.equal(result.status, "COMPLETED")
  assert.equal(result.nonProgress?.recoveryCount, 1)
  assert.equal(result.nonProgress?.finalBlocker, undefined, "no immediate BLOCK after real progress")
  assert.equal(result.nonProgress?.recoveryOutcome, "RECOVERED")
})

test("EP-04: stall → recovery → the same stall with no progress is BLOCKED_NON_PROGRESS", async () => {
  const result = await run([read("a", "README.md"), read("b", "README.md"), read("c", "README.md"), reply("unreachable")])
  assert.equal(result.failureReason, "NON_PROGRESS")
  assert.equal(result.nonProgress?.finalBlocker?.kind, "BLOCKED_NON_PROGRESS")
  assert.equal(result.nonProgress?.recoveryCount, 1)
})
