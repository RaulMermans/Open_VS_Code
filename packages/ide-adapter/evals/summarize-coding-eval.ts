/**
 * Summarizes one or more Sprint 21 coding evaluation result files.
 *   node --import tsx/esm packages/ide-adapter/evals/summarize-coding-eval.ts evals/results/sprint-21-coding-A-ALL.json evals/results/sprint-21-coding-B-ALL.json
 */
import { readFile } from "node:fs/promises"

interface Row {
  id: string
  split: string
  category: string
  pass: boolean
  codeCorrect: boolean
  falseCompletion: boolean
  timedOut: boolean
  unauthorized: string[]
  durationMs: number
  writeApprovals: number
  commandApprovals: number
  phases: Array<{ status: string; failureReason?: string; turns: number; patchAttempts: number; patchApplied: number; failedToolCalls: number; deniedToolCalls: number }>
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "n/a" : `${numerator}/${denominator} (${Math.round((numerator / denominator) * 100)}%)`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

for (const file of process.argv.slice(2)) {
  const { meta, rows } = JSON.parse(await readFile(file, "utf8")) as { meta: Record<string, unknown>; rows: Row[] }
  console.log(`\n## ${meta.label} — ${file}`)
  console.log(`source ${meta.sourceHead} dirty=${meta.trackedDirty} model ${meta.model} ${String(meta.modelDigest).slice(0, 12)}`)
  for (const split of ["DEV", "HELD_OUT", "ALL"]) {
    const subset = rows.filter((row) => split === "ALL" || row.split === split)
    if (subset.length === 0) continue
    const phases = subset.map((row) => row.phases.at(-1)!)
    const patchAttempts = subset.reduce((sum, row) => sum + row.phases.reduce((s, p) => s + p.patchAttempts, 0), 0)
    const patchApplied = subset.reduce((sum, row) => sum + row.phases.reduce((s, p) => s + p.patchApplied, 0), 0)
    console.log(`${split.padEnd(8)} pass ${pct(subset.filter((row) => row.pass).length, subset.length)} | completed ${pct(phases.filter((p) => p.status === "COMPLETED").length, subset.length)} | false-completion ${subset.filter((row) => row.falseCompletion).length} | out-of-scope writes (approved) ${subset.filter((row) => row.unauthorized.length > 0).length} | timeouts ${subset.filter((row) => row.timedOut).length} | patch applicability ${pct(patchApplied, patchAttempts)} | median turns ${median(phases.map((p) => p.turns))} | median s ${Math.round(median(subset.map((row) => row.durationMs)) / 1000)} | failed calls ${subset.reduce((s, row) => s + row.phases.reduce((t, p) => t + p.failedToolCalls, 0), 0)} | denied calls ${subset.reduce((s, row) => s + row.phases.reduce((t, p) => t + p.deniedToolCalls, 0), 0)}`)
  }
  const categories = [...new Set(rows.map((row) => row.category))]
  console.log(categories.map((category) => {
    const subset = rows.filter((row) => row.category === category)
    return `${category} ${subset.filter((row) => row.pass).length}/${subset.length}`
  }).join(" · "))
  console.log("failures: " + rows.filter((row) => !row.pass).map((row) => `${row.id}(${row.phases.at(-1)!.status}${row.phases.at(-1)!.failureReason ? "/" + row.phases.at(-1)!.failureReason : ""})`).join(", "))
}
