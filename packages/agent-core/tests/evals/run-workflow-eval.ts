import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runBiasEval, runComparison, runEligibilityEval, type ArmMeasurement } from "./workflow-eval.ts"

/**
 * `npm run eval:workflow` — Sprint 5B deterministic Structured Engineering Loop evaluation.
 * Simulated local model, real VerificationEngine checks, no network. Writes
 * evals/results/sprint-5b-workflow-eval.{json,md}. Latency is wall-clock and varies run to run.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const resultsDir = resolve(repoRoot, "evals/results")
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

const eligibility = runEligibilityEval()
const comparison = await runComparison()
const bias = await runBiasEval()

const report = { sprint: "5B", realModelWorkflowDelta: "DEFERRED_TO_HALO", eligibility, comparison, bias }

const row = (item: ArmMeasurement) => `| ${item.fixture} | ${item.kind} | ${item.arm} | ${item.outcome} | ${item.correct ? "yes" : "no"} | ${item.verificationRuns} | ${item.defectDetected ? "yes" : "-"} | ${item.modelCalls} | ${item.promptTokens} | ${item.peakContextTokens} | ${item.repairCycles} | ${item.approvals} |`
const summary = (label: string, value: (typeof comparison)["direct"]) => `| ${label} | ${value.correct}/${value.tasks} | ${value.verifiedTasks}/${value.tasks} | ${value.defectsDetected}/${value.defectsInjected} | ${value.modelCalls} | ${value.promptTokens} | ${value.peakContextTokens} | ${value.repairCycles} | ${value.approvals} | ${value.latencyMs} |`
const workflowRows = comparison.rows.filter((item) => item.arm === "workflow" && item.stageTokens)

const markdown = `# Sprint 5B — Structured Engineering Loop Evaluation (deterministic)

Real-model workflow delta: **DEFERRED_TO_HALO**. The model here is a deterministic local simulation that plays a fallible implementer and a scripted reviewer; TEST/VERIFY run each fixture's real \`npm test\` checker through VerificationEngine. Approvals are granted by the harness.

## Recorded fixture changes (made after the first run)

- E13 exposed a product bug, not a fixture problem: \`do not modify behaviour\` was classified read-only. The eligibility pattern now requires a file/code object.
- T4: the workspace gained \`tests/.gitkeep\`; MutationEngine (unchanged) refuses \`create_file\` under a missing parent directory.
- T5: the ground-truth checker wrongly rejected the intended fix (it contains \`return true\` for reader+list); it now checks reader+list is allowed and the admin check is kept.
- Direct arm: the simulated implementer ignored failing-verification feedback; it now applies its next attempt after a failure, mirroring the workflow's repair pass. Its defect detection is measured from \`verification.completed\` FAIL events.

## Eligibility

${eligibility.correct}/${eligibility.total} correct.

| Case | Expected | Eligible | Reason |
| --- | --- | --- | --- |
${eligibility.results.map((item) => `| ${item.id} | ${item.expected} | ${item.eligible} | ${item.reason} |`).join("\n")}

## Direct vs structured (mutating tasks)

| Arm | Correct | Verified | Defects caught | Model calls | Prompt tokens | Peak context | Repair cycles | Approvals | Latency ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${summary("A direct (workflow off)", comparison.direct)}
${summary("B structured (workflow on)", comparison.workflow)}

| Fixture | Kind | Arm | Outcome | Correct | Verification runs | Defect caught | Model calls | Prompt tokens | Peak context | Repairs | Approvals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${comparison.rows.map(row).join("\n")}

## Stage context (structured arm, peak estimated tokens per stage)

| Fixture | PLAN | IMPLEMENT | TEST | REVIEW | VERIFY | Structured peak | Monolithic estimate (lower bound) |
| --- | --- | --- | --- | --- | --- | --- | --- |
${workflowRows.map((item) => `| ${item.fixture} | ${item.stageTokens!.PLAN} | ${item.stageTokens!.IMPLEMENT} | ${item.stageTokens!.TEST} | ${item.stageTokens!.REVIEW} | ${item.stageTokens!.VERIFY} | ${item.peakContextTokens} | ${item.monolithicEstimateTokens} |`).join("\n")}

## Reviewer bias (pipeline, scripted reviewer)

True-positive rate ${percent(bias.truePositiveRate)} · false-positive rate ${percent(bias.falsePositiveRate)} · severity correctness ${percent(bias.severityCorrectness)}

| Case | Description | Real defect | Blocked | Kept | Dropped ungrounded | Severity | Expected | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${bias.results.map((item) => `| ${item.id} | ${item.description} | ${item.realDefect} | ${item.blocked} | ${item.keptFindings} | ${item.rejectedUngrounded} | ${item.severityClass} | ${item.expectedSeverityClass} | ${item.outcome} |`).join("\n")}
`

await mkdir(resultsDir, { recursive: true })
await writeFile(resolve(resultsDir, "sprint-5b-workflow-eval.json"), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(resolve(resultsDir, "sprint-5b-workflow-eval.md"), markdown)
console.log(markdown)
const failures = eligibility.total - eligibility.correct
process.exitCode = failures > 0 ? 1 : 0
