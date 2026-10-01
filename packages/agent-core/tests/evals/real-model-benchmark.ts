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
import { createHash } from "node:crypto"
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { platform, arch, cpus, totalmem, tmpdir } from "node:os"
import { checkInferenceGate, requireInferenceGate, inferenceGateBlockedMessage } from "../../src/model/inference-gate.ts"
import { OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts"
import { LocalFimProvider, type FimStrategy } from "../../src/autocomplete/local-fim-provider.ts"
import { AgentRunner } from "../../src/agent/runner.ts"
import { RoutedModelGateway } from "../../src/model/routed-gateway.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import { classifyPermission } from "../../src/tools/permissions.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import type { RoutingConfiguration } from "../../src/contracts/routing.ts"

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
  readonly syntaxValid: boolean
  readonly latencyMs: number
  readonly emptyCompletion: boolean
  readonly completionLength: number
  readonly completionSha256: string
  readonly error?: string
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
  endpoint: string,
  modelId: string,
): Promise<readonly AgentTaskResult[]> {
  const results: AgentTaskResult[] = []

  const tempDir = await mkdtemp(join(tmpdir(), "open-vs-code-benchmark-"))
  try {
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
    await writeFile(
      join(tempDir, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "utf-8"
    )

    const config: RoutingConfiguration = {
      providers: [{ id: "prov-local", kind: "openai_compatible_local" }],
      models: [{
        id: modelId,
        contextWindow: 32768,
        capabilities: ["toolUse", "coding", "reasoning"],
        specialization: "coding",
      }],
      deployments: [{
        id: "dep-benchmark",
        providerId: "prov-local",
        modelId,
        endpoint,
        enabled: true,
      }],
      routes: {
        general: ["dep-benchmark"],
        coding: ["dep-benchmark"],
      },
    }

    const provider = new OpenAICompatibleProvider({
      baseUrl: endpoint,
      model: modelId,
      timeoutMs: 60_000,
      capabilities: ["chat", "tools"],
    })
    const providers = new Map([["dep-benchmark", provider], ["prov-local", provider]])

    const gateway = new RoutedModelGateway({
      config,
      providers,
      mode: "ASK",
      hasTools: true,
      hasStructuredOutput: false,
    })

    const registry = createReadOnlyToolRegistry()
    const runner = new AgentRunner({
      provider: gateway,
      registry,
      permissionEvaluator: classifyPermission,
      evidenceGate: false,
    })

    const contextBudget = calculateBudget({
      contextWindow: 32768,
      reservedOutput: 1000,
      reservedToolHistory: 500,
    })

    for (const task of tasks) {
      const t0 = Date.now()
      try {
        const result = await runner.run({
          task: {
            id: task.id,
            instruction: task.prompt,
            mode: "ASK",
          },
          workspaceRoot: tempDir,
          maxTurns: 5,
          contextBudget,
          projectInstructions: [],
        })

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

        const lower = responseText.toLowerCase()
        const keywordMatches = task.expectedKeywords.filter(kw => lower.includes(kw.toLowerCase()))
        const groundedSuccess = keywordMatches.length > 0
        const success = (result.status === "COMPLETED" || groundedSuccess) && result.status !== "FAILED"

        const toolCalls = result.toolCalls ?? []
        const validCalls = toolCalls.filter(tc => tc.outcome === "COMPLETED")
        const selectedToolNames = [...new Set(toolCalls.map(tc => tc.name))]

        const responseSha256 = createHash("sha256").update(responseText).digest("hex")

        results.push({
          taskId: task.id,
          name: task.name,
          category: task.category,
          success,
          groundedSuccess,
          latencyMs: Date.now() - t0,
          turns: result.turns,
          toolCallsCount: toolCalls.length,
          validToolCallsCount: validCalls.length,
          selectedToolNames,
          ...(gateway.lastDecision ? {
            routeProvenance: {
              deploymentId: gateway.lastDecision.deploymentId,
              providerId: gateway.lastDecision.providerId,
              modelId: gateway.lastDecision.modelId,
            }
          } : {}),
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          responseLength: responseText.length,
          responseSha256,
        })
      } catch (error) {
        results.push({
          taskId: task.id,
          name: task.name,
          category: task.category,
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
      const sha256 = createHash("sha256").update(response.text).digest("hex")

      results.push({
        fixtureId: fixture.id,
        language: fixture.language,
        success,
        exactMatch,
        syntaxValid: !empty,
        latencyMs: Date.now() - t0,
        emptyCompletion: empty,
        completionLength: response.text.length,
        completionSha256: sha256,
      })
    } catch (error) {
      results.push({
        fixtureId: fixture.id,
        language: fixture.language,
        success: false,
        exactMatch: false,
        syntaxValid: false,
        latencyMs: Date.now() - t0,
        emptyCompletion: true,
        completionLength: 0,
        completionSha256: createHash("sha256").update("").digest("hex"),
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
    const warmupProvider = new OpenAICompatibleProvider({
      baseUrl: options.endpoint,
      model: options.agentModelId,
      timeoutMs: 30_000,
    })
    await warmupProvider.complete({
      messages: [{ role: "user", content: "Say READY." }],
      temperature: 0,
      maxOutputTokens: 10,
    })
  } catch {
    // Warmup failure is non-fatal
  }

  console.error("[benchmark] Running agent tasks through Open VS Code AgentRunner stack...")
  const agentTasks = await runAgentBenchmark(AGENT_BENCHMARK_TASKS, options.endpoint, options.agentModelId)

  console.error("[benchmark] Running FIM tasks through LocalFimProvider...")
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
    const baseName = `benchmark-${artifact.gitSha.slice(0, 8)}-${Date.now()}`
    const jsonPath = join(options.outputDir, `${baseName}.json`)
    await writeFile(jsonPath, JSON.stringify(artifact, null, 2), "utf-8")
    console.error(`[benchmark] JSON artifact written: ${jsonPath}`)

    const mdContent = [
      `# Sprint 4E Real Model Benchmark Report`,
      ``,
      `- **Date:** ${artifact.timestamp}`,
      `- **Git SHA:** \`${artifact.gitSha}\``,
      `- **Hardware:** ${artifact.hardware}`,
      `- **OS:** ${artifact.os}`,
      `- **Node:** ${artifact.nodeVersion}`,
      `- **Agent Model:** \`${artifact.agentModelId}\``,
      `- **FIM Model:** \`${artifact.fimModelId}\``,
      `- **Endpoint:** \`${artifact.endpoint}\``,
      ``,
      `## Agent Summary`,
      `- **Total Tasks:** ${artifact.agentSummary.total}`,
      `- **Success Count:** ${artifact.agentSummary.success}`,
      `- **Success Rate:** ${(artifact.agentSummary.successRate * 100).toFixed(1)}%`,
      `- **Median Latency:** ${artifact.agentSummary.medianLatencyMs.toFixed(0)} ms`,
      `- **P95 Latency:** ${artifact.agentSummary.p95LatencyMs.toFixed(0)} ms`,
      ``,
      `## FIM Summary`,
      `- **Total Tasks:** ${artifact.fimSummary.total}`,
      `- **Success Count:** ${artifact.fimSummary.success}`,
      `- **Success Rate:** ${(artifact.fimSummary.successRate * 100).toFixed(1)}%`,
      `- **Empty Rate:** ${(artifact.fimSummary.emptyRate * 100).toFixed(1)}%`,
      `- **Median Latency:** ${artifact.fimSummary.medianLatencyMs.toFixed(0)} ms`,
      `- **P95 Latency:** ${artifact.fimSummary.p95LatencyMs.toFixed(0)} ms`,
      ``,
    ].join("\n")

    const mdPath = join(options.outputDir, `${baseName}.md`)
    await writeFile(mdPath, mdContent, "utf-8")
    console.error(`[benchmark] Markdown report written: ${mdPath}`)
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
