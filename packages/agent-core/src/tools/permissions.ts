import type { AgentMode } from "../contracts/agent.ts"
import type { ToolAction, ToolPermission } from "../contracts/tools.ts"

export type ActionCategory = ToolAction

const HARD_DENIES = new Set<ActionCategory>(["repository_escape", "system_configuration", "destructive_disk", "unknown"])

const BASELINE: Readonly<Record<ActionCategory, ToolPermission>> = {
  read_repository: "ALLOW",
  search_repository: "ALLOW",
  read_markdown: "ALLOW",
  write_file: "CONFIRM",
  delete_file: "CONFIRM",
  run_known_test: "CONFIRM",
  terminal_command: "CONFIRM",
  git_commit: "CONFIRM",
  git_push: "CONFIRM",
  deploy: "CONFIRM",
  repository_escape: "DENY",
  system_configuration: "DENY",
  destructive_disk: "DENY",
  unknown: "DENY",
  mcp_external_read: "ALLOW",
  mcp_external_side_effect: "CONFIRM",
  mcp_external_unknown: "CONFIRM",
  mcp_sensitive_data_transmission: "CONFIRM",
  mcp_external_destructive: "CONFIRM",
  browser_inspection: "ALLOW",
  browser_interaction: "CONFIRM",
  browser_sensitive: "CONFIRM",
  browser_destructive: "CONFIRM",
}

const PLAN_DENIES: readonly ActionCategory[] = [
  "write_file",
  "delete_file",
  "terminal_command",
  "git_commit",
  "git_push",
  "deploy",
  "mcp_external_side_effect",
  "mcp_external_unknown",
  "mcp_sensitive_data_transmission",
  "mcp_external_destructive",
  "browser_interaction",
  "browser_sensitive",
  "browser_destructive",
]

const READ_ONLY_MODES: readonly AgentMode[] = ["PLAN", "ASK", "REVIEW"]

export type ModePermissionOverrides = Partial<Record<AgentMode, Partial<Record<ActionCategory, ToolPermission>>>>

export function classifyPermission(input: {
  readonly action: ActionCategory
  readonly mode: AgentMode
  readonly modeOverrides?: ModePermissionOverrides
}): ToolPermission {
  if (HARD_DENIES.has(input.action)) return "DENY"
  const override = input.modeOverrides?.[input.mode]?.[input.action]
  if (override) return override
  if (READ_ONLY_MODES.includes(input.mode) && PLAN_DENIES.includes(input.action)) return "DENY"
  if (input.action === "run_known_test" && (input.mode === "ASK" || input.mode === "PLAN")) return "DENY"
  return BASELINE[input.action]
}
