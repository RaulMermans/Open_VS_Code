/**
 * Sprint 25: lookup results say when they are incomplete, and earlier successful lookups that fell out of
 * the recent-observation window stay listed (with the call that returns them) instead of disappearing.
 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createToolObservation, type ToolObservation } from "../../src/agent/observations.ts"
import { calculateBudget } from "../../src/context/budget.ts"
import { compileContext } from "../../src/context/compiler.ts"
import { listDirectory } from "../../src/tools/list-directory.ts"

const budget = calculateBudget({ contextWindow: 32_000, reservedOutput: 1_000, reservedToolHistory: 1_000 })

const read = (id: string, path: string, content = `contents of ${path}`): ToolObservation =>
  createToolObservation({ toolName: "read_file", callId: id, output: { path, content }, arguments: { path } })

test("a truncated directory listing states how many entries exist and how to see the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-s25-list-"))
  try {
    await mkdir(join(root, "many"))
    for (let index = 0; index < 12; index += 1) await writeFile(join(root, "many", `f${String(index).padStart(2, "0")}.ts`), "")
    const listed = await listDirectory(root, "many", { maxEntries: 5 })
    assert.equal(listed.truncated, true)
    assert.equal(listed.total, 12)
    const observation = createToolObservation({ toolName: "list_directory", callId: "l", output: listed })
    assert.match(observation.content, /\[Incomplete: only the first 5 entries of 12 are shown\. List a subdirectory, or use find_files/)
    const complete = createToolObservation({ toolName: "list_directory", callId: "l2", output: await listDirectory(root, "many") })
    assert.doesNotMatch(complete.content, /Incomplete/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("search and find results distinguish complete, incomplete and empty", () => {
  const partial = createToolObservation({ toolName: "search_text", callId: "s", output: { results: [{ path: "a.ts", line: 1, text: "x" }], truncated: true } })
  assert.match(partial.content, /Found 1 matches:\na\.ts:1: x\n\[Incomplete: only the first 1 matches are shown/)
  const none = createToolObservation({ toolName: "search_text", callId: "s2", output: { results: [], truncated: false } })
  assert.equal(none.content, "No matching text found.")
  const stopped = createToolObservation({ toolName: "search_text", callId: "s3", output: { results: [], truncated: true } })
  assert.match(stopped.content, /search stopped early/)
  const files = createToolObservation({ toolName: "find_files", callId: "f", output: { paths: ["a.ts", "b.ts"], truncated: true } })
  assert.match(files.content, /\[Incomplete: only the first 2 files are shown\. Use a narrower glob/)
})

test("successful lookups pushed out of the recent window stay listed in a required index", () => {
  const observations = Array.from({ length: 9 }, (_, index) => read(`r${index}`, `src/file${index}.ts`))
  const compiled = compileContext({ task: "Fix the bug.", projectInstructions: [], observations, budget })
  const index = compiled.items.find((item) => item.id === "observed-index")
  assert.ok(index, "an index is added when older observations are not shown")
  assert.equal(index.required, true)
  for (const evicted of ["src/file0.ts", "src/file1.ts", "src/file2.ts"]) assert.match(index.content, new RegExp(`read_file \\{"path":"${evicted.replace(".", "\\.")}"\\}`))
  assert.doesNotMatch(index.content, /src\/file8\.ts/, "observations still shown in full are not repeated in the index")
  assert.match(index.content, /repeat the exact call to get one back/)
})

test("the index leaves out failures and ALREADY_OBSERVED repeats, and is absent when everything is shown", () => {
  const failed = createToolObservation({ toolName: "read_file", callId: "bad", error: { category: "NOT_FOUND", message: "missing" }, arguments: { path: "nope.ts" } })
  const repeat: ToolObservation = { ...read("rep", "src/file0.ts"), alreadyObserved: true }
  const observations = [failed, repeat, ...Array.from({ length: 8 }, (_, index) => read(`r${index}`, `src/file${index}.ts`))]
  const index = compileContext({ task: "Fix the bug.", projectInstructions: [], observations, budget }).items.find((item) => item.id === "observed-index")
  assert.ok(index)
  assert.doesNotMatch(index.content, /nope\.ts/)
  assert.equal(index.content.match(/read_file \{"path":"src\/file0\.ts"\}/g)?.length, 1, "one line per distinct call")
  const few = compileContext({ task: "Fix the bug.", projectInstructions: [], observations: [read("a", "a.ts"), read("b", "b.ts")], budget })
  assert.equal(few.items.some((item) => item.id === "observed-index"), false)
})

test("the index stays bounded however long the task runs", () => {
  const observations = Array.from({ length: 200 }, (_, index) => read(`r${index}`, `src/f${index}.ts`, "x".repeat(4_000)))
  const index = compileContext({ task: "Refactor.", projectInstructions: [], observations, budget }).items.find((item) => item.id === "observed-index")!
  assert.ok(index.content.split("\n").length <= 31)
  assert.ok(index.estimatedTokens < 2_000)
})
