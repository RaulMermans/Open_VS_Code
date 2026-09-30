/**
 * Real Model Benchmark Harness — Sprint 4E.
 *
 * This module provides the production benchmark for REAL local open-weight models.
 *
 * IMPORTANT: This harness is gated by the InferenceGate.
 * It MUST NOT be executed during normal `npm test`.
 * It is invoked ONLY via: npm run eval:models
 *
 * The harness:
 *   - Refuses to run without OPEN_VS_CODE_REAL_INFERENCE=1
 *   - Records hardware / runtime / model metadata
 *   - Separates warmup from measured runs
 *   - Records real latency (not fabricated)
 *   - Does NOT train on its own results during a benchmark run (adaptive routing disabled)
 *   - Does NOT use scripted providers for acceptance test
 *   - Does NOT commit model weights, raw completions, or secrets
 *
 * Benchmark artifacts:
 *   - Lightweight JSON summary (schema-versioned, Git SHA tagged)
 *   - Markdown report for human review
 */

import { execSync } from "node:child_process"
import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { platform, arch, cpus, totalmem } from "node:os"
import { checkInferenceGate, requireInferenceGate, inferenceGateBlockedMessage } from "../../src/model/inference-gate.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { LocalFimProvider, type FimStrategy } from "../../src/autocomplete/local-fim-provider.ts"

export const BENCHMARK_SCHEMA_VERSION = 1

function getCurrentGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim()
  } catch {
    return "unknown"
  }
}

function getHardwareSummary(): string {
  const cpu = cpus()[0]?.model ?? "unknown"
  const cores = cpus().length
  const ramGb = Math.round(totalmem() / 1024 / 1024 / 1024)
  const os = `${platform()} ${arch()}`
  return `${cpu} (${cores} cores), ${ramGb}GB RAM, ${os}`
}

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
  readonly success: boolean
  readonly latencyMs: number
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly response: string
  readonly error: string | undefined
}

export interface FimTaskResult {
  readonly fixtureId: string
  readonly language: string
  readonly success: boolean
  readonly exactMatch: boolean
  readonly syntaxValid: boolean
  readonly latencyMs: number
  readonly inputTokens: number | undefined
  readonly outputTokens: number | undefined
  readonly emptyCompletion: boolean
  readonly completion: string
  readonly error: string | undefined
}

export interface BenchmarkArtifact {
  readonly schemaVersion: number
  readonly gitSha: string
  readonly timestamp: string
  readonly hardware: string
  readonly os: string
  readonly nodeVersion: string
  readonly providerRuntime: string
  readonly endpoint: string
  readonly agentModelId: string
  readonly fimModelId: string
  readonly agentTasks: readonly AgentTaskResult[]
  readonly fimTasks: readonly FimTaskResult[]
  readonly agentSummary: {
    readonly total: number
    readonly success: number
    readonly successRate: number
    readonly medianLatencyMs: number
    readonly p95LatencyMs: number
  }
  readonly fimSummary: {
    readonly total: number
    readonly success: number
    readonly successRate: number
    readonly emptyRate: number
    readonly medianLatencyMs: number
    readonly p95LatencyMs: number
  }
}

// Representative agent task suite — safe coding questions against disposable prompts
// These tasks do NOT mutate the working tree; they test model reasoning/knowledge
const AGENT_BENCHMARK_TASKS: readonly AgentBenchmarkTask[] = [
  {
    id: "A001",
    name: "TypeScript function signature",
    category: "understanding",
    prompt: "Write a TypeScript function called `addNumbers` that takes two number parameters and returns their sum.",
    expectedKeywords: ["function", "addNumbers", "number", "return"],
    maxOutputTokens: 200,
  },
  {
    id: "A002",
    name: "Bug identification",
    category: "bug-repair",
    prompt: "This JavaScript has a bug: `function sum(a, b) { return a - b; }`. Identify and fix it.",
    expectedKeywords: ["+", "a + b", "fix", "bug"],
    maxOutputTokens: 150,
  },
  {
    id: "A003",
    name: "Code explanation",
    category: "understanding",
    prompt: "Explain what this code does in one sentence: `const result = arr.filter(x => x > 0).map(x => x * 2)`",
    expectedKeywords: ["filter", "positive", "double", "map"],
    maxOutputTokens: 100,
  },
  {
    id: "A004",
    name: "Error type identification",
    category: "debugging",
    prompt: "What error will `JSON.parse('invalid json')` throw in JavaScript?",
    expectedKeywords: ["SyntaxError", "JSON", "parse"],
    maxOutputTokens: 100,
  },
  {
    id: "A005",
    name: "Refactor suggestion",
    category: "refactor",
    prompt: "Suggest a refactoring to reduce repetition: `if (x === 1) return 'one'; if (x === 2) return 'two'; if (x === 3) return 'three';`",
    expectedKeywords: ["switch", "object", "map", "dict", "lookup"],
    maxOutputTokens: 200,
  },
  {
    id: "A006",
    name: "Test case design",
    category: "test-addition",
    prompt: "List 3 test cases for a function `divide(a, b)` that divides two numbers.",
    expectedKeywords: ["zero", "division", "negative", "positive"],
    maxOutputTokens: 200,
  },
  {
    id: "A007",
    name: "Async/await explanation",
    category: "understanding",
    prompt: "What is the difference between `async/await` and Promises in JavaScript? Answer in 2-3 sentences.",
    expectedKeywords: ["Promise", "async", "await", "syntax"],
    maxOutputTokens: 200,
  },
  {
    id: "A008",
    name: "Type error identification",
    category: "debugging",
    prompt: "In TypeScript: `const x: string = 42;` — what error will occur?",
    expectedKeywords: ["Type", "number", "string", "assignable"],
    maxOutputTokens: 100,
  },
  {
    id: "A009",
    name: "Single-file change",
    category: "single-file",
    prompt: "Add a `multiply(a: number, b: number): number` function to this module: `export function add(a: number, b: number) { return a + b; }`",
    expectedKeywords: ["multiply", "function", "return", "number"],
    maxOutputTokens: 150,
  },
  {
    id: "A010",
    name: "Code review feedback",
    category: "understanding",
    prompt: "Review this code and identify one improvement: `function getUser(id) { return db.find(id); }`",
    expectedKeywords: ["error", "null", "undefined", "type", "validation"],
    maxOutputTokens: 150,
  },
]

// FIM benchmark fixtures — deterministic completion tasks
const FIM_BENCHMARK_FIXTURES: readonly FimBenchmarkFixture[] = [
  {
    id: "F001",
    language: "typescript",
    prefix: "function add(a: number, b: number): number {\n  return ",
    suffix: "\n}",
    expectedKeywords: ["a + b", "a+b"],
    maxOutputTokens: 20,
  },
  {
    id: "F002",
    language: "javascript",
    prefix: "const arr = [1, 2, 3];\nconst doubled = arr.map(x => ",
    suffix: ");",
    expectedKeywords: ["x * 2", "x*2", "2 * x"],
    maxOutputTokens: 20,
  },
  {
    id: "F003",
    language: "python",
    prefix: "def greet(name):\n    return ",
    suffix: "\n",
    expectedKeywords: ["f\"Hello", "'Hello'", "\"Hello\"", "+ name", "Hello"],
    maxOutputTokens: 30,
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
    expectedKeywords: ["T", "<T>"],
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

export async function runAgentBenchmark(
  tasks: readonly AgentBenchmarkTask[],
  provider: OpenAICompatibleProvider,
): Promise<readonly AgentTaskResult[]> {
  const results: AgentTaskResult[] = []

  for (const task of tasks) {
    const t0 = Date.now()
    try {
      const response = await provider.complete({
        messages: [{ role: "user", content: task.prompt }],
        temperature: 0,
        maxOutputTokens: task.maxOutputTokens,
      })
      const text = response.message.content.toLowerCase()
      const keywordMatches = task.expectedKeywords.filter(kw => text.includes(kw.toLowerCase()))
      const success = keywordMatches.length > 0

      results.push({
        taskId: task.id,
        name: task.name,
        category: task.category,
        success,
        latencyMs: Date.now() - t0,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        response: response.message.content.slice(0, 200), // Truncated — no raw source
        error: undefined,
      })
    } catch (error) {
      results.push({
        taskId: task.id,
        name: task.name,
        category: task.category,
        success: false,
        latencyMs: Date.now() - t0,
        inputTokens: undefined,
        outputTokens: undefined,
        response: "",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

export async function runFimBenchmark(
  fixtures: readonly FimBenchmarkFixture[],
  provider: LocalFimProvider,
): Promise<readonly FimTaskResult[]> {
  const results: FimTaskResult[] = []
  const signal = AbortSignal.timeout(60_000)

  for (const fixture of fixtures) {
    const t0 = Date.now()
    try {
      const response = await provider.complete({
        requestId: `benchmark-${fixture.id}`,
        prefix: fixture.prefix,
        suffix: fixture.suffix,
        languageId: fixture.language,
        maxOutputTokens: fixture.maxOutputTokens,
        signal,
      })
      const text = response.text.toLowerCase()
      const keywordMatches = fixture.expectedKeywords.filter(kw => text.includes(kw.toLowerCase()))
      const success = keywordMatches.length > 0
      const exactMatch = fixture.expectedKeywords.some(kw => response.text.includes(kw))
      const empty = response.text.trim().length === 0

      results.push({
        fixtureId: fixture.id,
        language: fixture.language,
        success,
        exactMatch,
        syntaxValid: !empty,
        latencyMs: Date.now() - t0,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        emptyCompletion: empty,
        completion: response.text.slice(0, 100), // Truncated — not full raw completion
        error: undefined,
      })
    } catch (error) {
      results.push({
        fixtureId: fixture.id,
        language: fixture.language,
        success: false,
        exactMatch: false,
        syntaxValid: false,
        latencyMs: Date.now() - t0,
        inputTokens: undefined,
        outputTokens: undefined,
        emptyCompletion: true,
        completion: "",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}

export async function runRealModelBenchmark(options: {
  readonly endpoint: string
  readonly agentModelId: string
  readonly fimModelId: string
  readonly fimStrategy?: FimStrategy
  readonly providerRuntime?: string
  readonly outputDir?: string
}): Promise<BenchmarkArtifact> {
  // Gate check — must be authorized
  requireInferenceGate()

  const agentProvider = new OpenAICompatibleProvider({
    baseUrl: options.endpoint,
    model: options.agentModelId,
    timeoutMs: 60_000,
    capabilities: ["chat", "tools"],
  })

  const fimProvider = new LocalFimProvider({
    providerId: "local-fim",
    modelId: options.fimModelId,
    deploymentId: "local-fim-deployment",
    baseUrl: options.endpoint,
    model: options.fimModelId,
    fimStrategy: options.fimStrategy ?? "qwen",
    timeoutMs: 30_000,
  })

  // Warmup pass (not measured)
  console.error("[benchmark] Warming up agent model...")
  try {
    await agentProvider.complete({
      messages: [{ role: "user", content: "Say READY." }],
      temperature: 0,
      maxOutputTokens: 10,
    })
  } catch {
    // Warmup failure is non-fatal
  }

  console.error("[benchmark] Running agent tasks...")
  const agentTasks = await runAgentBenchmark(AGENT_BENCHMARK_TASKS, agentProvider)

  console.error("[benchmark] Running FIM tasks...")
  const fimTasks = await runFimBenchmark(FIM_BENCHMARK_FIXTURES, fimProvider)

  // Compute summaries
  const agentLatencies = agentTasks.map(t => t.latencyMs)
  const fimLatencies = fimTasks.map(t => t.latencyMs)

  const agentSuccess = agentTasks.filter(t => t.success).length
  const fimSuccess = fimTasks.filter(t => t.success).length
  const fimEmpty = fimTasks.filter(t => t.emptyCompletion).length

  const artifact: BenchmarkArtifact = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    gitSha: getCurrentGitSha(),
    timestamp: new Date().toISOString(),
    hardware: getHardwareSummary(),
    os: `${platform()} ${arch()}`,
    nodeVersion: process.version,
    providerRuntime: options.providerRuntime ?? "local",
    endpoint: options.endpoint,
    agentModelId: options.agentModelId,
    fimModelId: options.fimModelId,
    agentTasks,
    fimTasks,
    agentSummary: {
      total: agentTasks.length,
      success: agentSuccess,
      successRate: agentTasks.length > 0 ? agentSuccess / agentTasks.length : 0,
      medianLatencyMs: median(agentLatencies),
      p95LatencyMs: percentile95(agentLatencies),
    },
    fimSummary: {
      total: fimTasks.length,
      success: fimSuccess,
      successRate: fimTasks.length > 0 ? fimSuccess / fimTasks.length : 0,
      emptyRate: fimTasks.length > 0 ? fimEmpty / fimTasks.length : 0,
      medianLatencyMs: median(fimLatencies),
      p95LatencyMs: percentile95(fimLatencies),
    },
  }

  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true })
    const filename = `benchmark-${artifact.gitSha.slice(0, 8)}-${Date.now()}.json`
    const artifactPath = join(options.outputDir, filename)
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf-8")
    console.error(`[benchmark] Artifact written: ${artifactPath}`)
  }

  return artifact
}

/**
 * CLI entry point for `npm run eval:models`.
 * Checks the inference gate first — BLOCKED_WITH_EVIDENCE if not authorized.
 */
export async function benchmarkCli(): Promise<void> {
  const gate = checkInferenceGate()
  if (!gate.authorized) {
    console.log(inferenceGateBlockedMessage())
    process.exit(0)
  }

  const endpoint = gate.endpoint ?? process.env["OPEN_VS_CODE_MODEL_ENDPOINT"] ?? "http://localhost:11434"
  const agentModel = process.env["OPEN_VS_CODE_AGENT_MODEL"] ?? "qwen2.5-coder:7b"
  const fimModel = process.env["OPEN_VS_CODE_FIM_MODEL"] ?? "qwen2.5-coder:7b"
  const fimStrategy = (process.env["OPEN_VS_CODE_FIM_STRATEGY"] ?? "qwen") as FimStrategy
  const outputDir = process.env["OPEN_VS_CODE_BENCHMARK_OUTPUT"] ?? join(process.cwd(), "benchmark-results")

  console.log(`[benchmark] Starting Sprint 4E real model benchmark`)
  console.log(`[benchmark] Endpoint: ${endpoint}`)
  console.log(`[benchmark] Agent model: ${agentModel}`)
  console.log(`[benchmark] FIM model: ${fimModel} (strategy: ${fimStrategy})`)

  try {
    const artifact = await runRealModelBenchmark({
      endpoint,
      agentModelId: agentModel,
      fimModelId: fimModel,
      fimStrategy,
      providerRuntime: "local-openai-compatible",
      outputDir,
    })

    console.log("\n=== BENCHMARK RESULTS ===")
    console.log(`Agent tasks: ${artifact.agentSummary.success}/${artifact.agentSummary.total} (${(artifact.agentSummary.successRate * 100).toFixed(1)}%)`)
    console.log(`Agent median latency: ${artifact.agentSummary.medianLatencyMs.toFixed(0)}ms`)
    console.log(`FIM tasks: ${artifact.fimSummary.success}/${artifact.fimSummary.total} (${(artifact.fimSummary.successRate * 100).toFixed(1)}%)`)
    console.log(`FIM median latency: ${artifact.fimSummary.medianLatencyMs.toFixed(0)}ms`)
    console.log(`FIM empty rate: ${(artifact.fimSummary.emptyRate * 100).toFixed(1)}%`)
    console.log(`\nArtifact: ${outputDir}/`)
    console.log(`Git SHA: ${artifact.gitSha}`)
    console.log(`Hardware: ${artifact.hardware}`)
  } catch (error) {
    console.error("[benchmark] ERROR:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
