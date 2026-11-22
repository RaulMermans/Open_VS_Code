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
  options: { readonly maxEntries?: number; readonly ignoredDirectories?: readonly string[]; readonly depth?: number } = {},
): Promise<{ readonly entries: readonly DirectoryEntry[]; readonly truncated: boolean; readonly total: number }> {
  const maxEntries = options.maxEntries ?? 200
  const depth = options.depth ?? 1
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive integer")
  if (!Number.isInteger(depth) || depth < 1) throw new TypeError("depth must be a positive integer")
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES)
  const directory = await resolveRepositoryPath(workspaceRoot, requestedPath, "directory")
  const toEntry = (dir: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): DirectoryEntry => ({
    name: entry.name,
    path: relative(workspaceRoot, join(dir, entry.name)).replaceAll("\\", "/"),
    type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other",
  })
  const read = async (dir: string) => (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => !(entry.isDirectory() && ignored.has(entry.name)))
    .toSorted((left, right) => left.name.localeCompare(right.name))

  if (depth === 1) {
    const all = await read(directory)
    const entries = all.slice(0, maxEntries).map((entry) => toEntry(directory, entry))
    return { entries, truncated: all.length > entries.length, total: all.length }
  }

  const entries: DirectoryEntry[] = []
  let truncated = false
  const walk = async (current: string, remaining: number): Promise<void> => {
    const all = await read(current)
    for (const entry of all) {
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      entries.push(toEntry(current, entry))
      if (remaining > 1 && entry.isDirectory() && !entry.isSymbolicLink()) await walk(join(current, entry.name), remaining - 1)
    }
  }
  await walk(directory, depth)
  return { entries, truncated, total: truncated ? entries.length + 1 : entries.length }
}
