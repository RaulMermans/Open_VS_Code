import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MutationEngine, locatePatch } from "../../src/tools/mutation-engine.ts"
import { MutationFailure } from "../../src/tools/mutation-contracts.ts"

const SOURCE = "export class Box {\n  open(): void {\n    this.state = \"open\"\n  }\n\n  close(): void {\n    this.state = \"closed\"\n  }\n}\n"

test("an exact unique search is applied exactly", () => {
  const location = locatePatch(SOURCE, "this.state = \"open\"", "this.state = \"opened\"", "box.ts")
  assert.equal(location.ok, true)
  if (!location.ok) return
  assert.equal(location.matchKind, "EXACT")
  assert.equal(location.afterContent, SOURCE.replace("\"open\"", "\"opened\""))
})

test("an exact search that occurs twice is ambiguous and names both lines", () => {
  const location = locatePatch("a()\nb()\na()\n", "a()", "c()", "x.ts")
  assert.equal(location.ok, false)
  if (location.ok) return
  assert.equal(location.code, "PATCH_AMBIGUOUS")
  assert.match(location.detail, /lines 1 and 3/)
})

test("a search with the wrong indentation matches one window and the replacement is re-indented", () => {
  const search = "close(): void {\n  this.state = \"closed\"\n}"
  const replace = "close(): void {\n  this.state = \"closed\"\n  this.count += 1\n}"
  const location = locatePatch(SOURCE, search, replace, "box.ts")
  assert.equal(location.ok, true)
  if (!location.ok) return
  assert.equal(location.matchKind, "WHITESPACE_NORMALIZED")
  assert.equal(location.afterContent, SOURCE.replace("    this.state = \"closed\"\n  }", "    this.state = \"closed\"\n    this.count += 1\n  }"))
  // Everything outside the window is untouched.
  assert.ok(location.afterContent.startsWith(SOURCE.slice(0, SOURCE.indexOf("  close()"))))
})

test("trailing whitespace and CRLF differences still match and keep CRLF endings", () => {
  const crlf = "def total(xs):\r\n    return sum(xs)   \r\n\r\ndef mean(xs):\r\n    return total(xs) / len(xs)\r\n"
  const location = locatePatch(crlf, "def mean(xs):\n    return total(xs) / len(xs)\n", "def mean(xs):\n    return total(xs) / len(xs) if xs else 0\n", "m.py")
  assert.equal(location.ok, true)
  if (!location.ok) return
  assert.equal(location.afterContent, crlf.replace("return total(xs) / len(xs)\r\n", "return total(xs) / len(xs) if xs else 0\r\n"))
})

test("a whitespace-normalized search that matches two windows is rejected as ambiguous", () => {
  const content = "if (a) {\n  return 1\n}\nif (a) {\n    return 1\n}\n"
  const location = locatePatch(content, "if (a) {\nreturn 1\n}", "if (a) {\nreturn 2\n}", "x.ts")
  assert.equal(location.ok, false)
  if (location.ok) return
  assert.equal(location.code, "PATCH_AMBIGUOUS")
})

test("a missing search returns the closest region with line numbers and never guesses", () => {
  const location = locatePatch(SOURCE, "  close(): void {\n    this.state = \"shut\"\n  }", "x", "box.ts")
  assert.equal(location.ok, false)
  if (location.ok) return
  assert.equal(location.code, "PATCH_MISMATCH")
  assert.match(location.detail, /Closest lines in box\.ts/)
  assert.match(location.detail, /\s6\|\s+close\(\): void \{/)
  assert.ok(location.detail.length < 3_000)
})

test("a mismatch whose replacement is already present says the edit may already be applied", () => {
  const location = locatePatch(SOURCE, "this.state = \"shutting\"", "this.state = \"closed\"", "box.ts")
  assert.equal(location.ok, false)
  if (location.ok) return
  assert.match(location.detail, /may already be applied/)
})

test("uneven indentation drift is refused with the exact lines instead of guessing the indentation", () => {
  const python = "def area(r):\n    if r < 0:\n        raise ValueError\n    return 3.14 * r * r\n"
  const location = locatePatch(python, "def area(r):\nif r < 0:\nraise ValueError", "def area(r):\nif r <= 0:\nraise ValueError", "geo.py")
  assert.equal(location.ok, false)
  if (location.ok) return
  assert.equal(location.code, "PATCH_MISMATCH")
  assert.match(location.detail, /indentation differs unevenly/)
  assert.match(location.detail, /\s2\|\s+if r < 0:/)
})

test("very short or blank searches never use the whitespace fallback", () => {
  const location = locatePatch("}\n}\n", "  }", "x", "x.ts")
  assert.equal(location.ok, false)
})

test("the engine applies a whitespace-normalized patch only after approval and keeps stale protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-patch-loc-"))
  try {
    await writeFile(join(root, "box.ts"), SOURCE)
    const engine = new MutationEngine(root)
    const prepared = await engine.preparePatch({ operation: "patch", path: "box.ts", patch: { search: "open(): void {\n  this.state = \"open\"\n}", replace: "open(): void {\n  this.state = \"ajar\"\n}" } })
    assert.equal(await readFile(join(root, "box.ts"), "utf8"), SOURCE, "prepare does not write")
    assert.match(prepared.diff.unified, /\+    this\.state = "ajar"/)
    await writeFile(join(root, "box.ts"), SOURCE + "// external\n")
    const stale = await engine.applyPreparedMutation(prepared)
    assert.notEqual(stale.status, "APPLIED")
    assert.equal(await readFile(join(root, "box.ts"), "utf8"), SOURCE + "// external\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the engine surfaces PATCH_MISMATCH with a region hint as a typed failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-patch-loc-"))
  try {
    await writeFile(join(root, "box.ts"), SOURCE)
    const engine = new MutationEngine(root)
    await assert.rejects(
      engine.preparePatch({ operation: "patch", path: "box.ts", patch: { search: "close(): void {\n  this.state = \"gone\"", replace: "x" } }),
      (error: unknown) => error instanceof MutationFailure && error.code === "PATCH_MISMATCH" && /Closest lines/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
