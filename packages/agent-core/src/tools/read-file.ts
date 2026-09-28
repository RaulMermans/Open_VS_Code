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

export function truncateUtf8ToBytes(
  text: string,
  maxBytes: number,
): {
  readonly text: string
  readonly bytes: number
  readonly truncated: boolean
} {
  if (maxBytes <= 0) {
    return { text: "", bytes: 0, truncated: text.length > 0 }
  }

  const totalBytes = Buffer.byteLength(text, "utf8")
  if (totalBytes <= maxBytes) {
    return { text, bytes: totalBytes, truncated: false }
  }

  let accumulatedBytes = 0
  let accumulatedChars = 0

  for (const cp of text) {
    const cpBytes = Buffer.byteLength(cp, "utf8")
    if (accumulatedBytes + cpBytes > maxBytes) {
      return {
        text: text.slice(0, accumulatedChars),
        bytes: accumulatedBytes,
        truncated: true,
      }
    }
    accumulatedBytes += cpBytes
    accumulatedChars += cp.length
  }

  return {
    text: text.slice(0, accumulatedChars),
    bytes: accumulatedBytes,
    truncated: true,
  }
}

export interface ReadFileResult {
  readonly path: string
  readonly content: string
  readonly sizeBytes: number
  readonly truncated?: boolean
  readonly totalLines?: number
  readonly startLine?: number
  readonly endLine?: number
  readonly bytesReadFromFile: number
  readonly returnedBytes: number
  readonly chunksRead: number
  readonly wholeFileBuffered: boolean
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
): Promise<ReadFileResult> {
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

  const realRoot = await realpath(workspaceRoot)
  const relPath = relative(realRoot, path).replaceAll("\\", "/")

  // Truncation marker reserved from the maxBytes budget so the final returned
  // content (data + marker) always satisfies:
  //   Buffer.byteLength(content, "utf8") <= maxBytes
  // For maxBytes < TRUNCATION_MARKER_BYTES, no marker is appended and the data
  // budget collapses to 0 (returns empty content with truncated=true).
  const TRUNCATION_MARKER = "\n[TRUNCATED]"
  const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8") // 12
  const dataBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_BYTES)

  const handle = await open(path, "r")
  try {
    // --- PATH A: Full file read (no line range) ---
    // Binary check uses the already-read buffer — no separate offset-zero sample read.
    if (!hasLineRange) {
      const contentBuf = Buffer.alloc(details.size)
      let fileBytesRead = 0
      if (details.size > 0) {
        const { bytesRead } = await handle.read(contentBuf, 0, details.size, 0)
        fileBytesRead = bytesRead
      }
      // Binary detection: reuse already-loaded buffer (no extra read)
      if (isProbablyBinary(path, contentBuf.subarray(0, Math.min(contentBuf.length, 8192)))) {
        throw new ReadFileError("BINARY_FILE", `Binary files cannot be read as context: ${requestedPath}`)
      }
      const rawText = contentBuf.toString("utf8")
      const lines = rawText.split(/\r?\n/)
      return {
        path: relPath,
        content: rawText,
        sizeBytes: details.size,
        truncated: false,
        totalLines: lines.length,
        bytesReadFromFile: fileBytesRead,
        returnedBytes: Buffer.byteLength(rawText, "utf8"),
        chunksRead: fileBytesRead > 0 ? 1 : 0,
        wholeFileBuffered: true,
      }
    }

    // --- PATH B: Bounded streaming chunk scanner for line ranges ---
    // Binary detection reuses the first streaming chunk — no separate sample read.
    const targetStart = options.startLine ?? 1
    const targetEnd = options.endLine ?? Infinity

    const chunkBuf = Buffer.alloc(CHUNK_SIZE)
    const decoder = new StringDecoder("utf8")
    let fileOffset = 0
    let totalBytesRead = 0
    let chunksRead = 0
    let currentLineNumber = 1
    let pendingLine = ""
    const collectedLines: string[] = []
    let truncated = false
    let outputByteLength = 0
    let reachedTargetEnd = false
    let binaryChecked = false

    while (fileOffset < details.size && !reachedTargetEnd && !truncated) {
      const bytesToRead = Math.min(CHUNK_SIZE, details.size - fileOffset)
      const { bytesRead } = await handle.read(chunkBuf, 0, bytesToRead, fileOffset)
      if (bytesRead === 0) break
      fileOffset += bytesRead
      totalBytesRead += bytesRead
      chunksRead++

      // Binary detection on first chunk — reuses streaming bytes, no extra read
      if (!binaryChecked) {
        binaryChecked = true
        if (isProbablyBinary(path, chunkBuf.subarray(0, Math.min(bytesRead, 8192)))) {
          throw new ReadFileError("BINARY_FILE", `Binary files cannot be read as context: ${requestedPath}`)
        }
      }

      const text = decoder.write(chunkBuf.subarray(0, bytesRead))
      const parts = text.split("\n")

      // The first segment continues pendingLine
      const firstSegment = pendingLine + parts[0]
      parts[0] = firstSegment

      // The last element is the new pendingLine (incomplete line)
      pendingLine = parts.pop() ?? ""

      // Guard against huge single-line files without newlines.
      // Use dataBudget so the marker fits within maxBytes if truncation occurs.
      const pendingLineBytes = Buffer.byteLength(pendingLine, "utf8")
      if (pendingLineBytes > dataBudget) {
        truncated = true
        if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
          const trunc = truncateUtf8ToBytes(pendingLine, dataBudget)
          collectedLines.push(trunc.text)
          outputByteLength += trunc.bytes
        }
        break
      }

      for (let i = 0; i < parts.length; i++) {
        const line = parts[i]!.replace(/\r$/, "")

        if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
          const separatorBytes = collectedLines.length > 0 ? 1 : 0
          const lineBytes = Buffer.byteLength(line, "utf8")
          if (outputByteLength + separatorBytes + lineBytes > dataBudget) {
            const remaining = dataBudget - outputByteLength - separatorBytes
            if (remaining > 0) {
              const trunc = truncateUtf8ToBytes(line, remaining)
              if (trunc.text.length > 0) {
                collectedLines.push(trunc.text)
                outputByteLength += separatorBytes + trunc.bytes
              }
            }
            truncated = true
            break
          }
          collectedLines.push(line)
          outputByteLength += separatorBytes + lineBytes
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
      const trailingBytes = Buffer.byteLength(trailing, "utf8")
      if (currentLineNumber >= targetStart && currentLineNumber <= targetEnd) {
        const separatorBytes = collectedLines.length > 0 ? 1 : 0
        if (outputByteLength + separatorBytes + trailingBytes > dataBudget) {
          const remaining = dataBudget - outputByteLength - separatorBytes
          if (remaining > 0) {
            const trunc = truncateUtf8ToBytes(trailing, remaining)
            if (trunc.text.length > 0) {
              collectedLines.push(trunc.text)
              outputByteLength += separatorBytes + trunc.bytes
            }
          }
          truncated = true
        } else {
          collectedLines.push(trailing)
          outputByteLength += separatorBytes + trailingBytes
        }
      }
    }

    // Build final content. Marker is reserved from dataBudget so the total
    // (data bytes + marker bytes) <= maxBytes always.
    // If maxBytes < TRUNCATION_MARKER_BYTES, dataBudget collapsed to 0 and we
    // cannot fit even the marker — emit no marker, just return truncated=true.
    let content = collectedLines.join("\n")
    if (truncated && maxBytes >= TRUNCATION_MARKER_BYTES) {
      content += TRUNCATION_MARKER
    }

    return {
      path: relPath,
      content,
      sizeBytes: details.size,
      truncated,
      startLine: options.startLine ?? 1,
      endLine: options.endLine ?? currentLineNumber,
      // bytesReadFromFile counts ALL successful OS reads for this file.
      // Binary detection reuses the first streaming chunk, so there are
      // no hidden reads: bytesReadFromFile == sum of all handle.read() calls.
      bytesReadFromFile: totalBytesRead,
      returnedBytes: Buffer.byteLength(content, "utf8"),
      chunksRead,
      wholeFileBuffered: false,
    }
  } finally {
    await handle.close()
  }
}

