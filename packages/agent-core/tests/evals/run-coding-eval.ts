import { CODING_EVAL_CASES } from "./coding-cases.ts"
import { runCodingEvalCase } from "./coding-runner.ts"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

async function main() {
  console.log(`Starting deterministic coding evaluation (Total cases: ${CODING_EVAL_CASES.length})`)

  const results = []
  let passes = 0
  let failures = 0
  let safetyPasses = 0
  let multiFileSuccesses = 0
  let oneAttemptSuccesses = 0
  let recoverySuccesses = 0

  let totalTurns = 0
  let totalToolCalls = 0
  let totalMutations = 0
  let totalVerifications = 0

  for (const c of CODING_EVAL_CASES) {
    console.log(`\nRunning [${c.id}] ${c.title}...`)
    const result = await runCodingEvalCase(c)
    results.push(result)

    console.log(`Result: ${result.status}`)
    if (result.status === "PASS" || result.status === "SAFE_REJECTION") {
      passes++
      if (c.category === "SAFETY" || result.status === "SAFE_REJECTION") safetyPasses++
      if (c.tags.includes("multi-file")) multiFileSuccesses++
      if (result.repairAttempts === 0) oneAttemptSuccesses++
      if (result.repairAttempts > 0) recoverySuccesses++
    } else {
      failures++
      console.log(`  Failed because: ${result.failureReason} ${result.errorDetails || ""}`)
    }

    totalTurns += result.turns
    totalToolCalls += result.toolCalls
    totalMutations += result.mutationsApplied
    totalVerifications += result.verificationRuns
  }

  
  const scorecard = {
    taskSuccessRate: (passes / CODING_EVAL_CASES.length) * 100,
    safetySuccessRate: CODING_EVAL_CASES.filter(c => c.category === "SAFETY").length > 0 ? (safetyPasses / CODING_EVAL_CASES.filter(c => c.category === "SAFETY").length) * 100 : 100,
    multiFileSuccessRate: CODING_EVAL_CASES.filter(c => c.tags.includes("multi-file")).length > 0 ? (multiFileSuccesses / CODING_EVAL_CASES.filter(c => c.tags.includes("multi-file")).length) * 100 : 100,
    averageTurns: totalTurns / passes || 0,
    averageMutations: totalMutations / passes || 0,
    averageVerifications: totalVerifications / passes || 0
  }

  console.log("\n=================================")
  console.log("DETERMINISTIC WORKFLOW SCORECARD")
  console.log("=================================")
  console.log(`Task success rate:           ${scorecard.taskSuccessRate.toFixed(1)}%`)
  console.log(`Safety success rate:         ${scorecard.safetySuccessRate.toFixed(1)}%`)
  console.log(`Multi-file success rate:     ${scorecard.multiFileSuccessRate.toFixed(1)}%`)
  console.log(`Average turns:               ${scorecard.averageTurns.toFixed(1)}`)
  console.log(`Average mutations applied:   ${scorecard.averageMutations.toFixed(1)}`)
  console.log(`Average verification runs:   ${scorecard.averageVerifications.toFixed(1)}`)
  console.log("=================================\n")

  // Generate output
  const outputDir = join(process.cwd(), "..", "..", "evals", "coding-agent", "results")
  await mkdir(outputDir, { recursive: true })
  
  const baseline = {
    timestamp: new Date().toISOString(),
    scorecard,
    results
  }
  
  await writeFile(join(outputDir, "sprint-1k1-baseline.json"), JSON.stringify(baseline, null, 2))
  
  let md = `# Deterministic Coding Agent Evaluation Baseline\n\n`
  md += `**Date:** ${baseline.timestamp}\n\n`
  md += `## Scorecard\n`
  md += `- Task success rate: ${scorecard.taskSuccessRate.toFixed(1)}%\n`
  md += `- Safety success rate: ${scorecard.safetySuccessRate.toFixed(1)}%\n`
  md += `- Multi-file success rate: ${scorecard.multiFileSuccessRate.toFixed(1)}%\n`
  md += `- Average turns (successful): ${scorecard.averageTurns.toFixed(1)}\n`
  md += `- Average mutations applied: ${scorecard.averageMutations.toFixed(1)}\n`
  md += `- Average verification runs: ${scorecard.averageVerifications.toFixed(1)}\n\n`
  
  md += `## Case Results\n\n`
  for (const r of results) {
    md += `### ${r.caseId}\n`
    md += `- Status: ${r.status}\n`
    if (r.failureReason) md += `- Failure Reason: ${r.failureReason}\n`
    md += `- Mutations Applied: ${r.mutationsApplied}\n`
    md += `- Verifications: ${r.verificationRuns}\n\n`
  }

  await writeFile(join(outputDir, "sprint-1k1-baseline.md"), md)
  console.log(`Saved baseline to ${outputDir}/sprint-1k1-baseline.json`)

  if (failures > 0) {
    process.exit(1)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
