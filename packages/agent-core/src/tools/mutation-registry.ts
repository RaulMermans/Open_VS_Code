import { MutationEngine, type MutationEngineOptions } from "./mutation-engine.ts"
import { type MutationRequest, MutationFailure } from "./mutation-contracts.ts"
import { ToolRegistry, type ToolRegistration } from "./registry.ts"

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

export interface MutationToolDependencies {
  readonly engine: MutationEngine
}

export function createMutationToolRegistrations(deps: MutationToolDependencies): readonly ToolRegistration[] {
  const { engine } = deps

  return [
    {
      definition: {
        name: "apply_patch",
        description: "Modify an existing text file by replacing a specific text occurrence. Provide the exact text to find (search) and its replacement (replace). The search text must appear exactly once in the file.",
        action: "write_file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to the file to modify" },
            search: { type: "string", description: "Exact text to find in the file (must appear exactly once)" },
            replace: { type: "string", description: "Text to replace the search text with" },
          },
          required: ["path", "search", "replace"],
          additionalProperties: false,
        },
      },
      validate: (input) => {
        const record = objectArguments(input, ["path", "search", "replace"])
        const path = requiredString(record, "path")
        const search = requiredString(record, "search")
        const replace = record.replace
        if (typeof replace !== "string") throw new TypeError("replace must be a string")
        return { path, search, replace }
      },
      execute: async (_input, _context) => {
        throw new MutationFailure("INVALID_PATCH", "Mutation tools require two-phase preparation and review")
      },
      prepareForReview: async (input, _context) => {
        const request: MutationRequest = {
          operation: "patch",
          path: input.path as string,
          patch: {
            search: input.search as string,
            replace: input.replace as string,
          },
        }

        const prepared = await engine.preparePatchFull(request)
        let consumed = false

        const content = engine.getPreparedContent(prepared.id)

        return {
          id: prepared.id,
          reviewPayload: {
            id: prepared.id,
            operation: prepared.operation,
            path: prepared.path,
            beforeHash: prepared.baseHash,
            afterHash: prepared.resultHash,
            linesAdded: prepared.diff.linesAdded,
            linesRemoved: prepared.diff.linesRemoved,
            bytesChanged: prepared.diff.bytesChanged,
            diff: prepared.diff.unified,
            truncated: prepared.diff.truncated,
            beforeContent: content?.before ?? "",
            proposedContent: content?.after ?? "",
          },
          apply: async () => {
            if (consumed) throw new MutationFailure("INVALID_PATCH", "already consumed")
            consumed = true
            return engine.applyPreparedMutation(prepared)
          }
        }
      },
    },
    {
      definition: {
        name: "create_file",
        description: "Create a new text file. The file must not already exist. Provide the workspace-relative path and the complete file content.",
        action: "write_file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path for the new file" },
            content: { type: "string", description: "Complete content for the new file" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      validate: (input) => {
        const record = objectArguments(input, ["path", "content"])
        const path = requiredString(record, "path")
        const content = record.content
        if (typeof content !== "string") throw new TypeError("content must be a string")
        return { path, content }
      },
      execute: async (_input, _context) => {
        throw new MutationFailure("INVALID_PATCH", "Mutation tools require two-phase preparation and review")
      },
      prepareForReview: async (input, _context) => {
        const request: MutationRequest = {
          operation: "create",
          path: input.path as string,
          content: input.content as string,
        }

        const prepared = await engine.prepareCreateFull(request)
        let consumed = false
        
        const content = engine.getPreparedContent(prepared.id)

        return {
          id: prepared.id,
          reviewPayload: {
            id: prepared.id,
            operation: prepared.operation,
            path: prepared.path,
            beforeHash: prepared.baseHash,
            afterHash: prepared.resultHash,
            linesAdded: prepared.diff.linesAdded,
            linesRemoved: prepared.diff.linesRemoved,
            bytesChanged: prepared.diff.bytesChanged,
            diff: prepared.diff.unified,
            truncated: prepared.diff.truncated,
            beforeContent: "",
            proposedContent: content?.after ?? "",
          },
          apply: async () => {
            if (consumed) throw new MutationFailure("INVALID_PATCH", "already consumed")
            consumed = true
            return engine.applyPreparedMutation(prepared)
          }
        }
      },
    },
  ]
}

export function createMutationToolRegistry(options?: MutationEngineOptions & { workspaceRoot: string }): { registry: ToolRegistry; engine: MutationEngine } {
  const workspaceRoot = options?.workspaceRoot ?? process.cwd()
  const engine = new MutationEngine(workspaceRoot, options)
  const registrations = createMutationToolRegistrations({ engine })
  const registry = new ToolRegistry(registrations)
  return { registry, engine }
}
