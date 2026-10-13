import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { readSkillFrontmatter } from "../context/skills.ts"
import { RepositoryPathError, resolveRepositoryPath } from "../tools/path-safety.ts"
import { SKILL_LIMITS, SKILL_RISK_LEVELS, type SkillDiagnostic, type SkillIndexEntry, type SkillSourceKind } from "./contracts.ts"
import { SkillValidationError, parseSkillFrontmatter, splitSkillDocument, validateSkillBody, validateSkillMetadata, type ValidatedSkillMetadata } from "./schema.ts"

export const WORKSPACE_SKILLS_DIR = join(".open-vs-code", "skills")
const SKILL_FILE = "SKILL.md"
/** A body shorter than this cannot contain the seven required sections. */
const MIN_BODY_BYTES = 64

export interface SkillFileSystem {
  /** Sorted child entry names that are directories (or symlinks, resolved later by containment checks). */
  listDirectories(root: string): Promise<string[] | undefined>
  readFrontmatter(path: string, maxBytes: number): Promise<string>
  readText(path: string): Promise<string>
  size(path: string): Promise<number>
}

export const nodeSkillFileSystem: SkillFileSystem = {
  async listDirectories(root) {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .toSorted((left, right) => left.localeCompare(right))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined
      throw error
    }
  },
  readFrontmatter: readSkillFrontmatter,
  readText: (path) => readFile(path, "utf8"),
  size: async (path) => (await stat(path)).size,
}

/** Location of the curated built-in skills shipped with agent-core. Undefined inside bundles without `import.meta`. */
export function defaultBuiltinSkillsRoot(): string | undefined {
  try {
    return fileURLToPath(new URL("../../skills/builtins/", import.meta.url))
  } catch {
    return undefined
  }
}

export interface SkillRegistryOptions {
  readonly builtinRoot?: string
  readonly workspaceRoot?: string
  /** Workspace skills are untrusted repository content and are only indexed for trusted workspaces. */
  readonly workspaceTrusted: boolean
  readonly fs?: SkillFileSystem
}

export interface LoadedSkillBody {
  readonly entry: SkillIndexEntry
  readonly sections: ReadonlyMap<string, string>
}

interface IndexedSkill {
  readonly entry: SkillIndexEntry
  readonly absolutePath: string
  /** Workspace skills are re-contained at load time so a post-index symlink swap cannot escape. */
  readonly containment?: { readonly workspaceRoot: string; readonly relativePath: string }
}

function riskRank(level: SkillIndexEntry["riskLevel"]): number {
  return SKILL_RISK_LEVELS.indexOf(level)
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  return values.every((value) => allowed.includes(value))
}

/** A workspace override may only narrow what the built-in it shadows declares. */
function expandsBuiltin(override: SkillIndexEntry, builtin: SkillIndexEntry): string | undefined {
  if (!isSubset(override.capabilities, builtin.capabilities)) return "capabilities"
  if (!isSubset(override.allowedModes, builtin.allowedModes)) return "allowed_modes"
  if (!isSubset(override.requiredTools, builtin.requiredTools)) return "required_tools"
  if (riskRank(override.riskLevel) > riskRank(builtin.riskLevel)) return "risk_level"
  if (override.contextBudget > builtin.contextBudget) return "context_budget"
  return undefined
}

function sameMetadata(entry: SkillIndexEntry, metadata: ValidatedSkillMetadata): boolean {
  const indexed = {
    id: entry.id, name: entry.name, description: entry.description, version: entry.version, category: entry.category,
    allowedModes: entry.allowedModes, capabilities: entry.capabilities, requiredTools: entry.requiredTools,
    contextBudget: entry.contextBudget, riskLevel: entry.riskLevel, triggers: entry.triggers, composesWith: entry.composesWith,
  }
  return JSON.stringify(indexed) === JSON.stringify(metadata)
}

/**
 * Deterministic skill discovery: discover → validate → index metadata → lazily load bodies.
 *
 * Startup reads only each file's frontmatter prefix and size. A body is read the first time it is
 * requested and cached thereafter, so unselected skills never leave disk.
 */
export class SkillRegistry {
  readonly #skills: ReadonlyMap<string, IndexedSkill>
  readonly #diagnostics: readonly SkillDiagnostic[]
  readonly #fs: SkillFileSystem
  readonly #bodies = new Map<string, Promise<LoadedSkillBody>>()

  private constructor(skills: Map<string, IndexedSkill>, diagnostics: SkillDiagnostic[], fs: SkillFileSystem) {
    this.#skills = skills
    this.#diagnostics = diagnostics
    this.#fs = fs
  }

  static empty(): SkillRegistry {
    return new SkillRegistry(new Map(), [], nodeSkillFileSystem)
  }

  static async discover(options: SkillRegistryOptions): Promise<SkillRegistry> {
    const fs = options.fs ?? nodeSkillFileSystem
    const diagnostics: SkillDiagnostic[] = []
    const builtins = new Map<string, IndexedSkill>()

    if (options.builtinRoot) {
      const builtinRoot = options.builtinRoot
      for (const directory of (await fs.listDirectories(builtinRoot)) ?? []) {
        const indexed = await indexSkill(fs, "builtin", directory, join(directory, SKILL_FILE), join(builtinRoot, directory, SKILL_FILE), diagnostics)
        if (indexed) builtins.set(indexed.entry.id, indexed)
      }
    }

    const skills = new Map(builtins)
    if (options.workspaceRoot) {
      const workspaceRoot = options.workspaceRoot
      const directories = await fs.listDirectories(join(workspaceRoot, WORKSPACE_SKILLS_DIR))
      if (directories && !options.workspaceTrusted) {
        diagnostics.push({ code: "WORKSPACE_UNTRUSTED", source: "workspace", skill: WORKSPACE_SKILLS_DIR, message: "Workspace skills are ignored until the workspace is trusted" })
      } else if (directories) {
        if (directories.length > SKILL_LIMITS.maxWorkspaceSkills) {
          diagnostics.push({ code: "WORKSPACE_LIMIT", source: "workspace", skill: WORKSPACE_SKILLS_DIR, message: `Only the first ${SKILL_LIMITS.maxWorkspaceSkills} workspace skills are indexed` })
        }
        for (const directory of directories.slice(0, SKILL_LIMITS.maxWorkspaceSkills)) {
          const relativePath = join(WORKSPACE_SKILLS_DIR, directory, SKILL_FILE)
          let absolutePath: string
          try {
            absolutePath = await resolveRepositoryPath(workspaceRoot, relativePath, "file")
          } catch (error) {
            const missing = error instanceof RepositoryPathError && error.code === "NOT_FOUND"
            diagnostics.push({
              code: missing ? "READ_FAILED" : "UNSAFE_PATH",
              source: "workspace",
              skill: directory,
              message: missing ? `${relativePath} does not exist` : `${relativePath} resolves outside the workspace or is not a regular file`,
            })
            continue
          }
          const indexed = await indexSkill(fs, "workspace", directory, join(directory, SKILL_FILE), absolutePath, diagnostics)
          const builtin = builtins.get(directory)
          if (!indexed) {
            if (builtin) diagnostics.push({ code: "OVERRIDE_INVALID", source: "workspace", skill: directory, message: `Invalid workspace override ignored; built-in '${directory}' remains active` })
            continue
          }
          if (builtin) {
            const expanded = expandsBuiltin(indexed.entry, builtin.entry)
            if (expanded) {
              diagnostics.push({
                code: "OVERRIDE_EXPANDS_PERMISSIONS",
                source: "workspace",
                skill: directory,
                message: `Workspace override expands '${expanded}' beyond the built-in; built-in '${directory}' remains active`,
              })
              continue
            }
          }
          skills.set(indexed.entry.id, { ...indexed, containment: { workspaceRoot, relativePath } })
        }
      }
    }

    const sorted = new Map([...skills.entries()].toSorted(([left], [right]) => left.localeCompare(right)))
    return new SkillRegistry(sorted, diagnostics, fs)
  }

  get entries(): readonly SkillIndexEntry[] {
    return [...this.#skills.values()].map((skill) => skill.entry)
  }

  get diagnostics(): readonly SkillDiagnostic[] {
    return this.#diagnostics
  }

  get(id: string): SkillIndexEntry | undefined {
    return this.#skills.get(id)?.entry
  }

  /** Reads, re-validates and caches one skill body. Repeated calls share a single read. */
  loadBody(id: string): Promise<LoadedSkillBody> {
    const cached = this.#bodies.get(id)
    if (cached) return cached
    const skill = this.#skills.get(id)
    if (!skill) return Promise.reject(new SkillValidationError("READ_FAILED", `Skill '${id}' is not indexed`))
    const loading = this.#readBody(skill)
    this.#bodies.set(id, loading)
    return loading
  }

  async #readBody(skill: IndexedSkill): Promise<LoadedSkillBody> {
    if (skill.containment) {
      let resolved: string
      try {
        resolved = await resolveRepositoryPath(skill.containment.workspaceRoot, skill.containment.relativePath, "file")
      } catch {
        throw new SkillValidationError("UNSAFE_PATH", `Skill '${skill.entry.id}' no longer resolves inside the workspace`)
      }
      if (resolved !== skill.absolutePath) throw new SkillValidationError("CHANGED_SINCE_INDEX", `Skill '${skill.entry.id}' path changed after indexing`)
    }
    const size = await this.#fs.size(skill.absolutePath)
    if (size > SKILL_LIMITS.maxFileBytes) throw new SkillValidationError("TOO_LARGE", `SKILL.md exceeds ${SKILL_LIMITS.maxFileBytes} bytes`)
    const { frontmatter, body } = splitSkillDocument(await this.#fs.readText(skill.absolutePath))
    const metadata = validateSkillMetadata(parseSkillFrontmatter(frontmatter), skill.entry.id)
    if (!sameMetadata(skill.entry, metadata)) throw new SkillValidationError("CHANGED_SINCE_INDEX", `Skill '${skill.entry.id}' metadata changed after indexing`)
    const { sections } = validateSkillBody(body)
    return { entry: skill.entry, sections }
  }
}

async function indexSkill(
  fs: SkillFileSystem,
  source: SkillSourceKind,
  directory: string,
  relativePath: string,
  absolutePath: string,
  diagnostics: SkillDiagnostic[],
): Promise<IndexedSkill | undefined> {
  try {
    const fileBytes = await fs.size(absolutePath)
    if (fileBytes > SKILL_LIMITS.maxFileBytes) throw new SkillValidationError("TOO_LARGE", `SKILL.md is ${fileBytes} bytes; the limit is ${SKILL_LIMITS.maxFileBytes}`)
    const prefix = await fs.readFrontmatter(absolutePath, SKILL_LIMITS.maxFrontmatterBytes + 8)
    const { frontmatter } = splitSkillDocument(prefix)
    const metadata = validateSkillMetadata(parseSkillFrontmatter(frontmatter), directory)
    if (fileBytes - Buffer.byteLength(prefix, "utf8") < MIN_BODY_BYTES) throw new SkillValidationError("EMPTY_BODY", "SKILL.md has no Markdown body")
    return { entry: { ...metadata, source, relativePath, fileBytes }, absolutePath }
  } catch (error) {
    if (error instanceof SkillValidationError) {
      diagnostics.push({ code: error.code, source, skill: directory, message: error.message })
    } else {
      diagnostics.push({ code: "READ_FAILED", source, skill: directory, message: `SKILL.md could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})` })
    }
    return undefined
  }
}
