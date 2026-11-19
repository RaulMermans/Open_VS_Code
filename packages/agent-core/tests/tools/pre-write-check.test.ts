import assert from "node:assert/strict"
import test from "node:test"
import { exportedTypeShapeChanged, proposedContentProblems } from "../../src/tools/pre-write-check.ts"

test("valid TypeScript with unresolved imports and types is not reported", () => {
  assert.deepEqual(proposedContentProblems("a.ts", "import { x } from './missing'\nexport const y: Foo = x\n"), [])
})
test("a duplicate declaration (the HALO second patch) and a syntax error are reported", () => {
  assert.match(proposedContentProblems("v.ts", "const A = 1\nconst A = 2\n")[0]!, /redeclare/)
  assert.ok(proposedContentProblems("v.ts", "export const = = =\n").length > 0)
})
test("non-code files are ignored", () => {
  assert.deepEqual(proposedContentProblems("a.md", "const = ="), [])
})

test("an exported type or union that gains a member is flagged; unrelated edits and non-exported types are not", () => {
  const before = 'export type Format = "json" | "csv"\nexport const x = 1\n'
  assert.equal(exportedTypeShapeChanged("a.ts", before, before.replace('"csv"', '"csv" | "ndjson"')), true)
  assert.equal(exportedTypeShapeChanged("a.ts", before, before.replace("x = 1", "x = 2")), false)
  assert.equal(exportedTypeShapeChanged("a.ts", "type L = 1\n", "type L = 1 | 2\n"), false)
  assert.equal(exportedTypeShapeChanged("a.md", before, before + "x"), false)
})
