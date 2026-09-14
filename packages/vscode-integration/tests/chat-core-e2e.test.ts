import { AgentSessionBridge } from "../../ide-adapter/src/bridge.ts";
import { test, describe, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const mockVscode = {
  window: { showErrorMessage: () => {}, showWarningMessage: async () => "Cancel" },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { writeText: () => {} } },
  languages: { onDidChangeDiagnostics: () => ({ dispose: () => {} }) },
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
  public lastMessage: any;
  public onDidReceiveMessageCb?: (msg: any) => void;
  onDidReceiveMessage(cb: (msg: any) => void) { this.onDidReceiveMessageCb = cb; }
  postMessage(message: any) { this.lastMessage = message; }
  async send(msg: any) { if (this.onDidReceiveMessageCb) { await this.onDidReceiveMessageCb(msg); } }
}

class TestProvider {
  capabilities = new Set(["chat", "tools"]);
  calls: any[] = [];
  steps: any[] = [];
  
  async complete(request: any) {
    this.calls.push(request);
    const step = this.steps.shift();
    if (typeof step === 'function') return step(request.messages, null, request.signal);
    if (!step) throw new Error("No steps left");
    return step;
  }
}

const freshCoreFixtures = () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-core-test-"));
  
  let controller: any;
  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null, selection: null, diagnostics: [], visibleDocuments: []
    }),
    showOutput: async () => {}, showError: async () => {}, isWorkspaceTrusted: async () => true, readTextDocument: async () => "", 
    writeTextDocument: async (uri: any, content: any) => { require("fs").writeFileSync(uri.replace("file://", ""), content); }, 
    applyWorkspaceEdit: async (edit: any) => { for (const entry of edit.entries()) { require("fs").writeFileSync(entry[0].fsPath, entry[1][0].newText); } return true; }, 
    executeCommand: async () => {}, 
    log: () => {}, 
    requestConfirmation: async (prompt: any, payload: any) => await controller.requestConfirmation(prompt, payload)
  };
  
  const provider = new TestProvider();
  
  const bridgeFactory = (options: any) => {
    return new AgentSessionBridge({ ...options, providerOverride: provider });
  };

  controller = new ChatController(host as any, bridgeFactory);
  const view = { webview: new MockWebview() };
  controller.setWebviewView(view as any);
  controller.diffReviewController = { setStatus: () => {}, clearReview: () => {} };
  
  return { host, controller, view, provider, tmpRoot };
};

export const runChatCoreEvaluation = async (fixtures: ReturnType<typeof freshCoreFixtures>) => {
  const { controller, view, provider, tmpRoot } = fixtures;
  const results: any = {};
  const waitForTurn = async () => {
    let i = 0;
    while (controller["state"].activeTurn && i < 100) {
      await new Promise(r => setTimeout(r, 10));
      i++;
    }
  };
  
  // 1. REAL ASK
  provider.steps.push({ message: { role: "assistant", content: "done ask" }, toolCalls: [] });
  let beforeCalls = provider.calls.length;
  await view.webview.send({ type: "chat.send", text: "hello ask", mode: "ASK" });
  await waitForTurn();
  
  results.ask = {
    providerCalls: provider.calls.length - beforeCalls,
    assistantMessages: controller["state"].messages.filter((m: any) => m.role === 'assistant').length,
    terminalStatus: controller["state"].messages.slice(-1)[0].status,
  };

  // 2. REAL BUILD APPROVE
  const testFilePath = path.join(tmpRoot, 'test-build.txt');
  provider.steps.push({ message: { role: "assistant", content: "building" }, toolCalls: [{ id: "call_1", name: "create_file", arguments: { path: "test-build.txt", content: "built" } }]});
  provider.steps.push({ message: { role: "assistant", content: "done build" }, toolCalls: [] });
  
  await view.webview.send({ type: "chat.newConversation" });
  await view.webview.send({ type: "chat.setMode", mode: "BUILD" });
  view.webview.send({ type: "chat.send", text: "build it", mode: "BUILD" });
  
  // wait for mutation confirmation prompt
  let tries = 0;
  while (!controller["state"].pendingConfirmation && tries < 100) {
    await new Promise(r => setTimeout(r, 10));
    tries++;
  }
  
  const pendingId = controller["state"].pendingConfirmation?.id;
  const confirmationCount = pendingId ? 1 : 0;
  if (pendingId) {
    view.webview.send({ type: "confirmation.respond", confirmationId: pendingId, action: "APPROVE" });
    await waitForTurn();
  }
  
  results.buildApprove = {
    confirmationCount,
    mutationCount: fs.existsSync(testFilePath) ? 1 : 0,
    fileChanged: fs.existsSync(testFilePath) ? "yes" : "no",
  };

  // 3. REAL BUILD REJECT
  const testRejectPath = path.join(tmpRoot, 'test-reject.txt');
  provider.steps.push({ message: { role: "assistant", content: "rejecting" }, toolCalls: [{ id: "call_2", name: "create_file", arguments: { path: "test-reject.txt", content: "reject" } }]});
  provider.steps.push({ message: { role: "assistant", content: "done reject" }, toolCalls: [] });
  
  await view.webview.send({ type: "chat.newConversation" });
  view.webview.send({ type: "chat.send", text: "reject it", mode: "BUILD" });
  
  tries = 0;
  while (!controller["state"].pendingConfirmation && tries < 100) {
    await new Promise(r => setTimeout(r, 10));
    tries++;
  }
  
  const rejectPendingId = controller["state"].pendingConfirmation?.id;
  if (rejectPendingId) {
    view.webview.send({ type: "confirmation.respond", confirmationId: rejectPendingId, action: "REJECT" });
    await waitForTurn();
  }
  
  results.buildReject = {
    mutationCount: fs.existsSync(testRejectPath) ? 1 : 0,
    fileChanged: fs.existsSync(testRejectPath) ? "yes" : "no",
  };

  // 4. REAL REVIEW DENIAL
  const testReviewPath = path.join(tmpRoot, 'test-review.txt');
  provider.steps.push({ message: { role: "assistant", content: "reviewing" }, toolCalls: [{ id: "call_3", name: "create_file", arguments: { path: "test-review.txt", content: "review" } }]});
  provider.steps.push({ message: { role: "assistant", content: "done review" }, toolCalls: [] });
  
  await view.webview.send({ type: "chat.newConversation" });
  await view.webview.send({ type: "chat.setMode", mode: "REVIEW" });
  view.webview.send({ type: "chat.send", text: "review it", mode: "REVIEW" });
  await waitForTurn();
  
  results.reviewDenial = {
    mutationCount: fs.existsSync(testReviewPath) ? 1 : 0,
    fileChanged: fs.existsSync(testReviewPath) ? "yes" : "no"
  };

  // 5. REAL CANCELLATION
  let abortObserved = "no";
  
  let markProviderStarted: () => void;
  const providerStarted = new Promise<void>(resolve => {
    markProviderStarted = resolve;
  });

  // Clear any leftover steps from previous tests that might have exited early
  provider.steps = [];


  provider.steps.push(
    async (messages: any, onEvent: any, signal: any) => {
      return new Promise((resolve, reject) => {
         if (signal?.aborted) {
           abortObserved = "yes";
           const err = new Error("AbortError");
           err.name = "AbortError";
           reject(err);
           return;
         }
         signal?.addEventListener("abort", () => {
           abortObserved = "yes";
           const err = new Error("AbortError");
           err.name = "AbortError";
           reject(err);
         }, { once: true });
         
         markProviderStarted();
      });
    }
  );
  
  await view.webview.send({ type: "chat.newConversation" });
  await view.webview.send({ type: "chat.setMode", mode: "ASK" });
  view.webview.send({ type: "chat.send", text: "cancel test", mode: "ASK" });
  
  await providerStarted; // deterministic wait
  await view.webview.send({ type: "chat.cancel" });
  await waitForTurn();
  
  results.cancellation = {
    abortObserved,
    lateResultRendered: controller["state"].messages.some((m: any) => m.content === "cancelled internally") ? "yes" : "no",
  };

  // 6. CANCEL DURING CONFIRMATION
  provider.steps.push({ message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "call_4", name: "create_file", arguments: { path: "mut.txt", content: "mut" } }]});
  provider.steps.push({ message: { role: "assistant", content: "done mut" }, toolCalls: [] });
  
  await view.webview.send({ type: "chat.newConversation" });
  await view.webview.send({ type: "chat.setMode", mode: "BUILD" });
  view.webview.send({ type: "chat.send", text: "cancel confirm", mode: "BUILD" });
  
  tries = 0;
  while (!controller["state"].pendingConfirmation && tries < 100) {
    await new Promise(r => setTimeout(r, 10));
    tries++;
  }
  
  await view.webview.send({ type: "chat.cancel" });
  await waitForTurn();
  
  results.cancelDuringConfirm = {
    mutationCount: fs.existsSync(path.join(tmpRoot, 'mut.txt')) ? 1 : 0,
  };

  return results;
};

describe("Real Core Evaluations", () => {
  before(async () => {
    ChatController = (await import("../src/chat-controller.js")).ChatController;
  });

  test("Real core E2E scenarios", async () => {
    const res = await runChatCoreEvaluation(freshCoreFixtures());
    assert.strictEqual(res.ask.providerCalls, 1);
    assert.strictEqual(res.ask.assistantMessages, 1);
    assert.strictEqual(res.ask.terminalStatus, "completed");

    assert.strictEqual(res.buildApprove.mutationCount, 1);
    assert.strictEqual(res.buildApprove.fileChanged, "yes");

    assert.strictEqual(res.buildReject.mutationCount, 0);
    assert.strictEqual(res.buildReject.fileChanged, "no");

    assert.strictEqual(res.reviewDenial.mutationCount, 0);

    assert.strictEqual(res.cancellation.abortObserved, "yes");
    assert.strictEqual(res.cancellation.lateResultRendered, "no");

    assert.strictEqual(res.cancelDuringConfirm.mutationCount, 0);
  });
});
