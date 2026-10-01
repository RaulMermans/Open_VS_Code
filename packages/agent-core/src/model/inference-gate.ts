/**
 * Inference Host Authorization Gate — Sprint 4E.
 *
 * Real inference against local open-weight models is ONLY allowed on an
 * explicitly designated host. This file provides the gate that MUST be
 * checked before any operation that would:
 *   - invoke a real local model endpoint
 *   - pull/download model weights
 *   - run real benchmark measurements
 *
 * Authorization requires:
 *   1. OPEN_VS_CODE_REAL_INFERENCE=1 in process environment
 *
 * Default: DISABLED — real inference never runs unless explicitly authorized.
 *
 * This gate does NOT infer authorization from the existence of Ollama/vLLM.
 */

export interface InferenceGateState {
  readonly authorized: boolean
  readonly reason: string
  readonly endpoint: string | undefined
}

/**
 * Check whether this execution environment is authorized for real local inference.
 *
 * Never throws. Always returns a gate state.
 */
export function checkInferenceGate(): InferenceGateState {
  const authorized = process.env["OPEN_VS_CODE_REAL_INFERENCE"] === "1"
  if (!authorized) {
    return {
      authorized: false,
      reason: "OPEN_VS_CODE_REAL_INFERENCE is not set to '1'. Real inference is disabled on this host.",
      endpoint: undefined,
    }
  }
  const endpoint = process.env["OPEN_VS_CODE_MODEL_ENDPOINT"] ?? undefined
  return {
    authorized: true,
    reason: "Authorized: OPEN_VS_CODE_REAL_INFERENCE=1",
    endpoint,
  }
}

export class InferenceNotAuthorizedError extends Error {
  readonly code = "INFERENCE_NOT_AUTHORIZED"

  constructor(message?: string) {
    super(
      message ??
      "[InferenceGate] Real inference is disabled. Set OPEN_VS_CODE_REAL_INFERENCE=1 to authorize local model inference."
    )
    this.name = "InferenceNotAuthorizedError"
  }
}

/**
 * Assert that inference is authorized.
 * In production (when using global fetch), OPEN_VS_CODE_REAL_INFERENCE=1 is strictly required.
 * In deterministic test suites with an injected mock fetch, authorization is bypassed to permit testing.
 */
export function assertInferenceAuthorized(isCustomFetch?: boolean): InferenceGateState {
  if (isCustomFetch) {
    return {
      authorized: true,
      reason: "Test seam: custom fetch mock provided",
      endpoint: undefined,
    }
  }

  const state = checkInferenceGate()
  if (!state.authorized) {
    throw new InferenceNotAuthorizedError(
      `[InferenceGate] ${state.reason}\n` +
      `To enable real inference on this host: export OPEN_VS_CODE_REAL_INFERENCE=1`
    )
  }
  return state
}

/**
 * Assert the inference gate is open. Throws with a clear message if not authorized.
 * Use in benchmark harnesses and real model runners before any inference.
 */
export function requireInferenceGate(): InferenceGateState {
  const state = checkInferenceGate()
  if (!state.authorized) {
    throw new InferenceNotAuthorizedError(
      `[InferenceGate] ${state.reason}\n` +
      `To enable real inference on this host: export OPEN_VS_CODE_REAL_INFERENCE=1`
    )
  }
  return state
}

/**
 * Returns a safe BLOCKED_WITH_EVIDENCE message when real inference is not authorized.
 * Used by benchmark CLI to exit gracefully without faking results.
 */
export function inferenceGateBlockedMessage(): string {
  return [
    "BLOCKED_WITH_EVIDENCE",
    "",
    "Real inference is not authorized on this host.",
    "To authorize: export OPEN_VS_CODE_REAL_INFERENCE=1",
    "Ensure a real local model endpoint is running and configured.",
    "",
    "This is not a failure of the implementation — it is the correct behavior",
    "when the designated inference host is not available.",
  ].join("\n")
}
