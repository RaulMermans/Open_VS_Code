/**
 * Autocomplete latency and relevance over 30 completion opportunities (Sprint 33B, Workstream D).
 *
 * Uses the production pipeline: workspace .open-vs-code/models.json → createProductionAutocompleteGateway →
 * LocalFimProvider → the local model. Relevance is an automated proxy (an expected token appears in the
 * suggestion), not a human acceptance rate. Requires OPEN_VS_CODE_REAL_INFERENCE=1.
 *
 *   OPEN_VS_CODE_REAL_INFERENCE=1 node --import tsx packages/agent-core/tests/evals/autocomplete-latency.ts [model] [label]
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProductionAutocompleteGateway } from "../../src/autocomplete/gateway.ts"

if (process.env.OPEN_VS_CODE_REAL_INFERENCE !== "1") throw new Error("Set OPEN_VS_CODE_REAL_INFERENCE=1")
const model = process.argv[2] ?? "qwen2.5-coder:7b"
const label = process.argv[3] ?? "autocomplete"
const endpoint = "http://127.0.0.1:11434/v1"

type Case = { id: string; lang: string; prefix: string; suffix: string; expect: string[]; multi?: boolean }
const c = (id: string, lang: string, prefix: string, suffix: string, expect: string[], multi = false): Case => ({ id, lang, prefix, suffix, expect, multi })

const CASES: Case[] = [
  c("ts-sum", "typescript", "export function sum(values: number[]): number {\n  return values.", "\n}\n", ["reduce"]),
  c("ts-max", "typescript", "export function max(a: number, b: number): number {\n  return ", "\n}\n", ["Math.max", "a > b", "a >= b"]),
  c("ts-filter", "typescript", "interface User { name: string; active: boolean }\nexport function activeUsers(users: User[]): User[] {\n  return users.", "\n}\n", ["filter"]),
  c("ts-map-names", "typescript", "interface User { name: string }\nexport const names = (users: User[]): string[] => users.", "\n", ["map"]),
  c("ts-import", "typescript", "import { readFile } from \"node:fs/", "\"\n", ["promises"]),
  c("ts-interface", "typescript", "export interface Point {\n  x: number\n  ", "\n}\n", ["y"]),
  c("ts-async", "typescript", "export async function loadJson(path: string): Promise<unknown> {\n  const text = await readFile(path, \"utf8\")\n  return ", "\n}\n", ["JSON.parse"]),
  c("ts-clamp", "typescript", "export function clamp(value: number, min: number, max: number): number {\n  ", "\n}\n", ["Math.min", "Math.max", "if"], true),
  c("ts-class", "typescript", "export class Counter {\n  #count = 0\n  increment(): number {\n    ", "\n  }\n}\n", ["count"], true),
  c("ts-switch", "typescript", "type Shape = { kind: \"circle\"; r: number } | { kind: \"square\"; s: number }\nexport function area(shape: Shape): number {\n  switch (shape.kind) {\n    case \"circle\":\n      ", "\n  }\n}\n", ["Math.PI", "r"], true),
  c("ts-suffix-aware", "typescript", "export function isEven(n: number): boolean {\n  return n ", " === 0\n}\n", ["% 2"]),
  c("ts-try", "typescript", "export function safeParse(text: string): unknown {\n  try {\n    return JSON.parse(text)\n  } ", "\n}\n", ["catch"], true),
  c("py-sum", "python", "def total(values: list[int]) -> int:\n    return ", "\n", ["sum"]),
  c("py-comprehension", "python", "def squares(values: list[int]) -> list[int]:\n    return [", "]\n", ["for", "**", "*"]),
  c("py-open", "python", "def read_lines(path: str) -> list[str]:\n    with open(path) as handle:\n        return ", "\n", ["read", "lines"]),
  c("py-class", "python", "class Stack:\n    def __init__(self) -> None:\n        self.items = []\n\n    def push(self, item) -> None:\n        ", "\n", ["append"]),
  c("py-pop", "python", "class Stack:\n    def __init__(self) -> None:\n        self.items = []\n\n    def pop(self):\n        return self.items.", "\n", ["pop"]),
  c("py-dict-get", "python", "def lookup(table: dict[str, int], key: str) -> int:\n    return table.", "\n", ["get"]),
  c("py-fib", "python", "def fib(n: int) -> int:\n    if n < 2:\n        return n\n    ", "\n", ["fib"], true),
  c("py-main", "python", "def main() -> None:\n    print(\"hi\")\n\n\nif __name__ == ", "\n", ["__main__"]),
  c("py-suffix-aware", "python", "def is_empty(items: list) -> bool:\n    return len(items) ", "\n", ["== 0"]),
  c("tsx-props", "typescriptreact", "type ButtonProps = { label: string; onClick: () => void }\nexport function Button({ label, onClick }: ButtonProps) {\n  return <button onClick={", "}>{label}</button>\n}\n", ["onClick"]),
  c("tsx-map", "typescriptreact", "export function List({ items }: { items: string[] }) {\n  return <ul>{items.", "}</ul>\n}\n", ["map", "li"]),
  c("tsx-state", "typescriptreact", "import { useState } from \"react\"\nexport function Toggle() {\n  const [on, setOn] = ", "\n  return <button onClick={() => setOn(!on)}>{on ? \"On\" : \"Off\"}</button>\n}\n", ["useState"]),
  c("tsx-effect", "typescriptreact", "import { useEffect } from \"react\"\nexport function Title({ text }: { text: string }) {\n  useEffect(() => {\n    document.title = ", "\n  }, [text])\n  return null\n}\n", ["text"]),
  c("tsx-disabled", "typescriptreact", "export function Next({ page, pages, go }: { page: number; pages: number; go: (p: number) => void }) {\n  return <button disabled={", "} onClick={() => go(page + 1)}>Next</button>\n}\n", ["page", "pages"]),
  c("tsx-component", "typescriptreact", "export function Card({ title, children }: { title: string; children: React.ReactNode }) {\n  return (\n    <section>\n      ", "\n    </section>\n  )\n}\n", ["title", "h"], true),
  c("js-require", "javascript", "const path = require(\"", "\")\n", ["path"]),
  c("js-arrow", "javascript", "export const double = (n) => ", "\n", ["n * 2", "2 * n", "n + n"]),
  c("js-loop", "javascript", "export function countVowels(text) {\n  let count = 0\n  for (const ch of text) {\n    ", "\n  }\n  return count\n}\n", ["count", "aeiou"], true),
]

const root = await mkdtemp(join(tmpdir(), "ovsc-ac-latency-"))
await mkdir(join(root, ".open-vs-code"), { recursive: true })
await writeFile(join(root, ".open-vs-code", "models.json"), JSON.stringify({
  providers: [{ id: "local", kind: "openai_compatible_local", baseUrl: endpoint }],
  models: [{ id: "fim", contextWindow: 32768, capabilities: ["autocomplete", "fim"], specialization: "coding", fimStrategy: "qwen", modelName: model }],
  deployments: [{ id: "dep-fim", providerId: "local", modelId: "fim", modelName: model, endpoint, enabled: true, priority: 10, fimStrategy: "qwen" }],
  routes: { autocomplete: ["dep-fim"], default: ["dep-fim"] },
}))
const gateway = createProductionAutocompleteGateway(root)
gateway.performanceLedger?.disableAdaptiveRouting()

async function complete(item: Case, signal: AbortSignal) {
  const started = performance.now()
  const response = await gateway.complete({ requestId: `${label}-${item.id}-${started}`, prefix: item.prefix, suffix: item.suffix, languageId: item.lang, maxOutputTokens: item.multi ? 96 : 32, signal })
  return { ms: performance.now() - started, text: response.text }
}

const cold = await complete(CASES[0]!, AbortSignal.timeout(120_000))
const rows = []
for (const item of CASES) {
  try {
    const { ms, text } = await complete(item, AbortSignal.timeout(30_000))
    rows.push({ id: item.id, lang: item.lang, multi: !!item.multi, ms: Math.round(ms), relevant: item.expect.some((token) => text.includes(token)), empty: text.trim() === "", text: text.slice(0, 160) })
  } catch (error) {
    rows.push({ id: item.id, lang: item.lang, multi: !!item.multi, ms: null, relevant: false, empty: true, error: error instanceof Error ? error.message : String(error) })
  }
}

// Cancellation: abort 50 ms into a multiline request and time how long the promise takes to settle.
const cancels = []
for (let i = 0; i < 5; i += 1) {
  const controller = new AbortController()
  const started = performance.now()
  const pending = complete(CASES[8]!, controller.signal).then(() => "completed", (error: Error) => error.name || "error")
  await new Promise((resolve) => setTimeout(resolve, 50))
  const abortedAt = performance.now()
  controller.abort()
  const outcome = await pending
  cancels.push({ outcome, settleAfterAbortMs: Math.round(performance.now() - abortedAt), totalMs: Math.round(performance.now() - started) })
}

const ok = rows.filter((row) => typeof row.ms === "number").map((row) => row.ms as number).toSorted((a, b) => a - b)
const pct = (p: number) => ok[Math.min(ok.length - 1, Math.ceil((p / 100) * ok.length) - 1)] ?? null
const summary = {
  label, model, endpoint, at: new Date().toISOString(),
  opportunities: rows.length, answered: ok.length, errors: rows.length - ok.length,
  coldFirstSuggestionMs: Math.round(cold.ms), medianMs: pct(50), p95Ms: pct(95),
  relevant: rows.filter((row) => row.relevant).length, empty: rows.filter((row) => row.empty).length,
  cancellation: cancels,
}
const out = join(process.cwd(), "evals", "results", `${label}.json`)
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`Wrote ${out}`)
await rm(root, { recursive: true, force: true })
