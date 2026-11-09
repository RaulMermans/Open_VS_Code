import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { GUEST_RUNTIME } from "./src/guest-bridge.ts"
import { loadCatalog } from "./src/catalog.ts"
import { assertApprovalTarget, assertIsolatedPath, liveProfileDirs } from "./src/safety.ts"
import { notRun } from "./src/execute.ts"
import {
  classifyPingContent,
  classifySendAck,
  gitCleanProblems,
  isPermittedRuntimePath,
  sourceDigest,
  trustStateFromWorkbench,
  turnAssistantText,
  unexpectedReload,
} from "./src/oracles.ts"

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..")

test("scenario catalog has a closed set of executable contracts", () => {
  const scenarios = loadCatalog()
  assert.ok(scenarios.length >= 40 && scenarios.length <= 50)
  const groups = new Set(scenarios.map((scenario) => scenario.group))
  for (const group of ["conversation", "coding", "safety", "experience", "lifecycle"]) {
    assert.equal(groups.has(group as never), true)
  }
  const critical = scenarios.filter((scenario) => scenario.tier === "critical")
  assert.ok(critical.length >= 8)
  const heldOut = scenarios.filter((scenario) => scenario.tier === "held-out")
  assert.ok(heldOut.length >= 5)
})

test("approval and profile guards refuse the product tree and a live profile", () => {
  assert.throws(() => assertApprovalTarget(REPOSITORY_ROOT, REPOSITORY_ROOT, "approve"))
  assert.throws(() => assertIsolatedPath(REPOSITORY_ROOT, "Acceptance profile"))
  for (const live of liveProfileDirs()) {
    assert.throws(() => assertIsolatedPath(live, "Acceptance profile"))
  }
  const scratch = mkdtempSync(join(tmpdir(), "ovsc-accept-guard-"))
  const isolated = assertIsolatedPath(scratch, "Acceptance profile")
  assert.equal(isolated.startsWith(scratch) || scratch.startsWith(isolated), true)
})

test("a scenario that was not launched is not a pass", () => {
  const scenario = loadCatalog()[0]!
  const result = notRun(scenario, join(tmpdir(), "ovsc-accept-score"))
  assert.equal(result.verdict, "NOT_RUN")
  assert.equal(result.cause, "not_executed")
  assert.notEqual(result.verdict, "PASS")
})

test("runtime ledger files are permitted and models.json is not", () => {
  assert.equal(isPermittedRuntimePath(".open-vs-code/model-performance-ledger.json"), true)
  assert.equal(isPermittedRuntimePath(".open-vs-code/recovery/runs/a/operations.jsonl"), true)
  assert.equal(isPermittedRuntimePath(".open-vs-code/models.json"), false)
  assert.equal(isPermittedRuntimePath("src/add.js"), false)
  const digested = sourceDigest({
    "src/add.js": "aaa",
    ".open-vs-code/model-performance-ledger.json": "bbb",
    ".open-vs-code/models.json": "ccc",
  })
  assert.deepEqual(digested, {
    "src/add.js": "aaa",
    ".open-vs-code/models.json": "ccc",
  })
})

test("git clean ignores only the permitted runtime tree", () => {
  const allowed = gitCleanProblems("?? .open-vs-code/", [
    ".open-vs-code/model-performance-ledger.json",
    ".open-vs-code/recovery/journal.json",
  ])
  assert.deepEqual(allowed, [])
  const unexpected = gitCleanProblems("?? .open-vs-code/", [
    ".open-vs-code/model-performance-ledger.json",
    ".open-vs-code/models.json",
  ])
  assert.equal(unexpected.some((problem) => problem.includes("models.json")), true)
  const dirty = gitCleanProblems(" M src/add.js", ["src/add.js"])
  assert.equal(dirty.length, 1)
})

test("send acknowledgement distinguishes missing, accepted, and unknown outcomes", () => {
  assert.equal(classifySendAck({
    prompt: "pong",
    composerValue: "pong",
    userMessages: [],
    sendClicked: false,
  }), "not_attempted")
  assert.equal(classifySendAck({
    prompt: "pong",
    composerValue: "",
    userMessages: ["pong"],
    sendClicked: true,
  }), "acknowledged")
  assert.equal(classifySendAck({
    prompt: "pong",
    composerValue: "pong",
    userMessages: [],
    sendClicked: true,
  }), "not_attempted")
  assert.equal(classifySendAck({
    prompt: "pong",
    composerValue: "",
    userMessages: [],
    sendClicked: true,
    clickError: "frame detached",
  }), "unknown")
  assert.equal(classifySendAck({
    prompt: "pong",
    composerValue: "later draft",
    userMessages: ["Reply with the single word pong. Do not call tools."],
    sendClicked: true,
    clickError: "timeout",
  }), "acknowledged")
})

test("assistant assertions bind to the current user turn", () => {
  const text = turnAssistantText([
    { role: "user", text: "hello" },
    { role: "assistant", text: "pong from an earlier turn" },
    { role: "user", text: "Reply with the single word pong. Do not call tools." },
    { role: "assistant", text: "pong" },
  ], "Reply with the single word pong. Do not call tools.")
  assert.equal(text, "pong")
  assert.equal(turnAssistantText([
    { role: "assistant", text: "pong" },
  ], "Reply with the single word pong. Do not call tools."), "")
})

test("CONV-PING transport success is not a content pass when a tool envelope remains", () => {
  const leaked = classifyPingContent("pong\n<tool_call>")
  assert.equal(leaked.transportTextPresent, true)
  assert.equal(leaked.protocolLeak, true)
  assert.equal(leaked.contentOk, false)
  const clean = classifyPingContent("pong")
  assert.equal(clean.contentOk, true)
})

test("a trust-required scenario can detect Restricted Mode before Send", () => {
  assert.equal(trustStateFromWorkbench("Restricted Mode\nAsk"), "restricted")
})

test("guest bridge fills and clicks the composer without attaching a frame", async () => {
  assert.equal(GUEST_RUNTIME.includes("contentFrame"), false)
  const clicked: string[] = []
  const elements = new Map<string, FakeEl>()
  class FakeEl {
    value = ""
    textContent = ""
    innerText = ""
    className = ""
    selectionStart = 0
    selectionEnd = 0
    constructor(readonly id: string) {}
    click(): void {
      clicked.push(this.id)
      if (this.id === "send-btn") {
        elements.get("composer")!.value = ""
      }
    }
    getClientRects(): unknown[] {
      return [{}]
    }
    dispatchEvent(): void {}
    querySelector(selector: string): FakeEl | null {
      if (selector === ".message-body") return this
      return null
    }
  }
  const composer = new FakeEl("composer")
  composer.value = ""
  const send = new FakeEl("send-btn")
  const status = new FakeEl("connection-status")
  status.innerText = "Ready · qwen3-coder:30b"
  elements.set("composer", composer)
  elements.set("send-btn", send)
  elements.set("connection-status", status)
  const sandbox = {
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelector: (selector: string) => elements.get(selector.slice(1)) ?? null,
      querySelectorAll: () => [],
    },
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    Event,
    KeyboardEvent: class KeyboardEvent {
      constructor(readonly type: string, readonly init: Record<string, unknown> = {}) {
        void type
        void init
      }
    },
  }
  const fill = runInNewContext(`(${GUEST_RUNTIME})(${JSON.stringify({ op: "fill", selector: "#composer", value: "pong" })})`, sandbox) as { ok?: boolean; value?: string }
  assert.equal(fill.ok, true)
  assert.equal(fill.value, "pong")
  const click = runInNewContext(`(${GUEST_RUNTIME})(${JSON.stringify({ op: "click", selector: "#send-btn" })})`, sandbox) as { ok?: boolean; value?: string }
  assert.equal(click.ok, true)
  assert.deepEqual(clicked, ["send-btn"])
  assert.equal(composer.value, "")
  runInNewContext(`(${GUEST_RUNTIME})(${JSON.stringify({ op: "fill", selector: "#composer", value: "line" })})`, sandbox)
  const shifted = runInNewContext(`(${GUEST_RUNTIME})(${JSON.stringify({ op: "press", selector: "#composer", key: "Shift+Enter" })})`, sandbox) as { value?: string }
  assert.equal(shifted.value, "line\n")
  const messages: { role: string; text: string; classList: { contains: (name: string) => boolean }; querySelector: () => { textContent: string } }[] = []
  sandbox.document.querySelectorAll = ((selector: string) => selector === ".message" ? messages : []) as typeof sandbox.document.querySelectorAll
  send.click = () => {
    clicked.push(send.id)
    composer.value = ""
    const user = { role: "user", text: "pong", classList: { contains: (name: string) => name === "user" }, querySelector: () => ({ textContent: "pong" }) }
    const assistant = { role: "assistant", text: "pong", classList: { contains: (name: string) => name === "assistant" }, querySelector: () => ({ textContent: "pong" }) }
    messages.push(user, assistant)
  }
  const waits: Array<() => void> = []
  Object.assign(sandbox, {
    setInterval: (callback: () => void) => {
      waits.push(callback)
      queueMicrotask(callback)
      return 1
    },
    clearInterval: () => undefined,
  })
  const submitted = await runInNewContext(`(${GUEST_RUNTIME})(${JSON.stringify({ op: "submit", value: "pong", timeoutMs: 1000 })})`, sandbox) as { ok?: boolean; text?: string }
  assert.equal(submitted.ok, true)
  assert.equal(submitted.text, "pong")
  const read = runInNewContext(`(${GUEST_RUNTIME})(${JSON.stringify({ op: "read", selector: "#connection-status" })})`, sandbox) as { visible?: boolean; text?: string }
  assert.equal(read.visible, true)
  assert.match(read.text ?? "", /qwen3-coder:30b/)
})

test("send waits until the webview document has stayed open", async () => {
  const { WebviewLifecycleLog, waitForSettledWebview } = await import("./src/chat-surface.ts")
  const root = mkdtempSync(join(tmpdir(), "ovsc-settle-"))
  const log = new WebviewLifecycleLog(join(root, "lifecycle.jsonl"))
  log.record("frame-navigated", "vscode-webview://agent/index.html name=active")
  const pending = waitForSettledWebview(log, 4000)
  await new Promise((resolve) => setTimeout(resolve, 1600))
  await pending
  log.record("frame-detached", "vscode-webview://agent/index.html name=active")
  log.record("frame-navigated", "vscode-webview://agent/index.html name=active")
  const again = waitForSettledWebview(log, 4000)
  await new Promise((resolve) => setTimeout(resolve, 1600))
  await again
})

test("webview detach plus attach after Send is an unexpected reload", () => {
  assert.equal(unexpectedReload([
    { at: 5, kind: "frame-detached", detail: "vscode-webview://agent name=active-frame" },
    { at: 6, kind: "frame-attached", detail: "vscode-webview://agent name=active-frame" },
  ], 4), true)
  assert.equal(unexpectedReload([
    { at: 1, kind: "frame-detached", detail: "vscode-webview://agent" },
  ], 4), false)
})
