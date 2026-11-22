import assert from "node:assert/strict"
import test from "node:test"
import { taxIncluded } from "../src/tax.ts"
import { lineTotal } from "../src/invoice.ts"

test("lineTotal multiplies", () => {
  assert.equal(lineTotal(3, 4), 12)
})

test("taxIncluded adds the rate", () => {
  assert.equal(taxIncluded(100, 0.1), 110)
})
