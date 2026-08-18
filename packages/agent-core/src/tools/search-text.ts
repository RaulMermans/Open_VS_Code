import { findFiles } from "./find-files.ts"
import { ReadFileError, readRepositoryFile } from "./read-file.ts"

export interface TextSearchResult {
  readonly path: string
  readonly line: number
  readonly text: string
}

export async function searchText(
  workspaceRoot: string,
  query: string,
  options: {
    readonly rootPath?: string
    readonly maxResults?: number
    readonly maxFileBytes?: number
    readonly maxLineLength?: number
    readonly maxOutputBytes?: number
    readonly ignoredDirectories?: readonly string[]
  } = {},
): Promise<{ readonly results: readonly TextSearchResult[]; readonly truncated: boolean }> {
  const maxResults = options.maxResults ?? 100
  const maxLineLength = options.maxLineLength ?? 500
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024
  for (const [name, value] of Object.entries({ maxResults, maxLineLength, maxOutputBytes })) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  }
  const files = await findFiles(workspaceRoot, "**/*", {
    ...(options.rootPath ? { rootPath: options.rootPath } : {}),
    maxResults: 10_000,
    ...(options.ignoredDirectories ? { ignoredDirectories: options.ignoredDirectories } : {}),
  })
  const needle = query.toLocaleLowerCase()
  const results: TextSearchResult[] = []
  let outputBytes = 0
  let truncated = files.truncated
  for (const path of files.paths) {
    let content: string
    try {
      content = (await readRepositoryFile(workspaceRoot, path, { maxBytes: options.maxFileBytes ?? 1024 * 1024 })).content
    } catch (error) {
      if (error instanceof ReadFileError && (error.code === "BINARY_FILE" || error.code === "TOO_LARGE")) continue
      throw error
    }
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.toLocaleLowerCase().includes(needle)) continue
      const text = line.slice(0, maxLineLength)
      const bytes = Buffer.byteLength(path) + Buffer.byteLength(text)
      if (results.length >= maxResults || outputBytes + bytes > maxOutputBytes) {
        truncated = true
        return { results, truncated }
      }
      results.push({ path, line: index + 1, text })
      outputBytes += bytes
    }
  }
  return { results, truncated }
}
