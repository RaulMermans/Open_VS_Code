/**
 * S35 oracle strength: each plausible wrong implementation (a mutant of the hand reference) must FAIL its
 * hidden oracle. Run: node --import tsx packages/ide-adapter/evals/s35-mutants.ts
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { S35_TASKS } from "./coding-tasks-s35.ts"
import { S35_REFERENCE } from "./s35-reference.ts"

const MUTANTS: readonly { task: string; file: string; from: string; to: string; label: string }[] = [
  { task: "s35-03-bugfix", file: "src/paginate.js", from: "Math.max(1, Math.ceil(items.length / size))", to: "Math.ceil(items.length / size)", label: "start fixed, empty list still 0 pages" },
  { task: "s35-03-bugfix", file: "src/paginate.js", from: "(page - 1) * size", to: "page * size - 1", label: "off by one the other way" },
  { task: "s35-04-multifile", file: "src/sort.ts", from: "{ high: 0, normal: 1, low: 2 }", to: "{ high: 2, normal: 1, low: 0 }", label: "priority order reversed" },
  { task: "s35-04-multifile", file: "src/tasks.ts", from: "priority: Priority = \"normal\"", to: "priority: Priority = \"low\"", label: "wrong default priority" },
  { task: "s35-05-repair-test", file: "src/duration.ts", from: "if (!match || trimmed === \"\")", to: "if (!match)", label: "empty text accepted" },
  { task: "s35-06-rename", file: "src/money.ts", from: "\n", to: "\nexport { formatMoney as formatPrice }\n", label: "old name kept as an alias" },
  { task: "s35-07-python", file: "slugkit/slug.py", from: "unicodedata.normalize(\"NFKD\", text)", to: "text", label: "accents dropped instead of folded" },
  { task: "s35-07-python", file: "slugkit/slug.py", from: "slug[:max_length].rstrip(\"-\")", to: "slug[:max_length]", label: "trailing dash after the cut" },
  { task: "s35-08-frontend", file: "src/Pager.js", from: "if (!first) onChange(page - 1)", to: "onChange(page - 1)", label: "disabled Prev still calls onChange" },
  { task: "s35-08-frontend", file: "src/Pager.js", from: "disabled: last || undefined", to: "disabled: last", label: "Next always has a disabled prop (false renders nothing; must still pass)" },
  { task: "s35-09-history", file: "src/history.ts", from: "[...entries.slice(0, index + 1), url]", to: "[...entries, url]", label: "push keeps forward entries" },
  { task: "s35-09-history", file: "src/history.ts", from: "if (entries.length > limit) entries = entries.slice(entries.length - limit)", to: "", label: "no limit" },
  { task: "s35-10-complex", file: "src/cache.ts", from: "      entries.delete(key)\n      entries.set(key, entry)\n      hits += 1", to: "      entries.delete(key)\n      entries.set(key, { ...entry, setAt: now() })\n      hits += 1", label: "get extends expiry" },
  { task: "s35-10-complex", file: "src/cache.ts", from: "      if (entries.size > options.maxEntries) dropExpired()\n", to: "", label: "evicts live LRU before expired" },
  { task: "s35-10-complex", file: "src/cache.ts", from: "      entries.delete(key)\n      entries.set(key, entry)\n", to: "", label: "a hit does not count as use" },
]
// Mutants that are still correct implementations: the oracle must accept them.
const EQUIVALENT = new Set(["Next always has a disabled prop (false renders nothing; must still pass)"])

let bad = 0
for (const mutant of MUTANTS) {
  const task = S35_TASKS.find((item) => item.id === mutant.task)!
  const files = { ...task.files, ...S35_REFERENCE[mutant.task]!.files }
  const original = files[mutant.file]!
  if (!original.includes(mutant.from)) throw new Error(`anchor missing: ${mutant.label}`)
  files[mutant.file] = original.replace(mutant.from, mutant.to)
  const base = mkdtempSync(join(tmpdir(), "ovsc-s35-mutant-"))
  const root = realpathSync(base)
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), body)
    }
    const oracle = task.oracle
    if (oracle.kind === "absent") throw new Error("explain tasks are checked with untreated answers, not mutants")
    const script = join(root, oracle.kind === "node" ? "oracle.mjs" : "oracle.py")
    writeFileSync(script, oracle.kind === "node" ? oracle.script.replaceAll("WS/", `${root}/`) : `import sys\nsys.path.insert(0, ${JSON.stringify(root)})\n${oracle.script}`)
    const result = spawnSync(oracle.kind === "node" ? process.execPath : "python3", oracle.kind === "node" ? ["--experimental-strip-types", script] : ["-B", script], { cwd: root, encoding: "utf8", timeout: 120_000 })
    const passed = result.status === 0
    const expected = EQUIVALENT.has(mutant.label)
    const ok = passed === expected
    if (!ok) bad += 1
    console.log(`${ok ? "OK " : "BAD"} ${mutant.task} ${expected ? "accepted" : "rejected"}: ${mutant.label}${ok ? "" : ` (oracle ${passed ? "passed" : "failed"}: ${(result.stdout + result.stderr).trim().slice(-200)})`}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
if (bad) process.exit(1)
