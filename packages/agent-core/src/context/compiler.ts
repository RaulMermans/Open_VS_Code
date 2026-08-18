import type { CompiledContext, ContextBudget, ContextItem } from "../contracts/context.ts"
import { estimateTokens, fitContext } from "./budget.ts"
import type { LoadedSkill } from "./skills.ts"

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
  readonly budget: ContextBudget
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
  return fitContext([...required, ...(input.codeContext ?? [])], input.budget)
}
