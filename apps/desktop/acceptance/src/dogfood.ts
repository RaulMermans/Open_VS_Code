/**
 * Real-project dogfooding through the GUI (Sprint 23).
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
import { acceptanceExtensionsDir, captureWorkbench, launchCdpApp, runCdpTurn, trustWorkspace, writePng } from "./cdp-driver.ts"

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..")

async function main(): Promise<void> {
  const [workspaceArg, evidenceArg, taskId, promptFile] = process.argv.slice(2)
  if (!workspaceArg || !evidenceArg || !taskId || !promptFile) throw new Error("usage: dogfood.ts <workspace> <evidenceDir> <taskId> <promptFile>")
  const workspace = resolve(workspaceArg)
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
    const turn = await runCdpTurn(app, {
      taskId,
      prompt,
      mode: "BUILD",
      model: process.env.OPEN_VS_CODE_DOGFOOD_MODEL ?? "qwen3-coder:30b",
      timeoutMs: Number(process.env.OPEN_VS_CODE_DOGFOOD_TIMEOUT_MS ?? 15 * 60_000),
      decision: "approve",
      workspace,
      maxConfirmations: 40,
    })
    writePng(join(evidence, "after.png"), await captureWorkbench(app))
    const raw = turn.raw
    writeFileSync(join(evidence, "turn.json"), JSON.stringify({
      durationMs: Date.now() - started,
      reason: raw.reason ?? null,
      timedOut: raw.timedOut ?? false,
      running: raw.running ?? false,
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
