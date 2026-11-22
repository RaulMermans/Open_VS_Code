import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { excludeRuntimeArtifactsFromSourceControl } from "../../src/recovery/source-control-exclude.ts"

test("recovery artifacts are excluded locally without deleting them", () => {
  const root = mkdtempSync(join(tmpdir(), "ovsc-exclude-"))
  mkdirSync(join(root, ".git", "info"), { recursive: true })
  mkdirSync(join(root, ".open-vs-code", "recovery"), { recursive: true })
  writeFileSync(join(root, ".open-vs-code", "recovery", "journal.json"), "{}\n")
  writeFileSync(join(root, ".git", "info", "exclude"), "# existing\n")

  excludeRuntimeArtifactsFromSourceControl(root)
  excludeRuntimeArtifactsFromSourceControl(root)

  const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8")
  assert.match(exclude, /# existing/)
  assert.equal(exclude.split(".open-vs-code/recovery/").length - 1, 1)
  assert.match(exclude, /\.open-vs-code\/model-performance-ledger\.json/)
  assert.equal(readFileSync(join(root, ".open-vs-code", "recovery", "journal.json"), "utf8"), "{}\n")
})
