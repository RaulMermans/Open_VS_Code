export interface ObservationProvenance {
  readonly kind: "tool"
  readonly paths: readonly string[]
}

export interface ToolObservation {
  readonly toolName: string
  readonly callId: string
  readonly ok: boolean
  readonly content: string
  readonly truncated: boolean
  readonly provenance: ObservationProvenance
  readonly errorCategory?: string
}

export interface ToolObservationInput {
  readonly toolName: string
  readonly callId: string
  readonly output?: unknown
  readonly error?: { readonly category: string; readonly message: string }
  readonly maxContentBytes?: number
}

function collectPaths(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 3 || paths.size >= 20 || !value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, depth + 1)
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "path" && typeof nested === "string") paths.add(nested)
    else if (key === "paths" && Array.isArray(nested)) {
      for (const path of nested) if (typeof path === "string" && paths.size < 20) paths.add(path)
    } else collectPaths(nested, paths, depth + 1)
  }
}

function truncateUtf8(content: string, maxBytes: number): { content: string; truncated: boolean } {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxContentBytes must be a positive integer")
  if (Buffer.byteLength(content) <= maxBytes) return { content, truncated: false }
  let bounded = ""
  let bytes = 0
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    bounded += character
    bytes += characterBytes
  }
  return { content: bounded, truncated: true }
}

export function createToolObservation(input: ToolObservationInput): ToolObservation {
  const paths = new Set<string>()
  collectPaths(input.output, paths)
  const rawContent = input.error
    ? input.error.message
    : typeof input.output === "string"
      ? input.output
      : JSON.stringify(input.output ?? null)
  const bounded = truncateUtf8(rawContent, input.maxContentBytes ?? 16 * 1024)
  return {
    toolName: input.toolName,
    callId: input.callId,
    ok: !input.error,
    content: bounded.content,
    truncated: bounded.truncated,
    provenance: { kind: "tool", paths: [...paths].toSorted() },
    ...(input.error ? { errorCategory: input.error.category } : {}),
  }
}
