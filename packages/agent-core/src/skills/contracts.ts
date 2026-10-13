import { AGENT_MODES, type AgentMode } from "../contracts/agent.ts"
import type { ToolAction } from "../contracts/tools.ts"

/**
 * Portable Skills Runtime contracts (Sprint 5A, ADR-029).
 *
 * A skill is Markdown guidance plus strictly validated metadata. It is data, never authority:
 * nothing in this module can register tools, change permissions, or alter model routing.
 */

export const SKILL_MODES: readonly AgentMode[] = AGENT_MODES

export const SKILL_CATEGORIES = ["debugging", "testing", "refactoring", "security", "verification", "architecture", "documentation"] as const
export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

export const SKILL_CAPABILITIES = ["read", "search", "write", "verify", "terminal"] as const
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number]

/** Each declared capability is checked against the existing PermissionGate through these actions. */
export const CAPABILITY_ACTIONS: Readonly<Record<SkillCapability, ToolAction>> = {
  read: "read_repository",
  search: "search_repository",
  write: "write_file",
  verify: "run_known_test",
  terminal: "terminal_command",
}

export const SKILL_RISK_LEVELS = ["low", "medium", "high"] as const
export type SkillRiskLevel = (typeof SKILL_RISK_LEVELS)[number]

/** Tools a skill may require. MCP tools are dynamic and therefore never a valid requirement. */
export const KNOWN_SKILL_TOOLS = ["read_file", "list_directory", "find_files", "search_text", "apply_patch", "create_file", "run_verification"] as const

export const REQUIRED_SKILL_SECTIONS = ["Intent", "When to Use", "Inputs", "Workflow", "Verification", "Failure Modes", "Exit Criteria"] as const

/** Sections dropped last-to-first when a body must shrink; the first four form the minimum viable core. */
export const SKILL_SECTION_PRIORITY = ["Intent", "Workflow", "Verification", "Exit Criteria", "When to Use", "Failure Modes", "Inputs"] as const
export const SKILL_CORE_SECTION_COUNT = 4

export const SKILL_LIMITS = {
  maxFileBytes: 16 * 1024,
  maxFrontmatterBytes: 4 * 1024,
  maxDescriptionChars: 200,
  maxNameChars: 60,
  maxTriggers: 16,
  maxTriggerChars: 40,
  minContextBudget: 200,
  maxContextBudget: 4000,
  maxWorkspaceSkills: 32,
  maxSkillsPerTask: 2,
} as const

export type SkillSourceKind = "builtin" | "workspace"

export interface SkillIndexEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: number
  readonly category: SkillCategory
  readonly allowedModes: readonly AgentMode[]
  readonly capabilities: readonly SkillCapability[]
  readonly requiredTools: readonly string[]
  readonly contextBudget: number
  readonly riskLevel: SkillRiskLevel
  readonly triggers: readonly string[]
  readonly composesWith: readonly string[]
  readonly source: SkillSourceKind
  /** Path relative to the source root, e.g. `bug-triage/SKILL.md`. Never absolute. */
  readonly relativePath: string
  readonly fileBytes: number
}

export type SkillDiagnosticCode =
  | "MALFORMED_FRONTMATTER"
  | "UNKNOWN_FIELD"
  | "DUPLICATE_FIELD"
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "ID_DIRECTORY_MISMATCH"
  | "EMPTY_BODY"
  | "MISSING_SECTION"
  | "DUPLICATE_SECTION"
  | "TOO_LARGE"
  | "SECRET_DETECTED"
  | "EXECUTABLE_CONTENT"
  | "UNSAFE_DIRECTIVE"
  | "UNSAFE_PATH"
  | "OVERRIDE_INVALID"
  | "OVERRIDE_EXPANDS_PERMISSIONS"
  | "WORKSPACE_UNTRUSTED"
  | "WORKSPACE_LIMIT"
  | "CHANGED_SINCE_INDEX"
  | "READ_FAILED"

export interface SkillDiagnostic {
  readonly code: SkillDiagnosticCode
  readonly source: SkillSourceKind
  /** Skill directory name or id; never file contents. */
  readonly skill: string
  readonly message: string
}

export type SkillRejectionReason = "MODE_INCOMPATIBLE" | "MISSING_REQUIRED_TOOL" | "CAPABILITY_DENIED" | "BELOW_THRESHOLD" | "AMBIGUOUS" | "OUTRANKED"

export type SkillSelectionReason = "explicit_request" | "trigger_match" | "description_overlap" | "composition"

export interface SkillCandidate {
  readonly id: string
  readonly score: number
  readonly eligible: boolean
  readonly reason: SkillSelectionReason | SkillRejectionReason
}

export interface SkillSelection {
  readonly selected: readonly SkillIndexEntry[]
  readonly reasons: readonly SkillSelectionReason[]
  readonly candidates: readonly SkillCandidate[]
}

export type SkillLoadStatus =
  | "DISABLED"
  | "NO_SKILL_SELECTED"
  | "LOADED"
  | "LOADED_PARTIAL"
  | "FAILED_BUDGET"
  | "FAILED_INVALID"

/** A skill body prepared for injection into the current stage context. */
export interface SkillGuidance {
  readonly id: string
  readonly version: number
  readonly source: SkillSourceKind
  readonly sections: readonly string[]
  readonly content: string
  readonly estimatedTokens: number
}

/**
 * Bounded, privacy-safe evidence. Contains ids, versions, reason codes and counts only:
 * never task text, prompts, source code, or skill bodies.
 */
export interface SkillEvidence {
  readonly enabled: boolean
  readonly skillsIndexed: number
  readonly indexTokens: number
  readonly candidateSkills: readonly string[]
  readonly selectedSkill?: string
  readonly selectedSkills: readonly string[]
  readonly selectionReason?: SkillSelectionReason
  readonly skillLoadStatus: SkillLoadStatus
  readonly skillContextTokens: number
  readonly skillVersion?: number
  readonly skillSource?: SkillSourceKind
  readonly loadedSections: readonly string[]
  readonly rejected: readonly { readonly id: string; readonly reason: SkillRejectionReason }[]
  readonly diagnostics: readonly { readonly code: SkillDiagnosticCode; readonly skill: string; readonly source: SkillSourceKind }[]
}

export const MAX_EVIDENCE_CANDIDATES = 8
export const MAX_EVIDENCE_REJECTIONS = 16
export const MAX_EVIDENCE_DIAGNOSTICS = 16

export function isSkillMode(value: string): value is AgentMode {
  return (SKILL_MODES as readonly string[]).includes(value)
}
