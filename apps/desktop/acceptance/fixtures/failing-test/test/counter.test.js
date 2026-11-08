import assert from "node:assert/strict"
import test from "node:test"
import { nextCount } from "../src/counter.js"

test("nextCount increments", () => {
  assert.equal(nextCount(1), 2)
})
