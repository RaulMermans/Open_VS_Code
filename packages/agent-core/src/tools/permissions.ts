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
}

const PLAN_DENIES: readonly ActionCategory[] = [
  "write_file",
  "delete_file",
  "run_known_test",
  "terminal_command",
  "git_commit",
  "git_push",
  "deploy",
]

export type ModePermissionOverrides = Partial<Record<AgentMode, Partial<Record<ActionCategory, ToolPermission>>>>

export function classifyPermission(input: {
  readonly action: ActionCategory
  readonly mode: AgentMode
  readonly modeOverrides?: ModePermissionOverrides
}): ToolPermission {
  if (HARD_DENIES.has(input.action)) return "DENY"
  const override = input.modeOverrides?.[input.mode]?.[input.action]
  if (override) return override
  if (input.mode === "PLAN" && PLAN_DENIES.includes(input.action)) return "DENY"
  return BASELINE[input.action]
}
