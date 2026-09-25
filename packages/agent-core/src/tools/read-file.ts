import { stat, realpath, open } from "node:fs/promises"
import { extname, relative } from "node:path"
import { StringDecoder } from "node:string_decoder"

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

const CHUNK_SIZE = 64 * 1024

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
  readonly bytesReadFromFile?: number
}> {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new ReadFileError("INVALID_LIMIT", "maxBytes must be a positive integer")
  }

  if (options.startLine !== undefined) {
    if (!Number.isInteger(options.startLine) || options.startLine <= 0) {
      throw new ReadFileError("INVALID_LIMIT", "startLine must be a positive integer")
    }
  }
  if (options.endLine !== undefined) {
    if (!Number.isInteger(options.endLine) || options.endLine <= 0) {
      throw new ReadFileError("INVALID_LIMIT", "endLine must be a positive integer")
    }
  }
  if (
    options.startLine !== undefined &&
    options.endLine !== undefined &&
    options.startLine > options.endLine
  ) {
    throw new ReadFileError("INVALID_LIMIT", "startLine cannot be greater than endLine")
  }

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
  const hasLineRange = options.startLine !== undefined || options.endLine !== undefined

  if (details.size > maxBytes && !hasLineRange) {
    throw new ReadFileError("TOO_LARGE", `File exceeds ${maxBytes} bytes: ${requestedPath}`)
  }

  const handle = await open(path, "r")
  try {
    // 1. Check binary with bounded sample (first 8KB max)
    const sampleSize = Math.min(details.size, 8192)
    const sampleBuf = Buffer.alloc(sampleSize)
    if (sampleSize > 0) {
      await handle.read(sampleBuf, 0, sampleSize, 0)
    }
    if (isProbablyBinary(path, sampleBuf)) {
      throw new ReadFileError("BINARY_FILE", `Binary files cannot be read as context: ${requestedPath}`)
    }

    const realRoot = await realpath(workspaceRoot)
    const relPath = relative(realRoot, path).replaceAll("\\", "/")

    // 2. Full file read when no line range is requested (file is already confirmed <= maxBytes)
    if (!hasLineRange) {
      const contentBuf = Buffer.alloc(details.size)
      if (details.size > 0) {
        await handle.read(contentBuf, 0, details.size, 0)
      }
      const rawText = contentBuf.toString("utf8")
      const lines = rawText.split(/\r?\n/)
      return {
        path: relPath,
        content: rawText,
        sizeBytes: details.size,
        truncated: false,
        totalLines: lines.length,
        bytesReadFromFile: details.size,
      }
    }

    // 3. Truly bounded streaming chunk scanner for line ranges
    const targetStart = options.startLine ?? 1
    const targetEnd = options.endLine ?? Infinity

    const chunkBuf = Buffer.alloc(CHUNK_SIZE)
    const decoder = new StringDecoder("utf8")
    let fileOffset = 0
    let totalBytesRead = 0
    let currentLineNumber = 1
    let pendingLine = ""
    const collectedLines: string[] = []
    let truncated = false
    let outputByteLength = 0
    let reachedTargetEnd = false

    while (fileOffset < details.size && !reachedTargetEnd && !truncated) {
      const bytesToRead = Math.min(CHUNK_SIZE, details.size - fileOffset)
      const { bytesRead } = await handle.read(chunkBuf, 0, bytesToRead, fileOffset)
      if (bytesRead === 0) break
      fileOffset += bytesRead
      totalBytesRead += bytesRead

      const text = decoder.write(chunkBuf.subarray(0, bytesRead))
      const parts = text.split("\n")

      // The first segment continues pendingLine
      const firstSegment = pendingLine + parts[0]
      parts[0] = firstSegment

      // The last element is the new pendingLine (incomplete line)
      pendingLine = parts.pop() ?? ""

      // Guard against huge single-line files without newlines
      if (pendingLine.length > maxBytes) {
        truncated = true
        if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
          collectedLines.push(pendingLine.slice(0, maxBytes) + "\n[TRUNCATED]")
        }
        break
      }

      for (let i = 0; i < parts.length; i++) {
        const line = parts[i]!.replace(/\r$/, "")

        if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
          const lineBytes = Buffer.byteLength(line, "utf8") + (collectedLines.length > 0 ? 1 : 0)
          if (outputByteLength + lineBytes > maxBytes) {
            const remaining = maxBytes - outputByteLength
            if (remaining > 0) {
              collectedLines.push(line.slice(0, remaining))
            }
            truncated = true
            break
          }
          collectedLines.push(line)
          outputByteLength += lineBytes
        }

        if (currentLineNumber >= targetEnd) {
          reachedTargetEnd = true
          break
        }

        currentLineNumber++
      }
    }

    // Handle any final trailing pending line if EOF reached before targetEnd
    if (!truncated && !reachedTargetEnd && pendingLine.length > 0) {
      const trailing = (pendingLine + decoder.end()).replace(/\r$/, "")
      if (trailing.length > maxBytes) {
        truncated = true
        if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
          collectedLines.push(trailing.slice(0, maxBytes) + "\n[TRUNCATED]")
        }
      } else if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
        const lineBytes = Buffer.byteLength(trailing, "utf8") + (collectedLines.length > 0 ? 1 : 0)
        if (outputByteLength + lineBytes > maxBytes) {
          const remaining = maxBytes - outputByteLength
          if (remaining > 0) {
            collectedLines.push(trailing.slice(0, remaining))
          }
          truncated = true
        } else {
          collectedLines.push(trailing)
        }
      }
    }

    let content = collectedLines.join("\n")
    if (truncated && !content.endsWith("[TRUNCATED]")) {
      content += "\n[TRUNCATED]"
    }

    return {
      path: relPath,
      content,
      sizeBytes: details.size,
      truncated,
      startLine: options.startLine ?? 1,
      endLine: options.endLine ?? currentLineNumber,
      bytesReadFromFile: totalBytesRead,
    }
  } finally {
    await handle.close()
  }
}
