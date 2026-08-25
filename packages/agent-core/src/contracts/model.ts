import type { ToolCall, ToolDefinition } from "./tools.ts"

export type ModelCapability =
  | "chat"
  | "reasoning"
  | "tools"
  | "fim"
  | "embeddings"
  | "streaming"
  | "parallel_tool_calls"
  | "context_window"
  | "usage_reporting"

export type ModelRole = "system" | "user" | "assistant" | "tool"

export interface ModelMessage {
  readonly role: ModelRole
  readonly content: string
  readonly name?: string
  readonly toolCallId?: string
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[]
  readonly temperature?: number
  readonly maxOutputTokens?: number
  readonly signal?: AbortSignal
  readonly tools?: readonly ToolDefinition[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ModelResponse {
  readonly model: string
  readonly message: ModelMessage
  readonly finishReason?: string
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
  }
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly toolCalls?: readonly ToolCall[]
  readonly contextWindow?: number | undefined
}

export interface ModelProvider {
  readonly capabilities: ReadonlySet<ModelCapability>
  complete(request: ModelRequest): Promise<ModelResponse>
}
