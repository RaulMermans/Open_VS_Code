import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication, Page } from "playwright-core"
import { queryGuest, type GuestOp } from "./guest-bridge.ts"
import {
  classifySendAck,
  redactUrl,
  turnAssistantText,
  type ChatMessage,
  type LifecycleEvent,
  type SendAck,
} from "./oracles.ts"
import { livePage, type LabSession } from "./session.ts"

export interface ChatControl {
  isVisible(options?: { timeout?: number }): Promise<boolean>
  inputValue(options?: { timeout?: number }): Promise<string>
  innerText(options?: { timeout?: number }): Promise<string>
  selectOption(value: string, options?: { timeout?: number }): Promise<void>
  click(options?: { timeout?: number }): Promise<void>
  waitFor(options?: { state?: string; timeout?: number }): Promise<void>
  fill(value: string): Promise<void>
  press(key: string): Promise<void>
  pressSequentially(text: string): Promise<void>
}

export interface ChatSurface {
  readonly page: Page
  readonly app: ElectronApplication
  readonly locator: (selector: string) => ChatControl
}

export interface SendResult {
  readonly ack: SendAck
  readonly clicks: number
  readonly composerReady: boolean
  readonly composerValueAfter: string
  readonly userVisible: boolean
  readonly reloadAfterSend: boolean
  readonly detail: string
  readonly assistantText?: string
  readonly messages?: ChatMessage[]
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

function guestControl(app: ElectronApplication, selector: string): ChatControl {
  const read = () => queryGuest(app, { op: "read", selector })
  const act = (op: GuestOp) => queryGuest(app, op)
  return {
    async isVisible(options) {
      const timeout = options?.timeout ?? 0
      const started = Date.now()
      do {
        const result = await read()
        if (result?.visible) return true
        if (timeout <= 0) return false
        await sleep(150)
      } while (Date.now() - started < timeout)
      return false
    },
    async inputValue() {
      return (await read())?.value ?? ""
    },
    async innerText() {
      return (await read())?.text ?? ""
    },
    async selectOption(value) {
      const result = await act({ op: "select", selector, value })
      if (!result?.ok) throw new Error(`Could not select ${selector}`)
    },
    async click() {
      const result = await act({ op: "click", selector })
      if (!result?.ok) throw new Error(`Could not click ${selector}`)
    },
    async waitFor(options) {
      const visible = await this.isVisible({ timeout: options?.timeout ?? 10000 })
      if (!visible) throw new Error(`${selector} did not become visible`)
    },
    async fill(value) {
      const result = await act({ op: "fill", selector, value })
      if (!result?.ok) throw new Error(`Could not fill ${selector}. ${result?.text ?? "no result"}`)
    },
    async press(key) {
      const result = await act({ op: "press", selector, key })
      if (!result?.ok) throw new Error(`Could not press ${key} in ${selector}`)
    },
    async pressSequentially(text) {
      const current = (await read())?.value ?? ""
      const result = await act({ op: "fill", selector, value: current + text })
      if (!result?.ok) throw new Error(`Could not type into ${selector}`)
    },
  }
}

export function attachChatSurface(app: ElectronApplication, page: Page): ChatSurface {
  return guestSurface(app, page)
}

function guestSurface(app: ElectronApplication, page: Page): ChatSurface {
  return {
    page,
    app,
    locator: (selector: string) => guestControl(app, selector),
  }
}

export async function resolveChatSurface(
  app: ElectronApplication,
  timeoutMs: number,
  log?: WebviewLifecycleLog,
  preferred?: Page,
): Promise<ChatSurface> {
  const started = Date.now()
  let page = preferred
  let last = "no guest diagnostic"
  while (Date.now() - started < timeoutMs) {
    if (!page || page.isClosed()) {
      page = await workbenchPage(app, 1000).catch(() => undefined)
    }
    const composer = await queryGuest(app, { op: "read", selector: "#composer" })
    if (composer?.visible && page) {
      log?.record("composer-ready", "guest-bridge")
      return guestSurface(app, page)
    }
    if (composer?.text) last = composer.text
    await sleep(200)
  }
  log?.record("guest-bridge", last)
  throw new Error(`The Agent composer was not found through the Electron guest bridge. ${last}`)
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

export async function readMessages(surface: ChatSurface): Promise<ChatMessage[]> {
  const result = await queryGuest(surface.app, { op: "messages" })
  return result?.messages ?? []
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

export async function waitForSettledWebview(log: WebviewLifecycleLog, timeoutMs = 25000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const navigated = log.events.filter((event) => event.kind === "frame-navigated" && event.detail.includes("/index.html"))
    const last = navigated.at(-1)
    const detachedAfter = last
      ? log.events.some((event) => event.at > last.at && event.kind === "frame-detached" && event.detail.includes("/index.html"))
      : false
    if (last && !detachedAfter && Date.now() - last.at >= 1500) return
    await sleep(200)
  }
  throw new Error("Agent webview did not stay open long enough to send")
}

export async function sendPrompt(
  session: LabSession,
  prompt: string,
  log: WebviewLifecycleLog,
  existing?: ChatSurface,
): Promise<{ surface: ChatSurface; result: SendResult }> {
  const surface = existing ?? attachChatSurface(session.app, session.page)
  const beforeSend = Date.now()
  let clicks = 0
  let clickError: string | undefined
  let assistantText = ""
  let messages: ChatMessage[] = []
  let composerValueAfter = ""
  try {
    await waitForSettledWebview(log)
    log.record("webview-settled", "index.html stayed open")
    // One guest script only. A second executeJavaScript on the webview frame
    // closes the Playwright debugger, so the reply has to come back from this call.
    const submitted = await queryGuest(session.app, { op: "submit", value: prompt, timeoutMs: 170000 })
    if (!submitted?.ok) throw new Error(submitted?.text || "submit was not accepted")
    assistantText = submitted.text ?? ""
    messages = submitted.messages ?? []
    composerValueAfter = submitted.value ?? ""
    clicks = 1
    log.record("send-click", "guest-bridge submit")
  } catch (error) {
    clickError = error instanceof Error ? error.message : String(error)
    log.record("send-click", `error ${clickError.slice(0, 500)}`)
  }
  const users = messages.filter((message) => message.role === "user").map((message) => message.text)
  const ack = classifySendAck({
    prompt,
    composerValue: composerValueAfter,
    userMessages: users,
    sendClicked: clicks > 0,
    clickError,
  })
  const reloadAfterSend = log.events.some((event) => event.at >= beforeSend && (event.kind === "frame-detached" || event.kind === "frame-attached"))
  const detail = `${ack === "not_attempted" ? `send ${ack}; controls did not settle` : `send ${ack}`}${clickError ? ` (${clickError.slice(0, 240)})` : ""}`
  return {
    surface,
    result: {
      ack,
      clicks,
      composerReady: true,
      composerValueAfter,
      userVisible: userAlreadyPresent(users, prompt),
      reloadAfterSend: reloadAfterSend && ack !== "not_attempted",
      detail,
      assistantText,
      messages,
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
