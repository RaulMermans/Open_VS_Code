import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { FIXTURES, runProgressEval, type ArmResult } from "./progress-eval.ts"

/**
 * `npm run eval:progress` — Sprint 5C deterministic non-progress detection & recovery evaluation.
 * Simulated local model, no network. Writes evals/results/sprint-5c-progress-eval.{json,md}.
 * Exits non-zero if a known loop is missed or a fixture with measurable progress is stopped.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const resultsDir = resolve(repoRoot, "evals/results")
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

const report = await runProgressEval()
const { detection, recovery, efficiency } = report
const title = new Map(FIXTURES.map((fixture) => [fixture.id, fixture]))
const row = (item: ArmResult) => {
  const fixture = title.get(item.fixture)!
  return `| ${item.fixture} | ${fixture.path} | ${fixture.expected} | ${item.arm} | ${item.outcome} | ${item.stallDetected ? "yes" : "no"} | ${item.signals.join(", ") || "-"} | ${item.failureClass ?? "-"} | ${item.recoveryAttempted ? "yes" : "no"} | ${item.recoveryOutcome ?? "-"} | ${item.modelCalls} | ${item.toolCalls} | ${item.promptTokens} | ${item.turns} |`
}

const markdown = `# Sprint 5C — Non-Progress Detection & Recovery Evaluation (deterministic)

Real-model non-progress delta: **DEFERRED_TO_HALO**. The model is a deterministic local simulation. It behaves the same in both arms; a compact recovery context does not make it smarter. So these numbers measure the detector and the bounded recovery machinery, not how a real model responds to them. Thresholds are the shipped defaults (2 repeats, window 3), and they were not tuned per fixture.

A = progress monitor disabled (Sprint 5B behaviour) · B = enabled.

## Recorded changes after the first run

- The first run missed fixture E and caught A only through the 3-cycle window, not on the second identical failure. The cause was a product gap: the failure normalizer did not strip node:test's own TAP footer (\`# duration_ms 12.345\`), so identical failures got different fingerprints. The normalizer now strips duration fields, and unit test P-04b covers it. Thresholds were not changed.
- Fixture G had a fixture bug: its patch target \`a + b\` also matched \`add()\`, so the patch failed in both arms. G now uses a genuine one-character fix (\`a - a\` → \`a - b\`).

- Sprint 5D closure: fixture J adds the progress-epoch case. A real stall is recovered, new evidence opens a new epoch, and the old action is reused. It must complete; before epochs it was blocked by an inherited repetition count.

## Fixtures

${FIXTURES.map((fixture) => `- **${fixture.id}** (${fixture.path}, expected ${fixture.expected}${fixture.expectedClass ? `, ${fixture.expectedClass}` : ""}): ${fixture.title}`).join("\n")}

## Detection (arm B)

| Metric | Value |
| --- | --- |
| Known loops detected | ${detection.loopsDetected}/${detection.loopFixtures} (${percent(detection.trueStallRate)}) |
| False stalls on fixtures with measurable progress | ${detection.falseStalls}/${detection.progressFixtures} (${percent(detection.falseStallRate)}) |
| Failure classification accuracy (detected loops) | ${detection.classified}/${detection.loopsDetected} (${percent(detection.classificationAccuracy)}) |
| Misses | ${detection.misses.length === 0 ? "none" : detection.misses.join("; ")} |

## Recovery (arm B)

| Metric | Value |
| --- | --- |
| Stalls detected | ${recovery.stallsDetected} |
| Stalls correctly classified | ${recovery.stallsCorrectlyClassified} |
| Diagnostic checks run | ${recovery.diagnosticsRun} |
| Recovery attempts | ${recovery.recoveriesAttempted} |
| Recovered (state then demonstrably progressed) | ${recovery.recovered} (${percent(recovery.recoverySuccessRate)} of attempts) |
| Blocked after the bounded retry | ${recovery.blockedAfterBoundedRetry} |
| Escalated without retry (environment/permission/state) | ${recovery.escalatedWithoutRetry} |
| Unnecessary recoveries (on progress fixtures) | ${recovery.unnecessaryRecoveries} (${percent(recovery.unnecessaryRecoveryRate)}) |

## Efficiency (A vs B, all fixtures)

| Metric | A (off) | B (on) | Δ |
| --- | --- | --- | --- |
| Model calls | ${efficiency.modelCalls.A} | ${efficiency.modelCalls.B} | ${efficiency.modelCalls.B - efficiency.modelCalls.A} |
| Tool + check calls | ${efficiency.toolCalls.A} | ${efficiency.toolCalls.B} | ${efficiency.toolCalls.B - efficiency.toolCalls.A} |
| Prompt tokens (estimated) | ${efficiency.promptTokens.A} | ${efficiency.promptTokens.B} | ${efficiency.netTokenDifference} |
| Average model turns before a blocker | ${efficiency.averageTurnsBeforeBlocker.A} | ${efficiency.averageTurnsBeforeBlocker.B} | ${(efficiency.averageTurnsBeforeBlocker.B - efficiency.averageTurnsBeforeBlocker.A).toFixed(2)} |

- Repeated model calls avoided: ${efficiency.repeatedModelCallsAvoided}.
- Repeated tool/check calls avoided: ${efficiency.repeatedToolCallsAvoided}.
- Diagnostic checks added: ${efficiency.diagnosticCallsAdded}. They are deterministic and read-only; model calls added by diagnostics: ${efficiency.diagnosticModelCallsAdded}.
- Net token difference (B − A): ${efficiency.netTokenDifference}.

## Per fixture

| Fixture | Path | Expected | Arm | Outcome | Stall | Signals | Class | Recovery | Recovery outcome | Model calls | Tool+check calls | Prompt tokens | Turns |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${report.rows.map(row).join("\n")}
`

await mkdir(resultsDir, { recursive: true })
await writeFile(resolve(resultsDir, "sprint-5c-progress-eval.json"), `${JSON.stringify({ sprint: "5C", realModelNonProgressDelta: "DEFERRED_TO_HALO", ...report }, null, 2)}\n`)
await writeFile(resolve(resultsDir, "sprint-5c-progress-eval.md"), markdown)
console.log(markdown)
process.exitCode = detection.loopsDetected === detection.loopFixtures && detection.falseStalls === 0 && detection.misses.length === 0 ? 0 : 1
