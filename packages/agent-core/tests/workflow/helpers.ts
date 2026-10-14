import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { ModelCapability, ModelProvider, ModelRequest, ModelResponse } from "../../src/contracts/model.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { MutationEngine } from "../../src/tools/mutation-engine.ts"
import { createMutationToolRegistrations } from "../../src/tools/mutation-registry.ts"
import { classifyPermission } from "../../src/tools/permissions.ts"
import { createReadOnlyToolRegistry } from "../../src/tools/read-only-registry.ts"
import type { VerificationAction, VerificationStatus } from "../../src/tools/verification-contracts.ts"
import { EngineeringWorkflow, type EngineeringWorkflowDependencies, type EngineeringWorkflowInput } from "../../src/workflow/engine.ts"
import type { WorkflowResult } from "../../src/workflow/contracts.ts"
import type { WorkflowVerifier } from "../../src/workflow/services.ts"

export type SimStage = "PLAN" | "IMPLEMENT" | "REVIEW" | "DIRECT"

export interface SimContext {
  readonly turn: number
  readonly prompt: string
  readonly repair: boolean
  /** 1-based count of this stage's sessions so far (a new session starts at turn 1). */
  readonly session: number
}

export type SimHandler = (context: SimContext) => ModelResponse

export function reply(content: string, toolCalls?: ModelResponse["toolCalls"], metadata?: ModelResponse["metadata"]): ModelResponse {
  return { model: "sim-local", message: { role: "assistant", content }, ...(toolCalls ? { toolCalls } : {}), ...(metadata ? { metadata } : {}), usage: { inputTokens: 1, outputTokens: 1 } }
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): ModelResponse {
  return reply("", [{ id, name, arguments: args }])
}

export const DEFAULT_PLAN = {
  goal: "Add a subtract function to src/math.ts",
  files: ["src/math.ts"],
  steps: ["Add subtract(a, b) next to add", "Export it"],
  tests: ["subtract(5, 3) === 2"],
  risks: ["None significant"],
  acceptanceCriteria: ["subtract(a, b) returns a - b", "add is unchanged"],
}

export function planReply(plan: object = DEFAULT_PLAN): ModelResponse {
  return reply(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)
}

export function reviewReply(review: object): ModelResponse {
  return reply(`\`\`\`json\n${JSON.stringify(review)}\n\`\`\``)
}

export const NO_FINDINGS = { verdict: "NO_FINDINGS", findings: [] }

/** Implementer that applies one patch on its first turn and then summarises. */
export function patchingImplementer(patches: readonly { search: string; replace: string; path?: string }[], summary = "Implemented the change."): SimHandler {
  return ({ turn, repair, session }) => {
    const patch = patches[Math.min(session - 1, patches.length - 1)]!
    if (turn === 1) return toolCall(`call-${session}-${repair ? "r" : "i"}`, "apply_patch", { path: patch.path ?? "src/math.ts", search: patch.search, replace: patch.replace })
    return reply(summary)
  }
}

const STAGE_HEADER = /\[Engineering workflow · (PLAN|IMPLEMENT|IMPLEMENT \(repair\)|IMPLEMENT \(recovery\)|REVIEW) stage\]/

/**
 * Deterministic, local, stage-aware model. It answers by the stage header in the prompt and the
 * runner turn, and records every prompt per stage so tests can inspect exactly what each stage saw.
 */
export class StageAwareModel implements ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability> = new Set(["chat", "tools"])
  readonly requests: ModelRequest[] = []
  readonly prompts: Record<SimStage, string[]> = { PLAN: [], IMPLEMENT: [], REVIEW: [], DIRECT: [] }
  readonly sessions: Record<SimStage, number> = { PLAN: 0, IMPLEMENT: 0, REVIEW: 0, DIRECT: 0 }
  readonly #handlers: Partial<Record<SimStage, SimHandler>>

  constructor(handlers: Partial<Record<SimStage, SimHandler>>) {
    this.#handlers = handlers
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const prompt = request.messages.map((message) => message.content).join("\n")
    const header = prompt.match(STAGE_HEADER)?.[1]
    const stage: SimStage = header === undefined ? "DIRECT" : header.startsWith("IMPLEMENT") ? "IMPLEMENT" : (header as SimStage)
    const turn = Number((request.metadata as { turn?: number } | undefined)?.turn ?? 1)
    if (turn === 1) this.sessions[stage] += 1
    this.prompts[stage].push(prompt)
    const handler = this.#handlers[stage]
    if (!handler) throw new Error(`No simulated handler for ${stage}`)
    return handler({ turn, prompt, repair: header === "IMPLEMENT (repair)", session: this.sessions[stage] })
  }

  get modelCalls(): number {
    return this.requests.length
  }

  get promptTokens(): number {
    return this.requests.reduce((total, request) => total + Math.ceil(request.messages.map((message) => message.content).join("\n").length / 4), 0)
  }
}

export const MATH_SOURCE = "export function add(a: number, b: number): number {\n  return a + b\n}\n// subtract: TODO\n"
export const SUBTRACT_OK = "export function subtract(a: number, b: number): number {\n  return a - b\n}\n"
export const SUBTRACT_BUG = "export function subtract(a: number, b: number): number {\n  return b - a\n}\n"

export async function workspace(files: Readonly<Record<string, string>> = { "src/math.ts": MATH_SOURCE }): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ovsc-workflow-")))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

/** Fake verifier: statuses per action are produced by `decide`, which may inspect the workspace. */
export class FakeVerifier implements WorkflowVerifier {
  readonly runs: VerificationAction[] = []
  readonly #available: ReadonlySet<VerificationAction>
  readonly #decide: (action: VerificationAction, run: number) => VerificationStatus | Promise<VerificationStatus>

  constructor(available: readonly VerificationAction[], decide: (action: VerificationAction, run: number) => VerificationStatus | Promise<VerificationStatus> = () => "PASS") {
    this.#available = new Set(available)
    this.#decide = decide
  }

  async discover(action: VerificationAction): Promise<string | undefined> {
    return this.#available.has(action) ? `npm run ${action.toLowerCase()}` : undefined
  }

  async run(action: VerificationAction) {
    this.runs.push(action)
    const status = await this.#decide(action, this.runs.filter((item) => item === action).length)
    return {
      command: `npm run ${action.toLowerCase()}`,
      result: { status, exitCode: status === "PASS" ? 0 : 1, stdout: status === "PASS" ? `ok ${action} 12ms` : `FAIL ${action}: expected 2 got -2 (31ms)`, stderr: "", durationMs: 5 },
    }
  }
}

export function harness(options: {
  readonly root: string
  readonly model: ModelProvider
  readonly verifier?: WorkflowVerifier
  readonly overrides?: Partial<EngineeringWorkflowDependencies>
}): EngineeringWorkflowDependencies {
  const registry = createReadOnlyToolRegistry()
  for (const registration of createMutationToolRegistrations({ engine: new MutationEngine(options.root) })) registry.register(registration)
  let tick = 0
  return {
    provider: options.model,
    registry,
    permissionEvaluator: classifyPermission,
    verifier: options.verifier ?? new FakeVerifier(["TEST", "TYPECHECK"]),
    workspaceRoot: options.root,
    contextBudget: calculateBudget({ contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500 }),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    idFactory: () => "wf-test",
    ...options.overrides,
  }
}

export const TASK = "Add a subtract function to src/math.ts"

export function startWorkflow(deps: EngineeringWorkflowDependencies, input: Partial<EngineeringWorkflowInput> = {}): EngineeringWorkflow {
  return EngineeringWorkflow.start(deps, { task: TASK, mode: "BUILD", ...input })
}

/** Drives a workflow to a terminal state, answering every confirmation with `decide`. */
export async function drive(workflow: EngineeringWorkflow, decide: (result: WorkflowResult) => "APPROVE" | "REJECT" = () => "APPROVE", limit = 40): Promise<{ result: WorkflowResult; confirmations: WorkflowResult[] }> {
  const confirmations: WorkflowResult[] = []
  let result = await workflow.run()
  while (result.status === "WAITING_FOR_CONFIRMATION") {
    if (confirmations.length >= limit) throw new Error("confirmation limit reached")
    confirmations.push(result)
    result = await workflow.resume(decide(result))
  }
  return { result, confirmations }
}

/** Standard happy-path model: plan, one correct patch, clean review. */
export function happyModel(overrides: Partial<Record<SimStage, SimHandler>> = {}): StageAwareModel {
  return new StageAwareModel({
    PLAN: () => planReply(),
    IMPLEMENT: patchingImplementer([{ search: "// subtract: TODO\n", replace: SUBTRACT_OK }]),
    REVIEW: () => reviewReply(NO_FINDINGS),
    ...overrides,
  })
}
