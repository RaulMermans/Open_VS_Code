/**
 * Context budget constants for autocomplete — Sprint 3E.
 *
 * These are VERY small compared to agent context budgets.  Autocomplete runs
 * on every keystroke and must have bounded, predictable overhead.
 *
 * Token estimation uses the existing 4-chars-per-token approximation from the
 * agent-core ContextBudget.  We also maintain byte ceilings as a secondary
 * safety net.
 *
 * All constants are exported so tests can assert exact boundary behaviour.
 */

/** chars-per-token estimate — matches agent-core convention */
export const CHARS_PER_TOKEN = 4

/**
 * Prefix token budget (text left of cursor).
 * Keep the NEWEST (right-most) portion when truncating.
 *
 * Target: ~2,000 tokens → 8,000 chars
 */
export const PREFIX_TOKEN_BUDGET = 2_000
export const PREFIX_CHAR_CEILING = PREFIX_TOKEN_BUDGET * CHARS_PER_TOKEN   // 8_000

/**
 * Suffix token budget (text right of cursor).
 * Keep the EARLIEST (left-most) portion when truncating.
 *
 * Target: ~1,000 tokens → 4,000 chars
 */
export const SUFFIX_TOKEN_BUDGET = 1_000
export const SUFFIX_CHAR_CEILING = SUFFIX_TOKEN_BUDGET * CHARS_PER_TOKEN   // 4_000

/**
 * Hard total context ceiling (prefix + suffix estimate).
 * Secondary safety net expressed in characters.
 *
 * Target: ~3,500 tokens → 14,000 chars
 */
export const TOTAL_TOKEN_BUDGET = 3_500
export const TOTAL_CHAR_CEILING = TOTAL_TOKEN_BUDGET * CHARS_PER_TOKEN     // 14_000

/**
 * Maximum generated tokens per autocomplete response.
 * Autocomplete should not generate entire files.
 *
 * Target: 256 tokens.
 */
export const MAX_OUTPUT_TOKENS = 256

/**
 * Hard character ceiling on generated completion text.
 * Complements the token limit.
 *
 * Target: 256 tokens × 4 chars = 1,024 chars.
 */
export const MAX_OUTPUT_CHARS = MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN        // 1_024

/**
 * Debounce delay in milliseconds.
 * A new trigger within this window cancels the previous pending request.
 *
 * Target: 100 ms.
 */
export const DEBOUNCE_MS = 100

/**
 * Provider inference timeout.
 * If the provider does not respond within this window, the request is
 * aborted.  Local FIM models should be much faster; this is a conservative
 * upper bound.
 *
 * Target: 3,000 ms.
 */
export const INFERENCE_TIMEOUT_MS = 3_000

/**
 * Minimum meaningful prefix length.
 * Requests with a whitespace-only or very short prefix are skipped to avoid
 * pointless inference on empty new documents.
 *
 * Target: 3 non-whitespace characters.
 */
export const MIN_PREFIX_NON_WS_CHARS = 3

/**
 * Maximum bounded recent-request registry size for acceptance telemetry.
 * Beyond this limit, the oldest entries are dropped.
 */
export const MAX_ACCEPTANCE_REGISTRY_SIZE = 50

/**
 * Sensitive file patterns that must be skipped.
 * Autocomplete must not run on credential files.
 */
export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /\.(env)$/i,
  /\.env\./i,
  /\.(pem|key|p12|pfx|crt|cert|der)$/i,
  /\.(jks|keystore)$/i,
  // SSH private key filenames (id_rsa, id_ed25519, id_ecdsa, id_dsa, etc.)
  /\bid_[a-z0-9]+$/i,
  // credentials files
  /^credentials$/i,
]

/**
 * Estimate tokens from a character count.
 * Matches agent-core convention (ceiling of chars / 4).
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
