import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

import { resolveRepositoryPath } from "./path-safety.ts"

export const DEFAULT_IGNORED_DIRECTORIES = [".cache", ".git", ".next", "build", "coverage", "dist", "node_modules"] as const

export interface DirectoryEntry {
  readonly name: string
  readonly path: string
  readonly type: "file" | "directory" | "symlink" | "other"
}

export async function listDirectory(
  workspaceRoot: string,
  requestedPath = ".",
  options: { readonly maxEntries?: number; readonly ignoredDirectories?: readonly string[] } = {},
): Promise<{ readonly entries: readonly DirectoryEntry[]; readonly truncated: boolean }> {
  const maxEntries = options.maxEntries ?? 200
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer")
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES)
  const directory = await resolveRepositoryPath(workspaceRoot, requestedPath, "directory")
  const all = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !(entry.isDirectory() && ignored.has(entry.name)))
    .toSorted((left, right) => left.name.localeCompare(right.name))
  const entries = all.slice(0, maxEntries).map((entry): DirectoryEntry => ({
    name: entry.name,
    path: relative(workspaceRoot, join(directory, entry.name)).replaceAll("\\", "/"),
    type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other",
  }))
  return { entries, truncated: all.length > entries.length }
}
