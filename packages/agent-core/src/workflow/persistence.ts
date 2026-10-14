/**
 * Workflow persistence boundary (Sprint 5B closure, ADR-030/031). Every WorkflowState is passed
 * through `sanitizeWorkflowState` before any store sees it, whatever the store implementation.
 *
 * It reuses the canonical secret redactor (`redactRuntimeEvalSecrets`) rather than a second
 * scanner, strips reasoning blocks, and bounds every string. Structure, hashes, counts and ids are
 * kept, so a restored workflow can resume and be debugged; secret values are never written.
 */
import { redactRuntimeEvalSecrets } from "../runtime-evals/evidence.ts"
import type { WorkflowState } from "./contracts.ts"

/** Upper bound for any single persisted string (artifact-specific bounds are tighter). */
export const MAX_PERSISTED_STRING_CHARS = 12_000
const MAX_DEPTH = 12

/** Keys whose values are hashes, ids or enums: hashing must never be disturbed by redaction. */
const STRUCTURAL_KEYS = new Set(["beforeHash", "afterHash", "baselineHash", "currentHash", "fingerprint", "workflowId", "taskId", "schemaVersion", "createdAt", "updatedAt", "startedAt", "endedAt", "timestamp"])

export function sanitizePersistedText(text: string): string {
  const stripped = text.replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "[reasoning removed]")
  const redacted = redactRuntimeEvalSecrets(stripped)
  return redacted.length <= MAX_PERSISTED_STRING_CHARS ? redacted : `${redacted.slice(0, MAX_PERSISTED_STRING_CHARS - 1)}…`
}

function sanitizeValue(value: unknown, depth: number, key?: string): unknown {
  if (typeof value === "string") return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : sanitizePersistedText(value)
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === "__proto__" || entryKey === "constructor" || entryKey === "prototype") continue
    out[entryKey] = sanitizeValue(entryValue, depth + 1, entryKey)
  }
  return out
}

/** Returns a redacted, bounded copy of the state for persistence. The in-memory state is unchanged. */
export function sanitizeWorkflowState(state: WorkflowState): WorkflowState {
  return sanitizeValue(state, 0) as WorkflowState
}
