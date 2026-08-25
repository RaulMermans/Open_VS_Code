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

const registrations: readonly ToolRegistration[] = [
  {
    definition: {
      name: "read_file",
      description: "Read one known repository text file.",
      action: "read_repository",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    },
    validate: (input) => {
      const record = objectArguments(input, ["path"])
      return { path: requiredString(record, "path") }
    },
    execute: (input, context) => readRepositoryFile(context.workspaceRoot, input.path as string, { maxBytes: 64 * 1024 }),
  },
  {
    definition: {
      name: "list_directory",
      description: "List entries in one repository directory.",
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
      description: "Search text across repository files.",
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
      description: "Find repository files by glob pattern.",
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
