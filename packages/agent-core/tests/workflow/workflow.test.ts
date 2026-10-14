import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { createAgentRuntime } from "../../src/agent/runtime.ts"
import type { ToolAction } from "../../src/contracts/tools.ts"
import { AGENT_MODES } from "../../src/contracts/agent.ts"
import { CheckpointStore } from "../../src/recovery/checkpoint-store.ts"
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts"
import { classifyPermission } from "../../src/tools/permissions.ts"
import { ARTIFACT_LIMITS, WorkflowTransitionError, type WorkflowState } from "../../src/workflow/contracts.ts"
import { EngineeringWorkflow } from "../../src/workflow/engine.ts"
import { STAGE_ENVELOPES, assertTransition, assessWorkflowEligibility, stagePermission } from "../../src/workflow/policy.ts"
import { CheckpointWorkflowStore, createWorkspaceVerifier, workflowRunId } from "../../src/workflow/services.ts"
import { DEFAULT_WORKFLOW_POLICY } from "../../src/workflow/contracts.ts"
import {
  FakeVerifier,
  MATH_SOURCE,
  NO_FINDINGS,
  SUBTRACT_BUG,
  SUBTRACT_OK,
  StageAwareModel,
  TASK,
  drive,
  happyModel,
  harness,
  patchingImplementer,
  planReply,
  reply,
  reviewReply,
  startWorkflow,
  toolCall,
  workspace,
} from "./helpers.ts"

const WRITE_TOOLS = ["apply_patch", "create_file"]
const denyAll = () => "DENY" as const
const noTests = (input: { action: ToolAction; mode: (typeof AGENT_MODES)[number] }) => (input.action === "run_known_test" ? "DENY" : classifyPermission(input))
const toolNames = (model: StageAwareModel, index: number) => (model.requests[index]?.tools ?? []).map((tool) => tool.name)
const stageSequence = (state: WorkflowState) => state.stages.map((record) => record.stage)
const blockerFinding = {
  verdict: "FINDINGS",
  findings: [{ id: "F1", severity: "BLOCKER", file: "src/math.ts", location: "subtract", claim: "subtract returns b - a, the opposite of the acceptance criterion", evidence: "return b - a", recommendedAction: "Return a - b" }],
}

// ---- 1, 2, 25: eligibility and the feature flag -------------------------------------------------

test("W-01: an eligible mutating task with the flag on gets a workflow that starts in PLAN", async () => {
  const root = await workspace()
  const model = happyModel()
  const runtime = await createAgentRuntime({ workspaceRoot: root, mode: "BUILD", instruction: TASK, eventSink: () => {}, isTrusted: true, providerOverride: model, workflow: { enabled: true } })
  assert.equal(runtime.workflowEligibility.reason, "ELIGIBLE")
  assert.ok(runtime.workflow)
  assert.equal(runtime.workflow.state.currentStage, "PLAN")
  const result = await runtime.workflow.run()
  assert.equal(result.state.stages[0]?.stage, "PLAN")
  assert.ok(model.prompts.PLAN[0]?.includes("[Engineering workflow · PLAN stage]"))
  await runtime.cleanup()
})

test("W-02: ASK, PLAN and REVIEW modes, read-only requests and untrusted workspaces bypass the workflow", async () => {
  for (const mode of AGENT_MODES) {
    const expected = mode === "BUILD" || mode === "DEBUG" ? "ELIGIBLE" : "MODE_NOT_MUTATING"
    assert.equal(assessWorkflowEligibility({ enabled: true, mode, instruction: TASK, isTrusted: true }).reason, expected, mode)
  }
  for (const instruction of ["Explain how add works", "Where is subtract defined?", "Review only the diff in src/math.ts", "Rename it but do not modify any files", "Do a read-only audit"]) {
    assert.equal(assessWorkflowEligibility({ enabled: true, mode: "BUILD", instruction, isTrusted: true }).reason, "READ_ONLY_REQUEST", instruction)
  }
  assert.equal(assessWorkflowEligibility({ enabled: true, mode: "BUILD", instruction: TASK, isTrusted: false }).reason, "UNTRUSTED_WORKSPACE")

  const root = await workspace()
  const runtime = await createAgentRuntime({ workspaceRoot: root, mode: "ASK", instruction: "What does add do?", eventSink: () => {}, isTrusted: true, providerOverride: happyModel(), workflow: { enabled: true } })
  assert.equal(runtime.workflow, undefined)
  await runtime.cleanup()
})

test("W-25: workflow disabled (default) keeps the direct runner path unchanged", async () => {
  const root = await workspace()
  const model = new StageAwareModel({ DIRECT: () => reply("Done") })
  const runtime = await createAgentRuntime({ workspaceRoot: root, mode: "BUILD", instruction: TASK, eventSink: () => {}, isTrusted: true, providerOverride: model })
  assert.equal(runtime.workflow, undefined)
  assert.equal(runtime.workflowEligibility.reason, "DISABLED")
  const result = await runtime.runner.run(runtime.runnerInput as never)
  assert.equal(result.status, "COMPLETED")
  assert.equal(result.finalAnswer, "Done")
  assert.equal(model.prompts.DIRECT.length, 1)
  assert.ok(!model.prompts.DIRECT[0]!.includes("Engineering workflow"))
  await runtime.cleanup()
})

// ---- 3, 4, 5: PLAN ------------------------------------------------------------------------------

test("W-03: PLAN has no mutation capability, even if the model tries to write", async () => {
  const root = await workspace()
  const model = happyModel({
    PLAN: ({ turn }) => (turn === 1 ? toolCall("p1", "apply_patch", { path: "src/math.ts", search: "return a + b", replace: "return 0" }) : planReply()),
  })
  const workflow = startWorkflow(harness({ root, model }))
  const result = await workflow.run()
  assert.ok(!toolNames(model, 0).some((name) => WRITE_TOOLS.includes(name)), "write tools are not offered in PLAN")
  assert.equal(await readFile(join(root, "src/math.ts"), "utf8"), MATH_SOURCE)
  assert.equal(result.confirmation?.stage, "IMPLEMENT", "the first approval request comes from IMPLEMENT, never PLAN")
  for (const action of ["write_file", "delete_file", "terminal_command", "run_known_test"] as ToolAction[]) {
    assert.equal(stagePermission("PLAN", classifyPermission)({ action, mode: "BUILD" }), "DENY", action)
  }
})

test("W-04: the plan artifact is bounded", async () => {
  const root = await workspace()
  const huge = "x".repeat(5_000)
  const model = happyModel({
    PLAN: () => planReply({ goal: huge, files: Array.from({ length: 60 }, (_, index) => `f${index}`), steps: Array.from({ length: 60 }, () => huge), tests: [huge], risks: [huge], acceptanceCriteria: [huge] }),
  })
  const workflow = startWorkflow(harness({ root, model }))
  await workflow.run()
  const plan = workflow.state.plan!
  assert.ok(plan.goal.length <= ARTIFACT_LIMITS.textChars)
  assert.ok(plan.steps.length <= ARTIFACT_LIMITS.listItems && plan.files.length <= ARTIFACT_LIMITS.listItems)
  assert.ok(plan.steps.every((step) => step.length <= ARTIFACT_LIMITS.textChars))
  assert.ok(JSON.stringify(plan).length < 16_000)
})

test("W-05: PLAN transitions to IMPLEMENT only with an actionable plan; otherwise one retry then BLOCKED", async () => {
  const root = await workspace()
  const model = happyModel()
  const workflow = startWorkflow(harness({ root, model }))
  await workflow.run()
  assert.equal(workflow.state.currentStage, "IMPLEMENT")
  assert.deepEqual(workflow.state.completedStages, ["PLAN"])

  const bad = startWorkflow(harness({ root: await workspace(), model: happyModel({ PLAN: () => reply("I think we should add it somewhere.") }) }))
  const result = await bad.run()
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "PLAN_INVALID")
  assert.equal(result.state.retryCounts.plan, 1)
  assert.equal(stageSequence(result.state).join(","), "PLAN,PLAN")
  assert.throws(() => assertTransition({ ...result.state, currentStage: "PLAN", plan: undefined } as unknown as WorkflowState, "IMPLEMENT", DEFAULT_WORKFLOW_POLICY), WorkflowTransitionError)
})

// ---- 6, 7, 8: IMPLEMENT and approvals -----------------------------------------------------------

test("W-06/07: IMPLEMENT offers mutation tools, and a write pauses the workflow at the PermissionGate", async () => {
  const root = await workspace()
  const model = happyModel()
  const workflow = startWorkflow(harness({ root, model }))
  const paused = await workflow.run()
  assert.equal(paused.status, "WAITING_FOR_CONFIRMATION")
  assert.equal(paused.state.currentStage, "IMPLEMENT")
  assert.equal(paused.confirmation?.runner?.toolName, "apply_patch")
  assert.ok(paused.confirmation?.runner?.preparedMutation?.diff.includes("subtract"))
  assert.ok(toolNames(model, 1).includes("apply_patch"))
  const callsAtPause = model.modelCalls
  assert.equal(await readFile(join(root, "src/math.ts"), "utf8"), MATH_SOURCE, "nothing written before approval")
  assert.equal((await workflow.run()).status, "WAITING_FOR_CONFIRMATION", "run() while paused does nothing")
  assert.equal(model.modelCalls, callsAtPause, "no hidden continuation while paused")
})

test("W-08: resume continues the paused stage and records the approved change; rejection is not applied", async () => {
  const root = await workspace()
  const workflow = startWorkflow(harness({ root, model: happyModel() }))
  await workflow.run()
  const next = await workflow.resume("APPROVE")
  assert.equal(next.state.currentStage, "TEST")
  assert.equal(next.confirmation?.stage, "TEST")
  assert.equal(next.state.implementation?.changedFiles.length, 1)
  assert.equal(next.state.implementation?.changedFiles[0]?.path, "src/math.ts")
  assert.ok((await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b"))

  const rejectRoot = await workspace()
  const rejected = startWorkflow(harness({ root: rejectRoot, model: happyModel() }))
  await rejected.run()
  const after = await rejected.resume("REJECT")
  assert.equal(after.status, "BLOCKED")
  assert.equal(after.state.blocker, "NO_CHANGES")
  assert.equal(await readFile(join(rejectRoot, "src/math.ts"), "utf8"), MATH_SOURCE)
})

// ---- 9, 19: TEST and VERIFY use the real verification machinery ---------------------------------

test("W-09/19: TEST and VERIFY execute the repository's configured commands through VerificationEngine", async () => {
  const root = await workspace({
    "src/math.ts": MATH_SOURCE,
    "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "node -e \"require('fs').appendFileSync('test-runs.log','run\\n')\"" } }),
  })
  const workflow = startWorkflow(harness({ root, model: happyModel(), verifier: createWorkspaceVerifier(root) }))
  const { result, confirmations } = await drive(workflow)
  assert.equal(result.status, "COMPLETE")
  assert.deepEqual(confirmations.map((item) => item.confirmation?.verification?.commands ?? item.confirmation?.runner?.toolName), ["apply_patch", ["npm run test"], ["npm run test"]])
  assert.equal(result.state.test?.commands[0], "npm run test")
  assert.equal(result.state.test?.outcomes[0]?.status, "PASS")
  assert.equal(result.state.verification?.outcomes.map((outcome) => outcome.action).join(","), "TEST", "VERIFY ran only checks the repository defines")
  assert.equal((await readFile(join(root, "test-runs.log"), "utf8")).trim().split("\n").length, 2, "TEST and VERIFY each really executed the script")
})

// ---- 10, 11: test failure repair ----------------------------------------------------------------

test("W-10: a failed test triggers one bounded IMPLEMENT repair pass with the failure excerpt", async () => {
  const root = await workspace()
  const verifier = new FakeVerifier(["TEST"], async (action): Promise<"PASS" | "FAIL"> => {
    if (action !== "TEST") return "PASS"
    return (await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b") ? "PASS" : "FAIL"
  })
  const model = happyModel({
    IMPLEMENT: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return a - b" },
    ]),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier })))
  assert.equal(result.status, "COMPLETE")
  assert.equal(result.state.retryCounts.testRepairs, 1)
  assert.equal(stageSequence(result.state).join(","), "PLAN,IMPLEMENT,TEST,IMPLEMENT,TEST,REVIEW,VERIFY")
  const repairPrompt = model.prompts.IMPLEMENT.find((prompt) => prompt.includes("IMPLEMENT (repair)"))!
  assert.ok(repairPrompt.includes("## Repair required") && repairPrompt.includes("FAIL TEST"))
  assert.equal(result.state.implementation?.passes, 2)
})

test("W-11: the test repair limit is enforced (default 2) and ends BLOCKED, never COMPLETE", async () => {
  const root = await workspace()
  const verifier = new FakeVerifier(["TEST"], () => "FAIL")
  const model = happyModel({
    IMPLEMENT: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return (b - a)" },
      { search: "return (b - a)", replace: "return ((b - a))" },
    ]),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier })))
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "TEST_REPAIR_LIMIT")
  assert.equal(result.state.retryCounts.testRepairs, DEFAULT_WORKFLOW_POLICY.maxTestRepairs)
  assert.equal(result.state.stages.filter((record) => record.stage === "TEST").length, 3)
  assert.equal(result.state.reviews.length, 0, "no review is fabricated for a blocked run")
  assert.equal(result.state.test?.failureFingerprints.length, 1)
})

// ---- 12, 13, 27: fresh-context review proof -----------------------------------------------------

test("W-FRESH (core acceptance): REVIEW receives a fresh context with no implementer history", async () => {
  const SENTINEL = "IMPLEMENTER_PRIVATE_CONTEXT_SENTINEL"
  const root = await workspace({ "src/math.ts": MATH_SOURCE, "notes/scratch.md": `private notes ${SENTINEL}-file\n` })
  const model = happyModel({
    IMPLEMENT: ({ turn }) => {
      if (turn === 1) return reply(`Thinking aloud: ${SENTINEL}-dialogue. I will read my notes first.`, [{ id: "r1", name: "read_file", arguments: { path: "notes/scratch.md" } }], { reasoning: `${SENTINEL}-reasoning` })
      if (turn === 2) return reply(`<think>${SENTINEL}-think</think>`, [{ id: "w1", name: "apply_patch", arguments: { path: "src/math.ts", search: "// subtract: TODO\n", replace: SUBTRACT_OK } }])
      return reply(`Done. I am confident this is perfect. ${SENTINEL}-self-justification`)
    },
  })
  const runtimeRecentTurns = [{ role: "user" as const, content: `earlier chat ${SENTINEL}-conversation` }]
  const workflow = startWorkflow(harness({ root, model }), { task: TASK })
  const { result } = await drive(workflow)
  assert.equal(result.status, "COMPLETE")

  // The implementer really saw its private context…
  assert.ok(model.prompts.IMPLEMENT.some((prompt) => prompt.includes(`${SENTINEL}-file`)), "implementer read the private file")
  // …and none of it reached the reviewer.
  assert.equal(model.prompts.REVIEW.length, 1)
  const review = model.prompts.REVIEW[0]!
  assert.ok(!review.includes(SENTINEL), "no implementer dialogue, reasoning, observation, summary or chat history in REVIEW")
  assert.ok(!runtimeRecentTurns.some((turn) => review.includes(turn.content)))
  // The reviewer received exactly the allowed handoff.
  for (const section of ["## Original task", "## Acceptance criteria", "## Approved plan", "## Changed files", "## Diff", "## Test evidence"]) assert.ok(review.includes(section), section)
  assert.ok(review.includes("return a - b"), "diff present")
  assert.ok(review.includes("NO_FINDINGS is a correct, expected answer"))
  assert.equal(model.requests[model.requests.length - 1]?.messages.length, 1, "a single fresh user message, no transcript")
  // Workflow state holds only the implementer's bounded final summary (which REVIEW never receives);
  // dialogue, reasoning, <think> blocks and tool observations are not persisted anywhere.
  const { implementation, ...rest } = result.state
  assert.ok(!JSON.stringify(rest).includes(SENTINEL))
  assert.ok(!JSON.stringify(implementation?.changedFiles).includes(SENTINEL))
  assert.ok(!implementation!.summary.includes(`${SENTINEL}-think`) && !implementation!.summary.includes(`${SENTINEL}-reasoning`))
})

test("W-13: the REVIEW request is a new runner session (turn 1, no prior observations)", async () => {
  const root = await workspace()
  const model = happyModel()
  await drive(startWorkflow(harness({ root, model })))
  const reviewRequest = model.requests.find((request) => request.messages[0]!.content.includes("[Engineering workflow · REVIEW stage]"))!
  assert.equal((reviewRequest.metadata as { turn: number }).turn, 1)
  assert.ok(!reviewRequest.messages[0]!.content.includes("[Turn "), "no recent-turn history groups")
})

// ---- 14, 15, 16, 17, 18: REVIEW contract and repair ---------------------------------------------

test("W-14: REVIEW is read-only: no write tools are offered and a write attempt changes nothing", async () => {
  const root = await workspace()
  const model = happyModel({
    REVIEW: ({ turn }) => (turn === 1 ? toolCall("rv1", "apply_patch", { path: "src/math.ts", search: "return a - b", replace: "return 42" }) : reviewReply(NO_FINDINGS)),
  })
  const { result, confirmations } = await drive(startWorkflow(harness({ root, model })))
  assert.equal(result.status, "COMPLETE")
  const reviewIndex = model.requests.findIndex((request) => request.messages[0]!.content.includes("REVIEW stage"))
  assert.ok(!toolNames(model, reviewIndex).some((name) => WRITE_TOOLS.includes(name)))
  assert.ok(confirmations.every((item) => item.confirmation?.stage !== "REVIEW"), "REVIEW never asks to mutate")
  assert.ok((await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b"))
  for (const action of ["write_file", "delete_file", "terminal_command", "run_known_test", "git_push"] as ToolAction[]) {
    assert.equal(stagePermission("REVIEW", classifyPermission)({ action, mode: "BUILD" }), "DENY", action)
  }
})

test("W-15: NO_FINDINGS is a valid review result that advances to VERIFY", async () => {
  const root = await workspace()
  const { result } = await drive(startWorkflow(harness({ root, model: happyModel() })))
  assert.equal(result.state.reviews[0]?.verdict, "NO_FINDINGS")
  assert.equal(result.state.reviews[0]?.blocking, 0)
  assert.ok(result.state.completedStages.includes("REVIEW"))
})

test("W-16: an evidence-backed blocker is represented; ungrounded and malformed findings are dropped", async () => {
  const root = await workspace()
  const model = happyModel({
    IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_BUG }, { search: "return b - a", replace: "return a - b" }]),
    REVIEW: ({ session }) => session === 1
      ? reviewReply({ verdict: "FINDINGS", findings: [
          ...blockerFinding.findings,
          { id: "F2", severity: "HIGH", file: "src/math.ts", claim: "Consider adding more error handling.", evidence: "", recommendedAction: "Add try/catch" },
          { id: "F3", severity: "HIGH", file: "src/math.ts", claim: "Uses eval", evidence: "eval(userInput)", recommendedAction: "Remove eval" },
          { id: "F4", severity: "CRITICAL!!", file: "src/math.ts", claim: "bad", evidence: "return b - a", recommendedAction: "x" },
        ] })
      : reviewReply(NO_FINDINGS),
  })
  const { result } = await drive(startWorkflow(harness({ root, model })))
  const first = result.state.reviews[0]!
  assert.equal(first.findings.length, 1)
  assert.deepEqual({ ...first.findings[0] }, { id: "F1", severity: "BLOCKER", file: "src/math.ts", location: "subtract", claim: blockerFinding.findings[0]!.claim, evidence: "return b - a", recommendedAction: "Return a - b" })
  assert.equal(first.blocking, 1)
  assert.equal(first.rejectedUngrounded, 2, "generic advice and quotes not in the diff are not findings")
  assert.equal(first.rejectedMalformed, 1)
})

test("W-17/18: a blocker triggers a bounded repair, then TEST, then a new fresh REVIEW", async () => {
  const root = await workspace()
  const model = happyModel({
    IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_BUG }, { search: "return b - a", replace: "return a - b" }]),
    REVIEW: ({ session }) => reviewReply(session === 1 ? blockerFinding : NO_FINDINGS),
  })
  const { result } = await drive(startWorkflow(harness({ root, model })))
  assert.equal(result.status, "COMPLETE")
  assert.equal(stageSequence(result.state).join(","), "PLAN,IMPLEMENT,TEST,REVIEW,IMPLEMENT,TEST,REVIEW,VERIFY")
  assert.equal(result.state.retryCounts.reviewRepairs, 1)
  assert.ok(model.prompts.IMPLEMENT.some((prompt) => prompt.includes("IMPLEMENT (repair)") && prompt.includes("[BLOCKER] src/math.ts:subtract")))
  assert.equal(model.prompts.REVIEW.length, 2)
  const [firstReview, secondReview] = model.prompts.REVIEW as [string, string]
  assert.ok(firstReview.includes("return b - a"))
  assert.ok(secondReview.includes("return a - b"), "second review sees the repaired diff")
  assert.ok(!secondReview.includes("subtract returns b - a, the opposite"), "the earlier review's own output is not carried into the new review")
  assert.equal(result.state.stages.filter((record) => record.stage === "REVIEW").map((record) => record.attempt).join(","), "1,2")
})

test("W-18b: review repair is bounded at 2 cycles, then BLOCKED_REVIEW", async () => {
  const root = await workspace()
  const model = happyModel({
    IMPLEMENT: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return b - a // still" },
      { search: "return b - a // still", replace: "return b - a // again" },
    ]),
    REVIEW: () => reviewReply(blockerFinding),
  })
  const { result } = await drive(startWorkflow(harness({ root, model })))
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "BLOCKED_REVIEW")
  assert.equal(result.state.retryCounts.reviewRepairs, 2)
  assert.equal(result.state.reviews.length, 3)
  assert.ok(!result.state.completedStages.includes("VERIFY"))
})

// ---- 20, 30: VERIFY is mandatory and COMPLETE requires READY ------------------------------------

test("W-20: VERIFY cannot be skipped: no transition reaches COMPLETE except VERIFY with READY", () => {
  const base = { currentStage: "REVIEW", reviews: [{ blocking: 0 }], retryCounts: { testRepairs: 0, reviewRepairs: 0 }, completedStages: [] } as unknown as WorkflowState
  for (const from of ["PLAN", "IMPLEMENT", "TEST", "REVIEW"] as const) {
    assert.throws(() => assertTransition({ ...base, currentStage: from }, "COMPLETE", DEFAULT_WORKFLOW_POLICY), WorkflowTransitionError, from)
  }
  assert.throws(() => assertTransition({ ...base, currentStage: "VERIFY" }, "COMPLETE", DEFAULT_WORKFLOW_POLICY), /not READY/)
  assert.doesNotThrow(() => assertTransition({ ...base, currentStage: "VERIFY", verification: { verdict: "READY" } } as unknown as WorkflowState, "COMPLETE", DEFAULT_WORKFLOW_POLICY))
  assert.throws(() => assertTransition({ ...base, currentStage: "TEST", test: { attempted: true, passed: true } } as unknown as WorkflowState, "VERIFY", DEFAULT_WORKFLOW_POLICY), /no such transition/)
})

test("W-30: COMPLETE requires VERIFY READY: a failing check or a diverged workspace ends NOT_READY", async () => {
  const failing = await workspace()
  const verifier = new FakeVerifier(["TEST", "TYPECHECK"], (action) => (action === "TYPECHECK" ? "FAIL" : "PASS"))
  const { result } = await drive(startWorkflow(harness({ root: failing, model: happyModel(), verifier })))
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "VERIFY_NOT_READY")
  assert.equal(result.state.verification?.verdict, "NOT_READY")

  const drifting = await workspace()
  const sneaky = new FakeVerifier(["TEST", "TYPECHECK"], async (action, run): Promise<"PASS"> => {
    if (action === "TEST" && run === 2) await writeFile(join(drifting, "src/math.ts"), "tampered after review\n")
    return "PASS"
  })
  const second = await drive(startWorkflow(harness({ root: drifting, model: happyModel(), verifier: sneaky })))
  assert.equal(second.result.state.verification?.diffIntegrity, "DIVERGED")
  assert.deepEqual(second.result.state.verification?.divergedFiles, ["src/math.ts"])
  assert.equal(second.result.status, "BLOCKED")
})

// ---- 21: cancellation ---------------------------------------------------------------------------

test("W-21: cancellation is terminal: no later stage, reviewer or verification runs", async () => {
  const root = await workspace()
  const model = happyModel()
  const verifier = new FakeVerifier(["TEST", "TYPECHECK"])
  const controller = new AbortController()
  const workflow = startWorkflow(harness({ root, model, verifier }), { signal: controller.signal })
  await workflow.run()
  await workflow.resume("APPROVE")
  assert.equal(workflow.state.currentStage, "TEST")
  const calls = model.modelCalls
  controller.abort()
  const cancelled = await workflow.resume("APPROVE")
  assert.equal(cancelled.status, "CANCELLED")
  assert.equal(cancelled.state.currentStage, "CANCELLED")
  assert.equal(verifier.runs.length, 0, "approval after cancel runs no verification")
  assert.equal(model.modelCalls, calls, "no phantom reviewer")
  assert.equal((await workflow.run()).status, "CANCELLED")
  assert.equal((await workflow.resume("APPROVE")).status, "CANCELLED")
  assert.equal(model.modelCalls, calls)
  assert.ok(!cancelled.state.stages.some((record) => record.stage === "REVIEW" || record.stage === "VERIFY"))

  const early = startWorkflow(harness({ root: await workspace(), model: happyModel() }))
  early.cancel()
  assert.equal((await early.run()).status, "CANCELLED")
})

// ---- 22: restart / resume -----------------------------------------------------------------------

test("W-22: a persisted workflow restores after restart at the right stage without re-running completed stages", async () => {
  const root = await workspace()
  const store = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root, ".open-vs-code", "recovery") }))
  const first = startWorkflow(harness({ root, model: happyModel(), overrides: { store } }))
  await first.run()
  const waiting = await first.resume("APPROVE")
  assert.equal(waiting.state.currentStage, "TEST")
  assert.equal(waiting.state.pending?.kind, "VERIFICATION")

  // "Restart": new process objects, a new model, the same store.
  const model = happyModel()
  const verifier = new FakeVerifier(["TEST", "TYPECHECK"])
  const restored = await EngineeringWorkflow.restore(harness({ root, model, verifier, overrides: { store } }), "wf-test")
  assert.equal(restored.state.currentStage, "TEST")
  assert.deepEqual(restored.state.completedStages, ["PLAN", "IMPLEMENT"])
  assert.equal(restored.state.status, "WAITING_FOR_CONFIRMATION", "the pending approval is re-requested, not assumed")
  assert.equal((await restored.run()).confirmation?.verification?.actions.join(), "TEST")
  const { result } = await drive(restored)
  assert.equal(result.status, "COMPLETE")
  assert.equal(model.prompts.PLAN.length + model.prompts.IMPLEMENT.length, 0, "completed mutation stages are not re-run")
  assert.equal(model.prompts.REVIEW.length, 1)
  assert.ok((await readdir(join(root, ".open-vs-code", "recovery", "runs", workflowRunId("wf-test"), "checkpoints"))).some((file) => file.startsWith("cp_")))

  // A runner confirmation pending at restart is never replayed: the stage restarts from artifacts.
  const root2 = await workspace()
  const store2 = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root2, ".open-vs-code", "recovery") }))
  await startWorkflow(harness({ root: root2, model: happyModel(), overrides: { store: store2 } })).run()
  const model2 = happyModel()
  const again = await EngineeringWorkflow.restore(harness({ root: root2, model: model2, overrides: { store: store2 } }), "wf-test")
  assert.equal(again.state.status, "RUNNING")
  assert.equal(again.state.stages.at(-1)?.outcome, "INTERRUPTED_BY_RESTART")
  const resumed = await again.run()
  assert.equal(resumed.confirmation?.runner?.toolName, "apply_patch", "a fresh IMPLEMENT session asks again")
  assert.equal(model2.prompts.PLAN.length, 0)
  assert.equal(await readFile(join(root2, "src/math.ts"), "utf8"), MATH_SOURCE)
})

// ---- 23, 24: skills -----------------------------------------------------------------------------

test("W-23/24: skills follow stage capabilities and stage evidence reports only skills actually injected", async () => {
  const root = await workspace()
  const builtinRoot = defaultBuiltinSkillsRoot()
  const skills = await SkillRegistry.discover({ ...(builtinRoot ? { builtinRoot } : {}), workspaceRoot: root, workspaceTrusted: true })
  const model = happyModel()
  const task = "Fix the parser crash and check for a security vulnerability in src/math.ts"
  const { result } = await drive(startWorkflow(harness({ root, model, overrides: { skills: { registry: skills } } }), { task }))
  const byStage = new Map(result.state.stages.map((record) => [record.stage, record]))
  assert.equal(byStage.get("PLAN")?.selectedSkill, undefined, "no built-in skill allows PLAN mode")
  const implementSkill = byStage.get("IMPLEMENT")?.selectedSkill
  assert.ok(implementSkill === undefined || ["bug-triage", "tdd", "refactor-with-guards"].includes(implementSkill), String(implementSkill))
  const reviewSkill = byStage.get("REVIEW")?.selectedSkill
  assert.ok(reviewSkill === undefined || ["security-review", "verification"].includes(reviewSkill), String(reviewSkill))
  assert.ok(result.state.stages.every((record) => record.skillInjected === (record.skillInjection === "INJECTED" || record.skillInjection === "PARTIALLY_INJECTED")))
  // Truth check against what the model actually received, stage by stage.
  for (const [stage, prompts] of [["PLAN", model.prompts.PLAN], ["IMPLEMENT", model.prompts.IMPLEMENT], ["REVIEW", model.prompts.REVIEW]] as const) {
    const record = byStage.get(stage)!
    assert.equal(prompts.some((prompt) => prompt.includes("[Skill: ")), record.skillInjected, stage)
    if (record.skillInjected) assert.ok(prompts.some((prompt) => prompt.includes(`[Skill: ${record.selectedSkill} `)))
  }
  assert.ok(result.state.stages.filter((record) => record.skillInjected).length >= 1, "at least one stage used a skill")
  assert.deepEqual(result.state.selectedSkillIds, [...new Set(result.state.stages.filter((record) => record.skillInjected).map((record) => record.selectedSkill))])
})

// ---- 26, 27, 28, 29: security and evidence truth ------------------------------------------------

test("W-26: every model call goes to the single configured local provider; there is no fallback path", async () => {
  const root = await workspace()
  const model = happyModel()
  const { result } = await drive(startWorkflow(harness({ root, model })))
  const accounted = result.state.stages.reduce((total, record) => total + record.modelCalls, 0)
  assert.equal(accounted, model.modelCalls, "stage evidence accounts for every request the local provider served")
  assert.ok(model.requests.every((request) => !JSON.stringify(request.metadata ?? {}).includes("cloud")))
})

test("W-27: stage envelopes never escalate permissions, and a denied gate blocks rather than bypasses", async () => {
  const actions: ToolAction[] = ["read_repository", "search_repository", "read_markdown", "write_file", "delete_file", "run_known_test", "terminal_command", "git_commit", "git_push", "deploy", "repository_escape", "system_configuration", "destructive_disk", "unknown", "mcp_external_read", "mcp_external_side_effect", "mcp_external_unknown"]
  const rank = { DENY: 0, CONFIRM: 1, ALLOW: 2 } as const
  for (const stage of Object.keys(STAGE_ENVELOPES) as (keyof typeof STAGE_ENVELOPES)[]) {
    for (const action of actions) {
      const base = classifyPermission({ action, mode: STAGE_ENVELOPES[stage].mode })
      const effective = stagePermission(stage, classifyPermission)({ action, mode: "BUILD" })
      assert.ok(rank[effective] <= rank[base], `${stage}/${action}: ${effective} > ${base}`)
    }
    assert.equal(stagePermission(stage, classifyPermission)({ action: "git_push", mode: "BUILD" }), "DENY")
  }
  const root = await workspace()
  const model = happyModel({ IMPLEMENT: ({ turn }) => (turn === 1 ? toolCall("x", "apply_patch", { path: "src/math.ts", search: "// subtract: TODO\n", replace: SUBTRACT_OK }) : reply("could not write")) })
  const { result } = await drive(startWorkflow(harness({ root, model, overrides: { permissionEvaluator: denyAll } })))
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "NO_CHANGES")
  assert.equal(await readFile(join(root, "src/math.ts"), "utf8"), MATH_SOURCE)

  // TEST/VERIFY approval is the PermissionGate's, never implied by stage membership.
  const root2 = await workspace()
  const blocked = await drive(startWorkflow(harness({ root: root2, model: happyModel(), overrides: { permissionEvaluator: noTests } })))
  assert.equal(blocked.result.state.blocker, "VERIFICATION_DENIED")
})

test("W-28: stage evidence reflects actual execution only", async () => {
  const root = await workspace()
  const verifier = new FakeVerifier([])
  const { result } = await drive(startWorkflow(harness({ root, model: happyModel(), verifier })))
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "NO_TEST_COMMAND")
  assert.equal(stageSequence(result.state).join(","), "PLAN,IMPLEMENT,TEST")
  assert.equal(result.state.test?.attempted, false)
  assert.equal(result.state.reviews.length, 0)
  assert.equal(result.state.verification, undefined)
  assert.ok(result.state.stages.every((record) => record.endedAt), "every stage record is closed")
  const happy = await drive(startWorkflow(harness({ root: await workspace(), model: happyModel() })))
  assert.equal(stageSequence(happy.result.state).join(","), "PLAN,IMPLEMENT,TEST,REVIEW,VERIFY")
  assert.ok(happy.result.state.stages.filter((record) => record.stage === "TEST" || record.stage === "VERIFY").every((record) => record.modelCalls === 0 && record.contextTokens === 0))
  assert.ok(happy.result.state.stages.filter((record) => ["PLAN", "IMPLEMENT", "REVIEW"].includes(record.stage)).every((record) => record.modelCalls > 0 && record.contextTokens > 0))
})

test("W-29: no hidden reasoning or transcript is persisted", async () => {
  const HIDDEN = "HIDDEN_CHAIN_OF_THOUGHT_SENTINEL"
  const root = await workspace()
  const store = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root, ".open-vs-code", "recovery") }))
  const model = happyModel({
    PLAN: () => reply(`<think>${HIDDEN} plan musings</think>\n\`\`\`json\n${JSON.stringify({ goal: "Add subtract", steps: ["add it"], acceptanceCriteria: ["works"] })}\n\`\`\``, undefined, { reasoning: HIDDEN }),
    IMPLEMENT: ({ turn }) => (turn === 1 ? toolCall("w", "apply_patch", { path: "src/math.ts", search: "// subtract: TODO\n", replace: SUBTRACT_OK }) : reply(`<think>${HIDDEN}</think>Added subtract.`)),
    REVIEW: () => reply(`<reasoning>${HIDDEN}</reasoning>${JSON.stringify(NO_FINDINGS)}`),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, overrides: { store } })))
  assert.equal(result.status, "COMPLETE")
  assert.equal(result.state.implementation?.summary, "Added subtract.")
  const dir = join(root, ".open-vs-code", "recovery", "runs", workflowRunId("wf-test"), "checkpoints")
  const files = await readdir(dir)
  assert.ok(files.length > 3)
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf8")
    assert.ok(!content.includes(HIDDEN), file)
    assert.ok(!content.includes("beforeContent") && !content.includes("proposedContent"), "no full file contents")
    assert.ok(!content.includes("Operating Guidelines"), "no prompts")
  }
})
