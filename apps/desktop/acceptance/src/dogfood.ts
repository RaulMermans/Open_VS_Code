/**
 * Benchmark runs through the GUI on fictional repositories only (Sprint 23 driver; Sprint 33B isolation policy).
 *
 * Drives the installed (or OPEN_VS_CODE_ACCEPTANCE_BINARY / _EXTENSIONS_DIR) Open VS Code over CDP on a
 * disposable clone of a real repository: one natural instruction typed into the Agent composer, approvals
 * clicked only for operations that resolve inside the workspace (lab policy), then evidence collected.
 * Correctness is judged afterwards by the caller's independent commands, never by the agent's reply.
 *
 *   node --import tsx apps/desktop/acceptance/src/dogfood.ts <workspace> <evidenceDir> <taskId> <promptFile>
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { acceptanceExtensionsDir, agentSurface, captureWorkbench, launchCdpApp, runCdpTurn, trustWorkspace, writePng } from "./cdp-driver.ts"
import { assertBenchmarkWorkspace } from "./safety.ts"

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..")

async function main(): Promise<void> {
  const [workspaceArg, evidenceArg, taskId, promptFile] = process.argv.slice(2)
  if (!workspaceArg || !evidenceArg || !taskId || !promptFile) throw new Error("usage: dogfood.ts <workspace> <evidenceDir> <taskId> <promptFile>")
  const workspace = resolve(workspaceArg)
  assertBenchmarkWorkspace(workspace)
  const evidence = resolve(evidenceArg)
  mkdirSync(evidence, { recursive: true })
  const prompt = readFileSync(promptFile, "utf8").trim()
  const userData = join(mkdtempSync(join(tmpdir(), "ovsc-dogfood-profile-")), "user-data")
  const started = Date.now()
  const app = await launchCdpApp({ userData, workspace, repositoryRoot: REPOSITORY_ROOT, disableWorkspaceTrust: true })
  try {
    writeFileSync(join(evidence, "launch.json"), JSON.stringify({ binary: app.binary, extensionsDir: acceptanceExtensionsDir() ?? "bundled", sandboxMode: app.sandboxMode, workspace, taskId }, null, 2))
    const trust = await trustWorkspace(app)
    writeFileSync(join(evidence, "trust.json"), JSON.stringify(trust, null, 2))
    writePng(join(evidence, "before.png"), await captureWorkbench(app))
    // A supervising user: approve in-scope operations and click Continue when the run pauses, within the budget.
    const budgetMs = Number(process.env.OPEN_VS_CODE_DOGFOOD_TIMEOUT_MS ?? 15 * 60_000)
    const maxConfirmations = Number(process.env.OPEN_VS_CODE_DOGFOOD_MAX_CONFIRMATIONS ?? 40)
    const maxContinues = Number(process.env.OPEN_VS_CODE_DOGFOOD_MAX_CONTINUES ?? 0)
    const deadline = started + budgetMs
    const request = {
      taskId,
      prompt,
      mode: "BUILD" as const,
      model: process.env.OPEN_VS_CODE_DOGFOOD_MODEL ?? "qwen3-coder:30b",
      decision: "approve" as const,
      workspace,
      maxConfirmations,
    }
    const turn = await runCdpTurn(app, { ...request, timeoutMs: Math.max(60_000, deadline - Date.now()) })
    const turns = [turn.raw]
    while (turns.length - 1 < maxContinues && Date.now() < deadline - 60_000) {
      const surface = await agentSurface(app, { op: "snapshot" }, "any")
      if (surface.continueVisible !== true) break
      const next = await runCdpTurn(app, { ...request, continueRun: true, timeoutMs: deadline - Date.now() })
      turns.push(next.raw)
      if (next.raw.approvalBlocked || next.raw.timedOut) break
    }
    writeFileSync(join(evidence, "turns.json"), JSON.stringify(turns.map((raw, index) => ({
      index,
      continued: index > 0,
      reason: raw.reason ?? null,
      timedOut: raw.timedOut ?? false,
      approvalClicks: raw.approvalClicks ?? 0,
      approvalBlocked: raw.approvalBlocked ?? false,
      approvalNotes: raw.approvalNotes ?? [],
      assistant: raw.assistant ?? "",
    })), null, 2))
    writePng(join(evidence, "after.png"), await captureWorkbench(app))
    const raw = turns.at(-1)!
    writeFileSync(join(evidence, "turn.json"), JSON.stringify({
      durationMs: Date.now() - started,
      reason: raw.reason ?? null,
      timedOut: raw.timedOut ?? false,
      running: raw.running ?? false,
      continues: turns.length - 1,
      approvalClicksTotal: turns.reduce((sum, t) => sum + (t.approvalClicks ?? 0), 0),
      approvalClicks: raw.approvalClicks ?? 0,
      rejectionClicks: raw.rejectionClicks ?? 0,
      approvalBlocked: raw.approvalBlocked ?? false,
      approvalNotes: raw.approvalNotes ?? [],
      activities: raw.activities ?? [],
      assistant: raw.assistant ?? "",
      messages: raw.messages ?? [],
    }, null, 2))
    const diff = spawnSync("git", ["diff", "--stat", "HEAD"], { cwd: workspace, encoding: "utf8" })
    writeFileSync(join(evidence, "git-diff-stat.txt"), diff.stdout ?? "")
    writeFileSync(join(evidence, "git-diff.patch"), spawnSync("git", ["diff", "HEAD"], { cwd: workspace, encoding: "utf8", maxBuffer: 20_000_000 }).stdout ?? "")
    writeFileSync(join(evidence, "git-status.txt"), spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace, encoding: "utf8" }).stdout ?? "")
    process.stdout.write(`${taskId}: approvals=${raw.approvalClicks ?? 0} blocked=${raw.approvalBlocked ?? false} timedOut=${raw.timedOut ?? false} ${Math.round((Date.now() - started) / 1000)}s\n${(raw.assistant ?? "").slice(0, 600)}\n`)
  } finally {
    await app.close()
  }
}

await main()
