import type { AgentMode } from "../contracts/agent.ts"
import { redactRuntimeEvalSecrets } from "../runtime-evals/evidence.ts"
import {
  KNOWN_SKILL_TOOLS,
  REQUIRED_SKILL_SECTIONS,
  SKILL_CAPABILITIES,
  SKILL_CATEGORIES,
  SKILL_LIMITS,
  SKILL_RISK_LEVELS,
  isSkillMode,
  type SkillCapability,
  type SkillCategory,
  type SkillDiagnosticCode,
  type SkillRiskLevel,
} from "./contracts.ts"

/**
 * Strict `SKILL.md` metadata schema (Sprint 5A, ADR-029).
 *
 * Frontmatter is a deliberately tiny YAML subset: `key: scalar`, `key: []`, and `key:` followed by
 * `  - item` list lines. Anchors, tags, flow collections, block scalars and unknown keys are rejected,
 * so frontmatter can never smuggle executable or structured payloads. The JSON Schema mirror lives at
 * `config/schemas/skill.schema.json` and is kept in sync by tests.
 */

export class SkillValidationError extends Error {
  readonly code: SkillDiagnosticCode

  constructor(code: SkillDiagnosticCode, message: string) {
    super(message)
    this.name = "SkillValidationError"
    this.code = code
  }
}

export const SKILL_FIELDS = {
  id: { required: true, kind: "string" },
  name: { required: true, kind: "string" },
  description: { required: true, kind: "string" },
  version: { required: true, kind: "string" },
  category: { required: true, kind: "string" },
  allowed_modes: { required: true, kind: "list" },
  capabilities: { required: true, kind: "list" },
  required_tools: { required: true, kind: "list" },
  context_budget: { required: true, kind: "string" },
  risk_level: { required: true, kind: "string" },
  triggers: { required: false, kind: "list" },
  composes_with: { required: false, kind: "list" },
} as const

export type SkillField = keyof typeof SKILL_FIELDS

export interface ValidatedSkillMetadata {
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
}

export const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_ID_LENGTH = 48
const FORBIDDEN_SCALAR_START = /^[{[&*!|>%@`]/
const EXECUTABLE_FRONTMATTER = /`|\$\(|\$\{|<script|javascript:/i

/** Splits a document into raw frontmatter text and body. Throws on a missing or unterminated block. */
export function splitSkillDocument(content: string): { frontmatter: string; body: string } {
  const normalized = content.replaceAll("\r\n", "\n")
  if (!normalized.startsWith("---\n")) throw new SkillValidationError("MALFORMED_FRONTMATTER", "SKILL.md must start with a '---' frontmatter block")
  const end = normalized.indexOf("\n---\n", 3)
  const endAtEof = end < 0 && normalized.endsWith("\n---") ? normalized.length - 4 : -1
  const close = end >= 0 ? end : endAtEof
  if (close < 0) throw new SkillValidationError("MALFORMED_FRONTMATTER", "SKILL.md frontmatter is not terminated by '---'")
  return { frontmatter: normalized.slice(4, close), body: end >= 0 ? normalized.slice(end + 5) : "" }
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  if (value.startsWith('"') || value.startsWith("'")) throw new SkillValidationError("MALFORMED_FRONTMATTER", `Unterminated quoted value: ${value.slice(0, 40)}`)
  return value
}

function scalar(raw: string, key: string): string {
  const value = raw.trim()
  if (FORBIDDEN_SCALAR_START.test(value)) throw new SkillValidationError("MALFORMED_FRONTMATTER", `Field '${key}' uses unsupported YAML syntax`)
  const unquoted = unquote(value)
  if (EXECUTABLE_FRONTMATTER.test(unquoted)) throw new SkillValidationError("EXECUTABLE_CONTENT", `Field '${key}' contains executable-looking content`)
  return unquoted
}

/** Parses the strict frontmatter subset into raw string / string-list fields. */
export function parseSkillFrontmatter(frontmatter: string): Map<SkillField, string | string[]> {
  if (Buffer.byteLength(frontmatter, "utf8") > SKILL_LIMITS.maxFrontmatterBytes) {
    throw new SkillValidationError("TOO_LARGE", `Frontmatter exceeds ${SKILL_LIMITS.maxFrontmatterBytes} bytes`)
  }
  const fields = new Map<SkillField, string | string[]>()
  let listKey: SkillField | undefined
  for (const line of frontmatter.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const item = /^ {2}- (.*)$/.exec(line)
    if (item) {
      if (!listKey) throw new SkillValidationError("MALFORMED_FRONTMATTER", "List item without a list field")
      ;(fields.get(listKey) as string[]).push(scalar(item[1]!, listKey))
      continue
    }
    const match = /^([a-z][a-z0-9_]*):(?:\s+(.*))?$/.exec(line)
    if (!match) throw new SkillValidationError("MALFORMED_FRONTMATTER", `Unsupported frontmatter line: ${line.slice(0, 60)}`)
    const key = match[1]!
    if (!Object.hasOwn(SKILL_FIELDS, key)) throw new SkillValidationError("UNKNOWN_FIELD", `Unknown field '${key}'`)
    const field = key as SkillField
    if (fields.has(field)) throw new SkillValidationError("DUPLICATE_FIELD", `Field '${field}' is declared more than once`)
    const rawValue = (match[2] ?? "").trim()
    if (rawValue === "" || rawValue === "[]") {
      fields.set(field, [])
      listKey = rawValue === "" ? field : undefined
      continue
    }
    listKey = undefined
    fields.set(field, scalar(rawValue, field))
  }
  return fields
}

function requireString(fields: Map<SkillField, string | string[]>, key: SkillField): string {
  const value = fields.get(key)
  if (value === undefined) throw new SkillValidationError("MISSING_FIELD", `Required field '${key}' is missing`)
  if (typeof value !== "string" || !value.trim()) throw new SkillValidationError("INVALID_FIELD", `Field '${key}' must be a non-empty scalar`)
  return value.trim()
}

function requireList(fields: Map<SkillField, string | string[]>, key: SkillField, optional = false): string[] {
  const value = fields.get(key)
  if (value === undefined) {
    if (optional) return []
    throw new SkillValidationError("MISSING_FIELD", `Required field '${key}' is missing`)
  }
  if (!Array.isArray(value)) throw new SkillValidationError("INVALID_FIELD", `Field '${key}' must be a list`)
  if (new Set(value).size !== value.length) throw new SkillValidationError("INVALID_FIELD", `Field '${key}' contains duplicates`)
  return value
}

function enumList<T extends string>(values: readonly string[], allowed: readonly T[], key: string): T[] {
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new SkillValidationError("INVALID_FIELD", `Field '${key}' has unsupported value '${value.slice(0, 40)}' (allowed: ${allowed.join(", ")})`)
    }
  }
  return values as T[]
}

function positiveInteger(raw: string, key: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new SkillValidationError("INVALID_FIELD", `Field '${key}' must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SkillValidationError("INVALID_FIELD", `Field '${key}' must be between ${min} and ${max}`)
  }
  return value
}

/** Validates parsed frontmatter. `directoryName` must equal the declared id for deterministic discovery. */
export function validateSkillMetadata(fields: Map<SkillField, string | string[]>, directoryName: string): ValidatedSkillMetadata {
  for (const [key, spec] of Object.entries(SKILL_FIELDS) as [SkillField, (typeof SKILL_FIELDS)[SkillField]][]) {
    if (spec.required && !fields.has(key)) throw new SkillValidationError("MISSING_FIELD", `Required field '${key}' is missing`)
  }
  const id = requireString(fields, "id")
  if (id.length > MAX_ID_LENGTH || !SKILL_ID_PATTERN.test(id)) throw new SkillValidationError("INVALID_FIELD", "Field 'id' must be lowercase kebab-case (max 48 chars)")
  if (id !== directoryName) throw new SkillValidationError("ID_DIRECTORY_MISMATCH", `Skill id '${id}' must match its directory name '${directoryName}'`)

  const name = requireString(fields, "name")
  if (name.length > SKILL_LIMITS.maxNameChars) throw new SkillValidationError("INVALID_FIELD", `Field 'name' exceeds ${SKILL_LIMITS.maxNameChars} characters`)
  const description = requireString(fields, "description")
  if (description.length > SKILL_LIMITS.maxDescriptionChars) {
    throw new SkillValidationError("INVALID_FIELD", `Field 'description' exceeds ${SKILL_LIMITS.maxDescriptionChars} characters`)
  }
  const version = positiveInteger(requireString(fields, "version"), "version", 1, 10_000)
  const category = enumList([requireString(fields, "category")], SKILL_CATEGORIES, "category")[0]!

  const modes = requireList(fields, "allowed_modes")
  if (modes.length === 0) throw new SkillValidationError("INVALID_FIELD", "Field 'allowed_modes' must not be empty")
  for (const mode of modes) {
    if (!isSkillMode(mode)) throw new SkillValidationError("INVALID_FIELD", `Field 'allowed_modes' has unsupported mode '${mode.slice(0, 20)}'`)
  }

  const capabilities = enumList(requireList(fields, "capabilities"), SKILL_CAPABILITIES, "capabilities")
  const requiredTools = enumList(requireList(fields, "required_tools"), KNOWN_SKILL_TOOLS, "required_tools")
  const contextBudget = positiveInteger(requireString(fields, "context_budget"), "context_budget", SKILL_LIMITS.minContextBudget, SKILL_LIMITS.maxContextBudget)
  const riskLevel = enumList([requireString(fields, "risk_level")], SKILL_RISK_LEVELS, "risk_level")[0]!

  const triggers = requireList(fields, "triggers", true).map((trigger) => trigger.trim().toLowerCase())
  if (triggers.length > SKILL_LIMITS.maxTriggers) throw new SkillValidationError("INVALID_FIELD", `Field 'triggers' allows at most ${SKILL_LIMITS.maxTriggers} entries`)
  for (const trigger of triggers) {
    if (!trigger || trigger.length > SKILL_LIMITS.maxTriggerChars || !/^[a-z0-9][a-z0-9 '-]*$/.test(trigger)) {
      throw new SkillValidationError("INVALID_FIELD", `Trigger '${trigger.slice(0, 40)}' must be a short lowercase phrase`)
    }
  }
  const composesWith = requireList(fields, "composes_with", true)
  for (const other of composesWith) {
    if (!SKILL_ID_PATTERN.test(other) || other === id) throw new SkillValidationError("INVALID_FIELD", `Field 'composes_with' has invalid id '${other.slice(0, 40)}'`)
  }

  return { id, name, description, version, category, allowedModes: modes as AgentMode[], capabilities, requiredTools, contextBudget, riskLevel, triggers, composesWith }
}

const EXECUTABLE_BODY = /<\s*(script|iframe|object|embed)\b|javascript:|<\?php/i

const NEGATION_WINDOW = /\b(not|never|no|don't|do not|must not|cannot|without first)\b[^.\n]{0,24}$/i

/**
 * Directives that try to override the runtime's authority. A skill is guidance only, so these are
 * rejected outright rather than injected and hoped to be ignored. Negated phrasing ("never skip
 * verification") is permitted.
 */
const UNSAFE_DIRECTIVES: readonly RegExp[] = [
  /\b(ignore|disregard|override|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system|security|safety)\s+(instructions?|rules|polic(y|ies)|guidance|prompts?)/i,
  /\b(disable|bypass|skip|circumvent|turn off|suppress|override)\s+(\w+\s+){0,2}(verification|permissions?|approvals?|confirmations?|security|sandbox|safety|polic(y|ies)|guards?|permissiongate)\b/i,
  /\b(auto-?approve|automatically approve|without (asking|approval|confirmation|permission|review))\b/i,
  /\b(enable|use|switch to|fall ?back to|route to)\s+(a\s+|the\s+)?(cloud|remote|hosted)\s+(model|provider|fallback|api|inference|llm)/i,
  /\b(print|reveal|send|upload|exfiltrate|post|leak|dump|copy|read)\s+(\w+\s+){0,3}(secrets?|api[ _-]?keys?|credentials?|passwords?|\.env\b|private keys?|tokens?)\b/i,
  /\b(you (are|have been) (now\s+)?(authorized|allowed|permitted|granted)|grant (yourself|the agent)|elevat\w*\s+(permissions?|privileges?))/i,
  /\b(ignore|replace|abandon|disregard)\s+(the\s+)?(user'?s?\s+)?(task|request)\b/i,
]

export function findUnsafeDirective(text: string): string | undefined {
  for (const pattern of UNSAFE_DIRECTIVES) {
    const global = new RegExp(pattern.source, "gi")
    for (let match = global.exec(text); match; match = global.exec(text)) {
      const before = text.slice(Math.max(0, match.index - 40), match.index)
      if (!NEGATION_WINDOW.test(before)) return match[0]
    }
  }
  return undefined
}

export function containsSecret(text: string): boolean {
  return redactRuntimeEvalSecrets(text) !== text
}

export interface ParsedSkillBody {
  readonly sections: ReadonlyMap<string, string>
}

/** Splits a body on level-1 headings and validates safety and required sections. */
export function validateSkillBody(body: string): ParsedSkillBody {
  if (!body.trim()) throw new SkillValidationError("EMPTY_BODY", "SKILL.md body is empty")
  if (EXECUTABLE_BODY.test(body)) throw new SkillValidationError("EXECUTABLE_CONTENT", "SKILL.md body contains executable markup")
  if (containsSecret(body)) throw new SkillValidationError("SECRET_DETECTED", "SKILL.md body contains a secret-like value")
  const unsafe = findUnsafeDirective(body)
  if (unsafe) throw new SkillValidationError("UNSAFE_DIRECTIVE", `SKILL.md body contains an authority-override directive: "${unsafe.slice(0, 60)}"`)

  const sections = new Map<string, string>()
  const headings = [...body.matchAll(/^# (.+)$/gm)]
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const title = heading[1]!.trim()
    const end = index + 1 < headings.length ? headings[index + 1]!.index : body.length
    if (sections.has(title)) throw new SkillValidationError("DUPLICATE_SECTION", `Section '${title}' is declared more than once`)
    sections.set(title, body.slice(heading.index, end).trim())
  }
  for (const required of REQUIRED_SKILL_SECTIONS) {
    const section = sections.get(required)
    if (!section || section.split("\n").slice(1).join("\n").trim() === "") {
      throw new SkillValidationError("MISSING_SECTION", `Required section '# ${required}' is missing or empty`)
    }
  }
  return { sections }
}
