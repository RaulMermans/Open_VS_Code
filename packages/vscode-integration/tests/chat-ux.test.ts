import { AgentSessionBridge } from "../../ide-adapter/src/bridge.ts";
import { ScriptedModelProvider } from "../../agent-core/src/testing/scripted-model.ts";
import { test, describe, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import { resolve } from "node:path";

const mockVscode = {
  window: { showErrorMessage: () => {}, showWarningMessage: async () => "Cancel" },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { writeText: () => {} } }
};

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function(request: string) {
  if (request === 'vscode') return 'vscode';
  return originalResolveFilename.apply(this, arguments);
};
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function(id: string) {
  if (id === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

let ChatController: any;

class MockWebview {
  public options: any = {};
  public html: string = "";
  public lastMessage: any;
  public onDidReceiveMessageCb?: (msg: any) => void;
  
  onDidReceiveMessage(cb: (msg: any) => void) {
    this.onDidReceiveMessageCb = cb;
  }
  
  postMessage(message: any) {
    this.lastMessage = message;
  }
  
  async send(msg: any) {
    if (this.onDidReceiveMessageCb) {
      await this.onDidReceiveMessageCb(msg);
    }
  }
}

class MockWebviewView {
  public webview = new MockWebview();
}

const freshFixtures = () => {
  const tmpRoot = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "agent-test-"));
  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null,
      selection: null,
      diagnostics: [],
      visibleDocuments: []
    }),
    showOutput: async () => {},
    showError: async () => {},
    isWorkspaceTrusted: async () => true,
  };
  
  let currentRunTask: any = null;
  let calls = 0;
  const bridgeFactory = (options: any) => {
    return {
      runTask: async (...args: any[]) => {
        calls++;
        if (currentRunTask) return currentRunTask(...args);
        return { status: 'COMPLETED', finalAnswer: "done" };
      }
    };
  };

  const controller = new ChatController(host, bridgeFactory);
  const view = new MockWebviewView();
  controller.setWebviewView(view as any);
  
  return { host, bridgeFactory, controller, view, setRunTask: (fn: any) => { currentRunTask = fn; }, getCalls: () => calls, tmpRoot };
};

/** Webview posts omit `messages` when the transcript did not change. The live transcript is still on the controller. */
const postedMessages = (view: MockWebview, controller: any): any[] => {
  const msg = view.lastMessage;
  if (Array.isArray(msg?.state?.messages)) return msg.state.messages;
  if (msg?.type === "chat.state" && msg.transcript === "unchanged") return controller["state"].messages;
  return [];
};

const waitTurnIdle = async (controller: any) => {
  const started = Date.now();
  while (controller["state"].activeTurn || controller["_sendInFlight"]) {
    if (Date.now() - started > 2000) throw new Error("chat turn did not settle");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const runChatEvaluation = async (fixtures: ReturnType<typeof freshFixtures>) => {
  const { host, bridgeFactory, controller, view, setRunTask, getCalls } = fixtures;
  const results: any = {};
  const messages = () => postedMessages(view.webview, controller);
  
  // Basic Tests
  await view.webview.send({ type: "chat.send", text: "hello", mode: "ASK" });
  await waitTurnIdle(controller);
  results.ask = messages().length === 2 && messages()[1].content === "done";
  
  await view.webview.send({ type: "chat.setMode", mode: "PLAN" });
  await view.webview.send({ type: "chat.send", text: "plan", mode: "PLAN" });
  await waitTurnIdle(controller);
  results.plan = messages()[3].content === "done";
  
  await view.webview.send({ type: "chat.setMode", mode: "BUILD" });
  await view.webview.send({ type: "chat.send", text: "build", mode: "BUILD" });
  await waitTurnIdle(controller);
  results.build = messages()[5].content === "done";

  await view.webview.send({ type: "chat.setMode", mode: "DEBUG" });
  await view.webview.send({ type: "chat.send", text: "debug", mode: "DEBUG" });
  await waitTurnIdle(controller);
  results.debug = messages()[7].content === "done";

  await view.webview.send({ type: "chat.setMode", mode: "REVIEW" });
  await view.webview.send({ type: "chat.send", text: "review", mode: "REVIEW" });
  await waitTurnIdle(controller);
  results.review = messages()[9].content === "done";

  await view.webview.send({ type: "chat.send", text: "line1\\nline2", mode: "ASK" });
  await waitTurnIdle(controller);
  results.multiline = messages()[10].content === "line1\\nline2";

  results.modeSwitch = controller["state"].mode === "REVIEW";

  await view.webview.send({ type: "chat.newConversation" });
  results.newChat = controller["state"].messages.length === 0;

  // Workspace Context
  host.getSnapshot = async () => ({
    workspaceRoots: [{ uri: "file:///workspace", fsPath: "/workspace", name: "workspace" }],
    activeDocument: null, selection: null, diagnostics: [], visibleDocuments: []
  });
  await controller.refreshContext(await host.getSnapshot());
  results.singleRoot = controller["state"].context.some((c: any) => c.label === "1 workspace roots");

  host.getSnapshot = async () => ({
    workspaceRoots: [], activeDocument: { uri: "file:///b", workspaceRelativePath: "root-b", languageId: "ts", version: 1, isDirty: false }, selection: null, diagnostics: [], visibleDocuments: []
  });
  await controller.refreshContext(await host.getSnapshot());
  results.activeRootB = controller["state"].context.some((c: any) => c.label === "root-b");

  host.getSnapshot = async () => ({
    workspaceRoots: [{ uri: "A", fsPath: "A", name: "A" }, { uri: "B", fsPath: "B", name: "B" }], activeDocument: null, selection: null, diagnostics: [], visibleDocuments: []
  });
  await controller.refreshContext(await host.getSnapshot());
  results.ambiguousMultiRoot = controller["state"].context.some((c: any) => c.label === "2 workspace roots");

  host.getSnapshot = async () => ({
    workspaceRoots: [], activeDocument: null, selection: null, diagnostics: [], visibleDocuments: []
  });
  await controller.refreshContext(await host.getSnapshot());
  results.noWorkspace = controller["state"].context.length === 0;

  // Context Events Refresh
  host.getSnapshot = async () => ({
    workspaceRoots: [{ uri: `file://${fixtures.tmpRoot || "/tmp"}`, fsPath: fixtures.tmpRoot || "/tmp", name: "workspace" }],
    activeDocument: null, selection: null, diagnostics: [], visibleDocuments: []
  });
  let callsBefore = getCalls();
  await controller.refreshContext(await host.getSnapshot());
  results.zeroProviderCallsOnRefresh = getCalls() === callsBefore;

  // Real approve
  let resolveApprove: any;
  setRunTask(async () => {
    const p = controller.requestConfirmation("Approve?", { action: "write" });
    await new Promise(r => setTimeout(r, 10)); // yield
    await new Promise(r => resolveApprove = r);
    const res = await p;
    return { status: "COMPLETED", finalAnswer: res === "APPROVE" ? "approved" : "rejected" };
  });
  await view.webview.send({ type: "chat.send", text: "approve me", mode: "ASK" });
  await new Promise(r => setTimeout(r, 50)); // wait for runTask to hit
  const pendingId = controller["state"].pendingConfirmation?.id;
  if (!pendingId) throw new Error("No pending confirmation found!");
  await view.webview.send({ type: "confirmation.respond", confirmationId: pendingId, action: "APPROVE" });
  resolveApprove();
  await waitTurnIdle(controller);
  results.realApprove = messages().slice(-1)[0].content === "approved";

  // Real reject
  let resolveReject: any;
  setRunTask(async () => {
    const p = controller.requestConfirmation("Reject?", { action: "write" });
    await new Promise(r => setTimeout(r, 10)); // yield
    await new Promise(r => resolveReject = r);
    const res = await p;
    return { status: "COMPLETED", finalAnswer: res === "APPROVE" ? "approved" : "rejected" };
  });
  await view.webview.send({ type: "chat.send", text: "reject me", mode: "ASK" });
  await new Promise(r => setTimeout(r, 20)); // wait for runTask to hit
  const rejectPendingId = controller["state"].pendingConfirmation?.id;
  await view.webview.send({ type: "confirmation.respond", confirmationId: rejectPendingId, action: "REJECT" });
  resolveReject();
  await waitTurnIdle(controller);
  results.realReject = messages().slice(-1)[0].content === "rejected";

  // Forged ID
  let resolveForged: any;
  setRunTask(async () => {
    const p = controller.requestConfirmation("Forge?", { action: "write" });
    await new Promise(r => setTimeout(r, 10)); // yield
    await new Promise(r => resolveForged = r);
    const res = await p;
    return { status: "COMPLETED", finalAnswer: res === "APPROVE" ? "forged" : "rejected" };
  });
  await view.webview.send({ type: "chat.send", text: "forge me", mode: "ASK" });
  await new Promise(r => setTimeout(r, 20));
  const realId = controller["state"].pendingConfirmation?.id;
  await view.webview.send({ type: "confirmation.respond", confirmationId: "fake-id", action: "APPROVE" }); // should be ignored
  results.forgedIdIgnored = controller["state"].pendingConfirmation?.id === realId;
  await view.webview.send({ type: "confirmation.respond", confirmationId: realId, action: "APPROVE" });
  resolveForged();
  await waitTurnIdle(controller);
  results.forgedIdRecovered = messages().slice(-1)[0].content === "forged";

  // Validation Cases
  let stateSentOnReady = false;
  const oldPost = view.webview.postMessage.bind(view.webview);
  view.webview.postMessage = (msg: any) => {
    if (msg.type === "chat.state") stateSentOnReady = true;
    oldPost(msg);
  };
  await view.webview.send({ type: "chat.ready" });
  results.chatReady = stateSentOnReady;

  let copiedText = "";
  (mockVscode.env.clipboard as any).writeText = (text: string) => copiedText = text;
  await view.webview.send({ type: "ui.copyCode", text: "copied!" });
  results.copyCode = copiedText === "copied!";

  const prevLen = controller["state"].messages.length;
  await view.webview.send({ type: "chat.send", text: "   ", mode: "ASK" });
  results.emptySendIgnored = controller["state"].messages.length === prevLen;

  await view.webview.send({ type: "chat.send", mode: "ASK" } as any);
  results.missingTextIgnored = controller["state"].messages.length === prevLen;

  await view.webview.send({ type: "confirmation.respond", confirmationId: "A".repeat(101), action: "APPROVE" });
  results.longConfIdIgnored = controller["state"].pendingConfirmation?.id !== "A".repeat(101);

  await view.webview.send({ type: "confirmation.respond", confirmationId: "123", action: "INVALID" } as any);
  results.invalidConfActionIgnored = controller["state"].pendingConfirmation?.id !== "123";

  await view.webview.send({ type: "ui.copyCode", text: "A".repeat(200001) });
  results.hugeCopyIgnored = copiedText === "copied!"; // hasn't changed

  await view.webview.send({ type: "chat.setMode" } as any);
  results.missingModeIgnored = controller["state"].messages.length === prevLen;

  // Cancel while pending
  let resolveCancel: any;
  setRunTask(async (inst: any, mode: any, sig: AbortSignal) => {
    const p = controller.requestConfirmation("Cancel?", { action: "write" });
    await new Promise(r => setTimeout(r, 10)); // yield
    await new Promise(r => {
      resolveCancel = r;
      sig.addEventListener("abort", () => r(true));
    });
    return { status: "CANCELLED" };
  });
  await view.webview.send({ type: "chat.send", text: "cancel me", mode: "ASK" });
  await new Promise(r => setTimeout(r, 20));
  await view.webview.send({ type: "chat.cancel" });
  if (resolveCancel) resolveCancel();
  await waitTurnIdle(controller);
  results.cancelWhilePending = messages().slice(-1)[0].status === "cancelled";

  // delayed cancellation
  setRunTask(async (inst: any, mode: any, sig: AbortSignal) => {
    return new Promise(resolve => {
      sig.addEventListener("abort", () => resolve({ status: "CANCELLED" }));
    });
  });
  view.webview.send({ type: "chat.send", text: "delayed cancel", mode: "ASK" });
  await new Promise(r => setTimeout(r, 10));
  view.webview.send({ type: "chat.cancel" });
  await waitTurnIdle(controller);
  results.delayedCancellation = messages().slice(-1)[0].status === "cancelled";

  // BUSY policy
  let resolveBusy: any;
  setRunTask(async () => {
    return new Promise(resolve => resolveBusy = resolve);
  });
  view.webview.send({ type: "chat.send", text: "busy 1", mode: "ASK" });
  await new Promise(r => setTimeout(r, 10));
  const busyCalls = getCalls();
  view.webview.send({ type: "chat.send", text: "busy 2", mode: "ASK" });
  results.busyPolicy = getCalls() === busyCalls; // no new calls
  resolveBusy({ status: "COMPLETED", finalAnswer: "done busy" });
  await waitTurnIdle(controller);

  // Provider failure
  setRunTask(async () => {
    throw new Error("Provider broken");
  });
  view.webview.send({ type: "chat.send", text: "fail me", mode: "ASK" });
  await waitTurnIdle(controller);
  results.providerFailure = messages().slice(-1)[0].status === "failed";
  
  // Recovery next turn
  setRunTask(async () => {
    return { status: "COMPLETED", finalAnswer: "recovered" };
  });
  view.webview.send({ type: "chat.send", text: "recover me", mode: "ASK" });
  await waitTurnIdle(controller);
  results.recoveryNextTurn = messages().slice(-1)[0].content === "recovered";
  
  // Unknown message
  view.webview.send({ type: "evil.execute" });
  let prevUnknownMsgLen = controller["state"].messages.length;
  let prevUnknownMode = controller["state"].mode;
  let prevUnknownConf = controller["state"].pendingConfirmation;
  results.unknownMessage = controller["state"].messages.length === prevUnknownMsgLen && controller["state"].mode === prevUnknownMode && controller["state"].pendingConfirmation === prevUnknownConf;

  // Invalid mode
  view.webview.send({ type: "chat.send", text: "x", mode: "INVALID_MODE" });
  results.invalidMode = controller["state"].messages.slice(-1)[0].content !== "x";

  // Oversized send
  const hugeText = "A".repeat(100000);
  view.webview.send({ type: "chat.send", text: hugeText, mode: "ASK" });
  results.oversizedSend = controller["state"].messages.slice(-1)[0].content !== hugeText;
  
  
  
  
  
  // Stale turn races (Success and Error)
  let delayedResolver: any;
  setRunTask(async (i, m, signal) => new Promise(resolve => {
    delayedResolver = resolve;
  }));

  view.webview.send({ type: "chat.send", text: "stale req", mode: "ASK" });
  await new Promise(r => setTimeout(r, 10)); // starts

  // New Chat
  await view.webview.send({ type: "chat.newConversation" });
  await new Promise(r => setTimeout(r, 10)); // state cleared

  // Resolve late
  delayedResolver({ status: "COMPLETED", finalAnswer: "stale answer" });
  await new Promise(r => setTimeout(r, 20)); 

  results.staleSuccess = controller["state"].messages.every((m: any) => m.content !== "stale answer");
  
  let delayedRejecter: any;
  setRunTask(async () => new Promise((_, reject) => { delayedRejecter = reject; }));
  view.webview.send({ type: "chat.send", text: "stale req err", mode: "ASK" });
  await new Promise(r => setTimeout(r, 10));
  await view.webview.send({ type: "chat.newConversation" });
  delayedRejecter(new Error("stale error"));
  await new Promise(r => setTimeout(r, 20));
  results.staleError = controller["state"].messages.every((m: any) => !m.error);




  
  // Transcript pruning
  view.webview.send({ type: "chat.newConversation" });
  setRunTask(async () => { return { status: "COMPLETED", finalAnswer: "A".repeat(10000) }; });
  for (let i = 0; i < 25; i++) {
    view.webview.send({ type: "chat.send", text: "x", mode: "ASK" });
    await waitTurnIdle(controller);
  }
  results.transcriptPruning = controller["state"].messages.length <= 100;

  return results;
};

const normalizeResults = (res: any) => {
  return JSON.parse(JSON.stringify(res)); // nothing ephemeral to normalize for this set
};

describe("Chat UX Evaluation", () => {
  before(async () => {
    ChatController = (await import("../src/chat-controller.js")).ChatController;
  });

  test("Evaluations are deterministic and all pass", async () => {
    const run1 = await runChatEvaluation(freshFixtures());
    const run2 = await runChatEvaluation(freshFixtures());
    
    assert.deepEqual(normalizeResults(run1), normalizeResults(run2));
    
    // Assert all true
    for (const [k, v] of Object.entries(run1)) {
      assert.strictEqual(v, true, `Scenario failed: ${k}`);
    }
  });
});
