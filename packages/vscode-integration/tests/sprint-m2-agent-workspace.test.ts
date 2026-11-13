import { test, before } from "node:test";
import * as assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWebviewMessage } from "../src/chat-protocol.ts";
import { renderReviewLedger, renderTerminalOutput } from "../src/webview-render-helpers.ts";
import { prepareForRestore } from "../src/conversation-store.ts";

const commandCalls: Array<{ id: string; args: any[] }> = [];
const mockVscode: any = {
  EventEmitter: class {
    event() { return () => {}; }
    fire() {}
    dispose() {}
  },
  window: {
    showErrorMessage: () => {},
    showWarningMessage: async () => "Cancel",
    showTextDocument: async () => {},
    tabGroups: {
      all: [] as any[],
      close: async () => true,
    },
  },
  commands: {
    executeCommand: async (id: string, ...args: any[]) => {
      commandCalls.push({ id, args });
    },
  },
  env: { clipboard: { writeText: async () => {} } },
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
let isDiffPreviewStatus: (status: string | undefined) => boolean;
let previewTabMatches: (tab: { label?: string; input?: unknown }, mutationId: string, title?: string) => boolean;

class MockWebview {
  public messages: any[] = [];
  public controller?: { handleWebviewMessage: (msg: any) => Promise<void> };
  onDidReceiveMessage() { return { dispose: () => {} }; }
  postMessage(message: any) { this.messages.push(message); }
  async send(msg: any) { await this.controller!.handleWebviewMessage(msg); }
}

class MockElement {
  public textContent = "";
  public className = "";
  public children: MockElement[] = [];
  public attrs: Record<string, string> = {};
  constructor(public tagName = "div") {}
  set innerHTML(val: string) { if (val === "") this.children = []; }
  get innerHTML() { return ""; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child: MockElement) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name]; }
}

function mockDoc() {
  return { createElement: (tag: string) => new MockElement(tag) };
}

function walk(el: MockElement, out: MockElement[] = []): MockElement[] {
  out.push(el);
  for (const child of el.children) walk(child, out);
  return out;
}

before(async () => {
  const diffMod = await import("../src/diff-review-controller.ts");
  DiffReviewController = diffMod.DiffReviewController;
  isDiffPreviewStatus = diffMod.isDiffPreviewStatus;
  previewTabMatches = diffMod.previewTabMatches;
  ChatController = (await import("../src/chat-controller.ts")).ChatController;
});

function fixtures() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "sprint-m2-"));
  mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpRoot }, name: "workspace" }];
  commandCalls.length = 0;
  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      diagnostics: [],
      visibleDocuments: [],
      isTrusted: true,
    }),
    showOutput: async () => {},
    showError: async () => {},
  };
  let runTask: any = null;
  const bridgeFactory = () => ({
    runTask: async (instruction: string, mode: string, signal: AbortSignal, onEvent: any) => {
      return runTask(instruction, mode, signal, onEvent);
    },
  });
  const diff = new DiffReviewController();
  const controller = new ChatController(host, diff, bridgeFactory);
  const view = { webview: new MockWebview() };
  view.webview.controller = controller;
  controller.setWebviewView(view as any);
  return {
    controller,
    view,
    diff,
    tmpRoot,
    state: () => controller["state"],
    setRunTask: (fn: any) => { runTask = fn; },
  };
}

function mutation(id: string, path: string) {
  return {
    id,
    operation: "patch",
    path,
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    linesAdded: 1,
    linesRemoved: 1,
    beforeContent: "old\n",
    proposedContent: "new\n",
  };
}

test("parseWebviewMessage accepts a bounded composer draft", () => {
  assert.deepEqual(parseWebviewMessage({ type: "chat.draft", text: "hello" }), { type: "chat.draft", text: "hello" });
  assert.equal(parseWebviewMessage({ type: "chat.draft", text: "x".repeat(50001) }), null);
  assert.equal(parseWebviewMessage({ type: "chat.draft", text: 1 }), null);
});

test("sidebar and wide chat share one conversation and do not duplicate a send", async () => {
  const fx = fixtures();
  const wide = new MockWebview();
  wide.controller = fx.controller;
  const attached = fx.controller.attachWebview(wide);
  let started = 0;
  fx.setRunTask(async () => {
    started++;
    return { status: "COMPLETED", finalAnswer: "ok" };
  });
  await fx.view.webview.send({ type: "chat.draft", text: "shared draft" });
  assert.equal(fx.state().composerDraft, "shared draft");
  const wideStates = wide.messages.filter((message) => message.type === "chat.state");
  assert.ok(wideStates.some((message) => message.state?.composerDraft === "shared draft"));

  const first = fx.view.webview.send({ type: "chat.send", text: "one request", mode: "ASK" });
  await wide.send({ type: "chat.send", text: "one request", mode: "ASK" });
  await first;
  assert.equal(started, 1);
  assert.equal(fx.state().messages.filter((message: any) => message.role === "user").length, 1);
  const sidebarState = [...fx.view.webview.messages].reverse().find((message) => message.type === "chat.state");
  const wideState = [...wide.messages].reverse().find((message) => message.type === "chat.state");
  assert.equal(sidebarState?.wideOpen, true);
  assert.equal(wideState?.wideOpen, false);
  attached.dispose();
  const afterClose = [...fx.view.webview.messages].reverse().find((message) => message.type === "chat.state");
  assert.equal(afterClose?.wideOpen, false);
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("opening a proposed diff does not approve the confirmation", async () => {
  const fx = fixtures();
  let resolveGate: () => void = () => {};
  fx.setRunTask(async () => {
    const decision = fx.controller.requestConfirmation("Approve?", mutation("mut-m2", "src/a.ts"));
    await new Promise<void>((r) => { resolveGate = r; });
    const action = await decision;
    return { status: "FAILED", failureReason: "REJECTED", finalAnswer: action };
  });
  const send = fx.view.webview.send({ type: "chat.send", text: "edit", mode: "BUILD" });
  await waitFor(() => !!fx.state().pendingConfirmation);
  const pending = fx.state().pendingConfirmation;
  assert.equal(pending.mutationId, "mut-m2");
  const diffsBefore = commandCalls.filter((call) => call.id === "vscode.diff").length;
  mockVscode.window.tabGroups.all = [{
    tabs: [{
      label: "Open VS Code: Review src/a.ts",
      input: {
        original: { toString: () => "open-vs-code-diff:preview?id=mut-m2&side=before" },
        modified: { toString: () => "open-vs-code-diff:preview?id=mut-m2&side=after" },
      },
    }],
  }];
  const closed: any[] = [];
  mockVscode.window.tabGroups.close = async (tabs: any) => {
    closed.push(tabs);
    mockVscode.window.tabGroups.all = [{ tabs: [] }];
    return true;
  };
  await fx.view.webview.send({ type: "ui.openDiff", mutationId: "mut-m2", path: "src/a.ts", isCreate: false });
  assert.equal(fx.diff.getStatus("mut-m2"), "REVIEWING");
  assert.equal(fx.state().reviews[0].status, "pending");
  assert.equal(commandCalls.filter((call) => call.id === "vscode.diff").length, diffsBefore + 1);
  assert.equal(fx.state().pendingConfirmation.id, pending.id);
  await fx.view.webview.send({ type: "confirmation.respond", confirmationId: "other-id", action: "APPROVE" });
  assert.equal(fx.state().pendingConfirmation.id, pending.id);
  await fx.view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "REJECT" });
  resolveGate();
  await send;
  assert.equal(closed.length, 1);
  assert.equal(fx.diff.getStatus("mut-m2"), "REJECTED");
  assert.equal(fx.state().reviews[0].status, "rejected");
  const outcome = fx.state().messages.at(-1);
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.content, /Change rejected — no files modified/);
  assert.equal(fx.state().pendingConfirmation, undefined);
  assert.equal(fx.state().activities.some((activity: any) => activity.label === "Failed"), false);
  assert.equal(fx.state().activities.some((activity: any) => activity.label === "Change rejected"), true);
});

test("approve is distinct from applied, and a passing check is verified", async () => {
  const fx = fixtures();
  let resolveGate: () => void = () => {};
  fx.setRunTask(async (_i: string, _m: string, _s: AbortSignal, onEvent: any) => {
    const decision = fx.controller.requestConfirmation("Approve?", mutation("mut-ok", "src/a.ts"));
    await new Promise<void>((r) => { resolveGate = r; });
    const action = await decision;
    onEvent({ type: "mutation.applied", payload: { mutationId: "mut-ok", path: "src/a.ts" } });
    fx.controller["upsertReview"]({
      id: "ver-ok",
      kind: "command",
      status: "succeeded",
      command: "npm test",
      verifies: ["mut-ok"],
    });
    fx.controller["refreshReviews"]();
    return { status: "COMPLETED", finalAnswer: "done", appliedMutations: [{ path: "src/a.ts", status: "APPLIED" }] };
  });
  const send = fx.view.webview.send({ type: "chat.send", text: "edit", mode: "BUILD" });
  await waitFor(() => !!fx.state().pendingConfirmation);
  const pending = fx.state().pendingConfirmation;
  await fx.view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
  assert.equal(fx.state().reviews[0].status, "approved");
  assert.equal(fx.diff.getStatus("mut-ok"), "APPROVED");
  assert.equal(isDiffPreviewStatus("APPROVED"), true);
  resolveGate();
  await send;
  const mutationRow = fx.state().reviews.find((row: any) => row.kind === "mutation");
  assert.equal(mutationRow.status, "verified");
  const root = new MockElement();
  renderReviewLedger(root, fx.state().reviews, mockDoc());
  const text = walk(root).map((node) => node.textContent).join("\n");
  assert.match(text, /Verified/);
});

test("rejecting a proposed diff closes its preview tab", async () => {
  const closed: any[] = [];
  mockVscode.window.tabGroups.all = [{
    tabs: [{
      label: "Open VS Code: Review src/add.js",
      input: {
        original: { toString: () => "open-vs-code-diff:preview?id%3Dmut-x&side=before" },
        modified: { toString: () => "open-vs-code-diff:preview?id%3Dmut-x&side=after" },
      },
    }],
  }];
  mockVscode.window.tabGroups.close = async (tabs: any) => {
    closed.push(tabs);
    mockVscode.window.tabGroups.all = [{ tabs: [] }];
    return true;
  };
  const diff = new DiffReviewController();
  const closedOk = await diff.closeDiffEditors("mut-x");
  assert.equal(closed.length, 1);
  assert.equal(closedOk, true);
});

test("closeDiffEditors waits for an in-flight open before closing", async () => {
  let releaseOpen: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const previous = mockVscode.commands.executeCommand;
  mockVscode.commands.executeCommand = async (id: string, ...args: any[]) => {
    commandCalls.push({ id, args });
    if (id === "vscode.diff") await gate;
  };
  mockVscode.window.tabGroups.all = [{ tabs: [] }];
  const closed: any[] = [];
  mockVscode.window.tabGroups.close = async (tabs: any) => {
    closed.push(tabs);
    mockVscode.window.tabGroups.all = [{ tabs: [] }];
    return true;
  };
  try {
    const diff = new DiffReviewController();
    const opening = diff.openDiff("mut-late", "src/add.js", false);
    const closing = diff.closeDiffEditors("mut-late");
    await new Promise((resolve) => setTimeout(resolve, 20));
    mockVscode.window.tabGroups.all = [{
      tabs: [{
        label: "Open VS Code: Review src/add.js",
        input: {
          original: { toString: () => "open-vs-code-diff:preview?id=mut-late&side=before" },
          modified: { toString: () => "open-vs-code-diff:preview?id=mut-late&side=after" },
        },
      }],
    }];
    releaseOpen();
    await opening;
    assert.equal(await closing, true);
    assert.equal(closed.length, 1);
  } finally {
    mockVscode.commands.executeCommand = previous;
  }
});

test("preview tab matching covers encoded uris and review titles", () => {
  assert.equal(previewTabMatches({
    label: "Open VS Code: Review src/add.js",
    input: { original: { toString: () => "open-vs-code-diff:preview?id%3Dmut-x&side=before" } },
  }, "mut-x", "Open VS Code: Review src/add.js"), true);
});

test("finished command details stay collapsed", () => {
  const root = new MockElement();
  renderTerminalOutput(root, {
    executionId: "v1",
    command: "node --test test/add.test.js",
    executable: "/usr/bin/node",
    args: ["--test", "test/add.test.js"],
    cwd: "/tmp/ws",
    provenance: "Verification runner",
    timeoutMs: 60000,
    status: "SUCCEEDED",
    exitCode: 0,
    durationMs: 20,
    isOutputVisible: false,
  }, mockDoc());
  const text = walk(root).map((node) => node.textContent).join("\n");
  assert.match(text, /Command details/);
  assert.match(text, /Executable/);
  const details = walk(root).find((node) => node.tagName === "details");
  assert.ok(details);
  assert.equal(details?.attrs.open, undefined);
});

test("rejected review rows are not actionable", () => {
  const root = new MockElement();
  renderReviewLedger(root, [{
    id: "mut-x",
    kind: "mutation",
    status: "rejected",
    path: "src/add.js",
    detail: "Change rejected — no files modified.",
  }], mockDoc(), () => {});
  const text = walk(root).map((node) => node.textContent).join("\n");
  assert.match(text, /Rejected/);
  assert.equal(walk(root).some((node) => node.tagName === "button" && node.textContent === "Open"), false);
});

test("an unused approval is interrupted on restore and is not replayed", () => {
  const restored = prepareForRestore({
    schemaVersion: 1,
    id: "c-0123456789abcdef",
    workspaceId: "ws",
    title: "t",
    titleSource: "auto",
    createdAt: 1,
    updatedAt: 2,
    mode: "BUILD",
    messages: [],
    attachments: [],
    reviews: [{ id: "mut-1", kind: "mutation", status: "approved", path: "src/a.ts" }],
    lastStatus: "running",
    runIds: ["run-1"],
    archived: false,
  });
  assert.equal(restored.interrupted, true);
  assert.equal(restored.reviews[0]?.status, "interrupted");
});
