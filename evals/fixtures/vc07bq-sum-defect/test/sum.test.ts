import assert from "node:assert/strict"
import { test } from "node:test"
import { sum } from "../src/sum.ts"

test("sum adds every value", () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([5]), 5)
  assert.equal(sum([]), 0)
})
