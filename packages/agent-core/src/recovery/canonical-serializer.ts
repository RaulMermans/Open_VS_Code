/**
 * Canonical JSON Serializer
 * Sprint 4C.1 — Stable, recursive canonical JSON serialization for checkpoint checksums and operation intent hashing.
 * Deterministically sorts object keys, preserves array order and primitives, and rejects unsupported values.
 */

export class CanonicalSerializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CanonicalSerializationError"
  }
}

export function canonicalSerialize(value: unknown): string {
  const seen = new WeakSet<object>()

  function serialize(val: unknown): string {
    if (val === null) return "null"
    if (val === undefined) return "null" // in arrays/objects where undefined is evaluated

    const t = typeof val
    if (t === "boolean" || t === "number") {
      if (typeof val === "number" && (!Number.isFinite(val) || Number.isNaN(val))) {
        throw new CanonicalSerializationError(`Cannot canonically serialize non-finite number: ${val}`)
      }
      return JSON.stringify(val)
    }

    if (t === "string") {
      return JSON.stringify(val)
    }

    if (t === "bigint") {
      throw new CanonicalSerializationError("Cannot canonically serialize BigInt")
    }

    if (t === "symbol" || t === "function") {
      throw new CanonicalSerializationError(`Cannot canonically serialize type: ${t}`)
    }

    if (t === "object") {
      if (seen.has(val as object)) {
        throw new CanonicalSerializationError("Circular reference detected in canonical serialization")
      }
      seen.add(val as object)

      try {
        if (Array.isArray(val)) {
          const items = val.map((item) => (item === undefined ? "null" : serialize(item)))
          return `[${items.join(",")}]`
        }

        // Plain object or Record
        const obj = val as Record<string, unknown>
        const sortedKeys = Object.keys(obj).toSorted()
        const entries: string[] = []

        for (const key of sortedKeys) {
          const propVal = obj[key]
          if (propVal === undefined || typeof propVal === "symbol" || typeof propVal === "function") {
            continue
          }
          entries.push(`${JSON.stringify(key)}:${serialize(propVal)}`)
        }

        return `{${entries.join(",")}}`
      } finally {
        seen.delete(val as object)
      }
    }

    throw new CanonicalSerializationError(`Unsupported serialization type: ${t}`)
  }

  return serialize(value)
}
