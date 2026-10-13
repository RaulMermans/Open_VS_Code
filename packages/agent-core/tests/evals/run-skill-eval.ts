import { writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { loadBuiltinRegistry, runEfficiencyBenchmark, runSelectionEval } from "./skill-eval.ts"

/**
 * `npm run eval:skills` — Sprint 5A deterministic skill-selection evaluation and context-efficiency
 * benchmark. No model, no network. Writes evals/results/sprint-5a-skills-eval.{json,md}.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const resultsDir = resolve(repoRoot, "evals/results")

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

const registry = await loadBuiltinRegistry()
const selection = runSelectionEval(registry)
const efficiency = await runEfficiencyBenchmark(registry)

const report = {
  sprint: "5A",
  realModelSkillDelta: "DEFERRED_TO_HALO",
  diagnostics: registry.diagnostics.length,
  selection,
  efficiency,
}

const misses = selection.results.filter((result) => !result.correct)
const markdown = `# Sprint 5A — Skill Runtime Evaluation (deterministic)

Real-model skill delta: **DEFERRED_TO_HALO** (no HALO baseline recorded; no model executed).

## Selection

| Metric | Value |
| --- | --- |
| Cases | ${selection.total} |
| Correct | ${selection.correct} (${percent(selection.accuracy)}) |
| Positive cases correct | ${selection.positiveCorrect}/${selection.positiveCases} |
| No-skill accuracy | ${selection.noSkillCorrect}/${selection.noSkillCases} (${percent(selection.noSkillAccuracy)}) |
| False positives (skill selected where none was acceptable) | ${selection.falsePositives} |
| Wrong skill selected | ${selection.wrongSkill} |
| False negatives (no skill where one was required) | ${selection.falseNegatives} |

${misses.length === 0 ? "No misses." : `Misses:\n\n${misses.map((miss) => `- ${miss.id} (${miss.kind}, ${miss.mode}): selected \`${miss.selected ?? "none"}\`, acceptable ${miss.acceptable.map((value) => `\`${value ?? "none"}\``).join(" / ")}`).join("\n")}`}

## Context efficiency

| Metric | Tokens |
| --- | --- |
| Seed skills | ${efficiency.totalSkills} |
| Eager baseline (all framed bodies) | ${efficiency.eagerTokens} |
| Metadata index | ${efficiency.indexTokens} |
| Average selected-skill body | ${efficiency.averageSelectedSkillTokens.toFixed(1)} |
| Average lazy prompt cost per task | ${efficiency.averageLazyPromptTokens.toFixed(1)} |
| Average lazy cost incl. index | ${efficiency.averageLazyWithIndexTokens.toFixed(1)} |
| Tokens avoided per task | ${efficiency.tokensAvoidedPerTask.toFixed(1)} |
| Reduction | ${efficiency.reductionPercent.toFixed(1)}% |
| Reduction incl. index | ${efficiency.reductionWithIndexPercent.toFixed(1)}% |

Per skill: ${efficiency.perSkill.map((skill) => `\`${skill.id}\` ${skill.bodyTokens}`).join(", ")}.

Token counts use the runtime estimator (\`ceil(chars / 4)\`), the same one the context budget enforces.
`

await mkdir(resultsDir, { recursive: true })
await writeFile(resolve(resultsDir, "sprint-5a-skills-eval.json"), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(resolve(resultsDir, "sprint-5a-skills-eval.md"), markdown)
console.log(markdown)
