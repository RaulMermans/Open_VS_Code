import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runLearningEval } from "./learning-eval.ts"

/**
 * `npm run eval:learning` — Sprint 5D deterministic learning evaluation. No model, no network.
 * Writes evals/results/sprint-5d-learning-eval.{json,md}. Exits non-zero if a contract fixture
 * fails, a false promotion occurs, or a safety probe gets through.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const resultsDir = resolve(repoRoot, "evals/results")
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

const report = await runLearningEval()
const { metrics, tokens } = report

const markdown = `# Sprint 5D — Learning Evaluation (deterministic)

No model is involved. These numbers measure the learning layer's decisions: classification, dedupe, evidence thresholds, approval gating and safety. They do not measure whether approved learning makes a real model better. That is the HALO benchmark (**DEFERRED_TO_HALO**). Thresholds are the shipped defaults; nothing was tuned per fixture.

## Contract fixtures (A–J)

| Fixture | Scenario | Expected | Actual | Result |
| --- | --- | --- | --- | --- |
${report.fixtures.map((item) => `| ${item.id} | ${item.title} | ${item.expected} | ${item.actual} | ${item.pass ? "PASS" : "FAIL"} |`).join("\n")}

## Quality metrics

| Metric | Value |
| --- | --- |
| Contract fixtures passed | ${metrics.fixturesPassed}/${metrics.fixtures} |
| Project-vs-reusable classification | ${metrics.classificationCorrect}/${metrics.classificationTotal} (${percent(metrics.classificationCorrect / metrics.classificationTotal)}) |
| Dedupe pair decisions correct | ${metrics.dedupePairsCorrect}/${metrics.dedupePairs} (${metrics.dedupeRecords} records for ${metrics.dedupeGroups} paraphrase groups) |
| Skill candidates produced / expected | ${metrics.candidatesProduced} / ${metrics.candidatesExpected} |
| Candidate precision | ${percent(metrics.candidatePrecision)} |
| False promotions (fixtures A, C, D) | ${metrics.falsePromotions}/${metrics.falsePromotionFixtures} |
| Malicious repository text trusted | ${metrics.maliciousRejected ? 0 : "≥1"}/${metrics.maliciousProbes} |
| Permission-escalation candidates rejected | ${metrics.escalationRejected ? `${metrics.escalationProbes}/${metrics.escalationProbes}` : "not all"} |
| Stale memory excluded from retrieval | ${metrics.staleHandled ? "yes" : "no"} |

### Classification misses

${metrics.classification.filter((item) => !item.correct).map((item) => `- "${item.title}": expected ${item.expected}, got ${item.actual}`).join("\n") || "- none"}

These misses are kept as measured. The classifier errs towards PROJECT when a lesson names a path, file, version or tool. A project-specific lesson without such a marker can therefore pass as reusable. That still cannot become a skill without 3 independent verified tasks and human approval.

## Token efficiency: structured records vs transcript persistence

Transcript-style memory does not exist in this repository and was not built. Its size is estimated from the **measured** prompt tokens of the Sprint 5B workflow-arm fixtures (${tokens.measuredTaskPromptTokens.join(", ")} tokens per task). That is a lower bound: completions and tool output are excluded.

| Measure (${tokens.tasks} completed tasks) | Transcript (estimated) | Structured records |
| --- | --- | --- |
| Stored tokens (whole store) | ${tokens.transcript.storedTokens} | ${tokens.structured.storedTokens} (${tokens.structured.records} records at ${tokens.structured.averageRecordTokens} tokens each; skill candidates ${tokens.structured.candidateTokens}) |
| Retrieved tokens per prompt | ${tokens.transcript.retrievedTokensPerPrompt} (all history) | ${tokens.structured.retrievedTokensPerPrompt} (average; budget ${tokens.structured.memoryBudgetTokens}) |
| Rendered tokens per record in a prompt | n/a | ${tokens.structured.averageRenderedRecordTokens} |

- Stored reduction: ${percent(tokens.storedReduction)}. Per-prompt reduction: ${percent(tokens.promptReduction)}.

| Query | Selected | Useful | Records not injected | Tokens |
| --- | --- | --- | --- | --- |
${tokens.retrievals.map((item) => `| ${item.task} | ${item.selected} | ${item.useful} | ${item.irrelevantAvoided} | ${item.retrievedTokens} |`).join("\n")}

Only APPROVED, non-stale records are retrievable. Candidates and observations are never injected. Decisions and toolchain facts are always eligible, so the "Explain the README" query still receives them. That is deliberate: they are critical project facts.
`

await mkdir(resultsDir, { recursive: true })
await writeFile(resolve(resultsDir, "sprint-5d-learning-eval.json"), `${JSON.stringify({ sprint: "5D", realModelLearningDelta: "DEFERRED_TO_HALO", ...report }, null, 2)}\n`)
await writeFile(resolve(resultsDir, "sprint-5d-learning-eval.md"), markdown)
console.log(markdown)
const safe = metrics.falsePromotions === 0 && metrics.maliciousRejected && metrics.escalationRejected && metrics.staleHandled
process.exitCode = metrics.fixturesPassed === metrics.fixtures && safe ? 0 : 1
