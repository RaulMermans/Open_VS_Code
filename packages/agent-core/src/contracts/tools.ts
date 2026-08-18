export type ToolPermission = "ALLOW" | "CONFIRM" | "DENY"

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly permission: ToolPermission
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface ToolResult {
  readonly callId: string
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly truncated?: boolean
}
