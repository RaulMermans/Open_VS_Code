import { readFile, stat } from "node:fs/promises"
import { basename } from "node:path"

import { RepositoryPathError, resolveRepositoryPath } from "../tools/path-safety.ts"

export const CANONICAL_MARKDOWN_FILES = ["AGENTS.md", "PROJECT.md", "ARCHITECTURE.md", "PLAN.md", "SCRATCHPAD.md", "DECISIONS.md"] as const

export type MarkdownErrorCode = "NOT_FOUND" | "OUTSIDE_WORKSPACE" | "TOO_LARGE" | "SECTION_NOT_FOUND" | "INVALID_LIMIT"

export class MarkdownError extends Error {
  readonly code: MarkdownErrorCode

  constructor(code: MarkdownErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "MarkdownError"
    this.code = code
  }
}

export interface MarkdownFileMetadata {
  readonly name: string
  readonly path: string
  readonly sizeBytes: number
}

export interface MarkdownHeading {
  readonly level: number
  readonly title: string
  readonly line: number
}

export interface MarkdownSearchResult {
  readonly line: number
  readonly text: string
}

function mapPathError(error: unknown): never {
  if (error instanceof RepositoryPathError && (error.code === "NOT_FOUND" || error.code === "OUTSIDE_WORKSPACE")) {
    throw new MarkdownError(error.code, error.message, { cause: error })
  }
  throw error
}

function validatePositiveLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new MarkdownError("INVALID_LIMIT", `${name} must be a positive integer`)
}

export async function discoverCanonicalMarkdown(workspaceRoot: string): Promise<MarkdownFileMetadata[]> {
  const discovered: MarkdownFileMetadata[] = []
  for (const name of CANONICAL_MARKDOWN_FILES) {
    try {
      const path = await resolveRepositoryPath(workspaceRoot, name, "file")
      const details = await stat(path)
      discovered.push({ name, path, sizeBytes: details.size })
    } catch (error) {
      if (error instanceof RepositoryPathError && error.code === "NOT_FOUND") continue
      mapPathError(error)
    }
  }
  return discovered
}

export async function readMarkdownFile(
  workspaceRoot: string,
  requestedPath: string,
  options: { readonly maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? 64 * 1024
  validatePositiveLimit("maxBytes", maxBytes)
  let path: string
  try {
    path = await resolveRepositoryPath(workspaceRoot, requestedPath, "file")
  } catch (error) {
    mapPathError(error)
  }
  if (!basename(path).toLowerCase().endsWith(".md")) throw new MarkdownError("NOT_FOUND", `Not a Markdown file: ${requestedPath}`)
  const details = await stat(path)
  if (details.size > maxBytes) throw new MarkdownError("TOO_LARGE", `Markdown file exceeds ${maxBytes} bytes: ${requestedPath}`)
  return readFile(path, "utf8")
}

export function extractMarkdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  let fenced = false
  const lines = content.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) headings.push({ level: match[1]!.length, title: match[2]!, line: index + 1 })
  }
  return headings
}

export async function readMarkdownSection(
  workspaceRoot: string,
  requestedPath: string,
  heading: string,
  options: { readonly maxBytes?: number } = {},
): Promise<string> {
  const content = await readMarkdownFile(workspaceRoot, requestedPath, options)
  const lines = content.split(/\r?\n/)
  const headings = extractMarkdownHeadings(content)
  const target = headings.find((entry) => entry.title.toLocaleLowerCase() === heading.trim().toLocaleLowerCase())
  if (!target) throw new MarkdownError("SECTION_NOT_FOUND", `Markdown heading not found: ${heading}`)
  const next = headings.find((entry) => entry.line > target.line && entry.level <= target.level)
  return lines.slice(target.line - 1, next ? next.line - 1 : undefined).join("\n").trimEnd()
}

export async function searchMarkdown(
  workspaceRoot: string,
  requestedPath: string,
  keyword: string,
  options: { readonly maxBytes?: number; readonly maxResults?: number } = {},
): Promise<MarkdownSearchResult[]> {
  const maxResults = options.maxResults ?? 50
  validatePositiveLimit("maxResults", maxResults)
  const content = await readMarkdownFile(workspaceRoot, requestedPath, options)
  const needle = keyword.toLocaleLowerCase()
  const results: MarkdownSearchResult[] = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.toLocaleLowerCase().includes(needle)) results.push({ line: index + 1, text: line })
    if (results.length === maxResults) break
  }
  return results
}
