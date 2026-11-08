import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadCatalog, type AcceptanceScenario } from "./catalog.ts"
import { executeScenario, notRun, type ScenarioResult } from "./execute.ts"
import { installedPackageVersion } from "./session.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = join(HERE, "..", "..", "..", "..")

function repeatCount(argv: readonly string[]): number {
  const flag = argv.find((arg) => arg.startsWith("--repeat"))
  if (!flag) return 1
  const value = flag.includes("=") ? flag.split("=")[1] : argv[argv.indexOf(flag) + 1]
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

function selected(catalog: readonly AcceptanceScenario[], arg: string | undefined): AcceptanceScenario[] {
  if (!arg || arg === "all") return [...catalog]
  if (arg === "smoke") {
    return catalog.filter((scenario) =>
      scenario.driver === "unit"
      || scenario.driver === "artifact"
      || scenario.id === "LIFE-SANDBOX"
      || scenario.id === "LIFE-FIRST"
      || scenario.id === "CONV-PING",
    )
  }
  const ids = new Set(arg.split(",").map((id) => id.trim()).filter(Boolean))
  return catalog.filter((scenario) => ids.has(scenario.id))
}

function scorecardMarkdown(input: {
  runId: string
  version: string
  binary: string
  results: readonly ScenarioResult[]
}): string {
  const counts = new Map<string, number>()
  for (const result of input.results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1)
  const lines = [
    "# Product acceptance scorecard",
    "",
    `Run \`${input.runId}\`. Installed package \`${input.version}\`. Binary \`${input.binary}\`.`,
    "",
    `PASS ${counts.get("PASS") ?? 0}, FAIL ${counts.get("FAIL") ?? 0}, NEEDS_REVIEW ${counts.get("NEEDS_REVIEW") ?? 0}, NOT_RUN ${counts.get("NOT_RUN") ?? 0}, BLOCKED ${counts.get("BLOCKED") ?? 0}.`,
    "",
    "A NOT_RUN row was not executed. A NEEDS_REVIEW row still needs a person to look at the screenshot. Neither counts as a pass.",
    "",
    "| Id | Verdict | Tier | Cause | Detail |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const result of input.results) {
    const cause = result.verdict === "PASS" || result.verdict === "NEEDS_REVIEW" ? "" : result.cause
    lines.push(`| ${result.id} | ${result.verdict} | ${result.tier} | ${cause} | ${result.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 180)} |`)
  }
  lines.push("")
  return lines.join("\n")
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`acceptance unhandledRejection ${reason instanceof Error ? reason.message : String(reason)}\n`)
})

async function main(): Promise<void> {
  const catalog = loadCatalog()
  const liveArg = process.argv.find((arg) => arg.startsWith("--live"))
  const liveValue = liveArg?.includes("=") ? liveArg.split("=")[1] : process.argv[process.argv.indexOf("--live") + 1]
  const cycles = repeatCount(process.argv)
  const execute = liveArg ? selected(catalog, liveValue) : catalog.filter((scenario) => scenario.driver === "unit" || scenario.driver === "artifact")
  const executeIds = new Set(execute.map((scenario) => scenario.id))
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const evidenceRoot = join(HERE, "..", "evidence", runId)
  mkdirSync(evidenceRoot, { recursive: true })
  const context = {
    runId,
    repositoryRoot: REPOSITORY_ROOT,
    evidenceRoot,
    startedVersion: installedPackageVersion(),
  }
  const results: ScenarioResult[] = []
  for (const scenario of catalog) {
    if (!executeIds.has(scenario.id)) {
      results.push(notRun(scenario, evidenceRoot))
      continue
    }
    const scenarioCycles = execute.length === 1 ? cycles : 1
    process.stderr.write(`acceptance ${scenario.id}${scenarioCycles > 1 ? ` x${scenarioCycles}` : ""}\n`)
    try {
      for (let cycle = 1; cycle <= scenarioCycles; cycle += 1) {
        const result = await executeScenario(scenario, scenarioCycles > 1 ? { ...context, cycle } : context)
        results.push(scenarioCycles > 1 ? { ...result, id: `${scenario.id}#${String(cycle).padStart(2, "0")}` } : result)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        id: scenario.id,
        title: scenario.title,
        tier: scenario.tier,
        group: scenario.group,
        verdict: "FAIL",
        cause: "tooling",
        oracle: scenario.oracle,
        forbidden: scenario.forbidden,
        timeoutMs: scenario.timeoutMs,
        durationMs: 0,
        evidencePath: join(evidenceRoot, scenario.id),
        detail: message,
      })
    }
    writeFileSync(join(evidenceRoot, "partial-results.json"), JSON.stringify(results, null, 2))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const binary = process.env.OPEN_VS_CODE_ACCEPTANCE_BINARY?.trim() || "/usr/lib/open-vs-code/open-vs-code"
  const payload = {
    runId,
    installedVersion: context.startedVersion,
    binary,
    sourceNote: "Results below were executed in this run. NOT_RUN was not executed.",
    results,
  }
  writeFileSync(join(evidenceRoot, "scorecard.json"), JSON.stringify(payload, null, 2))
  const markdown = scorecardMarkdown({ runId, version: context.startedVersion, binary, results })
  writeFileSync(join(evidenceRoot, "scorecard.md"), markdown)
  const latestDir = join(HERE, "..", "results")
  mkdirSync(latestDir, { recursive: true })
  writeFileSync(join(latestDir, "latest-scorecard.json"), JSON.stringify(payload, null, 2))
  writeFileSync(join(latestDir, "latest-scorecard.md"), markdown)
  process.stdout.write(markdown)
  const failed = results.some((result) => result.verdict === "FAIL")
  process.exitCode = failed ? 1 : 0
}

await main()
