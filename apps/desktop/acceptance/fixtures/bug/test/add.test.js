import assert from "node:assert/strict"
import test from "node:test"
import { add } from "../src/add.js"

test("add sums two numbers", () => {
  assert.equal(add(1, 2), 3)
})
