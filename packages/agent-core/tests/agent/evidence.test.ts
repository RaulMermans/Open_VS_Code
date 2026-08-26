import test from "node:test"
import assert from "node:assert/strict"
import { EvidenceLedger } from "../../src/agent/evidence.ts"
import type { EvidenceRequirement } from "../../src/agent/task-profile.ts"

test("EvidenceLedger tracks observations and evaluates satisfaction", () => {
  const ledger = new EvidenceLedger()
  assert.equal(ledger.totalObservations, 0)
  assert.equal(ledger.filesRead.length, 0)

  ledger.recordObservation("read_file", "call-1", { path: "src/auth.ts" }, true, "export function auth() {}")
  assert.equal(ledger.totalObservations, 1)
  assert.equal(ledger.filesRead.length, 1)
  assert.ok(ledger.filesRead.includes("src/auth.ts"))

  const req: EvidenceRequirement = {
    id: "read-auth",
    kind: "FILE_READ",
    minCount: 1,
    description: "Read auth file",
  }

  const result = ledger.evaluate([req], ["src/auth.ts"])
  assert.equal(result.satisfied, true)
  assert.equal(result.missing.length, 0)
})

test("EvidenceLedger detects missing explicit files with basename matching", () => {
  const ledger = new EvidenceLedger()
  ledger.recordObservation("read_file", "call-1", { path: "src/config.ts" }, true, "export const PORT = 3000")

  const result = ledger.evaluate([], ["config.ts"])
  assert.equal(result.satisfied, true)
  assert.equal(result.missing.length, 0)
})

test("EvidenceLedger tracks searches and handles missing requirements", () => {
  const ledger = new EvidenceLedger()
  ledger.recordObservation("search_text", "call-1", { query: "authenticate" }, true, "src/auth.ts:1: export function authenticate")

  const searchReq: EvidenceRequirement = {
    id: "search-sym",
    kind: "SEARCH_PERFORMED",
    minCount: 1,
    description: "Perform a search",
  }

  const result = ledger.evaluate([searchReq])
  assert.equal(result.satisfied, true)
  assert.equal(result.missing.length, 0)

  const unreadReq: EvidenceRequirement = {
    id: "need-read",
    kind: "FILE_READ",
    minCount: 2,
    description: "Read 2 files",
  }
  const failedResult = ledger.evaluate([unreadReq])
  assert.equal(failedResult.satisfied, false)
  assert.equal(failedResult.missing.length, 1)
})
