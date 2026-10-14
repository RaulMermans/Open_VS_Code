/**
 * Sprint 5B closure (verified in Sprint 5C): workflow persistence is secret-safe, and REVIEW sees the
 * true net diff (workflow start → current workspace), never the accumulated mutation history.
 */
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"

import { CheckpointStore } from "../../src/recovery/checkpoint-store.ts"
import { computeNetChange } from "../../src/workflow/artifacts.ts"
import { EngineeringWorkflow } from "../../src/workflow/engine.ts"
import { sanitizeWorkflowState } from "../../src/workflow/persistence.ts"
import { CheckpointWorkflowStore, workflowRunId } from "../../src/workflow/services.ts"
import type { WorkflowState } from "../../src/workflow/contracts.ts"
import {
  FakeVerifier,
  MATH_SOURCE,
  NO_FINDINGS,
  SUBTRACT_BUG,
  SUBTRACT_OK,
  TASK,
  drive,
  happyModel,
  harness,
  patchingImplementer,
  reply,
  reviewReply,
  startWorkflow,
  toolCall,
  workspace,
} from "./helpers.ts"

const SECRETS = {
  openai: "sk-proj-AbCdEf0123456789XyZ",
  github: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  aws: "AKIAIOSFODNN7EXAMPLE",
  envPassword: "hunter2-Very-Secret",
  bearer: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
}
const ALL_SECRETS = Object.values(SECRETS)

async function checkpointJson(root: string): Promise<string[]> {
  const dir = join(root, ".open-vs-code", "recovery", "runs", workflowRunId("wf-test"), "checkpoints")
  const files = await readdir(dir)
  return Promise.all(files.map((file) => readFile(join(dir, file), "utf8")))
}

// ---- 0A: persistence redaction ------------------------------------------------------------------

test("C-0A: literal secrets in every free-text workflow field never reach checkpoint JSON", async () => {
  const root = await workspace({ "src/math.ts": `${MATH_SOURCE}const KEY = "placeholder"\n` })
  const store = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root, ".open-vs-code", "recovery") }))
  const task = `${TASK}. Use OPENAI_API_KEY=${SECRETS.openai} and token ${SECRETS.github}.`
  const verifier = new FakeVerifier(["TEST"], async () => ((await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b") ? "PASS" : "FAIL"))
  // Test output that leaks a secret into the excerpt.
  const run = verifier.run.bind(verifier)
  verifier.run = async (action) => {
    const out = await run(action)
    return out.result.status === "PASS" ? out : { ...out, result: { ...out.result, stdout: `${out.result.stdout}\nAWS_SECRET_ACCESS_KEY=${SECRETS.aws} Authorization: Bearer ${SECRETS.bearer}` } }
  }
  const leakyFinding = {
    verdict: "FINDINGS",
    findings: [{
      id: "F1",
      severity: "BLOCKER",
      file: "src/math.ts",
      claim: `hard-coded key ${SECRETS.github} breaks the task`,
      evidence: `const KEY = "${SECRETS.openai}"`,
      recommendedAction: `rotate ${SECRETS.aws} and read PASSWORD=${SECRETS.envPassword} from the environment`,
    }],
  }
  const model = happyModel({
    IMPLEMENT: ({ turn, session }) => {
      // 1: hard-codes the key (tests fail) · 2: adds subtract (tests pass) · 3: review repair removes the key.
      if (turn === 1 && session === 1) return toolCall("i1", "apply_patch", { path: "src/math.ts", search: 'const KEY = "placeholder"', replace: `const KEY = "${SECRETS.openai}"` })
      if (turn === 1 && session === 2) return toolCall("i2", "apply_patch", { path: "src/math.ts", search: "// subtract: TODO\n", replace: SUBTRACT_OK })
      if (turn === 1) return toolCall("i3", "apply_patch", { path: "src/math.ts", search: `const KEY = "${SECRETS.openai}"`, replace: `const KEY = process.env.KEY ?? ""` })
      return reply(`Implemented with token=${SECRETS.github} and Bearer ${SECRETS.bearer}.`)
    },
    REVIEW: ({ session }) => reviewReply(session === 1 ? leakyFinding : NO_FINDINGS),
  })
  const workflow = startWorkflow(harness({ root, model, verifier, overrides: { store, policy: { maxReviewRepairs: 1 } } }), { task })
  const { result } = await drive(workflow)
  // The in-memory run proceeded normally (secrets reached the fields under test)…
  assert.ok(result.state.task.includes(SECRETS.openai))
  assert.ok(result.state.implementation!.summary.includes(SECRETS.github))
  assert.ok(result.state.implementation!.changedFiles.some((change) => change.diff.includes(SECRETS.openai)))
  assert.ok(result.state.reviews[0]!.findings[0]!.claim.includes(SECRETS.github))
  assert.ok(result.state.stages.some((record) => record.stage === "TEST" && record.status === "FAILED"))
  assert.equal(result.state.retryCounts.reviewRepairs, 1, "the grounded secret finding drove a repair (repairReason persisted)")
  assert.equal(result.status, "COMPLETE")

  // …but no checkpoint file ever contains a literal secret.
  const files = await checkpointJson(root)
  assert.ok(files.length > 5)
  const joined = files.join("\n")
  for (const secret of ALL_SECRETS) assert.ok(!joined.includes(secret), `secret leaked: ${secret.slice(0, 6)}…`)
  // Structure needed for resume/debugging survives.
  const restored = await store.load("wf-test")
  assert.ok(restored)
  assert.equal(restored.currentStage, result.state.currentStage)
  assert.ok(restored.task.startsWith(TASK), "task intent is preserved")
  assert.ok(restored.task.includes("[REDACTED"), "task secret is redacted")
  assert.equal(restored.implementation?.changedFiles.length, result.state.implementation?.changedFiles.length)
  assert.equal(restored.implementation?.changedFiles[0]?.afterHash, result.state.implementation?.changedFiles[0]?.afterHash, "hashes are not altered")
})

test("C-0A: the sanitizer covers task, summary, diff, excerpt, finding fields, repairReason and blockerDetail", () => {
  const secret = SECRETS.github
  const state = {
    schemaVersion: 1,
    workflowId: "wf",
    taskId: "wf",
    mode: "BUILD",
    task: `fix ${secret}`,
    status: "BLOCKED",
    currentStage: "BLOCKED",
    completedStages: [],
    selectedSkillIds: [],
    implementation: { passes: 1, summary: `did ${secret}`, changedFiles: [{ pass: 1, path: "a.ts", operation: "patch", beforeHash: "b".repeat(64), afterHash: "c".repeat(64), linesAdded: 1, linesRemoved: 0, diff: `+const t = "${secret}"`, diffTruncated: false }] },
    test: { attempted: true, commands: ["npm test"], passed: false, failureFingerprints: [], outcomes: [{ action: "TEST", command: "npm test", status: "FAIL", exitCode: 1, durationMs: 1, fingerprint: "f".repeat(16), excerpt: `token=${secret}` }] },
    reviews: [{ attempt: 1, verdict: "FINDINGS", blocking: 1, rejectedUngrounded: 0, rejectedMalformed: 0, counts: { BLOCKER: 1, HIGH: 0, MEDIUM: 0, LOW: 0, NOTE: 0 }, findings: [{ id: "F1", severity: "BLOCKER", file: "a.ts", claim: `leaks ${secret}`, evidence: `"${secret}"`, recommendedAction: `remove ${secret}` }] }],
    retryCounts: { plan: 0, implement: 0, review: 0, testRepairs: 0, reviewRepairs: 0 },
    repairReason: `Evidence: ${secret}`,
    blocker: "BLOCKED_REVIEW",
    blockerDetail: `finding about ${secret} <think>private</think>`,
    stages: [],
    createdAt: "t",
    updatedAt: "t",
  } as unknown as WorkflowState
  const sanitized = JSON.stringify(sanitizeWorkflowState(state))
  assert.ok(!sanitized.includes(secret))
  assert.ok(!sanitized.includes("private"), "reasoning stripped")
  assert.ok(sanitized.includes("b".repeat(64)) && sanitized.includes("f".repeat(16)), "hashes and fingerprints untouched")
  assert.ok(JSON.stringify(state).includes(secret), "the in-memory state is not mutated")
})

// ---- 0B: review sees the true net diff ----------------------------------------------------------

test("C-0B (regression): IMPLEMENT bug → TEST fails → repair fixes → REVIEW cannot block on the obsolete buggy code", async () => {
  const root = await workspace()
  const verifier = new FakeVerifier(["TEST", "TYPECHECK"], async (action) => (action !== "TEST" || (await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b") ? "PASS" : "FAIL"))
  const staleBlocker = {
    verdict: "FINDINGS",
    findings: [{ id: "F1", severity: "BLOCKER", file: "src/math.ts", location: "subtract", claim: "subtract returns b - a", evidence: "return b - a", recommendedAction: "Return a - b" }],
  }
  const model = happyModel({
    IMPLEMENT: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return a - b" },
    ]),
    // An adversarial/stale reviewer that quotes the obsolete intermediate code.
    REVIEW: () => reviewReply(staleBlocker),
  })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier })))
  assert.equal(result.state.retryCounts.testRepairs, 1, "the bug was introduced and repaired")
  const prompt = model.prompts.REVIEW[0]!
  assert.ok(prompt.includes("## Diff (net: workflow start → current workspace)"))
  assert.ok(prompt.includes("+  return a - b"), "the reviewer sees the current code")
  assert.ok(!prompt.includes("return b - a"), "no stale intermediate state is presented as current code")
  const review = result.state.reviews[0]!
  assert.equal(review.blocking, 0, "a finding grounded only in obsolete code is rejected")
  assert.equal(review.rejectedUngrounded, 1)
  assert.equal(result.status, "COMPLETE")
  // Net changes are recorded; history stays internal.
  const net = result.state.implementation!.netChanges!
  assert.equal(net.length, 1)
  assert.equal(net[0]!.source, "BASELINE")
  assert.equal(net[0]!.linesRemoved, 1)
  assert.ok(net[0]!.diff.includes("-// subtract: TODO") && net[0]!.diff.includes("+  return a - b"))
  assert.equal(result.state.implementation!.changedFiles.length, 2, "mutation history is kept internally")
})

test("C-0B: a finding quoting code that is genuinely still current is grounded and blocks", async () => {
  const root = await workspace()
  const model = happyModel({
    IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_BUG }, { search: "return b - a", replace: "return a - b" }]),
    REVIEW: ({ session }) => reviewReply(session === 1 ? { verdict: "FINDINGS", findings: [{ id: "F1", severity: "BLOCKER", file: "src/math.ts", claim: "wrong order", evidence: "return b - a", recommendedAction: "swap" }] } : NO_FINDINGS),
  })
  const { result } = await drive(startWorkflow(harness({ root, model })))
  assert.equal(result.state.reviews[0]!.blocking, 1, "current code grounds the blocker")
  assert.equal(result.status, "COMPLETE")
})

test("C-0B: a reverted file has no net change and is not reviewed", () => {
  assert.equal(computeNetChange("a.ts", "same\n", "same\n", []), undefined)
  const created = computeNetChange("b.ts", null, "x\n", [])!
  assert.equal(created.operation, "create")
})

test("C-0B: after a restart without the start content, review shows current content, never stale history", async () => {
  const root = await workspace()
  const store = new CheckpointWorkflowStore(new CheckpointStore({ storageRoot: join(root, ".open-vs-code", "recovery") }))
  const verifier = new FakeVerifier(["TEST", "TYPECHECK"], async (action) => (action !== "TEST" || (await readFile(join(root, "src/math.ts"), "utf8")).includes("return a - b") ? "PASS" : "FAIL"))
  const first = startWorkflow(harness({ root, model: happyModel({ IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_BUG }, { search: "return b - a", replace: "return a - b" }]) }), verifier, overrides: { store } }))
  let result = await first.run()
  while (result.status === "WAITING_FOR_CONFIRMATION" && result.state.retryCounts.testRepairs === 0) result = await first.resume("APPROVE")
  while (result.status === "WAITING_FOR_CONFIRMATION" && result.state.currentStage !== "TEST") result = await first.resume("APPROVE")
  assert.equal(result.state.currentStage, "TEST")
  const model = happyModel()
  const restored = await EngineeringWorkflow.restore(harness({ root, model, verifier, overrides: { store } }), "wf-test")
  const { result: final } = await drive(restored)
  assert.equal(final.status, "COMPLETE")
  const prompt = model.prompts.REVIEW[0]!
  assert.ok(!prompt.includes("return b - a"), "stale history never reaches review after restart")
  assert.ok(prompt.includes("net diff unavailable after restart") && prompt.includes("return a - b"))
  assert.equal(final.state.implementation!.netChanges![0]!.source, "CURRENT_CONTENT")
})
