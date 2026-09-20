/**
 * Unicode and UTF-16 surrogate-pair boundary safety helpers — Sprint 3E.1.
 *
 * JavaScript strings use UTF-16 code units. Characters outside the Basic Multilingual
 * Plane (BMP), such as emojis and mathematical symbols, are represented as surrogate
 * pairs: a high surrogate (0xD800–0xDBFF) followed by a low surrogate (0xDC00–0xDFFF).
 *
 * Naive string slicing (e.g. `str.slice(0, maxChars)` or `str.slice(str.length - maxChars)`)
 * can split a surrogate pair in half, leaving isolated surrogates that corrupt text
 * and produce replacement characters (U+FFFD) when encoded.
 *
 * These helpers guarantee that slicing and truncation boundaries never split
 * surrogate pairs.
 */

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Truncate a string from the START, keeping at most `maxChars` characters at the END
 * (right-most portion, used for prefix budgeting).
 *
 * If the cut lands on a low surrogate (whose high surrogate was cut off), advance
 * `start` past the low surrogate so the slice does not begin with an orphaned low surrogate.
 */
export function truncateStartSafe(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  let start = text.length - maxChars
  // If start lands on a low surrogate, its matching high surrogate was truncated off.
  // Advance past the low surrogate to exclude the partial character.
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start++
  }
  return { text: text.slice(start), truncated: true }
}

/**
 * Truncate a string from the END, keeping at most `maxChars` characters at the START
 * (left-most portion, used for suffix budgeting and output capping).
 *
 * If the cut lands immediately after a high surrogate (whose low surrogate would be cut off),
 * back up past the high surrogate so the slice does not end with an orphaned high surrogate.
 */
export function truncateEndSafe(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  let end = maxChars
  // If the character immediately before the cut is a high surrogate,
  // its matching low surrogate would be cut off. Back up past the high surrogate.
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) {
    end--
  }
  return { text: text.slice(0, end), truncated: true }
}

/**
 * Check whether a string contains any isolated (unpaired) surrogate code units.
 */
export function hasIsolatedSurrogates(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (isHighSurrogate(code)) {
      if (i + 1 >= str.length || !isLowSurrogate(str.charCodeAt(i + 1))) {
        return true
      }
      i++ // Skip valid low surrogate
    } else if (isLowSurrogate(code)) {
      return true
    }
  }
  return false
}

/**
 * Clean isolated surrogates from a string, removing any orphaned surrogate code units.
 */
export function cleanIsolatedSurrogates(str: string): string {
  if (!hasIsolatedSurrogates(str)) {
    return str
  }
  let out = ""
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (isHighSurrogate(code)) {
      if (i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) {
        out += str[i]! + str[i + 1]!
        i++
      }
      // Else drop isolated high surrogate
    } else if (isLowSurrogate(code)) {
      // Drop isolated low surrogate
    } else {
      out += str[i]!
    }
  }
  return out
}
