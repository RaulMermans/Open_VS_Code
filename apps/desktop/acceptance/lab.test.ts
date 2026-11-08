import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

test("webview detach plus attach after Send is an unexpected reload", () => {
  assert.equal(unexpectedReload([
    { at: 5, kind: "frame-detached", detail: "vscode-webview://agent name=active-frame" },
    { at: 6, kind: "frame-attached", detail: "vscode-webview://agent name=active-frame" },
  ], 4), true)
  assert.equal(unexpectedReload([
    { at: 1, kind: "frame-detached", detail: "vscode-webview://agent" },
  ], 4), false)
})
