import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { AcceptanceScenario, ScenarioExpected } from "./catalog.ts"
import {
  assistantTextForTurn,
  clickDecision,
  readMessages,
  openAgentSurface,
  requireChat,
  resolveChatSurface,
  selectModel,
  sendPrompt,
  waitForApproval,
  waitForTurnAssistant,
  WebviewLifecycleLog,
  workbenchPage,
  type ChatSurface,
} from "./chat-surface.ts"
import { classifyPingContent, gitCleanProblems, sourceDigest, trustStateFromWorkbench } from "./oracles.ts"
import { assertApprovalTarget, assertIsolatedPath, liveProfileDirs } from "./safety.ts"
import {
  acceptanceBinary,
  installedPackageVersion,
  launchLab,
  launcherExportsInference,
  trustFolder,
  type LabSession,
} from "./session.ts"
import { fileDigest, gitPorcelain, materializeFixture, resolvedAbsent, runOracleCommand, workspaceDigest } from "./workspace.ts"

export type Verdict = "PASS" | "FAIL" | "NOT_RUN" | "NEEDS_REVIEW" | "BLOCKED"
export type FailureCause =
  | "model"
  | "context"
  | "tooling"
  | "orchestration"
  | "permission"
  | "presentation"
  | "persistence"
  | "packaging"
  | "environment"
  | "not_executed"
  | "none"

export interface ScenarioResult {
  readonly id: string
  readonly title: string
  readonly tier: string
  readonly group: string
  readonly verdict: Verdict
  readonly cause: FailureCause
  readonly oracle: string
  readonly forbidden: readonly string[]
  readonly timeoutMs: number
  readonly durationMs: number
  readonly evidencePath: string
  readonly detail: string
}

export interface RunContext {
  readonly runId: string
  readonly repositoryRoot: string
  readonly evidenceRoot: string
  readonly startedVersion: string
  readonly cycle?: number
}

function failuresForText(text: string, expected: ScenarioExpected): string[] {
  const problems: string[] = []
  for (const needle of expected.transcriptIncludes ?? []) {
    if (!text.includes(needle)) problems.push(`missing text: ${needle}`)
  }
  const any = expected.transcriptIncludesAny ?? []
  if (any.length > 0 && !any.some((needle) => text.includes(needle))) {
    problems.push(`missing any of: ${any.join(", ")}`)
  }
  for (const needle of expected.transcriptExcludes ?? []) {
    if (text.includes(needle)) problems.push(`forbidden text: ${needle}`)
  }
  return problems
}

function filesystemProblems(workspace: string, before: Record<string, string>, expected: ScenarioExpected): string[] {
  const problems: string[] = []
  const after = sourceDigest(workspaceDigest(workspace))
  const initial = sourceDigest(before)
  if (expected.filesUnchanged || expected.gitClean) {
    if (expected.filesUnchanged && JSON.stringify(initial) !== JSON.stringify(after)) problems.push("workspace bytes changed")
    if (expected.gitClean) {
      problems.push(...gitCleanProblems(gitPorcelain(workspace), Object.keys(workspaceDigest(workspace))))
    }
  }
  for (const relativePath of expected.unchangedPaths ?? []) {
    if (fileDigest(join(workspace, relativePath)) !== (before[relativePath] ?? null)) {
      problems.push(`changed path: ${relativePath}`)
    }
  }
  for (const relativePath of expected.absentPaths ?? []) {
    const target = resolvedAbsent(workspace, relativePath)
    if (existsSync(target)) problems.push(`forbidden path exists: ${target}`)
  }
  if (expected.command) {
    const code = runOracleCommand(workspace, expected.command.cmd, expected.command.args)
    if (code !== expected.command.exitCode) problems.push(`oracle ${expected.command.cmd} exited ${code}, expected ${expected.command.exitCode}`)
  }
  return problems
}

function writeEvidence(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

async function screenshot(session: LabSession, dir: string, name: string, required: boolean): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const page = await workbenchPage(session.app, 5000).catch(() => session.page)
  try {
    await page.screenshot({ path: join(dir, name) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeEvidence(dir, `${name}.error.txt`, message)
    if (required) throw new Error(`Required screenshot ${name} failed: ${message}`)
  }
}

export async function executeScenario(scenario: AcceptanceScenario, context: RunContext): Promise<ScenarioResult> {
  const started = Date.now()
  const evidencePath = context.cycle
    ? join(context.evidenceRoot, scenario.id, `cycle-${String(context.cycle).padStart(2, "0")}`)
    : join(context.evidenceRoot, scenario.id)
  mkdirSync(evidencePath, { recursive: true })
  try {
    const detail = await runScenario(scenario, context, evidencePath)
    const failed = detail.startsWith("FAIL:")
    const blocked = detail.startsWith("BLOCKED:")
    const verdict: Verdict = blocked
      ? "BLOCKED"
      : failed
        ? "FAIL"
        : scenario.driver === "review"
          ? "NEEDS_REVIEW"
          : "PASS"
    return {
      id: scenario.id,
      title: scenario.title,
      tier: scenario.tier,
      group: scenario.group,
      verdict,
      cause: blocked || failed ? causeFor(scenario, detail) : "none",
      oracle: scenario.oracle,
      forbidden: scenario.forbidden,
      timeoutMs: scenario.timeoutMs,
      durationMs: Date.now() - started,
      evidencePath,
      detail: detail.replace(/^(FAIL|BLOCKED):\s*/, ""),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeEvidence(evidencePath, "error.txt", error instanceof Error ? `${message}\n${error.stack ?? ""}` : message)
    return {
      id: scenario.id,
      title: scenario.title,
      tier: scenario.tier,
      group: scenario.group,
      verdict: "FAIL",
      cause: causeFor(scenario, message),
      oracle: scenario.oracle,
      forbidden: scenario.forbidden,
      timeoutMs: scenario.timeoutMs,
      durationMs: Date.now() - started,
      evidencePath,
      detail: error instanceof Error ? `${message} :: ${(error.stack ?? "").split("\n").slice(1, 4).join(" | ")}` : message,
    }
  }
}

function causeFor(scenario: AcceptanceScenario, detail: string): FailureCause {
  if (detail.includes("--no-sandbox") || detail.includes("chrome-sandbox") || detail.includes("dpkg")) return "packaging"
  if (detail.includes("composer") || detail.includes("selector") || detail.includes("Send not") || detail.includes("webview") || detail.includes("screenshot")) return "tooling"
  if (detail.includes("forbidden text") || detail.includes("<tool_call") || detail.includes("protocol leak")) return "presentation"
  if (detail.includes("oracle") || detail.includes("exited")) return "model"
  if (detail.includes("Restricted Mode") || detail.includes("trust")) return "permission"
  if (scenario.group === "safety") return "permission"
  if (scenario.group === "lifecycle") return "persistence"
  return "orchestration"
}

async function runScenario(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  if (scenario.driver === "unit") return runUnit(scenario, context.repositoryRoot)
  if (scenario.driver === "artifact") return runArtifact(scenario, context)
  return runElectron(scenario, context, evidencePath)
}

function runUnit(scenario: AcceptanceScenario, repositoryRoot: string): string {
  if (scenario.id === "SAFE-NO-SILENT") {
    let threw = false
    try {
      assertApprovalTarget(repositoryRoot, repositoryRoot, "approve")
    } catch {
      threw = true
    }
    if (!threw) return "FAIL: approval was accepted for the product repository"
    return "Approval helper rejects the product repository."
  }
  if (scenario.id === "SAFE-PROFILE") {
    const accepted: string[] = []
    for (const candidate of [...liveProfileDirs(), repositoryRoot]) {
      try {
        assertIsolatedPath(candidate, "Acceptance profile")
        accepted.push(candidate)
      } catch {
        // This path is outside the lab temp root, which is the required refusal.
      }
    }
    if (accepted.length > 0) return `FAIL: profile guard accepted ${accepted.join(", ")}`
    const live = liveProfileDirs()
    return live.length > 0
      ? `Refused ${live.length} live profile directory(s) and the product repository.`
      : "No live profile directory was present. The product repository was refused."
  }
  return `FAIL: no unit implementation for ${scenario.id}`
}

function runArtifact(scenario: AcceptanceScenario, context: RunContext): string {
  if (scenario.id === "LIFE-UPGRADE") {
    const now = installedPackageVersion()
    if (now !== context.startedVersion) return `FAIL: installed version changed from ${context.startedVersion} to ${now}`
    if (!now) return "FAIL: open-vs-code is not installed"
    return `Installed version stayed ${now}. This run did not install a package.`
  }
  if (scenario.id === "LIFE-ROLLBACK") {
    const deb = join(context.repositoryRoot, "apps", "desktop", "dist", "open-vs-code_0.1.0-rc.11_amd64.deb")
    if (!existsSync(deb)) return `FAIL: rollback package is missing at ${deb}`
    const now = installedPackageVersion()
    if (now === "0.1.0-rc.11") return "FAIL: the rollback package is the installed daily driver"
    return `Rollback package is on disk and was not installed. Daily driver is ${now}.`
  }
  return `FAIL: no artifact implementation for ${scenario.id}`
}

function freshRunDir(prefix: string): { root: string; userData: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    userData: join(root, "user-data"),
    workspace: join(root, "workspace"),
  }
}

async function runElectron(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const dirs = freshRunDir(`ovsc-accept-${scenario.id}-`)
  materializeFixture(scenario.fixture, dirs.workspace)
  const before = workspaceDigest(dirs.workspace)
  writeEvidence(evidencePath, "workspace.txt", dirs.workspace)
  const session = await launchLab({
    userData: dirs.userData,
    workspace: dirs.workspace,
    repositoryRoot: context.repositoryRoot,
  })
  const log = new WebviewLifecycleLog(join(evidencePath, "webview-lifecycle.jsonl"))
  log.attachApp(session.app)
  try {
    writeEvidence(evidencePath, "argv.txt", session.argv.join("\n"))
    await workbenchPage(session.app, 30000)
    await screenshot(session, evidencePath, "window.png", false)
    if (scenario.id === "LIFE-SANDBOX") return sandboxDetail(session)
    if (scenario.id === "LIFE-CRASH") return crashDetail(session, dirs.userData)
    if (scenario.id === "SAFE-STALE") return staleDetail(session, dirs.workspace, before, scenario.expected)
    if (scenario.id === "LIFE-SECOND-REPO") {
      await session.close()
      return secondRepoDetail(dirs.workspace, dirs.userData, before, context)
    }
    const page = await workbenchPage(session.app)
    await trustFolder(page, scenario.trust)
    if (scenario.trust === "trusted") {
      const body = await page.locator("body").innerText()
      if (trustStateFromWorkbench(body) === "restricted") {
        return "FAIL: workspace remained in Restricted Mode after the trust control was used"
      }
    }
    const iframeInventory = await page.locator("iframe").evaluateAll((nodes) =>
      nodes.map((node) => ({
        className: (node as HTMLIFrameElement).className,
        id: (node as HTMLIFrameElement).id,
        src: String((node as HTMLIFrameElement).src || "").split("?")[0].slice(0, 160),
      })),
    ).catch((error) => [{ error: error instanceof Error ? error.message : String(error) }])
    writeEvidence(evidencePath, "iframes.json", JSON.stringify(iframeInventory, null, 2))
    const iframe = page.locator("iframe.webview, iframe.webview-internal").last()
    const iframeVisible = await iframe.isVisible({ timeout: 20000 }).catch(() => false)
    if (!iframeVisible) await openAgentSurface(session.app, log)
    const surface: ChatSurface = scenario.driver === "electron-chat"
      ? {
          page,
          root: page.frameLocator("iframe.webview").last(),
          locator: (selector: string) => page.locator(selector),
        }
      : await requireChat(session, 15000, log)
    log.record("composer-ready", iframeVisible ? "iframe-visible" : "resolved")
    if (scenario.driver !== "electron-chat") {
      await screenshot(session, evidencePath, "chat.png", scenario.driver === "review")
    }
    if (scenario.id === "LIFE-FIRST") return firstLaunchDetail(surface, scenario.expected)
    if (scenario.id === "UX-TRUST") return trustDetail(session)
    if (scenario.id === "UX-KEYS") return keysDetail(surface)
    if (scenario.id === "UX-MODELS") return modelsDetail(session, log, scenario.expected)
    if (scenario.id === "UX-WIDE") return wideDetail(session, surface, log)
    if (scenario.id === "LIFE-MODEL") return modelPersistenceDetail(session, surface, scenario, context, log)
    if (scenario.driver === "review" && !scenario.prompt) {
      await screenshot(session, evidencePath, "review.png", true)
      return "Screenshot captured for human review."
    }
    if (!scenario.prompt && scenario.driver !== "electron-chat" && scenario.driver !== "review") {
      return `FAIL: no electron flow for ${scenario.id}`
    }
    return chatDetail(session, surface, scenario, context, before, evidencePath, log)
  } finally {
    writeEvidence(evidencePath, "webview-lifecycle-summary.json", JSON.stringify(log.snapshot(session.app), null, 2))
    await session.close().catch(() => undefined)
  }
}

function sandboxDetail(session: LabSession): string {
  const flat = session.argv.join(" ")
  const problems: string[] = []
  if (flat.includes("--no-sandbox")) problems.push("argv contains --no-sandbox")
  if (session.sandboxMode !== "4755") problems.push(`chrome-sandbox mode is ${session.sandboxMode}`)
  if (!launcherExportsInference()) problems.push("launcher does not export OPEN_VS_CODE_REAL_INFERENCE=1")
  const dataDir = flat.match(/--user-data-dir=(\S+)/)?.[1]
  if (!dataDir) problems.push("isolated user-data-dir was not passed")
  else {
    try {
      assertIsolatedPath(dataDir, "Acceptance profile")
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return `Sandbox mode ${session.sandboxMode}. Argv has no --no-sandbox. Profile ${dataDir}. Binary ${acceptanceBinary()}.`
}

async function crashDetail(session: LabSession, userData: string): Promise<string> {
  const settings = join(userData, "User", "settings.json")
  process.kill(session.pid, "SIGKILL")
  await new Promise((resolve) => setTimeout(resolve, 500))
  JSON.parse(readFileSync(settings, "utf8"))
  return "Profile settings.json is still valid JSON after SIGKILL."
}

function staleDetail(session: LabSession, workspace: string, before: Record<string, string>, expected: ScenarioExpected): string {
  process.kill(session.pid, "SIGKILL")
  const problems = filesystemProblems(workspace, before, expected)
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return "Killing the window left the fixture bytes unchanged."
}

async function secondRepoDetail(firstWorkspace: string, sharedUserData: string, before: Record<string, string>, context: RunContext): Promise<string> {
  const dirs = freshRunDir("ovsc-accept-second-")
  materializeFixture("bug", dirs.workspace)
  const session = await launchLab({
    userData: sharedUserData,
    workspace: dirs.workspace,
    repositoryRoot: context.repositoryRoot,
  })
  await session.close()
  const problems = filesystemProblems(firstWorkspace, before, { filesUnchanged: true })
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return "A second isolated repository launched with the shared lab profile and left the first fixture unchanged."
}

async function firstLaunchDetail(surface: ChatSurface, expected: ScenarioExpected): Promise<string> {
  await surface.locator("#empty-state").waitFor({ state: "visible", timeout: 15000 })
  await surface.locator("#composer").waitFor({ state: "visible", timeout: 15000 })
  const started = Date.now()
  let text = ""
  while (Date.now() - started < 15000) {
    text = await surface.locator("#empty-state").innerText()
    if (failuresForText(text, expected).length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const problems = failuresForText(text, expected)
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}. empty-state: ${JSON.stringify(text).slice(0, 300)}`
  return "Fresh profile shows the empty-state copy."
}

async function trustDetail(session: LabSession): Promise<string> {
  const page = await workbenchPage(session.app)
  const text = await page.locator("body").innerText()
  if (trustStateFromWorkbench(text) === "unknown" && !text.includes("Trust")) {
    return "FAIL: missing Restricted Mode or a trust prompt"
  }
  return "Untrusted folder shows a trust restriction."
}

async function keysDetail(surface: ChatSurface): Promise<string> {
  const composer = surface.locator("#composer")
  await composer.click()
  await composer.fill("line")
  await composer.press("Shift+Enter")
  await composer.pressSequentially("two")
  const value = await composer.inputValue()
  const running = await surface.locator("#cancel-btn").isVisible().catch(() => false)
  if (running) return "FAIL: Shift+Enter started a turn"
  if (!value.includes("\n")) return `FAIL: composer value has no newline: ${JSON.stringify(value)}`
  await composer.fill("")
  return "Shift+Enter inserted a newline and did not send."
}

async function modelsDetail(session: LabSession, log: WebviewLifecycleLog, expected: ScenarioExpected): Promise<string> {
  const surface = await resolveChatSurface(session.app, 15000, log, session.page)
  await surface.locator("#models-btn").click({ timeout: 10000 })
  const next = await resolveChatSurface(session.app, 10000, log, surface.page)
  await next.locator("#model-manager").waitFor({ state: "visible", timeout: 10000 })
  const text = await next.locator("#model-manager").innerText()
  const problems = failuresForText(text, expected)
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return "Model manager shows the endpoint and selected model."
}

async function wideDetail(session: LabSession, surface: ChatSurface, log: WebviewLifecycleLog): Promise<string> {
  await surface.locator("#overflow-menu summary").click()
  await surface.locator("#wide-chat-btn").click()
  const next = await resolveChatSurface(session.app, 15000, log, surface.page)
  const visible = await next.locator("#composer").isVisible().catch(() => false)
  if (!visible) return "FAIL: wider chat did not leave a composer on screen"
  return "Wider chat left a composer surface."
}

async function modelPersistenceDetail(
  session: LabSession,
  surface: ChatSurface,
  scenario: AcceptanceScenario,
  context: RunContext,
  log: WebviewLifecycleLog,
): Promise<string> {
  await selectModel(surface, scenario.model)
  const userData = session.userData
  const workspace = session.workspace
  await session.close()
  const again = await launchLab({ userData, workspace, repositoryRoot: context.repositoryRoot })
  const againLog = log
  againLog.attachApp(again.app)
  try {
    const next = await requireChat(again, 30000, againLog)
    const value = await next.locator("#model-selector").inputValue()
    if (value !== scenario.model) return `FAIL: model selector is ${value}`
    if (existsSync(join(workspace, ".open-vs-code", "models.json"))) return "FAIL: workspace models.json was created"
    await again.close()
    const second = freshRunDir("ovsc-accept-model-repo-")
    materializeFixture("bug", second.workspace)
    const otherRepo = await launchLab({
      userData,
      workspace: second.workspace,
      repositoryRoot: context.repositoryRoot,
    })
    try {
      const other = await requireChat(otherRepo, 30000, againLog)
      const otherValue = await other.locator("#model-selector").inputValue()
      if (otherValue !== scenario.model) return `FAIL: shared profile model selector is ${otherValue} in the second repository`
      if (existsSync(join(second.workspace, ".open-vs-code", "models.json"))) return "FAIL: second repository models.json was created"
      return `Model selector kept ${value} after restart and in a second repository on the same isolated profile.`
    } finally {
      await otherRepo.close()
    }
  } finally {
    await again.close().catch(() => undefined)
  }
}

async function chatDetail(
  session: LabSession,
  surface: ChatSurface,
  scenario: AcceptanceScenario,
  context: RunContext,
  before: Record<string, string>,
  evidencePath: string,
  log: WebviewLifecycleLog,
): Promise<string> {
  let current = surface
  let text = ""
  if (scenario.id === "SAFE-CANCEL" && scenario.prompt) {
    const sent = await sendPrompt(session, scenario.prompt, log, current)
    writeEvidence(evidencePath, "send.json", JSON.stringify(sent.result, null, 2))
    if (sent.result.ack !== "acknowledged") return `FAIL: Send not acknowledged (${sent.result.ack}): ${sent.result.detail}`
    current = await resolveChatSurface(session.app, 10000, log, sent.surface.page)
    await current.locator("#cancel-btn").click({ timeout: scenario.timeoutMs })
    await current.locator("#composer").waitFor({ state: "visible", timeout: 30000 })
  } else if (scenario.prompt) {
    const sent = await sendPrompt(session, scenario.prompt, log, current)
    writeEvidence(evidencePath, "send.json", JSON.stringify(sent.result, null, 2))
    await screenshot(session, evidencePath, "chat.png", false)
    if (sent.result.ack === "not_attempted") return `FAIL: Send not attempted: ${sent.result.detail}`
    if (sent.result.ack === "unknown") return `BLOCKED: Send outcome unknown; not retrying: ${sent.result.detail}`
    if (sent.result.clicks > 2) return `FAIL: Send was clicked ${sent.result.clicks} times`
    if (scenario.approval !== "none") {
      assertApprovalTarget(session.workspace, context.repositoryRoot, scenario.approval)
      current = await resolveChatSurface(session.app, 15000, log, sent.surface.page)
      await waitForApproval(current, scenario.timeoutMs)
      await clickDecision(current, scenario.approval, scenario.timeoutMs)
    }
    const first = await waitForTurnAssistant(session, scenario.prompt, scenario.timeoutMs, log, sent.surface.page)
    current = first.surface
    text = first.text
    if (scenario.followUp) {
      const follow = await sendPrompt(session, scenario.followUp, log)
      writeEvidence(evidencePath, "send-followup.json", JSON.stringify(follow.result, null, 2))
      if (follow.result.ack !== "acknowledged") return `FAIL: follow-up Send ${follow.result.ack}: ${follow.result.detail}`
      const second = await waitForTurnAssistant(session, scenario.followUp, scenario.timeoutMs, log, follow.surface.page)
      current = second.surface
      text = second.text
    }
  }
  if (!text && scenario.prompt) text = await assistantTextForTurn(current, scenario.prompt)
  writeEvidence(evidencePath, "assistant.txt", text)
  writeEvidence(evidencePath, "messages.json", JSON.stringify(await readMessages(current), null, 2))
  await screenshot(session, evidencePath, "after-prompt.png", true)
  const problems = [
    ...failuresForText(text, scenario.expected),
    ...filesystemProblems(session.workspace, before, scenario.expected),
  ]
  if (scenario.id === "SAFE-APPROVE") {
    const source = readFileSync(join(session.workspace, "src", "add.js"), "utf8")
    if (source.includes("a + b + 1")) problems.push("src/add.js still returns a + b + 1")
  }
  if (scenario.id === "CONV-PING") {
    const ping = classifyPingContent(text)
    writeEvidence(evidencePath, "ping-classification.json", JSON.stringify({
      ...ping,
      send: JSON.parse(readFileSync(join(evidencePath, "send.json"), "utf8")),
    }, null, 2))
    if (!ping.transportTextPresent) problems.push("transport: model reply did not contain pong")
    if (ping.protocolLeak) problems.push("protocol leak: <tool_call> remains visible on the installed binary")
  }
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  if (scenario.driver === "review") return "Checks that can be decided from the workspace passed. Screenshot is ready for review."
  return text.slice(0, 500) || "Chat turn finished and the oracle matched."
}

export function notRun(scenario: AcceptanceScenario, evidenceRoot: string): ScenarioResult {
  return {
    id: scenario.id,
    title: scenario.title,
    tier: scenario.tier,
    group: scenario.group,
    verdict: "NOT_RUN",
    cause: "not_executed",
    oracle: scenario.oracle,
    forbidden: scenario.forbidden,
    timeoutMs: scenario.timeoutMs,
    durationMs: 0,
    evidencePath: resolve(evidenceRoot, scenario.id),
    detail: "Not executed in this run.",
  }
}
