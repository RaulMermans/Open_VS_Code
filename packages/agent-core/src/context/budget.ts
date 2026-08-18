import type { CompiledContext, ContextBudget, ContextItem, ContextSourceKind } from "../contracts/context.ts"

export class ContextBudgetError extends Error {
  readonly code: "INVALID_BUDGET" | "INVALID_ITEM" | "REQUIRED_CONTEXT_OVERFLOW"

  constructor(code: ContextBudgetError["code"], message: string) {
    super(message)
    this.name = "ContextBudgetError"
    this.code = code
  }
}

export const DEFAULT_CONTEXT_SOURCE_ORDER: readonly ContextSourceKind[] = [
  "project-instruction",
  "task",
  "active-code",
  "retrieved-code",
  "observation",
  "background",
  "skill",
]

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

export function calculateBudget(input: Omit<ContextBudget, "availableContext">): ContextBudget {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < 0) throw new ContextBudgetError("INVALID_BUDGET", `${name} must be a non-negative integer`)
  }
  if (input.contextWindow <= 0) throw new ContextBudgetError("INVALID_BUDGET", "contextWindow must be positive")
  const availableContext = input.contextWindow - input.reservedOutput - input.reservedToolHistory
  if (availableContext < 0) throw new ContextBudgetError("INVALID_BUDGET", "Reserved tokens exceed the context window")
  return { ...input, availableContext }
}

export function rankContext(
  items: readonly ContextItem[],
  sourceOrder: readonly ContextSourceKind[] = DEFAULT_CONTEXT_SOURCE_ORDER,
): ContextItem[] {
  const ranks = new Map(sourceOrder.map((kind, index) => [kind, index]))
  return items
    .map((item, index) => ({ item, index }))
    .toSorted((left, right) => {
      const leftRank = ranks.get(left.item.source.kind) ?? Number.MAX_SAFE_INTEGER
      const rightRank = ranks.get(right.item.source.kind) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || right.item.priority - left.item.priority || left.index - right.index
    })
    .map(({ item }) => item)
}

function contextKey(item: ContextItem): string {
  return `${item.source.kind}\0${item.source.path ?? ""}\0${item.content.trim()}`
}

export function fitContext(
  items: readonly ContextItem[],
  budget: ContextBudget,
  sourceOrder: readonly ContextSourceKind[] = DEFAULT_CONTEXT_SOURCE_ORDER,
): CompiledContext {
  const unique: ContextItem[] = []
  const omittedItemIds: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!Number.isInteger(item.estimatedTokens) || item.estimatedTokens < 0) {
      throw new ContextBudgetError("INVALID_ITEM", `Context item ${item.id} has an invalid token estimate`)
    }
    const key = contextKey(item)
    if (seen.has(key)) {
      omittedItemIds.push(item.id)
      continue
    }
    seen.add(key)
    unique.push(item)
  }

  const ranked = rankContext(unique, sourceOrder)
  const required = ranked.filter((item) => item.required)
  const optional = ranked.filter((item) => !item.required)
  const requiredTokens = required.reduce((total, item) => total + item.estimatedTokens, 0)
  if (requiredTokens > budget.availableContext) {
    throw new ContextBudgetError("REQUIRED_CONTEXT_OVERFLOW", `Required context needs ${requiredTokens} tokens; ${budget.availableContext} are available`)
  }

  const selected = [...required]
  let totalEstimatedTokens = requiredTokens
  for (const item of optional) {
    if (totalEstimatedTokens + item.estimatedTokens <= budget.availableContext) {
      selected.push(item)
      totalEstimatedTokens += item.estimatedTokens
    } else {
      omittedItemIds.push(item.id)
    }
  }
  return { items: selected, totalEstimatedTokens, budget, omittedItemIds }
}
