import { test, describe, before } from "node:test";
import * as assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  renderTerminalOutput,
  renderConfirmationSummary,
  renderReviewLedger,
  updateTerminalElapsed,
  webviewRenderRuntime,
} from "../src/webview-render-helpers.ts";
import { parseWebviewMessage } from "../src/chat-protocol.ts";
import { describeMutationFailure } from "../src/review-model.ts";
import { PUBLISH_OWN_PID_INLINE, PUBLISH_PID_SOURCE, readPublishedPid } from "./helpers/process-tree.ts";

const commandCalls: Array<{ id: string; args: any[] }> = [];
const outputChannels: Array<{ name: string; lines: string[]; shown: number }> = [];
const mockVscode: any = {
  EventEmitter: class {
    event() { return () => {}; }
    fire() {}
    dispose() {}
  },
  window: {
    errors: [] as string[],
    showErrorMessage: (msg: string) => { mockVscode.window.errors.push(msg); },
    showWarningMessage: async () => "Cancel",
    showTextDocument: async (uri: any) => { mockVscode.window.shown.push(uri.fsPath || String(uri)); },
    shown: [] as string[],
    createOutputChannel: (name: string) => {
      const channel = { name, lines: [] as string[], shown: 0 };
      outputChannels.push(channel);
      return {
        appendLine: (s: string) => { channel.lines.push(s); },
        show: () => { channel.shown++; },
        dispose: () => {},
      };
    },
  },
  commands: {
    failGit: false,
    executeCommand: async (id: string, ...args: any[]) => {
      commandCalls.push({ id, args });
      if (id === "git.openChange" && mockVscode.commands.failGit) throw new Error("command 'git.openChange' not found");
    },
  },
  env: { clipboard: { last: "", writeText: async (text: string) => { mockVscode.env.clipboard.last = text; } } },
  workspace: {
    isTrusted: true,
    workspaceFolders: [] as any[],
    textDocuments: [] as any[],
    findFiles: async () => [],
    asRelativePath: (u: any) => String(u),
  },
  Uri: {
    joinPath: (base: any, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts), path: join(base.fsPath, ...parts) }),
    parse: (value: string) => ({ toString: () => value }),
  },
};

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string) {
  if (request === "vscode") return "vscode";
  return originalResolveFilename.apply(this, arguments);
};
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "vscode") return mockVscode;
  return originalRequire.apply(this, arguments);
};

let ChatController: any;
let DiffReviewController: any;
let TerminalReviewController: any;
let VerificationEngine: any;
let MutationEngine: any;

class MockWebview {
  public messages: any[] = [];
  public controller?: { handleWebviewMessage: (msg: any) => Promise<void> };
  onDidReceiveMessage() { return { dispose: () => {} }; }
  postMessage(message: any) { this.messages.push(message); }
  async send(msg: any) { await this.controller!.handleWebviewMessage(msg); }
  count(type: string) { return this.messages.filter((m) => m.type === type).length; }
}

class MockElement {
  public textContent = "";
  public className = "";
  public id = "";
  public type = "";
  public open = false;
  public tagName: string;
  public children: MockElement[] = [];
  public attrs: Record<string, string> = {};
  public style: Record<string, string> = {};
  public disabled = false;
  public focused = 0;
  public listeners: Record<string, Function[]> = {};
  [key: string]: any;
  constructor(tag = "div") { this.tagName = tag; }
  set innerHTML(val: string) { if (val === "") this.children = []; }
  get innerHTML() { return ""; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child: MockElement) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name]; }
  addEventListener(type: string, fn: Function) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn(); }
  focus() { this.focused++; }
}

function mockDoc() {
  let created = 0;
  return {
    created: () => created,
    createElement(tag: string) { created++; return new MockElement(tag); },
  };
}

function walk(el: MockElement, out: MockElement[] = []): MockElement[] {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}
const allText = (el: MockElement) => walk(el).map((e) => e.textContent).join("\n");
const buttons = (el: MockElement) => walk(el).filter((e) => e.tagName === "button");
const button = (el: MockElement, label: string) => buttons(el).find((b) => b.textContent === label);

async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function fixtures(options: { maxOutputBytes?: number } = {}) {
  // Real path: the engine's cwd containment check compares against the realpath'd root.
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "sprint7b-")));
  mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot }, name: "workspace" }];
  mockVscode.workspace.textDocuments = [];
  const opened: string[] = [];
  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: undefined,
      diagnostics: [],
      visibleDocuments: [],
      isTrusted: true,
    }),
    showOutput: async () => {},
    showError: async () => {},
    openWorkspaceFile: async (path: string) => { opened.push(path); },
  };
  let runTask: any = null;
  const signals: AbortSignal[] = [];
  const bridgeFactory = () => ({
    runTask: async (instruction: string, mode: string, signal: AbortSignal, onEvent: any) => {
      signals.push(signal);
      return runTask(instruction, mode, signal, onEvent);
    },
  });
  const diff = new DiffReviewController();
  const terminal = new TerminalReviewController(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : undefined);
  const controller = new ChatController(host, diff, bridgeFactory, terminal);
  const view = { webview: new MockWebview() };
  view.webview.controller = controller;
  controller.setWebviewView(view as any);
  return {
    controller, view, diff, terminal, opened, tmpRoot, signals,
    state: () => controller["state"],
    setRunTask: (fn: any) => { runTask = fn; },
  };
}

function command(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    action: "run_known_test",
    preparedCommand: {
      verificationId: id,
      executable: "/usr/local/bin/npm",
      args: ["run", "test", "--", "--grep", "two words"],
      cwd,
      commandPreview: "/usr/local/bin/npm run test -- --grep two words",
      scriptName: "test",
      scriptBody: "node --test",
      timeoutMs: 60000,
      ...extra,
    },
  };
}

function mutation(id: string, path: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    operation: "patch",
    path,
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    linesAdded: 3,
    linesRemoved: 1,
    beforeContent: "old\n",
    proposedContent: "new\n",
    ...extra,
  };
}

/** Starts a turn whose scripted runner is driven step by step from the test. */
function scriptedTurn(fx: ReturnType<typeof fixtures>) {
  const ctl: any = { onEvent: undefined, signal: undefined, finish: undefined as any };
  const done = new Promise<any>((resolve) => { ctl.finish = resolve; });
  fx.setRunTask(async (_i: string, _m: string, signal: AbortSignal, onEvent: any) => {
    ctl.onEvent = onEvent;
    ctl.signal = signal;
    return done;
  });
  ctl.turn = fx.view.webview.send({ type: "chat.send", text: "go", mode: "BUILD" });
  return ctl;
}

before(() => {
  const req = createRequire(import.meta.url);
  ChatController = req("../src/chat-controller.ts").ChatController;
  DiffReviewController = req("../src/diff-review-controller.ts").DiffReviewController;
  TerminalReviewController = req("../src/terminal-review-controller.ts").TerminalReviewController;
  VerificationEngine = req("../../agent-core/src/tools/verification-engine.ts").VerificationEngine;
  MutationEngine = req("../../agent-core/src/tools/mutation-engine.ts").MutationEngine;
});

describe("Sprint 7B terminal experience", () => {
  test("1. proposed command renders executable, args, cwd, source, script and limit", () => {
    const root = new MockElement();
    renderConfirmationSummary(root, {
      id: "c1",
      summary: "Run verification TEST?",
      riskLabel: "Controlled Verification Terminal",
      preparedCommand: {
        executionId: "v1",
        command: "/usr/local/bin/npm run test",
        executable: "/usr/local/bin/npm",
        args: ["run", "test", "--", "--grep", "two words", ""],
        cwd: "/work/repo",
        provenance: "package.json [test]",
        scriptName: "test",
        scriptBody: "node --test",
        timeoutMs: 60000,
        status: "WAITING_APPROVAL",
      },
    }, mockDoc());
    const text = allText(root);
    assert.match(text, /\/usr\/local\/bin\/npm run test/);
    assert.match(text, /Executable\n\/usr\/local\/bin\/npm/);
    assert.match(text, /run test -- --grep "two words" ""/);
    assert.match(text, /Directory\n\/work\/repo/);
    assert.match(text, /Source\npackage\.json \[test\]/);
    assert.match(text, /Script\nnode --test/);
    assert.match(text, /Time limit\n1 m/);
    assert.equal(button(root, "Run")?.attrs["aria-label"], "Run this command");
  });

  test("2. exact command and cwd reach the card unchanged", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("Run?", command("ver-2", fx.tmpRoot));
    const pc = fx.state().pendingConfirmation.preparedCommand;
    assert.equal(pc.command, "/usr/local/bin/npm run test -- --grep two words");
    assert.equal(pc.cwd, fx.tmpRoot);
    assert.equal(pc.executable, "/usr/local/bin/npm");
    assert.deepEqual(pc.args, ["run", "test", "--", "--grep", "two words"]);
    assert.equal(pc.provenance, "package.json [test]");
    assert.equal(pc.outputLimitBytes, 16 * 1024);
    await fx.view.webview.send({ type: "terminal.respond", confirmationId: fx.state().pendingConfirmation.id, action: "REJECT" });
    assert.equal(await decision, "REJECT");
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });

  test("3. approval starts the clock and shows output; rejection records not-run", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const approved = fx.controller.requestConfirmation("Run?", command("ver-3a", fx.tmpRoot));
    await fx.view.webview.send({ type: "terminal.respond", confirmationId: fx.state().pendingConfirmation.id, action: "APPROVE" });
    assert.equal(await approved, "APPROVE");
    const running = fx.state().activeTerminal;
    assert.equal(running.status, "RUNNING");
    assert.equal(typeof running.startedAt, "number");
    assert.equal(running.isOutputVisible, true);
    t.onEvent({ type: "verification.completed", payload: { executionId: "ver-3a", result: { status: "PASS", exitCode: 0, durationMs: 1234, stdout: "ok\n", stderr: "" } } });
    assert.equal(fx.terminal.getByExecutionId("ver-3a").status, "SUCCEEDED");

    const rejected = fx.controller.requestConfirmation("Run?", command("ver-3b", fx.tmpRoot));
    await fx.view.webview.send({ type: "terminal.respond", confirmationId: fx.state().pendingConfirmation.id, action: "REJECT" });
    assert.equal(await rejected, "REJECT");
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
    const rows = fx.state().reviews;
    assert.deepEqual(rows.map((r: any) => [r.id, r.status, r.exitCode ?? null]), [["ver-3a", "succeeded", 0], ["ver-3b", "rejected", null]]);

    const card = new MockElement();
    renderTerminalOutput(card, { ...fx.state().activeTerminal }, mockDoc());
    assert.match(allText(card), /Rejected — not run/);
    assert.equal(button(card, "Copy output"), undefined, "a command that never ran offers no output");
  });

  test("4. rapid repeated and contradictory approvals resolve exactly once", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    let resolutions = 0;
    const decision = fx.controller.requestConfirmation("Approve?", mutation("mut-4", "src/a.ts")).then((v: string) => { resolutions++; return v; });
    const id = fx.state().pendingConfirmation.id;
    const burst = [];
    for (let i = 0; i < 25; i++) {
      burst.push(fx.view.webview.send({ type: "confirmation.respond", confirmationId: id, action: i % 2 ? "REJECT" : "APPROVE" }));
      burst.push(fx.view.webview.send({ type: "terminal.respond", confirmationId: id, action: "REJECT" }));
    }
    await Promise.all(burst);
    assert.equal(await decision, "APPROVE");
    assert.equal(resolutions, 1);

    // A second request while one is pending fails closed and leaves the first decidable.
    const first = fx.controller.requestConfirmation("First?", mutation("mut-4b", "src/b.ts"));
    const firstId = fx.state().pendingConfirmation.id;
    assert.equal(await fx.controller.requestConfirmation("Conflicting?", mutation("mut-4c", "src/c.ts")), "REJECT");
    assert.equal(fx.state().pendingConfirmation.id, firstId);
    assert.equal(fx.state().reviews.some((r: any) => r.id === "mut-4c"), false);
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: firstId, action: "REJECT" });
    assert.equal(await first, "REJECT");
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });

  test("5. cancel only targets a running command, and late results cannot overwrite it", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("Run?", command("ver-5", fx.tmpRoot));
    const id = fx.state().pendingConfirmation.id;

    // Forged or premature cancels do nothing.
    await fx.view.webview.send({ type: "terminal.cancel", executionId: "not-a-real-id" });
    await fx.view.webview.send({ type: "terminal.cancel", executionId: "ver-5" });
    assert.equal(t.signal.aborted, false);
    assert.ok(fx.state().pendingConfirmation, "a command awaiting approval is rejected, not cancelled");

    await fx.view.webview.send({ type: "terminal.respond", confirmationId: id, action: "APPROVE" });
    await decision;
    await fx.view.webview.send({ type: "terminal.cancel", executionId: "ver-5" });
    assert.equal(t.signal.aborted, true);
    assert.equal(fx.terminal.getByExecutionId("ver-5").status, "CANCELLED");

    t.onEvent({ type: "verification.completed", payload: { executionId: "ver-5", result: { status: "PASS", exitCode: 0, durationMs: 50, stdout: "late", stderr: "" } } });
    const entry = fx.terminal.getByExecutionId("ver-5");
    assert.equal(entry.status, "CANCELLED");
    assert.equal(entry.exitCode, 0);
    t.onEvent({ type: "verification.completed", payload: { executionId: "ver-5", result: { status: "FAIL", exitCode: 9, durationMs: 99 } } });
    assert.equal(fx.terminal.getByExecutionId("ver-5").exitCode, 0, "a second completion is ignored");
    t.onEvent({ type: "verification.started", payload: { executionId: "ver-5" } });
    assert.equal(fx.terminal.getByExecutionId("ver-5").status, "CANCELLED");
    t.finish({ status: "CANCELLED" });
    await t.turn;
  });

  test("6. timeout and cancellation kill the real process tree", async () => {
    const fx = fixtures();
    const childPidFile = join(fx.tmpRoot, "child.pid");
    const parentPidFile = join(fx.tmpRoot, "parent.pid");
    writeFileSync(join(fx.tmpRoot, "spawn.cjs"), [
      "const { spawn } = require('node:child_process');",
      PUBLISH_PID_SOURCE,
      "publishPid(process.argv[3], process.pid);",
      "const c = spawn(process.execPath, ['-e', " + JSON.stringify(PUBLISH_OWN_PID_INLINE + " setInterval(() => {}, 1000);") + ", process.argv[2]], { stdio: 'ignore' });",
      "console.log('spawned');",
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const pkg = JSON.stringify({ name: "fixture", scripts: { test: "node spawn.cjs" } });
    writeFileSync(join(fx.tmpRoot, "package.json"), pkg);
    const engine = new VerificationEngine({ workspaceRoot: fx.tmpRoot });

    async function runOnce(id: string, timeoutMs: number, cancel: boolean) {
      const prepared = {
        verificationId: id,
        action: "TEST",
        executable: process.execPath,
        args: [join(fx.tmpRoot, "spawn.cjs"), childPidFile + id, parentPidFile + id],
        cwd: fx.tmpRoot,
        timeoutMs,
        commandPreview: "node spawn.cjs",
        packageJsonPath: join(fx.tmpRoot, "package.json"),
        packageJsonHash: createHash("sha256").update(pkg).digest("hex"),
        scriptName: "test",
        scriptBody: "node spawn.cjs",
      };
      const t = scriptedTurn(fx);
      await waitFor(() => !!t.onEvent);
      const decision = fx.controller.requestConfirmation("Run?", { action: "run_known_test", preparedCommand: prepared });
      await fx.view.webview.send({ type: "terminal.respond", confirmationId: fx.state().pendingConfirmation.id, action: "APPROVE" });
      assert.equal(await decision, "APPROVE");
      t.onEvent({ type: "verification.started", payload: { executionId: id } });
      const resultPromise = engine.execute(prepared, t.signal, (chunk: any) => {
        t.onEvent({ type: "verification.output", payload: { executionId: id, ...chunk } });
      });
      const childPid = await readPublishedPid(childPidFile + id);
      const parentPid = await readPublishedPid(parentPidFile + id);
      assert.equal(isAlive(childPid), true);
      if (cancel) await fx.view.webview.send({ type: "terminal.cancel", executionId: id });
      const result = await resultPromise;
      t.onEvent({ type: "verification.completed", payload: { executionId: id, result } });
      await waitFor(() => !isAlive(childPid) && !isAlive(parentPid));
      t.finish({ status: cancel ? "CANCELLED" : "COMPLETED", finalAnswer: "done" });
      await t.turn;
      return { result, entry: fx.terminal.getByExecutionId(id) };
    }

    const timedOut = await runOnce("ver-6-timeout", 400, false);
    assert.equal(timedOut.result.status, "TIMEOUT");
    assert.equal(timedOut.entry.status, "TIMED_OUT");
    assert.match(timedOut.entry.stdout, /spawned/);
    const card = new MockElement();
    renderTerminalOutput(card, fx.controller["terminalDto"](timedOut.entry), mockDoc());
    assert.match(allText(card), /Timed out/);
    assert.match(allText(card), /Stopped after the 400 ms limit/);

    const cancelled = await runOnce("ver-6-cancel", 30000, true);
    assert.equal(cancelled.result.status, "CANCELLED");
    assert.equal(cancelled.entry.status, "CANCELLED");
  });

  test("7. streaming output is bounded, warned per stream, and posts stop at the cap", async () => {
    const fx = fixtures({ maxOutputBytes: 1024 });
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("Run?", command("ver-7", fx.tmpRoot));
    await fx.view.webview.send({ type: "terminal.respond", confirmationId: fx.state().pendingConfirmation.id, action: "APPROVE" });
    await decision;
    const before = fx.view.webview.count("terminal.updated");
    t.onEvent({ type: "verification.output", payload: { executionId: "ver-7", stream: "stdout", chunk: "line one\n" } });
    assert.equal(fx.view.webview.count("terminal.updated"), before + 1);
    assert.match(fx.view.webview.messages.at(-1).terminal.stdout, /line one/);
    for (let i = 0; i < 10000; i++) {
      t.onEvent({ type: "verification.output", payload: { executionId: "ver-7", stream: "stdout", chunk: "é".repeat(50) + "\n" } });
    }
    const posts = fx.view.webview.count("terminal.updated") - before;
    assert.ok(posts < 30, `posts after cap must stop (got ${posts})`);
    const entry = fx.terminal.getByExecutionId("ver-7");
    assert.ok(Buffer.byteLength(entry.stdout) <= 1024);
    assert.equal(entry.stdout.includes("�"), false, "no split UTF-8 sequences");
    assert.equal(entry.stdoutTruncated, true);
    // Forged output for another id never reaches the visible card.
    t.onEvent({ type: "verification.output", payload: { executionId: "ver-other", stream: "stderr", chunk: "forged" } });
    assert.equal(fx.state().activeTerminal.stderr.includes("forged"), false);

    const card = new MockElement();
    renderTerminalOutput(card, fx.state().activeTerminal, mockDoc());
    assert.match(allText(card), /Output truncated: only the first 1 KB of stdout was kept\./);
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });
});

describe("Sprint 7B diff review", () => {
  test("8. mutation preview shows path, line delta and base hash; reject clears the diff", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("Approve mutation on src/a.ts? (patch)", mutation("mut-8", "src/a.ts"));
    const pending = fx.state().pendingConfirmation;
    assert.deepEqual(pending.mutation, { operation: "patch", linesAdded: 3, linesRemoved: 1, beforeHash: "a".repeat(64), afterHash: "b".repeat(64) });
    assert.equal(fx.diff.registrySize, 1);

    const card = new MockElement();
    const posted: any[] = [];
    renderConfirmationSummary(card, pending, mockDoc(), (m: any) => posted.push(m));
    const text = allText(card);
    assert.match(text, /File\nsrc\/a\.ts/);
    assert.match(text, /Lines\n\+3 −1/);
    assert.match(text, /sha256 aaaaaaaaaaaa — re-checked before writing/);
    button(card, "Open File")!.click();
    button(card, "Open Diff")!.click();
    assert.deepEqual(posted.map((m) => m.type), ["ui.openFile", "ui.openDiff"]);

    await fx.view.webview.send({ type: "ui.openDiff", mutationId: "mut-8", path: "src/a.ts", isCreate: false });
    assert.equal(commandCalls.at(-1)?.id, "vscode.diff");
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "REJECT" });
    assert.equal(await decision, "REJECT");
    assert.equal(fx.diff.registrySize, 0);
    assert.equal(fx.diff.getStatus("mut-8"), "REJECTED");
    t.onEvent({ type: "mutation.rejected", payload: { mutationId: "mut-8" } });
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
    assert.equal(fx.state().reviews[0].status, "rejected");
  });

  test("9. a stale change is labelled and no longer opens a diff", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("Approve?", mutation("mut-9", "src/a.ts"));
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: fx.state().pendingConfirmation.id, action: "APPROVE" });
    await decision;
    t.onEvent({ type: "mutation.failed", payload: { mutationId: "mut-9", error: { code: "STALE_BASE", message: "File changed since preparation (expected 1234, got 5678)" } } });
    const row = fx.state().reviews[0];
    assert.equal(row.status, "stale");
    assert.match(row.detail, /content hash mismatch\)\. Nothing was written\./);
    assert.equal(row.detail.includes("1234"), false, "raw engine message is not shown");
    assert.equal(fx.diff.getStatus("mut-9"), "STALE");

    const diffsBefore = commandCalls.filter((c) => c.id === "vscode.diff").length;
    await fx.view.webview.send({ type: "ui.openDiff", mutationId: "mut-9", path: "src/a.ts", isCreate: false });
    await fx.view.webview.send({ type: "review.openChange", mutationId: "mut-9" });
    assert.equal(commandCalls.filter((c) => c.id === "vscode.diff").length, diffsBefore);
    assert.deepEqual(fx.opened, ["src/a.ts"], "stale row opens the current file instead");
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });

  test("10. real file hash mismatch is rejected by the engine and shown as stale", async () => {
    const fx = fixtures();
    mkdirSync(join(fx.tmpRoot, "src"));
    writeFileSync(join(fx.tmpRoot, "src", "a.ts"), "export const x = 1;\n");
    const engine = new MutationEngine(fx.tmpRoot);
    const prepared = await engine.preparePatch({ operation: "patch", path: "src/a.ts", patch: { search: "x = 1", replace: "x = 2" } });
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("Approve?", {
      id: prepared.id, operation: prepared.operation, path: prepared.path, beforeHash: prepared.baseHash, afterHash: prepared.resultHash,
      linesAdded: prepared.diff.linesAdded, linesRemoved: prepared.diff.linesRemoved,
      beforeContent: prepared.beforeContent, proposedContent: prepared.proposedContent,
    });
    assert.equal(fx.state().pendingConfirmation.mutation.beforeHash, prepared.baseHash);
    writeFileSync(join(fx.tmpRoot, "src", "a.ts"), "export const x = 1; // user edit\n");
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: fx.state().pendingConfirmation.id, action: "APPROVE" });
    assert.equal(await decision, "APPROVE");
    const result = await engine.applyPreparedMutation(prepared);
    assert.equal(result.status, "STALE_BASE");
    t.onEvent({ type: "mutation.failed", payload: { mutationId: prepared.id, error: result.error } });
    assert.equal(readFileSync(join(fx.tmpRoot, "src", "a.ts"), "utf8"), "export const x = 1; // user edit\n");
    assert.equal(fx.state().reviews[0].status, "stale");
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });

  test("11. independent review records keep separate identities, outcomes and verification links", async () => {
    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    async function decide(payload: any, action: "APPROVE" | "REJECT") {
      const p = fx.controller.requestConfirmation("?", payload);
      await fx.view.webview.send({ type: payload.preparedCommand ? "terminal.respond" : "confirmation.respond", confirmationId: fx.state().pendingConfirmation.id, action });
      return p;
    }
    await decide(mutation("mut-a", "src/a.ts"), "APPROVE");
    t.onEvent({ type: "mutation.applied", payload: { mutationId: "mut-a" } });
    await decide(mutation("mut-b", "src/b.ts", { operation: "create", linesRemoved: 0 }), "REJECT");
    await decide(mutation("mut-c", "src/c.ts"), "APPROVE");
    t.onEvent({ type: "mutation.applied", payload: { mutationId: "mut-c" } });
    await decide(command("ver-11", fx.tmpRoot), "APPROVE");
    t.onEvent({ type: "verification.completed", payload: { executionId: "ver-11", result: { status: "FAIL", exitCode: 1, durationMs: 800, stdout: "", stderr: "1 failing" } } });
    // A late stale signal for a different id cannot touch these rows.
    t.onEvent({ type: "mutation.failed", payload: { mutationId: "mut-unknown", error: { code: "STALE_BASE" } } });
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;

    const byId = Object.fromEntries(fx.state().reviews.map((r: any) => [r.id, r]));
    assert.equal(byId["mut-a"].status, "applied");
    assert.equal(byId["mut-b"].status, "rejected");
    assert.equal(byId["mut-c"].status, "applied");
    assert.deepEqual(byId["ver-11"].verifies, ["mut-a", "mut-c"]);
    assert.deepEqual(byId["mut-a"].verifiedBy, { id: "ver-11", command: "/usr/local/bin/npm run test -- --grep two words", status: "failed" });
    assert.equal(byId["mut-b"].verifiedBy, undefined);

    const ledger = new MockElement();
    const posted: any[] = [];
    renderReviewLedger(ledger, fx.state().reviews, mockDoc(), (m: any) => posted.push(m));
    const text = allText(ledger);
    assert.match(text, /Changes & commands · 2 applied · 1 rejected · 1 failed/);
    assert.match(text, /New src\/b\.ts/);
    assert.match(text, /Checked by .*npm run test.*: failed/);
    assert.match(text, /Checks 2 applied changes/);
    assert.match(text, /Failed · exit 1 · 800 ms/);
    button(ledger, "Source Control")!.click();
    buttons(ledger).filter((b) => b.textContent === "Changes")[0].click();
    button(ledger, "Output")!.click();
    assert.deepEqual(posted, [
      { type: "ui.openSourceControl" },
      { type: "review.openChange", mutationId: "mut-a" },
      { type: "terminal.openOutput", executionId: "ver-11" },
    ]);

    await fx.view.webview.send({ type: "review.openChange", mutationId: "mut-a" });
    const git = commandCalls.at(-1)!;
    assert.equal(git.id, "git.openChange");
    assert.equal(git.args[0].fsPath, join(fx.tmpRoot, "src/a.ts"));
    mockVscode.commands.failGit = true;
    await fx.view.webview.send({ type: "review.openChange", mutationId: "mut-c" });
    mockVscode.commands.failGit = false;
    assert.deepEqual(fx.opened, ["src/c.ts"], "falls back to opening the file without Git");

    await fx.view.webview.send({ type: "terminal.openOutput", executionId: "ver-11" });
    const channel = outputChannels.at(-1)!;
    assert.equal(channel.name, "Open VS Code: Commands");
    assert.match(channel.lines.join("\n"), /status: FAILED · exit 1 · 800 ms[\s\S]*--- stderr ---\n1 failing/);
    await fx.view.webview.send({ type: "terminal.copyOutput", executionId: "ver-11" });
    assert.match(mockVscode.env.clipboard.last, /1 failing/);
  });

  test("12. interrupted, unconfirmed and failed workflows end in honest states without replay", async () => {
    const fx = fixtures();
    let t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const orphan = fx.controller.requestConfirmation("?", mutation("mut-12a", "src/a.ts"));
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
    const settled = await Promise.race([orphan, new Promise((r) => setTimeout(() => r("NEVER_SETTLED"), 1000))]);
    assert.equal(settled, "REJECT", "an undecided request is released as REJECT when its turn ends");
    const undecided = fx.state().reviews.find((r: any) => r.id === "mut-12a");
    assert.equal(undecided.status, "cancelled");
    assert.match(undecided.detail, /before a decision — nothing was written/);

    t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const approved = fx.controller.requestConfirmation("?", mutation("mut-12b", "src/b.ts"));
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: fx.state().pendingConfirmation.id, action: "APPROVE" });
    await approved;
    t.finish({ status: "FAILED", failureReason: "INTERNAL_ERROR" });
    await t.turn;
    const unconfirmed = fx.state().reviews.find((r: any) => r.id === "mut-12b");
    assert.equal(unconfirmed.status, "failed");
    assert.match(unconfirmed.detail, /Approved, but the engine reported no applied result/);

    t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    void fx.controller.requestConfirmation("?", mutation("mut-12c", "src/c.ts"));
    await fx.view.webview.send({ type: "chat.cancel" });
    assert.equal(fx.state().reviews.find((r: any) => r.id === "mut-12c").status, "cancelled");
    const oldOnEvent = t.onEvent;
    t.finish({ status: "CANCELLED" });
    await t.turn;

    await fx.view.webview.send({ type: "chat.newConversation" });
    assert.deepEqual(fx.state().reviews, []);
    // Events from a finished turn are not replayed into the new conversation.
    oldOnEvent({ type: "mutation.applied", payload: { mutationId: "mut-12c" } });
    assert.deepEqual(fx.state().reviews, []);
    assert.equal(fx.diff.getStatus("mut-12c"), "CANCELLED");

    const unknown = describeMutationFailure({ code: "", message: "EACCES: permission denied, open '/Users/someone/secret/key.pem'" });
    assert.equal(unknown.detail, "The change could not be applied. Nothing was written.");
    assert.equal(describeMutationFailure({ code: "PATCH_MISMATCH" }).detail, "The change could not be applied (PATCH_MISMATCH). Nothing was written.");
  });

  test("12b. a dirty editor blocks approval with a visible reason", async () => {
    const fx = fixtures();
    mockVscode.workspace.textDocuments = [{ isDirty: true, uri: { path: join(fx.tmpRoot, "src/a.ts") } }];
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    const decision = fx.controller.requestConfirmation("?", mutation("mut-12d", "src/a.ts"));
    const id = fx.state().pendingConfirmation.id;
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: id, action: "APPROVE" });
    assert.match(fx.state().pendingConfirmation.blockedReason, /Unsaved editor changes in src\/a\.ts/);
    const card = new MockElement();
    renderConfirmationSummary(card, fx.state().pendingConfirmation, mockDoc());
    assert.equal(walk(card).find((e) => e.className === "confirmation-blocked")?.attrs.role, "alert");
    mockVscode.workspace.textDocuments = [];
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: id, action: "REJECT" });
    assert.equal(await decision, "REJECT");
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });
});

describe("Sprint 7B accessibility, performance and authority", () => {
  test("13. keyboard focus lands on review, never on Approve, and controls are labelled", () => {
    const container = new MockElement();
    const conf = { id: "c13", summary: "s", riskLabel: "High Risk Mutation", mutationId: "m13", path: "src/a.ts", mutation: { operation: "patch", linesAdded: 1, linesRemoved: 1 } };
    renderConfirmationSummary(container, conf, mockDoc());
    const openDiff = button(container, "Open Diff")!;
    assert.equal(openDiff.focused, 1);
    assert.equal(button(container, "Approve")!.focused, 0);
    renderConfirmationSummary(container, conf, mockDoc());
    // Sprint 7D: an unchanged request keeps its card (same button), and focus is not moved again.
    assert.equal(button(container, "Open Diff"), openDiff);
    assert.equal(openDiff.focused, 1, "re-render does not steal focus again");
    const cmd = new MockElement();
    renderConfirmationSummary(cmd, { id: "c13b", summary: "s", riskLabel: "r", preparedCommand: { command: "npm test", cwd: "/w" } }, mockDoc());
    assert.equal(button(cmd, "Reject")!.focused, 1);
    assert.equal(button(cmd, "Run")!.focused, 0);

    const term = new MockElement();
    renderTerminalOutput(term, { executionId: "e13", command: "npm test", cwd: "/w", provenance: "p", timeoutMs: 1000, status: "RUNNING", startedAt: 1000, isOutputVisible: true, stdout: "x" }, mockDoc(), () => {});
    for (const b of buttons(term)) {
      assert.equal(b.type, "button");
      assert.ok(b.attrs["aria-label"], `button ${b.textContent} has an accessible name`);
    }
    const out = walk(term).find((e) => e.className === "terminal-output-box")!;
    assert.equal(out.tagName, "pre");
    assert.equal(out.attrs.tabindex, "0");
    assert.equal(out.attrs["aria-label"], "Command output");
    assert.equal(out.attrs["aria-live"], undefined, "streaming output does not flood screen readers");
    assert.equal(walk(term).find((e) => e.className === "status-badge")?.attrs.role, "status");
    assert.equal(updateTerminalElapsed(term, 4500), true);
    assert.match(allText(term), /Running for 3\.5 s/);

    const ledger = new MockElement();
    renderReviewLedger(ledger, [{ id: "m", kind: "mutation", status: "applied", path: "a.ts", mutation: { operation: "patch", linesAdded: 2, linesRemoved: 1 } }], mockDoc(), () => {});
    const details = ledger.children[0];
    assert.equal(details.tagName, "details");
    assert.equal(details.children[0].tagName, "summary");
    assert.equal(walk(ledger).find((e) => e.className === "review-delta")?.attrs["aria-label"], "added 2 removed 1");
  });

  test("14. long streaming output updates in place instead of rebuilding the card", () => {
    const container = new MockElement();
    const d = mockDoc();
    const term: any = { executionId: "e14", command: "npm test", cwd: "/w", provenance: "p", timeoutMs: 60000, status: "RUNNING", startedAt: Date.now(), isOutputVisible: true, stdout: "" };
    renderTerminalOutput(container, term, d);
    const afterFirst = d.created();
    const card = container.children[0];
    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      term.stdout += "chunk " + i + "\n";
      if (term.stdout.length > 16384) term.stdout = term.stdout.slice(0, 16384);
      renderTerminalOutput(container, term, d);
    }
    const elapsed = performance.now() - start;
    assert.equal(d.created(), afterFirst, "no new elements for streamed chunks");
    assert.equal(container.children[0], card);
    assert.ok(elapsed < 500, `2000 in-place updates took ${elapsed.toFixed(1)} ms`);
    term.status = "SUCCEEDED";
    term.exitCode = 0;
    renderTerminalOutput(container, term, d);
    assert.notEqual(container.children[0], card, "a status change rebuilds once");

    const ledger = new MockElement();
    const ld = mockDoc();
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: "m" + i, kind: "mutation", status: "applied", path: "f" + i + ".ts" }));
    renderReviewLedger(ledger, rows, ld);
    const ledgerCreated = ld.created();
    renderReviewLedger(ledger, rows.map((r) => ({ ...r })), ld);
    assert.equal(ld.created(), ledgerCreated, "unchanged ledger is not rebuilt (keeps keyboard focus)");
  });

  test("15. UI messages cannot approve, apply, or reach arbitrary paths", async () => {
    for (const raw of [
      { type: "mutation.apply", mutationId: "m" },
      { type: "verification.run", executionId: "v" },
      { type: "confirmation.respond", confirmationId: "c", action: "FORCE_APPLY" },
      { type: "terminal.openOutput", executionId: "" },
      { type: "terminal.copyOutput", executionId: "x".repeat(101) },
      { type: "review.openChange" },
      { type: "review.openChange", mutationId: 42 },
      JSON.parse('{"type":"review.openChange","mutationId":"m","__proto__":{"x":1}}'),
    ]) {
      assert.equal(parseWebviewMessage(raw), null, JSON.stringify(raw));
    }
    assert.deepEqual(parseWebviewMessage({ type: "review.openChange", mutationId: "m", path: "../../etc/passwd" }), { type: "review.openChange", mutationId: "m" });
    assert.deepEqual(parseWebviewMessage({ type: "ui.openSourceControl", command: "workbench.action.terminal.new" }), { type: "ui.openSourceControl" });

    const fx = fixtures();
    const t = scriptedTurn(fx);
    await waitFor(() => !!t.onEvent);
    let resolved = false;
    const decision = fx.controller.requestConfirmation("?", mutation("mut-15", "src/a.ts")).then((v: string) => { resolved = true; return v; });
    const channelsBefore = outputChannels.length;
    await fx.view.webview.send({ type: "review.openChange", mutationId: "never-proposed" });
    await fx.view.webview.send({ type: "terminal.openOutput", executionId: "never-ran" });
    await fx.view.webview.send({ type: "terminal.copyOutput", executionId: "never-ran" });
    await fx.view.webview.send({ type: "terminal.respond", confirmationId: "guess", action: "APPROVE" });
    await fx.view.webview.send({ type: "ui.openSourceControl" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(resolved, false, "no UI message other than the exact confirmation id decides");
    assert.equal(outputChannels.length, channelsBefore);
    assert.deepEqual(fx.opened, []);
    assert.equal(fx.state().reviews[0].status, "pending");
    assert.equal(commandCalls.at(-1)?.id, "workbench.view.scm");
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: fx.state().pendingConfirmation.id, action: "REJECT" });
    assert.equal(await decision, "REJECT");
    // After the decision the pending id is dead; replaying it does nothing.
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: "c", action: "APPROVE" });
    t.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await t.turn;
  });

  test("16. bundled webview runtime renders the 7B surfaces without module scope", async () => {
    const esbuild = createRequire(import.meta.url)("esbuild");
    const bundled = esbuild.buildSync({
      entryPoints: [fileURLToPath(new URL("../src/webview-render-helpers.ts", import.meta.url))],
      bundle: true, write: false, format: "cjs", platform: "node",
    });
    const mod: any = { exports: {} };
    new Function("module", "exports", bundled.outputFiles[0].text)(mod, mod.exports);
    const source = mod.exports.webviewRenderRuntime();
    assert.ok(source.length > 0 && webviewRenderRuntime().length > 0);
    const api = new Function(source + "\nreturn { renderTerminalOutput, renderReviewLedger, renderConfirmationSummary, updateTerminalElapsed };")();
    const d = mockDoc();
    const term = new MockElement();
    api.renderTerminalOutput(term, { executionId: "e", command: "npm test", executable: "npm", args: ["test"], cwd: "/w", provenance: "p", timeoutMs: 1000, status: "FAILED", exitCode: 1, durationMs: 20, isOutputVisible: true, stderr: "<img src=x onerror=alert(1)>", stderrTruncated: true, outputLimitBytes: 16384 }, d, () => {}, () => {});
    assert.match(allText(term), /<img src=x onerror=alert\(1\)>/, "output stays text");
    assert.match(allText(term), /Exit 1 · 20 ms/);
    assert.ok(button(term, "Ask to retry"));
    const ledger = new MockElement();
    api.renderReviewLedger(ledger, [{ id: "v", kind: "command", status: "timed-out", command: "npm test" }], d, () => {});
    assert.match(allText(ledger), /1 timed out/);
    const conf = new MockElement();
    api.renderConfirmationSummary(conf, { id: "c", summary: "s", riskLabel: "r", mutationId: "m", path: "a.ts", mutation: { operation: "create", linesAdded: 4 } }, d, () => {});
    assert.match(allText(conf), /New file\na\.ts/);
    assert.equal(button(conf, "Open File"), undefined, "a file that does not exist yet has nothing to open");
  });
});
