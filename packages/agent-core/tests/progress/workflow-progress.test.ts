/**
 * Sprint 5C: non-progress detection and bounded recovery inside the Structured Engineering Loop.
 */
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { CheckpointStore } from "../../src/recovery/checkpoint-store.ts"
import { SkillRegistry, defaultBuiltinSkillsRoot } from "../../src/skills/registry.ts"
import { classifyPermission } from "../../src/tools/permissions.ts"
import { EngineeringWorkflow, type EngineeringWorkflowDependencies } from "../../src/workflow/engine.ts"
import { CheckpointWorkflowStore, workflowRunId } from "../../src/workflow/services.ts"
import { STAGE_ENVELOPES } from "../../src/workflow/policy.ts"
import {
  DEFAULT_PLAN,
  FakeVerifier,
  MATH_SOURCE,
  NO_FINDINGS,
  SUBTRACT_BUG,
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
} from "../workflow/helpers.ts"

const ON = { progress: { enabled: true } } satisfies Partial<EngineeringWorkflowDependencies>
const stages = (state: { stages: readonly { stage: string }[] }) => state.stages.map((record) => record.stage).join(",")

/** Always-failing tests with an identical failure, and a repair that keeps changing the wrong code. */
function genuineLoop() {
  return {
    verifier: new FakeVerifier(["TEST", "TYPECHECK"], () => "FAIL"),
    model: happyModel({
      IMPLEMENT: patchingImplementer([
        { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
        { search: "return b - a", replace: "return (b - a)" },
        { search: "return (b - a)", replace: "return ((b - a))" },
      ]),
    }),
  }
}

const passesWhenFixed = (root: string) => new FakeVerifier(["TEST", "TYPECHECK"], async (action) => (action !== "TEST" || (await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b") ? "PASS" : "FAIL"))

// ---- 15, 16, 17, 26: bounded recovery on the workflow path --------------------------------------

test("NP-W-01: a repeated identical test failure triggers exactly one diagnostic recovery, then BLOCKED_NON_PROGRESS", async () => {
  const root = await workspace()
  const { verifier, model } = genuineLoop()
  const notices: string[] = []
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: { ...ON, onProgress: (notice) => notices.push(notice) } })))
  assert.equal(result.status, "BLOCKED")
  assert.equal(result.state.blocker, "BLOCKED_NON_PROGRESS")
  const progress = result.state.progress!
  assert.equal(progress.recoveryCount, 1, "diagnostic recovery ran once")
  assert.equal(progress.recoveryAttempted, true)
  assert.equal(progress.diagnosticRun, true)
  assert.equal(progress.recoveryOutcome, "NOT_RECOVERED", "never claimed as recovered")
  assert.equal(progress.recoveryPlan?.failureClass, "LOGIC_FAILURE")
  assert.equal(progress.recoveryPlan?.discriminatingCheck, "FAILING_ASSERTION")
  assert.ok(progress.stallSignals.every((signal) => signal.kind === "TEST_STAGNATION"))
  // Bounded: the recovery replaced the next ordinary repair; total passes equal Sprint 5B's budget.
  assert.equal(stages(result.state), "PLAN,IMPLEMENT,TEST,IMPLEMENT,TEST,IMPLEMENT,TEST")
  assert.equal(result.state.retryCounts.testRepairs, 2)
  assert.equal(model.prompts.IMPLEMENT.filter((prompt) => prompt.includes("IMPLEMENT (recovery)")).length, 2, "one recovery session (2 turns)")
  const report = progress.finalBlocker!
  assert.equal(report.kind, "BLOCKED_NON_PROGRESS")
  assert.match(report.repeatedPattern, /same failing check/)
  assert.match(report.recommendedHumanAction, /failing assertion/)
  assert.ok(report.diagnosticCheck.length > 0 && report.result.length > 0)
  assert.ok(notices[0]!.startsWith("No progress detected\nDiagnosing repeated test failure"))
  assert.ok(notices.at(-1)!.startsWith("Blocked after bounded recovery"))
  assert.ok(!notices.join("\n").match(/[0-9a-f]{16}/), "no fingerprints in user-facing text")
})

test("NP-W-02: recovery cannot loop: even with a larger repair budget, the same stall after recovery is BLOCKED", async () => {
  const root = await workspace()
  const { verifier, model } = genuineLoop()
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: { ...ON, policy: { maxTestRepairs: 10 } } })))
  assert.equal(result.state.blocker, "BLOCKED_NON_PROGRESS")
  assert.equal(result.state.progress?.recoveryCount, 1)
  assert.equal(result.state.retryCounts.testRepairs, 2, "8 repair passes were left unused")
  assert.equal(result.state.stages.filter((record) => record.stage === "TEST").length, 3)
})

test("NP-W-03: a successful recovery is RECOVERED only because the run then demonstrably progressed", async () => {
  const root = await workspace()
  const model = happyModel({
    IMPLEMENT: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return (b - a)" },
      { search: "return (b - a)", replace: "return a - b" },
    ]),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier: passesWhenFixed(root), overrides: ON })))
  assert.equal(result.status, "COMPLETE")
  assert.equal(result.state.progress?.recoveryOutcome, "RECOVERED")
  assert.equal(result.state.progress?.patternCandidate?.recovered, true, "a reusable pattern is emitted as evidence only")
  assert.equal(stages(result.state), "PLAN,IMPLEMENT,TEST,IMPLEMENT,TEST,IMPLEMENT,TEST,REVIEW,VERIFY")
})

test("NP-W-04: slow progress and a meaningful one-line fix never trigger recovery", async () => {
  const root = await workspace()
  const model = happyModel({ IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_BUG }, { search: "b - a", replace: "a - b" }]) })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier: passesWhenFixed(root), overrides: ON })))
  assert.equal(result.status, "COMPLETE")
  assert.equal(result.state.progress?.recoveryCount, 0)
  assert.deepEqual(result.state.progress?.stallSignals, [])
  assert.ok(result.state.progress!.assessments.some((assessment) => assessment.status === "ADVANCED"))
})

test("NP-W-05: the same blocking review finding after a repair is detected as review stagnation", async () => {
  const root = await workspace()
  const finding = { verdict: "FINDINGS", findings: [{ id: "F1", severity: "HIGH", file: "src/math.ts", claim: "subtract has the wrong operand order", evidence: "return b - a", recommendedAction: "Return a - b" }] }
  const model = happyModel({
    IMPLEMENT: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a\n", replace: "return b - a // checked\n" },
      { search: "return b - a // checked\n", replace: "return b - a // really\n" },
    ]),
    REVIEW: () => reviewReply(finding),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, overrides: ON })))
  assert.equal(result.state.blocker, "BLOCKED_NON_PROGRESS")
  assert.ok(result.state.progress!.stallSignals.some((signal) => signal.kind === "REVIEW_STAGNATION"))
  assert.equal(result.state.progress?.recoveryPlan?.discriminatingCheck, "REVIEW_EVIDENCE")
  assert.match(result.state.progress!.recoveryPlan!.observedResult!, /still present/)
  assert.equal(result.state.progress?.recoveryCount, 1)
  assert.equal(result.state.reviews.length, 3)
})

test("NP-W-06: an implementation pass that leaves the workspace unchanged is not progress", async () => {
  const root = await workspace()
  const model = happyModel({ IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: "// subtract: TODO\n" }]) })
  const { result } = await drive(startWorkflow(harness({ root, model, overrides: ON })))
  assert.equal(result.state.blocker, "BLOCKED_NON_PROGRESS")
  assert.equal(result.state.progress?.recoveryPlan?.failureClass, "STATE_MISMATCH")
  assert.equal(result.state.progress?.recoveryPlan?.retryAllowed, false)
  assert.equal(result.state.stages.filter((record) => record.stage === "TEST").length, 0, "no test run is wasted on an unchanged workspace")
})

test("NP-W-07: an unavailable local service is classified ENVIRONMENT_FAILURE and escalated without a retry", async () => {
  const root = await workspace()
  const verifier = new FakeVerifier(["TEST"], () => "FAIL")
  const run = verifier.run.bind(verifier)
  verifier.run = async (action) => {
    const out = await run(action)
    return { ...out, result: { ...out.result, stdout: "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect" } }
  }
  const probes: string[] = []
  const model = happyModel({ IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_BUG }, { search: "return b - a", replace: "return (b - a)" }]) })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: { progress: { enabled: true, probe: async (endpoint) => (probes.push(`${endpoint.host}:${endpoint.port}`), false) } } })))
  assert.equal(result.state.blocker, "BLOCKED_NON_PROGRESS")
  assert.equal(result.state.progress?.recoveryPlan?.failureClass, "ENVIRONMENT_FAILURE")
  assert.equal(result.state.progress?.recoveryCount, 0, "a retry cannot start a database")
  assert.equal(result.state.progress?.recoveryOutcome, "ESCALATED")
  assert.deepEqual(probes, ["127.0.0.1:5432"])
  assert.match(result.state.progress!.finalBlocker!.recommendedHumanAction, /Start or install/)
})

// ---- 18: cancellation ---------------------------------------------------------------------------

test("NP-W-08: cancellation supersedes recovery: no recovery retry and no background continuation", async () => {
  const root = await workspace()
  const { verifier, model } = genuineLoop()
  const controller = new AbortController()
  const workflow = startWorkflow(harness({ root, model, verifier, overrides: { ...ON, onProgress: (notice) => { if (notice.startsWith("No progress")) controller.abort() } } }), { signal: controller.signal })
  const { result } = await drive(workflow)
  assert.equal(result.status, "CANCELLED")
  assert.equal(result.state.progress?.recoveryCount, 0)
  assert.equal(model.prompts.IMPLEMENT.filter((prompt) => prompt.includes("IMPLEMENT (recovery)")).length, 0)
  const calls = model.modelCalls
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(model.modelCalls, calls, "nothing continues in the background")
  assert.equal((await workflow.run()).status, "CANCELLED")
})

// ---- 21: fresh diagnostic context ---------------------------------------------------------------

test("NP-W-09 (sentinel): recovery context is rebuilt from allow-listed state; stale failed dialogue never reaches it", async () => {
  const SENTINEL = "FAILED_CONTEXT_SENTINEL"
  const root = await workspace()
  const verifier = new FakeVerifier(["TEST"], () => "FAIL")
  const model = new StageAwareModel({
    PLAN: () => planReply({ ...DEFAULT_PLAN, risks: [`stale hypothesis ${SENTINEL}-plan`] }),
    IMPLEMENT: ({ turn, session, prompt }) => {
      if (prompt.includes("IMPLEMENT (recovery)")) return turn === 1 ? toolCall("rec", "apply_patch", { path: "src/math.ts", search: "return (b - a)", replace: "return ((b - a))" }) : reply("Recovery attempt done.")
      const patch = session === 1 ? { search: "// subtract: TODO\n", replace: SUBTRACT_BUG } : { search: "return b - a", replace: "return (b - a)" }
      if (turn === 1) return reply(`I believe ${SENTINEL}-dialogue is the cause.`, [{ id: `i${session}`, name: "apply_patch", arguments: { path: "src/math.ts", ...patch } }], { reasoning: `${SENTINEL}-reasoning` })
      return reply(`<think>${SENTINEL}-think</think>Done; I am sure ${SENTINEL}-summary.`)
    },
    REVIEW: () => reviewReply(NO_FINDINGS),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: ON })))
  const ordinaryRepair = model.prompts.IMPLEMENT.find((prompt) => prompt.includes("IMPLEMENT (repair)"))!
  assert.ok(ordinaryRepair.includes(`${SENTINEL}-plan`), "positive control: stale state existed in ordinary repair context")
  const recovery = model.prompts.IMPLEMENT.filter((prompt) => prompt.includes("IMPLEMENT (recovery)"))
  assert.ok(recovery.length >= 1)
  assert.ok(!recovery[0]!.includes(SENTINEL), "no stale dialogue, hypothesis, summary or reasoning in the recovery context")
  for (const section of ["## Task", "## Acceptance criteria", "## Recovery (one bounded attempt)", "## Latest evidence", "## Current workspace", "## Last meaningful action"]) assert.ok(recovery[0]!.includes(section), section)
  assert.ok(!recovery[0]!.includes("## Approved plan"), "the plan (an earlier hypothesis) is excluded")
  assert.ok(recovery[0]!.includes("FAIL TEST"), "the latest failure evidence is present")
  assert.equal(model.requests.find((request) => request.messages[0]!.content.includes("IMPLEMENT (recovery)"))!.messages.length, 1, "a single fresh message")
  assert.ok(!JSON.stringify(result.state.progress).includes(SENTINEL))
})

// ---- 22, 23, 24: persistence --------------------------------------------------------------------

test("NP-W-10: progress state persists hashes and bounded text only: no secrets, reasoning or raw output", async () => {
  const SECRET = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
  const HIDDEN = "HIDDEN_REASONING_SENTINEL"
  const root = await workspace()
  const store = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root, ".open-vs-code", "recovery") }))
  const verifier = new FakeVerifier(["TEST"], () => "FAIL")
  const run = verifier.run.bind(verifier)
  verifier.run = async (action) => {
    const out = await run(action)
    return { ...out, result: { ...out.result, stdout: `AssertionError: expected 2 got -2 with GITHUB_TOKEN=${SECRET}\n${"noise ".repeat(2000)}` } }
  }
  const model = happyModel({
    IMPLEMENT: ({ turn, session }) => turn === 1
      ? toolCall(`i${session}`, "apply_patch", { path: "src/math.ts", ...(session === 1 ? { search: "// subtract: TODO\n", replace: SUBTRACT_BUG } : { search: `return ${"(".repeat(session - 2)}b - a${")".repeat(session - 2)}`, replace: `return ${"(".repeat(session - 1)}b - a${")".repeat(session - 1)}` }) })
      : reply(`<think>${HIDDEN}</think>done`, undefined, { reasoning: HIDDEN }),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: { ...ON, store } })))
  assert.equal(result.state.blocker, "BLOCKED_NON_PROGRESS")
  const dir = join(root, ".open-vs-code", "recovery", "runs", workflowRunId("wf-test"), "checkpoints")
  const files = await Promise.all((await readdir(dir)).map((file) => readFile(join(dir, file), "utf8")))
  const joined = files.join("\n")
  assert.ok(joined.includes("recoveryPlan") && joined.includes("finalBlocker"))
  assert.ok(!joined.includes(SECRET), "no secret in progress or recovery evidence")
  assert.ok(!joined.includes(HIDDEN), "no hidden reasoning")
  assert.ok(!joined.includes("noise ".repeat(400)), "no full terminal output")
  const persisted = (await store.load("wf-test"))!.progress!
  assert.ok(JSON.stringify(persisted.monitor).length < 4_000, "monitor state is bounded")
})

test("NP-W-11: restart preserves the consumed recovery attempt; counters never reset into extra retries", async () => {
  const root = await workspace()
  const store = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root, ".open-vs-code", "recovery") }))
  const { verifier, model } = genuineLoop()
  const first = startWorkflow(harness({ root, model, verifier, overrides: { ...ON, store } }))
  let result = await first.run()
  // Drive until the recovery IMPLEMENT session asks to apply its change, then "crash".
  while (result.status === "WAITING_FOR_CONFIRMATION" && !(result.state.progress?.recoveryCount === 1 && result.confirmation?.runner)) result = await first.resume("APPROVE")
  assert.equal(result.state.progress?.recoveryCount, 1)
  assert.equal(result.state.progress?.recoveryOutcome, "PENDING")

  // The resumed process gets a new model; the interrupted recovery session restarts fresh.
  const model2 = happyModel({ IMPLEMENT: patchingImplementer([{ search: "return (b - a)", replace: "return ((b - a))" }]) })
  const restored = await EngineeringWorkflow.restore(harness({ root, model: model2, verifier: new FakeVerifier(["TEST"], () => "FAIL"), overrides: { ...ON, store } }), "wf-test")
  assert.equal(restored.state.progress?.recoveryCount, 1, "the consumed attempt survived the restart")
  assert.equal(restored.state.progress?.monitor.counters.test.count, 2, "stall counters survived the restart")
  const { result: final } = await drive(restored)
  assert.equal(final.state.blocker, "BLOCKED_NON_PROGRESS")
  assert.equal(final.state.progress?.recoveryCount, 1, "no second recovery after restart")
  assert.equal(model2.prompts.IMPLEMENT.filter((prompt) => prompt.includes("IMPLEMENT (recovery)")).length >= 1, true, "the interrupted recovery pass resumed as recovery")
  assert.equal(model2.prompts.PLAN.length, 0)
})

// ---- 27: skills stay permission-safe ------------------------------------------------------------

test("NP-W-12: recovery requests the existing bug-triage skill; its contract is enforced, evidence is truthful, and no tool or permission is added", async () => {
  const root = await workspace()
  const builtinRoot = defaultBuiltinSkillsRoot()
  const skills = await SkillRegistry.discover({ ...(builtinRoot ? { builtinRoot } : {}), workspaceRoot: root, workspaceTrusted: true })
  const { verifier, model } = genuineLoop()
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: { ...ON, skills: { registry: skills } } }), { task: TASK }))
  const implementRecords = result.state.stages.filter((record) => record.stage === "IMPLEMENT")
  const recoveryRecord = implementRecords[2]!
  // bug-triage declares the `verify` capability; IMPLEMENT has no run_known_test, so the explicit
  // request is rejected (CAPABILITY_DENIED) instead of widening the envelope — and nothing claims it was applied.
  assert.equal(recoveryRecord.selectedSkill, undefined)
  assert.equal(recoveryRecord.skillInjected, false)
  const recoveryPrompt = model.prompts.IMPLEMENT.find((prompt) => prompt.includes("IMPLEMENT (recovery)"))!
  assert.ok(!recoveryPrompt.includes("[Skill: "), "no skill text reached the model")
  assert.ok(!recoveryPrompt.includes("skill:bug-triage"), "the request is a selection key, not prompt text")
  assert.ok(!result.state.selectedSkillIds.includes("bug-triage"))
  const recoveryRequest = model.requests.find((request) => request.messages[0]!.content.includes("IMPLEMENT (recovery)"))!
  const offered = (recoveryRequest.tools ?? []).map((tool) => tool.name).toSorted()
  const ordinary = (model.requests.find((request) => request.messages[0]!.content.includes("[Engineering workflow · IMPLEMENT stage]"))!.tools ?? []).map((tool) => tool.name).toSorted()
  assert.deepEqual(offered, ordinary, "recovery sees exactly the IMPLEMENT envelope")
  assert.ok(!offered.includes("run_verification") && !offered.includes("run_known_test"))
  assert.ok(STAGE_ENVELOPES.IMPLEMENT.actions.has("write_file") && !STAGE_ENVELOPES.IMPLEMENT.actions.has("git_push"))
})

// ---- 28, 29: baseline and locality --------------------------------------------------------------

test("NP-W-13: feature disabled preserves Sprint 5B behaviour exactly", async () => {
  const run = async (overrides: Partial<EngineeringWorkflowDependencies>) => {
    const root = await workspace()
    const { verifier, model } = genuineLoop()
    const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides })))
    return { result, calls: model.modelCalls }
  }
  const off = await run({})
  const explicitOff = await run({ progress: { enabled: false } })
  assert.equal(off.result.state.blocker, "TEST_REPAIR_LIMIT")
  assert.equal(off.result.state.progress, undefined, "no progress state is created")
  assert.equal(explicitOff.result.state.blocker, "TEST_REPAIR_LIMIT")
  assert.equal(stages(off.result.state), stages(explicitOff.result.state))
  assert.equal(off.calls, explicitOff.calls)
  const on = await run(ON)
  assert.equal(stages(on.result.state), stages(off.result.state), "same bounded number of passes either way")
})

test("NP-W-14: no cloud fallback and no model download: every call goes to the single local provider", async () => {
  const root = await workspace()
  const { verifier, model } = genuineLoop()
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: ON })))
  assert.equal(result.state.stages.reduce((total, record) => total + record.modelCalls, 0), model.modelCalls)
  assert.ok(model.requests.every((request) => !JSON.stringify(request.metadata ?? {}).match(/cloud|download|pull/i)))
  for (const file of ["contracts.ts", "fingerprint.ts", "monitor.ts", "recovery.ts", "direct-guard.ts"]) {
    const source = await readFile(new URL(`../../src/progress/${file}`, import.meta.url), "utf8")
    assert.ok(!/\bfetch\(|node:https?|from "https?"|child_process|ollama|huggingface/i.test(source), `${file} has no network/download path`)
  }
  assert.equal(MATH_SOURCE.length > 0, true)
  assert.equal(classifyPermission({ action: "git_push", mode: "BUILD" }), classifyPermission({ action: "git_push", mode: "BUILD" }))
})
