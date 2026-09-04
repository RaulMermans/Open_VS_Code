import { open, readFile, readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"

import { RepositoryPathError, resolveRepositoryPath } from "../tools/path-safety.ts"
import { estimateTokens } from "./budget.ts"

export type SkillErrorCode = "MALFORMED_FRONTMATTER" | "INVALID_METADATA" | "DUPLICATE_NAME" | "MISSING_FILE" | "SKILL_NOT_FOUND" | "TOO_LARGE" | "DUPLICATE_ID"

export class SkillError extends Error {
  readonly code: SkillErrorCode

  constructor(code: SkillErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SkillError"
    this.code = code
  }
}

export interface SkillMetadata {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly modes: readonly string[]
  readonly tags: readonly string[]
  readonly tools?: readonly string[]
  readonly triggers?: readonly string[]
  readonly version?: string
  readonly path: string
  readonly estimatedTokens: number
}

export interface LoadedSkill extends SkillMetadata {
  readonly body: string
}

export interface SkillFileReader {
  readFrontmatter(path: string, maxBytes: number): Promise<string>
  readText(path: string): Promise<string>
  statSize(path: string): Promise<number>
}

export async function readSkillFrontmatter(path: string, maxBytes: number): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive integer")
  const handle = await open(path, "r")
  const buffer = Buffer.alloc(maxBytes)
  let bytesRead = 0
  try {
    while (bytesRead < maxBytes) {
      const result = await handle.read(buffer, bytesRead, 1, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
      const lfDelimiter = bytesRead >= 5 && buffer.subarray(bytesRead - 5, bytesRead).equals(Buffer.from("\n---\n"))
      const crlfDelimiter = bytesRead >= 7 && buffer.subarray(bytesRead - 7, bytesRead).equals(Buffer.from("\r\n---\r\n"))
      if (lfDelimiter || crlfDelimiter) break
    }
  } finally {
    await handle.close()
  }
  return buffer.subarray(0, bytesRead).toString("utf8")
}

const nodeSkillFileReader: SkillFileReader = {
  readFrontmatter: readSkillFrontmatter,
  readText: (path) => readFile(path, "utf8"),
  statSize: async (path) => (await stat(path)).size,
}

function parseSkillDocument(content: string, path: string, fileSize: number): { metadata: Omit<SkillMetadata, "path" | "estimatedTokens">; body: string } {
  const normalized = content.replaceAll("\r\n", "\n")
  if (!normalized.startsWith("---\n")) throw new SkillError("MALFORMED_FRONTMATTER", `Skill frontmatter is missing: ${path}`)
  const end = normalized.indexOf("\n---\n", 4)
  if (end < 0) throw new SkillError("MALFORMED_FRONTMATTER", `Skill frontmatter is not terminated: ${path}`)
  
  const values = new Map<string, any>()
  const lines = normalized.slice(4, end).split("\n")
  let currentArrayKey: string | null = null
  let currentArray: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    if (line.startsWith("  - ")) {
      if (currentArrayKey) {
        currentArray.push(line.slice(4).trim())
      }
      continue
    }
    
    if (currentArrayKey) {
      values.set(currentArrayKey, currentArray)
      currentArrayKey = null
      currentArray = []
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)\s*$/.exec(line)
    if (!match) throw new SkillError("MALFORMED_FRONTMATTER", `Unsupported Skill frontmatter line in ${path}: ${line}`)
    
    const key = match[1]!
    const value = match[2]!.trim()
    
    if (value === "") {
      currentArrayKey = key
      currentArray = []
    } else {
      values.set(key, value.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"))
    }
  }
  if (currentArrayKey) {
    values.set(currentArrayKey, currentArray)
  }

  // Backwards compatibility for old tests
  const id = values.get("id") ?? values.get("name")
  const title = values.get("title") ?? values.get("name")
  const summary = values.get("summary") ?? values.get("description")
  
  if (!id || typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new SkillError("INVALID_METADATA", `Skill id is invalid: ${path}`)
  if (!title || typeof title !== "string") throw new SkillError("INVALID_METADATA", `Skill title is required: ${path}`)
  if (!summary || typeof summary !== "string") throw new SkillError("INVALID_METADATA", `Skill summary is required: ${path}`)
  
  const modes = Array.isArray(values.get("modes")) ? values.get("modes") : []
  const tags = Array.isArray(values.get("tags")) ? values.get("tags") : []
  const tools = Array.isArray(values.get("tools")) ? values.get("tools") : undefined
  const triggers = Array.isArray(values.get("triggers")) ? values.get("triggers") : undefined
  const version = typeof values.get("version") === "string" ? values.get("version") : undefined

  return { 
    metadata: { 
      id, 
      title, 
      summary, 
      modes, 
      tags, 
      tools, 
      triggers, 
      version 
    }, 
    body: normalized.slice(end + 5).trim() 
  }
}

export async function discoverSkills(
  workspaceRoot: string,
  options: { readonly reader?: SkillFileReader; readonly maxMetadataBytes?: number } = {},
): Promise<SkillMetadata[]> {
  const reader = options.reader ?? nodeSkillFileReader
  const maxMetadataBytes = options.maxMetadataBytes ?? 8 * 1024
  let skillsRoot: string
  try {
    skillsRoot = await resolveRepositoryPath(workspaceRoot, join(".agents", "skills"), "directory")
  } catch (error) {
    if (error instanceof RepositoryPathError && error.code === "NOT_FOUND") return []
    throw error
  }
  const directories = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .toSorted((left, right) => left.name.localeCompare(right.name))
  const discovered: SkillMetadata[] = []
  const ids = new Set<string>()
  for (const directory of directories) {
    const relativePath = join(".agents", "skills", directory.name, "SKILL.md")
    let path: string
    try {
      path = await resolveRepositoryPath(workspaceRoot, relativePath, "file")
    } catch (error) {
      if (error instanceof RepositoryPathError && error.code === "NOT_FOUND") continue // T-650: Isolate missing skills instead of crashing
      throw error
    }
    try {
      const prefix = await reader.readFrontmatter(path, maxMetadataBytes)
      const fileSize = await reader.statSize(path)
      const { metadata } = parseSkillDocument(prefix, relativePath, fileSize)
      if (ids.has(metadata.id)) throw new SkillError("DUPLICATE_ID", `Duplicate Skill id: ${metadata.id}`)
      ids.add(metadata.id)
      
      const estimatedTokens = Math.ceil(fileSize / 4)
      discovered.push({ ...metadata, path: relative(workspaceRoot, path), estimatedTokens })
    } catch (error) {
       // T-650: Isolate malformed skills. If DUPLICATE_ID, isolate both by removing the existing one and continuing?
       // Wait, "If two primitive files claim: id: BUG_TRIAGE_LOOP fail skill catalog construction for that ID or isolate both."
       if (error instanceof SkillError && error.code === "DUPLICATE_ID") {
          const idMatch = error.message.match(/Duplicate Skill id: (.*)$/)
          if (idMatch) {
             const duplicateId = idMatch[1]
             // Isolate both
             const idx = discovered.findIndex(s => s.id === duplicateId)
             if (idx >= 0) discovered.splice(idx, 1)
          }
       }
       continue
    }
  }
  return discovered.toSorted((left, right) => left.id.localeCompare(right.id))
}

export function getSkillMetadata(skills: readonly SkillMetadata[], id: string): SkillMetadata {
  const skill = skills.find((candidate) => candidate.id === id)
  if (!skill) throw new SkillError("SKILL_NOT_FOUND", `Skill not found: ${id}`)
  return skill
}

export async function loadSkill(
  workspaceRoot: string,
  metadata: SkillMetadata,
  options: { readonly reader?: SkillFileReader; readonly maxBytes?: number } = {},
): Promise<LoadedSkill> {
  const reader = options.reader ?? nodeSkillFileReader
  const maxBytes = options.maxBytes ?? 64 * 1024
  const path = await resolveRepositoryPath(workspaceRoot, metadata.path, "file")
  const fileSize = await reader.statSize(path)
  if (fileSize > maxBytes) throw new SkillError("TOO_LARGE", `Skill exceeds ${maxBytes} bytes: ${metadata.id}`)
  const parsed = parseSkillDocument(await reader.readText(path), metadata.path, fileSize)
  if (parsed.metadata.id !== metadata.id) {
    throw new SkillError("INVALID_METADATA", `Skill metadata changed before loading: ${metadata.id}`)
  }
  return { ...metadata, body: parsed.body }
}

export function loadSkillSections(body: string, sections: string[]): string {
  if (sections.length === 0) return body
  const regex = /^#\s+(.+)$/gm
  let match
  const blocks: {title: string, start: number}[] = []
  while ((match = regex.exec(body)) !== null) {
    blocks.push({ title: match[1]!.trim(), start: match.index })
  }
  if (blocks.length === 0) return body
  
  let result = ""
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    const isSelected = sections.some(s => block.title.toLowerCase() === s.toLowerCase())
    if (isSelected) {
      const end = i < blocks.length - 1 ? blocks[i+1]!.start : body.length
      result += body.slice(block.start, end).trim() + "\n\n"
    }
  }
  return result.trim()
}

export function matchSkills(skills: readonly SkillMetadata[], query: string): SkillMetadata[] {
  const terms = query.toLocaleLowerCase().split(/\W+/).filter((term) => term.length > 2)
  return skills
    .filter((skill) => terms.some((term) => `${skill.id} ${skill.title} ${skill.summary}`.toLocaleLowerCase().includes(term)))
    .toSorted((left, right) => left.id.localeCompare(right.id))
}
