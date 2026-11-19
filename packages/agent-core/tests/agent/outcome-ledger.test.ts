import assert from "node:assert/strict"
import test from "node:test"
import { deriveOutcomes, evaluateOutcomes, isSubstantial, outcomeGaps } from "../../src/agent/outcome-ledger.ts"

const BRIEF = `# Stabilize billing

## Phase 1 — Inspect current state
Read-only inspection of the services.

## Phase 2 — Invoice numbering
Implement sequential \`invoiceNumber\` generation in the billing module. Add \`INVOICE_PREFIX\` to config.

## Phase 3 — Tax rounding
Fix the \`roundTax\` helper so totals round half-up.

## Phase 4 — Rollout plan
Prepare a deployment procedure document with a rollback target.

## Phase 5 — Live switch
Switch production only after operator approval.
`

test("a multi-phase brief yields typed outcomes; inspection is not an outcome; live switch is approval-gated", () => {
  const o = deriveOutcomes(BRIEF)
  assert.deepEqual(o.map((x) => x.kind), ["IMPLEMENTATION", "IMPLEMENTATION", "DOCUMENTATION", "EXTERNAL"])
  assert.equal(o[3]!.status, "BLOCKED")
  assert.equal(isSubstantial(o), true)
  assert.equal(isSubstantial(deriveOutcomes("Fix the bug in src/a.ts")), false)
})

test("only workspace evidence and verification move statuses; the model's claim does not", () => {
  const o = deriveOutcomes(BRIEF)
  const edit = { path: "src/billing.ts", content: "export function invoiceNumber() {} const INVOICE_PREFIX = 'INV'" }
  const none = evaluateOutcomes(o, [], undefined)
  assert.ok(none.slice(0, 2).every((x) => x.status === "PENDING"))
  assert.equal(outcomeGaps(none).length, 2)
  const edited = evaluateOutcomes(o, [edit], undefined)
  assert.equal(edited[0]!.status, "UNVERIFIED")
  assert.equal(edited[1]!.status, "PENDING")
  assert.equal(evaluateOutcomes(o, [edit], { status: "PASS", afterLastEdit: true })[0]!.status, "VERIFIED")
  assert.equal(evaluateOutcomes(o, [edit], { status: "FAIL", afterLastEdit: true })[0]!.status, "FAILED")
  assert.equal(evaluateOutcomes(o, [edit], { status: "PASS", afterLastEdit: false })[0]!.status, "UNVERIFIED")
})

test("a doc edit does not satisfy an implementation outcome; a code edit does not satisfy the plan document", () => {
  const o = deriveOutcomes(BRIEF)
  const doc = evaluateOutcomes(o, [{ path: "docs/notes.md", content: "invoiceNumber INVOICE_PREFIX roundTax rollback deployment procedure" }], undefined)
  assert.equal(doc[0]!.status, "PENDING")
  assert.equal(doc[2]!.status, "VERIFIED")
  const code = evaluateOutcomes(o, [{ path: "src/x.ts", content: "rollback deployment procedure" }], undefined)
  assert.equal(code[2]!.status, "PENDING")
})

test("the current work unit is the first outstanding outcome, with its own brief; approval-gated work is never a unit", async () => {
  const { currentWorkUnit, formatWorkUnit } = await import("../../src/agent/outcome-ledger.ts")
  const o = deriveOutcomes(BRIEF)
  assert.equal(currentWorkUnit(o)?.id, "O1")
  assert.match(formatWorkUnit(o), /CURRENT WORK UNIT O1 of 4: Invoice numbering[\s\S]*invoiceNumber/)
  const edit = { path: "src/billing.ts", content: "invoiceNumber INVOICE_PREFIX" }
  const next = evaluateOutcomes(o, [edit], { status: "PASS", afterLastEdit: true })
  assert.equal(currentWorkUnit(next)?.id, "O2")
  assert.match(formatWorkUnit(next), /done: O1/)
})

test("a section that asks for tests is not met by its code alone", () => {
  const o = deriveOutcomes(`## Phase 1 — Qualification\nAdd \`QUALIFY_ALIAS\` checking to the gateway.\n\nTest in isolation:\n- alias missing\n- wrong alias\n`)
  assert.equal(o[0]!.testsRequired, true)
  const code = { path: "src/gateway.ts", content: "const QUALIFY_ALIAS = 1; function qualification() {}" }
  const codeOnly = evaluateOutcomes(o, [code], undefined)
  assert.equal(codeOnly[0]!.status, "IN_PROGRESS")
  assert.match(outcomeGaps(codeOnly)[0]!, /tests it asks for are not written/)
  const withTest = evaluateOutcomes(o, [code, { path: "test/gateway.test.ts", content: "expect(QUALIFY_ALIAS)" }], undefined)
  assert.equal(withTest[0]!.status, "UNVERIFIED")
})

test("a section's tests count toward it once its code is edited, but tests alone do not", () => {
  const o = deriveOutcomes(`## Phase 1 — Qualification\nImplement \`QUALIFY_ALIAS\` and \`alias-q4km\` checking at startup.\n\nTest in isolation:\n- alias missing\n`)
  const config = { path: "config/routes.json", content: "alias-q4km" }
  const test = { path: "test/q.test.ts", content: "expect(QUALIFY_ALIAS).toBe('alias-q4km')" }
  assert.equal(evaluateOutcomes(o, [config, test], undefined)[0]!.status, "UNVERIFIED")
  assert.equal(evaluateOutcomes(o, [test], undefined)[0]!.status, "PENDING")
})
