import { readFile, stat, realpath } from "node:fs/promises"
import { extname, relative } from "node:path"

import { RepositoryPathError, resolveRepositoryPath } from "./path-safety.ts"

export type ReadFileErrorCode = "OUTSIDE_WORKSPACE" | "NOT_FOUND" | "BINARY_FILE" | "TOO_LARGE" | "INVALID_LIMIT"

export class ReadFileError extends Error {
  readonly code: ReadFileErrorCode

  constructor(code: ReadFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ReadFileError"
    this.code = code
  }
}

const BINARY_EXTENSIONS = new Set([".bin", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".webp", ".zip"])

export function isProbablyBinary(path: string, content: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLocaleLowerCase())) return true
  const sample = content.subarray(0, Math.min(content.length, 8_192))
  return sample.includes(0)
}

export async function readRepositoryFile(
  workspaceRoot: string,
  requestedPath: string,
  options: {
    readonly maxBytes?: number
    readonly startLine?: number
    readonly endLine?: number
  } = {},
): Promise<{
  readonly path: string
  readonly content: string
  readonly sizeBytes: number
  readonly truncated?: boolean
  readonly totalLines?: number
  readonly startLine?: number
  readonly endLine?: number
}> {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new ReadFileError("INVALID_LIMIT", "maxBytes must be a positive integer")
  let path: string
  try {
    path = await resolveRepositoryPath(workspaceRoot, requestedPath, "file")
  } catch (error) {
    if (error instanceof RepositoryPathError && (error.code === "OUTSIDE_WORKSPACE" || error.code === "NOT_FOUND")) {
      throw new ReadFileError(error.code, error.message, { cause: error })
    }
    throw error
  }
  const details = await stat(path)
  // If line range is specified, allow reading from files larger than maxBytes by slicing
  const hasLineRange = options.startLine !== undefined || options.endLine !== undefined
  if (details.size > maxBytes && !hasLineRange) {
    throw new ReadFileError("TOO_LARGE", `File exceeds ${maxBytes} bytes: ${requestedPath}`)
  }
  const bytes = await readFile(path)
  if (isProbablyBinary(path, bytes)) throw new ReadFileError("BINARY_FILE", `Binary files cannot be read as context: ${requestedPath}`)

  const rawText = bytes.toString("utf8")
  const lines = rawText.split(/\r?\n/)
  const totalLines = lines.length

  if (hasLineRange) {
    const start = Math.max(1, options.startLine ?? 1)
    const end = Math.min(totalLines, options.endLine ?? totalLines)
    const slicedLines = lines.slice(start - 1, end)
    let content = slicedLines.join("\n")
    let truncated = false
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      content = content.slice(0, maxBytes) + "\n[TRUNCATED]"
      truncated = true
    }
    const realRoot = await realpath(workspaceRoot)
    const relPath = relative(realRoot, path).replaceAll("\\", "/")
    return {
      path: relPath,
      content,
      sizeBytes: details.size,
      truncated,
      totalLines,
      startLine: start,
      endLine: end,
    }
  }

  let content = rawText
  let truncated = false
  if (details.size > maxBytes) {
    content = rawText.slice(0, maxBytes) + "\n[TRUNCATED]"
    truncated = true
  }

  const realRoot = await realpath(workspaceRoot)
  const relPath = relative(realRoot, path).replaceAll("\\", "/")
  return {
    path: relPath,
    content,
    sizeBytes: details.size,
    truncated,
    totalLines,
  }
}
