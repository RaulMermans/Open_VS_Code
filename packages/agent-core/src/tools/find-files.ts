import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

import { DEFAULT_IGNORED_DIRECTORIES } from "./list-directory.ts"
import { resolveRepositoryPath } from "./path-safety.ts"

function globExpression(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/")
  let expression = ""
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1
      if (normalized[index + 1] === "/") {
        index += 1
        expression += "(?:.*/)?"
      } else {
        expression += ".*"
      }
    } else if (character === "*") {
      expression += "[^/]*"
    } else if (character === "?") {
      expression += "[^/]"
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    }
  }
  if (!normalized.includes("/")) {
    return new RegExp(`^(?:.*/)?${expression}$`)
  }
  return new RegExp(`^${expression}$`)
}

export async function findFiles(
  workspaceRoot: string,
  pattern: string,
  options: {
    readonly rootPath?: string
    readonly maxResults?: number
    readonly ignoredDirectories?: readonly string[]
  } = {},
): Promise<{ readonly paths: readonly string[]; readonly truncated: boolean }> {
  const maxResults = options.maxResults ?? 500
  if (!Number.isInteger(maxResults) || maxResults <= 0) throw new TypeError("maxResults must be a positive integer")
  const start = await resolveRepositoryPath(workspaceRoot, options.rootPath ?? ".", "directory")
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES)
  const matches = globExpression(pattern)
  const paths: string[] = []
  let truncated = false

  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (paths.length >= maxResults) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolutePath)
        if (truncated) return
      } else if (entry.isFile()) {
        const repositoryPath = relative(workspaceRoot, absolutePath).replaceAll("\\", "/")
        if (matches.test(repositoryPath)) paths.push(repositoryPath)
      }
    }
  }

  await visit(start)
  return { paths, truncated }
}
