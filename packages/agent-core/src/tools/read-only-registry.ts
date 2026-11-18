import { findFiles } from "./find-files.ts"
import { listDirectory } from "./list-directory.ts"
import { readRepositoryFile } from "./read-file.ts"
import { ToolRegistry, type ToolRegistration } from "./registry.ts"
import { searchText } from "./search-text.ts"

function objectArguments(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("arguments must be an object")
  const record = input as Record<string, unknown>
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key))
  if (unexpected) throw new TypeError(`unexpected argument: ${unexpected}`)
  return record
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name]
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

/** Lines returned by one read_file call when no range is given. */
export const READ_WINDOW_LINES = 250

const registrations: readonly ToolRegistration[] = [
  {
    definition: {
      name: "read_file",
      description: `Read a repository text file, ${READ_WINDOW_LINES} lines at a time. Use startLine to read further.`,
      action: "read_repository",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1, description: "First line to read (1-based), e.g. a line a search result points to." },
          endLine: { type: "integer", minimum: 1, description: "Last line to read. Defaults to startLine + 249." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    validate: (input) => {
      const record = objectArguments(input, ["path", "startLine", "endLine"])
      const line = (name: string): number | undefined => {
        const value = record[name]
        if (value === undefined || value === null) return undefined
        const number = typeof value === "string" ? Number(value) : value
        if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new TypeError(`${name} must be a positive integer`)
        return number
      }
      const startLine = line("startLine")
      const endLine = line("endLine")
      return { path: requiredString(record, "path"), ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) }
    },
    // Bounded windows (SWE-agent style): a long file is never silently cut off mid-way by the observation limit.
    execute: async (input, context) => {
      const startLine = (input.startLine as number | undefined) ?? 1
      const endLine = Math.max(startLine, (input.endLine as number | undefined) ?? startLine + READ_WINDOW_LINES - 1)
      try {
        // Files within the read limit are read whole so the window can report the total line count.
        const whole = await readRepositoryFile(context.workspaceRoot, input.path as string, { maxBytes: 64 * 1024 })
        const lines = whole.content.split("\n")
        const totalLines = whole.content.endsWith("\n") ? lines.length - 1 : lines.length
        if (startLine === 1 && endLine >= totalLines) return { ...whole, totalLines }
        const last = Math.min(endLine, totalLines)
        const content = startLine > totalLines ? "" : lines.slice(startLine - 1, last).join("\n")
        return { ...whole, content, returnedBytes: Buffer.byteLength(content, "utf8"), startLine, endLine: Math.max(startLine - 1, last), totalLines }
      } catch (error) {
        if (!(error instanceof Error) || !/exceeds/.test(error.message)) throw error
        return readRepositoryFile(context.workspaceRoot, input.path as string, { maxBytes: 64 * 1024, startLine, endLine })
      }
    },
  },
  {
    definition: {
      name: "list_directory",
      description: "List one directory (not recursive, up to 100 entries); says when the list is incomplete.",
      action: "read_repository",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
    },
    validate: (input) => {
      const record = objectArguments(input, ["path"])
      const path = optionalString(record, "path")
      return path ? { path } : {}
    },
    execute: (input, context) => listDirectory(context.workspaceRoot, input.path as string | undefined, { maxEntries: 100 }),
  },
  {
    definition: {
      name: "search_text",
      description: "Search file contents for literal text (up to 50 path:line matches); says if incomplete.",
      action: "search_repository",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, rootPath: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
    validate: (input) => {
      const record = objectArguments(input, ["query", "rootPath"])
      const query = requiredString(record, "query")
      const rootPath = optionalString(record, "rootPath")
      return rootPath ? { query, rootPath } : { query }
    },
    execute: (input, context) => searchText(context.workspaceRoot, input.query as string, {
      ...(input.rootPath ? { rootPath: input.rootPath as string } : {}),
      maxResults: 50,
      maxOutputBytes: 32 * 1024,
      maxFileBytes: 256 * 1024,
      maxLineLength: 300,
    }),
  },
  {
    definition: {
      name: "find_files",
      description: "Find files by glob, e.g. src/**/*.ts (up to 200 paths); says if the list is incomplete.",
      action: "search_repository",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, rootPath: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    validate: (input) => {
      const record = objectArguments(input, ["pattern", "rootPath"])
      const pattern = requiredString(record, "pattern")
      const rootPath = optionalString(record, "rootPath")
      return rootPath ? { pattern, rootPath } : { pattern }
    },
    execute: (input, context) => findFiles(context.workspaceRoot, input.pattern as string, {
      ...(input.rootPath ? { rootPath: input.rootPath as string } : {}),
      maxResults: 200,
    }),
  },
]

export function createReadOnlyToolRegistry(): ToolRegistry {
  return new ToolRegistry(registrations)
}
