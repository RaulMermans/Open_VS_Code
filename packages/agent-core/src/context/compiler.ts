import type { CompiledContext, ContextBudget, ContextItem } from "../contracts/context.ts"
import { estimateTokens, fitContext } from "./budget.ts"
import type { LoadedSkill } from "./skills.ts"
import type { ToolObservation } from "../agent/observations.ts"

export interface ProjectInstruction {
  readonly id: string
  readonly path: string
  readonly content: string
}

export interface ContextCompilerInput {
  readonly task: string
  readonly projectInstructions: readonly ProjectInstruction[]
  readonly selectedSkill?: LoadedSkill
  readonly codeContext?: readonly ContextItem[]
  readonly observations?: readonly ToolObservation[]
  readonly maxObservations?: number
  readonly budget: ContextBudget
}

function recentObservations(observations: readonly ToolObservation[], limit: number): ToolObservation[] {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("maxObservations must be a non-negative integer")
  const selected: ToolObservation[] = []
  const seen = new Set<string>()
  for (let index = observations.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const observation = observations[index]!
    const key = `${observation.toolName}\0${observation.ok}\0${observation.content}`
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(observation)
  }
  return selected
}

export function compileContext(input: ContextCompilerInput): CompiledContext {
  if (!input.task.trim()) throw new TypeError("Context compiler task must not be empty")
  const required: ContextItem[] = input.projectInstructions.map((instruction) => ({
    id: instruction.id,
    source: { kind: "project-instruction", path: instruction.path },
    content: instruction.content,
    priority: 1_000,
    estimatedTokens: estimateTokens(instruction.content),
    required: true,
  }))
  required.push({
    id: "current-task",
    source: { kind: "task" },
    content: input.task,
    priority: 1_000,
    estimatedTokens: estimateTokens(input.task),
    required: true,
  })
  if (input.selectedSkill) {
    required.push({
      id: `skill:${input.selectedSkill.name}`,
      source: { kind: "skill", path: input.selectedSkill.path },
      content: input.selectedSkill.body,
      priority: 1_000,
      estimatedTokens: estimateTokens(input.selectedSkill.body),
      required: true,
      metadata: { name: input.selectedSkill.name, description: input.selectedSkill.description },
    })
  }
  const observations = recentObservations(input.observations ?? [], input.maxObservations ?? 6).map((observation, index): ContextItem => ({
    id: `observation:${observation.callId}`,
    source: { kind: "observation", ...(observation.provenance.paths[0] ? { path: observation.provenance.paths[0] } : {}) },
    content: observation.content,
    priority: 100 - index,
    estimatedTokens: estimateTokens(observation.content),
    required: false,
    metadata: {
      toolName: observation.toolName,
      callId: observation.callId,
      ok: observation.ok,
      truncated: observation.truncated,
      paths: observation.provenance.paths,
      ...(observation.errorCategory ? { errorCategory: observation.errorCategory } : {}),
    },
  }))
  return fitContext([...required, ...(input.codeContext ?? []), ...observations], input.budget)
}
