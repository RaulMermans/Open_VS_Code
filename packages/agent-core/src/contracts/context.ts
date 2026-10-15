export type ContextSourceKind = "project-instruction" | "task" | "active-code" | "retrieved-code" | "observation" | "background" | "skill" | "historical-session" | "learned-memory"

export interface ContextSource {
  readonly kind: ContextSourceKind
  readonly path?: string
  readonly heading?: string
}

export type ContextPriority = number

export interface ContextItem {
  readonly id: string
  readonly source: ContextSource
  readonly content: string
  readonly priority: ContextPriority
  readonly estimatedTokens: number
  readonly required: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ContextBudget {
  readonly contextWindow: number
  readonly reservedOutput: number
  readonly reservedToolHistory: number
  readonly availableContext: number
}

export interface CompiledContext {
  readonly items: readonly ContextItem[]
  readonly totalEstimatedTokens: number
  readonly budget: ContextBudget
  readonly omittedItemIds: readonly string[]
}

export interface ConversationTurn {
  readonly role: "user" | "assistant"
  readonly content: string
}
