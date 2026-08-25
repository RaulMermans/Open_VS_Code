import assert from "node:assert/strict"
import test from "node:test"

import { createToolObservation } from "../../src/agent/observations.ts"

test("creates bounded success observations with repository provenance", () => {
  const observation = createToolObservation({
    callId: "call-1",
    toolName: "search_text",
    output: { results: [{ path: "src/auth.ts", line: 3, text: "authenticate()" }], truncated: false },
    maxContentBytes: 1_000,
  })

  assert.equal(observation.ok, true)
  assert.equal(observation.truncated, false)
  assert.deepEqual(observation.provenance.paths, ["src/auth.ts"])
  assert.match(observation.content, /authenticate/)
})

test("marks bounded content as truncated without claiming completeness", () => {
  const observation = createToolObservation({ callId: "call-2", toolName: "read_file", output: "é".repeat(100), maxContentBytes: 11 })

  assert.equal(observation.truncated, true)
  assert.equal(Buffer.byteLength(observation.content) <= 11, true)
})

test("retains structured error categories without stack traces", () => {
  const observation = createToolObservation({
    callId: "call-3",
    toolName: "read_file",
    error: { category: "TOOL_RUNTIME_ERROR", message: "file vanished" },
    maxContentBytes: 100,
  })

  assert.equal(observation.ok, false)
  assert.equal(observation.errorCategory, "TOOL_RUNTIME_ERROR")
  assert.equal(observation.content, "file vanished")
})
