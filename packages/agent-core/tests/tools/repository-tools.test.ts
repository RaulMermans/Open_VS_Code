import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import test from "node:test"

import { findFiles } from "../../src/tools/find-files.ts"
import { listDirectory } from "../../src/tools/list-directory.ts"
import { ReadFileError, readRepositoryFile } from "../../src/tools/read-file.ts"
import { searchText } from "../../src/tools/search-text.ts"

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "simple-ts-project")

test("reads normal, nested, and explicitly requested ignored files", async () => {
  assert.equal((await readRepositoryFile(fixtureRoot, "README.md")).content.includes("Simple Project"), true)
  assert.equal((await readRepositoryFile(fixtureRoot, "src/nested/value.ts")).content.includes("42"), true)
  assert.equal((await readRepositoryFile(fixtureRoot, "node_modules/ignored/index.ts")).content.includes("ignored dependency"), true)
})

test("rejects traversal, external absolute paths, missing, binary, and oversized files", async () => {
  await assert.rejects(readRepositoryFile(fixtureRoot, "../outside.txt"), { code: "OUTSIDE_WORKSPACE" })
  await assert.rejects(readRepositoryFile(fixtureRoot, resolve(fixtureRoot, "..", "outside.txt")), { code: "OUTSIDE_WORKSPACE" })
  await assert.rejects(readRepositoryFile(fixtureRoot, "missing.txt"), { code: "NOT_FOUND" })
  await assert.rejects(readRepositoryFile(fixtureRoot, "binary.bin"), { code: "BINARY_FILE" })
  await assert.rejects(readRepositoryFile(fixtureRoot, "large.txt", { maxBytes: 20 }), ReadFileError)
})

test("bounds and sorts directory listings", async () => {
  const result = await listDirectory(fixtureRoot, "many", { maxEntries: 2 })
  assert.deepEqual(result.entries.map((entry) => entry.name), ["a.txt", "b.txt"])
  assert.equal(result.truncated, true)
})

test("finds files deterministically while ignoring generated directories", async () => {
  const result = await findFiles(fixtureRoot, "**/*.ts")
  assert.deepEqual(result.paths, ["src/index.ts", "src/nested/value.ts"])
  assert.equal(result.truncated, false)
})

test("bounds search results and line output while ignoring generated directories", async () => {
  const result = await searchText(fixtureRoot, "hello", { maxResults: 1, maxLineLength: 24 })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0]!.path, "README.md")
  assert.equal(result.results[0]!.text.length <= 24, true)
  assert.equal(result.truncated, true)
  assert.equal(result.results.some((entry) => entry.path.includes("node_modules")), false)
})
