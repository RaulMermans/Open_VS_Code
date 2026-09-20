/**
 * AutocompleteContextBuilder — Sprint 3E.
 *
 * Captures editor-local context for one autocomplete request.  This class
 * deliberately has no access to:
 *   - AgentRunner
 *   - ProjectMemory
 *   - Skills
 *   - MCP
 *   - filesystem reads (context comes from the live editor buffer only)
 *   - session / conversation history
 *
 * Inputs are raw editor state values (strings, numbers).  The builder is
 * testable without any VS Code APIs.
 */

import {
  PREFIX_CHAR_CEILING,
  SUFFIX_CHAR_CEILING,
  TOTAL_CHAR_CEILING,
  SENSITIVE_FILE_PATTERNS,
  MIN_PREFIX_NON_WS_CHARS,
  estimateTokensFromChars,
} from "./budget.ts"

/**
 * Raw input from the live editor buffer.
 * All strings are the unsaved editor content — NOT re-read from disk.
 */
export interface EditorSnapshot {
  /** Text from document start to cursor (unsaved buffer). */
  readonly rawPrefix: string
  /** Text from cursor to document end (unsaved buffer). */
  readonly rawSuffix: string
  /** VS Code languageId, e.g. "typescript" */
  readonly languageId: string
  /** Workspace-relative path (never absolute). */
  readonly relativePath: string
  /** Document version at time of snapshot (for stale-result rejection). */
  readonly documentVersion: number
  /** Cursor position for stale-result rejection. */
  readonly cursorLine: number
  readonly cursorCharacter: number
}

/**
 * Result of context building — ready to attach to AutocompleteRequest.
 */
export interface BuiltContext {
  /** Token-budgeted prefix, keeping the NEWEST (right-most) portion. */
  readonly prefix: string
  /** Token-budgeted suffix, keeping the EARLIEST (left-most) portion. */
  readonly suffix: string
  /** Workspace-relative path (sanitized). */
  readonly relativePath: string
  readonly languageId: string
  /** True when the prefix was truncated to fit the budget. */
  readonly prefixTruncated: boolean
  /** True when the suffix was truncated to fit the budget. */
  readonly suffixTruncated: boolean
  /** Estimated token count for the combined prefix + suffix. */
  readonly estimatedTokens: number
}

/**
 * Reason a context build was rejected before reaching the provider.
 */
export type ContextSkipReason =
  | "sensitive_file"
  | "empty_prefix"
  | "unsupported_language"

export type ContextResult =
  | { ok: true; context: BuiltContext }
  | { ok: false; reason: ContextSkipReason }

/**
 * Languages where autocomplete is actively meaningful in V1.
 *
 * This is intentionally minimal.  Expand incrementally as real provider
 * quality is validated.
 */
const SUPPORTED_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "markdown",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "shellscript",
  "bash",
  "sh",
  "plaintext",
])

/**
 * Trim prefix to budget, keeping the NEWEST (right-most) characters.
 * Avoids splitting inside a Unicode surrogate pair at the trim boundary.
 */
function budgetPrefix(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= PREFIX_CHAR_CEILING) {
    return { text: raw, truncated: false }
  }
  // Keep right-most portion
  let start = raw.length - PREFIX_CHAR_CEILING
  // Advance past any high-surrogate at the boundary
  while (start < raw.length && isHighSurrogate(raw.charCodeAt(start))) {
    start++
  }
  return { text: raw.slice(start), truncated: true }
}

/**
 * Trim suffix to budget, keeping the EARLIEST (left-most) characters.
 * Avoids splitting inside a Unicode surrogate pair at the trim boundary.
 */
function budgetSuffix(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= SUFFIX_CHAR_CEILING) {
    return { text: raw, truncated: false }
  }
  let end = SUFFIX_CHAR_CEILING
  // Back up past any high-surrogate at the boundary
  while (end > 0 && isHighSurrogate(raw.charCodeAt(end - 1))) {
    end--
  }
  return { text: raw.slice(0, end), truncated: true }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Check whether a relative path matches a sensitive file pattern.
 */
function isSensitivePath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase()
  return SENSITIVE_FILE_PATTERNS.some(re => re.test(lower))
}

/**
 * Check whether the prefix has enough non-whitespace content to be meaningful.
 */
function hasMeaningfulContent(prefix: string): boolean {
  let nonWs = 0
  for (const ch of prefix) {
    if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
      nonWs++
      if (nonWs >= MIN_PREFIX_NON_WS_CHARS) return true
    }
  }
  return false
}

/**
 * Build bounded, sanitized autocomplete context from a live editor snapshot.
 *
 * This function has no I/O — it operates purely on the supplied strings.
 * Tests can call it directly without any VS Code or filesystem dependency.
 */
export function buildAutocompleteContext(snapshot: EditorSnapshot): ContextResult {
  // 1. Sensitive file guard
  if (isSensitivePath(snapshot.relativePath)) {
    return { ok: false, reason: "sensitive_file" }
  }

  // 2. Language support guard
  if (!SUPPORTED_LANGUAGES.has(snapshot.languageId)) {
    return { ok: false, reason: "unsupported_language" }
  }

  // 3. Minimum meaningful prefix guard
  if (!hasMeaningfulContent(snapshot.rawPrefix)) {
    return { ok: false, reason: "empty_prefix" }
  }

  // 4. Budget prefix and suffix independently
  const { text: prefix, truncated: prefixTruncated } = budgetPrefix(snapshot.rawPrefix)
  const { text: suffix, truncated: suffixTruncated } = budgetSuffix(snapshot.rawSuffix)

  // 5. Enforce total ceiling
  //    If combined length still exceeds total ceiling (e.g. suffix budget could
  //    be adjusted later), trim the suffix further.
  let finalSuffix = suffix
  let finalSuffixTruncated = suffixTruncated
  if (prefix.length + suffix.length > TOTAL_CHAR_CEILING) {
    const remainingForSuffix = Math.max(0, TOTAL_CHAR_CEILING - prefix.length)
    finalSuffix = suffix.slice(0, remainingForSuffix)
    finalSuffixTruncated = true
  }

  const estimatedToks = estimateTokensFromChars(prefix.length + finalSuffix.length)

  return {
    ok: true,
    context: {
      prefix,
      suffix: finalSuffix,
      relativePath: snapshot.relativePath,
      languageId: snapshot.languageId,
      prefixTruncated,
      suffixTruncated: finalSuffixTruncated,
      estimatedTokens: estimatedToks,
    },
  }
}
