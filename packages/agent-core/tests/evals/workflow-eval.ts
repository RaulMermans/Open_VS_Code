/**
 * Sprint 5B deterministic workflow evaluation (no real model, no network).
 *
 * - Eligibility dataset.
 * - Six task fixtures (feature, bug fix, refactor, test addition, security-sensitive, read-only), each a
 *   real workspace whose `npm test` runs a checker script through the canonical VerificationEngine.
 * - Reviewer-bias cases A–D (+ an inflated-severity probe) run end to end through the workflow.
 * - Direct (workflow off) vs structured (workflow on) A/B on the same fixtures and simulated model.
 *
 * The simulated model is deterministic: it plays a fallible implementer (some fixtures' first attempt is
 * defective) and a scripted reviewer. It measures what the workflow machinery does with those
 * behaviours, not how well a real model reviews; that delta is DEFERRED_TO_HALO.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { createAgentRuntime } from "../../src/agent/runtime.ts"
import type { AgentMode, AgentResult } from "../../src/contracts/agent.ts"
import { assessWorkflowEligibility } from "../../src/workflow/policy.ts"
import type { WorkflowState } from "../../src/workflow/contracts.ts"
import { NO_FINDINGS, StageAwareModel, planReply, reply, reviewReply, toolCall, workspace, type SimHandler } from "../workflow/helpers.ts"

// ---- Eligibility ----------------------------------------------------------------------------------

interface EligibilityCase {
  readonly id: string
  readonly mode: AgentMode
  readonly instruction: string
  readonly trusted?: boolean
  readonly expected: boolean
}

export const ELIGIBILITY_CASES: readonly EligibilityCase[] = [
  { id: "E01", mode: "BUILD", instruction: "Add a subtract function to src/math.ts", expected: true },
  { id: "E02", mode: "DEBUG", instruction: "Fix add in src/math.ts; it multiplies", expected: true },
  { id: "E03", mode: "BUILD", instruction: "Refactor src/format.ts to extract the padding helper", expected: true },
  { id: "E04", mode: "BUILD", instruction: "Add a unit test for clamp", expected: true },
  { id: "E05", mode: "BUILD", instruction: "Allow readers to list documents in src/auth.ts", expected: true },
  { id: "E06", mode: "BUILD", instruction: "Explain how canAccess works in src/auth.ts", expected: false },
  { id: "E07", mode: "ASK", instruction: "Add a subtract function to src/math.ts", expected: false },
  { id: "E08", mode: "PLAN", instruction: "Plan a subtract function", expected: false },
  { id: "E09", mode: "REVIEW", instruction: "Review src/math.ts", expected: false },
  { id: "E10", mode: "BUILD", instruction: "Review only the diff for src/auth.ts", expected: false },
  { id: "E11", mode: "BUILD", instruction: "Where is clamp defined?", expected: false },
  { id: "E12", mode: "BUILD", instruction: "Add a subtract function to src/math.ts", trusted: false, expected: false },
  { id: "E13", mode: "DEBUG", instruction: "Rename the variable but do not modify behaviour", expected: true },
  { id: "E14", mode: "DEBUG", instruction: "Investigate the crash but don't change any files", expected: false },
]

export function runEligibilityEval() {
  const results = ELIGIBILITY_CASES.map((testCase) => {
    const outcome = assessWorkflowEligibility({ enabled: true, mode: testCase.mode, instruction: testCase.instruction, isTrusted: testCase.trusted ?? true })
    return { id: testCase.id, expected: testCase.expected, eligible: outcome.eligible, reason: outcome.reason, correct: outcome.eligible === testCase.expected }
  })
  return { total: results.length, correct: results.filter((result) => result.correct).length, results }
}

// ---- Fixtures -------------------------------------------------------------------------------------

type Patch = { readonly tool: "apply_patch"; readonly path: string; readonly search: string; readonly replace: string } | { readonly tool: "create_file"; readonly path: string; readonly content: string }

interface TaskFixture {
  readonly id: string
  readonly kind: "feature" | "bugfix" | "refactor" | "test-addition" | "security" | "read-only"
  readonly mode: AgentMode
  readonly task: string
  readonly files: Readonly<Record<string, string>>
  /** Checker run by `npm test` (exit 0 = pass). It only sees the workspace. */
  readonly check: string
  /** Ground-truth correctness of the final workspace (independent of the test script). */
  readonly correct: (read: (path: string) => Promise<string>) => Promise<boolean>
  /** The implementer's successive attempts: attempt 1, then repairs. */
  readonly attempts: readonly Patch[]
  /** Scripted reviewer output per review round. */
  readonly reviews: readonly object[]
  /** Whether the first attempt contains a real defect (for detection metrics). */
  readonly defectInFirstAttempt: boolean
}

const MATH = "export function add(a: number, b: number): number {\n  return a + b\n}\n// subtract: TODO\n"
const AUTH = "export function canAccess(role: string, action: string): boolean {\n  if (role !== \"admin\") return false\n  return action.length > 0\n}\n"

const checker = (body: string) => `import { readFileSync, existsSync } from "node:fs"\nconst read = (p) => existsSync(p) ? readFileSync(p, "utf8") : ""\n${body}\n`

const finding = (severity: string, file: string, claim: string, evidence: string, recommendedAction: string) => ({ verdict: "FINDINGS", findings: [{ id: "F1", severity, file, claim, evidence, recommendedAction }] })
const GENERIC_NOISE = { verdict: "FINDINGS", findings: [{ id: "N1", severity: "HIGH", file: "src/math.ts", claim: "Consider adding more error handling.", evidence: "", recommendedAction: "Add try/catch" }] }

export const TASK_FIXTURES: readonly TaskFixture[] = [
  {
    id: "T1", kind: "feature", mode: "BUILD", task: "Add a subtract function to src/math.ts",
    files: { "src/math.ts": MATH },
    check: checker(`process.exit(read("src/math.ts").includes("return a - b") ? 0 : 1)`),
    correct: async (read) => (await read("src/math.ts")).includes("return a - b"),
    attempts: [{ tool: "apply_patch", path: "src/math.ts", search: "// subtract: TODO\n", replace: "export function subtract(a: number, b: number): number {\n  return a - b\n}\n" }],
    reviews: [GENERIC_NOISE],
    defectInFirstAttempt: false,
  },
  {
    id: "T2", kind: "bugfix", mode: "DEBUG", task: "Fix add in src/math.ts: it multiplies instead of adding",
    files: { "src/math.ts": "export function add(a: number, b: number): number {\n  return a * b\n}\n" },
    check: checker(`const s = read("src/math.ts"); if (!s.includes("return a + b")) { console.log("add(2,3) expected 5"); process.exit(1) }`),
    correct: async (read) => (await read("src/math.ts")).includes("return a + b"),
    attempts: [
      { tool: "apply_patch", path: "src/math.ts", search: "return a * b", replace: "return a - b" },
      { tool: "apply_patch", path: "src/math.ts", search: "return a - b", replace: "return a + b" },
    ],
    reviews: [NO_FINDINGS],
    defectInFirstAttempt: true,
  },
  {
    id: "T3", kind: "refactor", mode: "BUILD", task: "Refactor src/format.ts to extract the repeated padding into a pad helper",
    files: { "src/format.ts": "export const left = (s: string) => \"  \" + s\nexport const right = (s: string) => s + \"  \"\n" },
    check: checker(`process.exit(read("src/format.ts").includes("const pad") ? 0 : 1)`),
    correct: async (read) => (await read("src/format.ts")).includes("const pad"),
    attempts: [{ tool: "apply_patch", path: "src/format.ts", search: "export const left = (s: string) => \"  \" + s\nexport const right = (s: string) => s + \"  \"\n", replace: "const pad  = \"  \"\nexport const left = (s: string) => pad + s\nexport const right = (s: string) => s + pad\n" }],
    reviews: [finding("LOW", "src/format.ts", "Double space before = is inconsistent with the file's style", "const pad  =", "Use a single space")],
    defectInFirstAttempt: false,
  },
  {
    id: "T4", kind: "test-addition", mode: "BUILD", task: "Add a unit test for clamp in tests/clamp.test.ts",
    // Fixture fix (recorded): MutationEngine refuses create_file under a missing parent (PARENT_NOT_FOUND),
    // so the workspace needs an existing tests/ directory, as a real repository would have.
    files: { "src/clamp.ts": "export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))\n", "tests/.gitkeep": "" },
    check: checker(`process.exit(read("tests/clamp.test.ts").includes("clamp(") ? 0 : 1)`),
    correct: async (read) => (await read("tests/clamp.test.ts")).includes("clamp(5, 0, 3)"),
    attempts: [{ tool: "create_file", path: "tests/clamp.test.ts", content: "import { clamp } from \"../src/clamp\"\nif (clamp(5, 0, 3) !== 3) throw new Error(\"clamp\")\n" }],
    reviews: [NO_FINDINGS],
    defectInFirstAttempt: false,
  },
  {
    id: "T5", kind: "security", mode: "BUILD", task: "Allow the reader role to list documents in src/auth.ts",
    files: { "src/auth.ts": AUTH },
    // The test only checks the new capability, so an over-broad change still passes it.
    check: checker(`const s = read("src/auth.ts"); process.exit(s.includes("reader") || s.includes("return true") ? 0 : 1)`),
    // Fixture fix (recorded): the first version also required !includes("return true"), which the
    // intended fix itself contains; the correct state is reader+list allowed and the admin check kept.
    correct: async (read) => {
      const source = await read("src/auth.ts")
      return source.includes("role === \"reader\" && action === \"list\"") && source.includes("if (role !== \"admin\") return false")
    },
    attempts: [
      { tool: "apply_patch", path: "src/auth.ts", search: "  if (role !== \"admin\") return false\n", replace: "  return true\n" },
      { tool: "apply_patch", path: "src/auth.ts", search: "  return true\n", replace: "  if (role === \"reader\" && action === \"list\") return true\n  if (role !== \"admin\") return false\n" },
    ],
    reviews: [
      finding("BLOCKER", "src/auth.ts", "Every role is now authorised for every action; the admin check was removed", "return true", "Restore the admin check and allow only reader+list"),
      NO_FINDINGS,
    ],
    defectInFirstAttempt: true,
  },
  {
    id: "T6", kind: "read-only", mode: "BUILD", task: "Explain how canAccess works in src/auth.ts",
    files: { "src/auth.ts": AUTH },
    check: checker("process.exit(0)"),
    correct: async (read) => (await read("src/auth.ts")) === AUTH,
    attempts: [],
    reviews: [],
    defectInFirstAttempt: false,
  },
]

// ---- Simulated model ------------------------------------------------------------------------------

function patchCall(id: string, patch: Patch) {
  return patch.tool === "apply_patch"
    ? toolCall(id, "apply_patch", { path: patch.path, search: patch.search, replace: patch.replace })
    : toolCall(id, "create_file", { path: patch.path, content: patch.content })
}

function implementer(fixture: TaskFixture): SimHandler {
  return ({ turn, session }) => {
    const patch = fixture.attempts[Math.min(session - 1, fixture.attempts.length - 1)]
    if (turn === 1 && patch) return patchCall(`${fixture.id}-${session}`, patch)
    return reply(fixture.kind === "read-only" ? "canAccess allows only admins, for any non-empty action." : "Done.")
  }
}

/**
 * Direct-path implementer. Simulation fix (recorded): the first version ignored failing-verification
 * feedback, which unfairly handicapped the direct arm. It now applies its next attempt when the latest
 * observation reports a verification failure, mirroring how the workflow implementer gets a repair pass.
 */
function directImplementer(fixture: TaskFixture): SimHandler {
  let applied = 0
  let lastFailures = 0
  return ({ turn, prompt }) => {
    const failures = (prompt.match(/"status":\s*"FAIL"|\bFAIL\b/g) ?? []).length
    const sawNewFailure = failures > lastFailures
    lastFailures = failures
    const next = fixture.attempts[applied]
    if (next && (turn === 1 || (sawNewFailure && applied > 0))) {
      applied += 1
      return patchCall(`${fixture.id}-d${applied}`, next)
    }
    return reply(fixture.kind === "read-only" ? "canAccess allows only admins, for any non-empty action." : "Done.")
  }
}

function simulatedModel(fixture: TaskFixture): StageAwareModel {
  return new StageAwareModel({
    PLAN: () => planReply({ goal: fixture.task, files: Object.keys(fixture.files), steps: ["Make the change"], tests: ["npm test"], risks: [], acceptanceCriteria: [fixture.task] }),
    IMPLEMENT: implementer(fixture),
    REVIEW: ({ session }) => reviewReply(fixture.reviews[Math.min(session - 1, fixture.reviews.length - 1)] ?? NO_FINDINGS),
    DIRECT: directImplementer(fixture),
  })
}

async function fixtureWorkspace(fixture: TaskFixture): Promise<string> {
  return workspace({ ...fixture.files, "check.mjs": fixture.check, "package.json": JSON.stringify({ name: `fixture-${fixture.id.toLowerCase()}`, private: true, type: "module", scripts: { test: "node check.mjs" } }) })
}

const readIn = (root: string) => (path: string) => readFile(join(root, path), "utf8").catch(() => "")

// ---- Direct vs structured -------------------------------------------------------------------------

export interface ArmMeasurement {
  readonly fixture: string
  readonly kind: TaskFixture["kind"]
  readonly arm: "direct" | "workflow"
  readonly outcome: string
  readonly correct: boolean
  readonly verificationRuns: number
  readonly defectDetected: boolean
  readonly modelCalls: number
  readonly promptTokens: number
  readonly peakContextTokens: number
  readonly repairCycles: number
  readonly approvals: number
  readonly latencyMs: number
  readonly stageTokens?: Readonly<Record<string, number>>
  readonly monolithicEstimateTokens?: number
  readonly workflowEligible?: boolean
}

async function runDirect(fixture: TaskFixture): Promise<ArmMeasurement> {
  const root = await fixtureWorkspace(fixture)
  const model = simulatedModel(fixture)
  const started = performance.now()
  let failedVerifications = 0
  const eventSink = (event: { readonly type: string; readonly payload: unknown }) => {
    if (event.type === "verification.completed" && (event.payload as { result?: { status?: string } }).result?.status === "FAIL") failedVerifications += 1
  }
  const runtime = await createAgentRuntime({ workspaceRoot: root, mode: fixture.mode, instruction: fixture.task, eventSink, isTrusted: true, providerOverride: model })
  let result: AgentResult = await runtime.runner.run(runtime.runnerInput as never)
  let approvals = 0
  while (result.status === "PAUSED" && approvals < 10) {
    approvals += 1
    result = await runtime.runner.resume("APPROVE")
  }
  await runtime.cleanup()
  const latencyMs = performance.now() - started
  return {
    fixture: fixture.id,
    kind: fixture.kind,
    arm: "direct",
    outcome: result.status,
    correct: await fixture.correct(readIn(root)),
    verificationRuns: result.toolCalls.filter((call) => call.name === "run_verification").length,
    defectDetected: fixture.defectInFirstAttempt && failedVerifications > 0,
    modelCalls: model.modelCalls,
    promptTokens: model.promptTokens,
    peakContextTokens: result.contextDiagnostics.reduce((peak, item) => Math.max(peak, item.totalEstimatedTokens), 0),
    repairCycles: failedVerifications,
    approvals,
    latencyMs,
  }
}

function stageTokens(state: WorkflowState): Record<string, number> {
  const tokens: Record<string, number> = { PLAN: 0, IMPLEMENT: 0, TEST: 0, REVIEW: 0, VERIFY: 0 }
  for (const record of state.stages) tokens[record.stage] = Math.max(tokens[record.stage] ?? 0, record.contextTokens)
  return tokens
}

async function runWorkflow(fixture: TaskFixture): Promise<ArmMeasurement & { readonly state?: WorkflowState }> {
  const root = await fixtureWorkspace(fixture)
  const model = simulatedModel(fixture)
  const started = performance.now()
  const runtime = await createAgentRuntime({ workspaceRoot: root, mode: fixture.mode, instruction: fixture.task, eventSink: () => {}, isTrusted: true, providerOverride: model, workflow: { enabled: true } })
  if (!runtime.workflow) {
    // Ineligible (read-only) requests take the direct path even with the flag on.
    let result = await runtime.runner.run(runtime.runnerInput as never)
    while (result.status === "PAUSED") result = await runtime.runner.resume("APPROVE")
    await runtime.cleanup()
    return {
      fixture: fixture.id, kind: fixture.kind, arm: "workflow", outcome: `BYPASS:${runtime.workflowEligibility.reason}`, correct: await fixture.correct(readIn(root)),
      verificationRuns: 0, defectDetected: false, modelCalls: model.modelCalls, promptTokens: model.promptTokens,
      peakContextTokens: result.contextDiagnostics.reduce((peak, item) => Math.max(peak, item.totalEstimatedTokens), 0), repairCycles: 0, approvals: 0,
      latencyMs: performance.now() - started, workflowEligible: false,
    }
  }
  let result = await runtime.workflow.run()
  let approvals = 0
  while (result.status === "WAITING_FOR_CONFIRMATION" && approvals < 40) {
    approvals += 1
    result = await runtime.workflow.resume("APPROVE")
  }
  await runtime.cleanup()
  const latencyMs = performance.now() - started
  const state = result.state
  const tokens = stageTokens(state)
  // TEST/VERIFY stage runs whose checks actually executed (approved, not blocked).
  const verificationRuns = state.stages.filter((record) => (record.stage === "TEST" || record.stage === "VERIFY") && (record.status === "PASSED" || record.status === "FAILED")).length
  const testCaught = state.stages.some((record) => record.stage === "TEST" && record.status === "FAILED")
  const reviewCaught = state.reviews.some((review) => review.blocking > 0)
  return {
    fixture: fixture.id,
    kind: fixture.kind,
    arm: "workflow",
    outcome: state.blocker ? `${result.status}:${state.blocker}` : result.status,
    correct: await fixture.correct(readIn(root)),
    verificationRuns,
    defectDetected: fixture.defectInFirstAttempt && (testCaught || reviewCaught),
    modelCalls: model.modelCalls,
    promptTokens: model.promptTokens,
    peakContextTokens: Math.max(...Object.values(tokens)),
    repairCycles: state.retryCounts.testRepairs + state.retryCounts.reviewRepairs,
    approvals,
    latencyMs,
    stageTokens: tokens,
    // A single growing window would hold at least every stage's context at once.
    monolithicEstimateTokens: state.stages.reduce((total, record) => total + record.contextTokens, 0),
    workflowEligible: true,
    state,
  }
}

export async function runComparison() {
  const rows: ArmMeasurement[] = []
  for (const fixture of TASK_FIXTURES) {
    rows.push(await runDirect(fixture))
    const { state: _state, ...measurement } = await runWorkflow(fixture)
    rows.push(measurement)
  }
  const summarize = (arm: "direct" | "workflow") => {
    const mutating = rows.filter((row) => row.arm === arm && row.kind !== "read-only")
    const sum = (key: "modelCalls" | "promptTokens" | "repairCycles" | "approvals" | "verificationRuns") => mutating.reduce((total, row) => total + row[key], 0)
    const defects = TASK_FIXTURES.filter((fixture) => fixture.defectInFirstAttempt).length
    return {
      tasks: mutating.length,
      correct: mutating.filter((row) => row.correct).length,
      verifiedTasks: mutating.filter((row) => row.verificationRuns > 0).length,
      defectsInjected: defects,
      defectsDetected: mutating.filter((row) => row.defectDetected).length,
      modelCalls: sum("modelCalls"),
      promptTokens: sum("promptTokens"),
      peakContextTokens: Math.max(...mutating.map((row) => row.peakContextTokens)),
      repairCycles: sum("repairCycles"),
      approvals: sum("approvals"),
      latencyMs: Math.round(mutating.reduce((total, row) => total + row.latencyMs, 0)),
    }
  }
  return { rows, direct: summarize("direct"), workflow: summarize("workflow") }
}

// ---- Reviewer bias --------------------------------------------------------------------------------

interface BiasCase {
  readonly id: string
  readonly description: string
  readonly fixture: TaskFixture
  /** Whether the patch truly contains a defect the reviewer should block. */
  readonly realDefect: boolean
  readonly expectedSeverityClass: "blocking" | "non-blocking" | "none"
}

const bias = (id: string, base: TaskFixture, review: object, firstAttemptOnly: boolean): TaskFixture => ({
  ...base,
  id,
  reviews: [review, NO_FINDINGS],
  attempts: firstAttemptOnly ? [base.attempts[0]!] : base.attempts,
})

export const BIAS_CASES: readonly BiasCase[] = [
  { id: "A", description: "Correct implementation; reviewer emits generic ungrounded advice", fixture: bias("BA", TASK_FIXTURES[0]!, GENERIC_NOISE, true), realDefect: false, expectedSeverityClass: "none" },
  {
    id: "B", description: "Diff introduces a clear regression (subtract returns b - a)",
    fixture: bias("BB", { ...TASK_FIXTURES[0]!, attempts: [{ tool: "apply_patch", path: "src/math.ts", search: "// subtract: TODO\n", replace: "export function subtract(a: number, b: number): number {\n  return b - a\n}\n" }, { tool: "apply_patch", path: "src/math.ts", search: "return b - a", replace: "return a - b" }], check: checker(`process.exit(read("src/math.ts").includes("subtract") ? 0 : 1)`) },
      finding("HIGH", "src/math.ts", "subtract returns b - a; subtract(5, 3) gives -2", "return b - a", "Return a - b"), false),
    realDefect: true, expectedSeverityClass: "blocking",
  },
  { id: "C", description: "Tests pass but the authorization boundary is removed", fixture: bias("BC", TASK_FIXTURES[4]!, TASK_FIXTURES[4]!.reviews[0]!, false), realDefect: true, expectedSeverityClass: "blocking" },
  { id: "D", description: "Harmless stylistic oddity reported at LOW", fixture: bias("BD", TASK_FIXTURES[2]!, TASK_FIXTURES[2]!.reviews[0]!, true), realDefect: false, expectedSeverityClass: "non-blocking" },
  {
    id: "D-inflated", description: "Same stylistic oddity, reviewer inflates it to BLOCKER (pipeline probe)",
    fixture: bias("BDI", { ...TASK_FIXTURES[2]!, attempts: [TASK_FIXTURES[2]!.attempts[0]!, { tool: "apply_patch", path: "src/format.ts", search: "const pad  =", replace: "const pad =" }] }, finding("BLOCKER", "src/format.ts", "Double space before =", "const pad  =", "Use a single space"), false),
    realDefect: false, expectedSeverityClass: "non-blocking",
  },
]

export async function runBiasEval() {
  const results = []
  for (const testCase of BIAS_CASES) {
    const measurement = await runWorkflow(testCase.fixture)
    const first = measurement.state?.reviews[0]
    const kept = first?.findings ?? []
    const blocked = (first?.blocking ?? 0) > 0
    const severityClass = kept.length === 0 ? "none" : blocked ? "blocking" : "non-blocking"
    results.push({
      id: testCase.id,
      description: testCase.description,
      realDefect: testCase.realDefect,
      blocked,
      keptFindings: kept.length,
      rejectedUngrounded: first?.rejectedUngrounded ?? 0,
      severityClass,
      expectedSeverityClass: testCase.expectedSeverityClass,
      severityCorrect: severityClass === testCase.expectedSeverityClass,
      outcome: measurement.outcome,
      repairCycles: measurement.repairCycles,
    })
  }
  const defects = results.filter((item) => item.realDefect)
  const clean = results.filter((item) => !item.realDefect)
  return {
    results,
    truePositiveRate: defects.filter((item) => item.blocked).length / defects.length,
    falsePositiveRate: clean.filter((item) => item.blocked).length / clean.length,
    severityCorrectness: results.filter((item) => item.severityCorrect).length / results.length,
  }
}
