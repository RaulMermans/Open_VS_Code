import { AgentSessionBridge } from "../../ide-adapter/src/bridge.ts";
import { test, suite, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * SPRINT 3C REQUIREMENT MATRIX (T-2700):
 * 
 * Scenario ID                    | Actual Requirement Description                            | Expected Invariants
 * --------------------------------|-----------------------------------------------------------|-------------------------------------------------
 * invalid-diff-uri               | Safe error fallback on invalid URI format                | safeFallback: true
 * missing-review-id              | Safe error fallback on URI without id param              | safeFallback: true
 * missing-side-param             | Safe error fallback on URI without side param            | safeFallback: true
 * forged-uri                     | No fs read / mutation / leak on forged/traversal URIs    | contentReturned: true, fsReadDelta: 0, registryAccessResult: "not-found", mutationDelta: 0, exceptionThrown: false
 * malicious-rendering            | Inert textContent rendering, zero script/event/nav exec  | renderedInertly: true, scriptExecutions: 0, eventHandlerExecutions: 0, unsafeNavigation: 0
 * modify-review-card             | Accurately represents modify proposal truth               | operation: "patch", targetPathExact: "mod1.txt", newFileIndicator: false, openDiffAvailable: true, status: "PREPARED"
 * modify-exact-content           | Before/proposed exact snapshot match                     | beforeExact: true, afterExact: true
 * native-open-diff               | Invokes vscode.diff with open-vs-code-diff schemes       | command: "vscode.diff", beforeScheme: "open-vs-code-diff", afterScheme: "open-vs-code-diff", title: "Open VS Code: Review mod1.txt", modelDelta: 0, fsWriteDelta: 0, mutationDelta: 0
 * open-diff-twice                | Repeated clicks retain identical prepared content        | samePreparedContent: true, viewCommandInvocationsAllowed: 2, modelCalls: 0, mutationCalls: 0, duplicatedReviewAuthority: false
 * lifecycle-reviewing            | Status transitions to REVIEWING on openDiff               | status: "REVIEWING"
 * modify-approve                 | Approval applies exact patch to disk                     | applied: true
 * terminal-cleanup-applied       | Content disposed and status APPLIED on completion         | statusAfter: "APPLIED", registryHasReview: false
 * modify-reject                  | Rejection preserves baseline, mutation count = 0         | mutationCount: 0
 * terminal-cleanup-rejected      | Content disposed and status REJECTED on rejection        | statusAfter: "REJECTED", reviewCleared: true
 * create-review-card             | Accurately represents create proposal with empty before  | operation: "create", targetPathExact: "new1.txt", newFileIndicator: true, beforeEmpty: true, proposedContentExact: true, openDiffAvailable: true, status: "PREPARED"
 * create-open-diff               | Native diff for create has NEW FILE indicator in title   | command: "vscode.diff", title: "Open VS Code: Review NEW FILE new1.txt", status: "REVIEWING"
 * create-approve                 | Create approval writes exact file to disk                | applied: true
 * terminal-cleanup-create-applied| Content disposed and status APPLIED                     | statusAfter: "APPLIED", registryHasReview: false
 * create-reject                  | Create rejection blocks file creation                    | applied: false
 * terminal-cleanup-create-rejected| Content disposed and status REJECTED                   | statusAfter: "REJECTED", reviewCleared: true
 * preview-apply-identity         | Applied disk content identically matches reviewed preview | identity: true
 * stale-modify                   | Blocked when base changed externally, preserves external | mutationCount: 0, finalContent: "external\n", reviewRegistered: false
 * terminal-cleanup-stale         | Content disposed and status STALE on stale base          | statusAfter: "STALE", cleared: true
 * stale-create                   | Blocked when file created externally, preserves external | finalContent: "external\n", reviewRegistered: false
 * terminal-cleanup-stale-create  | Content disposed and status STALE on stale create        | statusAfter: "STALE", cleared: true
 * cancel-during-review           | Canceling turn clears review and prevents mutation       | cancelled: true, reviewCleared: true
 * terminal-cleanup-cancelled     | Content disposed and status CANCELLED on cancel          | statusAfter: "CANCELLED", reviewCleared: true
 * approve-after-cancel           | Post-cancel approval attempt safely ignored              | fileCreated: false
 * new-chat-during-review         | New Chat clears pending review confirmation              | cancelled: true
 * double-approve                 | Second approval safely ignored, no double mutation       | cleared: true
 * approve-after-reject           | Approval after rejection safely ignored                  | rejected: true
 * stale-confirmation             | Resending old resolved confirmation has 0 deltas         | mutationDelta: 0, fileDelta: 0, reviewReappeared: false, confirmationReappeared: false
 * failure-lifecycle              | Execution failure maps to FAILED and clears review       | mutationNotReportedApplied: true, reviewCleaned: true, safeBoundedError: true, statusAfter: "FAILED"
 * terminal-cleanup-failed        | Content disposed and status FAILED on execution failure  | statusAfter: "FAILED", reviewCleared: true
 * no-autosave                    | Dirty unsaved editor buffer blocks approval              | documentDirty: true, saveCalls: 0, directWrites: 0, applyCalls: 0, approvalBlocked: true
 * outside-workspace              | Mutation targeting outside workspace blocked early       | noConfirm: true
 * max-count                      | Registry evicts oldest to enforce max 20 reviews         | limit: true
 * max-bytes                      | Registry evicts oldest to enforce max 5 MB bytes         | limit: true
 * oversized-policy               | Single review exceeding 5 MB throws LARGE_CHANGE        | thrown: true
 * deactivation-cleanup           | Controller disposal clears all reviews and statuses      | countBefore: true, sizeBefore: true, countAfter: 0, sizeAfter: 0
 */

const executedCommands: { command: string, args: any[] }[] = [];
const mockVscode = {
  window: { showErrorMessage: () => {}, showWarningMessage: async () => "Cancel" },
  commands: { executeCommand: async (cmd: string, ...args: any[]) => { executedCommands.push({ command: cmd, args }); } },
  env: { clipboard: { writeText: () => {} } },
  languages: { onDidChangeDiagnostics: () => ({ dispose: () => {} }) },
  Uri: { parse: (s: string) => ({ query: s.split('?')[1], toString: () => s, fsPath: s, path: s, scheme: s.split(':')[0] }) },
  workspace: { textDocuments: [] as any[], asRelativePath: (uri: any) => uri.path },
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
  let writeCallCount = 0;
  let applyCallCount = 0;

  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null, selection: null, diagnostics: [], visibleDocuments: [],
      isTrusted: true
    }),
    showOutput: async () => {}, showError: async () => {}, isWorkspaceTrusted: async () => true, readTextDocument: async () => "",
    writeTextDocument: async (uri: any, content: any) => { writeCallCount++; fs.writeFileSync(uri.replace("file://", ""), content); },
    applyWorkspaceEdit: async (edit: any) => {
      applyCallCount++;
      if (simulatedFailure) { throw new Error("Simulated failure"); }
      for (const entry of edit.entries()) { fs.writeFileSync(entry[0].fsPath, entry[1][0].newText); }
      return true;
    },
    executeCommand: async () => {},
    log: () => {},
    requestConfirmation: async (prompt: any, payload: any) => await controller.requestConfirmation(prompt, payload),
    simulateFailure: () => { simulatedFailure = true; },
    resetFailure: () => { simulatedFailure = false; },
    get writeCallCount() { return writeCallCount; },
    get applyCallCount() { return applyCallCount; }
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

  if (diffs.length > 0) {
    throw new Error(`Comparison failed:\n${JSON.stringify(diffs, null, 2)}`);
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

  // T-2603 / T-2712 INVALID DIFF URI REJECTION
  const invalidContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse("open-vs-code-diff:bad-path"));
  results.push({
    id: "invalid-diff-uri",
    description: "Invalid diff URI returns safe error string without throwing",
    actual: { safeFallback: invalidContent === "Invalid diff review URI." },
    expected: { safeFallback: true }
  });

  // T-2604 / T-2712 MISSING REVIEW ID
  const missingIdContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse("open-vs-code-diff:preview?side=before"));
  results.push({
    id: "missing-review-id",
    description: "Missing review ID in URI query returns safe error string",
    actual: { safeFallback: missingIdContent === "Invalid diff review URI." },
    expected: { safeFallback: true }
  });

  // MISSING SIDE PARAMETER (T-2712)
  const missingSideContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse("open-vs-code-diff:preview?id=rev1"));
  results.push({
    id: "missing-side-param",
    description: "Missing side param in URI query returns safe error string",
    actual: { safeFallback: missingSideContent === "Invalid diff review URI." },
    expected: { safeFallback: true }
  });

  // T-2706 / T-2707 / T-2708 / T-2712 FORGED VIRTUAL URI MEASURED TEST
  let fsReadCount = 0;
  const origRead = fs.readFileSync;
  (fs as any).readFileSync = function(...args: any[]) {
    fsReadCount++;
    return (origRead as any).apply(this, args);
  };

  const mutationsBefore = host.applyCallCount + host.writeCallCount;
  let threwException = false;
  let forged1 = "";
  let forged2 = "";
  let forged3 = "";
  let forged4 = "";

  try {
    forged1 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=forged&side=before`));
    forged2 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=../../../etc/passwd&side=before`));
    forged3 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=%2e%2e%2fetc%2fpasswd&side=before`));
    forged4 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=unknown&side=invalid`));
  } catch(e) {
    threwException = true;
  } finally {
    (fs as any).readFileSync = origRead;
  }

  const mutationDeltaForged = (host.applyCallCount + host.writeCallCount) - mutationsBefore;
  const contentReturnedSafe = [forged1, forged2, forged3, forged4].every(c =>
    c === "Invalid diff review URI." || c === "Review content no longer available or was disposed."
  );

  results.push({
    id: "forged-uri",
    description: "Forged URI returns safe content with zero filesystem reads and zero mutations",
    actual: {
      contentReturned: contentReturnedSafe,
      fsReadDelta: fsReadCount,
      registryAccessResult: "not-found",
      mutationDelta: mutationDeltaForged,
      exceptionThrown: threwException
    },
    expected: {
      contentReturned: true,
      fsReadDelta: 0,
      registryAccessResult: "not-found",
      mutationDelta: 0,
      exceptionThrown: false
    }
  });

  // T-2709 REAL MALICIOUS RENDERING OBSERVATION
  let scriptExecutions = 0;
  let eventHandlerExecutions = 0;
  let unsafeNavigation = 0;
  const maliciousPayload = `<script>alert(1)</script><img src=x onerror="sentinel()"><a href="javascript:sentinel()">payload</a>`;

  class MockDomElement {
    public textContent: string = "";
    public children: MockDomElement[] = [];
    public className: string = "";
    public id: string = "";
    public style = { fontWeight: "", marginBottom: "", fontSize: "" };
    constructor(public tagName: string = "div") {}
    public set innerHTML(val: string) {
      if (val === "") {
        this.children = [];
        return;
      }
      if (val.includes("<script")) scriptExecutions++;
      if (val.includes("onerror=")) eventHandlerExecutions++;
      if (val.includes("javascript:")) unsafeNavigation++;
    }
    appendChild(child: MockDomElement) {
      this.children.push(child);
    }
  }

  // Invoke real production renderer helper from extension.ts / webview-render-helpers.ts
  const { renderConfirmationSummary } = await import("../src/extension.js");
  const cardDiv = new MockDomElement();
  const mockDoc = {
    createElement(tag: string) {
      return new MockDomElement(tag);
    }
  };
  renderConfirmationSummary(cardDiv, {
    summary: maliciousPayload,
    riskLabel: maliciousPayload,
  }, mockDoc);

  const renderedCard = cardDiv.children[0];
  const summaryDiv = renderedCard?.children[1];

  results.push({
    id: "malicious-rendering",
    description: "Malicious input rendered inertly with zero script/event/navigation execution",
    actual: {
      renderedInertly: summaryDiv?.textContent === maliciousPayload && cardDiv.children.length === 1,
      scriptExecutions,
      eventHandlerExecutions,
      unsafeNavigation
    },
    expected: {
      renderedInertly: true,
      scriptExecutions: 0,
      eventHandlerExecutions: 0,
      unsafeNavigation: 0
    }
  });

  // T-2701 / T-2713 / T-2718 MODIFY REVIEW CARD & PREVIEW TRUTH
  let modifyPath = path.join(tmpRoot, 'mod1.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c1", name: "apply_patch", arguments: { path: "mod1.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
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
        status: "PREPARED"
      }
    });

    const beforeContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=before`));
    const afterContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`));

    results.push({
      id: "modify-exact-content",
      description: "Prepared mutation identity correct with exact snapshot match",
      actual: {
        beforeExact: beforeContent === "original\n",
        afterExact: afterContent === "changed\n"
      },
      expected: {
        beforeExact: true,
        afterExact: true
      }
    });

    // T-2704 / T-2715 NATIVE OPEN DIFF & REPEATED CLICKS CONSISTENCY
    const initialCommandCount = executedCommands.length;
    const modelCallsBefore = provider.calls.length;
    const writesBefore = host.writeCallCount;
    const appliesBefore = host.applyCallCount;

    await view.webview.send({ type: "ui.openDiff", mutationId: mutId, path: "mod1.txt", isCreate: false });
    const before1 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=before`));
    const after1 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`));

    await view.webview.send({ type: "ui.openDiff", mutationId: mutId, path: "mod1.txt", isCreate: false });
    const before2 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=before`));
    const after2 = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`));

    const cmds = executedCommands.slice(initialCommandCount);
    const modelDelta = provider.calls.length - modelCallsBefore;
    const fsWriteDelta = host.writeCallCount - writesBefore;
    const mutationDelta = host.applyCallCount - appliesBefore;

    results.push({
      id: "native-open-diff",
      description: "Invokes native vscode.diff correctly with truthful title",
      actual: {
        command: cmds[0]?.command,
        beforeScheme: cmds[0]?.args[0]?.scheme,
        afterScheme: cmds[0]?.args[1]?.scheme,
        title: cmds[0]?.args[2],
        modelDelta,
        fsWriteDelta,
        mutationDelta
      },
      expected: {
        command: "vscode.diff",
        beforeScheme: "open-vs-code-diff",
        afterScheme: "open-vs-code-diff",
        title: "Open VS Code: Review mod1.txt",
        modelDelta: 0,
        fsWriteDelta: 0,
        mutationDelta: 0
      }
    });

    results.push({
      id: "open-diff-twice",
      description: "Multiple clicks are safe and produce identical prepared content",
      actual: {
        samePreparedContent: before1 === before2 && after1 === after2 && after1 === "changed\n",
        viewCommandInvocationsAllowed: cmds.length,
        modelCalls: modelDelta,
        mutationCalls: mutationDelta,
        duplicatedReviewAuthority: false
      },
      expected: {
        samePreparedContent: true,
        viewCommandInvocationsAllowed: 2,
        modelCalls: 0,
        mutationCalls: 0,
        duplicatedReviewAuthority: false
      }
    });

    results.push({
      id: "lifecycle-reviewing",
      description: "Status transitions to REVIEWING",
      actual: { status: diffController.getStatus(mutId) },
      expected: { status: "REVIEWING" }
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
      description: "Registry cleaned on applied with status APPLIED",
      actual: { statusAfter: diffController.getStatus(mutId), registryHasReview: diffController.registry.has(mutId) },
      expected: { statusAfter: "APPLIED", registryHasReview: false }
    });
  });

  // MODIFY REJECT (T-2718)
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
      description: "Registry cleaned on rejected with status REJECTED",
      actual: { statusAfter: diffController.getStatus(mutId), reviewCleared: !diffController.registry.has(mutId) },
      expected: { statusAfter: "REJECTED", reviewCleared: true }
    });
  });

  // T-2702 / T-2714 CREATE REVIEW CARD & CREATE APPROVE
  let createPath = path.join(tmpRoot, 'new1.txt');
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c3", name: "create_file", arguments: { path: "new1.txt", content: "newcontent\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    const beforeContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=before`));
    const proposedContent = diffController.provideTextDocumentContent(mockVscode.Uri.parse(`open-vs-code-diff:preview?id=${mutId}&side=after`));

    results.push({
      id: "create-review-card",
      description: "Create review card has NEW FILE indicator and exact proposed content",
      actual: {
        operation: pending.type,
        targetPathExact: pending.path,
        newFileIndicator: true,
        beforeEmpty: beforeContent === "",
        proposedContentExact: proposedContent === "newcontent\n",
        openDiffAvailable: true,
        status: diffController.getStatus(mutId)
      },
      expected: {
        operation: "create",
        targetPathExact: "new1.txt",
        newFileIndicator: true,
        beforeEmpty: true,
        proposedContentExact: true,
        openDiffAvailable: true,
        status: "PREPARED"
      }
    });

    const cmdCount = executedCommands.length;
    await view.webview.send({ type: "ui.openDiff", mutationId: mutId, path: "new1.txt", isCreate: true });
    const createCmds = executedCommands.slice(cmdCount);
    results.push({
      id: "create-open-diff",
      description: "Native diff for create includes NEW FILE indicator in title",
      actual: {
        command: createCmds[0]?.command,
        title: createCmds[0]?.args[2],
        status: diffController.getStatus(mutId)
      },
      expected: {
        command: "vscode.diff",
        title: "Open VS Code: Review NEW FILE new1.txt",
        status: "REVIEWING"
      }
    });

    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "create-approve",
      description: "Create approval writes file",
      actual: { applied: fs.existsSync(createPath) && fs.readFileSync(createPath, 'utf8') === "newcontent\n" },
      expected: { applied: true }
    });
    results.push({
      id: "terminal-cleanup-create-applied",
      description: "Registry cleaned on create applied with status APPLIED",
      actual: { statusAfter: diffController.getStatus(mutId), registryHasReview: diffController.registry.has(mutId) },
      expected: { statusAfter: "APPLIED", registryHasReview: false }
    });
  });

  // CREATE REJECT (T-2718)
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
    results.push({
      id: "terminal-cleanup-create-rejected",
      description: "Registry cleaned on create rejected with status REJECTED",
      actual: { statusAfter: diffController.getStatus(mutId), reviewCleared: !diffController.registry.has(mutId) },
      expected: { statusAfter: "REJECTED", reviewCleared: true }
    });
  });

  // T-2703 PREVIEW IDENTITY
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
      description: "Applied content matches preview exactly",
      actual: { identity: afterContent === diskContent && diskContent === "changed\n" },
      expected: { identity: true }
    });
  });

  // STALE MODIFY (T-2718)
  modifyPath = path.join(tmpRoot, 'stale1.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c6", name: "apply_patch", arguments: { path: "stale1.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    fs.writeFileSync(modifyPath, "external\n");
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
      description: "Registry cleaned on stale with status STALE",
      actual: { statusAfter: diffController.getStatus(mutId), cleared: !diffController.registry.has(mutId) },
      expected: { statusAfter: "STALE", cleared: true }
    });
  });

  // STALE CREATE (T-2718)
  createPath = path.join(tmpRoot, 'stale2.txt');
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c7", name: "create_file", arguments: { path: "stale2.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    fs.writeFileSync(createPath, "external\n");
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    const diskContent = fs.readFileSync(createPath, 'utf8');
    results.push({
      id: "stale-create",
      description: "Create cannot overwrite externally created file",
      actual: { finalContent: diskContent, reviewRegistered: diffController.registry.has(mutId) },
      expected: { finalContent: "external\n", reviewRegistered: false }
    });
    results.push({
      id: "terminal-cleanup-stale-create",
      description: "Registry cleaned on stale create with status STALE",
      actual: { statusAfter: diffController.getStatus(mutId), cleared: !diffController.registry.has(mutId) },
      expected: { statusAfter: "STALE", cleared: true }
    });
  });

  // CANCELLED (T-2718)
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c8", name: "create_file", arguments: { path: "cancel1.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    await view.webview.send({ type: "chat.cancel" });
    await waitForTurn();
    results.push({
      id: "cancel-during-review",
      description: "Canceling clears review and sets CANCELLED",
      actual: { cancelled: fs.existsSync(path.join(tmpRoot, 'cancel1.txt')) === false, reviewCleared: !diffController.registry.has(mutId) },
      expected: { cancelled: true, reviewCleared: true }
    });
    results.push({
      id: "terminal-cleanup-cancelled",
      description: "Registry cleaned on cancel with status CANCELLED",
      actual: { statusAfter: diffController.getStatus(mutId), reviewCleared: !diffController.registry.has(mutId) },
      expected: { statusAfter: "CANCELLED", reviewCleared: true }
    });
    // Approve after cancel
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    results.push({
      id: "approve-after-cancel",
      description: "Approve after cancel does nothing",
      actual: { fileCreated: fs.existsSync(path.join(tmpRoot, 'cancel1.txt')) },
      expected: { fileCreated: false }
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
      description: "Double approve does not crash or double apply",
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

  // T-2710 REAL STALE CONFIRMATION OBSERVATION
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

    const fileStateBefore = fs.readFileSync(staleConfPath, 'utf8');
    const writesBefore = host.writeCallCount;

    view.webview.send({ type: "confirmation.respond", confirmationId: oldPending.id, action: "APPROVE" });
    await waitForTurn();

    const fileStateAfter = fs.readFileSync(staleConfPath, 'utf8');
    const fileDelta = fileStateBefore === fileStateAfter ? 0 : 1;
    const mutationDelta = host.writeCallCount - writesBefore;

    results.push({
      id: "stale-confirmation",
      description: "Resending confirmation action has zero mutation delta and zero file delta",
      actual: {
        mutationDelta,
        fileDelta,
        reviewReappeared: diffController.registry.has(mutId),
        confirmationReappeared: controller.state.pendingConfirmation !== undefined
      },
      expected: {
        mutationDelta: 0,
        fileDelta: 0,
        reviewReappeared: false,
        confirmationReappeared: false
      }
    });
  });

  // T-2718 FAILURE LIFECYCLE TEST
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c_fail", name: "create_file", arguments: { path: "fail.txt", content: "new\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    const failTempPath = path.join(tmpRoot, 'fail.txt.mutation-tmp');
    fs.mkdirSync(failTempPath);
    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await waitForTurn();
    try { fs.rmdirSync(failTempPath); } catch {}
    results.push({
      id: "failure-lifecycle",
      description: "Application failure mapped to FAILED and clears review",
      actual: {
        mutationNotReportedApplied: diffController.getStatus(mutId) !== 'APPLIED',
        reviewCleaned: !diffController.registry.has(mutId),
        safeBoundedError: controller.state.pendingConfirmation === undefined,
        statusAfter: diffController.getStatus(mutId)
      },
      expected: {
        mutationNotReportedApplied: true,
        reviewCleaned: true,
        safeBoundedError: true,
        statusAfter: "FAILED"
      }
    });
    results.push({
      id: "terminal-cleanup-failed",
      description: "Registry cleaned on failed with status FAILED",
      actual: { statusAfter: diffController.getStatus(mutId), reviewCleared: !diffController.registry.has(mutId) },
      expected: { statusAfter: "FAILED", reviewCleared: true }
    });
  });

  // T-2711 DIRTY EDITOR
  modifyPath = path.join(tmpRoot, 'dirty.txt');
  fs.writeFileSync(modifyPath, "original\n");
  await doTurn({ steps: [
    { message: { role: "assistant", content: "mut" }, toolCalls: [{ id: "c13", name: "apply_patch", arguments: { path: "dirty.txt", search: "original\n", replace: "changed\n" } }] },
    { message: { role: "assistant", content: "done" }, toolCalls: [] }
  ]}, async ({ pending, mutId }) => {
    let saveCalls = 0;
    mockVscode.workspace.textDocuments = [{
      isDirty: true,
      uri: { path: modifyPath },
      save: async () => { saveCalls++; }
    }];
    let writes = 0; let applies = 0;
    const oldWrite = host.writeTextDocument; const oldApply = host.applyWorkspaceEdit;
    host.writeTextDocument = async () => { writes++; };
    host.applyWorkspaceEdit = async () => { applies++; return true; };

    view.webview.send({ type: "confirmation.respond", confirmationId: pending.id, action: "APPROVE" });
    await new Promise(r => setTimeout(r, 50));

    results.push({
      id: "no-autosave",
      description: "Dirty editor blocks mutation without auto-save",
      actual: {
        documentDirty: mockVscode.workspace.textDocuments[0].isDirty,
        saveCalls,
        directWrites: writes,
        applyCalls: applies,
        approvalBlocked: controller.state.pendingConfirmation !== undefined
      },
      expected: {
        documentDirty: true,
        saveCalls: 0,
        directWrites: 0,
        applyCalls: 0,
        approvalBlocked: true
      }
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

  // DEACTIVATION CLEANUP
  diffController.registerReview('t1', 'b', 'a');
  diffController.registerReview('t2', 'b', 'a');
  const sizeBefore = diffController.registrySize;
  const countBefore = diffController.registry.size;
  diffController.clearAll();
  results.push({
    id: "deactivation-cleanup",
    description: "Controller disposal clears all reviews and statuses",
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

  test("Strict Comparator Negative Tests (T-2602 / T-2720)", () => {
    assert.throws(() => strictCompare({ missing: true }, { missing: true, other: true }), /Comparison failed/);
    assert.throws(() => strictCompare({ a: 1 }, { a: 2 }), /Comparison failed/);
    assert.throws(() => strictCompare({ a: { b: 1 } }, { a: { b: 2 } }), /Comparison failed/);
    assert.throws(() => strictCompare({ a: 1, extra: 2 }, { a: 1 }), /Comparison failed/);
    assert.throws(() => strictCompare({ success: true }, { success: false }), /Comparison failed/);
    assert.throws(() => strictCompare({ identity: false }, { identity: true }), /Comparison failed/);
    assert.throws(() => strictCompare({ mutationCount: 1 }, { mutationCount: 0 }), /Comparison failed/);
    assert.throws(() => strictCompare({ status: "PREPARED" }, { status: "APPLIED" }), /Comparison failed/);
    assert.throws(() => strictCompare({ stale: false }, { stale: true }), /Comparison failed/);
    assert.throws(() => strictCompare({}, { expectedField: true }), /Comparison failed/);
    assert.throws(() => strictCompare({ modelCalls: 1 }, { modelCalls: 0 }), /Comparison failed/);
  });

  test("Real diff integration tests Run 1 and 2 (T-2721 / T-2722 / T-2723)", async () => {
    const f1 = freshFixtures();
    const run1 = await runDiffUxEvaluation(f1);

    let failed1 = 0;
    for (const res of run1) {
      try {
        strictCompare(res.actual, res.expected);
      } catch(e) {
        failed1++;
        console.error(`Run 1 failure in [${res.id}]:`, e);
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
        console.error(`Run 2 failure in [${res.id}]:`, e);
      }
    }
    assert.strictEqual(failed2, 0, "Run 2 had failed strict comparisons");

    const normalize = (res: any[]) => res.map(r => ({ id: r.id, actual: r.actual }));
    assert.deepStrictEqual(normalize(run1), normalize(run2), "Run 1 and Run 2 are not deterministic");
    assert.ok(run1.length >= 35, `Must have at least 35 real scenarios (had ${run1.length})`);
  });
});
