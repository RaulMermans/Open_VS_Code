import { readFile, stat } from "node:fs/promises"
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
  options: { readonly maxBytes?: number } = {},
): Promise<{ readonly path: string; readonly content: string; readonly sizeBytes: number }> {
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
  if (details.size > maxBytes) throw new ReadFileError("TOO_LARGE", `File exceeds ${maxBytes} bytes: ${requestedPath}`)
  const bytes = await readFile(path)
  if (isProbablyBinary(path, bytes)) throw new ReadFileError("BINARY_FILE", `Binary files cannot be read as context: ${requestedPath}`)
  return { path: relative(workspaceRoot, path).replaceAll("\\", "/"), content: bytes.toString("utf8"), sizeBytes: details.size }
}
