import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReadOnlyToolRegistry, READ_WINDOW_LINES } from "../../src/tools/read-only-registry.ts"
import { createToolObservation } from "../../src/agent/observations.ts"

async function read(root: string, args: Record<string, unknown>) {
  const output = await createReadOnlyToolRegistry().prepare({ id: "r", name: "read_file", arguments: args }).invoke({ workspaceRoot: root, signal: new AbortController().signal })
  return createToolObservation({ toolName: "read_file", callId: "r", output, maxContentBytes: 16 * 1024 }).content
}

test("a long file is read in windows with an explicit way to continue, so its end is reachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-window-"))
  try {
    const lines = Array.from({ length: 800 }, (_, i) => `line_${i + 1} = ${i + 1}`)
    await writeFile(join(root, "big.py"), `${lines.join("\n")}\n`)
    const first = await read(root, { path: "big.py" })
    assert.match(first, new RegExp(`^File: big\\.py \\(lines 1-${READ_WINDOW_LINES} of 800\\)`))
    assert.match(first, /startLine 251/)
    assert.doesNotMatch(first, /line_251 =/)
    const tail = await read(root, { path: "big.py", startLine: 780 })
    assert.match(tail, /\(lines 780-800 of 800\)/)
    assert.match(tail, /line_800 = 800/)
    assert.doesNotMatch(tail, /More below/)
    assert.match(await read(root, { path: "big.py", startLine: 900 }), /past the end[\s\S]*only 800 lines/)
    await writeFile(join(root, "small.ts"), "export const a = 1\n")
    assert.equal(await read(root, { path: "small.ts" }), "File: small.ts\n```\nexport const a = 1\n\n```")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
