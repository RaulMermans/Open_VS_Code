import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { diagnoseUnresolvedSymbols, unresolvedSymbols } from "../../src/tools/symbol-diagnosis.ts"

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ovsc-symdiag-"))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  return root
}

test("a half-finished rename lists every stale reference and what the module now exports", async () => {
  const root = await fixture({
    "src/totals.ts": "export function computeTotal(values: number[]) {\n  return values.reduce((a, b) => a + b, 0)\n}\n",
    "src/report.ts": "import { calcTotal } from \"./totals.ts\"\nexport const report = (v: number[]) => `total=${calcTotal(v)}`\n",
    "src/average.ts": "import { computeTotal } from \"./totals.ts\"\nexport const average = (v: number[]) => computeTotal(v) / v.length\n",
    "node_modules/x/index.js": "export const calcTotal = 1\n",
  })
  try {
    const output = "# file:///w/src/report.ts:1\n# import { calcTotal } from \"./totals.ts\"\n# SyntaxError: The requested module './totals.ts' does not provide an export named 'calcTotal'\n"
    const report = await diagnoseUnresolvedSymbols(root, output)
    assert.ok(report)
    assert.match(report!, /src\/totals\.ts exports: computeTotal/)
    assert.match(report!, /not defined or exported anywhere/)
    assert.match(report!, /src\/report\.ts:1: import \{ calcTotal \}/)
    assert.match(report!, /src\/report\.ts:2: export const report/)
    assert.doesNotMatch(report!, /average\.ts/, "files that already use the new name are not listed")
    assert.doesNotMatch(report!, /node_modules/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a call to a name that is defined elsewhere but not imported points at the definition", async () => {
  const root = await fixture({
    "src/format.ts": "export function formatName(first: string, last: string) {\n  return `${last}, ${first}`\n}\n",
    "src/greet.ts": "export function greet(first: string, last: string) {\n  return `Hello, ${formatName(first, last)}`\n}\n",
  })
  try {
    const report = await diagnoseUnresolvedSymbols(root, "not ok 1 - greet\n  error: 'formatName is not defined'\n")
    assert.match(report!, /defined at: src\/format\.ts:1: export function formatName/)
    assert.match(report!, /src\/greet\.ts:2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Python import and name errors are diagnosed against the dotted module", async () => {
  const root = await fixture({
    "src/__init__.py": "",
    "src/models.py": "class Item:\n    pass\n\ndef make_item():\n    return Item()\n",
    "src/service.py": "from src.models import build_item\n\ndef run():\n    return build_item()\n",
  })
  try {
    const output = "ImportError: cannot import name 'build_item' from 'src.models' (/w/src/models.py)\n"
    assert.deepEqual(unresolvedSymbols(output), [{ name: "build_item", module: "src.models" }])
    const report = await diagnoseUnresolvedSymbols(root, output)
    assert.match(report!, /src\/models\.py exports: Item, make_item/)
    assert.match(report!, /src\/service\.py:1: from src\.models import build_item/)
    assert.match(report!, /src\/service\.py:4/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an undefined constructor names the package entry that omits the existing class", async () => {
  const root = await fixture({
    "packages/models/package.json": JSON.stringify({ name: "@acme/models", exports: { ".": { import: "./dist/index.js" } } }),
    "packages/models/src/index.ts": "export { ConfigError } from './errors.js'\n",
    "packages/models/src/errors.ts": "export class ConfigError extends Error {}\nexport class QualificationError extends Error {}\n",
    "packages/inference/test/qualify.test.ts": "import { QualificationError } from '@acme/models'\nexpect(error).toBeInstanceOf(QualificationError)\n",
  })
  try {
    const output = "AssertionError: The instanceof assertion needs a constructor but undefined was given.\n ❯ packages/inference/test/qualify.test.ts:2:25\n"
    const report = await diagnoseUnresolvedSymbols(root, output)
    assert.match(report!, /packages\/models\/src\/index\.ts exports: ConfigError/)
    assert.match(report!, /defined at: packages\/models\/src\/errors\.ts:2/)
    assert.match(report!, /package entry does not export it/)
    assert.match(report!, /qualify\.test\.ts:2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a built package entry tells the model that tests load dist", async () => {
  const root = await fixture({
    "packages/models/package.json": JSON.stringify({ name: "@acme/models", exports: { ".": { import: "./dist/index.js" } } }),
    "packages/models/src/index.ts": "export { ConfigError } from './errors.js'\n",
    "packages/models/src/errors.ts": "export class QualificationError extends Error {}\n",
    "packages/models/dist/index.js": "export { ConfigError } from './errors.js'\n",
    "packages/models/dist/errors.js": "export class ConfigError extends Error {}\n",
    "packages/inference/test/qualify.test.ts": "import { QualificationError } from '@acme/models'\nexpect(error).toBeInstanceOf(QualificationError)\n",
  })
  try {
    const output = "AssertionError: The instanceof assertion needs a constructor but undefined was given.\n ❯ packages/inference/test/qualify.test.ts:2:1\n"
    const report = await diagnoseUnresolvedSymbols(root, output)
    assert.match(report!, /tests load `packages\/models\/dist\/index\.js`/)
    assert.match(report!, /Build this package/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ordinary assertion failures produce no diagnosis", async () => {
  assert.deepEqual(unresolvedSymbols("AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n3 !== 4\n"), [])
  assert.equal(await diagnoseUnresolvedSymbols(tmpdir(), "expected 3 got 4"), undefined)
})
