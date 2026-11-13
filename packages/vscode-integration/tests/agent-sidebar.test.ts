import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { deriveConnectionStatus } from "../src/chat-ux-model.ts"

const require = createRequire(import.meta.url)

test("the agent view is contributed to the secondary sidebar, not the explorer", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const views = manifest.contributes.views
  assert.equal(views.explorer, undefined)
  assert.equal(views["open-vs-code-agent"][0].id, "open-vs-code.chat")
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, "open-vs-code-agent")
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited")
})

test("the chat page keeps one composer and asks, plans, and agents by their runtime modes", () => {
  const { ChatViewProvider } = require("../src/chat-view-provider.ts")
  let html = ""
  const provider = new ChatViewProvider({ fsPath: "/ext" } as any, { setWebviewView() {} } as any)
  provider.resolveWebviewView({ webview: { options: {}, set html(value: string) { html = value }, get html() { return html } } } as any, {} as any, {} as any)
  assert.equal(html.split('id="mode-selector"').length, 2)
  assert.match(html, /<option value="ASK">Ask<\/option>/)
  assert.match(html, /<option value="PLAN">Plan<\/option>/)
  assert.match(html, /<option value="BUILD">Agent<\/option>/)
  assert.match(html, /id="model-selector"/)
  assert.match(html, /id="history-btn"[^>]*aria-expanded="false"[^>]*aria-controls="history-panel"/)
  assert.doesNotMatch(html, /viewsContainers/)
})

test("wider chat is the same page with an editor layout class", () => {
  const { ChatViewProvider } = require("../src/chat-view-provider.ts")
  const provider = new ChatViewProvider({ fsPath: "/ext" } as any, { setWebviewView() {} } as any)
  const html = provider.htmlFor({} as any, { wide: true })
  assert.match(html, /class="wide-chat"/)
  assert.match(html, /id="composer"/)
  assert.match(html, /body\.wide-chat #wide-chat-btn \{ display: none; \}/)
})

test("connection status carries the probed local catalog without inventing readiness", () => {
  const offline = deriveConnectionStatus({
    inferenceBackend: "standalone-local",
    configStatus: "present",
    endpoint: "http://127.0.0.1:11434",
    lastError: "disconnected",
  })
  assert.equal(offline.state, "disconnected")
  assert.match(offline.detail || "", /Ollama is offline/)
  assert.equal(offline.installedModels, undefined)

  const ready = deriveConnectionStatus({
    inferenceBackend: "standalone-local",
    configStatus: "present",
    endpointVerified: true,
    endpoint: "http://127.0.0.1:11434",
    selectedModel: "qwen3-coder:30b",
    installedModels: ["qwen2.5-coder:7b", "qwen3-coder:30b"],
  })
  assert.equal(ready.state, "ready")
  assert.deepEqual(ready.installedModels, ["qwen2.5-coder:7b", "qwen3-coder:30b"])
  assert.equal(ready.selectedModel, "qwen3-coder:30b")
})
