export type ToolPermission = "ALLOW" | "CONFIRM" | "DENY"

export type ToolAction =
  | "read_repository"
  | "search_repository"
  | "read_markdown"
  | "write_file"
  | "delete_file"
  | "run_known_test"
  | "terminal_command"
  | "git_commit"
  | "git_push"
  | "deploy"
  | "repository_escape"
  | "system_configuration"
  | "destructive_disk"
  | "unknown"
  | "mcp_external_read"
  | "mcp_external_side_effect"
  | "mcp_external_unknown"
  | "mcp_sensitive_data_transmission"
  | "mcp_external_destructive"
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly action: ToolAction
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

export interface ToolResult {
  readonly callId: string
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly truncated?: boolean
}
