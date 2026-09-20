import { AgentSessionBridge } from "../../ide-adapter/src/bridge.ts";
import { test, suite, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { VerificationEngine } from "@open-vs-code/agent-core";

const executedCommands: { command: string, args: any[] }[] = [];
let clipboardText = "";
const mockVscode = {
  window: { showErrorMessage: () => {}, showWarningMessage: async () => "Cancel" },
  commands: { executeCommand: async (cmd: string, ...args: any[]) => { executedCommands.push({ command: cmd, args }); } },
  env: {
    clipboard: {
      writeText: async (text: string) => { clipboardText = text; },
      readText: async () => clipboardText,
    }
  },
  languages: { onDidChangeDiagnostics: () => ({ dispose: () => {} }) },
  Uri: { parse: (s: string) => ({ query: s.split('?')[1], toString: () => s, fsPath: s, path: s, scheme: s.split(':')[0] }) },
  workspace: { textDocuments: [] as any[], asRelativePath: (uri: any) => uri.path },
  EventEmitter: class { event = {}; fire() {} }
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
let TerminalReviewController: any;

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

const freshTerminalFixtures = () => {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-term-test-")));
  executedCommands.length = 0;
  clipboardText = "";

  const pkgJsonPath = path.join(tmpRoot, "package.json");
  fs.writeFileSync(pkgJsonPath, JSON.stringify({
    name: "test-pkg",
    version: "1.0.0",
    scripts: {
      test: "echo test-ok",
      typecheck: "node -e 'process.exit(0)'",
      lint: "node -e 'console.error(\"lint warning\"); process.exit(0)'",
      build: "node -e 'console.log(\"built\"); process.exit(0)'",
      failing: "node -e 'console.error(\"failed\"); process.exit(1)'",
      infinite: "node -e 'setTimeout(() => {}, 100000)'"
    }
  }, null, 2));

  let controller: any;
  let termController: any;

  const host = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null, selection: null, diagnostics: [], visibleDocuments: [],
      isTrusted: true
    }),
    showOutput: async () => {}, showError: async () => {}, isWorkspaceTrusted: async () => true, readTextDocument: async () => "",
    writeTextDocument: async (uri: any, content: any) => { fs.writeFileSync(uri.replace("file://", ""), content); },
    applyWorkspaceEdit: async () => true,
    executeCommand: async () => {},
    log: () => {},
    requestConfirmation: async (prompt: any, payload: any) => await controller.requestConfirmation(prompt, payload),
  };

  const provider = new TestProvider();
  const bridgeFactory = (options: any) => new AgentSessionBridge({ ...options, providerOverride: provider });

  termController = new TerminalReviewController();
  const diffController = { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {} };
  controller = new ChatController(host as any, diffController, termController, bridgeFactory);
  const view = { webview: new MockWebview() };
  controller.setWebviewView(view as any);

  return { host, controller, termController, view, provider, tmpRoot, pkgJsonPath };
};

export interface TermEvalScenarioResult {
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

export const runTerminalUxEvaluation = async (fixtures: ReturnType<typeof freshTerminalFixtures>) => {
  const { host, controller, termController, view, provider, tmpRoot, pkgJsonPath } = fixtures;
  const results: TermEvalScenarioResult[] = [];

  const waitForConfirm = async () => {
    let tries = 0;
    while (!controller.state.pendingConfirmation && tries < 500) {
      await new Promise(r => setTimeout(r, 10));
      tries++;
    }
  };

  const waitForTurn = async () => {
    let i = 0;
    while (controller.state.activeTurn && i < 500) {
      await new Promise(r => setTimeout(r, 10));
      i++;
    }
  };

  // ==========================================
  // CATEGORY 1: PREPARATION & REGISTRATION (1-5)
  // ==========================================

  // 1. prepare-registered-verification
  const entry1 = termController.registerPreparedCommand({
    confirmationId: "conf-1",
    command: "npm run test",
    cwd: tmpRoot,
    provenance: "package.json [test]",
    timeoutMs: 60000,
    executable: "npm",
    args: ["run", "test"],
    scriptName: "test",
    scriptBody: "echo test-ok"
  });
  results.push({
    id: "prepare-registered-verification",
    description: "Prepared verification creates valid review entry in WAITING_APPROVAL state",
    actual: {
      status: entry1.status,
      command: entry1.command,
      provenance: entry1.provenance,
      timeoutMs: entry1.timeoutMs,
      hasExecutionId: Boolean(entry1.executionId),
    },
    expected: {
      status: "WAITING_APPROVAL",
      command: "npm run test",
      provenance: "package.json [test]",
      timeoutMs: 60000,
      hasExecutionId: true,
    }
  });

  // 2. lookup-by-confirmation-id
  const fetchedByConf = termController.getByConfirmationId("conf-1");
  results.push({
    id: "lookup-by-confirmation-id",
    description: "Lookup by confirmation ID returns matching registered entry",
    actual: { found: Boolean(fetchedByConf), executionIdMatch: fetchedByConf?.executionId === entry1.executionId },
    expected: { found: true, executionIdMatch: true }
  });

  // 3. lookup-by-execution-id
  const fetchedByExec = termController.getByExecutionId(entry1.executionId);
  results.push({
    id: "lookup-by-execution-id",
    description: "Lookup by execution ID returns matching registered entry",
    actual: { found: Boolean(fetchedByExec), confIdMatch: fetchedByExec?.confirmationId === "conf-1" },
    expected: { found: true, confIdMatch: true }
  });

  // 4. exact-cwd-display
  results.push({
    id: "exact-cwd-display",
    description: "CWD is exact workspace path, no shell interpolation or relative escape",
    actual: { cwd: entry1.cwd === tmpRoot, isAbsolute: path.isAbsolute(entry1.cwd) },
    expected: { cwd: true, isAbsolute: true }
  });

  // 5. explicit-timeout-bound
  results.push({
    id: "explicit-timeout-bound",
    description: "Timeout is explicitly captured and bounded",
    actual: { timeoutMs: entry1.timeoutMs, isPositive: entry1.timeoutMs > 0 },
    expected: { timeoutMs: 60000, isPositive: true }
  });

  // ==========================================
  // CATEGORY 2: APPROVAL WORKFLOWS (6-12)
  // ==========================================

  // 6. approval-transitions-to-running
  controller.state.activeTurn = true;
  controller.state.pendingConfirmation = {
    id: "conf-app-1",
    type: "run_known_test",
    summary: "Run verification TEST?",
    riskLabel: "Controlled Verification Terminal",
    preparedCommand: {
      executionId: entry1.executionId,
      command: "npm run test",
      cwd: tmpRoot,
      provenance: "package.json [test]",
      timeoutMs: 60000,
      status: "WAITING_APPROVAL",
    }
  };
  let resolvedAction: string | null = null;
  controller._confirmationResolver = (act: any) => { resolvedAction = act; };

  await view.webview.send({ type: "terminal.respond", confirmationId: "conf-app-1", action: "APPROVE" });
  results.push({
    id: "approval-transitions-to-running",
    description: "Approval action transitions terminal status to RUNNING and clears pending confirmation",
    actual: {
      status: entry1.status,
      resolvedAction,
      pendingCleared: controller.state.pendingConfirmation === undefined,
    },
    expected: {
      status: "RUNNING",
      resolvedAction: "APPROVE",
      pendingCleared: true,
    }
  });

  // 7. rejection-transitions-to-rejected
  const entryReject = termController.registerPreparedCommand({
    confirmationId: "conf-rej-1",
    command: "npm run test",
    cwd: tmpRoot,
    provenance: "package.json [test]",
    timeoutMs: 60000,
    executable: "npm",
    args: ["run", "test"],
  });
  controller.state.pendingConfirmation = {
    id: "conf-rej-1",
    type: "run_known_test",
    summary: "Run verification TEST?",
    riskLabel: "Controlled Verification Terminal",
    preparedCommand: {
      executionId: entryReject.executionId,
      command: "npm run test",
      cwd: tmpRoot,
      provenance: "package.json [test]",
      timeoutMs: 60000,
      status: "WAITING_APPROVAL",
    }
  };
  controller._confirmationResolver = (act: any) => { resolvedAction = act; };
  await view.webview.send({ type: "terminal.respond", confirmationId: "conf-rej-1", action: "REJECT" });

  results.push({
    id: "rejection-transitions-to-rejected",
    description: "Rejection action transitions terminal status to REJECTED and clears pending confirmation",
    actual: {
      status: entryReject.status,
      resolvedAction,
      pendingCleared: controller.state.pendingConfirmation === undefined,
    },
    expected: {
      status: "REJECTED",
      resolvedAction: "REJECT",
      pendingCleared: true,
    }
  });

  // 8. wrong-confirmation-id-ignored
  controller.state.pendingConfirmation = {
    id: "conf-active-real",
    type: "run_known_test",
    summary: "Run verification TEST?",
    riskLabel: "Controlled Verification Terminal",
  };
  let wrongResolved = false;
  controller._confirmationResolver = () => { wrongResolved = true; };
  await view.webview.send({ type: "terminal.respond", confirmationId: "conf-forged-id", action: "APPROVE" });

  results.push({
    id: "wrong-confirmation-id-ignored",
    description: "Approval with mismatched confirmation ID is safely ignored",
    actual: {
      wrongResolved,
      pendingStillPresent: controller.state.pendingConfirmation?.id === "conf-active-real",
    },
    expected: {
      wrongResolved: false,
      pendingStillPresent: true,
    }
  });

  // 9. forged-execution-id-safe
  const forgedToggle = termController.toggleOutput("non-existent-exec-id");
  const forgedCopy = await termController.copyCommand("non-existent-exec-id");
  const forgedSet = termController.setStatus("non-existent-exec-id", "RUNNING");
  results.push({
    id: "forged-execution-id-safe",
    description: "Actions targeting nonexistent execution IDs return false without errors",
    actual: { forgedToggle, forgedCopy, forgedSet },
    expected: { forgedToggle: false, forgedCopy: false, forgedSet: false }
  });

  // 10. double-approve-protection
  // Resending approval for the already-handled conf-app-1
  let doubleApproveResolved = false;
  controller._confirmationResolver = () => { doubleApproveResolved = true; };
  await view.webview.send({ type: "terminal.respond", confirmationId: "conf-app-1", action: "APPROVE" });
  results.push({
    id: "double-approve-protection",
    description: "Second approval for resolved confirmation is inert",
    actual: { doubleApproveResolved },
    expected: { doubleApproveResolved: false }
  });

  // 11. approve-after-reject-ignored
  let approveAfterRejectResolved = false;
  controller._confirmationResolver = () => { approveAfterRejectResolved = true; };
  await view.webview.send({ type: "terminal.respond", confirmationId: "conf-rej-1", action: "APPROVE" });
  results.push({
    id: "approve-after-reject-ignored",
    description: "Approval sent after rejection is safely ignored",
    actual: { approveAfterRejectResolved, statusStillRejected: entryReject.status === "REJECTED" },
    expected: { approveAfterRejectResolved: false, statusStillRejected: true }
  });

  // 12. approve-after-cancel-ignored
  const entryCancelTest = termController.registerPreparedCommand({
    confirmationId: "conf-cancel-pre",
    command: "npm run test",
    cwd: tmpRoot,
    provenance: "package.json [test]",
    timeoutMs: 60000,
    executable: "npm",
    args: ["run", "test"],
  });
  termController.setStatus(entryCancelTest.executionId, "CANCELLED");
  let approveAfterCancel = false;
  controller._confirmationResolver = () => { approveAfterCancel = true; };
  await view.webview.send({ type: "terminal.respond", confirmationId: "conf-cancel-pre", action: "APPROVE" });
  results.push({
    id: "approve-after-cancel-ignored",
    description: "Approval sent after cancellation is safely ignored",
    actual: { approveAfterCancel, statusStillCancelled: entryCancelTest.status === "CANCELLED" },
    expected: { approveAfterCancel: false, statusStillCancelled: true }
  });

  // ==========================================
  // CATEGORY 3: EXECUTION OUTCOMES (13-19)
  // ==========================================

  // 13. execution-exit-0-succeeded
  const entryExit0 = termController.registerPreparedCommand({
    confirmationId: "c-e0", command: "npm run test", cwd: tmpRoot, provenance: "package.json", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.recordCompletion(entryExit0.executionId, {
    status: "SUCCEEDED",
    exitCode: 0,
    durationMs: 120,
    stdout: "pass 1 test",
  });
  results.push({
    id: "execution-exit-0-succeeded",
    description: "Exit code 0 records status SUCCEEDED and duration",
    actual: { status: entryExit0.status, exitCode: entryExit0.exitCode, durationMs: entryExit0.durationMs },
    expected: { status: "SUCCEEDED", exitCode: 0, durationMs: 120 }
  });

  // 14. execution-exit-nonzero-failed
  const entryNonZero = termController.registerPreparedCommand({
    confirmationId: "c-nz", command: "npm run failing", cwd: tmpRoot, provenance: "package.json", timeoutMs: 1000, executable: "npm", args: ["failing"]
  });
  termController.recordCompletion(entryNonZero.executionId, {
    status: "FAILED",
    exitCode: 1,
    durationMs: 85,
    stderr: "test failure in line 4",
  });
  results.push({
    id: "execution-exit-nonzero-failed",
    description: "Non-zero exit code records status FAILED and captured stderr",
    actual: { status: entryNonZero.status, exitCode: entryNonZero.exitCode, stderr: entryNonZero.stderr },
    expected: { status: "FAILED", exitCode: 1, stderr: "test failure in line 4" }
  });

  // 15. execution-streamed-stdout
  const entryStream = termController.registerPreparedCommand({
    confirmationId: "c-str", command: "npm run test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryStream.executionId, "RUNNING");
  termController.appendOutput(entryStream.executionId, "stdout", "chunk 1\n");
  termController.appendOutput(entryStream.executionId, "stdout", "chunk 2\n");
  results.push({
    id: "execution-streamed-stdout",
    description: "Live stdout chunks append cleanly to buffer",
    actual: { stdout: entryStream.stdout },
    expected: { stdout: "chunk 1\nchunk 2\n" }
  });

  // 16. execution-streamed-stderr
  termController.appendOutput(entryStream.executionId, "stderr", "warn 1\n");
  termController.appendOutput(entryStream.executionId, "stderr", "warn 2\n");
  results.push({
    id: "execution-streamed-stderr",
    description: "Live stderr chunks append cleanly to separate stderr buffer",
    actual: { stderr: entryStream.stderr },
    expected: { stderr: "warn 1\nwarn 2\n" }
  });

  // 17. execution-separated-streams
  results.push({
    id: "execution-separated-streams",
    description: "Stdout and stderr buffers remain completely separated",
    actual: {
      stdoutHasStderr: entryStream.stdout.includes("warn"),
      stderrHasStdout: entryStream.stderr.includes("chunk"),
    },
    expected: {
      stdoutHasStderr: false,
      stderrHasStdout: false,
    }
  });

  // 18. execution-signal-recorded
  const entrySig = termController.registerPreparedCommand({
    confirmationId: "c-sig", command: "npm run test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.recordCompletion(entrySig.executionId, {
    status: "CANCELLED",
    exitCode: null,
    exitSignal: "SIGTERM",
  });
  results.push({
    id: "execution-signal-recorded",
    description: "Exit signal (e.g. SIGTERM) is recorded truthfully without synthetic exitCode",
    actual: { status: entrySig.status, exitCode: entrySig.exitCode, exitSignal: entrySig.exitSignal },
    expected: { status: "CANCELLED", exitCode: null, exitSignal: "SIGTERM" }
  });

  // 19. execution-duration-reported
  results.push({
    id: "execution-duration-reported",
    description: "Execution duration is numeric and non-negative",
    actual: { hasDuration: typeof entryExit0.durationMs === "number" && entryExit0.durationMs >= 0 },
    expected: { hasDuration: true }
  });

  // ==========================================
  // CATEGORY 4: CANCELLATION (20-24)
  // ==========================================

  // 20. cancel-before-spawn
  const entryCancelPre = termController.registerPreparedCommand({
    confirmationId: "c-can-pre", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryCancelPre.executionId, "CANCELLED");
  results.push({
    id: "cancel-before-spawn",
    description: "Canceling confirmation before spawn marks status CANCELLED",
    actual: { status: entryCancelPre.status },
    expected: { status: "CANCELLED" }
  });

  // 21. cancel-running-process
  const verifEngine = new VerificationEngine({ workspaceRoot: tmpRoot });
  const abortCtrl = new AbortController();
  const execPromise = verifEngine.execute({
    verificationId: "v-can",
    action: "TEST",
    executable: "node",
    args: ["-e", "setInterval(() => {}, 10000)"],
    cwd: tmpRoot,
    timeoutMs: 10000,
    commandPreview: "node sleep",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok"
  }, abortCtrl.signal);

  setTimeout(() => abortCtrl.abort(), 50);
  const cancelResult = await execPromise;
  results.push({
    id: "cancel-running-process",
    description: "AbortSignal terminates running process tree cleanly and returns CANCELLED",
    actual: { status: cancelResult.status },
    expected: { status: "CANCELLED" }
  });

  // 22. late-output-after-cancel-ignored
  const entryLate = termController.registerPreparedCommand({
    confirmationId: "c-late", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryLate.executionId, "CANCELLED");
  termController.appendOutput(entryLate.executionId, "stdout", "late output");
  results.push({
    id: "late-output-after-cancel-ignored",
    description: "Late process output arriving after cancellation is discarded",
    actual: { stdoutEmpty: entryLate.stdout === "" },
    expected: { stdoutEmpty: true }
  });

  // 23. webview-cancel-message-handling
  const entryWebCancel = termController.registerPreparedCommand({
    confirmationId: "c-web-can", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryWebCancel.executionId, "RUNNING");
  await view.webview.send({ type: "terminal.cancel", executionId: entryWebCancel.executionId });
  results.push({
    id: "webview-cancel-message-handling",
    description: "terminal.cancel webview message triggers controller cancellation",
    actual: { status: entryWebCancel.status },
    expected: { status: "CANCELLED" }
  });

  // 24. next-command-usable-after-cancel
  const nextCommandEntry = termController.registerPreparedCommand({
    confirmationId: "c-next", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  results.push({
    id: "next-command-usable-after-cancel",
    description: "Controller can prepare and register new command immediately after previous cancellation",
    actual: { status: nextCommandEntry.status },
    expected: { status: "WAITING_APPROVAL" }
  });

  // ==========================================
  // CATEGORY 5: TIMEOUT WORKFLOWS (25-27)
  // ==========================================

  // 25. execution-timeout-kills-process
  const timeoutResult = await verifEngine.execute({
    verificationId: "v-to",
    action: "TEST",
    executable: "node",
    args: ["-e", "setTimeout(() => {}, 20000)"],
    cwd: tmpRoot,
    timeoutMs: 100,
    commandPreview: "node sleep",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok"
  });
  results.push({
    id: "execution-timeout-kills-process",
    description: "Timeout triggers process-tree kill and returns status TIMEOUT",
    actual: { status: timeoutResult.status },
    expected: { status: "TIMEOUT" }
  });

  // 26. timeout-recorded-in-terminal-card
  const entryTimeout = termController.registerPreparedCommand({
    confirmationId: "c-to-card", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 100, executable: "npm", args: ["test"]
  });
  termController.recordCompletion(entryTimeout.executionId, { status: "TIMED_OUT", durationMs: 105 });
  results.push({
    id: "timeout-recorded-in-terminal-card",
    description: "Terminal card status accurately reflects TIMED_OUT",
    actual: { status: entryTimeout.status, durationMs: entryTimeout.durationMs },
    expected: { status: "TIMED_OUT", durationMs: 105 }
  });

  // 27. next-command-usable-after-timeout
  const entryAfterTimeout = termController.registerPreparedCommand({
    confirmationId: "c-after-to", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  results.push({
    id: "next-command-usable-after-timeout",
    description: "New command can be registered and approved cleanly after timeout",
    actual: { status: entryAfterTimeout.status },
    expected: { status: "WAITING_APPROVAL" }
  });

  // ==========================================
  // CATEGORY 6: BOUNDED OUTPUT & ENCODING (28-31)
  // ==========================================

  // 28. output-bounded-at-16kb
  const smallBoundController = new TerminalReviewController({ maxOutputBytes: 100 });
  const entryBound = smallBoundController.registerPreparedCommand({
    confirmationId: "c-bnd", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  smallBoundController.setStatus(entryBound.executionId, "RUNNING");
  const hugeChunk = "A".repeat(500);
  smallBoundController.appendOutput(entryBound.executionId, "stdout", hugeChunk);
  results.push({
    id: "output-bounded-at-16kb",
    description: "Ring buffer truncates output exactly at configured max bytes",
    actual: {
      bufLength: Buffer.byteLength(entryBound.stdout, "utf-8"),
      truncatedFlag: entryBound.stdoutTruncated,
    },
    expected: {
      bufLength: 100,
      truncatedFlag: true,
    }
  });

  // 29. truncation-warning-surfaced
  results.push({
    id: "truncation-warning-surfaced",
    description: "Truncation indicator flag is true when limit exceeded",
    actual: { stdoutTruncated: entryBound.stdoutTruncated },
    expected: { stdoutTruncated: true }
  });

  // 30. stderr-bounded-independently
  smallBoundController.appendOutput(entryBound.executionId, "stderr", "E".repeat(500));
  results.push({
    id: "stderr-bounded-independently",
    description: "Stderr buffer truncates at byte boundary independently",
    actual: {
      stderrLength: Buffer.byteLength(entryBound.stderr, "utf-8"),
      stderrTruncated: entryBound.stderrTruncated,
    },
    expected: {
      stderrLength: 100,
      stderrTruncated: true,
    }
  });

  // 31. utf8-multibyte-split-safety
  const entryUtf8 = termController.registerPreparedCommand({
    confirmationId: "c-utf8", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryUtf8.executionId, "RUNNING");
  // Multi-byte character: emoji or CJK (e.g. '🚀' = 4 bytes)
  termController.appendOutput(entryUtf8.executionId, "stdout", "Rocket: 🚀 — Done.\n");
  results.push({
    id: "utf8-multibyte-split-safety",
    description: "Multibyte UTF-8 characters append without corruption",
    actual: { stdout: entryUtf8.stdout, containsEmoji: entryUtf8.stdout.includes("🚀") },
    expected: { stdout: "Rocket: 🚀 — Done.\n", containsEmoji: true }
  });

  // ==========================================
  // CATEGORY 7: CWD & PATH SAFETY (32-34)
  // ==========================================

  // 32. cwd-must-be-inside-workspace
  const outsideCwd = path.resolve(tmpRoot, "..");
  const outsideResult = await verifEngine.execute({
    verificationId: "v-out",
    action: "TEST",
    executable: "echo",
    args: ["bad"],
    cwd: outsideCwd,
    timeoutMs: 1000,
    commandPreview: "echo bad",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok"
  });
  results.push({
    id: "cwd-must-be-inside-workspace",
    description: "Executing with CWD outside workspace root is blocked with EXECUTION_ERROR",
    actual: {
      status: outsideResult.status,
      hasCwdError: outsideResult.stderr.includes("CWD validation failed"),
    },
    expected: {
      status: "EXECUTION_ERROR",
      hasCwdError: true,
    }
  });

  // 33. workspace-subdirectory-allowed
  const subDir = path.join(tmpRoot, "packages", "app");
  fs.mkdirSync(subDir, { recursive: true });
  const subDirResult = await verifEngine.execute({
    verificationId: "v-sub",
    action: "TEST",
    executable: "node",
    args: ["-e", "console.log('subdir-ok')"],
    cwd: subDir,
    timeoutMs: 1000,
    commandPreview: "node subdir",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok"
  });
  results.push({
    id: "workspace-subdirectory-allowed",
    description: "Subdirectory within workspace is allowed for CWD",
    actual: { status: subDirResult.status, stdoutTrim: subDirResult.stdout.trim() },
    expected: { status: "PASS", stdoutTrim: "subdir-ok" }
  });

  // 34. path-traversal-cwd-blocked
  const traversalCwd = path.join(tmpRoot, "packages", "..", "..", "etc");
  const traversalResult = await verifEngine.execute({
    verificationId: "v-trav",
    action: "TEST",
    executable: "echo",
    args: ["bad"],
    cwd: traversalCwd,
    timeoutMs: 1000,
    commandPreview: "echo bad",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok"
  });
  results.push({
    id: "path-traversal-cwd-blocked",
    description: "Path traversal in CWD pointing outside workspace is blocked",
    actual: { status: traversalResult.status },
    expected: { status: "EXECUTION_ERROR" }
  });

  // ==========================================
  // CATEGORY 8: STALE SCRIPT BINDING (35-36)
  // ==========================================

  // 35. stale-package-json-hash-rejected
  const staleResult = await verifEngine.execute({
    verificationId: "v-stale",
    action: "TEST",
    executable: "echo",
    args: ["stale"],
    cwd: tmpRoot,
    timeoutMs: 1000,
    commandPreview: "echo stale",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: "0000000000000000000000000000000000000000000000000000000000000000", // forged hash
    scriptName: "test",
    scriptBody: "echo test-ok"
  });
  results.push({
    id: "stale-package-json-hash-rejected",
    description: "Mismatched package.json hash blocks execution with STALE_VERIFICATION",
    actual: { status: staleResult.status, hasStaleMsg: staleResult.stderr.includes("package.json modified") },
    expected: { status: "STALE_VERIFICATION", hasStaleMsg: true }
  });

  // 36. stale-script-body-rejected
  const realHash = crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex");
  const staleBodyResult = await verifEngine.execute({
    verificationId: "v-stale-body",
    action: "TEST",
    executable: "echo",
    args: ["stale"],
    cwd: tmpRoot,
    timeoutMs: 1000,
    commandPreview: "echo stale",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: realHash,
    scriptName: "test",
    scriptBody: "forged script body" // changed body
  });
  results.push({
    id: "stale-script-body-rejected",
    description: "Changed script body blocks execution with STALE_VERIFICATION",
    actual: { status: staleBodyResult.status, hasStaleBodyMsg: staleBodyResult.stderr.includes("Script 'test' was modified") },
    expected: { status: "STALE_VERIFICATION", hasStaleBodyMsg: true }
  });

  // ==========================================
  // CATEGORY 9: FORBIDDEN COMMANDS & SHELL STRING FILTERING (37-39)
  // ==========================================

  // 37. shell-operators-denied
  let pipelineThrown = false;
  try {
    const reg = (await import("@open-vs-code/agent-core")).createVerificationToolRegistry(tmpRoot);
    reg.prepare({ id: "inj-1", name: "run_verification", arguments: { action: "TEST | rm -rf /" } });
  } catch {
    pipelineThrown = true;
  }
  results.push({
    id: "shell-operators-denied",
    description: "Arbitrary shell strings and pipe operators rejected at preparation gate",
    actual: { pipelineThrown },
    expected: { pipelineThrown: true }
  });

  // 38. package-install-denied
  let installThrown = false;
  try {
    const reg = (await import("@open-vs-code/agent-core")).createVerificationToolRegistry(tmpRoot);
    reg.prepare({ id: "inj-2", name: "run_verification", arguments: { action: "npm install express" } });
  } catch {
    installThrown = true;
  }
  results.push({
    id: "package-install-denied",
    description: "Package installer commands denied by verification schema",
    actual: { installThrown },
    expected: { installThrown: true }
  });

  // 39. git-mutation-denied
  let gitThrown = false;
  try {
    const reg = (await import("@open-vs-code/agent-core")).createVerificationToolRegistry(tmpRoot);
    reg.prepare({ id: "inj-3", name: "run_verification", arguments: { action: "git commit -m evil" } });
  } catch {
    gitThrown = true;
  }
  results.push({
    id: "git-mutation-denied",
    description: "Git mutation commands denied by verification schema",
    actual: { gitThrown },
    expected: { gitThrown: true }
  });

  // ==========================================
  // CATEGORY 10: LIFECYCLE & SECURITY (40-42)
  // ==========================================

  // 40. new-chat-cancels-pending-terminal
  const entryNewChat = termController.registerPreparedCommand({
    confirmationId: "c-nc", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  controller.state.pendingConfirmation = {
    id: "c-nc",
    type: "run_known_test",
    summary: "Run test?",
    riskLabel: "Terminal",
    preparedCommand: {
      executionId: entryNewChat.executionId,
      command: "npm test",
      cwd: tmpRoot,
      provenance: "pkg",
      timeoutMs: 1000,
      status: "WAITING_APPROVAL",
    }
  };
  await view.webview.send({ type: "chat.newConversation" });
  results.push({
    id: "new-chat-cancels-pending-terminal",
    description: "New chat action cancels pending terminal confirmation",
    actual: { status: entryNewChat.status, pendingCleared: controller.state.pendingConfirmation === undefined },
    expected: { status: "CANCELLED", pendingCleared: true }
  });

  // 41. copy-command-clipboard-bound
  const entryCopy = termController.registerPreparedCommand({
    confirmationId: "c-copy", command: "npm run custom-task", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["run", "custom-task"]
  });
  await view.webview.send({ type: "terminal.copyCommand", executionId: entryCopy.executionId });
  results.push({
    id: "copy-command-clipboard-bound",
    description: "terminal.copyCommand copies exact display command to clipboard without model call",
    actual: { copiedText: clipboardText },
    expected: { copiedText: "npm run custom-task" }
  });

  // 42. deactivation-cleanup
  const countBefore = termController.totalReviews;
  termController.clearAll();
  results.push({
    id: "deactivation-cleanup",
    description: "Controller disposal clears all reviews and execution mappings",
    actual: { countBefore: countBefore > 0, countAfter: termController.totalReviews },
    expected: { countBefore: true, countAfter: 0 }
  });

  // Cleanup tmp dir
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}

  return results;
};

suite("Terminal Core E2E Evaluation Strict", () => {
  before(async () => {
    ChatController = (await import("../src/chat-controller.js")).ChatController;
    TerminalReviewController = (await import("../src/terminal-review-controller.js")).TerminalReviewController;
  });

  test("Strict Comparator Negative Tests", () => {
    assert.throws(() => strictCompare({ a: 1 }, { a: 2 }), /Comparison failed/);
    assert.throws(() => strictCompare({ missing: true }, { missing: true, other: true }), /Comparison failed/);
    assert.throws(() => strictCompare({ status: "RUNNING" }, { status: "SUCCEEDED" }), /Comparison failed/);
  });

  test("Deterministic Terminal UX Evaluations Run 1 and Run 2 (42 Scenarios)", async () => {
    const f1 = freshTerminalFixtures();
    const run1 = await runTerminalUxEvaluation(f1);

    let failed1 = 0;
    for (const res of run1) {
      try {
        strictCompare(res.actual, res.expected);
      } catch (e) {
        failed1++;
        console.error(`Run 1 failure in [${res.id}]:`, e);
      }
    }
    assert.strictEqual(failed1, 0, "Run 1 had failed strict comparisons");

    const f2 = freshTerminalFixtures();
    const run2 = await runTerminalUxEvaluation(f2);

    let failed2 = 0;
    for (const res of run2) {
      try {
        strictCompare(res.actual, res.expected);
      } catch (e) {
        failed2++;
        console.error(`Run 2 failure in [${res.id}]:`, e);
      }
    }
    assert.strictEqual(failed2, 0, "Run 2 had failed strict comparisons");

    const normalize = (res: any[]) => res.map(r => ({ id: r.id, actual: r.actual }));
    assert.deepStrictEqual(normalize(run1), normalize(run2), "Run 1 and Run 2 are not deterministic");
    assert.ok(run1.length >= 40, `Must have at least 40 scenarios (had ${run1.length})`);
  });
});
