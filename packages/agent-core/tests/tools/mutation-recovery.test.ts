import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { deriveUniquePatch } from "../../src/tools/mutation-engine.ts"
import {
  classifyNamedEditTargets,
  inspectMutationTarget,
  misplacedExportPath,
} from "../../src/tools/mutation-recovery.ts"

test("deriveUniquePatch returns a unique hunk and refuses whole-file replacement", () => {
  const before = "export function add(a, b) {\n  return a - b\n}\n"
  const after = "export function add(a, b) {\n  return a + b\n}\n"
  const patch = deriveUniquePatch(before, after)
  assert.ok(patch)
  assert.equal(before.split(patch!.search).length, 2)
  assert.equal(before.replace(patch!.search, patch!.replace), after)
  assert.equal(deriveUniquePatch(before, "unrelated\n"), undefined)
  assert.equal(deriveUniquePatch(before, before), undefined)
})

test("inspectMutationTarget uses workspace path resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-inspect-"))
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/add.ts"), "export function add() {}\n")
    const existing = await inspectMutationTarget(root, "src/add.ts")
    assert.equal(existing.kind, "existing")
    const missing = await inspectMutationTarget(root, "src/new.ts")
    assert.equal(missing.kind, "missing")
    const blocked = await inspectMutationTarget(root, "../secret.ts")
    assert.equal(blocked.kind, "blocked")
    const classified = await classifyNamedEditTargets(root, ["src/add.ts", "src/new.ts"])
    assert.deepEqual(classified.existing, ["src/add.ts"])
    assert.deepEqual(classified.missing, ["src/new.ts"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("inspectMutationTarget rejects a symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovsc-inspect-link-"))
  const outside = await mkdtemp(join(tmpdir(), "ovsc-inspect-out-"))
  try {
    await writeFile(join(outside, "secret.txt"), "nope\n")
    await mkdir(join(root, "src"))
    await symlink(join(outside, "secret.txt"), join(root, "src/secret.txt"))
    const state = await inspectMutationTarget(root, "src/secret.txt")
    assert.equal(state.kind, "blocked")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("misplacedExportPath detects an export that belongs in another existing file", () => {
  const before = "export function formatName(first: string, last: string): string {\n  return `${first} ${last}`\n}\n"
  const after = `${before}\nexport function greet(first: string, last: string): string {\n  return formatName(first, last)\n}\n`
  const owner = misplacedExportPath("src/format.ts", before, after, ["src/format.ts", "src/greet.ts"])
  assert.equal(owner, "src/greet.ts")
  assert.equal(misplacedExportPath("src/greet.ts", "export function greet() {\n  return ''\n}\n", "export function greet() {\n  return 'Hello'\n}\n", ["src/format.ts", "src/greet.ts"]), undefined)
})
