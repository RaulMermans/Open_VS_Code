import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertLocalDebuggerUrl, CDP_TURN_RUNTIME, debuggerBindProblems, type CdpTurnRaw } from "./cdp-turn.ts"
import { redactUrl } from "./oracles.ts"
import { assertIsolatedPath, assertLabWorkspace, chromeSandboxMode } from "./safety.ts"
import { acceptanceBinary, prepareProfile } from "./session.ts"

interface DebugTarget {
  readonly type?: string
  readonly url?: string
  readonly webSocketDebuggerUrl?: string
  readonly title?: string
}

export interface FrameSample {
  readonly at: number
  readonly targets: { readonly type: string; readonly url: string }[]
  readonly error?: string
}

export interface CdpApp {
  readonly pid: number
  readonly userData: string
  readonly workspace: string
  readonly port: number
  readonly argv: string[]
  readonly sandboxMode: string
  readonly binary: string
  close(): Promise<void>
}

export interface CdpTurnRequest {
  readonly taskId: string
  readonly prompt: string
  readonly mode: string
  readonly model: string
  readonly timeoutMs: number
  readonly decision: "approve" | "reject" | "none"
  readonly workspace: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function labEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_") || key.startsWith("CURSOR_") || key === "NODE_OPTIONS") continue
    env[key] = value
  }
  env.OPEN_VS_CODE_REAL_INFERENCE = "1"
  env.CHROME_DESKTOP = "open-vs-code.desktop"
  return env
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

export function loopbackListeners(port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0")
  const found: string[] = []
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = ""
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n").slice(1)) {
      const local = line.trim().split(/\s+/)[1]
      if (!local) continue
      const [addr, current] = local.split(":")
      if (current?.toUpperCase() !== hexPort || !addr) continue
      if (addr === "0100007F") found.push("127.0.0.1")
      else if (addr === "0000000000000000000000000100007F") found.push("::1")
      else if (addr === "00000000" || addr === "00000000000000000000000000000000") found.push("wildcard")
      else found.push(addr)
    }
  }
  return found
}

class CdpSocket {
  private next = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }
      if (!message.id || !this.pending.has(message.id)) return
      const waiter = this.pending.get(message.id)!
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message || "CDP error"))
      else waiter.resolve(message.result)
    })
    ws.addEventListener("close", () => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error("debug socket closed"))
      }
      this.pending.clear()
    })
  }

  static async connect(rawUrl: string): Promise<CdpSocket> {
    const url = assertLocalDebuggerUrl(rawUrl)
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debug socket timed out")), 8000)
      ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("debug socket failed"))
      }, { once: true })
    })
    return new CdpSocket(ws)
  }

  call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.ws.close()
  }
}

async function listTargets(port: number): Promise<DebugTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`debug list returned ${response.status}`)
  return await response.json() as DebugTarget[]
}

function targetUrl(target: DebugTarget): string {
  return redactUrl(String(target.url || ""))
}

async function evaluate(socket: CdpSocket, expression: string, timeoutMs: number): Promise<unknown> {
  const result = await socket.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "page evaluation failed")
  }
  return result.result?.value
}

async function connectMatching(port: number, predicate: (value: unknown) => boolean, timeoutMs: number): Promise<{ socket: CdpSocket; url: string }> {
  const started = Date.now()
  let last = "no debug target"
  while (Date.now() - started < timeoutMs) {
    const targets = await listTargets(port).catch((error: unknown) => {
      last = error instanceof Error ? error.message : String(error)
      return [] as DebugTarget[]
    })
    for (const target of targets) {
      if (target.type !== "iframe" || !String(target.url || "").includes("/index.html") || !target.webSocketDebuggerUrl) continue
      let socket: CdpSocket | undefined
      try {
        socket = await CdpSocket.connect(target.webSocketDebuggerUrl)
        const value = await evaluate(socket, `(() => {
          const frame = document.getElementById("active-frame");
          const doc = frame && frame.contentDocument;
          const composer = doc && doc.getElementById("composer");
          return { composer: !!(composer) };
        })()`, 5000)
        if (predicate(value)) return { socket, url: targetUrl(target) }
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      socket?.close()
    }
    await sleep(300)
  }
  throw new Error(`Agent webview was not available through the local debug port. ${last}`)
}

export async function launchCdpApp(input: {
  userData: string
  workspace: string
  repositoryRoot: string
}): Promise<CdpApp> {
  const userData = assertIsolatedPath(input.userData, "Acceptance profile")
  const workspace = assertLabWorkspace(input.workspace, input.repositoryRoot)
  prepareProfile(userData)
  const binary = acceptanceBinary()
  const sandboxMode = chromeSandboxMode(binary)
  if (sandboxMode !== "4755") throw new Error(`Refusing to launch while chrome-sandbox mode is ${sandboxMode}`)
  const port = await freeLoopbackPort()
  if (!port) throw new Error("Could not reserve a loopback debug port")
  const args = [
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--disable-telemetry",
    "--disable-crash-reporter",
    "--skip-release-notes",
    "--no-first-run",
    "--disable-updates",
    workspace,
  ]
  if (args.some((arg) => arg === "--no-sandbox" || arg.startsWith("--no-sandbox="))) {
    throw new Error("Refusing to launch with --no-sandbox")
  }
  const child: ChildProcess = spawn(binary, args, {
    cwd: tmpdir(),
    env: labEnv(),
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  })
  const pid = child.pid
  if (!pid) throw new Error("Installed Electron process did not start")
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const fail = async (message: string): Promise<never> => {
    await stopProcess(pid)
    throw new Error(`${message}${stderr.trim() ? ` Child log: ${stderr.trim().slice(-2000)}` : ""}`)
  }
  const started = Date.now()
  let listening = false
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) return fail(`Installed Electron exited before the debug port opened (code ${child.exitCode})`)
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (version.ok) {
        listening = true
        break
      }
    } catch {
      // The port is opened after the window process starts.
    }
    await sleep(200)
  }
  if (!listening) return fail("Local debug port did not open")
  const bind = debuggerBindProblems(loopbackListeners(port))
  if (bind.length > 0) return fail(bind.join("; "))
  let argv: string[] = []
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (argv.includes("--no-sandbox")) return fail("Refusing to drive a process launched with --no-sandbox")
  return {
    pid,
    userData,
    workspace,
    port,
    argv,
    sandboxMode,
    binary,
    close: async () => {
      await stopProcess(pid)
    },
  }
}

async function stopProcess(pid: number): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      try {
        process.kill(pid, name)
      } catch {
        // already gone
      }
    }
  }
  signal("SIGTERM")
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(100)
  }
  signal("SIGKILL")
}

export async function workbenchTargets(app: CdpApp): Promise<DebugTarget[]> {
  const targets = await listTargets(app.port)
  const pages: DebugTarget[] = []
  for (const target of targets) {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) continue
    pages.push(target)
  }
  return pages
}

async function withWorkbench<T>(app: CdpApp, run: (socket: CdpSocket) => Promise<T | undefined>): Promise<T | undefined> {
  const pages = await workbenchTargets(app)
  let last: T | undefined
  for (const page of pages) {
    if (!page.webSocketDebuggerUrl) continue
    const socket = await CdpSocket.connect(page.webSocketDebuggerUrl)
    try {
      const value = await run(socket)
      if (value !== undefined) return value
      last = value
    } finally {
      socket.close()
    }
  }
  return last
}

const TRUST_EXPRESSION = `(() => {
  const visible = (node) => !!(node && node.getClientRects && node.getClientRects().length > 0);
  const label = (node) => String((node.innerText || node.textContent || "") + " " + (node.getAttribute && node.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
  const nodes = Array.from(document.querySelectorAll("button, a, .monaco-button, .statusbar-item"));
  const body = document.body ? (document.body.innerText || "") : "";
  const trustedNow = /You trust this folder|In a Trusted Folder|trust has been granted/i.test(body);
  const restricted = !trustedNow && (/Restricted Mode/i.test(body) || nodes.some((node) => /Restricted Mode/i.test(label(node))));
  const plain = (node) => String(node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim();
  const trustButton = nodes.find((node) => visible(node) && /^(Trust|Yes, I trust the authors)$/i.test(plain(node)));
  if (trustButton) {
    trustButton.click();
    return { clicked: true, kind: "trust", restricted: restricted, label: plain(trustButton).slice(0, 80) };
  }
  const bannerManage = nodes.find((node) => visible(node) && plain(node) === "Manage" && node.parentElement && /Learn More|not trusted/i.test(node.parentElement.innerText || ""));
  if (bannerManage) {
    bannerManage.click();
    return { clicked: true, kind: "manage", restricted: true, label: "Manage" };
  }
  return { clicked: false, kind: "none", restricted: restricted, text: body.slice(0, 400) };
})()`

export async function trustWorkspace(app: CdpApp): Promise<{ clicked: boolean; restricted: boolean; detail: string }> {
  let clicked = false
  let restricted = true
  let detail = ""
  const started = Date.now()
  while (Date.now() - started < 20000) {
    const pages = await workbenchTargets(app)
    let sawWorkbench = false
    for (const page of pages) {
      if (!page.webSocketDebuggerUrl) continue
      const socket = await CdpSocket.connect(page.webSocketDebuggerUrl)
      try {
        const marker = await evaluate(socket, `Boolean(document.querySelector(".monaco-workbench"))`, 5000)
        if (marker !== true) continue
        sawWorkbench = true
        const snapshot = await evaluate(socket, TRUST_EXPRESSION, 5000) as { clicked?: boolean; kind?: string; restricted?: boolean; label?: string; text?: string }
        restricted = snapshot?.restricted === true
        detail = snapshot?.label || snapshot?.text || detail
        if (snapshot?.clicked) clicked = true
      } finally {
        socket.close()
      }
      if (sawWorkbench) break
    }
    if (clicked && !restricted) break
    await sleep(400)
  }
  return { clicked, restricted, detail }
}

export async function captureWorkbenchWhenReady(app: CdpApp, timeoutMs = 20000): Promise<Buffer> {
  const started = Date.now()
  let last = "Workbench screenshot failed"
  while (Date.now() - started < timeoutMs) {
    try {
      return await captureWorkbench(app)
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      await sleep(400)
    }
  }
  throw new Error(last)
}

export async function captureWorkbench(app: CdpApp): Promise<Buffer> {
  const shot = await withWorkbench(app, async (socket) => {
    const marker = await evaluate(socket, `Boolean(document.querySelector(".monaco-workbench"))`, 5000)
    if (marker !== true) return undefined
    const result = await socket.call("Page.captureScreenshot", { format: "png" }, 10000) as { data?: string }
    if (!result.data) return undefined
    return Buffer.from(result.data, "base64")
  })
  if (!shot) throw new Error("Workbench screenshot failed")
  return shot
}

export async function sampleFrames(app: CdpApp): Promise<FrameSample> {
  try {
    const targets = await listTargets(app.port)
    return {
      at: Date.now(),
      targets: targets.map((target) => ({ type: String(target.type || ""), url: targetUrl(target) })),
    }
  } catch (error) {
    return { at: Date.now(), targets: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export async function runCdpTurn(app: CdpApp, request: CdpTurnRequest): Promise<{ raw: CdpTurnRaw; frames: FrameSample[]; targetUrl: string }> {
  const frames: FrameSample[] = []
  const sampler = setInterval(() => {
    void sampleFrames(app).then((sample) => frames.push(sample))
  }, 1000)
  frames.push(await sampleFrames(app))
  let socket: CdpSocket | undefined
  try {
    const connected = await connectMatching(app.port, (value) => Boolean((value as { composer?: boolean } | null)?.composer), 45000)
    socket = connected.socket
    const expression = `(${CDP_TURN_RUNTIME})(${JSON.stringify({
      taskId: request.taskId,
      prompt: request.prompt,
      mode: request.mode,
      model: request.model,
      timeoutMs: request.timeoutMs,
      decision: request.decision,
      workspace: request.workspace,
    })})`
    const raw = await evaluate(socket, expression, request.timeoutMs + 20000) as CdpTurnRaw
    frames.push(await sampleFrames(app))
    return { raw, frames, targetUrl: connected.url }
  } finally {
    clearInterval(sampler)
    socket?.close()
  }
}

export function writePng(file: string, bytes: Buffer): void {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, bytes)
}
