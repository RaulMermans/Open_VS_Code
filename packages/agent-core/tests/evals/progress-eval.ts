/**
 * Sprint 5C deterministic non-progress evaluation (no real model, no network).
 *
 * Fixtures A–G from the sprint brief, plus three direct-path fixtures, each run twice on the same
 * simulated model and checker: arm A with the progress monitor disabled, arm B with it enabled.
 * Ground truth (loop or progress, expected failure class) is fixed per fixture before the run;
 * thresholds are the shipped defaults and are not tuned per fixture.
 *
 * The simulated implementer behaves identically in both arms (it does not get smarter from a compact
 * context), so this measures what the detector and recovery machinery do, not a real model's
 * response to them. The real-model delta is DEFERRED_TO_HALO.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { AgentRunner } from "../../src/agent/runner.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import type { FailureClass } from "../../src/progress/contracts.ts"
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import type { VerificationAction, VerificationStatus } from "../../src/tools/verification-contracts.ts"
import type { WorkflowState } from "../../src/workflow/contracts.ts"
import type { WorkflowVerifier } from "../../src/workflow/services.ts"
import { MATH_SOURCE, NO_FINDINGS, StageAwareModel, drive, harness, patchingImplementer, planReply, reviewReply, startWorkflow, workspace, type SimHandler } from "../workflow/helpers.ts"

export type Expectation = "LOOP" | "PROGRESS"

interface Checker {
  readonly status: VerificationStatus
  readonly output: string
}

interface WorkflowFixture {
  readonly id: string
  readonly path: "workflow"
  readonly title: string
  readonly expected: Expectation
  readonly expectedClass?: FailureClass
  readonly files: Readonly<Record<string, string>>
  readonly implement: SimHandler
  readonly review?: SimHandler
  /** Deterministic checker over the current workspace (stands in for `npm test`). */
  readonly check: (source: string) => Checker
}

interface DirectFixture {
  readonly id: string
  readonly path: "direct"
  readonly title: string
  readonly expected: Expectation
  readonly expectedClass?: FailureClass
  readonly steps: () => ((request: ModelRequest) => ModelResponse)[]
}

type Fixture = WorkflowFixture | DirectFixture

const SUBTRACT_BUG = "export function subtract(a: number, b: number): number {\n  return b - a\n}\n"
/** One character away from correct (`a - a` → `a - b`). */
const SUBTRACT_ONE_CHAR = "export function subtract(a: number, b: number): number {\n  return a - a\n}\n"
const pass = (count = 1): Checker => ({ status: "PASS", output: `# tests ${count}\n# pass ${count}\n# fail 0` })
const tap = (failing: readonly string[], total: number, detail: string): Checker => ({
  status: "FAIL",
  output: `${failing.map((name, index) => `not ok ${index + 1} - ${name}\n  ${detail}`).join("\n")}\n# tests ${total}\n# pass ${total - failing.length}\n# fail ${failing.length}\n# duration_ms ${(Math.random() * 100).toFixed(3)}`,
})
const subtractCheck = (source: string): Checker => (source.includes("return a - b") ? pass(2) : tap(["subtract(5, 3) === 2"], 2, `AssertionError: expected 2, got ${source.includes("a - a") ? 0 : -2} at ${new Date().toISOString()}`))

const highFinding = { verdict: "FINDINGS", findings: [{ id: "F1", severity: "HIGH", file: "src/math.ts", claim: "subtract has the wrong operand order", evidence: "return b - a", recommendedAction: "Return a - b" }] }

export const FIXTURES: readonly Fixture[] = [
  {
    id: "A",
    path: "workflow",
    title: "genuine loop: the same failing test after every edit",
    expected: "LOOP",
    expectedClass: "LOGIC_FAILURE",
    files: { "src/math.ts": MATH_SOURCE },
    implement: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return (b - a)" },
      { search: "return (b - a)", replace: "return ((b - a))" },
    ]),
    check: subtractCheck,
  },
  {
    id: "B",
    path: "workflow",
    title: "slow progress: each repair removes one failing test",
    expected: "PROGRESS",
    files: { "src/math.ts": `${MATH_SOURCE}// fixme: overflow\n// fixme: negative\n` },
    implement: patchingImplementer([
      { search: "// subtract: TODO\n", replace: "export function subtract(a: number, b: number): number {\n  return a - b\n}\n" },
      { search: "// fixme: overflow\n", replace: "// overflow handled\n" },
      { search: "// fixme: negative\n", replace: "// negatives handled\n" },
    ]),
    check: (source) => {
      const failing = ["overflow", "negative"].filter((name) => source.includes(`// fixme: ${name}`))
      return failing.length === 0 ? pass(3) : tap(failing.map((name) => `${name} case`), 3, "AssertionError: case not handled")
    },
  },
  {
    id: "D",
    path: "workflow",
    title: "environmental blocker: the database endpoint is down",
    expected: "LOOP",
    expectedClass: "ENVIRONMENT_FAILURE",
    files: { "src/math.ts": MATH_SOURCE },
    implement: patchingImplementer([
      { search: "// subtract: TODO\n", replace: "export function subtract(a: number, b: number): number {\n  return a - b\n}\n" },
      { search: "return a - b", replace: "return a - b // retry" },
      { search: "return a - b // retry", replace: "return a - b // retry again" },
    ]),
    check: () => ({ status: "FAIL", output: `Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect (node:net:1555:16) ${new Date().toISOString()}` }),
  },
  {
    id: "E",
    path: "workflow",
    title: "wrong hypothesis: the code changes but the exact failure remains, then a real fix",
    expected: "LOOP",
    expectedClass: "LOGIC_FAILURE",
    files: { "src/math.ts": MATH_SOURCE },
    implement: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a", replace: "return (b - a)" },
      { search: "return (b - a)", replace: "return a - b" },
    ]),
    check: subtractCheck,
  },
  {
    id: "F",
    path: "workflow",
    title: "review loop: the same HIGH finding survives every repair",
    expected: "LOOP",
    expectedClass: "LOGIC_FAILURE",
    files: { "src/math.ts": MATH_SOURCE },
    implement: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_BUG },
      { search: "return b - a\n", replace: "return b - a // checked\n" },
      { search: "return b - a // checked\n", replace: "return b - a // really\n" },
    ]),
    review: () => reviewReply(highFinding),
    check: () => pass(1),
  },
  {
    id: "G",
    path: "workflow",
    title: "meaningful tiny fix: a one-character change fixes the test",
    expected: "PROGRESS",
    files: { "src/math.ts": MATH_SOURCE },
    implement: patchingImplementer([
      { search: "// subtract: TODO\n", replace: SUBTRACT_ONE_CHAR },
      { search: "a - a", replace: "a - b" },
    ]),
    check: subtractCheck,
  },
  {
    id: "C",
    path: "direct",
    title: "transient tool failure: one failed read, then success",
    expected: "PROGRESS",
    steps: () => [
      () => read("t1", "src/indx.ts"),
      () => read("t2", "src/index.ts"),
      () => answer("index.ts exports greet."),
    ],
  },
  {
    id: "H",
    path: "direct",
    title: "direct A/B/A/B read cycle (invisible to a consecutive-repeat guard)",
    expected: "LOOP",
    expectedClass: "CONTEXT_DEGRADATION",
    steps: () => Array.from({ length: 15 }, (_, index) => () => read(`h${index}`, index % 2 === 0 ? "README.md" : "src/index.ts")),
  },
  {
    id: "I",
    path: "direct",
    title: "direct productive investigation across three files",
    expected: "PROGRESS",
    steps: () => [() => read("i1", "README.md"), () => read("i2", "src/index.ts"), () => read("i3", "src/nested/value.ts"), () => answer("Done.")],
  },
]

function read(id: string, path: string): ModelResponse {
  return { model: "sim-local", message: { role: "assistant", content: "read" }, toolCalls: [{ id, name: "read_file", arguments: { path } }], usage: { inputTokens: 1, outputTokens: 1 } }
}

function answer(content: string): ModelResponse {
  return { model: "sim-local", message: { role: "assistant", content }, usage: { inputTokens: 1, outputTokens: 1 } }
}

class FixtureVerifier implements WorkflowVerifier {
  runs = 0
  readonly #root: string
  readonly #check: WorkflowFixture["check"]

  constructor(root: string, check: WorkflowFixture["check"]) {
    this.#root = root
    this.#check = check
  }

  async discover(action: VerificationAction): Promise<string | undefined> {
    return action === "TEST" || action === "TYPECHECK" ? `npm run ${action.toLowerCase()}` : undefined
  }

  async run(action: VerificationAction) {
    this.runs += 1
    const result = action === "TEST" ? this.#check(await readFile(join(this.#root, "src/math.ts"), "utf8")) : pass(1)
    return { command: `npm run ${action.toLowerCase()}`, result: { status: result.status, exitCode: result.status === "PASS" ? 0 : 1, stdout: result.output, stderr: "", durationMs: 1 } }
  }
}

export interface ArmResult {
  readonly fixture: string
  readonly arm: "A" | "B"
  readonly outcome: string
  readonly stallDetected: boolean
  readonly signals: readonly string[]
  readonly failureClass?: FailureClass
  readonly recoveryAttempted: boolean
  readonly recoveryOutcome?: string
  readonly diagnosticChecks: number
  readonly modelCalls: number
  readonly promptTokens: number
  readonly toolCalls: number
  readonly turns: number
}

const directRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")
const directBudget = calculateBudget({ contextWindow: 4_000, reservedOutput: 200, reservedToolHistory: 200 })

async function runWorkflowArm(fixture: WorkflowFixture, arm: "A" | "B"): Promise<ArmResult> {
  const root = await workspace(fixture.files)
  const verifier = new FixtureVerifier(root, fixture.check)
  const model = new StageAwareModel({ PLAN: () => planReply(), IMPLEMENT: fixture.implement, REVIEW: fixture.review ?? (() => reviewReply(NO_FINDINGS)) })
  const { result } = await drive(startWorkflow(harness({ root, model, verifier, overrides: arm === "B" ? { progress: { enabled: true, probe: async () => false } } : {} })))
  const state: WorkflowState = result.state
  const progress = state.progress
  return {
    fixture: fixture.id,
    arm,
    outcome: state.blocker ? `BLOCKED:${state.blocker}` : result.status,
    stallDetected: (progress?.stallSignals.length ?? 0) > 0,
    signals: [...new Set(progress?.stallSignals.map((signal) => signal.kind) ?? [])],
    ...(progress?.recoveryPlan ? { failureClass: progress.recoveryPlan.failureClass } : {}),
    recoveryAttempted: progress?.recoveryAttempted ?? false,
    ...(progress?.recoveryOutcome ? { recoveryOutcome: progress.recoveryOutcome } : {}),
    diagnosticChecks: progress?.diagnosticRun ? 1 : 0,
    modelCalls: model.modelCalls,
    promptTokens: model.promptTokens,
    toolCalls: verifier.runs + state.stages.reduce((total, record) => total + record.toolsUsed.length, 0),
    turns: state.stages.reduce((total, record) => total + record.modelCalls, 0),
  }
}

async function runDirectArm(fixture: DirectFixture, arm: "A" | "B"): Promise<ArmResult> {
  const provider = new ScriptedModelProvider(fixture.steps())
  const runner = new AgentRunner({ provider, registry: createReadOnlyToolRegistry(), runtimeEvals: false, ...(arm === "B" ? { progressMonitor: { enabled: true } } : {}) })
  const result = await runner.run({ task: { id: `np-${fixture.id}`, mode: "BUILD", instruction: "Inspect the fixture" }, workspaceRoot: directRoot, maxTurns: 15, contextBudget: directBudget, projectInstructions: [] })
  const evidence = result.nonProgress
  const stall = (evidence?.signals ?? []).filter((signal) => !signal.pattern.startsWith("the turn budget ran out"))
  return {
    fixture: fixture.id,
    arm,
    outcome: result.status === "COMPLETED" ? "COMPLETED" : `FAILED:${result.failureReason}`,
    stallDetected: stall.length > 0,
    signals: [...new Set(stall.map((signal) => signal.kind))],
    ...(evidence?.recoveryPlan ? { failureClass: evidence.recoveryPlan.failureClass } : {}),
    recoveryAttempted: evidence?.recoveryAttempted ?? false,
    ...(evidence?.recoveryOutcome ? { recoveryOutcome: evidence.recoveryOutcome } : {}),
    diagnosticChecks: evidence?.recoveryPlan?.observedResult ? 1 : 0,
    modelCalls: provider.requests.length,
    promptTokens: provider.requests.reduce((total, request) => total + Math.ceil(request.messages.map((message) => message.content).join("\n").length / 4), 0),
    toolCalls: result.toolCalls.length,
    turns: result.turns,
  }
}

export interface ProgressEvalReport {
  readonly rows: readonly ArmResult[]
  readonly detection: {
    readonly loopFixtures: number
    readonly loopsDetected: number
    readonly trueStallRate: number
    readonly progressFixtures: number
    readonly falseStalls: number
    readonly falseStallRate: number
    readonly classified: number
    readonly classificationAccuracy: number
    readonly misses: readonly string[]
  }
  readonly recovery: {
    readonly stallsDetected: number
    readonly stallsCorrectlyClassified: number
    readonly diagnosticsRun: number
    readonly recoveriesAttempted: number
    readonly recovered: number
    readonly recoverySuccessRate: number
    readonly blockedAfterBoundedRetry: number
    readonly escalatedWithoutRetry: number
    readonly unnecessaryRecoveries: number
    readonly unnecessaryRecoveryRate: number
  }
  readonly efficiency: {
    readonly modelCalls: { readonly A: number; readonly B: number }
    readonly toolCalls: { readonly A: number; readonly B: number }
    readonly promptTokens: { readonly A: number; readonly B: number }
    readonly repeatedModelCallsAvoided: number
    readonly repeatedToolCallsAvoided: number
    readonly averageTurnsBeforeBlocker: { readonly A: number; readonly B: number }
    readonly diagnosticCallsAdded: number
    readonly diagnosticModelCallsAdded: number
    readonly netTokenDifference: number
  }
}

const byId = (id: string, arm: readonly ArmResult[]) => arm.find((row) => row.fixture === id)!
const sum = (items: readonly ArmResult[], key: "modelCalls" | "toolCalls" | "promptTokens") => items.reduce((total, row) => total + row[key], 0)
const average = (items: readonly ArmResult[]) => (items.length === 0 ? 0 : Number((items.reduce((total, row) => total + row.turns, 0) / items.length).toFixed(2)))
const rate = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator)

export async function runProgressEval(): Promise<ProgressEvalReport> {
  const rows: ArmResult[] = []
  for (const fixture of FIXTURES) {
    for (const arm of ["A", "B"] as const) rows.push(fixture.path === "workflow" ? await runWorkflowArm(fixture, arm) : await runDirectArm(fixture, arm))
  }
  const b = rows.filter((row) => row.arm === "B")
  const a = rows.filter((row) => row.arm === "A")
  const loops = FIXTURES.filter((fixture) => fixture.expected === "LOOP")
  const progress = FIXTURES.filter((fixture) => fixture.expected === "PROGRESS")
  const detected = loops.filter((fixture) => byId(fixture.id, b).stallDetected)
  const falseStalls = progress.filter((fixture) => byId(fixture.id, b).stallDetected)
  const classified = detected.filter((fixture) => fixture.expectedClass && byId(fixture.id, b).failureClass === fixture.expectedClass)
  const misses = [
    ...loops.filter((fixture) => !byId(fixture.id, b).stallDetected).map((fixture) => `${fixture.id}: loop not detected`),
    ...falseStalls.map((fixture) => `${fixture.id}: false stall`),
    ...detected.filter((fixture) => fixture.expectedClass && byId(fixture.id, b).failureClass !== fixture.expectedClass).map((fixture) => `${fixture.id}: classified ${byId(fixture.id, b).failureClass}, expected ${fixture.expectedClass}`),
  ]
  const attempted = b.filter((row) => row.recoveryAttempted)
  const recovered = attempted.filter((row) => row.recoveryOutcome === "RECOVERED")
  const blockedA = a.filter((row) => row.outcome !== "COMPLETE" && row.outcome !== "COMPLETED")
  const blockedB = b.filter((row) => row.outcome !== "COMPLETE" && row.outcome !== "COMPLETED")
  return {
    rows,
    detection: {
      loopFixtures: loops.length,
      loopsDetected: detected.length,
      trueStallRate: rate(detected.length, loops.length),
      progressFixtures: progress.length,
      falseStalls: falseStalls.length,
      falseStallRate: rate(falseStalls.length, progress.length),
      classified: classified.length,
      classificationAccuracy: rate(classified.length, detected.length),
      misses,
    },
    recovery: {
      stallsDetected: b.filter((row) => row.stallDetected).length,
      stallsCorrectlyClassified: classified.length,
      diagnosticsRun: b.reduce((total, row) => total + row.diagnosticChecks, 0),
      recoveriesAttempted: attempted.length,
      recovered: recovered.length,
      recoverySuccessRate: rate(recovered.length, attempted.length),
      blockedAfterBoundedRetry: attempted.filter((row) => row.recoveryOutcome === "NOT_RECOVERED").length,
      escalatedWithoutRetry: b.filter((row) => row.recoveryOutcome === "ESCALATED").length,
      unnecessaryRecoveries: progress.filter((fixture) => byId(fixture.id, b).recoveryAttempted).length,
      unnecessaryRecoveryRate: rate(progress.filter((fixture) => byId(fixture.id, b).recoveryAttempted).length, progress.length),
    },
    efficiency: {
      modelCalls: { A: sum(a, "modelCalls"), B: sum(b, "modelCalls") },
      toolCalls: { A: sum(a, "toolCalls"), B: sum(b, "toolCalls") },
      promptTokens: { A: sum(a, "promptTokens"), B: sum(b, "promptTokens") },
      repeatedModelCallsAvoided: sum(a, "modelCalls") - sum(b, "modelCalls"),
      repeatedToolCallsAvoided: sum(a, "toolCalls") - sum(b, "toolCalls"),
      averageTurnsBeforeBlocker: { A: average(blockedA), B: average(blockedB) },
      diagnosticCallsAdded: b.reduce((total, row) => total + row.diagnosticChecks, 0),
      // Diagnostic checks are deterministic and read-only; none of them calls the model.
      diagnosticModelCallsAdded: 0,
      netTokenDifference: sum(b, "promptTokens") - sum(a, "promptTokens"),
    },
  }
}
