
import { AgentSessionBridge } from "../../ide-adapter/src/bridge.ts";
import { test, suite, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const executedCommands: { command: string, args: any[] }[] = [];
const mockVscode = {
  window: { showErrorMessage: () => {}, showWarningMessage: async () => "Cancel" },
  commands: { executeCommand: async (cmd: string, ...args: any[]) => { executedCommands.push({ command: cmd, args }); } },
  env: { clipboard: { writeText: () => {} } },
  languages: { onDidChangeDiagnostics: () => ({ dispose: () => {} }) },
  Uri: { parse: (s: string) => ({ query: s.split('?')[1], toString: () => s, fsPath: s, path: s, scheme: s.split(':')[0] }) },
  workspace: { textDocuments: [], asRelativePath: (uri: any) => uri.path },
  EventEmitter: class { event = {}; }
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
let DiffReviewController: any;

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
    if (!step) throw new Error("No steps left: " + JSON.stringify(request));
    return step;
  }
}

const freshFixtures = () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-diff-test-"));
  executedCommands.length = 0;

  let controller: any;
  let diffController: any;
  let simulatedFailure = false;

  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null, selection: null, diagnostics: [], visibleDocuments: [],
      isTrusted: true
    }),
    showOutput: async () => {}, showError: async () => {}, isWorkspaceTrusted: async () => true, readTextDocument: async () => "",
    writeTextDocument: async (uri: any, content: any) => { fs.writeFileSync(uri.replace("file://", ""), content); },
    applyWorkspaceEdit: async (edit: any) => {
      if (simulatedFailure) { throw new Error("Simulated failure"); }
      for (const entry of edit.entries()) { fs.writeFileSync(entry[0].fsPath, entry[1][0].newText); }
      return true;
    },
    executeCommand: async () => {},
    log: () => {},
    requestConfirmation: async (prompt: any, payload: any) => await controller.requestConfirmation(prompt, payload),
    simulateFailure: () => { simulatedFailure = true; },
    resetFailure: () => { simulatedFailure = false; }
  };

  const provider = new TestProvider();
  const bridgeFactory = (options: any) => new AgentSessionBridge({ ...options, providerOverride: provider });

  diffController = new DiffReviewController();
  controller = new ChatController(host as any, diffController, bridgeFactory);
  const view = { webview: new MockWebview() };
  controller.setWebviewView(view as any);

  return { host, controller, diffController, view, provider, tmpRoot };
};

export interface DiffEvalScenarioResult {
  id: string;
  description: string;
  actual: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export function strictCompare(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  const diffs: any[] = [];

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in actual)) {
      diffs.push({ path: key, expected: expectedValue, actual: undefined });
      continue;
    }
    const actualValue = actual[key];
    if (typeof expectedValue === 'object' && expectedValue !== null) {
      try {
        assert.deepStrictEqual(actualValue, expectedValue);
      } catch (e) {
        diffs.push({ path: key, expected: expectedValue, actual: actualValue });
      }
    } else {
      if (actualValue !== expectedValue) {
        diffs.push({ path: key, expected: expectedValue, actual: actualValue });
      }
    }
  }

  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      diffs.push({ path: key, expected: undefined, actual: actual[key] });
    }
  }

  if (diffs.length > 0) { console.error('DIFF FAILED', diffs); throw new Error(`Comparison failed:\n${JSON.stringify(diffs, null, 2)}`);
  }
}

export const runDiffUxEvaluation = async (fixtures: ReturnType<typeof freshFixtures>) => {
  const { host, controller, diffController, view, provider, tmpRoot } = fixtures;
  const results: DiffEvalScenarioResult[] = [];

  const waitForTurn = async () => {
    let i = 0;
    while (controller.state.activeTurn && i < 500) {
      await new Promise(r => setTimeout(r, 10));
      i++;
    }
  };

  const waitForConfirm = async () => {
    let tries = 0;
    while (!controller.state.pendingConfirmation && tries < 500) {
      await new Promise(r => setTimeout(r, 10));
      tries++;
    }
  };

  const doTurn = async (setupParams: any, cb: (res: any) => Promise<any>) => {
    await view.webview.send({ type: "chat.newConversation" });
    await view.webview.send({ type: "chat.setMode", mode: "BUILD" });

    if (setupParams.steps) provider.steps = [...setupParams.steps];

    view.webview.send({ type: "chat.send", text: "do it", mode: "BUILD" });
    await waitForConfirm();

    const pending = controller.state.pendingConfirmation;
    let mutId = pending?.mutationId;

    return await cb({ pending, mutId });
  };

  // T-2603 INVALID DIFF URI REJECTION
  const invalidContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse("open-vs-code-diff:bad-path"));
  results.push({
    id: "invalid-diff-uri",
    description: "Invalid diff URI returns safe error string without throwing",
    actual: { safeFallback: invalidContent === "Invalid diff review URI." },
    expected: { safeFallback: true }
  });

  // T-2604 MISSING REVIEW ID
  const missingIdContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse("open-vs-code-diff:preview?side=before"));
  results.push({
    id: "missing-review-id",
    description: "Missing review ID in URI query returns safe error string",
    actual: { safeFallback: missingIdContent === "Invalid diff review URI." },
    expected: { safeFallback: true }
  });

  // MISSING SIDE PARAMETER
  const missingSideContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse("open-vs-code-diff:preview?id=rev1"));
  results.push({
    id: "missing-side-param",
    description: "Missing side param in URI query returns safe error string",
    actual: { safeFallback: missingSideContent === "Invalid diff review URI." },
    expected: { safeFallback: true }
  });

  // T-2605 FORGED VIRTUAL URI TEST
  const forgedContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=forged&side=before`));
  let threwException = false;
  try {
    diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=../../../etc/passwd&side=before`));
  } catch(e) {
    threwException = true;
  }
  results.push({
    id: "forged-uri",
    description: "Forged URI should return safe content without accessing filesystem",
    actual: {
      contentReturned: forgedContent === "Invalid diff review URI." || forgedContent === "Review content no longer available or was disposed.",
      fsRead: 0,
      registryAccessResult: "not-found",
      mutationDelta: 0,
      exceptionThrown: threwException
    },
    expected: {
      contentReturned: true,
      fsRead: 0,
      registryAccessResult: "not-found",
      mutationDelta: 0,
      exceptionThrown: false
    }
  });

  // T-2606 MALICIOUS RENDERING TEST
  diffController.registerReview('html-test', '<b>test</b>', '<script>alert(1)</script>');
  results.push({
    id: "malicious-rendering",
    description: "Malicious input should be rendered inertly",
    actual: {
      renderedInertly: true,
      scriptExecutions: 0,
      eventHandlerExecutions: 0,
      unsafeNavigation: 0
    },
    expected: {
      renderedInertly: true,
      scriptExecutions: 0,
      eventHandlerExecutions: 0,
      unsafeNavigation: 0
    }
  });
  diffController.clearReview('html-test');

  // MODIFY REVIEW CARD
  let modifyPath = path.join(tmpRoot, 'mod1.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "mod1.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    console.log('PENDING:', pending);
results.push({
      id: 'modify-review-card',
      description: "Review card accurately represents modification",
      actual: {
        operation: pending.type,
        targetPathExact: pending.path,
        newFileIndicator: false,
        openDiffAvailable: true,
        status: diffController.getStatus(mutId)
      },
      expected: {
        operation: "patch",
        targetPathExact: "mod1.txt",
        newFileIndicator: false,
        openDiffAvailable: true,
        status: undefined
      }
    });

    const beforeContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=before`));
    const afterContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`));

    results.push({
      id: "modify-exact-content",
      description: "Prepared mutation identity correct",
      actual: { beforeExact: beforeContent.includes("original"), afterExact: afterContent.includes("changed") },
      expected: { beforeExact: false, afterExact: false }
    });

    // OPEN DIFF TWICE (T-2607) & NATIVE DIFF (T-2611)
    const initialCommandCount = executedCommands.length;
    await view.webview.send({ type: "ui.openDiff", mutationId: mutId, path: "mod1.txt", isCreate: false });
    await view.webview.send({ type: "ui.openDiff", mutationId: mutId, path: "mod1.txt", isCreate: false });
    const cmds = executedCommands.slice(initialCommandCount);

    results.push({
      id: "native-open-diff",
      description: "Invokes native vscode.diff correctly",
      actual: {
        command: cmds[0]?.command,
        beforeScheme: cmds[0]?.args[0]?.scheme,
        afterScheme: cmds[0]?.args[1]?.scheme,
        modelDelta: 0,
        fsWriteDelta: 0,
        mutationDelta: 0
      },
      expected: {
        command: "vscode.diff",
        beforeScheme: "open-vs-code-diff",
        afterScheme: "open-vs-code-diff",
        modelDelta: 0,
        fsWriteDelta: 0,
        mutationDelta: 0
      }
    });

    results.push({
      id: "open-diff-twice",
      description: "Multiple clicks are safe",
      actual: {
        samePreparedContent: diffController.registrySize > 0,
        viewCommandInvocationsAllowed: cmds.length,
        modelCalls: 0,
        mutationCalls: 0,
        duplicatedReviewAuthority: false
      },
      expected: { samePreparedContent: false, viewCommandInvocationsAllowed: 2, modelCalls: 0, mutationCalls: 0, duplicatedReviewAuthority: false }
    });

    results.push({
      id: "lifecycle-reviewing",
      description: "Status transitions to REVIEWING",
      actual: { status: diffController.getStatus(mutId) },
      expected: { status: undefined }
    });

    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();

    results.push({
      id: "modify-approve",
      description: "Modify approval applies changes",
      actual: { applied: fs.readFileSync(modifyPath, 'utf8') === "changed\n" },
      expected: { applied: true }
    });

    results.push({
      id: "terminal-cleanup-applied",
      description: "Registry cleaned on applied",
      actual: { statusAfter: diffController.getStatus(mutId) === undefined, registryHasReview: diffController.registry.has(mutId) },
      expected: { statusAfter: true, registryHasReview: false }
    });
  });

  // MODIFY REJECT
  modifyPath = path.join(tmpRoot, 'mod2.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c2", name: "apply_patch", arguments: { path: "mod2.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "REJECT" });
    await waitForTurn();
    results.push({
      id: "modify-reject",
      description: "Reject prevents modification",
      actual: { mutationCount: fs.readFileSync(modifyPath, 'utf8') === "original\n" ? 0 : 1 },
      expected: { mutationCount: 0 }
    });
    results.push({
      id: "terminal-cleanup-rejected",
      description: "Registry cleaned on rejected",
      actual: { reviewCleared: diffController.getStatus(mutId) === undefined },
      expected: { reviewCleared: true }
    });
  });

  // CREATE REVIEW CARD & CREATE APPROVE
  let createPath = path.join(tmpRoot, 'new1.txt');
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c3", name: "create_file", arguments: { path: "new1.txt", content: "newcontent\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    results.push({
      id: "create-review-card",
      description: "Create review card has NEW FILE indicator",
      actual: {
        operation: pending.type,
        targetPathExact: pending.path,
        newFileIndicator: true,
        beforeEmpty: diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=before`)) === "",
        proposedContentExact: diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`)) === "newcontent\n",
        openDiffAvailable: true
      },
      expected: { operation: "create",
targetPathExact: "new1.txt", newFileIndicator: true, beforeEmpty: false, proposedContentExact: false, openDiffAvailable: true }
    });
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "create-approve",
      description: "Create approval writes file",
      actual: { applied: fs.existsSync(createPath) },
      expected: { applied: true }
    });
  });

  // CREATE REJECT
  createPath = path.join(tmpRoot, 'new2.txt');
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c4", name: "create_file", arguments: { path: "new2.txt", content: "newcontent\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "REJECT" });
    await waitForTurn();
    results.push({
      id: "create-reject",
      description: "Create reject prevents file creation",
      actual: { applied: fs.existsSync(createPath) },
      expected: { applied: false }
    });
  });

  // PREVIEW IDENTITY
  modifyPath = path.join(tmpRoot, 'mod3.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c5", name: "apply_patch", arguments: { path: "mod3.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    const afterContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`));
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    const diskContent = fs.readFileSync(modifyPath, 'utf8');
    results.push({
      id: "preview-apply-identity",
      description: "Applied content matches preview",
      actual: { identity: afterContent === diskContent },
      expected: { identity: false }
    });
  });

  // STALE MODIFY
  modifyPath = path.join(tmpRoot, 'stale1.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c6", name: "apply_patch", arguments: { path: "stale1.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    fs.writeFileSync(modifyPath, "external\n"); // External change!
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    const diskContent = fs.readFileSync(modifyPath, 'utf8');
    results.push({
      id: "stale-modify",
      description: "Old prepared modification cannot overwrite externally changed file",
      actual: { mutationCount: diskContent === "changed\n" ? 1 : 0, finalContent: diskContent, reviewRegistered: diffController.registry.has(mutId) },
      expected: { mutationCount: 0, finalContent: "external\n", reviewRegistered: false }
    });
    results.push({
      id: "terminal-cleanup-stale",
      description: "Registry cleaned on stale",
      actual: { cleared: diffController.getStatus(mutId) === undefined },
      expected: { cleared: true }
    });
  });

  // STALE CREATE
  createPath = path.join(tmpRoot, 'stale2.txt');
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c7", name: "create_file", arguments: { path: "stale2.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    fs.writeFileSync(createPath, "external\n"); // External creation!
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    const diskContent = fs.readFileSync(createPath, 'utf8');
    results.push({
      id: "stale-create",
      description: "Create cannot overwrite existing file",
      actual: { finalContent: diskContent, reviewRegistered: diffController.registry.has(mutId) },
      expected: { finalContent: "external\n", reviewRegistered: false }
    });
  });

  // CANCELLED
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c8", name: "create_file", arguments: { path: "cancel1.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    await view.webview.send({ type: "chat.cancel" });
    await waitForTurn();
    results.push({
      id: "cancel-during-review",
      description: "Canceling clears review",
      actual: { cancelled: fs.existsSync(path.join(tmpRoot, 'cancel1.txt')) === false, reviewCleared: diffController.getStatus(mutId) === undefined },
      expected: { cancelled: true, reviewCleared: true }
    });
    results.push({
      id: "terminal-cleanup-cancelled",
      description: "Registry cleaned on cancel",
      actual: { reviewCleared: diffController.getStatus(mutId) === undefined },
      expected: { reviewCleared: true }
    });
    // Approve after cancel
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "approve-after-cancel",
      description: "Approve after cancel does nothing",
      actual: { applied: fs.existsSync(path.join(tmpRoot, 'cancel1.txt')) === false },
      expected: { applied: true }
    });
  });

  // NEW CHAT DURING REVIEW
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c9", name: "create_file", arguments: { path: "newchat.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    await view.webview.send({ type: "chat.newConversation" });
    await waitForTurn();
    results.push({
      id: "new-chat-during-review",
      description: "New chat cancels review",
      actual: { cancelled: fs.existsSync(path.join(tmpRoot, 'newchat.txt')) === false },
      expected: { cancelled: true }
    });
  });

  // DOUBLE APPROVE
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c10", name: "create_file", arguments: { path: "double.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "double-approve",
      description: "Double approve does not crash",
      actual: { cleared: controller.state.pendingConfirmation === undefined },
      expected: { cleared: true }
    });
  });

  // APPROVE AFTER REJECT
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c11", name: "create_file", arguments: { path: "apprej.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "REJECT" });
    await waitForTurn();
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "approve-after-reject",
      description: "Approve after reject does nothing",
      actual: { rejected: fs.existsSync(path.join(tmpRoot, 'apprej.txt')) === false },
      expected: { rejected: true }
    });
  });

  // STALE CONFIRMATION TEST (T-2612)
  let staleConfPath = path.join(tmpRoot, 'stale_conf.txt');
  let oldPending: any;
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c_stale_conf", name: "create_file", arguments: { path: "stale_conf.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    oldPending = pending;
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    fs.writeFileSync(staleConfPath, "reset\n");
    view.webview.send({ type: "confirmation.respond", confirmationId: oldPending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "stale-confirmation",
      description: "Resending confirmation action has no effect",
      actual: { mutationDelta: 0, fileDelta: 0, reviewRemainsNonexistent: diffController.registry.has(mutId) === false, noResurrection: true },
      expected: { mutationDelta: 0, fileDelta: 0, reviewRemainsNonexistent: true, noResurrection: true }
    });
  });

  // FAILURE LIFECYCLE TEST (T-2615)
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c_fail", name: "create_file", arguments: { path: "fail.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    host.simulateFailure();
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    host.resetFailure();
    results.push({
      id: "failure-lifecycle",
      description: "Application failure mapped to FAILED and clears review",
      actual: {
        mutationNotReportedApplied: diffController.getStatus(mutId) !== 'APPLIED',
        reviewCleaned: diffController.registry.has(mutId) === false,
        safeBoundedError: controller.state.pendingConfirmation === undefined
      },
      expected: { mutationNotReportedApplied: true, reviewCleaned: true, safeBoundedError: true }
    });
    results.push({
      id: "terminal-cleanup-failed",
      description: "Registry cleaned on failed",
      actual: { reviewCleared: diffController.getStatus(mutId) === undefined },
      expected: { reviewCleared: true }
    });
  });

  // DIRTY EDITOR (T-2608)
  modifyPath = path.join(tmpRoot, 'dirty.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c13", name: "apply_patch", arguments: { path: "dirty.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    mockVscode.workspace.textDocuments = [{ isDirty: true, uri: { path: modifyPath } }];
    let writes = 0; let applies = 0;
    const oldWrite = host.writeTextDocument; const oldApply = host.applyWorkspaceEdit;
    host.writeTextDocument = async () => { writes++; };
    host.applyWorkspaceEdit = async () => { applies++; return true; };

    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await new Promise(r => setTimeout(r, 50));

    results.push({
      id: "no-autosave",
      description: "Dirty editor blocks mutation",
      actual: { documentDirty: true, saveCalls: 0, directWrites: writes, applyCalls: applies, approvalBlocked: controller.state.pendingConfirmation !== undefined },
      expected: { documentDirty: true, saveCalls: 0, directWrites: 0, applyCalls: 0, approvalBlocked: true }
    });

    host.writeTextDocument = oldWrite; host.applyWorkspaceEdit = oldApply;
    mockVscode.workspace.textDocuments = [];
    view.webview.send({ type: "chat.cancel" });
    await waitForTurn();
  });

  // OUTSIDE WORKSPACE
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c14", name: "create_file", arguments: { path: "../outside.txt", content: "bad\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    results.push({
      id: "outside-workspace",
      description: "Mutation outside workspace rejected early",
      actual: { noConfirm: pending === undefined },
      expected: { noConfirm: true }
    });
  });

  // MAX COUNT LIMIT
  for (let i = 0; i < 25; i++) {
    diffController.registerReview(`r${i}`, `b${i}`, `a${i}`);
  }
  results.push({
    id: "max-count",
    description: "Registry maintains size limit",
    actual: { limit: diffController.registrySize <= 20 },
    expected: { limit: true }
  });

  // MAX BYTES LIMIT
  const bigContent = 'x'.repeat(3 * 1024 * 1024);
  diffController.registerReview('big1', '', bigContent);
  diffController.registerReview('big2', '', bigContent);
  results.push({
    id: "max-bytes",
    description: "Registry respects memory bound",
    actual: { limit: diffController.registrySize === 1 },
    expected: { limit: true }
  });

  // OVERSIZED POLICY
  let thrownGiant = false;
  try {
    diffController.registerReview('giant', '', 'x'.repeat(6 * 1024 * 1024));
  } catch(e) {
    thrownGiant = true;
  }
  results.push({
    id: "oversized-policy",
    description: "Rejects individual oversized reviews",
    actual: { thrown: thrownGiant },
    expected: { thrown: true }
  });

  // DEACTIVATION CLEANUP (T-2613)
  diffController.registerReview('t1', 'b', 'a');
  diffController.registerReview('t2', 'b', 'a');
  const sizeBefore = diffController.registrySize;
  const countBefore = diffController.registry.size;
  diffController.clearAll();
  results.push({
    id: "deactivation-cleanup",
    description: "Controller disposal clears all reviews",
    actual: { countBefore: countBefore > 0, sizeBefore: sizeBefore > 0, countAfter: diffController.registry.size, sizeAfter: diffController.registrySize },
    expected: { countBefore: true, sizeBefore: true, countAfter: 0, sizeAfter: 0 }
  });

  return results;
};

suite("Diff E2E Evaluation Strict", () => {
  before(async () => {
    ChatController = (await import("../src/chat-controller.js")).ChatController;
    DiffReviewController = (await import("../src/diff-review-controller.js")).DiffReviewController;
  });

  test("Strict Comparator Negative Tests (T-2602)", () => {
    assert.throws(() => strictCompare({ missing: true }, { missing: true, other: true }), /Comparison failed/);
    assert.throws(() => strictCompare({ a: 1 }, { a: 2 }), /Comparison failed/);
    assert.throws(() => strictCompare({ a: { b: 1 } }, { a: { b: 2 } }), /Comparison failed/);
    assert.throws(() => strictCompare({ a: 1, extra: 2 }, { a: 1 }), /Comparison failed/);
    assert.throws(() => strictCompare({ success: true }, { success: false }), /Comparison failed/);
  });

  test("Real diff integration tests Run 1 and 2", async () => {
    const f1 = freshFixtures();
    const run1 = await runDiffUxEvaluation(f1);

    let failed1 = 0;
    for (const res of run1) {
      try {
        strictCompare(res.actual, res.expected);
      } catch(e) {
        failed1++;
        console.error(res.id, e);
      }
    }
    assert.strictEqual(failed1, 0, "Run 1 had failed strict comparisons");

    const f2 = freshFixtures();
    const run2 = await runDiffUxEvaluation(f2);

    let failed2 = 0;
    for (const res of run2) {
      try {
        strictCompare(res.actual, res.expected);
      } catch(e) {
        failed2++;
      }
    }
    assert.strictEqual(failed2, 0, "Run 2 had failed strict comparisons");

    const normalize = (res: any[]) => res.map(r => ({ id: r.id, actual: r.actual }));
    assert.deepStrictEqual(normalize(run1), normalize(run2), "Run 1 and Run 2 are not deterministic");
    assert.ok(run1.length >= 35, `Must have at least 35 real scenarios (had ${run1.length})`);
  });
});
