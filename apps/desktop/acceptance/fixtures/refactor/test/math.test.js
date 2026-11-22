import assert from "node:assert/strict"
import test from "node:test"
import { total } from "../src/math.js"

test("total sums values", () => {
  assert.equal(total([1, 2, 3]), 6)
})
