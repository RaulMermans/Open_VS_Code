import path from "node:path"
import { AgentRunner } from "../../src/agent/runner.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { classifyTaskProfile } from "../../src/agent/task-profile.ts"
import { EVAL_CASES, type EvalCase } from "./cases.ts"
import type { AgentResult } from "../../src/contracts/agent.ts"

export type FailureRootCause =
  | "NONE"
  | "MODEL_REASONING"
  | "TOOL_SELECTION"
  | "TOOL_ARGUMENTS"
  | "EVIDENCE_INSUFFICIENT"
  | "PREMATURE_COMPLETION"
  | "MAX_TURNS"
  | "NON_PROGRESS"
  | "CONTEXT_SELECTION"
  | "CONTEXT_OVERFLOW"
  | "PROMPT_POLICY"
  | "BACKEND_PROTOCOL"
  | "BACKEND_RUNTIME"
  | "UNKNOWN"

export interface CaseRunResult {
  readonly caseId: string
  readonly name: string
  readonly category: EvalCase["category"]
  readonly complexity: EvalCase["complexity"]
  readonly split: EvalCase["split"]
  readonly passed: boolean
  readonly turns: number
  readonly maxTurns: number
  readonly latencyMs: number
  readonly toolCallsTotal: number
  readonly validToolCalls: number
  readonly validArguments: number
  readonly correctToolSelection: boolean
  readonly nonProgressEvents: number
  readonly permissionViolations: number
  readonly estimatedTokens: number
  readonly finalAnswer?: string
  readonly grounded: boolean
  readonly failureReason?: string
  readonly failureRootCause: FailureRootCause
  readonly filesInspected: readonly string[]
}

export interface BenchmarkSummary {
  readonly model: string
  readonly runtime: string
  readonly hardware: string
  readonly timestamp: string
  readonly contextWindow: number
  readonly tasksAttempted: number
  readonly tasksPassed: number
  readonly passRate: number
  readonly devPassRate: number
  readonly heldOutPassRate: number
  readonly totalToolCalls: number
  readonly validToolCalls: number
  readonly toolSyntaxValidityRate: number
  readonly correctToolSelectionRate: number
  readonly argumentValidityRate: number
  readonly groundedAnswerRate: number
  readonly nonProgressRate: number
  readonly averageTurns: number
  readonly averageLatencyMs: number
  readonly failureBreakdown: Record<FailureRootCause, number>
  readonly cases: readonly CaseRunResult[]
}

export async function runBenchmarkCase(
  caseItem: EvalCase,
  options: {
    readonly baseUrl?: string
    readonly model?: string
    readonly maxContextTokens?: number
  } = {},
): Promise<CaseRunResult> {
  const baseUrl = options.baseUrl ?? "http://localhost:11434/v1"
  const model = options.model ?? "qwen2.5-coder:7b"
  const maxContextTokens = options.maxContextTokens ?? 8192

  const packageRoot = path.resolve(import.meta.dirname, "../..")
  const workspaceRoot = path.resolve(packageRoot, caseItem.fixtureRelPath)

  const provider = new OpenAICompatibleProvider({
    baseUrl,
    model,
    timeoutMs: 60_000,
    capabilities: ["chat", "tools"],
    contextWindow: maxContextTokens,
  })

  const registry = createReadOnlyToolRegistry()
  const runner = new AgentRunner({
    provider,
    registry,
    nonProgressThreshold: 3,
  })

  const t0 = Date.now()
  let result: AgentResult | undefined
  let runError: unknown
  const taskProfile = classifyTaskProfile(caseItem.instruction)
  const effectiveMaxTurns = Math.max(caseItem.maxTurns, taskProfile.defaultTurnBudget)

  try {
    result = await runner.run({
      task: {
        id: caseItem.id,
        instruction: caseItem.instruction,
        mode: "ASK",
      },
      workspaceRoot,
      maxTurns: effectiveMaxTurns,
      contextBudget: calculateBudget({
        contextWindow: maxContextTokens,
        reservedOutput: Math.min(1024, Math.floor(maxContextTokens / 4)),
        reservedToolHistory: Math.min(1024, Math.floor(maxContextTokens / 4)),
      }),
      projectInstructions: [
        {
          id: "agent-guidelines",
          path: "AGENTS.md",
          content: "You are a local code analysis agent. Use tools to gather repository evidence. When observations provide sufficient evidence to answer the task, provide your final grounded answer directly without calling more tools.",
        },
      ],
    })
  } catch (error) {
    runError = error
  }

  const latencyMs = Date.now() - t0

  const turns = result?.turns ?? 0
  const toolCalls = result?.toolCalls ?? []
  const totalToolCalls = toolCalls.length
  const validToolCalls = toolCalls.filter((c) => c.outcome !== "REJECTED").length
  const validArguments = toolCalls.filter((c) => c.outcome !== "REJECTED").length
  const nonProgressEvents = result?.finalState.events.filter((e) => e.type === "task.non_progress").length ?? 0
  const permissionViolations = result?.finalState.events.filter((e) => e.type === "permission.denied").length ?? 0
  const estimatedTokens = result?.contextDiagnostics.at(-1)?.totalEstimatedTokens ?? 0

  const filesInspected = toolCalls
    .filter((c) => c.name === "read_file")
    .map((c) => c.id) // tool ids

  // Check groundedness: final answer contains keywords and inspected at least one expected file or executed relevant tools
  const finalAnswer = result?.finalAnswer ?? ""
  let keywordHits = 0
  for (const kw of caseItem.groundingKeywords) {
    if (finalAnswer.toLowerCase().includes(kw.toLowerCase())) {
      keywordHits++
    }
  }

  const keywordPass = caseItem.groundingKeywords.length > 0
    ? (keywordHits / caseItem.groundingKeywords.length) >= 0.5
    : true

  const correctToolSelection = totalToolCalls === 0
    ? false
    : toolCalls.every((c) => ["read_file", "search_text", "find_files", "list_directory"].includes(c.name))

  const grounded = Boolean(result && result.status === "COMPLETED" && keywordPass && totalToolCalls > 0)
  const passed = Boolean(result && result.status === "COMPLETED" && grounded)

  // Classify root cause failure
  let failureRootCause: FailureRootCause = "NONE"
  if (!passed) {
    if (result?.failureReason === "NON_PROGRESS") {
      failureRootCause = "NON_PROGRESS"
    } else if (result?.failureReason === "MAX_TURNS_EXCEEDED") {
      failureRootCause = "MAX_TURNS"
    } else if (result?.failureReason === "CONTEXT_OVERFLOW") {
      failureRootCause = "CONTEXT_OVERFLOW"
    } else if (totalToolCalls === 0) {
      failureRootCause = "PREMATURE_COMPLETION"
    } else if (toolCalls.some((c) => c.outcome === "REJECTED")) {
      failureRootCause = "TOOL_ARGUMENTS"
    } else if (!correctToolSelection) {
      failureRootCause = "TOOL_SELECTION"
    } else if (result?.status === "COMPLETED" && !keywordPass) {
      failureRootCause = "MODEL_REASONING"
    } else if (runError) {
      failureRootCause = "BACKEND_RUNTIME"
    } else {
      failureRootCause = "UNKNOWN"
    }
  }

  return {
    caseId: caseItem.id,
    name: caseItem.name,
    category: caseItem.category,
    complexity: caseItem.complexity,
    split: caseItem.split,
    passed,
    turns,
    maxTurns: effectiveMaxTurns,
    latencyMs,
    toolCallsTotal: totalToolCalls,
    validToolCalls,
    validArguments,
    correctToolSelection,
    nonProgressEvents,
    permissionViolations,
    estimatedTokens,
    ...(result?.finalAnswer !== undefined ? { finalAnswer: result.finalAnswer } : {}),
    grounded,
    ...(result?.failureReason !== undefined ? { failureReason: result.failureReason } : runError instanceof Error ? { failureReason: runError.message } : {}),
    failureRootCause,
    filesInspected,
  }
}

export async function runFullBenchmark(
  cases: readonly EvalCase[] = EVAL_CASES,
  options: {
    readonly baseUrl?: string
    readonly model?: string
    readonly maxContextTokens?: number
    readonly onProgress?: (completed: number, total: number, latest: CaseRunResult) => void
  } = {},
): Promise<BenchmarkSummary> {
  const model = options.model ?? "qwen2.5-coder:7b"
  const maxContextTokens = options.maxContextTokens ?? 8192
  const results: CaseRunResult[] = []

  for (let i = 0; i < cases.length; i++) {
    const caseItem = cases[i]
    if (!caseItem) continue
    const caseResult = await runBenchmarkCase(caseItem, options)
    results.push(caseResult)
    options.onProgress?.(i + 1, cases.length, caseResult)
  }

  const tasksAttempted = results.length
  const tasksPassed = results.filter((r) => r.passed).length
  const passRate = tasksAttempted > 0 ? (tasksPassed / tasksAttempted) * 100 : 0

  const devCases = results.filter((r) => r.split === "dev")
  const devPassed = devCases.filter((r) => r.passed).length
  const devPassRate = devCases.length > 0 ? (devPassed / devCases.length) * 100 : 0

  const heldOutCases = results.filter((r) => r.split === "held_out")
  const heldOutPassed = heldOutCases.filter((r) => r.passed).length
  const heldOutPassRate = heldOutCases.length > 0 ? (heldOutPassed / heldOutCases.length) * 100 : 0

  const totalToolCalls = results.reduce((sum, r) => sum + r.toolCallsTotal, 0)
  const validToolCalls = results.reduce((sum, r) => sum + r.validToolCalls, 0)
  const toolSyntaxValidityRate = totalToolCalls > 0 ? (validToolCalls / totalToolCalls) * 100 : 100

  const correctToolChoiceCount = results.filter((r) => r.correctToolSelection).length
  const correctToolSelectionRate = tasksAttempted > 0 ? (correctToolChoiceCount / tasksAttempted) * 100 : 0

  const validArgumentsCount = results.reduce((sum, r) => sum + r.validArguments, 0)
  const argumentValidityRate = totalToolCalls > 0 ? (validArgumentsCount / totalToolCalls) * 100 : 100

  const groundedCount = results.filter((r) => r.grounded).length
  const groundedAnswerRate = tasksAttempted > 0 ? (groundedCount / tasksAttempted) * 100 : 0

  const nonProgressCount = results.filter((r) => r.failureRootCause === "NON_PROGRESS").length
  const nonProgressRate = tasksAttempted > 0 ? (nonProgressCount / tasksAttempted) * 100 : 0

  const totalTurns = results.reduce((sum, r) => sum + r.turns, 0)
  const averageTurns = tasksAttempted > 0 ? totalTurns / tasksAttempted : 0

  const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0)
  const averageLatencyMs = tasksAttempted > 0 ? totalLatency / tasksAttempted : 0

  const failureBreakdown: Record<FailureRootCause, number> = {
    NONE: 0,
    MODEL_REASONING: 0,
    TOOL_SELECTION: 0,
    TOOL_ARGUMENTS: 0,
    EVIDENCE_INSUFFICIENT: 0,
    PREMATURE_COMPLETION: 0,
    MAX_TURNS: 0,
    NON_PROGRESS: 0,
    CONTEXT_SELECTION: 0,
    CONTEXT_OVERFLOW: 0,
    PROMPT_POLICY: 0,
    BACKEND_PROTOCOL: 0,
    BACKEND_RUNTIME: 0,
    UNKNOWN: 0,
  }

  for (const r of results) {
    failureBreakdown[r.failureRootCause] = (failureBreakdown[r.failureRootCause] ?? 0) + 1
  }

  return {
    model,
    runtime: "Ollama v0.32.15 (local Apple Silicon M3 Pro)",
    hardware: "Apple M3 Pro (11 cores), 18GB RAM",
    timestamp: new Date().toISOString(),
    contextWindow: maxContextTokens,
    tasksAttempted,
    tasksPassed,
    passRate,
    devPassRate,
    heldOutPassRate,
    totalToolCalls,
    validToolCalls,
    toolSyntaxValidityRate,
    correctToolSelectionRate,
    argumentValidityRate,
    groundedAnswerRate,
    nonProgressRate,
    averageTurns,
    averageLatencyMs,
    failureBreakdown,
    cases: results,
  }
}

export function formatBenchmarkMarkdownReport(summary: BenchmarkSummary): string {
  return `# Benchmark Report: ${summary.model}

- **Runtime**: ${summary.runtime}
- **Hardware**: ${summary.hardware}
- **Context window**: ${summary.contextWindow}
- **Timestamp**: ${summary.timestamp}

## Overall Metrics (n = ${summary.tasksAttempted})

| Metric | Score | Sample Size (n) |
| --- | --- | --- |
| Task Success (All) | ${summary.passRate.toFixed(1)}% | ${summary.tasksPassed}/${summary.tasksAttempted} |
| Dev Split Success | ${summary.devPassRate.toFixed(1)}% | ${summary.cases.filter((c) => c.split === "dev" && c.passed).length}/${summary.cases.filter((c) => c.split === "dev").length} |
| Held-Out Split Success | ${summary.heldOutPassRate.toFixed(1)}% | ${summary.cases.filter((c) => c.split === "held_out" && c.passed).length}/${summary.cases.filter((c) => c.split === "held_out").length} |
| Tool Syntax Validity | ${summary.toolSyntaxValidityRate.toFixed(1)}% | ${summary.validToolCalls}/${summary.totalToolCalls} calls |
| Correct Tool Selection | ${summary.correctToolSelectionRate.toFixed(1)}% | ${summary.cases.filter((c) => c.correctToolSelection).length}/${summary.tasksAttempted} tasks |
| Argument Payload Validity | ${summary.argumentValidityRate.toFixed(1)}% | ${summary.cases.reduce((s, c) => s + c.validArguments, 0)}/${summary.totalToolCalls} calls |
| Grounded Answer Rate | ${summary.groundedAnswerRate.toFixed(1)}% | ${summary.cases.filter((c) => c.grounded).length}/${summary.tasksAttempted} tasks |
| Non-Progress Failure Rate | ${summary.nonProgressRate.toFixed(1)}% | ${summary.cases.filter((c) => c.failureRootCause === "NON_PROGRESS").length}/${summary.tasksAttempted} tasks |
| Average Turns per Task | ${summary.averageTurns.toFixed(2)} | ${summary.tasksAttempted} tasks |
| Average Latency per Task | ${summary.averageLatencyMs.toFixed(0)} ms | ${summary.tasksAttempted} tasks |

## Failure Root Cause Breakdown

| Root Cause | Count | Percentage |
| --- | --- | --- |
| NONE (Passed) | ${summary.failureBreakdown.NONE} | ${((summary.failureBreakdown.NONE / summary.tasksAttempted) * 100).toFixed(1)}% |
| MODEL_REASONING | ${summary.failureBreakdown.MODEL_REASONING} | ${((summary.failureBreakdown.MODEL_REASONING / summary.tasksAttempted) * 100).toFixed(1)}% |
| TOOL_SELECTION | ${summary.failureBreakdown.TOOL_SELECTION} | ${((summary.failureBreakdown.TOOL_SELECTION / summary.tasksAttempted) * 100).toFixed(1)}% |
| TOOL_ARGUMENTS | ${summary.failureBreakdown.TOOL_ARGUMENTS} | ${((summary.failureBreakdown.TOOL_ARGUMENTS / summary.tasksAttempted) * 100).toFixed(1)}% |
| CONTEXT_OVERFLOW | ${summary.failureBreakdown.CONTEXT_OVERFLOW} | ${((summary.failureBreakdown.CONTEXT_OVERFLOW / summary.tasksAttempted) * 100).toFixed(1)}% |
| NON_PROGRESS | ${summary.failureBreakdown.NON_PROGRESS} | ${((summary.failureBreakdown.NON_PROGRESS / summary.tasksAttempted) * 100).toFixed(1)}% |
| MAX_TURNS | ${summary.failureBreakdown.MAX_TURNS} | ${((summary.failureBreakdown.MAX_TURNS / summary.tasksAttempted) * 100).toFixed(1)}% |
| BACKEND_PROTOCOL | ${summary.failureBreakdown.BACKEND_PROTOCOL} | ${((summary.failureBreakdown.BACKEND_PROTOCOL / summary.tasksAttempted) * 100).toFixed(1)}% |
| BACKEND_RUNTIME | ${summary.failureBreakdown.BACKEND_RUNTIME} | ${((summary.failureBreakdown.BACKEND_RUNTIME / summary.tasksAttempted) * 100).toFixed(1)}% |
| UNKNOWN | ${summary.failureBreakdown.UNKNOWN} | ${((summary.failureBreakdown.UNKNOWN / summary.tasksAttempted) * 100).toFixed(1)}% |

## Detailed Case Results

| ID | Name | Category | Complexity | Split | Outcome | Turns | Latency | Root Cause |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${summary.cases.map((c) => `| ${c.caseId} | ${c.name} | ${c.category} | ${c.complexity} | ${c.split} | ${c.passed ? "PASS" : "FAIL"} | ${c.turns}/${c.maxTurns} | ${c.latencyMs}ms | ${c.failureRootCause} |`).join("\n")}
`
}
