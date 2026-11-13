import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { scenarioHarness, type AcceptanceScenario, type ScenarioExpected } from "./catalog.ts"
import {
  assistantTextForTurn,
  attachChatSurface,
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
import {
  acceptanceExtensionsDir,
  agentSurface,
  captureWorkbenchWhenReady,
  closeWideChat,
  launchCdpApp,
  listAgentWebviews,
  parseAcceptanceWindowSize,
  readWorkbench,
  relaunchCdpApp,
  runCdpTurn,
  sampleFrames,
  trustWorkspace,
  waitAgentSurface,
  waitForAgentViews,
  writePng,
  type AgentViewKind,
  type CdpApp,
} from "./cdp-driver.ts"
import { interpretCdpTurn } from "./cdp-turn.ts"
import { assessJourney } from "./journey.ts"
import { classifyPingContent, gitCleanProblems, sourceDigest, trustStateFromWorkbench } from "./oracles.ts"
import { assertApprovalTarget, assertIsolatedPath, fingerprintDrift, liveProfileDirs, liveProfileFingerprint } from "./safety.ts"
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
  if (
    detail.includes("composer")
    || detail.includes("selector")
    || detail.includes("Send not")
    || detail.includes("webview")
    || detail.includes("screenshot")
    || detail.includes("debug port")
    || detail.includes("debug socket")
    || detail.includes("CDP")
  ) return "tooling"
  if (detail.includes("forbidden text") || detail.includes("<tool_call") || detail.includes("protocol leak")) return "presentation"
  if (detail.includes("oracle") || detail.includes("exited")) return "model"
  if (detail.includes("Restricted Mode") || detail.includes("trust")) return "permission"
  if (scenario.group === "safety") return "permission"
  if (scenario.group === "lifecycle") return "persistence"
  return "orchestration"
}

async function runScenario(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const harness = scenarioHarness(scenario)
  if (harness === "unit") return runUnit(scenario, context.repositoryRoot)
  if (harness === "artifact") return runArtifact(scenario, context)
  if (harness === "cdp-webview") {
    if (scenario.id === "UX-WIDE") return runCdpWide(scenario, context, evidencePath)
    if (scenario.id === "UX-ACTIVITY") return runCdpActivity(scenario, context, evidencePath)
    if (scenario.id === "UX-DIFF") return runCdpDiff(scenario, context, evidencePath)
    if (scenario.id === "LIFE-HISTORY") return runCdpHistory(scenario, context, evidencePath)
    if (scenario.id === "CODE-CONTINUE") return runCdpContinueSameSession(scenario, context, evidencePath)
    if (scenario.id === "CODE-CONTINUE-RESTART") return runCdpContinueRestart(scenario, context, evidencePath)
    if (scenario.id === "CODE-CONTINUE-COMPLETE") return runCdpContinueComplete(scenario, context, evidencePath)
    if (scenario.id === "CODE-CONTINUE-STALE") return runCdpContinueStale(scenario, context, evidencePath)
    if (scenario.prompt) return runCdpChat(scenario, context, evidencePath)
    return `BLOCKED: CDP webview harness has no flow for ${scenario.id}`
  }
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
    let iframeVisible = false
    if (!scenario.prompt) {
      const iframeInventory = await page.locator("iframe").evaluateAll((nodes) =>
        nodes.map((node) => ({
          className: (node as HTMLIFrameElement).className,
          id: (node as HTMLIFrameElement).id,
          src: String((node as HTMLIFrameElement).src || "").split("?")[0].slice(0, 160),
        })),
      ).catch((error) => [{ error: error instanceof Error ? error.message : String(error) }])
      writeEvidence(evidencePath, "iframes.json", JSON.stringify(iframeInventory, null, 2))
      const iframe = page.locator("iframe.webview, iframe.webview-internal").last()
      iframeVisible = await iframe.isVisible({ timeout: 20000 }).catch(() => false)
      if (!iframeVisible) await openAgentSurface(session.app, log)
    } else {
      writeEvidence(evidencePath, "iframes.json", "[]\n")
    }
    const surface = scenario.prompt
      ? attachChatSurface(session.app, page)
      : await resolveChatSurface(session.app, 20000, log, page)
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
    if (sent.result.assistantText) {
      text = sent.result.assistantText
    } else {
      const first = await waitForTurnAssistant(session, scenario.prompt, scenario.timeoutMs, log, sent.surface.page)
      current = first.surface
      text = first.text
    }
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

async function runCdpChat(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const dirs = freshRunDir(`ovsc-cdp-${scenario.id}-`)
  materializeFixture(scenario.fixture, dirs.workspace)
  const before = workspaceDigest(dirs.workspace)
  writeEvidence(evidencePath, "workspace.txt", dirs.workspace)
  if (scenario.id === "CODE-BUG") {
    const initial = spawnSync("node", ["--test"], { cwd: dirs.workspace, encoding: "utf8", timeout: 60000 })
    writeEvidence(evidencePath, "initial-test.txt", `${initial.stdout ?? ""}${initial.stderr ?? ""}\nexit ${initial.status}\n`)
    if (initial.status === 0) return "FAIL: the disposable fixture test already passed before the agent ran"
  }
  const app = await launchCdpApp({
    userData: dirs.userData,
    workspace: dirs.workspace,
    repositoryRoot: context.repositoryRoot,
    disableWorkspaceTrust: scenario.trust === "trusted",
    ...(scenario.maxTurns ? { env: { OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: String(scenario.maxTurns) } } : {}),
  })
  try {
    writeEvidence(evidencePath, "argv.txt", app.argv.join("\n"))
    writeEvidence(evidencePath, "launch.json", JSON.stringify({
      binary: app.binary,
      pid: app.pid,
      port: app.port,
      sandboxMode: app.sandboxMode,
      profile: app.userData,
      driver: "cdp",
      extensionsDir: acceptanceExtensionsDir() ?? null,
      windowBounds: app.windowBounds ?? null,
    }, null, 2))
    writeEvidence(evidencePath, "window-bounds.json", JSON.stringify(app.windowBounds ?? parseAcceptanceWindowSize(), null, 2))
    await saveShot(app, evidencePath, "window.png")
    if (scenario.trust === "trusted") {
      const trust = await trustWorkspace(app)
      writeEvidence(evidencePath, "trust.json", JSON.stringify(trust, null, 2))
      if (trust.restricted) return "FAIL: workspace remained in Restricted Mode after the trust control was used"
    }
    if (scenario.approval !== "none") assertApprovalTarget(dirs.workspace, context.repositoryRoot, scenario.approval)
    const taskId = `${context.runId}:${scenario.id}${context.cycle ? `#${context.cycle}` : ""}`
    let text = ""
    let activities: string[] = []
    let messageStatuses: string[] = []
    let approvalBlocked = false
    try {
      const first = await oneCdpTurn(app, scenario, scenario.prompt!, taskId, dirs.workspace, evidencePath, "send.json")
      if (first.blocked) return first.blocked
      text = first.text
      activities = first.activities
      messageStatuses = first.messageStatuses
      approvalBlocked = first.approvalBlocked
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeEvidence(evidencePath, "frames.jsonl", `${JSON.stringify(await sampleFrames(app))}\n`)
      return `BLOCKED: CDP turn did not finish; not retrying: ${message}`
    }
    if (scenario.followUp) {
      const follow = await oneCdpTurn(app, scenario, scenario.followUp, `${taskId}:follow`, dirs.workspace, evidencePath, "send-followup.json")
      if (follow.blocked) return follow.blocked
      text = follow.text
    }
    await saveShot(app, evidencePath, "after-prompt.png", true)
    const outcome = scenario.group === "coding"
      ? await agentSurface(app, { op: "snapshot" }, "any").catch(() => null)
      : null
    if (outcome) {
      writeEvidence(evidencePath, "outcome.json", JSON.stringify({
        outcomeVisible: outcome.outcomeVisible === true,
        outcomeText: outcome.outcomeText || "",
        modelsVisible: outcome.modelsVisible === true,
        composerVisible: outcome.composerVisible === true,
      }, null, 2))
    }
    const filesystem = filesystemProblems(dirs.workspace, before, scenario.expected)
    const fileProblems = filesystem.filter((problem) => !problem.startsWith("oracle "))
    const problems = [
      ...failuresForText(text, scenario.expected),
      ...filesystem,
    ]
    if (scenario.id === "CODE-BUG" && outcome && /Changed:|Tests passed|Task completed/i.test(text) && outcome.outcomeVisible !== true) {
      problems.push("completed coding result was not visible")
    }
    if (scenario.id === "SAFE-APPROVE") {
      const source = readFileSync(join(dirs.workspace, "src", "add.js"), "utf8")
      if (source.includes("a + b + 1")) problems.push("src/add.js still returns a + b + 1")
    }
    if (scenario.id === "CONV-PING") {
      const ping = classifyPingContent(text)
      writeEvidence(evidencePath, "ping-classification.json", JSON.stringify({
        ...ping,
        taskId,
        send: JSON.parse(readFileSync(join(evidencePath, "send.json"), "utf8")),
      }, null, 2))
      if (!ping.transportTextPresent) problems.push("transport: model reply did not contain pong")
      if (ping.protocolLeak) problems.push("protocol leak: tool-call markup remains visible")
    }
    if (scenario.expected.command || scenario.group === "coding") {
      const diff = spawnSync("git", ["diff", "--"], { cwd: dirs.workspace, encoding: "utf8" })
      writeEvidence(evidencePath, "git-diff.patch", diff.stdout || "")
      writeEvidence(evidencePath, "git-status.txt", gitPorcelain(dirs.workspace))
    }
    let commandExit: number | null = null
    if (scenario.expected.command) {
      const oracle = spawnSync(scenario.expected.command.cmd, [...scenario.expected.command.args], {
        cwd: dirs.workspace,
        encoding: "utf8",
        timeout: 60000,
      })
      commandExit = oracle.status
      const commandOutput = `${oracle.stdout ?? ""}${oracle.stderr ?? ""}`
      writeEvidence(evidencePath, "oracle-test.txt", `${commandOutput}\nexit ${oracle.status}\n`)
    }
    const expectsAgentCompletion = scenario.group === "coding"
    const journey = assessJourney({
      expectsAgentCompletion,
      text,
      activities,
      messageStatuses,
      commandExit,
      commandOutput: scenario.expected.command ? readFileSync(join(evidencePath, "oracle-test.txt"), "utf8") : "",
      expectedExit: scenario.expected.command?.exitCode ?? null,
      filesystemProblems: fileProblems,
      approvalBlocked,
    })
    writeEvidence(evidencePath, "journey.json", JSON.stringify({ taskId, ...journey }, null, 2))
    if (expectsAgentCompletion && !journey.endToEndSuccess) {
      for (const reason of journey.reasons) problems.push(reason)
    } else if (!expectsAgentCompletion && journey.verificationReportedTruthfully === false) {
      problems.push("verification claim does not match the independent result")
    }
    if (scenario.group === "coding") {
      writeEvidence(evidencePath, "solved.json", JSON.stringify({
        taskId,
        codeCorrect: journey.codeCorrect,
        independentTestsPassed: journey.independentTestsPassed,
        agentCompleted: journey.agentCompleted,
        verificationReportedTruthfully: journey.verificationReportedTruthfully,
        permissionsRespected: journey.permissionsRespected,
        endToEndSuccess: journey.endToEndSuccess,
        solved: journey.endToEndSuccess,
        failureReason: journey.failureReason,
        modelClaim: text.slice(0, 500),
        independentExit: commandExit,
      }, null, 2))
    }
    if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
    return text.slice(0, 500) || "Chat turn finished and the oracle matched."
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function oneCdpTurn(
  app: CdpApp,
  scenario: AcceptanceScenario,
  prompt: string,
  taskId: string,
  workspace: string,
  evidencePath: string,
  evidenceName: string,
  view: AgentViewKind = "any",
  continueRun = false,
): Promise<{ text: string; blocked?: string; activities: string[]; messageStatuses: string[]; approvalBlocked: boolean }> {
  const turn = await runCdpTurn(app, {
    taskId,
    prompt,
    mode: scenario.mode,
    model: scenario.model,
    timeoutMs: scenario.timeoutMs,
    decision: scenario.approval === "none" ? "none" : scenario.approval,
    workspace,
    view,
    continueRun,
  })
  writeEvidence(evidencePath, "frames.jsonl", turn.frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")
  const interpreted = interpretCdpTurn({ taskId, prompt, workspace, raw: turn.raw })
  const payload = { taskId, targetUrl: turn.targetUrl, raw: turn.raw, interpreted }
  writeEvidence(evidencePath, evidenceName, JSON.stringify(payload, null, 2))
  writeEvidence(evidencePath, evidenceName === "send.json" ? "messages.json" : "messages-followup.json", JSON.stringify(turn.raw.messages ?? [], null, 2))
  writeEvidence(evidencePath, evidenceName === "send.json" ? "assistant.txt" : "assistant-followup.txt", interpreted.assistant)
  const observed = {
    activities: [...(turn.raw.activities ?? [])],
    messageStatuses: (turn.raw.messages ?? []).map((message) => message.status ?? "").filter(Boolean),
    approvalBlocked: turn.raw.approvalBlocked === true,
  }
  if (continueRun) {
    const text = (turn.raw.messages ?? []).map((message) => message.text).join("\n")
    if (turn.raw.reason === "Continue this run was not visible") {
      return { text, blocked: "FAIL: Continue this run was not visible", ...observed }
    }
    return { text, ...observed }
  }
  if (interpreted.problems.length > 0) return { text: interpreted.assistant, blocked: `FAIL: ${interpreted.problems.join("; ")}`, ...observed }
  if (interpreted.ack === "not_attempted") return { text: "", blocked: `FAIL: Send not attempted: ${turn.raw.reason || "composer was not submitted"}`, ...observed }
  if (interpreted.ack !== "acknowledged") return { text: "", blocked: `BLOCKED: Send outcome unknown; not retrying: ${turn.raw.reason || "empty composer is not a submission"}`, ...observed }
  if (interpreted.userCount !== 1) return { text: interpreted.assistant, blocked: `FAIL: expected one user turn, saw ${interpreted.userCount}`, ...observed }
  if (!interpreted.assistant.trim()) return { text: "", blocked: "FAIL: the submitted user turn has no assistant reply", ...observed }
  return { text: interpreted.assistant, ...observed }
}

async function saveShot(app: CdpApp, evidencePath: string, name: string, required = false): Promise<void> {
  try {
    writePng(join(evidencePath, name), await captureWorkbenchWhenReady(app))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeEvidence(evidencePath, `${name}.error.txt`, message)
    if (required) throw new Error(`Required screenshot ${name} failed: ${message}`)
  }
}

function protocolLeak(text: string): boolean {
  return /<tool_call\b|<\/tool_call>|<function=/.test(text)
}

async function startCdpSession(
  scenario: AcceptanceScenario,
  context: RunContext,
  evidencePath: string,
  options?: { prepare?: boolean; userData?: string; workspace?: string },
): Promise<{ app: CdpApp; dirs: { root: string; userData: string; workspace: string }; before: Record<string, string> }> {
  const dirs = options?.userData && options.workspace
    ? { root: join(options.userData, ".."), userData: options.userData, workspace: options.workspace }
    : freshRunDir(`ovsc-cdp-${scenario.id}-`)
  if (!options?.workspace) materializeFixture(scenario.fixture, dirs.workspace)
  const before = workspaceDigest(dirs.workspace)
  writeEvidence(evidencePath, "workspace.txt", dirs.workspace)
  const app = await launchCdpApp({
    userData: dirs.userData,
    workspace: dirs.workspace,
    repositoryRoot: context.repositoryRoot,
    disableWorkspaceTrust: scenario.trust === "trusted",
    prepare: options?.prepare,
    ...(scenario.maxTurns ? { env: { OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: String(scenario.maxTurns) } } : {}),
  })
  writeEvidence(evidencePath, "argv.txt", app.argv.join("\n"))
  writeEvidence(evidencePath, "launch.json", JSON.stringify({
    binary: app.binary,
    pid: app.pid,
    port: app.port,
    sandboxMode: app.sandboxMode,
    profile: app.userData,
    driver: "cdp",
    extensionsDir: acceptanceExtensionsDir() ?? null,
    windowBounds: app.windowBounds ?? null,
  }, null, 2))
  writeEvidence(evidencePath, "window-bounds.json", JSON.stringify(app.windowBounds ?? parseAcceptanceWindowSize(), null, 2))
  if (scenario.trust === "trusted") {
    const trust = await trustWorkspace(app)
    writeEvidence(evidencePath, "trust.json", JSON.stringify(trust, null, 2))
    if (trust.restricted) throw new Error("FAIL: workspace remained in Restricted Mode after the trust control was used")
  }
  return { app, dirs, before }
}

async function runCdpWide(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app, dirs } = await startCdpSession(scenario, context, evidencePath)
  try {
    await saveShot(app, evidencePath, "window.png", true)
    await waitForAgentViews(app, 1, 45000)
    const sidebar = await waitAgentSurface(app, "sidebar", (snap) => snap.composerVisible === true, 20000)
    writeEvidence(evidencePath, "sidebar-before.json", JSON.stringify(sidebar, null, 2))
    if (!sidebar.wideButtonVisible) return "FAIL: Wider chat control was not visible in the sidebar"
    await agentSurface(app, { op: "click", selector: "#wide-chat-btn" }, "sidebar")
    let views
    try {
      views = await waitForAgentViews(app, 2, 20000)
    } catch (error) {
      return `BLOCKED: Wider Chat did not expose a second Agent webview: ${error instanceof Error ? error.message : String(error)}`
    }
    writeEvidence(evidencePath, "views.json", JSON.stringify(views, null, 2))
    const wide = await waitAgentSurface(app, "wide", (snap) => snap.composerVisible === true, 15000)
    if (!wide.composerVisible) return "FAIL: Wider chat did not leave a composer on screen"
    const draft = `shared-draft-${scenario.id}`
    await agentSurface(app, { op: "fill", value: draft }, "sidebar")
    const synced = await waitAgentSurface(app, "wide", (snap) => (snap.composerValue || "").includes(draft), 10000).catch(() => null)
    if (!synced) return "FAIL: Wider Chat did not show the sidebar composer draft"
    await agentSurface(app, { op: "fill", value: "" }, "wide")
    const taskId = `${context.runId}:${scenario.id}`
    const sent = await oneCdpTurn(app, scenario, scenario.prompt, taskId, dirs.workspace, evidencePath, "send.json", "wide")
    if (sent.blocked) return sent.blocked
    const afterSidebar = await waitAgentSurface(app, "sidebar", (snap) => (snap.messages || []).some((message) => message.role === "user" && message.text.includes(scenario.prompt)), 15000)
    const afterWide = await waitAgentSurface(app, "wide", (snap) => (snap.messages || []).some((message) => message.role === "assistant" && /widecheck/i.test(message.text)), 15000)
    writeEvidence(evidencePath, "messages-sidebar.json", JSON.stringify(afterSidebar.messages ?? [], null, 2))
    writeEvidence(evidencePath, "messages-wide.json", JSON.stringify(afterWide.messages ?? [], null, 2))
    const problems = [
      ...failuresForText(sent.text, scenario.expected),
      ...failuresForText((afterSidebar.messages ?? []).map((message) => message.text).join("\n"), scenario.expected),
    ]
    const usersWide = (afterWide.messages ?? []).filter((message) => message.role === "user" && message.text.includes(scenario.prompt)).length
    const usersSide = (afterSidebar.messages ?? []).filter((message) => message.role === "user" && message.text.includes(scenario.prompt)).length
    if (usersWide !== 1 || usersSide !== 1) problems.push(`expected one shared user turn, sidebar=${usersSide} wide=${usersWide}`)
    await saveShot(app, evidencePath, "wide-open.png", true)
    const requested = parseAcceptanceWindowSize()
    const actualWidth = app.windowBounds?.actual?.outerWidth || app.windowBounds?.actual?.innerWidth || 0
    writeEvidence(evidencePath, "window-bounds.json", JSON.stringify({ ...app.windowBounds, modelsVisible: afterWide.modelsVisible === true, composerVisible: afterWide.composerVisible === true }, null, 2))
    if (actualWidth > 0 && Math.abs(actualWidth - requested.width) > 160) {
      problems.push(`window outer/inner width ${actualWidth} did not match requested ${requested.width}x${requested.height}`)
    }
    if (afterWide.modelsVisible !== true) problems.push("Models control was not visible in Wider Chat")
    if (afterWide.composerVisible !== true) problems.push("composer was not usable in Wider Chat")
    const closed = await closeWideChat(app)
    writeEvidence(evidencePath, "close-wide.json", JSON.stringify({ closed }, null, 2))
    await waitForAgentViews(app, 1, 15000)
    const remaining = await listAgentWebviews(app)
    if (remaining.some((view) => view.kind === "wide")) problems.push("Wider Chat remained open after close")
    const usable = await waitAgentSurface(app, "sidebar", (snap) => snap.composerVisible === true, 10000)
    if (!usable.composerVisible) problems.push("sidebar composer was not usable after closing Wider Chat")
    await saveShot(app, evidencePath, "after-prompt.png", true)
    if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
    return "Sidebar and Wider Chat shared one conversation, one draft, and one completed turn."
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function runCdpActivity(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app, dirs, before } = await startCdpSession(scenario, context, evidencePath)
  try {
    await saveShot(app, evidencePath, "window.png", true)
    const taskId = `${context.runId}:${scenario.id}`
    const sent = await oneCdpTurn(app, scenario, scenario.prompt, taskId, dirs.workspace, evidencePath, "send.json")
    if (sent.blocked) return sent.blocked
    const snap = await waitAgentSurface(app, "sidebar", (value) => (value.activities ?? []).length > 0 || (value.trace ?? []).length > 0 || Boolean(sent.text), 10000)
    writeEvidence(evidencePath, "activity.json", JSON.stringify({
      activities: snap.activities ?? [],
      statuses: snap.activityStatuses ?? [],
      trace: snap.trace ?? [],
      technicalOpen: snap.technicalOpen === true,
    }, null, 2))
    await saveShot(app, evidencePath, "after-prompt.png", true)
    const body = `${sent.text}\n${(snap.activities ?? []).join("\n")}\n${(snap.trace ?? []).join("\n")}\n${snap.bodyText ?? ""}`
    const problems = [
      ...failuresForText(sent.text, scenario.expected),
      ...filesystemProblems(dirs.workspace, before, { gitClean: scenario.expected.gitClean }),
    ]
    if (protocolLeak(body)) problems.push("protocol leak: tool-call markup remains visible")
    if ((snap.trace ?? []).length > 0 && snap.technicalOpen) problems.push("technical details were expanded by default")
    if ((snap.activities ?? []).length === 0) problems.push("activity is not grouped in a summary")
    if ((snap.trace ?? []).length === 0) problems.push("technical activity trace is missing")
    const toolish = [...(snap.activities ?? []), ...(snap.trace ?? [])].some((line) => /read|explor|file|tool|think|model/i.test(line))
    if (!toolish) problems.push("activity summary does not correspond to model or tool work")
    const failed = (snap.activityStatuses ?? []).includes("failed")
    const retried = [...(snap.activities ?? []), ...(snap.trace ?? [])].some((line) => /retry|failed/i.test(line))
    writeEvidence(evidencePath, "activity-flags.json", JSON.stringify({ failed, retried, visual: "NEEDS_REVIEW" }, null, 2))
    if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
    return "Activity is grouped, technical details stay collapsed, and the screenshot is ready for visual review."
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function runCdpDiff(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app, dirs, before } = await startCdpSession(scenario, context, evidencePath)
  try {
    await saveShot(app, evidencePath, "window.png", true)
    assertApprovalTarget(dirs.workspace, context.repositoryRoot, "reject")
    const sourceBefore = readFileSync(join(dirs.workspace, "src", "add.js"), "utf8")
    const taskId = `${context.runId}:${scenario.id}`
    const turn = await runCdpTurn(app, {
      taskId,
      prompt: scenario.prompt,
      mode: scenario.mode,
      model: scenario.model,
      timeoutMs: scenario.timeoutMs,
      decision: "hold",
      workspace: dirs.workspace,
    })
    writeEvidence(evidencePath, "frames.jsonl", turn.frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")
    writeEvidence(evidencePath, "send.json", JSON.stringify({ taskId, targetUrl: turn.targetUrl, raw: turn.raw }, null, 2))
    const card = await waitAgentSurface(app, "any", (snap) => snap.diffVisible === true || snap.approveVisible === true, 20000)
    writeEvidence(evidencePath, "confirmation.json", JSON.stringify({
      confirmationId: card.confirmationId,
      path: card.confirmationPath,
      diffVisible: card.diffVisible,
    }, null, 2))
    if (!card.diffVisible) return "FAIL: Open Diff control was not visible on the proposed change"
    if (card.confirmationPath && !card.confirmationPath.includes("add.js")) return `FAIL: proposed path was ${card.confirmationPath}`
    await agentSurface(app, { op: "click", selector: "#btn-diff" }, "any")
    const workbench = await waitForWorkbenchDiff(app, scenario.timeoutMs > 5000 ? 20000 : 20000)
    writeEvidence(evidencePath, "workbench-diff.json", JSON.stringify(workbench, null, 2))
    await saveShot(app, evidencePath, "review.png", true)
    const afterOpen = readFileSync(join(dirs.workspace, "src", "add.js"), "utf8")
    if (afterOpen !== sourceBefore) return "FAIL: opening the diff applied the proposed edit"
    const stillPending = await agentSurface(app, { op: "snapshot" }, "any")
    if (!stillPending.approveVisible && !stillPending.rejectVisible) return "FAIL: opening the diff dismissed the approval card"
    await agentSurface(app, { op: "click", selector: "#btn-reject" }, "any")
    const settled = await waitAgentSurface(app, "any", (snap) => {
      const rejected = (snap.reviews ?? []).some((row) => /rejected/i.test(row))
        || (snap.messages ?? []).some((message) => /Change rejected/i.test(message.text))
        || /Change rejected/i.test(snap.bodyText || "")
      return snap.approveVisible !== true && snap.rejectVisible !== true && rejected
    }, 60000).catch(async () => agentSurface(app, { op: "snapshot" }, "any"))
    writeEvidence(evidencePath, "messages.json", JSON.stringify(settled.messages ?? [], null, 2))
    const afterReject = await waitForClosedReview(app, 8000)
    writeEvidence(evidencePath, "workbench-after-reject.json", JSON.stringify(afterReject, null, 2))
    await saveShot(app, evidencePath, "after-prompt.png", true)
    const problems = filesystemProblems(dirs.workspace, before, scenario.expected)
    const sourceAfter = readFileSync(join(dirs.workspace, "src", "add.js"), "utf8")
    if (sourceAfter !== sourceBefore) problems.push("src/add.js changed after reject")
    if (sourceAfter.includes("a + b") && !sourceAfter.includes("a + b + 1") && sourceBefore.includes("a + b + 1")) {
      problems.push("src/add.js was applied despite reject")
    }
    if (!workbench.diffEditor && !workbench.tabLabels.some((label) => /add\.js|Review/i.test(label))) {
      problems.push("VS Code did not show a diff editor for the proposed file")
    }
    if (afterReject.diffEditor || afterReject.tabLabels.some((label) => /Open VS Code: Review/i.test(label))) {
      problems.push("proposed Review tab remained open after reject")
    }
    if (settled.approveVisible || settled.rejectVisible) problems.push("approval controls remained after reject")
    const rejectedVisible = (settled.reviews ?? []).some((row) => /rejected/i.test(row))
      || (settled.messages ?? []).some((message) => /Change rejected/i.test(message.text))
      || /Change rejected/i.test(settled.bodyText || "")
    if (!rejectedVisible) problems.push("rejected state was not visible after reject")
    if ((settled.reviews ?? []).some((row) => /\bOpen\b/i.test(row) && /rejected/i.test(row))) {
      problems.push("rejected review remained actionable")
    }
    if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
    return "Open Diff showed the proposed src/add.js change without applying it; reject left the file unchanged and closed the preview."
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function waitForClosedReview(app: CdpApp, timeoutMs: number): Promise<{ diffEditor: boolean; tabLabels: readonly string[]; text: string }> {
  const started = Date.now()
  let last = { diffEditor: false, tabLabels: [] as string[], text: "" }
  while (Date.now() - started < timeoutMs) {
    try {
      const snap = await readWorkbench(app)
      last = { diffEditor: snap.diffEditor, tabLabels: [...snap.tabLabels], text: snap.text }
      const reviewOpen = snap.diffEditor || snap.tabLabels.some((label) => /Open VS Code: Review/i.test(label))
      if (!reviewOpen) return last
    } catch {
      // Workbench may still be attaching.
    }
    await sleep(200)
  }
  return last
}

async function waitForWorkbenchDiff(app: CdpApp, timeoutMs: number): Promise<{ diffEditor: boolean; tabLabels: readonly string[]; text: string }> {
  const started = Date.now()
  let last = { diffEditor: false, tabLabels: [] as string[], text: "" }
  while (Date.now() - started < timeoutMs) {
    try {
      const snap = await readWorkbench(app)
      last = { diffEditor: snap.diffEditor, tabLabels: [...snap.tabLabels], text: snap.text }
      if (snap.diffEditor || snap.tabLabels.some((label) => /Review|add\.js/i.test(label))) return last
    } catch {
      // Workbench may still be attaching.
    }
    await sleep(300)
  }
  return last
}

const STALE_MARKER = 'export const EXTERNAL_STALE_MARKER = "do-not-overwrite"'

function continuationEnv(scenario: AcceptanceScenario): Record<string, string> | undefined {
  return scenario.maxTurns ? { OPEN_VS_CODE_ACCEPTANCE_MAX_TURNS: String(scenario.maxTurns) } : undefined
}

function transcriptHasTurnLimit(text: string): boolean {
  return /MAX_TURNS_EXCEEDED|turn budget was used up|Continue this run/i.test(text)
}

async function waitIdleWithoutResume(app: CdpApp, evidencePath: string): Promise<string[]> {
  const before = await agentSurface(app, { op: "snapshot" }, "any")
  const beforeDigest = workspaceDigest(app.workspace)
  await sleep(5000)
  const after = await agentSurface(app, { op: "snapshot" }, "any")
  const afterDigest = workspaceDigest(app.workspace)
  writeEvidence(evidencePath, "idle-before.json", JSON.stringify(before, null, 2))
  writeEvidence(evidencePath, "idle-after.json", JSON.stringify(after, null, 2))
  const problems: string[] = []
  if (before.continueVisible === true && after.continueVisible !== true && !transcriptHasTurnLimit((after.bodyText || "") + (after.messages ?? []).map((m) => m.text).join("\n"))) {
    problems.push("Continue this run disappeared without an explicit click")
  }
  if (JSON.stringify(sourceDigest(beforeDigest)) !== JSON.stringify(sourceDigest(afterDigest))) {
    problems.push("workspace changed during the idle wait before Continue")
  }
  return problems
}

async function pauseAtTurnLimit(
  app: CdpApp,
  scenario: AcceptanceScenario,
  context: RunContext,
  evidencePath: string,
): Promise<{ text: string; blocked?: string }> {
  const taskId = `${context.runId}:${scenario.id}`
  const first = await oneCdpTurn(app, scenario, scenario.prompt, taskId, app.workspace, evidencePath, "send.json")
  if (first.blocked) return first
  const snap = await agentSurface(app, { op: "snapshot" }, "any")
  writeEvidence(evidencePath, "pause-snapshot.json", JSON.stringify({
    continueVisible: snap.continueVisible === true,
    body: (snap.bodyText || "").slice(0, 2000),
    messages: snap.messages ?? [],
    activities: snap.activities ?? [],
    reviews: snap.reviews ?? [],
    model: scenario.model,
    maxTurns: scenario.maxTurns ?? null,
  }, null, 2))
  await saveShot(app, evidencePath, "paused.png", true)
  const blob = [first.text, snap.bodyText || "", ...(snap.messages ?? []).map((message) => message.text)].join("\n")
  if (!transcriptHasTurnLimit(blob) && snap.continueVisible !== true) {
    return { text: blob, blocked: "FAIL: task did not pause at the lab turn budget; Continue this run was not shown. The cap was not increased." }
  }
  const idle = await waitIdleWithoutResume(app, evidencePath)
  if (idle.length > 0) return { text: blob, blocked: `FAIL: ${idle.join("; ")}` }
  return { text: blob }
}

async function clickContinue(app: CdpApp, scenario: AcceptanceScenario, context: RunContext, evidencePath: string, name: string): Promise<{ text: string; blocked?: string }> {
  const taskId = `${context.runId}:${scenario.id}:continue`
  return oneCdpTurn(app, scenario, scenario.prompt, taskId, app.workspace, evidencePath, name, "any", true)
}

async function finishContinueOracle(
  scenario: AcceptanceScenario,
  dirsWorkspace: string,
  before: Record<string, string>,
  text: string,
  evidencePath: string,
): Promise<string> {
  writeEvidence(evidencePath, "assistant-final.txt", text)
  const diff = spawnSync("git", ["diff", "--"], { cwd: dirsWorkspace, encoding: "utf8" })
  writeEvidence(evidencePath, "git-diff.patch", diff.stdout || "")
  writeEvidence(evidencePath, "git-status.txt", gitPorcelain(dirsWorkspace))
  const problems = [
    ...failuresForText(text, scenario.expected),
    ...filesystemProblems(dirsWorkspace, before, scenario.expected),
  ]
  if (scenario.expected.command) {
    const oracle = spawnSync(scenario.expected.command.cmd, [...scenario.expected.command.args], {
      cwd: dirsWorkspace,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PYTHONPATH: dirsWorkspace },
    })
    writeEvidence(evidencePath, "oracle-test.txt", `${oracle.stdout ?? ""}${oracle.stderr ?? ""}\nexit ${oracle.status}\n`)
  }
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return text.slice(0, 500) || "Continuation finished and the independent oracle matched."
}

async function runCdpContinueComplete(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app, dirs, before } = await startCdpSession(scenario, context, evidencePath)
  try {
    await saveShot(app, evidencePath, "window.png", true)
    const first = await oneCdpTurn(app, scenario, scenario.prompt, `${context.runId}:${scenario.id}`, dirs.workspace, evidencePath, "send.json")
    if (first.blocked) return first.blocked
    let text = first.text
    for (let index = 0; index < 3; index += 1) {
      const snap = await agentSurface(app, { op: "snapshot" }, "any")
      if (snap.continueVisible !== true) break
      const continued = await clickContinue(app, scenario, context, evidencePath, `continue-${index + 1}.json`)
      if (continued.blocked) {
        if (/Continue this run was not visible/i.test(continued.blocked)) break
        return continued.blocked
      }
      text = `${text}\n${continued.text}`
    }
    await saveShot(app, evidencePath, "after-complete.png", true)
    return finishContinueOracle(scenario, dirs.workspace, before, text, evidencePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function runCdpContinueSameSession(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app, dirs, before } = await startCdpSession(scenario, context, evidencePath)
  try {
    await saveShot(app, evidencePath, "window.png", true)
    const paused = await pauseAtTurnLimit(app, scenario, context, evidencePath)
    if (paused.blocked) return paused.blocked
    const continued = await clickContinue(app, scenario, context, evidencePath, "continue.json")
    if (continued.blocked) return continued.blocked
    await saveShot(app, evidencePath, "after-continue.png", true)
    return finishContinueOracle(scenario, dirs.workspace, before, continued.text, evidencePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function restoreConversation(app: CdpApp, needle: string): Promise<void> {
  await waitForAgentViews(app, 1, 45000)
  await agentSurface(app, { op: "historyOpen" }, "sidebar")
  await agentSurface(app, { op: "historySelect", value: needle.slice(0, 40) }, "sidebar").catch(() => undefined)
}

async function runCdpContinueRestart(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app: initial, dirs, before } = await startCdpSession(scenario, context, evidencePath)
  let app = initial
  try {
    await saveShot(app, evidencePath, "window.png", true)
    const paused = await pauseAtTurnLimit(app, scenario, context, evidencePath)
    if (paused.blocked) return paused.blocked
    await saveShot(app, evidencePath, "before-restart.png", true)
    app = await relaunchCdpApp(app, {
      repositoryRoot: context.repositoryRoot,
      disableWorkspaceTrust: scenario.trust === "trusted",
      ...(continuationEnv(scenario) ? { env: continuationEnv(scenario) } : {}),
    })
    writeEvidence(evidencePath, "relaunch.json", JSON.stringify({ pid: app.pid, port: app.port, profile: app.userData }, null, 2))
    await restoreConversation(app, scenario.prompt)
    const restored = await waitAgentSurface(app, "sidebar", (snap) => snap.continueVisible === true || transcriptHasTurnLimit(snap.bodyText || ""), 30000)
    writeEvidence(evidencePath, "restored.json", JSON.stringify(restored, null, 2))
    await saveShot(app, evidencePath, "after-restart.png", true)
    if (restored.continueVisible !== true && !transcriptHasTurnLimit(restored.bodyText || "")) {
      return "FAIL: Continue this run was not available after relaunch"
    }
    const idle = await waitIdleWithoutResume(app, evidencePath)
    if (idle.length > 0) return `FAIL: ${idle.join("; ")}`
    const continued = await clickContinue(app, scenario, context, evidencePath, "continue.json")
    if (continued.blocked) return continued.blocked
    await saveShot(app, evidencePath, "after-continue.png", true)
    return finishContinueOracle(scenario, dirs.workspace, before, continued.text, evidencePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function runCdpContinueStale(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const { app: initial, dirs, before } = await startCdpSession(scenario, context, evidencePath)
  let app = initial
  try {
    await saveShot(app, evidencePath, "window.png", true)
    const paused = await pauseAtTurnLimit(app, scenario, context, evidencePath)
    if (paused.blocked) return paused.blocked
    for (const relativePath of ["src/format.ts", "src/greet.ts", "src/parse.ts"]) {
      const target = join(dirs.workspace, relativePath)
      const current = readFileSync(target, "utf8")
      if (!current.includes("EXTERNAL_STALE_MARKER")) {
        writeFileSync(target, `${current.trimEnd()}\n${STALE_MARKER}\n`)
      }
    }
    writeEvidence(evidencePath, "external-edit.txt", STALE_MARKER)
    app = await relaunchCdpApp(app, {
      repositoryRoot: context.repositoryRoot,
      disableWorkspaceTrust: scenario.trust === "trusted",
      ...(continuationEnv(scenario) ? { env: continuationEnv(scenario) } : {}),
    })
    await restoreConversation(app, scenario.prompt)
    await waitAgentSurface(app, "sidebar", (snap) => snap.continueVisible === true || transcriptHasTurnLimit(snap.bodyText || ""), 30000).catch(() => undefined)
    await saveShot(app, evidencePath, "before-stale-continue.png", true)
    const continued = await clickContinue(app, scenario, context, evidencePath, "continue.json")
    const text = `${paused.text}\n${continued.text}`
    writeEvidence(evidencePath, "assistant-final.txt", text)
    await saveShot(app, evidencePath, "after-stale-continue.png", true)
    const problems: string[] = []
    for (const relativePath of ["src/format.ts", "src/greet.ts", "src/parse.ts"]) {
      const body = readFileSync(join(dirs.workspace, relativePath), "utf8")
      if (!body.includes("EXTERNAL_STALE_MARKER")) problems.push(`overwrote external edit in ${relativePath}`)
    }
    const blob = text.toLowerCase()
    const noticed = /stale|diverg|changed since|checkpoint|resolve the stale|external/i.test(blob)
    if (!noticed) problems.push("agent did not report stale or diverged workspace state")
    problems.push(...filesystemProblems(dirs.workspace, before, { unchangedPaths: scenario.expected.unchangedPaths }))
    if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
    return "External edits survived Continue; the agent reported stale state and did not overwrite them."
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await app.close().catch(() => undefined)
  }
}

async function runCdpHistory(scenario: AcceptanceScenario, context: RunContext, evidencePath: string): Promise<string> {
  const liveBefore = liveProfileFingerprint()
  const { app, dirs } = await startCdpSession(scenario, context, evidencePath)
  let current = app
  try {
    await saveShot(current, evidencePath, "window.png", true)
    const taskId = `${context.runId}:${scenario.id}`
    const sent = await oneCdpTurn(current, scenario, scenario.prompt, taskId, dirs.workspace, evidencePath, "send.json")
    if (sent.blocked) return sent.blocked
    const original = await agentSurface(current, { op: "snapshot" }, "sidebar")
    writeEvidence(evidencePath, "messages-before.json", JSON.stringify(original.messages ?? [], null, 2))
    await agentSurface(current, { op: "historyOpen" }, "sidebar")
    const listed = await waitAgentSurface(current, "sidebar", (snap) => (snap.historyItems ?? []).length > 0, 10000)
    writeEvidence(evidencePath, "history-before.json", JSON.stringify(listed.historyItems ?? [], null, 2))
    const identity = (listed.historyItems ?? []).find((item) => item.current)?.label
      || (listed.historyItems ?? [])[0]?.label
      || scenario.prompt
    await saveShot(current, evidencePath, "before-restart.png", true)
    current = await relaunchCdpApp(current, {
      repositoryRoot: context.repositoryRoot,
      disableWorkspaceTrust: scenario.trust === "trusted",
    })
    writeEvidence(evidencePath, "relaunch.json", JSON.stringify({
      pid: current.pid,
      port: current.port,
      profile: current.userData,
    }, null, 2))
    await waitForAgentViews(current, 1, 45000)
    await agentSurface(current, { op: "historyOpen" }, "sidebar")
    const restoredList = await waitAgentSurface(current, "sidebar", (snap) => (snap.historyItems ?? []).some((item) => item.label.includes("historycheck") || (identity ? item.label === identity : false) || item.label.includes(scenario.prompt.slice(0, 24))), 20000).catch(async () => agentSurface(current, { op: "snapshot" }, "sidebar"))
    writeEvidence(evidencePath, "history-after.json", JSON.stringify(restoredList.historyItems ?? [], null, 2))
    const selected = await agentSurface(current, { op: "historySelect", value: "historycheck" }, "sidebar").catch(() => null)
    if (!selected || selected.found === false) {
      const byIdentity = identity ? await agentSurface(current, { op: "historySelect", value: identity.slice(0, 40) }, "sidebar").catch(() => null) : null
      if (!byIdentity || byIdentity.found === false) return "FAIL: History did not list the original conversation after restart"
    }
    const restored = await waitAgentSurface(current, "sidebar", (snap) => (snap.messages ?? []).some((message) => message.text.includes("historycheck")), 15000)
    writeEvidence(evidencePath, "messages-after.json", JSON.stringify(restored.messages ?? [], null, 2))
    await saveShot(current, evidencePath, "after-prompt.png", true)
    const problems = failuresForText((restored.messages ?? []).map((message) => message.text).join("\n"), scenario.expected)
    if (restored.approveVisible) problems.push("an interrupted approval was restored as actionable")
    const pendingReview = (restored.reviews ?? []).some((row) => /awaiting review|proposed/i.test(row) && /approve/i.test(row))
    if (pendingReview) problems.push("a proposed review was restored as actionable")
    const liveAfter = liveProfileFingerprint()
    const liveProblems = fingerprintDrift(liveBefore, liveAfter)
    writeEvidence(evidencePath, "live-profile.json", JSON.stringify({ before: liveBefore, after: liveAfter, liveProblems }, null, 2))
    if (liveProblems.length > 0) problems.push(...liveProblems)
    if (current.userData === liveProfileDirs()[0]) problems.push("lab relaunch used the live profile")
    if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
    return "The original conversation identity and messages were restored from the isolated profile History control."
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("webview") || message.includes("debug port")) return `BLOCKED: ${message}`
    throw error
  } finally {
    await current.close().catch(() => undefined)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
