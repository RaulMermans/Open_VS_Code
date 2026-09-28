/**
 * UTF-8 Byte Bounds, Streaming Range Reads & Unicode Safety Test Suite
 * Sprint 4D.2 — Tasks T-6208 through T-6218
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"

import {
  truncateUtf8ToBytes,
  readRepositoryFile,
} from "../../src/tools/read-file.ts"

function hasIsolatedSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: next MUST be low surrogate
      if (i + 1 >= str.length) return true
      const next = str.charCodeAt(i + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      i++ // Skip low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Unpaired low surrogate
      return true
    }
  }
  return false
}

describe("Sprint 4D.2/4D.3 — UTF-8 Byte Bounds & Streaming Range Reads (T-6208 .. T-6218, T-6305 .. T-6308)", () => {
  // -------------------------------------------------------------------------
  // T-6208 / T-6210: truncateUtf8ToBytes with ASCII, Accented, CJK, Emoji
  // -------------------------------------------------------------------------
  test("T-6208 / T-6210: truncateUtf8ToBytes enforces true byte ceiling, never string.length", () => {
    // ASCII
    const ascii = truncateUtf8ToBytes("Hello world", 5)
    assert.equal(ascii.text, "Hello")
    assert.equal(ascii.bytes, 5)
    assert.equal(ascii.truncated, true)

    // Accented text: 'é' is 2 UTF-8 bytes, length 1
    assert.equal("é".length, 1)
    assert.equal(Buffer.byteLength("é", "utf8"), 2)

    const acc1 = truncateUtf8ToBytes("café", 3)
    assert.equal(acc1.text, "caf")
    assert.equal(acc1.bytes, 3)
    assert.equal(acc1.truncated, true)

    const acc2 = truncateUtf8ToBytes("café", 4)
    // "caf" is 3 bytes, adding "é" would be 5 bytes > 4
    assert.equal(acc2.text, "caf")
    assert.equal(acc2.bytes, 3)
    assert.equal(acc2.truncated, true)

    const acc3 = truncateUtf8ToBytes("café", 5)
    assert.equal(acc3.text, "café")
    assert.equal(acc3.bytes, 5)
    assert.equal(acc3.truncated, false)

    // CJK: '你' is 3 UTF-8 bytes, length 1
    assert.equal("你".length, 1)
    assert.equal(Buffer.byteLength("你", "utf8"), 3)

    const cjk1 = truncateUtf8ToBytes("你好世界", 5)
    assert.equal(cjk1.text, "你")
    assert.equal(cjk1.bytes, 3)
    assert.equal(cjk1.truncated, true)

    const cjk2 = truncateUtf8ToBytes("你好世界", 6)
    assert.equal(cjk2.text, "你好")
    assert.equal(cjk2.bytes, 6)
    assert.equal(cjk2.truncated, true)

    const cjk3 = truncateUtf8ToBytes("你好世界", 7)
    assert.equal(cjk3.text, "你好")
    assert.equal(cjk3.bytes, 6)
    assert.equal(cjk3.truncated, true)
  })

  // -------------------------------------------------------------------------
  // T-6211: Emoji Boundary (landing inside a 4-byte surrogate sequence)
  // -------------------------------------------------------------------------
  test("T-6211: Emoji boundary lands safely without splitting surrogate pair or creating U+FFFD", () => {
    const rocket = "🚀" // 4 UTF-8 bytes, 2 UTF-16 code units (\uD83D\uDE80)
    assert.equal(rocket.length, 2)
    assert.equal(Buffer.byteLength(rocket, "utf8"), 4)

    // Budget lands inside rocket's 4 bytes (e.g. 1, 2, or 3 bytes)
    for (const budget of [1, 2, 3]) {
      const res = truncateUtf8ToBytes(rocket, budget)
      assert.equal(res.text, "", `Budget ${budget} must exclude 4-byte emoji completely`)
      assert.equal(res.bytes, 0)
      assert.equal(res.truncated, true)
      assert.equal(hasIsolatedSurrogate(res.text), false)
      assert.equal(res.text.includes("\uFFFD"), false)
    }

    // Budget of 4 bytes includes rocket completely
    const fullRocket = truncateUtf8ToBytes(rocket, 4)
    assert.equal(fullRocket.text, "🚀")
    assert.equal(fullRocket.bytes, 4)
    assert.equal(fullRocket.truncated, false)

    // Two emojis with 6 bytes budget: first included, second excluded
    const twoEmojis = truncateUtf8ToBytes("🚀🔥", 6)
    assert.equal(twoEmojis.text, "🚀")
    assert.equal(twoEmojis.bytes, 4)
    assert.equal(twoEmojis.truncated, true)
    assert.equal(hasIsolatedSurrogate(twoEmojis.text), false)
    assert.equal(twoEmojis.text.includes("\uFFFD"), false)
  })

  // -------------------------------------------------------------------------
  // T-6212: CJK Byte Boundary
  // -------------------------------------------------------------------------
  test("T-6212: CJK characters exceeding byte budget truncate cleanly with truthful metrics", () => {
    const cjkText = "日本語テキストと中国語のテスト"
    const totalBytes = Buffer.byteLength(cjkText, "utf8")
    assert.ok(totalBytes > 20)

    for (let budget = 1; budget <= 20; budget++) {
      const res = truncateUtf8ToBytes(cjkText, budget)
      assert.ok(res.bytes <= budget, `Returned bytes ${res.bytes} must be <= budget ${budget}`)
      assert.equal(Buffer.byteLength(res.text, "utf8"), res.bytes)
      assert.equal(res.truncated, true)
      assert.equal(hasIsolatedSurrogate(res.text), false)
      assert.equal(res.text.includes("\uFFFD"), false)
    }
  })

  // -------------------------------------------------------------------------
  // T-6213: Combined ASCII / Accented / Emoji / CJK Mixed Unicode
  // -------------------------------------------------------------------------
  test("T-6213: Mixed Unicode around exact byte ceilings behaves deterministically", () => {
    const mixed = "Code: café ☕ with 你好 & 🚀 rocket!"
    // Byte sequence breakdown:
    // "Code: " (6) + "café " (6) + "☕ " (4) + "with " (5) + "你好 " (7) + "& " (2) + "🚀 " (5) + "rocket!" (7)

    for (let budget = 0; budget <= Buffer.byteLength(mixed, "utf8") + 5; budget++) {
      const res = truncateUtf8ToBytes(mixed, budget)
      assert.ok(res.bytes <= budget)
      assert.equal(Buffer.byteLength(res.text, "utf8"), res.bytes)
      assert.equal(hasIsolatedSurrogate(res.text), false)
      assert.equal(res.text.includes("\uFFFD"), false)
    }
  })

  // -------------------------------------------------------------------------
  // T-6214 / T-6215 / T-6216: Real 5MB Range Read & IO Evidence Metrics
  // -------------------------------------------------------------------------
  test("T-6214 / T-6215 / T-6216: Real >=5MB file middle-range read reads bounded chunk without whole-file buffering", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6215-5mb-"))
    try {
      const lineCount = 50_000
      const lineStr = "line " + "x".repeat(94) + "\n" // Exactly 100 bytes per line
      const fileBytes = lineCount * 100 // 5,000,000 bytes
      assert.equal(fileBytes, 5_000_000)

      const filePath = join(root, "huge_5mb.txt")
      await writeFile(filePath, lineStr.repeat(lineCount), "utf8")

      // Request middle slice: lines 100..120 (21 lines)
      const res = await readRepositoryFile(root, "huge_5mb.txt", {
        startLine: 100,
        endLine: 120,
      })

      // Instrument invariants
      assert.equal(res.sizeBytes, 5_000_000, "File size must be exactly 5,000,000 bytes")
      assert.equal(res.startLine, 100)
      assert.equal(res.endLine, 120)
      assert.equal(res.wholeFileBuffered, false, "Streaming scanner must not buffer whole file")
      assert.equal(res.truncated, false)
      assert.ok(res.bytesReadFromFile < res.sizeBytes, `bytesReadFromFile (${res.bytesReadFromFile}) must be << ${res.sizeBytes}`)
      assert.equal(res.chunksRead, 1, "Only 1 chunk (64KB) needed for lines 100..120")
      assert.equal(res.bytesReadFromFile, 65536, "Chunk size is 65536 bytes")

      const lines = res.content.split("\n")
      assert.equal(lines.length, 21, "Must return exactly 21 lines")
      assert.equal(res.returnedBytes, Buffer.byteLength(res.content, "utf8"))
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6217: Huge Single-Line Unicode File
  // -------------------------------------------------------------------------
  test("T-6217: Multi-megabyte single line containing mixed Unicode truncates at byte ceiling without unlimited buffering", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6217-single-"))
    try {
      const mixedUnit = "ASCII_" + "é".repeat(10) + "你好世界🚀🔥🌟"
      const unitBytes = Buffer.byteLength(mixedUnit, "utf8")
      // Repeat to create >2MB single line
      const repeatCount = Math.ceil((2 * 1024 * 1024) / unitBytes)
      const hugeLine = mixedUnit.repeat(repeatCount)
      const totalFileBytes = Buffer.byteLength(hugeLine, "utf8")
      assert.ok(totalFileBytes >= 2 * 1024 * 1024)

      const filePath = join(root, "huge_single.txt")
      await writeFile(filePath, hugeLine, "utf8")

      const maxBytes = 32 * 1024 // 32KB ceiling
      const res = await readRepositoryFile(root, "huge_single.txt", {
        startLine: 1,
        endLine: 1,
        maxBytes,
      })

      assert.equal(res.truncated, true)
      assert.equal(res.wholeFileBuffered, false)
      assert.ok(res.bytesReadFromFile < res.sizeBytes, "Must halt I/O upon hitting line byte limit")
      assert.equal(hasIsolatedSurrogate(res.content), false, "Must not contain isolated surrogates")
      assert.equal(res.content.includes("\uFFFD"), false, "Must not contain replacement characters")

      // Content ends with [TRUNCATED]
      assert.ok(res.content.endsWith("[TRUNCATED]"))
      // T-6305 hard invariant: full content including the marker must be <= maxBytes
      assert.ok(
        Buffer.byteLength(res.content, "utf8") <= maxBytes,
        `Full content including marker (${Buffer.byteLength(res.content, "utf8")} bytes) must be <= maxBytes (${maxBytes})`,
      )
      // returnedBytes field must match actual content bytes
      assert.equal(res.returnedBytes, Buffer.byteLength(res.content, "utf8"))
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6218: CRLF + UTF-8
  // -------------------------------------------------------------------------
  test("T-6218: Large CRLF Unicode file parses lines cleanly without stray \\r", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6218-crlf-"))
    try {
      const content =
        "line 1: café crème\r\n" +
        "line 2: 東京タワー 🗼\r\n" +
        "line 3: deep learning 🚀\r\n" +
        "line 4: final line 🎉\r\n"

      const filePath = join(root, "crlf_unicode.txt")
      await writeFile(filePath, content, "utf8")

      const res = await readRepositoryFile(root, "crlf_unicode.txt", {
        startLine: 2,
        endLine: 3,
      })

      assert.equal(res.content.includes("\r"), false, "Must contain zero carriage returns")
      const lines = res.content.split("\n")
      assert.equal(lines.length, 2)
      assert.equal(lines[0], "line 2: 東京タワー 🗼")
      assert.equal(lines[1], "line 3: deep learning 🚀")
      assert.equal(res.truncated, false)
      assert.equal(hasIsolatedSurrogate(res.content), false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6305: Truncation marker reserved from dataBudget — content + marker <= maxBytes
  // -------------------------------------------------------------------------
  test("T-6305: Truncation marker is reserved from maxBytes budget — returnedBytes <= maxBytes always", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6305-marker-"))
    try {
      // 200 ASCII lines × 50 bytes = 10 000 bytes; maxBytes = 100 forces truncation
      const line50 = "x".repeat(49) + "\n"
      await writeFile(join(root, "test.txt"), line50.repeat(200), "utf8")

      const maxBytes = 100
      const res = await readRepositoryFile(root, "test.txt", { startLine: 1, endLine: 200, maxBytes })

      assert.equal(res.truncated, true)
      // HARD INVARIANT: data + marker must fit inside maxBytes
      const contentBytes = Buffer.byteLength(res.content, "utf8")
      assert.ok(
        contentBytes <= maxBytes,
        `returnedBytes (${contentBytes}) must be <= maxBytes (${maxBytes})`,
      )
      assert.equal(res.returnedBytes, contentBytes)
      assert.equal(hasIsolatedSurrogate(res.content), false)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6306 / T-6307: Tiny maxBytes below marker size (< 12 bytes)
  // -------------------------------------------------------------------------
  test("T-6306/T-6307: Tiny maxBytes below truncation-marker size does not exceed budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6307-tiny-"))
    try {
      await writeFile(join(root, "tiny.txt"), "hello world\nsecond line\n", "utf8")

      // TRUNCATION_MARKER_BYTES = 12; test budgets smaller than that
      for (const maxBytes of [1, 5, 11]) {
        const res = await readRepositoryFile(root, "tiny.txt", { startLine: 1, endLine: 2, maxBytes })
        const contentBytes = Buffer.byteLength(res.content, "utf8")
        assert.ok(
          contentBytes <= maxBytes,
          `Tiny budget ${maxBytes}: content (${contentBytes} bytes) must be <= ${maxBytes}`,
        )
        assert.equal(hasIsolatedSurrogate(res.content), false)
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------------
  // T-6308: Unicode content + truncation marker within maxBytes — no surrogates
  // -------------------------------------------------------------------------
  test("T-6308: Unicode + truncation marker boundary — returnedBytes <= maxBytes, no isolated surrogates", async () => {
    const root = await mkdtemp(join(tmpdir(), "t6308-unicode-"))
    try {
      // Mix emoji (4 bytes), CJK (3 bytes), accented (2 bytes) per character
      const mixedLine = "🚀".repeat(15) + "你好世界".repeat(10) + "café".repeat(8)
      await writeFile(join(root, "unicode.txt"), (mixedLine + "\n").repeat(60), "utf8")

      const maxBytes = 500
      const res = await readRepositoryFile(root, "unicode.txt", { startLine: 1, endLine: 50, maxBytes })

      const contentBytes = Buffer.byteLength(res.content, "utf8")
      assert.ok(
        contentBytes <= maxBytes,
        `Unicode content (${contentBytes} bytes) must be <= maxBytes (${maxBytes})`,
      )
      assert.equal(hasIsolatedSurrogate(res.content), false, "No isolated surrogates at truncation boundary")
      assert.equal(res.content.includes("\uFFFD"), false, "No replacement characters")
      assert.equal(res.returnedBytes, contentBytes)
      if (res.truncated) {
        assert.ok(res.content.endsWith("[TRUNCATED]"))
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

