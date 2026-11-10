import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { permitConfirmation, resolveInsideWorkspace } from "./src/confirmation-allow.ts"
import { CDP_TURN_RUNTIME, assertLocalDebuggerUrl, confirmationAllowed, debuggerBindProblems, interpretCdpTurn } from "./src/cdp-turn.ts"
import { assessJourney } from "./src/journey.ts"
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
  }), "unknown")
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

test("an empty composer is not a completed CDP submission", () => {
  const prompt = "Reply with the single word pong. Do not call tools."
  const taskId = "run:CONV-PING"
  const interpreted = interpretCdpTurn({
    taskId,
    prompt,
    workspace: "/tmp/ovsc-fixture",
    raw: {
      found: true,
      taskId,
      sendClicks: 1,
      composerValue: "",
      messages: [],
      timedOut: true,
    },
  })
  assert.equal(interpreted.ack, "unknown")
  assert.equal(interpreted.userCount, 0)
  assert.equal(interpreted.problems.some((problem) => problem.includes("timed out")), true)
})

test("a CDP turn binds one user message and its assistant reply to the task id", () => {
  const prompt = "Reply with the single word pong. Do not call tools."
  const taskId = "run:CONV-PING#1"
  const interpreted = interpretCdpTurn({
    taskId,
    prompt,
    workspace: "/tmp/ovsc-fixture",
    raw: {
      found: true,
      taskId,
      sendClicks: 1,
      composerValue: "",
      messages: [
        { role: "user", text: prompt },
        { role: "assistant", text: "pong" },
      ],
    },
  })
  assert.equal(interpreted.ack, "acknowledged")
  assert.equal(interpreted.userCount, 1)
  assert.equal(interpreted.assistant, "pong")
  assert.deepEqual(interpreted.problems, [])
  const mismatched = interpretCdpTurn({
    taskId,
    prompt,
    workspace: "/tmp/ovsc-fixture",
    raw: { found: true, taskId: "other", sendClicks: 1, messages: [{ role: "user", text: prompt }, { role: "assistant", text: "pong" }] },
  })
  assert.equal(mismatched.problems.some((problem) => problem.includes("task id")), true)
})

test("fixture approval rejects a path outside the disposable workspace", () => {
  assert.equal(confirmationAllowed("File src/add.js", "/tmp/ovsc-fixture"), true)
  assert.equal(confirmationAllowed("File /tmp/ovsc-fixture/src/add.js", "/tmp/ovsc-fixture"), true)
  assert.equal(confirmationAllowed("File ../escape.txt", "/tmp/ovsc-fixture"), false)
  assert.equal(confirmationAllowed("File /home/raul/secret.txt", "/tmp/ovsc-fixture"), false)
  assert.throws(() => assertLocalDebuggerUrl("ws://0.0.0.0:9222/devtools/page/1"))
  assert.equal(assertLocalDebuggerUrl("ws://127.0.0.1:9222/devtools/page/1").hostname, "127.0.0.1")
  assert.deepEqual(debuggerBindProblems(["127.0.0.1"]), [])
  assert.deepEqual(debuggerBindProblems(["wildcard"]), ["debug port is not limited to loopback"])
})

test("the CDP page script clicks Send once and reads the inner frame", async () => {
  const prompt = "Reply with the single word pong. Do not call tools."
  const messages: Array<{ className: string; text: string; classList: { contains: (name: string) => boolean }; querySelector: () => { textContent: string } }> = []
  const clicks: string[] = []
  class FakeEl {
    value = ""
    disabled = false
    textContent = ""
    innerText = ""
    options: Array<{ value: string }> = []
    selectionStart = 0
    selectionEnd = 0
    constructor(readonly id: string) {}
    click(): void {
      clicks.push(this.id)
      if (this.id === "send-btn") {
        this.value = ""
        composer.value = ""
        const user = message("user", prompt)
        const assistant = message("assistant", "pong")
        messages.push(user, assistant)
      }
    }
    getClientRects(): unknown[] {
      return this.id === "cancel-btn" ? [] : [{}]
    }
    dispatchEvent(): void {}
    closest(): null {
      return null
    }
  }
  function message(role: string, text: string) {
    return {
      className: role,
      text,
      classList: { contains: (name: string) => name === role },
      querySelector: () => ({ textContent: text }),
    }
  }
  const composer = new FakeEl("composer")
  const send = new FakeEl("send-btn")
  const status = new FakeEl("connection-status")
  status.innerText = "Ready · qwen3-coder:30b"
  const model = new FakeEl("model-selector")
  model.value = "qwen3-coder:30b"
  model.options = [{ value: "qwen3-coder:30b" }]
  const mode = new FakeEl("mode-selector")
  mode.value = "ASK"
  const elements = new Map<string, FakeEl>([
    ["composer", composer],
    ["send-btn", send],
    ["connection-status", status],
    ["model-selector", model],
    ["mode-selector", mode],
  ])
  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === ".message" ? messages : [],
    querySelector: () => null,
  }
  const sandbox = {
    document: { getElementById: (id: string) => id === "active-frame" ? { contentDocument: doc } : null },
    Event,
    window: {},
    setInterval: (callback: () => void) => {
      for (let tick = 0; tick < 4; tick += 1) queueMicrotask(callback)
      return 1
    },
    clearInterval: () => undefined,
  }
  const result = await runInNewContext(`(${CDP_TURN_RUNTIME})(${JSON.stringify({
    taskId: "run:CONV-PING",
    prompt,
    mode: "ASK",
    model: "qwen3-coder:30b",
    timeoutMs: 1000,
    decision: "none",
    workspace: "/tmp/ovsc-fixture",
  })})`, sandbox) as { sendClicks?: number; taskId?: string; assistant?: string; userCount?: number; frame?: string }
  assert.equal(result.sendClicks, 1)
  assert.deepEqual(clicks, ["send-btn"])
  assert.equal(result.taskId, "run:CONV-PING")
  assert.equal(result.userCount, 1)
  assert.equal(result.assistant, "pong")
  assert.equal(result.frame, "active-frame")
  assert.equal(CDP_TURN_RUNTIME.includes("contentFrame"), false)
  assert.equal(CDP_TURN_RUNTIME.includes("active-frame"), true)
})

test("a visible completion without the assistant class still belongs to the current turn", () => {
  const prompt = "Fix src/add.js only"
  const interpreted = interpretCdpTurn({
    taskId: "run:CODE-BUG",
    prompt,
    workspace: "/tmp/ovsc-fixture",
    raw: {
      found: true,
      taskId: "run:CODE-BUG",
      sendClicks: 1,
      composerValue: "",
      messages: [
        { role: "user", text: prompt },
        { role: "other", text: "Changed: src/add.js." },
      ],
    },
  })
  assert.equal(interpreted.ack, "acknowledged")
  assert.equal(interpreted.userCount, 1)
  assert.equal(interpreted.assistant, "Changed: src/add.js.")
  assert.deepEqual(interpreted.problems, [])
})

test("a correct edit that exhausted the turn budget is not an end-to-end pass", () => {
  const journey = assessJourney({
    expectsAgentCompletion: true,
    text: "Task failed (MAX_TURNS_EXCEEDED): Changed: src/add.js. Tests did not run.",
    activities: [],
    messageStatuses: ["failed"],
    commandExit: 0,
    expectedExit: 0,
    filesystemProblems: [],
    approvalBlocked: false,
  })
  assert.equal(journey.codeCorrect, true)
  assert.equal(journey.independentTestsPassed, true)
  assert.equal(journey.agentCompleted, false)
  assert.equal(journey.verificationReportedTruthfully, true)
  assert.equal(journey.endToEndSuccess, false)
  assert.equal(journey.failureReason, "MAX_TURNS_EXCEEDED")
})

test("approval uses the structured path, not a mention of a path in prose", () => {
  const workspace = mkdtempSync(join(tmpdir(), "ovsc-allow-"))
  const inside = resolveInsideWorkspace(workspace, "src/add.js")
  assert.equal(inside?.endsWith("/src/add.js"), true)
  assert.equal(resolveInsideWorkspace(workspace, "../escape.txt"), null)
  const allowed = permitConfirmation({
    confirmation: { id: "c1", kind: "mutation", operation: "patch", path: "src/add.js", cwd: "", executable: "", args: "", command: "" },
    workspace,
    decision: "approve",
  })
  assert.equal(allowed.permit, true)
  const prose = permitConfirmation({
    confirmation: { id: "", kind: "unknown", operation: "", path: "", cwd: "", executable: "", args: "", command: "" },
    workspace,
    decision: "approve",
  })
  assert.equal(prose.permit, false)
  const destructive = permitConfirmation({
    confirmation: { id: "c2", kind: "command", operation: "command", path: "", cwd: workspace, executable: "rm", args: "-rf .", command: "rm -rf ." },
    workspace,
    decision: "approve",
  })
  assert.equal(destructive.permit, false)
})

test("a disabled Agent mode is not clicked and is not retried as a send", async () => {
  const prompt = "Fix src/add.js"
  const messages: unknown[] = []
  const clicks: string[] = []
  class FakeEl {
    value = ""
    disabled = false
    textContent = ""
    innerText = "Ready · qwen3-coder:30b"
    options: Array<{ value: string; disabled?: boolean }> = []
    constructor(readonly id: string) {}
    click(): void {
      clicks.push(this.id)
    }
    getClientRects(): unknown[] {
      return [{}]
    }
    dispatchEvent(): void {}
    closest(): null {
      return null
    }
  }
  const composer = new FakeEl("composer")
  const send = new FakeEl("send-btn")
  const status = new FakeEl("connection-status")
  const model = new FakeEl("model-selector")
  model.value = "qwen3-coder:30b"
  model.options = [{ value: "qwen3-coder:30b" }]
  const mode = new FakeEl("mode-selector")
  mode.value = "ASK"
  mode.options = [{ value: "ASK" }, { value: "BUILD", disabled: true }]
  const elements = new Map<string, FakeEl>([
    ["composer", composer],
    ["send-btn", send],
    ["connection-status", status],
    ["model-selector", model],
    ["mode-selector", mode],
  ])
  const doc = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => messages,
    querySelector: () => null,
  }
  const result = await runInNewContext(`(${CDP_TURN_RUNTIME})(${JSON.stringify({
    taskId: "run:CODE-BUG",
    prompt,
    mode: "BUILD",
    model: "qwen3-coder:30b",
    timeoutMs: 1000,
    decision: "approve",
    workspace: "/tmp/ovsc-fixture",
  })})`, {
    document: { getElementById: (id: string) => id === "active-frame" ? { contentDocument: doc } : null },
    window: {},
    Event,
    setInterval: (callback: () => void) => {
      queueMicrotask(callback)
      return 1
    },
    clearInterval: () => undefined,
  }) as { sendClicks?: number; reason?: string }
  assert.equal(result.sendClicks, 0)
  assert.deepEqual(clicks, [])
  assert.match(result.reason ?? "", /trusted/)
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
