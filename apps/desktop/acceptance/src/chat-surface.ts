import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication, FrameLocator, Locator, Page } from "playwright-core"
import {
  classifySendAck,
  redactUrl,
  turnAssistantText,
  type ChatMessage,
  type LifecycleEvent,
  type SendAck,
} from "./oracles.ts"
import { livePage, type LabSession } from "./session.ts"

export interface ChatSurface {
  readonly page: Page
  readonly root: FrameLocator
  readonly locator: (selector: string) => Locator
}

export interface SendResult {
  readonly ack: SendAck
  readonly clicks: number
  readonly composerReady: boolean
  readonly composerValueAfter: string
  readonly userVisible: boolean
  readonly reloadAfterSend: boolean
  readonly detail: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class WebviewLifecycleLog {
  readonly events: LifecycleEvent[] = []
  private readonly seen = new WeakSet<object>()

  constructor(private readonly filePath: string) {
    mkdirSync(join(filePath, ".."), { recursive: true })
    writeFileSync(this.filePath, "")
  }

  record(kind: string, detail: string): void {
    const event = { at: Date.now(), kind, detail }
    this.events.push(event)
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`)
  }

  attachApp(app: ElectronApplication): void {
    app.on("window", (page) => {
      this.record("window-created", redactUrl(page.url()))
      this.attachPage(page)
    })
    for (const page of safeWindows(app)) this.attachPage(page)
  }

  attachPage(page: Page): void {
    if (this.seen.has(page)) return
    this.seen.add(page)
    page.on("close", () => this.record("window-closed", redactUrl(page.url())))
    page.on("framenavigated", (frame) => {
      this.record("frame-navigated", `${redactUrl(frame.url())} name=${frame.name()}`)
    })
    page.on("frameattached", (frame) => {
      this.record("frame-attached", `${redactUrl(frame.url())} name=${frame.name()}`)
    })
    page.on("framedetached", (frame) => {
      this.record("frame-detached", `${redactUrl(frame.url())} name=${frame.name()}`)
    })
  }

  snapshot(app: ElectronApplication): { windows: number; frames: { url: string; name: string }[] } {
    const windows = safeWindows(app)
    const frames = windows.flatMap((page) => {
      try {
        return page.frames().map((frame) => ({ url: redactUrl(frame.url()), name: frame.name() }))
      } catch {
        return []
      }
    })
    return { windows: windows.length, frames }
  }
}

export function safeWindows(app: ElectronApplication): Page[] {
  try {
    return app.windows()
  } catch {
    return []
  }
}

export async function workbenchPage(app: ElectronApplication, timeoutMs = 30000): Promise<Page> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    for (const page of safeWindows(app)) {
      const count = await page.locator(".monaco-workbench").count().catch(() => 0)
      if (count > 0) return page
    }
    await sleep(200)
  }
  throw new Error("The installed workbench did not appear")
}

async function composerVisible(root: FrameLocator, timeoutMs: number): Promise<boolean> {
  return root.locator("#composer").isVisible({ timeout: timeoutMs }).catch(() => false)
}

async function candidateRoots(page: Page): Promise<FrameLocator[]> {
  const webviews = page.locator("iframe.webview")
  const count = await webviews.count().catch(() => 0)
  const roots: FrameLocator[] = []
  for (let index = 0; index < count; index += 1) {
    const outer = webviews.nth(index).contentFrame()
    roots.push(outer.locator("iframe#active-frame").contentFrame())
    roots.push(outer)
  }
  return roots
}

async function surfaceFromFrames(page: Page): Promise<ChatSurface | null> {
  let frames: ReturnType<Page["frames"]> = []
  try {
    frames = page.frames()
  } catch {
    return null
  }
  for (const frame of frames) {
    try {
      if (frame.isDetached()) continue
      const url = frame.url()
      if (frame === page.mainFrame() || url === "about:blank") continue
      if (!/vscode-webview|webview/i.test(url) && frame.name() !== "pending-frame") continue
      const visible = await frame.locator("#composer").isVisible({ timeout: 200 }).catch(() => false)
      if (!visible) continue
      return {
        page,
        root: page.frameLocator("iframe.webview").last().contentFrame(),
        locator: (selector: string) => frame.locator(selector),
      }
    } catch {
      continue
    }
  }
  return null
}

function candidatePages(app: ElectronApplication, preferred?: Page): Page[] {
  const open = safeWindows(app)
  const pages: Page[] = []
  const add = (page: Page | undefined, keepClosed: boolean) => {
    if (!page) return
    if (pages.includes(page)) return
    if (!keepClosed) {
      try {
        if (page.isClosed()) return
      } catch {
        return
      }
    }
    pages.push(page)
  }
  add(preferred, true)
  for (const page of open) add(page, false)
  return pages
}

export async function resolveChatSurface(
  app: ElectronApplication,
  timeoutMs: number,
  log?: WebviewLifecycleLog,
  preferred?: Page,
): Promise<ChatSurface> {
  const started = Date.now()
  let last = "no windows"
  while (Date.now() - started < timeoutMs) {
    let pages = candidatePages(app, preferred)
    if (pages.length === 0) {
      const next = await app.waitForEvent("window", { timeout: 400 }).catch(() => null)
      if (next) {
        log?.attachPage(next)
        pages = [next]
      } else {
        last = "Playwright reports zero windows"
        await sleep(150)
        continue
      }
    }
    for (const page of pages) {
      log?.attachPage(page)
      const roots = await candidateRoots(page).catch(() => [])
      for (const root of roots) {
        if (await composerVisible(root, 400)) {
          return {
            page,
            root,
            locator: (selector: string) => root.locator(selector),
          }
        }
      }
      const fromFrames = await surfaceFromFrames(page)
      if (fromFrames) return fromFrames
    }
    last = `windows=${pages.length}`
    await sleep(150)
  }
  const snapshot = log?.snapshot(app)
  const urls = snapshot?.frames.map((frame) => `${frame.name}:${frame.url}`).join(" | ") || "(none)"
  throw new Error(`The Agent composer was not found. ${last}. Frames: ${urls}`)
}

export async function openAgentSurface(app: ElectronApplication, log?: WebviewLifecycleLog): Promise<void> {
  const page = await workbenchPage(app).catch(() => livePage(app))
  const iframeVisible = await page.locator("iframe.webview").last().isVisible({ timeout: 2500 }).catch(() => false)
  if (iframeVisible) return
  await page.keyboard.press("Escape").catch(() => undefined)
  await page.keyboard.press("Control+Shift+P")
  const palette = page.locator(".quick-input-widget input")
  await palette.waitFor({ timeout: 10000 })
  await palette.fill("Agent: Ask")
  await page.keyboard.press("Enter")
  await page.locator("iframe.webview").last().waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined)
}

export async function requireChat(session: LabSession, timeoutMs: number, log?: WebviewLifecycleLog): Promise<ChatSurface> {
  await openAgentSurface(session.app, log)
  return resolveChatSurface(session.app, timeoutMs, log, session.page)
}

export async function waitForAgentIframe(page: Page, timeoutMs: number): Promise<Locator> {
  const iframe = page.locator("iframe.webview").last()
  await iframe.waitFor({ state: "visible", timeout: timeoutMs })
  return iframe
}

export async function submitFromWorkbench(page: Page, prompt: string, log: WebviewLifecycleLog): Promise<void> {
  const iframe = await waitForAgentIframe(page, 20000)
  const box = await iframe.boundingBox()
  if (!box) throw new Error("Agent webview iframe has no bounding box")
  await page.mouse.click(box.x + Math.min(120, box.width / 2), box.y + box.height - 88)
  await page.keyboard.press("Control+A").catch(() => undefined)
  await page.keyboard.type(prompt, { delay: 5 })
  await page.keyboard.press("Enter")
  log.record("send-click", `workbench keyboard enter at ${Math.round(box.x)},${Math.round(box.y)}`)
}

export async function waitForReadyModel(surface: ChatSurface, timeoutMs: number): Promise<void> {
  const started = Date.now()
  let last = ""
  while (Date.now() - started < timeoutMs) {
    last = (await surface.locator("#connection-status").innerText().catch(() => "")).toLowerCase()
    if (last.includes("ready")) return
    await sleep(200)
  }
  throw new Error(`Local model did not become ready. Last status: ${JSON.stringify(last)}`)
}

export async function readMessages(surface: ChatSurface): Promise<ChatMessage[]> {
  return surface.locator("body").evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".message"))
    return nodes.map((node) => {
      const role = node.classList.contains("assistant")
        ? "assistant"
        : node.classList.contains("user")
          ? "user"
          : "other"
      const body = node.querySelector(".message-body")
      return { role, text: (body?.textContent ?? "").trim() }
    })
  }).catch(() => [])
}

export async function assistantTextForTurn(surface: ChatSurface, prompt: string): Promise<string> {
  return turnAssistantText(await readMessages(surface), prompt)
}

export async function selectMode(surface: ChatSurface, mode: string): Promise<void> {
  if (!mode || mode === "NONE") return
  const current = await surface.locator("#mode-selector").inputValue({ timeout: 800 }).catch(() => "")
  if (!current || current === mode) return
  await surface.locator("#mode-selector").selectOption(mode, { timeout: 10000 })
}

export async function selectModel(surface: ChatSurface, model: string): Promise<void> {
  if (!model || model === "none" || model.startsWith("missing-model:")) return
  const selector = surface.locator("#model-selector")
  const visible = await selector.isVisible({ timeout: 1000 }).catch(() => false)
  if (!visible) return
  const current = await selector.inputValue().catch(() => "")
  if (!current || current === model) return
  await selector.selectOption(model, { timeout: 5000 })
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await sleep(150)
  }
  return false
}

export async function sendPrompt(
  session: LabSession,
  prompt: string,
  log: WebviewLifecycleLog,
  existing?: ChatSurface,
): Promise<{ surface: ChatSurface; result: SendResult }> {
  let surface = existing ?? await requireChat(session, 20000, log)
  const beforeSend = Date.now()
  let clicks = 0
  let clickError: string | undefined
  try {
    const page = await workbenchPage(session.app, 5000).catch(() => surface.page)
    await submitFromWorkbench(page, prompt, log)
    clicks = 1
  } catch (error) {
    clickError = error instanceof Error ? error.message : String(error)
    log.record("send-click", `error ${clickError}`)
    const page = await workbenchPage(session.app, 8000).catch(() => null)
    if (page && clicks === 0) {
      try {
        await submitFromWorkbench(page, prompt, log)
        clicks = 1
        clickError = undefined
      } catch (retryError) {
        clickError = retryError instanceof Error ? retryError.message : String(retryError)
      }
    }
  }

  await sleep(1500)
  surface = await resolveChatSurface(session.app, 8000, log, surface.page).catch(() => surface)
  let composerValueAfter = await surface.locator("#composer").inputValue().catch(() => "")
  let users = (await readMessages(surface)).filter((message) => message.role === "user").map((message) => message.text)
  let ack = classifySendAck({
    prompt,
    composerValue: composerValueAfter,
    userMessages: users,
    sendClicked: clicks > 0,
    clickError,
  })
  const settled = ack !== "not_attempted"
  if (ack === "not_attempted" && clicks === 1 && composerValueAfter.trim() === prompt.trim()) {
    try {
      await surface.locator("#send-btn").click({ timeout: 5000 })
      clicks += 1
      log.record("send-click", "clicked after proving the first click was not accepted")
      clickError = undefined
    } catch (error) {
      clickError = error instanceof Error ? error.message : String(error)
    }
    await waitUntil(async () => {
      surface = await resolveChatSurface(session.app, 2000, log, surface.page).catch(() => surface)
      composerValueAfter = await surface.locator("#composer").inputValue().catch(() => prompt)
      users = (await readMessages(surface)).filter((message) => message.role === "user").map((message) => message.text)
      return userAlreadyPresent(users, prompt) || composerValueAfter.trim() === ""
    }, 8000)
    composerValueAfter = await surface.locator("#composer").inputValue().catch(() => "")
    users = (await readMessages(surface)).filter((message) => message.role === "user").map((message) => message.text)
    ack = classifySendAck({
      prompt,
      composerValue: composerValueAfter,
      userMessages: users,
      sendClicked: clicks > 0,
      clickError,
    })
  }
  const reloadAfterSend = log.events.some((event) => event.at >= beforeSend && (event.kind === "frame-detached" || event.kind === "frame-attached"))
  return {
    surface,
    result: {
      ack,
      clicks,
      composerReady: true,
      composerValueAfter,
      userVisible: userAlreadyPresent(users, prompt),
      reloadAfterSend: reloadAfterSend && ack !== "not_attempted",
      detail: settled ? `send ${ack}` : `send ${ack}; controls did not settle within 12s`,
    },
  }
}

function userAlreadyPresent(userMessages: readonly string[], prompt: string): boolean {
  return userMessages.some((text) => text.includes(prompt.trim()))
}

export async function waitForTurnAssistant(
  session: LabSession,
  prompt: string,
  timeoutMs: number,
  log: WebviewLifecycleLog,
  preferred?: Page,
): Promise<{ surface: ChatSurface; text: string }> {
  const started = Date.now()
  let surface = await resolveChatSurface(session.app, 15000, log, preferred)
  let last = ""
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    surface = await resolveChatSurface(session.app, 2000, log, surface.page).catch(() => surface)
    const running = await surface.locator("#cancel-btn").isVisible().catch(() => false)
    const text = await assistantTextForTurn(surface, prompt)
    if (!running && text.length > 0 && text === last) {
      stable += 1
      if (stable >= 2) return { surface, text }
    } else {
      stable = 0
    }
    last = text
    await sleep(400)
  }
  surface = await resolveChatSurface(session.app, 8000, log, surface.page)
  return { surface, text: await assistantTextForTurn(surface, prompt) }
}

export async function waitForApproval(surface: ChatSurface, timeoutMs: number): Promise<void> {
  await surface.locator("#btn-approve").waitFor({ state: "visible", timeout: timeoutMs })
}

export async function clickDecision(surface: ChatSurface, decision: "approve" | "reject", timeoutMs: number): Promise<void> {
  const selector = decision === "approve" ? "#btn-approve" : "#btn-reject"
  await surface.locator(selector).waitFor({ state: "visible", timeout: timeoutMs })
  await surface.locator(selector).click({ timeout: 10000 })
}
