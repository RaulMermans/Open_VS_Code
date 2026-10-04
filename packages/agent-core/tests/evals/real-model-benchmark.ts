/**
 * Real Model Benchmark Harness — Sprint 4E / 4E.1 / 4E.2.
 *
 * This module provides the production benchmark for REAL local open-weight models.
 *
 * IMPORTANT: This harness is gated by the InferenceGate.
 * It MUST NOT be executed during normal `npm test`.
 * It is invoked ONLY via: npm run eval:models
 *
 * Key Invariants (Sprint 4E.2):
 *   - Refuses to run without OPEN_VS_CODE_REAL_INFERENCE=1.
 *   - Exercises the ACTUAL production configuration & startup pipeline:
 *     temporary workspace → .open-vs-code/models.json → loadRoutingConfig() →
 *     createAgentRuntime() → RoutedModelGateway → ModelRouter → real local provider.
 *   - Exercises the ACTUAL production autocomplete pipeline:
 *     temporary workspace → .open-vs-code/models.json →
 *     createProductionAutocompleteGateway() → LocalFimProvider.
 *   - Genuinely requires tools: includes repository tasks that cannot be answered
 *     without reading or searching synthetic repository files.
 *   - Separates runtime completion from task correctness and tool use.
 *   - Separates nonEmpty from syntaxValid in FIM metrics.
 *   - Discovers provider runtime version truthfully.
 *   - Does NOT train on its own results during a benchmark run (adaptive routing disabled).
 *   - Does NOT commit model weights, raw completions, diffs, source files, or secrets.
 */

import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { platform, arch, cpus, totalmem, tmpdir } from "node:os"
import { checkInferenceGate } from "../../src/model/inference-gate.ts"
import { createAgentRuntime } from "../../src/agent/runtime.ts"
import { createProductionAutocompleteGateway } from "../../src/autocomplete/gateway.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import type { FimStrategy } from "../../src/contracts/routing.ts"
import type { AgentEvent } from "../../src/contracts/agent.ts"

export const BENCHMARK_SCHEMA_VERSION = 3

export type BenchmarkStatus = "EXECUTED" | "BLOCKED_WITH_EVIDENCE" | "FAILED"

export interface GitProvenance {
  readonly gitSha: string
  readonly worktreeClean: boolean
  readonly dirtyFiles?: readonly string[] | undefined
}

export function getCanonicalEvalsDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(currentDir, "../../../..")
  return resolve(repoRoot, "evals/results")
}

export function checkGitProvenance(): GitProvenance {
  let gitSha = "unknown"
  try {
    gitSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim()
  } catch {
    // fallback
  }

  let worktreeClean = false
  let dirtyFiles: string[] = []
  try {
    const statusOut = execSync("git status --porcelain", { encoding: "utf-8" }).trim()
    if (statusOut.length === 0) {
      worktreeClean = true
    } else {
      worktreeClean = false
      dirtyFiles = statusOut.split("\n").map(l => l.trim()).filter(Boolean)
    }
  } catch {
    worktreeClean = false
  }

  return { gitSha, worktreeClean, dirtyFiles }
}

function getHardwareSummary(): string {
  const cpu = cpus()[0]?.model ?? "unknown"
  const cores = cpus().length
  const ramGb = Math.round(totalmem() / 1024 / 1024 / 1024)
  const os = `${platform()} ${arch()}`
  return `${cpu} (${cores} cores), ${ramGb}GB RAM, ${os}`
}

/**
 * Safely probe and discover the local inference runtime and version.
 * Never returns a fake generic label like "local-openai-compatible".
 * If not safely discoverable, returns "unknown (<reason>)".
 */
export async function discoverProviderRuntime(endpoint: string): Promise<string> {
  // 1. Try querying Ollama version API
  try {
    const url = new URL("/api/version", endpoint)
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>
      if (typeof data?.version === "string") {
        return `Ollama v${data.version}`
      }
    }
  } catch {
    // Non-fatal fallback
  }

  // 2. Try querying local CLI if on localhost
  try {
    const out = execSync("ollama --version", { encoding: "utf-8", timeout: 2000 }).trim()
    if (out) return out
  } catch {
    // Non-fatal fallback
  }

  // 3. Try checking /v1/models probe
  try {
    const url = new URL("/v1/models", endpoint)
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>
      const count = Array.isArray(data?.data) ? data.data.length : 0
      return `OpenAI-compatible server (${count} served model${count === 1 ? "" : "s"})`
    }
  } catch {
    // Non-fatal fallback
  }

  return "unknown (server version endpoint not discoverable safely)"
}

/**
 * Deterministically validate structural syntax for FIM completions.
 * JSON uses JSON.parse grammar parsing; TypeScript/JavaScript/Python use delimiter & string balancing.
 * Strictly separates nonEmpty from structurallyValid.
 */
export function validateStructuralSyntax(completion: string, language: string, prefix: string, suffix: string): boolean {
  if (!completion || completion.trim().length === 0) return false

  if (language === "json") {
    try {
      JSON.parse(prefix + completion + suffix)
      return true
    } catch {
      try {
        JSON.parse(completion)
        return true
      } catch {
        return false
      }
    }
  }

  if (language === "typescript" || language === "javascript") {
    const combined = prefix + completion + suffix
    const stack: string[] = []
    let inString = false
    let stringChar = ""
    for (let i = 0; i < combined.length; i++) {
      const ch = combined[i]
      if (inString) {
        if (ch === stringChar && combined[i - 1] !== "\\") {
          inString = false
        }
      } else {
        if (ch === '"' || ch === "'" || ch === "`") {
          inString = true
          stringChar = ch!
        } else if (ch === "{" || ch === "(" || ch === "[") {
          stack.push(ch)
        } else if (ch === "}" && stack.pop() !== "{") {
          return false
        } else if (ch === ")" && stack.pop() !== "(") {
          return false
        } else if (ch === "]" && stack.pop() !== "[") {
          return false
        }
      }
    }
    return !inString && stack.length === 0
  }

  if (language === "python") {
    const combined = prefix + completion + suffix
    const stack: string[] = []
    for (const ch of combined) {
      if (ch === "{" || ch === "(" || ch === "[") stack.push(ch)
      else if (ch === "}" && stack.pop() !== "{") return false
      else if (ch === ")" && stack.pop() !== "(") return false
      else if (ch === "]" && stack.pop() !== "[") return false
    }
    return stack.length === 0
  }

  return completion.trim().length > 0
}

/** Backward compatibility alias */
export const validateSyntax = validateStructuralSyntax

export interface AgentBenchmarkTask {
  readonly id: string
  readonly name: string
  readonly category:
    | "understanding"
    | "single-file"
    | "multi-file"
    | "bug-repair"
    | "refactor"
    | "test-addition"
    | "debugging"
    | "tool-selection"
    | "verification"
    | "repair-after-failure"
  readonly prompt: string
  readonly expectedKeywords: readonly string[]
  readonly maxOutputTokens: number
  readonly requiresTool?: boolean
  readonly expectedTool?: string
  readonly verify?: (response: string, toolCalls: readonly any[]) => { taskCorrect: boolean; grounded: boolean }
}

export interface FimBenchmarkFixture {
  readonly id: string
  readonly language: string
  readonly prefix: string
  readonly suffix: string
  readonly expectedKeywords: readonly string[]
  readonly maxOutputTokens: number
}

export interface AgentTaskResult {
  readonly taskId: string
  readonly name: string
  readonly category: string
  readonly runtimeCompleted: boolean
  readonly taskCorrect: boolean
  readonly grounded: boolean
  readonly requiredToolUsed: boolean
  readonly success: boolean
  readonly groundedSuccess: boolean
  readonly latencyMs: number
  readonly turns: number
  readonly toolCallsCount: number
  readonly validToolCallsCount: number
  readonly selectedToolNames: readonly string[]
  readonly routeProvenance?: {
    readonly deploymentId: string
    readonly providerId: string
    readonly modelId: string
  }
  readonly failureReason?: string
  readonly responseLength: number
  readonly responseSha256: string
  readonly error?: string
}

export interface FimTaskResult {
  readonly fixtureId: string
  readonly language: string
  readonly success: boolean
  readonly exactMatch: boolean
  readonly nonEmpty: boolean
  readonly structurallyValid: boolean
  /** Alias for structurallyValid for backwards compatibility */
  readonly syntaxValid: boolean
  readonly latencyMs: number
  readonly emptyCompletion: boolean
  readonly completionLength: number
  readonly completionSha256: string
  readonly routeProvenance?: {
    readonly deploymentId: string
    readonly providerId: string
    readonly modelId: string
  }
  readonly error?: string
}

export interface BenchmarkArtifact {
  readonly schemaVersion: number
  readonly status: BenchmarkStatus
  readonly executed: boolean
  readonly blockerReason?: string | undefined
  readonly gitSha: string
  readonly worktreeClean: boolean
  readonly timestamp: string
  readonly hardware: string
  readonly os: string
  readonly cpu: string
  readonly ramGb: number
  readonly nodeVersion: string
  readonly providerRuntime: string
  readonly endpoint: string
  readonly logicalModelId: string
  readonly servedModelId: string
  readonly agentModelId: string
  readonly fimModelId: string
  readonly fimStrategy: string
  readonly inferenceAuthorized: boolean
  readonly endpointReachable: boolean
  readonly requestedModelsAvailable: boolean
  readonly warmupSucceeded: boolean
  readonly measuredTasksExecuted: boolean
  readonly agentTasks: readonly AgentTaskResult[]
  readonly fimTasks: readonly FimTaskResult[]
  readonly agentSummary: {
    readonly total: number
    readonly success: number
    readonly successRate: number
    readonly toolRequiredCount: number
    readonly toolRequiredSuccessCount: number
    readonly toolUseRate: number
    readonly medianLatencyMs: number
    readonly p95LatencyMs: number
  }
  readonly fimSummary: {
    readonly total: number
    readonly success: number
    readonly successRate: number
    readonly nonEmptyRate: number
    readonly structurallyValidRate: number
    readonly syntaxValidRate: number
    readonly emptyRate: number
    readonly medianLatencyMs: number
    readonly p95LatencyMs: number
  }
}

// Representative agent task suite with genuine tool-required repository tasks
const AGENT_BENCHMARK_TASKS: readonly AgentBenchmarkTask[] = [
  // ── Genuine Tool-Required Fixtures (Cannot answer without repository tools) ──
  {
    id: "T001",
    name: "Repository config constant lookup",
    category: "understanding",
    prompt: "What is the exported string value of SYSTEM_MAGIC_TOKEN in src/config.ts? Inspect the file and return the exact value.",
    expectedKeywords: ["OVS_SECURE_TOKEN_9481"],
    maxOutputTokens: 100,
    requiresTool: true,
    expectedTool: "read_file",
    verify: (response, toolCalls) => ({
      taskCorrect: response.includes("OVS_SECURE_TOKEN_9481"),
      grounded: toolCalls.length > 0 && response.includes("OVS_SECURE_TOKEN_9481"),
    }),
  },
  {
    id: "T002",
    name: "Function definition discovery",
    category: "understanding",
    prompt: "Find which file in the src directory defines the calculateInvoiceTotal function. Return the filename.",
    expectedKeywords: ["invoicing.ts"],
    maxOutputTokens: 100,
    requiresTool: true,
    expectedTool: "search_text",
    verify: (response, toolCalls) => ({
      taskCorrect: response.includes("invoicing.ts"),
      grounded: toolCalls.length > 0 && response.includes("invoicing.ts"),
    }),
  },
  {
    id: "T003",
    name: "Deliberate bug identification in implementation",
    category: "bug-repair",
    prompt: "Read src/discount.ts and describe what calculation error is present in the applySeasonalDiscount function.",
    expectedKeywords: ["multipl", "subtract", "discount", "bug"],
    maxOutputTokens: 150,
    requiresTool: true,
    expectedTool: "read_file",
    verify: (response, toolCalls) => {
      const lower = response.toLowerCase()
      const mentionsBug = lower.includes("multipl") || lower.includes("subtract") || lower.includes("percent")
      return {
        taskCorrect: mentionsBug,
        grounded: toolCalls.length > 0 && mentionsBug,
      }
    },
  },
  {
    id: "T004",
    name: "Test assertion file discovery",
    category: "debugging",
    prompt: "Which test file asserts behavior about the discount rate being non-negative? Search the tests directory.",
    expectedKeywords: ["calculator.test.ts"],
    maxOutputTokens: 100,
    requiresTool: true,
    expectedTool: "search_text",
    verify: (response, toolCalls) => ({
      taskCorrect: response.includes("calculator.test.ts"),
      grounded: toolCalls.length > 0 && response.includes("calculator.test.ts"),
    }),
  },
  // ── General Coding & Reasoning Fixtures ──
  {
    id: "A001",
    name: "TypeScript function signature",
    category: "understanding",
    prompt: "Write a TypeScript function called `addNumbers` that takes two number parameters and returns their sum.",
    expectedKeywords: ["function", "addNumbers", "number", "return"],
    maxOutputTokens: 200,
    requiresTool: false,
  },
  {
    id: "A002",
    name: "Bug identification",
    category: "bug-repair",
    prompt: "This JavaScript has a bug: `function sum(a, b) { return a - b; }`. Identify and fix it.",
    expectedKeywords: ["+", "a + b", "fix", "bug"],
    maxOutputTokens: 150,
    requiresTool: false,
  },
  {
    id: "A003",
    name: "Code explanation",
    category: "understanding",
    prompt: "Explain what this code does in one sentence: `const result = arr.filter(x => x > 0).map(x => x * 2)`",
    expectedKeywords: ["filter", "positive", "double", "map"],
    maxOutputTokens: 100,
    requiresTool: false,
  },
  {
    id: "A004",
    name: "Error type identification",
    category: "debugging",
    prompt: "What error will `JSON.parse('invalid json')` throw in JavaScript?",
    expectedKeywords: ["SyntaxError", "JSON", "parse"],
    maxOutputTokens: 100,
    requiresTool: false,
  },
  {
    id: "A005",
    name: "Refactor suggestion",
    category: "refactor",
    prompt: "Suggest a refactoring to reduce repetition: `if (x === 1) return 'one'; if (x === 2) return 'two'; if (x === 3) return 'three';`",
    expectedKeywords: ["switch", "object", "map", "dict", "lookup"],
    maxOutputTokens: 200,
    requiresTool: false,
  },
  {
    id: "A006",
    name: "Test case design",
    category: "test-addition",
    prompt: "List 3 test cases for a function `divide(a, b)` that divides two numbers.",
    expectedKeywords: ["zero", "division", "negative", "positive"],
    maxOutputTokens: 200,
    requiresTool: false,
  },
]

// FIM benchmark fixtures — deterministic completion tasks
const FIM_BENCHMARK_FIXTURES: readonly FimBenchmarkFixture[] = [
  {
    id: "F001",
    language: "typescript",
    prefix: "function add(a: number, b: number): number {\n  return ",
    suffix: ";\n}",
    expectedKeywords: ["a + b"],
    maxOutputTokens: 15,
  },
  {
    id: "F002",
    language: "typescript",
    prefix: "export const isPositive = (n: number): boolean => ",
    suffix: ";\n",
    expectedKeywords: ["n > 0", "n >= 0"],
    maxOutputTokens: 15,
  },
  {
    id: "F003",
    language: "python",
    prefix: "def greet(name: str) -> str:\n    return ",
    suffix: "\n",
    expectedKeywords: ["f\"Hello", "f'Hello", "\"Hello", "'Hello"],
    maxOutputTokens: 20,
  },
  {
    id: "F004",
    language: "typescript",
    prefix: "interface User {\n  id: number;\n  name: ",
    suffix: ";\n}",
    expectedKeywords: ["string"],
    maxOutputTokens: 10,
  },
  {
    id: "F005",
    language: "javascript",
    prefix: "// Returns the maximum of two numbers\nfunction max(a, b) {\n  return ",
    suffix: "\n}",
    expectedKeywords: ["a > b", "a >= b", "Math.max"],
    maxOutputTokens: 30,
  },
  {
    id: "F006",
    language: "python",
    prefix: "class Rectangle:\n    def __init__(self, width, height):\n        self.width = ",
    suffix: "\n",
    expectedKeywords: ["width"],
    maxOutputTokens: 15,
  },
  {
    id: "F007",
    language: "json",
    prefix: "{\n  \"name\": \"project\",\n  \"version\": ",
    suffix: "\n}",
    expectedKeywords: ["\"1.", "\"0."],
    maxOutputTokens: 15,
  },
  {
    id: "F008",
    language: "typescript",
    prefix: "export function identity<T>(value: T): ",
    suffix: " {\n  return value;\n}",
    expectedKeywords: ["T"],
    maxOutputTokens: 10,
  },
]

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.95)
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0
}

/**
 * Exercise the ACTUAL production agent pipeline:
 * temporary workspace → .open-vs-code/models.json → loadRoutingConfig() →
 * createAgentRuntime() → RoutedModelGateway → ModelRouter → real local provider → tools → result
 */
export async function runAgentBenchmark(
  tasks: readonly AgentBenchmarkTask[],
  endpoint: string,
  modelId: string,
  logicalModelId: string = "qwen2.5-coder-7b",
): Promise<readonly AgentTaskResult[]> {
  const results: AgentTaskResult[] = []

  const tempDir = await mkdtemp(join(tmpdir(), "open-vs-code-benchmark-"))
  try {
    // 1. Create temporary repository fixture
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "benchmark-fixture", version: "1.0.0", type: "module" }, null, 2),
      "utf-8"
    )
    await writeFile(
      join(tempDir, "README.md"),
      "# Benchmark Repository\nA minimal deterministic fixture for real-model evaluation.\n",
      "utf-8"
    )
    await mkdir(join(tempDir, "src"), { recursive: true })
    await mkdir(join(tempDir, "tests"), { recursive: true })
    await writeFile(
      join(tempDir, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf-8"
    )
    await writeFile(
      join(tempDir, "src", "config.ts"),
      "export const SYSTEM_MAGIC_TOKEN = \"OVS_SECURE_TOKEN_9481\";\nexport const MAX_RETRY_COUNT = 5;\n",
      "utf-8"
    )
    await writeFile(
      join(tempDir, "src", "invoicing.ts"),
      "export function calculateInvoiceTotal(items: { price: number; quantity: number }[]): number {\n  return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);\n}\n",
      "utf-8"
    )
    await writeFile(
      join(tempDir, "src", "discount.ts"),
      "export function applySeasonalDiscount(total: number, percent: number): number {\n  // DELIBERATE BUG: multiplies instead of subtracting discount\n  return total * (percent / 100);\n}\n",
      "utf-8"
    )
    await writeFile(
      join(tempDir, "tests", "calculator.test.ts"),
      "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\n\ntest(\"asserts discount rate is non-negative\", () => {\n  assert.ok(true);\n});\n",
      "utf-8"
    )

    // 2. Write file-backed production routing config into .open-vs-code/models.json
    await mkdir(join(tempDir, ".open-vs-code"), { recursive: true })
    const routingConfig = {
      providers: [
        {
          id: "prov-local",
          kind: "openai_compatible_local",
          baseUrl: endpoint,
        },
      ],
      models: [
        {
          id: logicalModelId,
          contextWindow: 32768,
          capabilities: ["toolUse", "coding", "reasoning"],
          specialization: "coding",
          modelName: modelId,
        },
      ],
      deployments: [
        {
          id: "dep-benchmark",
          providerId: "prov-local",
          modelId: logicalModelId,
          modelName: modelId,
          endpoint,
          enabled: true,
          priority: 10,
        },
      ],
      routes: {
        general: ["dep-benchmark"],
        coding: ["dep-benchmark"],
        default: ["dep-benchmark"],
      },
    }
    await writeFile(
      join(tempDir, ".open-vs-code", "models.json"),
      JSON.stringify(routingConfig, null, 2),
      "utf-8"
    )

    // 3. Execute each task through production createAgentRuntime
    for (const task of tasks) {
      const t0 = Date.now()
      try {
        const events: AgentEvent[] = []
        const runtime = await createAgentRuntime({
          workspaceRoot: tempDir,
          mode: "ASK",
          instruction: task.prompt,
          isTrusted: true,
          eventSink: (ev) => { events.push(ev) },
        })
        runtime.performanceLedger?.disableAdaptiveRouting()
        runtime.routedGateway?.performanceLedger?.disableAdaptiveRouting()

        const result = await runtime.runner.run(runtime.runnerInput)

        let responseText = ""
        for (const ev of result.events) {
          if (ev.type === "model.completed") {
            const content = (ev.payload as Record<string, unknown>)?.response as Record<string, unknown> | undefined
            const msg = content?.message as Record<string, unknown> | undefined
            if (typeof msg?.content === "string") {
              responseText = msg.content
            }
          }
        }

        const toolCalls = result.toolCalls ?? []
        const validCalls = toolCalls.filter(tc => tc.outcome === "COMPLETED")
        const selectedToolNames = [...new Set(toolCalls.map(tc => tc.name))]

        const verification = task.verify
          ? task.verify(responseText, toolCalls)
          : {
              taskCorrect: task.expectedKeywords.some(kw => responseText.toLowerCase().includes(kw.toLowerCase())),
              grounded: task.expectedKeywords.filter(kw => responseText.toLowerCase().includes(kw.toLowerCase())).length > 0,
            }

        const requiredToolUsed = task.requiresTool
          ? toolCalls.length > 0 &&
            (!task.expectedTool || selectedToolNames.includes(task.expectedTool)) &&
            validCalls.length > 0
          : true

        const runtimeCompleted = result.status === "COMPLETED"
        const success = runtimeCompleted && verification.taskCorrect && requiredToolUsed
        const groundedSuccess = verification.grounded && requiredToolUsed

        const responseSha256 = createHash("sha256").update(responseText).digest("hex")

        const decision = runtime.routedGateway?.lastDecision
        const provDeploymentId = decision?.deploymentId ?? "dep-benchmark"
        const provProviderId = decision?.providerId ?? "prov-local"
        const provModelId = decision?.modelId ?? modelId

        results.push({
          taskId: task.id,
          name: task.name,
          category: task.category,
          runtimeCompleted,
          taskCorrect: verification.taskCorrect,
          grounded: verification.grounded,
          requiredToolUsed,
          success,
          groundedSuccess,
          latencyMs: Date.now() - t0,
          turns: result.turns,
          toolCallsCount: toolCalls.length,
          validToolCallsCount: validCalls.length,
          selectedToolNames,
          routeProvenance: {
            deploymentId: provDeploymentId,
            providerId: provProviderId,
            modelId: provModelId,
          },
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          responseLength: responseText.length,
          responseSha256,
        })
      } catch (error) {
        results.push({
          taskId: task.id,
          name: task.name,
          category: task.category,
          runtimeCompleted: false,
          taskCorrect: false,
          grounded: false,
          requiredToolUsed: false,
          success: false,
          groundedSuccess: false,
          latencyMs: Date.now() - t0,
          turns: 0,
          toolCallsCount: 0,
          validToolCallsCount: 0,
          selectedToolNames: [],
          failureReason: "INTERNAL_ERROR",
          responseLength: 0,
          responseSha256: createHash("sha256").update("").digest("hex"),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return results
}

/**
 * Exercise the ACTUAL production autocomplete pipeline:
 * temporary workspace → .open-vs-code/models.json →
 * createProductionAutocompleteGateway() → LocalFimProvider → completion
 */
export async function runFimBenchmark(
  fixtures: readonly FimBenchmarkFixture[],
  endpoint: string,
  modelId: string,
  fimStrategy: FimStrategy = "qwen",
  logicalModelId: string = "qwen2.5-coder-7b",
): Promise<readonly FimTaskResult[]> {
  const results: FimTaskResult[] = []

  const tempDir = await mkdtemp(join(tmpdir(), "open-vs-code-fim-benchmark-"))
  try {
    // 1. Write file-backed production routing config into .open-vs-code/models.json
    await mkdir(join(tempDir, ".open-vs-code"), { recursive: true })
    const fimRoutingConfig = {
      providers: [
        {
          id: "prov-fim-local",
          kind: "openai_compatible_local",
          baseUrl: endpoint,
        },
      ],
      models: [
        {
          id: logicalModelId,
          contextWindow: 32768,
          capabilities: ["autocomplete", "fim"],
          specialization: "coding",
          fimStrategy,
          modelName: modelId,
        },
      ],
      deployments: [
        {
          id: "dep-fim-benchmark",
          providerId: "prov-fim-local",
          modelId: logicalModelId,
          modelName: modelId,
          endpoint,
          enabled: true,
          priority: 10,
          fimStrategy,
        },
      ],
      routes: {
        autocomplete: ["dep-fim-benchmark"],
        default: ["dep-fim-benchmark"],
      },
    }
    await writeFile(
      join(tempDir, ".open-vs-code", "models.json"),
      JSON.stringify(fimRoutingConfig, null, 2),
      "utf-8"
    )

    // 2. Instantiate production AutocompleteGateway from workspace models.json
    const gateway = createProductionAutocompleteGateway(tempDir)
    gateway.performanceLedger?.disableAdaptiveRouting()

    // 3. Complete each fixture through production gateway
    for (const fixture of fixtures) {
      const t0 = Date.now()
      const signal = AbortSignal.timeout(60_000)
      try {
        const response = await gateway.complete({
          requestId: `benchmark-${fixture.id}`,
          prefix: fixture.prefix,
          suffix: fixture.suffix,
          languageId: fixture.language,
          maxOutputTokens: fixture.maxOutputTokens,
          signal,
        })
        const text = response.text
        const keywordMatches = fixture.expectedKeywords.filter(kw => text.toLowerCase().includes(kw.toLowerCase()))
        const exactMatch = fixture.expectedKeywords.some(kw => text.includes(kw))
        const nonEmpty = text.trim().length > 0
        const structurallyValid = validateStructuralSyntax(text, fixture.language, fixture.prefix, fixture.suffix)
        const success = exactMatch || (keywordMatches.length > 0 && structurallyValid)
        const sha256 = createHash("sha256").update(text).digest("hex")

        results.push({
          fixtureId: fixture.id,
          language: fixture.language,
          success,
          exactMatch,
          nonEmpty,
          structurallyValid,
          syntaxValid: structurallyValid,
          latencyMs: Date.now() - t0,
          emptyCompletion: !nonEmpty,
          completionLength: text.length,
          completionSha256: sha256,
          routeProvenance: {
            deploymentId: response.deploymentId,
            providerId: response.providerId,
            modelId,
          },
        })
      } catch (error) {
        results.push({
          fixtureId: fixture.id,
          language: fixture.language,
          success: false,
          exactMatch: false,
          nonEmpty: false,
          structurallyValid: false,
          syntaxValid: false,
          latencyMs: Date.now() - t0,
          emptyCompletion: true,
          completionLength: 0,
          completionSha256: createHash("sha256").update("").digest("hex"),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  return results
}

export interface RealModelBenchmarkOptions {
  readonly endpoint: string
  readonly logicalModelId?: string
  readonly servedModelId?: string
  readonly agentModelId: string
  readonly fimModelId: string
  readonly fimStrategy?: FimStrategy
  readonly providerRuntime?: string
  readonly outputDir?: string
  readonly allowDirtyWorktree?: boolean
  readonly gitProvenanceOverride?: GitProvenance
  readonly skipPreflightWarmup?: boolean
  readonly fetchFn?: typeof fetch
  readonly customTasks?: {
    readonly agentTasks?: readonly AgentBenchmarkTask[]
    readonly fimTasks?: readonly FimBenchmarkFixture[]
  }
}

export interface BenchmarkPreflightResult {
  readonly status: BenchmarkStatus
  readonly inferenceAuthorized: boolean
  readonly endpointReachable: boolean
  readonly modelsEndpointSuccess: boolean
  readonly requestedModelsAvailable: boolean
  readonly warmupSucceeded: boolean
  readonly worktreeClean: boolean
  readonly gitSha: string
  readonly blockerReason?: string | undefined
  readonly servedModels: readonly string[]
  readonly discoveredRuntime: string
}

export async function performBenchmarkPreflight(
  options: RealModelBenchmarkOptions
): Promise<BenchmarkPreflightResult> {
  const servedModelId = options.servedModelId ?? options.agentModelId
  const gitProv = options.gitProvenanceOverride ?? checkGitProvenance()
  const worktreeClean = gitProv.worktreeClean
  const gitSha = gitProv.gitSha

  // 1. Worktree cleanliness check
  if (!worktreeClean && !options.allowDirtyWorktree) {
    return {
      status: "BLOCKED_WITH_EVIDENCE",
      inferenceAuthorized: false,
      endpointReachable: false,
      modelsEndpointSuccess: false,
      requestedModelsAvailable: false,
      warmupSucceeded: false,
      worktreeClean: false,
      gitSha,
      blockerReason: `DIRTY_WORKTREE: Working tree contains uncommitted changes (${gitProv.dirtyFiles?.length ?? 0} files). Permanent closure requires a clean committed worktree.`,
      servedModels: [],
      discoveredRuntime: "unknown",
    }
  }

  // 2. Authorization check
  const gate = checkInferenceGate()
  if (!gate.authorized) {
    return {
      status: "BLOCKED_WITH_EVIDENCE",
      inferenceAuthorized: false,
      endpointReachable: false,
      modelsEndpointSuccess: false,
      requestedModelsAvailable: false,
      warmupSucceeded: false,
      worktreeClean,
      gitSha,
      blockerReason: `UNAUTHORIZED_INFERENCE: ${gate.reason}`,
      servedModels: [],
      discoveredRuntime: "unknown",
    }
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch

  // 3. Endpoint reachability and /v1/models probe
  let modelsRes: Response
  try {
    const modelsUrl = new URL("/v1/models", options.endpoint)
    modelsRes = await fetchFn(modelsUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    return {
      status: "BLOCKED_WITH_EVIDENCE",
      inferenceAuthorized: true,
      endpointReachable: false,
      modelsEndpointSuccess: false,
      requestedModelsAvailable: false,
      warmupSucceeded: false,
      worktreeClean,
      gitSha,
      blockerReason: `ENDPOINT_UNREACHABLE: Could not connect to endpoint ${options.endpoint} (${err instanceof Error ? err.message : String(err)})`,
      servedModels: [],
      discoveredRuntime: "unknown",
    }
  }

  // 4. /v1/models response success
  if (!modelsRes.ok) {
    return {
      status: "BLOCKED_WITH_EVIDENCE",
      inferenceAuthorized: true,
      endpointReachable: true,
      modelsEndpointSuccess: false,
      requestedModelsAvailable: false,
      warmupSucceeded: false,
      worktreeClean,
      gitSha,
      blockerReason: `MODELS_ENDPOINT_FAILED: Endpoint ${options.endpoint}/v1/models returned HTTP ${modelsRes.status} (${modelsRes.statusText})`,
      servedModels: [],
      discoveredRuntime: "unknown",
    }
  }

  // Parse /v1/models response
  let servedModels: string[] = []
  try {
    const data = await modelsRes.json() as any
    if (Array.isArray(data?.data)) {
      servedModels = data.data
        .map((m: any) => (typeof m === "string" ? m : typeof m?.id === "string" ? m.id : String(m?.id ?? "")))
        .filter(Boolean)
    }
  } catch (err) {
    return {
      status: "BLOCKED_WITH_EVIDENCE",
      inferenceAuthorized: true,
      endpointReachable: true,
      modelsEndpointSuccess: false,
      requestedModelsAvailable: false,
      warmupSucceeded: false,
      worktreeClean,
      gitSha,
      blockerReason: `MODELS_RESPONSE_MALFORMED: Failed to parse /v1/models response (${err instanceof Error ? err.message : String(err)})`,
      servedModels: [],
      discoveredRuntime: "unknown",
    }
  }

  // 5. Requested agent served model and FIM served model exist
  const modelExists = (target: string) => {
    return servedModels.some(
      m => m === target || m === `${target}:latest` || (target.endsWith(":latest") && m === target.replace(":latest", ""))
    )
  }

  const agentModelAvailable = modelExists(servedModelId)
  const fimModelAvailable = modelExists(options.fimModelId)

  if (!agentModelAvailable || !fimModelAvailable) {
    const missing: string[] = []
    if (!agentModelAvailable) missing.push(`agent model "${servedModelId}"`)
    if (!fimModelAvailable) missing.push(`FIM model "${options.fimModelId}"`)
    return {
      status: "BLOCKED_WITH_EVIDENCE",
      inferenceAuthorized: true,
      endpointReachable: true,
      modelsEndpointSuccess: true,
      requestedModelsAvailable: false,
      warmupSucceeded: false,
      worktreeClean,
      gitSha,
      blockerReason: `MODEL_NOT_SERVED: Requested ${missing.join(" and ")} not found on server. Available served models: [${servedModels.length > 0 ? servedModels.join(", ") : "none"}]`,
      servedModels,
      discoveredRuntime: "unknown",
    }
  }

  // Discover provider runtime truthfully
  const discoveredRuntime = options.providerRuntime && options.providerRuntime !== "local-openai-compatible"
    ? options.providerRuntime
    : await discoverProviderRuntime(options.endpoint)

  // 6. Minimal authorized warmup inference request
  if (!options.skipPreflightWarmup) {
    try {
      const warmupProvider = new OpenAICompatibleProvider({
        baseUrl: options.endpoint,
        model: servedModelId,
        timeoutMs: 15_000,
        fetch: fetchFn,
      })
      const warmupRes = await warmupProvider.complete({
        messages: [{ role: "user", content: "Say READY." }],
        temperature: 0,
        maxOutputTokens: 10,
      })
      if (!warmupRes?.message?.content && warmupRes?.message?.content !== "") {
        throw new Error("Warmup response was empty")
      }
    } catch (err) {
      return {
        status: "BLOCKED_WITH_EVIDENCE",
        inferenceAuthorized: true,
        endpointReachable: true,
        modelsEndpointSuccess: true,
        requestedModelsAvailable: true,
        warmupSucceeded: false,
        worktreeClean,
        gitSha,
        blockerReason: `WARMUP_FAILED: Minimal inference request to ${servedModelId} failed (${err instanceof Error ? err.message : String(err)})`,
        servedModels,
        discoveredRuntime,
      }
    }
  }

  return {
    status: "EXECUTED",
    inferenceAuthorized: true,
    endpointReachable: true,
    modelsEndpointSuccess: true,
    requestedModelsAvailable: true,
    warmupSucceeded: true,
    worktreeClean,
    gitSha,
    servedModels,
    discoveredRuntime,
  }
}

export interface ClosureVerificationResult {
  readonly satisfiesPermanentClosure: boolean
  readonly reasons: readonly string[]
}

export function verifyPermanentClosure(artifact: BenchmarkArtifact): ClosureVerificationResult {
  const reasons: string[] = []

  if (artifact.status !== "EXECUTED") {
    reasons.push(`Benchmark status must be 'EXECUTED', was: '${artifact.status}'`)
  }
  if (!artifact.executed) {
    reasons.push("Benchmark artifact is marked executed: false")
  }
  if (!artifact.measuredTasksExecuted) {
    reasons.push("Measured tasks were not executed")
  }
  if (!artifact.worktreeClean) {
    reasons.push("Working tree was not clean at benchmark execution")
  }
  if (!artifact.inferenceAuthorized) {
    reasons.push("Inference was not authorized (OPEN_VS_CODE_REAL_INFERENCE !== '1')")
  }
  if (!artifact.endpointReachable) {
    reasons.push("Configured endpoint was not reachable")
  }
  if (!artifact.requestedModelsAvailable) {
    reasons.push("Requested models were not available on the inference host")
  }
  if (!artifact.warmupSucceeded) {
    reasons.push("Warmup inference request failed")
  }
  if (!artifact.gitSha || artifact.gitSha === "unknown") {
    reasons.push("Git SHA must be a valid commit hash")
  }
  if (artifact.agentTasks.length !== 10) {
    reasons.push(`Expected exactly 10 agent tasks, got ${artifact.agentTasks.length}`)
  }
  if (artifact.fimTasks.length !== 8) {
    reasons.push(`Expected exactly 8 FIM tasks, got ${artifact.fimTasks.length}`)
  }

  // Tool traversal check on the 4 tool-required tasks
  const toolRequiredIds = ["T001", "T002", "T003", "T004"]
  const toolTasks = artifact.agentTasks.filter(t => toolRequiredIds.includes(t.taskId))
  const toolTraversedCount = toolTasks.filter(t => t.requiredToolUsed || t.toolCallsCount > 0).length
  if (toolTraversedCount < 4) {
    reasons.push(`Tool-required agent tasks must genuinely traverse repository tools: traversed ${toolTraversedCount}/4`)
  }

  return {
    satisfiesPermanentClosure: reasons.length === 0,
    reasons,
  }
}

async function writeArtifactFiles(outputDir: string, artifact: BenchmarkArtifact): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  const baseName = `benchmark-${artifact.gitSha.slice(0, 8)}-${Date.now()}`
  const jsonPath = join(outputDir, `${baseName}.json`)
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2), "utf-8")
  console.error(`[benchmark] JSON artifact written: ${jsonPath}`)

  const isBlocked = artifact.status === "BLOCKED_WITH_EVIDENCE"
  const isFailed = artifact.status === "FAILED"

  const mdLines = [
    `# Sprint 4E Real Model Benchmark Report${isBlocked ? " (BLOCKED)" : isFailed ? " (FAILED)" : ""}`,
    ``,
    `- **Status:** \`${artifact.status}\``,
    `- **Executed:** \`${artifact.executed}\``,
    `- **Measured Tasks Executed:** \`${artifact.measuredTasksExecuted}\``,
    `- **Worktree Clean:** \`${artifact.worktreeClean}\``,
    `- **Date:** ${artifact.timestamp}`,
    `- **Git SHA:** \`${artifact.gitSha}\``,
  ]

  if (artifact.blockerReason) {
    mdLines.push(`- **Blocker Reason:** ${artifact.blockerReason}`)
  }

  mdLines.push(
    `- **Inference Authorized:** \`${artifact.inferenceAuthorized}\``,
    `- **Endpoint Reachable:** \`${artifact.endpointReachable}\``,
    `- **Requested Models Available:** \`${artifact.requestedModelsAvailable}\``,
    `- **Warmup Succeeded:** \`${artifact.warmupSucceeded}\``,
    `- **Hardware:** ${artifact.hardware}`,
    `- **OS:** ${artifact.os}`,
    `- **Node:** ${artifact.nodeVersion}`,
    `- **Runtime:** ${artifact.providerRuntime}`,
    `- **Endpoint:** \`${artifact.endpoint}\``,
    `- **Logical Model:** \`${artifact.logicalModelId}\``,
    `- **Served Model:** \`${artifact.servedModelId}\``,
    `- **FIM Model:** \`${artifact.fimModelId}\``,
    `- **FIM Strategy:** \`${artifact.fimStrategy}\``,
    ``,
    `## Agent Summary`,
    `- **Total Tasks:** ${artifact.agentSummary.total}`,
    `- **Success Count:** ${artifact.agentSummary.success}`,
    `- **Success Rate:** ${(artifact.agentSummary.successRate * 100).toFixed(1)}%`,
    `- **Tool-Required Tasks:** ${artifact.agentSummary.toolRequiredSuccessCount}/${artifact.agentSummary.toolRequiredCount}`,
    `- **Median Latency:** ${artifact.agentSummary.medianLatencyMs.toFixed(0)} ms`,
    `- **P95 Latency:** ${artifact.agentSummary.p95LatencyMs.toFixed(0)} ms`,
    ``,
    `## FIM Summary`,
    `- **Total Tasks:** ${artifact.fimSummary.total}`,
    `- **Success Count:** ${artifact.fimSummary.success}`,
    `- **Success Rate:** ${(artifact.fimSummary.successRate * 100).toFixed(1)}%`,
    `- **Non-Empty Rate:** ${(artifact.fimSummary.nonEmptyRate * 100).toFixed(1)}%`,
    `- **Structurally-Valid Rate:** ${(artifact.fimSummary.structurallyValidRate * 100).toFixed(1)}%`,
    `- **Empty Rate:** ${(artifact.fimSummary.emptyRate * 100).toFixed(1)}%`,
    `- **Median Latency:** ${artifact.fimSummary.medianLatencyMs.toFixed(0)} ms`,
    `- **P95 Latency:** ${artifact.fimSummary.p95LatencyMs.toFixed(0)} ms`,
    ``
  )

  const mdPath = join(outputDir, `${baseName}.md`)
  await writeFile(mdPath, mdLines.join("\n"), "utf-8")
  console.error(`[benchmark] Markdown report written: ${mdPath}`)
}

export async function runRealModelBenchmark(options: RealModelBenchmarkOptions): Promise<BenchmarkArtifact> {
  const logicalModelId = options.logicalModelId ?? "qwen2.5-coder-7b"
  const servedModelId = options.servedModelId ?? options.agentModelId
  const fimStrategy = options.fimStrategy ?? "qwen"
  const cpuModel = cpus()[0]?.model ?? "unknown"
  const ramGb = Math.round(totalmem() / 1024 / 1024 / 1024)

  // 1. Perform benchmark preflight acceptance checks
  const preflight = await performBenchmarkPreflight(options)

  if (preflight.status !== "EXECUTED") {
    console.error(`[benchmark] PREFLIGHT BLOCKED: ${preflight.blockerReason}`)
    const artifact: BenchmarkArtifact = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      status: preflight.status,
      executed: false,
      blockerReason: preflight.blockerReason,
      gitSha: preflight.gitSha,
      worktreeClean: preflight.worktreeClean,
      timestamp: new Date().toISOString(),
      hardware: getHardwareSummary(),
      os: `${platform()} ${arch()}`,
      cpu: cpuModel,
      ramGb,
      nodeVersion: process.version,
      providerRuntime: preflight.discoveredRuntime,
      endpoint: options.endpoint,
      logicalModelId,
      servedModelId,
      agentModelId: servedModelId,
      fimModelId: options.fimModelId,
      fimStrategy,
      inferenceAuthorized: preflight.inferenceAuthorized,
      endpointReachable: preflight.endpointReachable,
      requestedModelsAvailable: preflight.requestedModelsAvailable,
      warmupSucceeded: preflight.warmupSucceeded,
      measuredTasksExecuted: false,
      agentTasks: [],
      fimTasks: [],
      agentSummary: {
        total: 0,
        success: 0,
        successRate: 0,
        toolRequiredCount: 0,
        toolRequiredSuccessCount: 0,
        toolUseRate: 0,
        medianLatencyMs: 0,
        p95LatencyMs: 0,
      },
      fimSummary: {
        total: 0,
        success: 0,
        successRate: 0,
        nonEmptyRate: 0,
        structurallyValidRate: 0,
        syntaxValidRate: 0,
        emptyRate: 0,
        medianLatencyMs: 0,
        p95LatencyMs: 0,
      },
    }

    if (options.outputDir) {
      await writeArtifactFiles(options.outputDir, artifact)
    }

    return artifact
  }

  // 2. Preflight passed! Measured tasks begin.
  const tasksToRun = options.customTasks?.agentTasks ?? AGENT_BENCHMARK_TASKS
  const fimToRun = options.customTasks?.fimTasks ?? FIM_BENCHMARK_FIXTURES

  let agentTasks: readonly AgentTaskResult[] = []
  let fimTasks: readonly FimTaskResult[] = []

  try {
    console.error(`[benchmark] Running ${tasksToRun.length} agent tasks through production AgentRuntime stack...`)
    agentTasks = await runAgentBenchmark(tasksToRun, options.endpoint, servedModelId, logicalModelId)

    console.error(`[benchmark] Running ${fimToRun.length} FIM tasks through production AutocompleteGateway...`)
    fimTasks = await runFimBenchmark(fimToRun, options.endpoint, options.fimModelId, fimStrategy, logicalModelId)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[benchmark] EXECUTION FAILED: ${errorMsg}`)
    const artifact: BenchmarkArtifact = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      status: "FAILED",
      executed: false,
      blockerReason: `EXECUTION_FAILED: ${errorMsg}`,
      gitSha: preflight.gitSha,
      worktreeClean: preflight.worktreeClean,
      timestamp: new Date().toISOString(),
      hardware: getHardwareSummary(),
      os: `${platform()} ${arch()}`,
      cpu: cpuModel,
      ramGb,
      nodeVersion: process.version,
      providerRuntime: preflight.discoveredRuntime,
      endpoint: options.endpoint,
      logicalModelId,
      servedModelId,
      agentModelId: servedModelId,
      fimModelId: options.fimModelId,
      fimStrategy,
      inferenceAuthorized: true,
      endpointReachable: true,
      requestedModelsAvailable: true,
      warmupSucceeded: true,
      measuredTasksExecuted: false,
      agentTasks,
      fimTasks,
      agentSummary: {
        total: agentTasks.length,
        success: agentTasks.filter(t => t.success).length,
        successRate: agentTasks.length > 0 ? agentTasks.filter(t => t.success).length / agentTasks.length : 0,
        toolRequiredCount: 0,
        toolRequiredSuccessCount: 0,
        toolUseRate: 0,
        medianLatencyMs: 0,
        p95LatencyMs: 0,
      },
      fimSummary: {
        total: fimTasks.length,
        success: fimTasks.filter(t => t.success).length,
        successRate: fimTasks.length > 0 ? fimTasks.filter(t => t.success).length / fimTasks.length : 0,
        nonEmptyRate: 0,
        structurallyValidRate: 0,
        syntaxValidRate: 0,
        emptyRate: 0,
        medianLatencyMs: 0,
        p95LatencyMs: 0,
      },
    }

    if (options.outputDir) {
      await writeArtifactFiles(options.outputDir, artifact)
    }

    return artifact
  }

  // 3. Compute summaries
  const agentLatencies = agentTasks.map(t => t.latencyMs)
  const fimLatencies = fimTasks.map(t => t.latencyMs)

  const agentSuccess = agentTasks.filter(t => t.success).length
  const toolRequiredTasks = agentTasks.filter(t => {
    const orig = AGENT_BENCHMARK_TASKS.find(item => item.id === t.taskId)
    return orig?.requiresTool === true
  })
  const toolRequiredSuccess = toolRequiredTasks.filter(t => t.success).length

  const fimSuccess = fimTasks.filter(t => t.success).length
  const fimNonEmpty = fimTasks.filter(t => t.nonEmpty).length
  const fimStructurallyValid = fimTasks.filter(t => t.structurallyValid).length
  const fimEmpty = fimTasks.filter(t => t.emptyCompletion).length

  const artifact: BenchmarkArtifact = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    status: "EXECUTED",
    executed: true,
    gitSha: preflight.gitSha,
    worktreeClean: preflight.worktreeClean,
    timestamp: new Date().toISOString(),
    hardware: getHardwareSummary(),
    os: `${platform()} ${arch()}`,
    cpu: cpuModel,
    ramGb,
    nodeVersion: process.version,
    providerRuntime: preflight.discoveredRuntime,
    endpoint: options.endpoint,
    logicalModelId,
    servedModelId,
    agentModelId: servedModelId,
    fimModelId: options.fimModelId,
    fimStrategy,
    inferenceAuthorized: true,
    endpointReachable: true,
    requestedModelsAvailable: true,
    warmupSucceeded: true,
    measuredTasksExecuted: true,
    agentTasks,
    fimTasks,
    agentSummary: {
      total: agentTasks.length,
      success: agentSuccess,
      successRate: agentTasks.length > 0 ? agentSuccess / agentTasks.length : 0,
      toolRequiredCount: toolRequiredTasks.length,
      toolRequiredSuccessCount: toolRequiredSuccess,
      toolUseRate: toolRequiredTasks.length > 0 ? toolRequiredSuccess / toolRequiredTasks.length : 0,
      medianLatencyMs: median(agentLatencies),
      p95LatencyMs: percentile95(agentLatencies),
    },
    fimSummary: {
      total: fimTasks.length,
      success: fimSuccess,
      successRate: fimTasks.length > 0 ? fimSuccess / fimTasks.length : 0,
      nonEmptyRate: fimTasks.length > 0 ? fimNonEmpty / fimTasks.length : 0,
      structurallyValidRate: fimTasks.length > 0 ? fimStructurallyValid / fimTasks.length : 0,
      syntaxValidRate: fimTasks.length > 0 ? fimStructurallyValid / fimTasks.length : 0,
      emptyRate: fimTasks.length > 0 ? fimEmpty / fimTasks.length : 0,
      medianLatencyMs: median(fimLatencies),
      p95LatencyMs: percentile95(fimLatencies),
    },
  }

  if (options.outputDir) {
    await writeArtifactFiles(options.outputDir, artifact)
  }

  return artifact
}

/**
 * CLI entry point for `npm run eval:models`.
 */
export async function benchmarkCli(): Promise<void> {
  const gate = checkInferenceGate()
  const endpoint = gate.endpoint ?? process.env["OPEN_VS_CODE_MODEL_ENDPOINT"] ?? "http://127.0.0.1:11434"
  const logicalModel = process.env["OPEN_VS_CODE_LOGICAL_MODEL"] ?? "qwen2.5-coder-7b"
  const agentModel = process.env["OPEN_VS_CODE_AGENT_MODEL"] ?? "qwen2.5-coder:7b"
  const fimModel = process.env["OPEN_VS_CODE_FIM_MODEL"] ?? "qwen2.5-coder:7b"
  const fimStrategy = (process.env["OPEN_VS_CODE_FIM_STRATEGY"] ?? "qwen") as FimStrategy
  const outputDir = process.env["OPEN_VS_CODE_BENCHMARK_OUTPUT"] ?? getCanonicalEvalsDir()

  console.log(`[benchmark] Starting Sprint 4E real model benchmark harness`)
  console.log(`[benchmark] Endpoint: ${endpoint}`)
  console.log(`[benchmark] Logical model: ${logicalModel}`)
  console.log(`[benchmark] Served model: ${agentModel}`)
  console.log(`[benchmark] FIM model: ${fimModel} (strategy: ${fimStrategy})`)
  console.log(`[benchmark] Output dir: ${outputDir}`)

  try {
    const artifact = await runRealModelBenchmark({
      endpoint,
      logicalModelId: logicalModel,
      servedModelId: agentModel,
      agentModelId: agentModel,
      fimModelId: fimModel,
      fimStrategy,
      outputDir,
    })

    if (artifact.status === "BLOCKED_WITH_EVIDENCE") {
      console.log("\n=== BENCHMARK BLOCKED WITH EVIDENCE ===")
      console.log(`Status: ${artifact.status}`)
      console.log(`Blocker Reason: ${artifact.blockerReason}`)
      console.log(`Inference Authorized: ${artifact.inferenceAuthorized}`)
      console.log(`Endpoint Reachable: ${artifact.endpointReachable}`)
      console.log(`Requested Models Available: ${artifact.requestedModelsAvailable}`)
      console.log(`Warmup Succeeded: ${artifact.warmupSucceeded}`)
      console.log(`Worktree Clean: ${artifact.worktreeClean}`)
      console.log(`Measured Tasks Executed: ${artifact.measuredTasksExecuted} (zero fixtures run under blocked preflight)`)
      console.log(`Diagnostic Artifact: ${outputDir}/`)
      return
    }

    if (artifact.status === "FAILED") {
      console.error("\n=== BENCHMARK EXECUTION FAILED ===")
      console.error(`Status: ${artifact.status}`)
      console.error(`Blocker/Error: ${artifact.blockerReason}`)
      process.exit(1)
    }

    console.log("\n=== BENCHMARK RESULTS ===")
    console.log(`Status: ${artifact.status}`)
    console.log(`Runtime: ${artifact.providerRuntime}`)
    console.log(`Agent tasks: ${artifact.agentSummary.success}/${artifact.agentSummary.total} (${(artifact.agentSummary.successRate * 100).toFixed(1)}%)`)
    console.log(`Tool-required tasks: ${artifact.agentSummary.toolRequiredSuccessCount}/${artifact.agentSummary.toolRequiredCount}`)
    console.log(`Agent median latency: ${artifact.agentSummary.medianLatencyMs.toFixed(0)}ms`)
    console.log(`FIM tasks: ${artifact.fimSummary.success}/${artifact.fimSummary.total} (${(artifact.fimSummary.successRate * 100).toFixed(1)}%)`)
    console.log(`FIM syntax valid rate: ${(artifact.fimSummary.syntaxValidRate * 100).toFixed(1)}%`)
    console.log(`FIM median latency: ${artifact.fimSummary.medianLatencyMs.toFixed(0)}ms`)
    console.log(`FIM empty rate: ${(artifact.fimSummary.emptyRate * 100).toFixed(1)}%`)
    console.log(`\nArtifact: ${outputDir}/`)
    console.log(`Git SHA: ${artifact.gitSha} (clean: ${artifact.worktreeClean})`)
    console.log(`Hardware: ${artifact.hardware}`)

    const closureCheck = verifyPermanentClosure(artifact)
    if (closureCheck.satisfiesPermanentClosure) {
      console.log("\n>>> SPRINT 4E PERMANENT CLOSURE REQUIREMENTS SATISFIED <<<")
    } else {
      console.log("\n>>> BENCHMARK EXECUTED BUT DID NOT SATISFY PERMANENT CLOSURE <<<")
      for (const reason of closureCheck.reasons) {
        console.log(` - ${reason}`)
      }
    }
  } catch (error) {
    console.error("[benchmark] ERROR:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
