/**
 * Node adapters for the learning store (Sprint 5D, ADR-032). Writes are contained to two
 * workspace-relative prefixes — the learning store and project-local workspace skills — checked
 * with the existing storage-path safety (realpath containment, symlink escape), and are atomic.
 * Built-in skills are never on a writable path.
 */
import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { assertSafeStoragePath } from "../recovery/storage-path-safety.ts"
import { resolveRepositoryPath } from "../tools/path-safety.ts"
import { LEARNING_HISTORY_DIR, LEARNING_STORE_PATH } from "./contracts.ts"
import { LEARNED_SKILLS_DIR, LearningService, type LearningStorage, type LearningWorkspaceFiles } from "./service.ts"

const WRITABLE_PREFIXES = [`${LEARNED_SKILLS_DIR}/`, `${LEARNING_HISTORY_DIR}/`, LEARNING_STORE_PATH]

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, target)
}

export function createNodeLearningFiles(workspaceRoot: string): LearningWorkspaceFiles & LearningStorage {
  const contained = async (relativePath: string): Promise<string> => {
    if (relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.split("/").includes("..")) throw new Error(`unsafe learning path: ${relativePath}`)
    return assertSafeStoragePath(workspaceRoot, relativePath)
  }
  const readText = async (relativePath: string): Promise<string | undefined> => {
    try {
      return await readFile(await resolveRepositoryPath(workspaceRoot, relativePath, "file"), "utf8")
    } catch {
      return undefined
    }
  }
  return {
    exists: async (relativePath) => {
      try {
        await resolveRepositoryPath(workspaceRoot, relativePath)
        return true
      } catch {
        return false
      }
    },
    readText,
    writeText: async (relativePath, content) => {
      if (!WRITABLE_PREFIXES.some((prefix) => relativePath === prefix || (prefix.endsWith("/") && relativePath.startsWith(prefix)))) throw new Error(`learning may not write ${relativePath}`)
      await atomicWrite(await contained(relativePath), content)
    },
    read: () => readText(LEARNING_STORE_PATH),
    write: async (text) => atomicWrite(await contained(LEARNING_STORE_PATH), text),
  }
}

/** A stable, local project id: the hash of the workspace's real path. Never sent anywhere. */
export async function projectIdFor(workspaceRoot: string): Promise<string> {
  const root = await realpath(workspaceRoot).catch(() => workspaceRoot)
  return `p-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`
}

export async function openWorkspaceLearning(options: { readonly workspaceRoot: string; readonly enabled: boolean; readonly workspaceTrusted: boolean; readonly builtinSkillIds: readonly string[]; readonly clock?: () => string }): Promise<LearningService> {
  const files = createNodeLearningFiles(options.workspaceRoot)
  return LearningService.open({
    enabled: options.enabled,
    projectId: await projectIdFor(options.workspaceRoot),
    storage: files,
    files,
    builtinSkillIds: options.builtinSkillIds,
    workspaceTrusted: options.workspaceTrusted,
    ...(options.clock ? { clock: options.clock } : {}),
  })
}
