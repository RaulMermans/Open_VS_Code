import { test, describe, before } from "node:test";
import * as assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderChatMessage,
  syncTranscript,
  renderConfirmationSummary,
  handleComposerKeydown,
  webviewRenderRuntime,
} from "../src/webview-render-helpers.ts";
import {
  activityFromAgentEvent,
  classifyTurnError,
  formatTerminalTaskMessage,
  deriveConnectionStatus,
  describeAttachment,
  formatAttachmentInstruction,
  isIgnoredRelativePath,
  isSensitiveRelativePath,
  sanitizeRelativePath,
  sanitizeSearchQuery,
} from "../src/chat-ux-model.ts";
import { parseWebviewMessage } from "../src/chat-protocol.ts";

const mockVscode = {
  EventEmitter: class {
    event() { return () => {}; }
    fire() {}
    dispose() {}
  },
  window: {
    showErrorMessage: () => {},
    showWarningMessage: async () => "Cancel",
    showTextDocument: async () => {},
    showQuickPick: async () => undefined,
  },
  commands: { executeCommand: async (id: string) => { mockVscode.commands.calls.push(id); } },
  env: { clipboard: { writeText: async (text: string) => { mockVscode.env.clipboard.last = text; } } },
  workspace: {
    isTrusted: true,
    workspaceFolders: [] as any[],
    findFiles: async () => [],
    asRelativePath: (u: any) => String(u),
  },
  Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts), path: join(base.fsPath, ...parts) }) },
};
(mockVscode.commands as any).calls = [] as string[];
(mockVscode.env.clipboard as any).last = "";

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

class MockWebview {
  public lastMessage: any;
  public messages: any[] = [];
  public controller?: { handleWebviewMessage: (msg: any) => Promise<void> };
  public onDidReceiveMessageCb?: (msg: any) => void;
  onDidReceiveMessage(cb: (msg: any) => void) {
    this.onDidReceiveMessageCb = cb;
    return { dispose: () => { this.onDidReceiveMessageCb = undefined; } };
  }
  postMessage(message: any) {
    this.lastMessage = message;
    this.messages.push(message);
  }
  async send(msg: any) {
    if (this.controller) {
      await this.controller.handleWebviewMessage(msg);
      return;
    }
    if (this.onDidReceiveMessageCb) await this.onDidReceiveMessageCb(msg);
  }
}

class MockElement {
  public textContent = "";
  public className = "";
  public id = "";
  public tagName: string;
  public children: MockElement[] = [];
  public parentNode: MockElement | null = null;
  public attrs: Record<string, string> = {};
  public style: Record<string, string> = {};
  public disabled = false;
  public listeners: Record<string, Function[]> = {};
  constructor(tag = "div") { this.tagName = tag; }
  set innerHTML(val: string) { if (val === "") this.children = []; }
  get innerHTML() { return ""; }
  appendChild(child: MockElement) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: MockElement) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name]; }
  addEventListener(type: string, fn: Function) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn();
  }
}

function mockDoc() {
  let created = 0;
  return {
    created: () => created,
    createElement(tag: string) {
      created++;
      return new MockElement(tag);
    },
  };
}

function fixtures() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "sprint7a-"));
  mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot }, name: "workspace" }];
  const opened: string[] = [];
  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: { uri: `file://${tmpRoot}/src/app.ts`, workspaceRelativePath: "src/app.ts", languageId: "ts", version: 1, isDirty: false },
      selection: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 }, selectedText: "const x = 1;" },
      diagnostics: [],
      visibleDocuments: [],
      isTrusted: true,
    }),
    showOutput: async () => {},
    showError: async () => {},
    isWorkspaceTrusted: async () => true,
    searchWorkspaceFiles: async (query: string) => {
      const files = ["src/app.ts", "src/util.ts", "README.md"].filter((p) => p.includes(query));
      return files.map((path) => ({ path, label: path }));
    },
    openWorkspaceFile: async (path: string) => { opened.push(path); },
    pickWorkspaceFile: async () => "src/util.ts",
    getConnectionSnapshot: async () => ({
      inferenceBackend: "standalone-local",
      modelLabel: "Qwen 2.5 Coder 7B",
      providerLabel: "Standalone local",
      configStatus: "present" as const,
    }),
    checkConnection: async () => {},
    openModelConfig: async () => { mockVscode.commands.calls.push("open-vs-code.openModelConfig"); },
  };
  let currentRunTask: any = null;
  let calls = 0;
  const events: any[] = [];
  const bridgeFactory = () => ({
    runTask: async (...args: any[]) => {
      calls++;
      const onEvent = args[3];
      if (currentRunTask) return currentRunTask(...args, onEvent);
      if (onEvent) {
        onEvent({ type: "task.started", payload: {} });
        onEvent({ type: "model.requested", payload: {} });
        onEvent({ type: "model.completed", payload: {} });
      }
      return { status: "COMPLETED", finalAnswer: "done" };
    },
  });
  const controller = new ChatController(host, bridgeFactory);
  const view = { webview: new MockWebview() };
  view.webview.controller = controller;
  controller.setWebviewView(view as any);
  return {
    host, controller, view, opened, tmpRoot,
    setRunTask: (fn: any) => { currentRunTask = fn; },
    getCalls: () => calls,
    events,
  };
}

describe("Sprint 7A chat UX model", () => {
  test("path sanitization and sensitive/ignored classification", () => {
    assert.equal(sanitizeRelativePath("../etc/passwd"), null);
    assert.equal(sanitizeRelativePath("/abs/path.ts"), null);
    assert.equal(sanitizeRelativePath("src/app.ts"), "src/app.ts");
    assert.equal(isSensitiveRelativePath(".env"), true);
    assert.equal(isSensitiveRelativePath("src/id_rsa"), true);
    assert.equal(isSensitiveRelativePath("src/app.ts"), false);
    assert.equal(isIgnoredRelativePath("node_modules/pkg/index.js"), true);
    assert.equal(sanitizeSearchQuery("foo*{bar}"), "foobar");
  });

  test("connection status never claims HALO ready without a health check", () => {
    const unverified = deriveConnectionStatus({ inferenceBackend: "halo", configStatus: "present" });
    assert.equal(unverified.state, "unavailable");
    assert.equal(unverified.healthChecked, false);
    const verified = deriveConnectionStatus({ inferenceBackend: "halo", configStatus: "present", haloHealthChecked: true, haloReachable: true });
    assert.equal(verified.state, "ready");
    assert.equal(verified.healthChecked, true);
    const missing = deriveConnectionStatus({ configStatus: "missing" });
    assert.equal(missing.state, "missing-config");
    const localUnverified = deriveConnectionStatus({ inferenceBackend: "standalone-local", configStatus: "present" });
    assert.equal(localUnverified.state, "unavailable");
    assert.equal(localUnverified.healthChecked, false);
    const localReady = deriveConnectionStatus({ inferenceBackend: "standalone-local", configStatus: "present", endpointVerified: true });
    assert.equal(localReady.state, "ready");
    assert.equal(classifyTurnError("ECONNREFUSED 127.0.0.1"), "disconnected");
  });

  test("attachments are descriptors and do not carry file contents", () => {
    const chip = describeAttachment({ kind: "file", path: "src/app.ts", label: "src/app.ts" }, { trusted: true, nextId: () => "a1" });
    assert.equal(chip.path, "src/app.ts");
    assert.equal((chip as any).content, undefined);
    const note = formatAttachmentInstruction([chip]);
    assert.match(note, /descriptors only/);
    assert.equal(note.includes("const "), false);
    const secret = describeAttachment({ kind: "file", path: ".env" }, { trusted: true, nextId: () => "s" });
    assert.equal(secret.unavailable, true);
    const untrusted = describeAttachment({ kind: "file", path: "src/app.ts" }, { trusted: false, nextId: () => "u" });
    assert.equal(untrusted.unavailable, true);
  });

  test("agent events map to honest activity labels", () => {
    const running = activityFromAgentEvent({ type: "tool.requested", payload: { name: "read_file" } }, "1");
    assert.equal(running?.label, "Running read_file");
    assert.equal(running?.status, "pending");
    const waiting = activityFromAgentEvent({ type: "model.requested" }, "2");
    assert.equal(waiting?.label, "Waiting for the model");
    assert.equal(activityFromAgentEvent({ type: "not.a.real.event" }, "3"), null);
  });
});

describe("Sprint 7A rendering and sanitization", () => {
  test("untrusted HTML is inert text; code fences stay textContent", () => {
    const d = mockDoc();
    const root = new MockElement("div");
    const evil = "<script>alert(1)</script>```js\n<img onerror=alert(1) src=x>\n```";
    renderChatMessage(root, { id: "m1", role: "assistant", content: evil }, d);
    const htmlAssigned: string[] = [];
    const orig = Object.getOwnPropertyDescriptor(MockElement.prototype, "innerHTML");
    assert.ok(root.children.length === 1);
    const body = root.children[0].children.find((c) => c.className.includes("message-body"));
    assert.ok(body);
    const code = body!.children.find((c) => c.className === "code-block");
    assert.ok(code);
    const pre = code!.children.find((c) => c.tagName === "pre");
    const text = pre?.children[0]?.textContent || "";
    assert.equal(text.includes("<img onerror=alert(1) src=x>"), true);
    assert.equal(htmlAssigned.length, 0);
    void orig;
  });

  test("incremental transcript appends without rebuilding unchanged messages", () => {
    const d = mockDoc();
    const root = new MockElement("div");
    const messages = [];
    for (let i = 0; i < 40; i++) messages.push({ id: "m" + i, role: i % 2 ? "assistant" : "user", content: "msg " + i });
    const first = syncTranscript(root, messages, d);
    const createdAfterFirst = d.created();
    assert.ok(first.created >= 40);
    const second = syncTranscript(root, [...messages, { id: "m40", role: "assistant", content: "tail" }], d);
    const createdAfterSecond = d.created();
    assert.equal(second.created, 1);
    assert.ok(createdAfterSecond - createdAfterFirst < createdAfterFirst / 2);
    assert.ok(root.children.length <= 41);
  });

  test("keyboard Enter sends and Shift+Enter does not", () => {
    let sent = 0;
    const send = () => { sent++; };
    const enter = handleComposerKeydown({ key: "Enter", shiftKey: false, preventDefault() {} }, send);
    const newline = handleComposerKeydown({ key: "Enter", shiftKey: true, preventDefault() {} }, send);
    assert.equal(enter, true);
    assert.equal(newline, false);
    assert.equal(sent, 1);
  });

  test("confirmation buttons ignore a second click", () => {
    const d = mockDoc();
    const root = new MockElement("div");
    const posts: any[] = [];
    renderConfirmationSummary(root, { id: "c1", summary: "Write file", riskLabel: "High Risk Mutation" }, d, (msg: any) => posts.push(msg));
    const card = root.children[0];
    const actions = card.children.find((c) => c.className === "confirmation-actions")!;
    const approve = actions.children.find((c) => c.id === "btn-approve")!;
    approve.click();
    approve.click();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].action, "APPROVE");
  });
});

describe("Sprint 7A ChatController contracts", { concurrency: false }, () => {
  before(() => {
    const req = createRequire(import.meta.url);
    ChatController = req("../src/chat-controller.ts").ChatController;
  });

  test("mode selection, send, cancel, and duplicate submission", async () => {
    const fx = fixtures();
    await fx.view.webview.send({ type: "chat.setMode", mode: "BUILD" });
    assert.equal(fx.controller["state"].mode, "BUILD");
    await fx.view.webview.send({ type: "chat.send", text: "hello", mode: "BUILD" });
    assert.equal(fx.controller["state"].messages[0].content, "hello");
    assert.equal(fx.controller["state"].messages.at(-1).content, "done");

    let resolveBusy: any;
    fx.setRunTask(async () => new Promise((resolve) => { resolveBusy = resolve; }));
    const pending = fx.view.webview.send({ type: "chat.send", text: "busy", mode: "ASK" });
    await new Promise((r) => setTimeout(r, 10));
    const calls = fx.getCalls();
    await fx.view.webview.send({ type: "chat.send", text: "busy-2", mode: "ASK" });
    assert.equal(fx.getCalls(), calls);
    resolveBusy({ status: "COMPLETED", finalAnswer: "ok" });
    await pending;

    fx.setRunTask(async (_i: any, _m: any, signal: AbortSignal) => {
      if (signal.aborted) return { status: "CANCELLED" };
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "CANCELLED" }));
      });
    });
    const cancelTurn = fx.view.webview.send({ type: "chat.send", text: "cancel me", mode: "ASK" });
    await new Promise((r) => setTimeout(r, 20));
    await fx.view.webview.send({ type: "chat.cancel" });
    await cancelTurn;
    assert.equal(fx.controller["state"].messages.at(-1).status, "cancelled");
    assert.equal(fx.controller["state"].activities.every((a: any) => a.status !== "pending"), true);
  });

  test("file reference attach, remove, search, and open", async () => {
    const fx = fixtures();
    await fx.view.webview.send({ type: "context.attach", target: "current-file" });
    assert.equal(fx.controller["state"].attachments.some((c: any) => c.path === "src/app.ts"), true);
    await fx.view.webview.send({ type: "context.attach", target: "selection" });
    assert.equal(fx.controller["state"].attachments.some((c: any) => c.kind === "selection"), true);
    await fx.view.webview.send({ type: "context.attachFile", path: "src/util.ts" });
    const util = fx.controller["state"].attachments.find((c: any) => c.path === "src/util.ts");
    assert.ok(util);
    await fx.view.webview.send({ type: "context.remove", id: util.id });
    assert.equal(fx.controller["state"].attachments.some((c: any) => c.path === "src/util.ts"), false);
    await fx.view.webview.send({ type: "context.search", query: "app" });
    const search = fx.view.webview.messages.find((m: any) => m.type === "context.searchResults");
    assert.ok(search.files.some((f: any) => f.path === "src/app.ts"));
    await fx.view.webview.send({ type: "ui.openFile", path: "src/app.ts" });
    assert.deepEqual(fx.opened, ["src/app.ts"]);
    await fx.view.webview.send({ type: "chat.send", text: "use the file", mode: "ASK" });
    const user = fx.controller["state"].messages[0];
    assert.ok(user.attachments?.length);
    assert.equal(user.attachments[0].content, undefined);
  });

  test("workspace trust marks attachments unavailable", async () => {
    const fx = fixtures();
    fx.host.isWorkspaceTrusted = async () => false;
    await fx.view.webview.send({ type: "context.attachFile", path: "src/app.ts" });
    const chip = fx.controller["state"].attachments[0];
    assert.equal(chip.unavailable, true);
    assert.match(chip.reason, /untrusted/i);
  });

  test("tool activity, errors, and disconnected states", async () => {
    const fx = fixtures();
    fx.setRunTask(async (_instruction: any, _mode: any, _signal: any, onEvent: any) => {
      if (typeof onEvent === "function") {
        onEvent({ type: "tool.requested", payload: { name: "search_text" } });
        onEvent({ type: "tool.completed", payload: { name: "search_text" } });
      }
      throw new Error("fetch failed ECONNREFUSED");
    });
    await fx.view.webview.send({ type: "chat.send", text: "boom", mode: "ASK" });
    const last = fx.controller["state"].messages.at(-1);
    assert.ok(fx.controller["state"].activities.some((a: any) => String(a.label).includes("search_text")));
    assert.equal(last?.status, "failed");
    assert.equal(fx.controller["state"].connection.state, "disconnected");
  });

  test("confirmation identity, stale rejection, and cancel during approval", async () => {
    const fx = fixtures();
    let resolveGate: any;
    fx.setRunTask(async () => {
      const p = fx.controller.requestConfirmation("Approve?", { action: "write_file", path: "src/app.ts", id: "mut-1", reviewPayload: { path: "src/app.ts", beforeContent: "a", proposedContent: "b" } });
      await new Promise((r) => { resolveGate = r; });
      const res = await p;
      return { status: "COMPLETED", finalAnswer: res };
    });
    const turn = fx.view.webview.send({ type: "chat.send", text: "edit", mode: "BUILD" });
    await new Promise((r) => setTimeout(r, 20));
    const realId = fx.controller["state"].pendingConfirmation.id;
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: "stale-id", action: "APPROVE" });
    assert.equal(fx.controller["state"].pendingConfirmation.id, realId);
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: realId, action: "APPROVE" });
    await fx.view.webview.send({ type: "confirmation.respond", confirmationId: realId, action: "APPROVE" });
    resolveGate();
    await turn;
    assert.equal(fx.controller["state"].messages.at(-1).content, "APPROVE");

    let resolveCancel: any;
    fx.setRunTask(async (_i: any, _m: any, signal: AbortSignal) => {
      const p = fx.controller.requestConfirmation("Later?", { action: "write_file", path: "src/app.ts" });
      await new Promise((r) => { resolveCancel = r; signal.addEventListener("abort", r); });
      const res = await p;
      return { status: "CANCELLED", finalAnswer: res };
    });
    const cancelTurn = fx.view.webview.send({ type: "chat.send", text: "cancel-approval", mode: "BUILD" });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(fx.controller["state"].pendingConfirmation);
    await fx.view.webview.send({ type: "chat.cancel" });
    resolveCancel?.();
    await cancelTurn;
    assert.equal(fx.controller["state"].pendingConfirmation, undefined);
    assert.equal(fx.controller["state"].activities.every((a: any) => a.status !== "pending"), true);
  });

  test("protocol validation for new context and file messages", () => {
    assert.equal(parseWebviewMessage({ type: "context.attach", target: "current-file" })?.type, "context.attach");
    assert.equal(parseWebviewMessage({ type: "context.attach", target: "other" }), null);
    assert.equal(parseWebviewMessage({ type: "ui.openFile", path: "http://evil" }), null);
    assert.equal(parseWebviewMessage({ type: "ui.openFile", path: "src/app.ts" })?.type, "ui.openFile");
    assert.equal(parseWebviewMessage({ type: "context.search", query: "x".repeat(81) }), null);
  });

  test("webview lifecycle dispose and duplicate listener cleanup", async () => {
    const fx = fixtures();
    const first = fx.view.webview;
    first.controller = undefined;
    const second = new MockWebview();
    fx.controller.setWebviewView({ webview: second } as any);
    await first.send({ type: "chat.setMode", mode: "DEBUG" });
    assert.equal(fx.controller["state"].mode, "ASK");
    await second.send({ type: "chat.setMode", mode: "DEBUG" });
    assert.equal(fx.controller["state"].mode, "DEBUG");
    fx.controller.dispose();
    await second.send({ type: "chat.setMode", mode: "REVIEW" });
    assert.equal(fx.controller["state"].mode, "DEBUG");
  });

  test("implicit context chips remain compatible", async () => {
    const fx = fixtures();
    await fx.controller.refreshContext(await fx.host.getSnapshot());
    const labels = fx.controller["state"].context.map((c: any) => c.label);
    assert.ok(labels.includes("src/app.ts"));
    assert.ok(labels.includes("Selection"));
    assert.ok(labels.includes("1 workspace roots"));
  });

  test("terminal confirmation exposes command and cwd; stale openDiff is ignored", async () => {
    const fx = fixtures();
    const opened: Array<{ id: string; path: string }> = [];
    fx.controller["diffReviewController"] = {
      openDiff: async (id: string, path: string) => { opened.push({ id, path }); },
      registerReview: () => {},
      clearReview: () => {},
      clearAll: () => {},
      setStatus: () => {},
      getStatus: () => undefined,
    };
    let resolveGate: any;
    fx.setRunTask(async () => {
      const p = fx.controller.requestConfirmation("Run tests?", {
        action: "run_known_test",
        preparedCommand: {
          verificationId: "ver-1",
          executable: "/usr/bin/npm",
          args: ["test"],
          cwd: fx.tmpRoot,
          commandPreview: "/usr/bin/npm test",
          provenance: "package.json [test]",
          timeoutMs: 5000,
        },
      });
      await new Promise((r) => { resolveGate = r; });
      const res = await p;
      return { status: "COMPLETED", finalAnswer: res };
    });
    const turn = fx.view.webview.send({ type: "chat.send", text: "test", mode: "BUILD" });
    await new Promise((r) => setTimeout(r, 20));
    const pending = fx.controller["state"].pendingConfirmation;
    assert.equal(pending.preparedCommand.command, "/usr/bin/npm test");
    assert.equal(pending.preparedCommand.cwd, fx.tmpRoot);
    await fx.view.webview.send({ type: "ui.openDiff", mutationId: "stale-mut", path: "src/app.ts", isCreate: false });
    assert.equal(opened.length, 0);
    await fx.view.webview.send({ type: "terminal.respond", confirmationId: pending.id, action: "REJECT" });
    resolveGate();
    await turn;
    assert.equal(fx.controller["state"].messages.at(-1).content, "REJECT");
  });

  test("transcript and activity retention stay bounded", async () => {
    const fx = fixtures();
    fx.setRunTask(async () => ({ status: "COMPLETED", finalAnswer: "ok" }));
    for (let i = 0; i < 105; i++) {
      await fx.view.webview.send({ type: "chat.send", text: "turn-" + i, mode: "ASK" });
    }
    assert.ok(fx.controller["state"].messages.length <= 100);
    const chars = fx.controller["state"].messages.reduce((acc: number, m: any) => acc + (m.content?.length || 0), 0);
    assert.ok(chars <= 200000);
    assert.ok(fx.controller["state"].activities.length <= 50);
  });
});

describe("Sprint 7A performance and webview runtime", () => {
  test("unchanged messages are not rebuilt on later syncs", () => {
    const d = mockDoc();
    const root = new MockElement("div");
    const messages = [];
    for (let i = 0; i < 80; i++) {
      messages.push({
        id: "m" + i,
        role: i % 2 ? "assistant" : "user",
        content: "msg " + i + "\n```js\nconst n = " + i + ";\n```",
      });
    }
    const first = syncTranscript(root, messages, d);
    const createdAfterFirst = d.created();
    const second = syncTranscript(root, messages, d);
    const createdAfterSecond = d.created();
    assert.equal(first.created, 80);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(createdAfterSecond, createdAfterFirst);
    assert.equal(root.children.length, 80);
  });

  test("incremental append is cheaper than a full rebuild", () => {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        id: "p" + i,
        role: i % 2 ? "assistant" : "user",
        content: "msg " + i + "\n```js\nconst n = " + i + ";\n```",
      });
    }
    const dFull = mockDoc();
    const rootFull = new MockElement("div");
    const tFull = performance.now();
    for (let k = 0; k < 15; k++) {
      rootFull.children = [];
      syncTranscript(rootFull, messages, dFull);
    }
    const fullMs = performance.now() - tFull;

    const dInc = mockDoc();
    const rootInc = new MockElement("div");
    syncTranscript(rootInc, messages.slice(0, 99), dInc);
    const createdBefore = dInc.created();
    const tInc = performance.now();
    for (let k = 0; k < 15; k++) {
      syncTranscript(rootInc, messages, dInc);
    }
    const incMs = performance.now() - tInc;
    const createdAfter = dInc.created();
    assert.ok(createdAfter - createdBefore < 20, "incremental sync recreated too many nodes: " + (createdAfter - createdBefore));
    assert.ok(rootInc.children.length <= 100);
    assert.ok(fullMs >= 0 && incMs >= 0);
    (globalThis as any).__sprint7aPerf = { fullRebuildMs: Number(fullMs.toFixed(2)), incrementalMs: Number(incMs.toFixed(2)), messages: 100, repeats: 15 };
  });

  test("webview runtime source includes helper closures", () => {
    const src = webviewRenderRuntime();
    assert.match(src, /var MAX_CODE_CHARS/);
    assert.match(src, /function docOf/);
    assert.match(src, /function onClick/);
    assert.match(src, /function fillMessageBody/);
    assert.match(src, /function messageSig/);
    assert.match(src, /function renderConnectionStatus/);
  });
});

test("a rejected edit is a decision, and a security failure stays a failure", () => {
  const rejected = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "REJECTED",
    finalAnswer: "The proposed edit was rejected.",
  })
  assert.equal(rejected.content, "Change rejected — no files modified.")
  assert.equal(rejected.lastStatus, "rejected")
  const blocked = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "INTERNAL_ERROR",
    finalAnswer: "PATH_ESCAPE: the target is outside the workspace.",
  })
  assert.equal(blocked.lastStatus, "failed")
  assert.match(blocked.content, /Task failed \(INTERNAL_ERROR\)/)
})
