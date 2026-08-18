import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"

import {
  MarkdownError,
  discoverCanonicalMarkdown,
  extractMarkdownHeadings,
  readMarkdownFile,
  readMarkdownSection,
  searchMarkdown,
} from "../../src/context/markdown.ts"

const fixtureRoot = join(import.meta.dirname, "..", "fixtures", "markdown-project")

test("discovers only canonical Markdown in canonical order", async () => {
  const files = await discoverCanonicalMarkdown(fixtureRoot)
  assert.deepEqual(files.map((file) => file.name), ["AGENTS.md", "PROJECT.md"])
  assert.equal(files.every((file) => file.sizeBytes > 0), true)
})

test("extracts headings and reads one section independently", async () => {
  const headings = extractMarkdownHeadings("# One\ntext\n```md\n# ignored\n```\n## Two\nmore")
  assert.deepEqual(headings.map(({ level, title }) => ({ level, title })), [
    { level: 1, title: "One" },
    { level: 2, title: "Two" },
  ])
  const section = await readMarkdownSection(fixtureRoot, "AGENTS.md", "Testing")
  assert.equal(section, "## Testing\n\nRun focused tests first.")
})

test("searches Markdown with deterministic bounded results", async () => {
  const results = await searchMarkdown(fixtureRoot, "AGENTS.md", "repository", { maxResults: 1 })
  assert.deepEqual(results, [{ line: 3, text: "Always stay inside the repository." }])
})

test("fails cleanly for missing, oversized, and escaped files", async () => {
  await assert.rejects(readMarkdownFile(fixtureRoot, "missing.md"), { code: "NOT_FOUND" })
  await assert.rejects(readMarkdownFile(fixtureRoot, "AGENTS.md", { maxBytes: 8 }), { code: "TOO_LARGE" })
  await assert.rejects(readMarkdownFile(fixtureRoot, "../outside.md"), { code: "OUTSIDE_WORKSPACE" })
})

test("bounds large Markdown before reading it", async () => {
  await assert.rejects(readMarkdownFile(fixtureRoot, "OVERSIZED.md", { maxBytes: 50 }), MarkdownError)
})
