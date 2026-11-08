import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron as electron, type ElectronApplication, type Frame, type Page } from "playwright-core"
import { assertIsolatedPath, assertLabWorkspace, chromeSandboxMode } from "./safety.ts"

export interface LabSession {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userData: string
  readonly workspace: string
  readonly pid: number
  readonly argv: string[]
  readonly sandboxMode: string
  close(): Promise<void>
}

export function acceptanceBinary(): string {
  return process.env.OPEN_VS_CODE_ACCEPTANCE_BINARY?.trim() || "/usr/lib/open-vs-code/open-vs-code"
}

export function launcherScript(): string {
  return join(acceptanceBinary(), "..", "bin", "open-vs-code")
}

export function launcherExportsInference(): boolean {
  return readFileSync(launcherScript(), "utf8").includes("export OPEN_VS_CODE_REAL_INFERENCE=1")
}

export function installedPackageVersion(): string {
  const result = spawnSync("dpkg-query", ["-W", "-f", "${Version}", "open-vs-code"], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

function labEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_") || key.startsWith("CURSOR_") || key === "NODE_OPTIONS") continue
    env[key] = value
  }
  env.OPEN_VS_CODE_REAL_INFERENCE = "1"
  env.ELECTRON_ENABLE_LOGGING = "1"
  return env
}

export function prepareProfile(userData: string): void {
  assertIsolatedPath(userData, "Acceptance profile")
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor": "none",
    "workbench.secondarySideBar.defaultVisibility": "visible",
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "window.restoreWindows": "none",
  }, null, 2))
}

export async function launchLab(input: {
  userData: string
  workspace: string
  repositoryRoot: string
}): Promise<LabSession> {
  const userData = assertIsolatedPath(input.userData, "Acceptance profile")
  const workspace = assertLabWorkspace(input.workspace, input.repositoryRoot)
  prepareProfile(userData)
  const binary = acceptanceBinary()
  process.stderr.write(`acceptance-launch ${binary} profile=${userData}\n`)
  const app = await electron.launch({
    executablePath: binary,
    timeout: 60000,
    cwd: tmpdir(),
    env: labEnv(),
    args: [
      `--user-data-dir=${userData}`,
      "--disable-telemetry",
      "--disable-crash-reporter",
      "--skip-release-notes",
      "--no-first-run",
      "--disable-updates",
      workspace,
    ],
  })
  const child = app.process()
  const pid = child.pid
  if (!pid) throw new Error("Installed Electron process did not start")
  let childLog = ""
  child.stderr?.on("data", (chunk) => {
    childLog += String(chunk)
  })
  child.stdout?.on("data", (chunk) => {
    childLog += String(chunk)
  })
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
  if (argv.includes("--no-sandbox")) {
    await app.close().catch(() => undefined)
    throw new Error("Refusing to drive a process launched with --no-sandbox")
  }
  let page
  try {
    page = await waitForAnyWindow(app, child, 60000)
  } catch (error) {
    const suffix = childLog.trim() ? ` Child log: ${childLog.trim().slice(-2000)}` : " Child log empty."
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`)
  }
  return {
    app,
    page,
    userData,
    workspace,
    pid,
    argv,
    sandboxMode: chromeSandboxMode(binary),
    close: async () => {
      await app.close().catch(() => undefined)
      for (let i = 0; i < 40; i += 1) {
        try {
          process.kill(pid, 0)
        } catch {
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    },
  }
}

export async function waitForAnyWindow(app: ElectronApplication, child: { pid?: number; exitCode: number | null }, timeoutMs: number): Promise<Page> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let existing
    try {
      existing = app.windows()[0]
    } catch (error) {
      throw new Error(`Playwright lost the Electron connection: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (existing) return existing
    if (!child.pid || child.exitCode !== null) {
      throw new Error(`Installed Electron exited before a window opened (code ${child.exitCode})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`No Electron window opened within ${timeoutMs}ms (windows=${app.windows().length}, pid=${child.pid})`)
}

export async function waitForWorkbench(app: ElectronApplication, timeoutMs = 60000): Promise<Page> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const page of app.windows()) {
      const count = await page.locator(".monaco-workbench").count().catch(() => 0)
      if (count > 0) return page
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error("The installed workbench did not appear")
}

export async function livePage(app: ElectronApplication): Promise<Page> {
  const windows = app.windows()
  if (windows.length > 0) return windows[windows.length - 1]!
  throw new Error("No live Electron window remains")
}

export async function openAgentSurface(app: ElectronApplication): Promise<void> {
  if (await composerFrame(app, 2000)) return
  const page = await livePage(app)
  await page.keyboard.press("Control+Alt+b").catch(() => undefined)
  if (await composerFrame(app, 3000)) return
  await page.keyboard.press("Escape").catch(() => undefined)
  await page.keyboard.press("Control+Shift+P")
  const palette = page.locator(".quick-input-widget input")
  await palette.waitFor({ timeout: 10000 })
  await palette.fill("Open VS Code Agent")
  await page.keyboard.press("Enter")
  if (await composerFrame(app, 4000)) return
  const again = await livePage(app)
  await again.keyboard.press("Control+Shift+P")
  const palette2 = again.locator(".quick-input-widget input")
  await palette2.waitFor({ timeout: 10000 })
  await palette2.fill("Agent: Ask")
  await again.keyboard.press("Enter")
}

export async function composerFrame(app: ElectronApplication, timeoutMs: number): Promise<Frame | null> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const windows = app.windows()
    if (windows.length === 0) {
      await app.waitForEvent("window", { timeout: 400 }).catch(() => null)
      continue
    }
    for (const page of windows) {
      for (const frame of page.frames()) {
        const count = await frame.locator("#composer").count().catch(() => 0)
        if (count > 0) return frame
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

export async function assistantText(frame: Frame): Promise<string> {
  return frame.locator(".message.assistant .message-body").allTextContents().then((parts) => parts.join("\n")).catch(() => "")
}

export async function trustFolder(page: Page, trust: "trusted" | "untrusted" | "n/a"): Promise<void> {
  if (trust !== "trusted") return
  const button = page.locator(".monaco-button").filter({ hasText: /^(Trust|Yes, I trust the authors)$/ }).first()
  if (await button.isVisible().catch(() => false)) {
    await button.click()
    await page.waitForTimeout(500)
  }
}

export function readCmdline(pid: number): string[] {
  return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
}
