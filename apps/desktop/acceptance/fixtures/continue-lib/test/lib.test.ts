import assert from "node:assert/strict"
import test from "node:test"
import { formatName } from "../src/format.ts"
import { greet } from "../src/greet.ts"
import { parseName } from "../src/parse.ts"

test("formatName returns Last, First", () => {
  assert.equal(formatName("Ada", "Lovelace"), "Lovelace, Ada")
})

test("greet uses formatName", () => {
  assert.equal(greet("Ada", "Lovelace"), "Hello, Lovelace, Ada")
})

test("parseName splits Last, First", () => {
  assert.deepEqual(parseName("Lovelace, Ada"), { first: "Ada", last: "Lovelace" })
})
