import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Frame } from "playwright-core"
import type { AcceptanceScenario, ScenarioExpected } from "./catalog.ts"
import { assertApprovalTarget, assertIsolatedPath, liveProfileDirs } from "./safety.ts"
import {
  acceptanceBinary,
  assistantText,
  composerFrame,
  installedPackageVersion,
  launchLab,
  launcherExportsInference,
  openAgentSurface,
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function sourceDigest(digests: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(digests).filter(([path]) => !path.startsWith(".open-vs-code/")))
}

function filesystemProblems(workspace: string, before: Record<string, string>, expected: ScenarioExpected): string[] {
  const problems: string[] = []
  const after = sourceDigest(workspaceDigest(workspace))
  const initial = sourceDigest(before)
  if (expected.filesUnchanged || expected.gitClean) {
    if (expected.filesUnchanged && JSON.stringify(initial) !== JSON.stringify(after)) problems.push("workspace bytes changed")
    const dirty = gitPorcelain(workspace).split("\n").filter((line) => line && !line.includes(".open-vs-code")).join("\n")
    if (expected.gitClean && dirty !== "") problems.push(`git status is dirty: ${dirty}`)
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

async function requireComposer(session: LabSession, timeoutMs: number): Promise<Frame> {
  await openAgentSurface(session.app)
  const frame = await composerFrame(session.app, timeoutMs)
  if (!frame) {
    const urls = session.app.windows().flatMap((page) => page.frames().map((candidate) => candidate.url()))
    throw new Error(`The Agent composer was not found. Frames: ${urls.join(" | ") || "(none)"}`)
  }
  return frame
}

async function waitForReadyModel(frame: Frame, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const status = (await frame.locator("#connection-status").innerText().catch(() => "")).toLowerCase()
    if (status.includes("ready")) return
    await sleep(400)
  }
  throw new Error(`Local model did not become ready. Last status: ${JSON.stringify(await frame.locator("#connection-status").innerText().catch(() => ""))}`)
}

async function liveComposer(session: LabSession): Promise<Frame> {
  const existing = await composerFrame(session.app, 20000)
  if (existing) return existing
  throw new Error("The Agent composer frame disappeared after the window had opened")
}

async function sendPrompt(session: LabSession, prompt: string, existing?: Frame): Promise<Frame> {
  let frame = existing ?? await liveComposer(session)
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (!frame || (await frame.locator("#composer").count().catch(() => 0)) === 0) {
        frame = await liveComposer(session)
      }
      await waitForReadyModel(frame, 15000)
      await frame.locator("#composer").fill(prompt, { timeout: 4000 })
      await frame.locator("#send-btn").click({ timeout: 4000 })
      return frame
    } catch (error) {
      lastError = error
      frame = await composerFrame(session.app, 5000) ?? frame
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function selectMode(frame: Frame, mode: AcceptanceScenario["mode"]): Promise<void> {
  if (mode === "NONE") return
  const current = await frame.locator("#mode-selector").inputValue().catch(() => "")
  if (current === mode) return
  await frame.locator("#mode-selector").selectOption(mode)
}

async function selectModel(frame: Frame, model: string): Promise<Frame> {
  if (!model || model === "none" || model.startsWith("missing-model:")) return frame
  const current = await frame.locator("#model-selector").inputValue().catch(() => "")
  if (current === model) return frame
  const option = frame.locator("#model-selector option").filter({ hasText: model }).first()
  await option.waitFor({ state: "attached", timeout: 30000 })
  await frame.locator("#model-selector").selectOption(model)
  await sleep(500)
  return frame
}

async function waitForAssistant(session: LabSession, timeoutMs: number): Promise<{ frame: Frame; text: string }> {
  const started = Date.now()
  let last = ""
  let stable = 0
  let frame = await liveComposer(session)
  while (Date.now() - started < timeoutMs) {
    frame = await liveComposer(session)
    const text = await assistantText(frame)
    const running = await frame.locator("#cancel-btn").isVisible().catch(() => false)
    if (!running && text.length > 0 && text === last) {
      stable += 1
      if (stable >= 2) return { frame, text }
    } else {
      stable = 0
    }
    last = text
    await sleep(800)
  }
  frame = await liveComposer(session)
  return { frame, text: await assistantText(frame) }
}

async function clickDecision(frame: Frame, session: LabSession, scenario: AcceptanceScenario, repositoryRoot: string): Promise<void> {
  if (scenario.approval === "none") return
  assertApprovalTarget(session.workspace, repositoryRoot, scenario.approval)
  const selector = scenario.approval === "approve" ? "#btn-approve" : "#btn-reject"
  await frame.locator(selector).click({ timeout: scenario.timeoutMs })
  await sleep(1000)
}

function writeEvidence(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

async function screenshot(session: LabSession, dir: string, name: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await session.page.screenshot({ path: join(dir, name) }).catch(() => undefined)
}

export async function executeScenario(scenario: AcceptanceScenario, context: RunContext): Promise<ScenarioResult> {
  const started = Date.now()
  const evidencePath = join(context.evidenceRoot, scenario.id)
  mkdirSync(evidencePath, { recursive: true })
  try {
    const detail = await runScenario(scenario, context, evidencePath)
    const failed = detail.startsWith("FAIL:")
    const verdict: Verdict = failed ? "FAIL" : scenario.driver === "review" ? "NEEDS_REVIEW" : "PASS"
    return {
      id: scenario.id,
      title: scenario.title,
      tier: scenario.tier,
      group: scenario.group,
      verdict: detail.startsWith("FAIL:") ? "FAIL" : verdict,
      cause: detail.startsWith("FAIL:") ? causeFor(scenario, detail) : "none",
      oracle: scenario.oracle,
      forbidden: scenario.forbidden,
      timeoutMs: scenario.timeoutMs,
      durationMs: Date.now() - started,
      evidencePath,
      detail: detail.replace(/^FAIL:\s*/, ""),
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
  if (detail.includes("composer") || detail.includes("selector")) return "tooling"
  if (detail.includes("forbidden text") || detail.includes("<tool_call")) return "presentation"
  if (detail.includes("oracle") || detail.includes("exited")) return "model"
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
  try {
    writeEvidence(evidencePath, "argv.txt", session.argv.join("\n"))
    await session.page.locator(".monaco-workbench").waitFor({ timeout: 30000 })
    await sleep(1000)
    await screenshot(session, evidencePath, "window.png")
    if (scenario.id === "LIFE-SANDBOX") return sandboxDetail(session)
    if (scenario.id === "LIFE-CRASH") return crashDetail(session, dirs.userData)
    if (scenario.id === "SAFE-STALE") return staleDetail(session, dirs.workspace, before, scenario.expected)
    if (scenario.id === "LIFE-SECOND-REPO") {
      await session.close()
      return secondRepoDetail(dirs.workspace, before, context)
    }
    await trustFolder(session.page, scenario.trust)
    const frame = await requireComposer(session, 30000)
    await screenshot(session, evidencePath, "chat.png")
    if (scenario.id === "LIFE-FIRST") return firstLaunchDetail(frame, scenario.expected)
    if (scenario.id === "UX-TRUST") return trustDetail(session)
    if (scenario.id === "UX-KEYS") return keysDetail(frame)
    if (scenario.id === "UX-MODELS") return modelsDetail(session, scenario.expected)
    if (scenario.id === "UX-WIDE") return wideDetail(session, frame)
    if (scenario.id === "LIFE-MODEL") return modelPersistenceDetail(session, frame, scenario, context)
    if (scenario.driver === "review" && !scenario.prompt) {
      await screenshot(session, evidencePath, "review.png")
      return "Screenshot captured for human review."
    }
    if (!scenario.prompt && scenario.driver !== "electron-chat" && scenario.driver !== "review") {
      return `FAIL: no electron flow for ${scenario.id}`
    }
    return chatDetail(session, frame, scenario, context, before, evidencePath)
  } finally {
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
  await sleep(500)
  JSON.parse(readFileSync(settings, "utf8"))
  return "Profile settings.json is still valid JSON after SIGKILL."
}

function staleDetail(session: LabSession, workspace: string, before: Record<string, string>, expected: ScenarioExpected): string {
  process.kill(session.pid, "SIGKILL")
  const problems = filesystemProblems(workspace, before, expected)
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return "Killing the window left the fixture bytes unchanged."
}

async function secondRepoDetail(firstWorkspace: string, before: Record<string, string>, context: RunContext): Promise<string> {
  const dirs = freshRunDir("ovsc-accept-second-")
  materializeFixture("bug", dirs.workspace)
  const session = await launchLab({
    userData: dirs.userData,
    workspace: dirs.workspace,
    repositoryRoot: context.repositoryRoot,
  })
  await session.close()
  const problems = filesystemProblems(firstWorkspace, before, { filesUnchanged: true })
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return "A second isolated repository launch left the first fixture unchanged."
}

async function firstLaunchDetail(frame: Frame, expected: ScenarioExpected): Promise<string> {
  await frame.locator("#empty-state").waitFor({ state: "visible", timeout: 15000 })
  await frame.locator("#composer").waitFor({ state: "visible", timeout: 15000 })
  const started = Date.now()
  let text = ""
  while (Date.now() - started < 15000) {
    text = await frame.locator("#empty-state").innerText()
    if (failuresForText(text, expected).length === 0) break
    await sleep(400)
  }
  const problems = failuresForText(text, expected)
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}. empty-state: ${JSON.stringify(text).slice(0, 300)}`
  return "Fresh profile shows the empty-state copy."
}

async function trustDetail(session: LabSession): Promise<string> {
  const text = await session.page.locator("body").innerText()
  if (!text.includes("Restricted Mode") && !text.includes("Trust")) {
    return "FAIL: missing Restricted Mode or a trust prompt"
  }
  return "Untrusted folder shows a trust restriction."
}

async function keysDetail(frame: Frame): Promise<string> {
  const composer = frame.locator("#composer")
  await composer.click()
  await composer.fill("line")
  await composer.press("Shift+Enter")
  await composer.type("two")
  const value = await composer.inputValue()
  const running = await frame.locator("#cancel-btn").isVisible().catch(() => false)
  if (running) return "FAIL: Shift+Enter started a turn"
  if (!value.includes("\n")) return `FAIL: composer value has no newline: ${JSON.stringify(value)}`
  await composer.fill("")
  return "Shift+Enter inserted a newline and did not send."
}

async function modelsDetail(session: LabSession, expected: ScenarioExpected): Promise<string> {
  const frame = await liveComposer(session)
  await frame.locator("#models-btn").click({ timeout: 10000 })
  await sleep(500)
  const text = await (await liveComposer(session)).locator("#model-manager").innerText()
  const problems = failuresForText(text, expected)
  if (problems.length > 0) return `FAIL: ${problems.join("; ")}`
  return "Model manager shows the endpoint and selected model."
}

async function wideDetail(session: LabSession, frame: Frame): Promise<string> {
  await frame.locator("#overflow-menu summary").click()
  await frame.locator("#wide-chat-btn").click()
  await sleep(1500)
  const frames = session.app.windows().flatMap((page) => page.frames())
  let composers = 0
  for (const candidate of frames) {
    composers += await candidate.locator("#composer").count().catch(() => 0)
  }
  if (composers < 1) return "FAIL: wider chat did not leave a composer on screen"
  return `Wider chat left ${composers} composer surface(s).`
}

async function modelPersistenceDetail(session: LabSession, frame: Frame, scenario: AcceptanceScenario, context: RunContext): Promise<string> {
  await selectModel(frame, scenario.model)
  const userData = session.userData
  const workspace = session.workspace
  await session.close()
  const again = await launchLab({ userData, workspace, repositoryRoot: context.repositoryRoot })
  try {
    const next = await requireComposer(again, 30000)
    const value = await next.locator("#model-selector").inputValue()
    if (value !== scenario.model) return `FAIL: model selector is ${value}`
    if (existsSync(join(workspace, ".open-vs-code", "models.json"))) return "FAIL: workspace models.json was created"
    return `Model selector kept ${value} after restart.`
  } finally {
    await again.close()
  }
}

async function chatDetail(
  session: LabSession,
  frame: Frame,
  scenario: AcceptanceScenario,
  context: RunContext,
  before: Record<string, string>,
  evidencePath: string,
): Promise<string> {
  await selectMode(frame, scenario.mode)
  frame = await selectModel(frame, scenario.model)
  const refreshed = await composerFrame(session.app, 10000)
  if (refreshed) frame = refreshed
  if (scenario.id === "SAFE-CANCEL") {
    frame = await sendPrompt(session, scenario.prompt, frame)
    frame = await liveComposer(session)
    await frame.locator("#cancel-btn").click({ timeout: scenario.timeoutMs })
    await frame.locator("#composer").waitFor({ state: "visible", timeout: 30000 })
  } else if (scenario.prompt) {
    frame = await sendPrompt(session, scenario.prompt, frame)
    const first = await waitForAssistant(session, scenario.timeoutMs)
    frame = first.frame
    if (scenario.approval !== "none") {
      frame = await liveComposer(session)
      await clickDecision(frame, session, scenario, context.repositoryRoot)
    }
    if (scenario.followUp) {
      await waitForAssistant(session, scenario.timeoutMs)
      frame = await sendPrompt(session, scenario.followUp)
      frame = (await waitForAssistant(session, scenario.timeoutMs)).frame
    }
  }
  const text = await assistantText(frame)
  writeEvidence(evidencePath, "assistant.txt", text)
  await screenshot(session, evidencePath, "after-prompt.png")
  const problems = [
    ...failuresForText(text, scenario.expected),
    ...filesystemProblems(session.workspace, before, scenario.expected),
  ]
  if (scenario.id === "SAFE-APPROVE") {
    const source = readFileSync(join(session.workspace, "src", "add.js"), "utf8")
    if (source.includes("a + b + 1")) problems.push("src/add.js still returns a + b + 1")
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
