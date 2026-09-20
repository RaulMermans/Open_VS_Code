/**
 * Autocomplete output sanitizer — Sprint 3E.
 *
 * Deterministic, minimal post-processing of provider output.
 * Does NOT aggressively rewrite legitimate code.
 *
 * Rules applied in order:
 *   1. Hard character ceiling (MAX_OUTPUT_CHARS)
 *   2. Code-fence stripping (``` … ```)
 *   3. Exact prefix-echo removal (provider repeated the prefix tail)
 *   4. Exact suffix-overlap removal (provider repeated the suffix head)
 *   5. Trim trailing whitespace-only lines
 *   6. Return empty string for whitespace-only result
 */

import { MAX_OUTPUT_CHARS } from "./budget.ts"

/**
 * Maximum exact-overlap suffix to check for prefix-echo and suffix-overlap.
 * Keeps the check O(k) rather than O(n²).
 */
const MAX_OVERLAP_CHECK = 256

/**
 * Strip a simple Markdown code fence if present.
 * Handles:
 *   ```typescript\n...\n```
 *   ```\n...\n```
 *
 * Does NOT build a Markdown parser.  Only strips when the entire content is
 * wrapped in a single fence pair.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return text

  // Find the closing fence
  const openEnd = trimmed.indexOf("\n")
  if (openEnd === -1) {
    // Single-line ```word — strip ticks but it's probably malformed
    return trimmed.replace(/^```\w*\s*/, "").replace(/```\s*$/, "")
  }

  const afterOpen = trimmed.slice(openEnd + 1)
  const closeStart = afterOpen.lastIndexOf("\n```")
  if (closeStart === -1) {
    // No closing fence — don't mutate
    return text
  }

  return afterOpen.slice(0, closeStart)
}

/**
 * Remove an exact prefix-echo.
 *
 * Some providers repeat the tail of the prefix before their new completion.
 * We check whether the BEGINNING of the generated text exactly equals
 * the TAIL of the prefix, up to MAX_OVERLAP_CHECK characters.
 *
 * We only remove a proven exact match — no fuzzy rewriting.
 */
function removePrefixEcho(generated: string, prefix: string): string {
  const checkLen = Math.min(MAX_OVERLAP_CHECK, prefix.length, generated.length)
  for (let len = checkLen; len > 0; len--) {
    const prefixTail = prefix.slice(prefix.length - len)
    if (generated.startsWith(prefixTail)) {
      return generated.slice(len)
    }
  }
  return generated
}

/**
 * Remove exact suffix overlap.
 *
 * If the generated text ends with the beginning of the existing suffix, trim
 * that duplicate.
 *
 * Example:
 *   suffix   = ");\n"
 *   generated = "foo();\n"
 *
 * → final: "foo"  (the ");\n" tail is already in the buffer)
 */
function removeSuffixOverlap(generated: string, suffix: string): string {
  if (!suffix) return generated
  const checkLen = Math.min(MAX_OVERLAP_CHECK, suffix.length, generated.length)
  for (let len = checkLen; len > 0; len--) {
    const suffixHead = suffix.slice(0, len)
    if (generated.endsWith(suffixHead)) {
      return generated.slice(0, generated.length - len)
    }
  }
  return generated
}

/**
 * Remove trailing lines that are whitespace-only.
 * Preserves meaningful trailing newlines (e.g. after a closing brace).
 */
function trimTrailingBlankLines(text: string): string {
  // Split, drop purely blank trailing lines, rejoin
  const lines = text.split("\n")
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === "") {
    end--
  }
  if (end === lines.length) return text
  return lines.slice(0, end).join("\n")
}

/**
 * Sanitize autocomplete provider output.
 *
 * @param raw      Raw text from the provider.
 * @param prefix   The prefix that was sent to the provider (for echo removal).
 * @param suffix   The suffix that was sent to the provider (for overlap removal).
 * @returns        Sanitized text ready for insertion, or empty string.
 */
export function sanitizeCompletion(raw: string, prefix: string, suffix: string): string {
  if (!raw) return ""

  // 1. Hard character ceiling
  let text = raw.length > MAX_OUTPUT_CHARS ? raw.slice(0, MAX_OUTPUT_CHARS) : raw

  // 2. Code-fence stripping
  text = stripCodeFence(text)

  // 3. Prefix-echo removal
  text = removePrefixEcho(text, prefix)

  // 4. Suffix-overlap removal
  text = removeSuffixOverlap(text, suffix)

  // 5. Trim trailing blank lines
  text = trimTrailingBlankLines(text)

  // 6. Empty/whitespace guard
  if (!text || /^\s*$/.test(text)) return ""

  return text
}
