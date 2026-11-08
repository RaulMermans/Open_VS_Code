import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCatalog } from "./src/catalog.ts"
import { assertApprovalTarget, assertIsolatedPath, liveProfileDirs } from "./src/safety.ts"
import { notRun } from "./src/execute.ts"

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..")

test("scenario catalog has a closed set of executable contracts", () => {
  const scenarios = loadCatalog()
  assert.ok(scenarios.length >= 40 && scenarios.length <= 50)
  const groups = new Set(scenarios.map((scenario) => scenario.group))
  for (const group of ["conversation", "coding", "safety", "experience", "lifecycle"]) {
    assert.equal(groups.has(group as never), true)
  }
  const critical = scenarios.filter((scenario) => scenario.tier === "critical")
  assert.ok(critical.length >= 8)
  const heldOut = scenarios.filter((scenario) => scenario.tier === "held-out")
  assert.ok(heldOut.length >= 5)
})

test("approval and profile guards refuse the product tree and a live profile", () => {
  assert.throws(() => assertApprovalTarget(REPOSITORY_ROOT, REPOSITORY_ROOT, "approve"))
  assert.throws(() => assertIsolatedPath(REPOSITORY_ROOT, "Acceptance profile"))
  for (const live of liveProfileDirs()) {
    assert.throws(() => assertIsolatedPath(live, "Acceptance profile"))
  }
  const scratch = mkdtempSync(join(tmpdir(), "ovsc-accept-guard-"))
  const isolated = assertIsolatedPath(scratch, "Acceptance profile")
  assert.equal(isolated.startsWith(scratch) || scratch.startsWith(isolated), true)
})

test("a scenario that was not launched is not a pass", () => {
  const scenario = loadCatalog()[0]!
  const result = notRun(scenario, join(tmpdir(), "ovsc-accept-score"))
  assert.equal(result.verdict, "NOT_RUN")
  assert.equal(result.cause, "not_executed")
  assert.notEqual(result.verdict, "PASS")
})
