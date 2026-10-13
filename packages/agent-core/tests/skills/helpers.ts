import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { nodeSkillFileSystem, type SkillFileSystem } from "../../src/skills/registry.ts"

export const VALID_BODY = `
# Intent

Diagnose the reported problem before editing anything.

# When to Use

When a reproducible failure is reported.

# Inputs

- The failure report.

# Workflow

1. Reproduce the failure.
2. Read the failing code path.
3. Apply the smallest fix.

# Verification

- The failing check passes.

# Failure Modes

- Editing before reproducing.

# Exit Criteria

- Root cause stated and fix verified.
`

export type FieldValue = string | readonly string[] | undefined

export const VALID_FIELDS: Readonly<Record<string, FieldValue>> = {
  id: "sample-skill",
  name: "Sample Skill",
  description: "Diagnose a sample failure before changing code.",
  version: "1",
  category: "debugging",
  allowed_modes: ["DEBUG", "BUILD"],
  capabilities: ["read", "search"],
  required_tools: ["read_file", "search_text"],
  context_budget: "900",
  risk_level: "low",
  triggers: ["sample failure", "widget crash"],
}

export function skillDocument(overrides: Readonly<Record<string, FieldValue>> = {}, body = VALID_BODY): string {
  const fields = { ...VALID_FIELDS, ...overrides }
  const lines: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (typeof value === "string") lines.push(`${key}: ${value}`)
    else if (value.length === 0) lines.push(`${key}: []`)
    else lines.push(`${key}:`, ...value.map((item) => `  - ${item}`))
  }
  return `---\n${lines.join("\n")}\n---\n${body}`
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ovsc-skills-${prefix}-`))
}

export async function writeSkill(root: string, directory: string, content: string): Promise<string> {
  const dir = join(root, directory)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "SKILL.md")
  await writeFile(path, content)
  return path
}

export async function writeWorkspaceSkill(workspaceRoot: string, directory: string, content: string): Promise<string> {
  return writeSkill(join(workspaceRoot, ".open-vs-code", "skills"), directory, content)
}

export interface CountingFileSystem extends SkillFileSystem {
  readonly bodyReads: string[]
  readonly frontmatterReads: string[]
}

/** Wraps the real file system and records which files had their full text read. */
export function countingFileSystem(): CountingFileSystem {
  const bodyReads: string[] = []
  const frontmatterReads: string[] = []
  return {
    bodyReads,
    frontmatterReads,
    listDirectories: (root) => nodeSkillFileSystem.listDirectories(root),
    size: (path) => nodeSkillFileSystem.size(path),
    readFrontmatter: (path, maxBytes) => {
      frontmatterReads.push(path)
      return nodeSkillFileSystem.readFrontmatter(path, maxBytes)
    },
    readText: (path) => {
      bodyReads.push(path)
      return nodeSkillFileSystem.readText(path)
    },
  }
}

export const FULL_TOOLS = ["read_file", "list_directory", "find_files", "search_text", "apply_patch", "create_file", "run_verification"]
export const READONLY_TOOLS = ["read_file", "list_directory", "find_files", "search_text"]
export const BUDGET = { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 }
