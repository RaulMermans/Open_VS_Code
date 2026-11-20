import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { danglingReferences } from "../../src/tools/json-references.ts"

test("a new reference to an id no JSON defines is reported; defined, self-defined and pre-existing ones are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-refs-"))
  try {
    await mkdir(join(root, "config"))
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, "config/models.json"), JSON.stringify({ models: [{ id: "dev-coder" }, { id: "dev-general" }] }))
    await writeFile(join(root, "node_modules/x.json"), JSON.stringify({ id: "ghost-in-deps" }))
    const before = JSON.stringify({ routes: { coding: { modelId: "dev-coder" }, old: { modelId: "long-gone" } } })
    const after = (extra: object) => JSON.stringify({ routes: { coding: { modelId: "dev-coder" }, old: { modelId: "long-gone" }, ...extra } })
    const run = (extra: object) => danglingReferences(root, "config/routes.json", before, after(extra))
    assert.deepEqual((await run({ general: { modelId: "x3-qwen3-4b-vulkan" } })).map((ref) => ref.value), ["x3-qwen3-4b-vulkan"])
    assert.deepEqual(await run({ general: { modelId: "dev-general" } }), [], "defined in models.json")
    assert.deepEqual((await run({ general: { modelId: "ghost-in-deps" } })).map((ref) => ref.value), ["ghost-in-deps"], "node_modules is not a definition")
    assert.deepEqual(await danglingReferences(root, "config/routes.json", before, before), [], "pre-existing dangling reference is not blamed")
    assert.deepEqual(await danglingReferences(root, "notes.md", before, after({ g: { modelId: "nope-nope" } })), [], "only JSON files")
    const selfDefined = JSON.stringify({ models: [{ id: "new-model" }], routes: { general: { modelId: "new-model" } } })
    assert.deepEqual(await danglingReferences(root, "config/all.json", "{}", selfDefined), [], "the edit defines it itself")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
