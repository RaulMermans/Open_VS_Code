import type { ToolCall, ToolDefinition } from "../contracts/tools.ts"

export interface ToolExecutionContext {
  readonly workspaceRoot: string
  readonly signal: AbortSignal
  readonly onOutput?: ((chunk: { stream: "stdout" | "stderr"; chunk: string }) => void) | undefined
}

export interface ReviewableExecution {
  readonly id: string
  readonly reviewPayload: Readonly<Record<string, unknown>>
  apply(context: ToolExecutionContext): Promise<unknown>
}

export interface ToolRegistration {
  readonly definition: ToolDefinition
  readonly validate: (input: unknown) => Readonly<Record<string, unknown>>
  readonly prepareForReview?: (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<ReviewableExecution>
  readonly execute: (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => Promise<unknown>
}

export interface PreparedToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly definition: ToolDefinition
  readonly prepareForReview?: (context: ToolExecutionContext) => Promise<ReviewableExecution>
  invoke(context: ToolExecutionContext): Promise<unknown>
}

export type ToolRegistryErrorCode = "DUPLICATE_TOOL" | "UNKNOWN_TOOL" | "INVALID_ARGUMENTS" | "INVALID_DEFINITION" | "MALFORMED_TOOL_CALL"

export class ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode

  constructor(code: ToolRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ToolRegistryError"
    this.code = code
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Tool call cancelled", "AbortError")
}

export class ToolRegistry {
  readonly #registrations = new Map<string, ToolRegistration>()

  constructor(registrations: readonly ToolRegistration[] = []) {
    for (const registration of registrations) this.register(registration)
  }

  register(registration: ToolRegistration): void {
    const name = registration.definition.name
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new ToolRegistryError("INVALID_DEFINITION", `Invalid tool name: ${name}`)
    if (!registration.definition.description.trim()) throw new ToolRegistryError("INVALID_DEFINITION", `Tool ${name} requires a description`)
    if (this.#registrations.has(name)) throw new ToolRegistryError("DUPLICATE_TOOL", `Tool is already registered: ${name}`)
    this.#registrations.set(name, registration)
  }

  /**
   * A new registry holding only the tools whose action is in `actions`. Narrowing only: it never adds
   * a tool, and the PermissionGate still decides every call on the restricted registry.
   */
  restrict(actions: ReadonlySet<ToolDefinition["action"]>): ToolRegistry {
    return new ToolRegistry([...this.#registrations.values()].filter((registration) => actions.has(registration.definition.action)))
  }

  listDefinitions(): readonly ToolDefinition[] {
    return [...this.#registrations.values()]
      .map((registration) => registration.definition)
      .toSorted((left, right) => left.name.localeCompare(right.name))
  }

  getDefinition(name: string): ToolDefinition {
    const registration = this.#registrations.get(name)
    if (!registration) throw new ToolRegistryError("UNKNOWN_TOOL", `Unknown tool: ${name}`)
    return registration.definition
  }

  prepare(call: ToolCall | unknown): PreparedToolCall {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new ToolRegistryError("MALFORMED_TOOL_CALL", "Tool call must be an object")
    }
    const candidate = call as Partial<ToolCall>
    if (typeof candidate.id !== "string" || !candidate.id.trim() || typeof candidate.name !== "string" || !candidate.name.trim()) {
      throw new ToolRegistryError("MALFORMED_TOOL_CALL", "Tool call requires non-empty string id and name")
    }
    const registration = this.#registrations.get(candidate.name)
    if (!registration) throw new ToolRegistryError("UNKNOWN_TOOL", `Unknown tool: ${candidate.name}`)
    let validated: Readonly<Record<string, unknown>>
    try {
      validated = registration.validate(candidate.arguments)
    } catch (error) {
      const message = error instanceof Error ? error.message : "arguments did not match the schema"
      throw new ToolRegistryError("INVALID_ARGUMENTS", `Invalid arguments for ${candidate.name}: ${message}`, { cause: error })
    }
    return {
      id: candidate.id,
      name: candidate.name,
      arguments: validated,
      definition: registration.definition,
      invoke: async (context) => {
        throwIfAborted(context.signal)
        const result = await registration.execute(validated, context)
        throwIfAborted(context.signal)
        return result
      },
      ...(registration.prepareForReview ? {
        prepareForReview: async (context) => {
          throwIfAborted(context.signal)
          const reviewable = await registration.prepareForReview!(validated, context)
          throwIfAborted(context.signal)
          return reviewable
        }
      } : {}),
    }
  }
}
