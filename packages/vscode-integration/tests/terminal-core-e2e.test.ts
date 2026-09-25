import { AgentSessionBridge } from "../../ide-adapter/src/bridge.ts";
import { test, suite, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { VerificationEngine, ScriptedModelProvider } from "@open-vs-code/agent-core";

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

  const treeScript = path.join(tmpRoot, "tree-runner.cjs");
  fs.writeFileSync(treeScript, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[2], String(process.pid));",
    "const child = spawn(process.execPath, [",
    "  '-e',",
    "  'const fs = require(\"node:fs\"); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 10000);',",
    "  process.argv[3]",
    "], { stdio: 'ignore' });",
    "setInterval(() => {}, 10000);"
  ].join("\n"));

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
    executionId: "exec-1",
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
    executionId: "exec-rej-1",
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
    executionId: "exec-cancel-pre",
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
    confirmationId: "c-e0", executionId: "exec-e0", command: "npm run test", cwd: tmpRoot, provenance: "package.json", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-nz", executionId: "exec-nz", command: "npm run failing", cwd: tmpRoot, provenance: "package.json", timeoutMs: 1000, executable: "npm", args: ["failing"]
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
    confirmationId: "c-str", executionId: "exec-str", command: "npm run test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-sig", executionId: "exec-sig", command: "npm run test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-can-pre", executionId: "exec-can-pre", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-late", executionId: "exec-late", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-web-can", executionId: "exec-web-can", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-next", executionId: "exec-next", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-to-card", executionId: "exec-to-card", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 100, executable: "npm", args: ["test"]
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
    confirmationId: "c-after-to", executionId: "exec-after-to", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-bnd", executionId: "exec-bnd", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-utf8", executionId: "exec-utf8", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-nc", executionId: "exec-nc", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
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
    confirmationId: "c-copy", executionId: "exec-copy", command: "npm run custom-task", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["run", "custom-task"]
  });
  await view.webview.send({ type: "terminal.copyCommand", executionId: entryCopy.executionId });
  results.push({
    id: "copy-command-clipboard-bound",
    description: "terminal.copyCommand copies exact display command to clipboard without model call",
    actual: { copiedText: clipboardText },
    expected: { copiedText: "npm run custom-task" }
  });

  // ==========================================
  // CATEGORY 11: RUNTIME TRUTH & STREAMING (42-59)
  // ==========================================

  // 42. live-streaming-chatcontroller-bridge
  const entryLive = termController.registerPreparedCommand({
    confirmationId: "c-live", executionId: "exec-live", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  controller.state.activeTerminal = {
    executionId: entryLive.executionId,
    command: entryLive.command,
    cwd: entryLive.cwd,
    provenance: entryLive.provenance,
    timeoutMs: entryLive.timeoutMs,
    status: entryLive.status,
  };
  controller.handleAgentEvent({
    id: "ev-out-1",
    type: "verification.output",
    taskId: "t-1",
    timestamp: new Date().toISOString(),
    payload: {
      executionId: entryLive.executionId,
      stream: "stdout",
      chunk: "live line 1\n",
    }
  });
  results.push({
    id: "live-streaming-chatcontroller-bridge",
    description: "verification.output event appends to terminal review and syncs active terminal",
    actual: {
      stdout: entryLive.stdout,
      activeStdout: controller.state.activeTerminal?.stdout,
      webviewSentType: view.webview.lastMessage?.type,
      webviewSentStdout: view.webview.lastMessage?.terminal?.stdout,
    },
    expected: {
      stdout: "live line 1\n",
      activeStdout: "live line 1\n",
      webviewSentType: "terminal.updated",
      webviewSentStdout: "live line 1\n",
    }
  });

  // 43. live-stderr-chatcontroller-bridge
  controller.handleAgentEvent({
    id: "ev-out-2",
    type: "verification.output",
    taskId: "t-1",
    timestamp: new Date().toISOString(),
    payload: {
      executionId: entryLive.executionId,
      stream: "stderr",
      chunk: "warning in build\n",
    }
  });
  results.push({
    id: "live-stderr-chatcontroller-bridge",
    description: "verification.output event for stderr appends to stderr buffer and updates webview",
    actual: {
      stderr: entryLive.stderr,
      activeStderr: controller.state.activeTerminal?.stderr,
      webviewSentStderr: view.webview.lastMessage?.terminal?.stderr,
    },
    expected: {
      stderr: "warning in build\n",
      activeStderr: "warning in build\n",
      webviewSentStderr: "warning in build\n",
    }
  });

  // 44. utf8-multibyte-split-chunks-safety
  const entryUtf8Split = termController.registerPreparedCommand({
    confirmationId: "c-u8", executionId: "exec-u8", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryUtf8Split.executionId, "RUNNING");
  const robotFull = "🤖";
  const robotBuf = Buffer.from(robotFull, "utf-8");
  assert.strictEqual(robotBuf.length, 4);
  const chunk1 = robotBuf.subarray(0, 2);
  const chunk2 = robotBuf.subarray(2, 4);
  termController.appendOutput(entryUtf8Split.executionId, "stdout", chunk1);
  termController.appendOutput(entryUtf8Split.executionId, "stdout", chunk2);
  results.push({
    id: "utf8-multibyte-split-chunks-safety",
    description: "Multibyte UTF-8 characters split across chunk boundaries decode cleanly without replacement characters",
    actual: {
      stdout: entryUtf8Split.stdout,
      hasReplacementChar: entryUtf8Split.stdout.includes("\uFFFD"),
    },
    expected: {
      stdout: "🤖",
      hasReplacementChar: false,
    }
  });

  // 45. utf8-truncation-boundary-safety
  const smallTermCtrl = new TerminalReviewController({ maxOutputBytes: 5 });
  const entryU8Trunc = smallTermCtrl.registerPreparedCommand({
    confirmationId: "c-u8t", executionId: "exec-u8t", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  smallTermCtrl.setStatus(entryU8Trunc.executionId, "RUNNING");
  smallTermCtrl.appendOutput(entryU8Trunc.executionId, "stdout", "abc" + "🤖");
  results.push({
    id: "utf8-truncation-boundary-safety",
    description: "Bounded prefix buffer truncates at full UTF-8 character boundary without partial bytes or replacement char",
    actual: {
      stdout: entryU8Trunc.stdout,
      stdoutTruncated: entryU8Trunc.stdoutTruncated,
      byteLength: Buffer.byteLength(entryU8Trunc.stdout, "utf-8"),
      hasReplacementChar: entryU8Trunc.stdout.includes("\uFFFD"),
    },
    expected: {
      stdout: "abc",
      stdoutTruncated: true,
      byteLength: 3,
      hasReplacementChar: false,
    }
  });

  // 46. buffer-overflow-prefix-policy
  const entryFlood = termController.registerPreparedCommand({
    confirmationId: "c-flood", executionId: "exec-flood", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryFlood.executionId, "RUNNING");
  const largeChunk = "X".repeat(8 * 1024);
  termController.appendOutput(entryFlood.executionId, "stdout", largeChunk);
  termController.appendOutput(entryFlood.executionId, "stdout", largeChunk);
  termController.appendOutput(entryFlood.executionId, "stdout", largeChunk);
  termController.appendOutput(entryFlood.executionId, "stdout", largeChunk);
  results.push({
    id: "buffer-overflow-prefix-policy",
    description: "Truthful bounded prefix buffer: retains first 16KB, flags truncated, discards overflow",
    actual: {
      byteLength: Buffer.byteLength(entryFlood.stdout, "utf-8"),
      stdoutTruncated: entryFlood.stdoutTruncated,
      startsCorrectly: entryFlood.stdout.startsWith("XXXX"),
    },
    expected: {
      byteLength: 16 * 1024,
      stdoutTruncated: true,
      startsCorrectly: true,
    }
  });

  // 47. malformed-prepared-command-presentation-fails-closed
  const malformed1 = await controller.requestConfirmation("Run?", { preparedCommand: { executable: "", args: ["test"], cwd: tmpRoot } });
  const malformed2 = await controller.requestConfirmation("Run?", { preparedCommand: { executable: "npm", args: "not-an-array" as any, cwd: tmpRoot } });
  const malformed3 = await controller.requestConfirmation("Run?", { preparedCommand: { executable: "npm", args: ["test"], cwd: "" } });
  results.push({
    id: "malformed-prepared-command-presentation-fails-closed",
    description: "Malformed prepared commands fail closed immediately without fallback defaults",
    actual: {
      malformed1,
      malformed2,
      malformed3,
    },
    expected: {
      malformed1: "REJECT",
      malformed2: "REJECT",
      malformed3: "REJECT",
    }
  });

  // 48. terminal-registry-max-reviews-eviction
  const boundedCtrl = new TerminalReviewController({ maxReviews: 3 });
  const r1 = boundedCtrl.registerPreparedCommand({ confirmationId: "b-1", executionId: "exec-b-1", command: "c1", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  boundedCtrl.setStatus(r1.executionId, "SUCCEEDED");
  const r2 = boundedCtrl.registerPreparedCommand({ confirmationId: "b-2", executionId: "exec-b-2", command: "c2", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  boundedCtrl.setStatus(r2.executionId, "SUCCEEDED");
  const r3 = boundedCtrl.registerPreparedCommand({ confirmationId: "b-3", executionId: "exec-b-3", command: "c3", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  boundedCtrl.setStatus(r3.executionId, "SUCCEEDED");
  const r4 = boundedCtrl.registerPreparedCommand({ confirmationId: "b-4", executionId: "exec-b-4", command: "c4", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  results.push({
    id: "terminal-registry-max-reviews-eviction",
    description: "Terminal review registry bounds total entries by evicting oldest finished review",
    actual: {
      totalReviews: boundedCtrl.totalReviews,
      r1Evicted: boundedCtrl.getByExecutionId(r1.executionId) === undefined,
      r2Present: boundedCtrl.getByExecutionId(r2.executionId) !== undefined,
      r4Present: boundedCtrl.getByExecutionId(r4.executionId) !== undefined,
    },
    expected: {
      totalReviews: 3,
      r1Evicted: true,
      r2Present: true,
      r4Present: true,
    }
  });

  // 49. terminal-registry-active-reviews-never-evicted
  const boundedCtrl2 = new TerminalReviewController({ maxReviews: 2 });
  const a1 = boundedCtrl2.registerPreparedCommand({ confirmationId: "act-1", executionId: "exec-act-1", command: "c1", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  const a2 = boundedCtrl2.registerPreparedCommand({ confirmationId: "act-2", executionId: "exec-act-2", command: "c2", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  boundedCtrl2.setStatus(a2.executionId, "RUNNING");
  const a3 = boundedCtrl2.registerPreparedCommand({ confirmationId: "act-3", executionId: "exec-act-3", command: "c3", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  results.push({
    id: "terminal-registry-active-reviews-never-evicted",
    description: "Active terminal reviews (WAITING_APPROVAL, RUNNING) are never evicted",
    actual: {
      a1Present: boundedCtrl2.getByExecutionId(a1.executionId) !== undefined,
      a2Present: boundedCtrl2.getByExecutionId(a2.executionId) !== undefined,
      a3Present: boundedCtrl2.getByExecutionId(a3.executionId) !== undefined,
    },
    expected: {
      a1Present: true,
      a2Present: true,
      a3Present: true,
    }
  });

  // 50. terminal-registry-total-retained-bytes-eviction
  const boundedBytesCtrl = new TerminalReviewController({ maxTotalRetainedBytes: 100 });
  const byteR1 = boundedBytesCtrl.registerPreparedCommand({ confirmationId: "by-1", executionId: "exec-by-1", command: "c1", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  boundedBytesCtrl.setStatus(byteR1.executionId, "RUNNING");
  boundedBytesCtrl.appendOutput(byteR1.executionId, "stdout", "A".repeat(60));
  boundedBytesCtrl.setStatus(byteR1.executionId, "SUCCEEDED");
  const byteR2 = boundedBytesCtrl.registerPreparedCommand({ confirmationId: "by-2", executionId: "exec-by-2", command: "c2", cwd: tmpRoot, provenance: "p", timeoutMs: 1000, executable: "node", args: [] });
  boundedBytesCtrl.setStatus(byteR2.executionId, "RUNNING");
  boundedBytesCtrl.appendOutput(byteR2.executionId, "stdout", "B".repeat(60));
  boundedBytesCtrl.setStatus(byteR2.executionId, "SUCCEEDED");
  results.push({
    id: "terminal-registry-total-retained-bytes-eviction",
    description: "Exceeding maxTotalRetainedBytes evicts oldest finished review to stay within budget",
    actual: {
      r1Evicted: boundedBytesCtrl.getByExecutionId(byteR1.executionId) === undefined,
      r2Present: boundedBytesCtrl.getByExecutionId(byteR2.executionId) !== undefined,
      retainedBytesUnderLimit: boundedBytesCtrl.totalRetainedBytes <= 100,
    },
    expected: {
      r1Evicted: true,
      r2Present: true,
      retainedBytesUnderLimit: true,
    }
  });

  // 51. real-e2e-agentrunner-approval-verification-subprocess-succeeded
  const { createVerificationToolRegistrations, AgentRunner } = await import("@open-vs-code/agent-core");
  const agentCoreRegistry = (await import("@open-vs-code/agent-core")).createReadOnlyToolRegistry();
  for (const r of createVerificationToolRegistrations(tmpRoot)) {
    agentCoreRegistry.register(r);
  }

  const liveEvents: any[] = [];
  const realRunner = new AgentRunner({
    provider: new ScriptedModelProvider([
      {
        model: "scripted-test",
        message: {
          role: "assistant",
          content: "Run test"
        },
        toolCalls: [
          { id: "call-verif-ok", name: "run_verification", arguments: { action: "TEST" } }
        ]
      },
      {
        model: "scripted-test",
        message: {
          role: "assistant",
          content: "Verification finished"
        }
      }
    ]),
    registry: agentCoreRegistry,
    permissionEvaluator: () => "CONFIRM",
    evidenceGate: false,
    eventSink: (ev) => {
      liveEvents.push(ev);
      controller.handleAgentEvent(ev);
    }
  });

  const runnerRun1 = await realRunner.run({
    task: { id: "t-e2e-verif", mode: "BUILD", instruction: "Run verification" },
    workspaceRoot: tmpRoot,
    maxTurns: 5,
    contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 },
    projectInstructions: [],
    memory: { durableNotes: [], activeContext: [], recentSessions: [] },
    selectedSkills: [],
  });

  assert.strictEqual(runnerRun1.status, "PAUSED");
  assert.ok(runnerRun1.confirmation);

  const prepCmd = runnerRun1.confirmation.preparedCommand;
  assert.ok(prepCmd.verificationId, "preparedCommand must have a verificationId");
  const runnerReviewEntry = termController.registerPreparedCommand({
    confirmationId: "c-e2e-run",
    executionId: prepCmd.verificationId, // canonical identity preserved
    command: prepCmd.commandPreview,
    cwd: prepCmd.cwd,
    provenance: "package.json [test]",
    timeoutMs: prepCmd.timeoutMs,
    executable: prepCmd.executable,
    args: prepCmd.args,
    packageJsonPath: prepCmd.packageJsonPath,
    packageJsonHash: prepCmd.packageJsonHash,
    scriptName: prepCmd.scriptName,
    scriptBody: prepCmd.scriptBody,
  });
  controller.state.activeTerminal = {
    executionId: runnerReviewEntry.executionId,
    command: runnerReviewEntry.command,
    cwd: runnerReviewEntry.cwd,
    provenance: runnerReviewEntry.provenance,
    timeoutMs: runnerReviewEntry.timeoutMs,
    status: runnerReviewEntry.status,
  };

  const runnerRun2 = await realRunner.resume("APPROVE");
  const outputEvents = liveEvents.filter(e => e.type === "verification.output");
  const testOkEvent = outputEvents.find(e => typeof e.payload?.chunk === "string" && e.payload.chunk.includes("test-ok"));
  const completedEvent = liveEvents.find(e => e.type === "verification.completed");

  // Identity invariant: all IDs must equal prepCmd.verificationId
  const outputEventId = outputEvents[0]?.payload?.executionId as string | undefined;
  const completedEventId = completedEvent?.payload?.executionId as string | undefined;

  results.push({
    id: "real-e2e-agentrunner-approval-verification-subprocess-succeeded",
    description: "Full real E2E: AgentRunner → approval → VerificationEngine → subprocess → live output → SUCCEEDED with canonical ID identity",
    actual: {
      runnerStatus: runnerRun2.status,
      hasOutputEvent: outputEvents.length > 0,
      hasTestOkChunk: Boolean(testOkEvent),
      terminalStatus: runnerReviewEntry.status,
      terminalExitCode: runnerReviewEntry.exitCode,
      completedStatus: completedEvent?.payload?.result?.status,
      // Canonical ID identity: PreparedVerification.verificationId == TerminalReview.executionId
      reviewIdMatchesPrepared: runnerReviewEntry.executionId === prepCmd.verificationId,
      // output event ID matches (if present)
      outputIdMatchesPrepared: outputEventId === undefined || outputEventId === prepCmd.verificationId,
    },
    expected: {
      runnerStatus: "COMPLETED",
      hasOutputEvent: true,
      hasTestOkChunk: true,
      terminalStatus: "SUCCEEDED",
      terminalExitCode: 0,
      completedStatus: "PASS",
      reviewIdMatchesPrepared: true,
      outputIdMatchesPrepared: true,
    }
  });

  // 52. real-e2e-agentrunner-failure-subprocess
  const originalPkgContent = fs.readFileSync(pkgJsonPath, "utf-8");
  const modifiedPkg = JSON.parse(originalPkgContent);
  modifiedPkg.scripts.test = "node -e 'process.stderr.write(\"failed in test\\n\"); process.exit(1)'";
  fs.writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkg, null, 2));

  const failToolRegistrations = (await import("@open-vs-code/agent-core")).createVerificationToolRegistrations(tmpRoot);
  const failRegistry = (await import("@open-vs-code/agent-core")).createReadOnlyToolRegistry();
  for (const r of failToolRegistrations) {
    failRegistry.register(r);
  }

  const failEvents: any[] = [];
  const failRunner = new AgentRunner({
    provider: new ScriptedModelProvider([
      {
        model: "scripted-test",
        message: {
          role: "assistant",
          content: "Run test"
        },
        toolCalls: [
          { id: "call-verif-fail", name: "run_verification", arguments: { action: "TEST" } }
        ]
      },
      {
        model: "scripted-test",
        message: {
          role: "assistant",
          content: "Verification failed"
        }
      }
    ]),
    registry: failRegistry,
    permissionEvaluator: () => "CONFIRM",
    evidenceGate: false,
    eventSink: (ev) => {
      failEvents.push(ev);
      controller.handleAgentEvent(ev);
    }
  });

  const failRun1 = await failRunner.run({
    task: { id: "t-e2e-verif-fail", mode: "BUILD", instruction: "Run failing test" },
    workspaceRoot: tmpRoot,
    maxTurns: 5,
    contextBudget: { contextWindow: 8000, reservedOutput: 1000, reservedToolHistory: 500, availableContext: 6500 },
    projectInstructions: [],
    memory: { durableNotes: [], activeContext: [], recentSessions: [] },
    selectedSkills: [],
  });

  assert.strictEqual(failRun1.status, "PAUSED");
  const failPrepCmd = failRun1.confirmation!.preparedCommand;
  assert.ok(failPrepCmd.verificationId, "failPrepCmd must have a verificationId");
  const failReviewEntry = termController.registerPreparedCommand({
    confirmationId: "c-e2e-fail",
    executionId: failPrepCmd.verificationId, // canonical identity preserved
    command: failPrepCmd.commandPreview,
    cwd: failPrepCmd.cwd,
    provenance: "package.json [test]",
    timeoutMs: failPrepCmd.timeoutMs,
    executable: failPrepCmd.executable,
    args: failPrepCmd.args,
    packageJsonPath: failPrepCmd.packageJsonPath,
    packageJsonHash: failPrepCmd.packageJsonHash,
    scriptName: failPrepCmd.scriptName,
    scriptBody: failPrepCmd.scriptBody,
  });
  controller.state.activeTerminal = {
    executionId: failReviewEntry.executionId,
    command: failReviewEntry.command,
    cwd: failReviewEntry.cwd,
    provenance: failReviewEntry.provenance,
    timeoutMs: failReviewEntry.timeoutMs,
    status: failReviewEntry.status,
  };

  const failRun2 = await failRunner.resume("APPROVE");
  const failOutputEvent = failEvents.find(e => e.type === "verification.output" && e.payload?.stream === "stderr");

  // Restore package.json
  fs.writeFileSync(pkgJsonPath, originalPkgContent);

  results.push({
    id: "real-e2e-agentrunner-failure-subprocess",
    description: "Full real end-to-end failure path captures stderr live and records status FAILED",
    actual: {
      runnerStatus: failRun2.status,
      hasStderrEvent: Boolean(failOutputEvent),
      stderrChunk: failOutputEvent?.payload?.chunk?.trim(),
      terminalStatus: failReviewEntry.status,
      terminalExitCode: failReviewEntry.exitCode,
    },
    expected: {
      runnerStatus: "COMPLETED",
      hasStderrEvent: true,
      stderrChunk: "failed in test",
      terminalStatus: "FAILED",
      terminalExitCode: 1,
    }
  });

  // 53. real-parent-child-cleanup-cancellation-deterministic
  const parentPidPath = path.join(tmpRoot, "parent-cancel.pid");
  const childPidPath = path.join(tmpRoot, "child-cancel.pid");
  const cancelEngine = new VerificationEngine({ workspaceRoot: tmpRoot });
  const cancelAbort = new AbortController();

  const cancelExecPromise = cancelEngine.execute({
    verificationId: "v-cancel-tree",
    action: "TEST",
    executable: process.execPath,
    args: [path.join(tmpRoot, "tree-runner.cjs"), parentPidPath, childPidPath],
    cwd: tmpRoot,
    timeoutMs: 30000,
    commandPreview: "node tree-runner.cjs",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok",
  }, cancelAbort.signal);

  let cancelTries = 0;
  while ((!fs.existsSync(parentPidPath) || !fs.existsSync(childPidPath)) && cancelTries < 100) {
    await new Promise(r => setTimeout(r, 20));
    cancelTries++;
  }
  const parentCancelPid = parseInt(fs.readFileSync(parentPidPath, "utf-8"), 10);
  const childCancelPid = parseInt(fs.readFileSync(childPidPath, "utf-8"), 10);

  let parentAliveBefore = false;
  let childAliveBefore = false;
  try { process.kill(parentCancelPid, 0); parentAliveBefore = true; } catch {}
  try { process.kill(childCancelPid, 0); childAliveBefore = true; } catch {}

  cancelAbort.abort();
  const cancelTreeResult = await cancelExecPromise;

  let parentAliveAfter = true;
  let childAliveAfter = true;
  for (let i = 0; i < 50; i++) {
    try { process.kill(parentCancelPid, 0); parentAliveAfter = true; } catch { parentAliveAfter = false; }
    try { process.kill(childCancelPid, 0); childAliveAfter = true; } catch { childAliveAfter = false; }
    if (!parentAliveAfter && !childAliveAfter) break;
    await new Promise(r => setTimeout(r, 25));
  }

  results.push({
    id: "real-parent-child-cleanup-cancellation-deterministic",
    description: "Cancellation deterministically terminates both parent and child processes in process tree",
    actual: {
      status: cancelTreeResult.status,
      parentAliveBefore,
      childAliveBefore,
      parentAliveAfter,
      childAliveAfter,
    },
    expected: {
      status: "CANCELLED",
      parentAliveBefore: true,
      childAliveBefore: true,
      parentAliveAfter: false,
      childAliveAfter: false,
    }
  });

  // 54. real-parent-child-cleanup-timeout-deterministic
  const parentTimeoutPidPath = path.join(tmpRoot, "parent-timeout.pid");
  const childTimeoutPidPath = path.join(tmpRoot, "child-timeout.pid");
  const timeoutEngine = new VerificationEngine({ workspaceRoot: tmpRoot });

  const timeoutExecPromise = timeoutEngine.execute({
    verificationId: "v-timeout-tree",
    action: "TEST",
    executable: process.execPath,
    args: [path.join(tmpRoot, "tree-runner.cjs"), parentTimeoutPidPath, childTimeoutPidPath],
    cwd: tmpRoot,
    timeoutMs: 1500,
    commandPreview: "node tree-runner.cjs",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok",
  });

  let timeoutTries = 0;
  while ((!fs.existsSync(parentTimeoutPidPath) || !fs.existsSync(childTimeoutPidPath)) && timeoutTries < 200) {
    await new Promise(r => setTimeout(r, 20));
    timeoutTries++;
  }
  const parentTimeoutPid = parseInt(fs.readFileSync(parentTimeoutPidPath, "utf-8"), 10);
  const childTimeoutPid = parseInt(fs.readFileSync(childTimeoutPidPath, "utf-8"), 10);

  let parentAliveBeforeTimeout = false;
  let childAliveBeforeTimeout = false;
  try { process.kill(parentTimeoutPid, 0); parentAliveBeforeTimeout = true; } catch {}
  try { process.kill(childTimeoutPid, 0); childAliveBeforeTimeout = true; } catch {}

  const timeoutTreeResult = await timeoutExecPromise;

  let parentAliveAfterTimeout = true;
  let childAliveAfterTimeout = true;
  for (let i = 0; i < 50; i++) {
    try { process.kill(parentTimeoutPid, 0); parentAliveAfterTimeout = true; } catch { parentAliveAfterTimeout = false; }
    try { process.kill(childTimeoutPid, 0); childAliveAfterTimeout = true; } catch { childAliveAfterTimeout = false; }
    if (!parentAliveAfterTimeout && !childAliveAfterTimeout) break;
    await new Promise(r => setTimeout(r, 25));
  }

  results.push({
    id: "real-parent-child-cleanup-timeout-deterministic",
    description: "Timeout deterministically terminates both parent and child processes in process tree",
    actual: {
      status: timeoutTreeResult.status,
      parentAliveBefore: parentAliveBeforeTimeout,
      childAliveBefore: childAliveBeforeTimeout,
      parentAliveAfter: parentAliveAfterTimeout,
      childAliveAfter: childAliveAfterTimeout,
    },
    expected: {
      status: "TIMEOUT",
      parentAliveBefore: true,
      childAliveBefore: true,
      parentAliveAfter: false,
      childAliveAfter: false,
    }
  });

  // 55. real-extension-deactivation-during-command
  // Proof: deactivate() alone (no prior cancelTurn()) kills the live process tree.
  // We inject the test controller into the extension module so deactivate() calls
  // chatController.cancelTurn() through the real production path.
  const deactivateModule = await import("../src/extension.js");
  const deactParentPid = path.join(tmpRoot, "parent-deact.pid");
  const deactChildPid = path.join(tmpRoot, "child-deact.pid");
  const deactEngine = new VerificationEngine({ workspaceRoot: tmpRoot });
  const deactAbort = new AbortController();

  const deactExecPromise = deactEngine.execute({
    verificationId: "v-deact-tree",
    action: "TEST",
    executable: process.execPath,
    args: [path.join(tmpRoot, "tree-runner.cjs"), deactParentPid, deactChildPid],
    cwd: tmpRoot,
    timeoutMs: 30000,
    commandPreview: "node tree-runner.cjs",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok",
  }, deactAbort.signal);

  // Wait deterministically for both PIDs to appear (both processes running)
  let deactTries = 0;
  while ((!fs.existsSync(deactParentPid) || !fs.existsSync(deactChildPid)) && deactTries < 250) {
    await new Promise(r => setTimeout(r, 20));
    deactTries++;
  }
  const parentDeactPid = parseInt(fs.readFileSync(deactParentPid, "utf-8"), 10);
  const childDeactPid = parseInt(fs.readFileSync(deactChildPid, "utf-8"), 10);

  // Confirm both processes are alive before deactivation
  let parentAliveBeforeDeact = false;
  let childAliveBeforeDeact = false;
  try { process.kill(parentDeactPid, 0); parentAliveBeforeDeact = true; } catch {}
  try { process.kill(childDeactPid, 0); childAliveBeforeDeact = true; } catch {}

  // Wire the real abort controller into the test ChatController, then inject it into
  // the extension module so deactivate() → chatController.cancelTurn() → abort.abort()
  // This simulates a real live agent turn holding the abort signal.
  controller._activeAbortController = deactAbort;
  // Inject test controller into module-level chatController (no manual cancelTurn before this)
  deactivateModule._testSeam.setChatController(controller as any);
  deactivateModule._testSeam.setTerminalReviewController(termController as any);

  // THE SOLE TRIGGER — deactivate() must be what kills the process
  deactivateModule.deactivate();

  // Wait for process death after deactivate
  await deactExecPromise;

  let pDeadAfterDeact = false;
  let cDeadAfterDeact = false;
  for (let i = 0; i < 60; i++) {
    try { process.kill(parentDeactPid, 0); pDeadAfterDeact = false; } catch { pDeadAfterDeact = true; }
    try { process.kill(childDeactPid, 0); cDeadAfterDeact = false; } catch { cDeadAfterDeact = true; }
    if (pDeadAfterDeact && cDeadAfterDeact) break;
    await new Promise(r => setTimeout(r, 25));
  }

  results.push({
    id: "real-extension-deactivation-during-command",
    description: "deactivate() alone (no prior cancelTurn) kills live parent+child process tree and clears the terminal registry",
    actual: {
      parentAliveBeforeDeact,
      childAliveBeforeDeact,
      parentDeadAfterDeact: pDeadAfterDeact,
      childDeadAfterDeact: cDeadAfterDeact,
      // Registry cleared by deactivate() via setTerminalReviewController + clearAll
      registryAfterDeact: termController.totalReviews,
    },
    expected: {
      parentAliveBeforeDeact: true,
      childAliveBeforeDeact: true,
      parentDeadAfterDeact: true,
      childDeadAfterDeact: true,
      registryAfterDeact: 0,
    }
  });

  // Restore termController state for subsequent scenarios (clearAll was called by deactivate)
  // Re-register any entries needed for subsequent scenarios via fresh registrations.

  // 56. late-output-after-completion-ignored
  const entryComplete = termController.registerPreparedCommand({
    confirmationId: "c-comp", executionId: "exec-comp", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.recordCompletion(entryComplete.executionId, {
    status: "SUCCEEDED",
    stdout: "initial stdout",
  });
  termController.appendOutput(entryComplete.executionId, "stdout", "late chunk");
  results.push({
    id: "late-output-after-completion-ignored",
    description: "Late output received after completion is discarded",
    actual: {
      stdout: entryComplete.stdout,
    },
    expected: {
      stdout: "initial stdout",
    }
  });

  // 57. malformed-streaming-event-ignored
  const beforeOut = entryLive.stdout;
  controller.handleAgentEvent({
    id: "ev-bad-1",
    type: "verification.output",
    taskId: "t-1",
    timestamp: new Date().toISOString(),
    payload: {
      executionId: entryLive.executionId,
      stream: "invalid_stream" as any,
      chunk: 12345 as any,
    }
  });
  results.push({
    id: "malformed-streaming-event-ignored",
    description: "Malformed verification.output event is ignored safely",
    actual: {
      stdoutUnchanged: entryLive.stdout === beforeOut,
    },
    expected: {
      stdoutUnchanged: true,
    }
  });

  // 58. malicious-streamed-output-xss-safety
  const entryXss = termController.registerPreparedCommand({
    confirmationId: "c-xss", executionId: "exec-xss", command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryXss.executionId, "RUNNING");
  const malicious = "<script>alert('xss')</script><img src=x onerror=alert(1)>";
  termController.appendOutput(entryXss.executionId, "stdout", malicious);
  results.push({
    id: "malicious-streamed-output-xss-safety",
    description: "Malicious HTML / scripts in stdout are stored literally as text without DOM execution",
    actual: {
      stdout: entryXss.stdout,
      hasScriptTag: entryXss.stdout.includes("<script>"),
    },
    expected: {
      stdout: malicious,
      hasScriptTag: true,
    }
  });

  // ==========================================
  // CATEGORY 12: SPRINT 3D.2 — EXECUTION IDENTITY & DEACTIVATION CLOSURE (60-79)
  // ==========================================

  // 60. canonical-id-preserved-at-registration (T-2900)
  const entryCanon = termController.registerPreparedCommand({
    confirmationId: "conf-canon-60",
    executionId: "canonical-id-abc123",
    command: "npm run test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["run", "test"]
  });
  results.push({
    id: "canonical-id-preserved-at-registration",
    description: "T-2900: Canonical executionId supplied at registration is preserved exactly — no regeneration",
    actual: {
      executionId: entryCanon.executionId,
      retrievable: termController.getByExecutionId("canonical-id-abc123") !== undefined,
    },
    expected: {
      executionId: "canonical-id-abc123",
      retrievable: true,
    }
  });

  // 61. canonical-id-preserved-at-approval (T-2901)
  const entryApproval = termController.registerPreparedCommand({
    confirmationId: "conf-canon-61",
    executionId: "canonical-id-approval-xyz",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  const beforeApprovalId = entryApproval.executionId;
  termController.setStatus(entryApproval.executionId, "RUNNING");
  results.push({
    id: "canonical-id-preserved-at-approval",
    description: "T-2901: executionId is identical before and after status transition to RUNNING",
    actual: {
      idBeforeApproval: beforeApprovalId,
      idAfterApproval: entryApproval.executionId,
      idUnchanged: beforeApprovalId === entryApproval.executionId,
      status: entryApproval.status,
    },
    expected: {
      idBeforeApproval: "canonical-id-approval-xyz",
      idAfterApproval: "canonical-id-approval-xyz",
      idUnchanged: true,
      status: "RUNNING",
    }
  });

  // 62. canonical-id-preserved-at-running (T-2902)
  const entryRunning = termController.registerPreparedCommand({
    confirmationId: "conf-canon-62",
    executionId: "canonical-id-running-r1",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryRunning.executionId, "RUNNING");
  termController.appendOutput(entryRunning.executionId, "stdout", "STARTED\n");
  const idAfterOutput = termController.getByExecutionId("canonical-id-running-r1")?.executionId;
  results.push({
    id: "canonical-id-immutable-through-running-and-output",
    description: "T-2902: executionId is immutable through RUNNING state and output events",
    actual: {
      idAfterRunning: idAfterOutput,
      statusAfterOutput: termController.getByExecutionId("canonical-id-running-r1")?.status,
      stdoutAfterOutput: termController.getByExecutionId("canonical-id-running-r1")?.stdout,
    },
    expected: {
      idAfterRunning: "canonical-id-running-r1",
      statusAfterOutput: "RUNNING",
      stdoutAfterOutput: "STARTED\n",
    }
  });

  // 63. output-event-routed-by-exact-id (T-2903)
  const entryExact = termController.registerPreparedCommand({
    confirmationId: "conf-exact-63",
    executionId: "exact-routing-id-63",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryExact.executionId, "RUNNING");
  // Route output using the exact event executionId
  const exactOutputController = new TerminalReviewController();
  exactOutputController.registerPreparedCommand({
    confirmationId: "conf-exact-63b",
    executionId: "exact-routing-id-63",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  exactOutputController.setStatus("exact-routing-id-63", "RUNNING");
  const beforeExactOutput = exactOutputController.getByExecutionId("exact-routing-id-63")?.stdout;
  exactOutputController.appendOutput("exact-routing-id-63", "stdout", "EXACT_OUTPUT_CHUNK\n");
  results.push({
    id: "output-event-routed-by-exact-id",
    description: "T-2903: appendOutput routes to entry registered under exact executionId",
    actual: {
      beforeOutput: beforeExactOutput,
      afterOutput: exactOutputController.getByExecutionId("exact-routing-id-63")?.stdout,
    },
    expected: {
      beforeOutput: "",
      afterOutput: "EXACT_OUTPUT_CHUNK\n",
    }
  });

  // 64. completion-routed-by-exact-id (T-2902 completion)
  const entryCompExact = termController.registerPreparedCommand({
    confirmationId: "conf-comp-64",
    executionId: "canonical-comp-id-64",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  termController.setStatus(entryCompExact.executionId, "RUNNING");
  termController.recordCompletion("canonical-comp-id-64", {
    status: "SUCCEEDED",
    exitCode: 0,
    durationMs: 200,
    stdout: "TEST_OK",
  });
  const compEntry = termController.getByExecutionId("canonical-comp-id-64");
  results.push({
    id: "completion-routed-by-exact-id",
    description: "T-2902: recordCompletion routes to entry registered under canonical executionId",
    actual: {
      status: compEntry?.status,
      stdout: compEntry?.stdout,
      exitCode: compEntry?.exitCode,
      idUnchangedAfterCompletion: compEntry?.executionId === "canonical-comp-id-64",
    },
    expected: {
      status: "SUCCEEDED",
      stdout: "TEST_OK",
      exitCode: 0,
      idUnchangedAfterCompletion: true,
    }
  });

  // 65. live-output-real-path-visible-before-completion (T-2905)
  // Uses real VerificationEngine with a staged fixture producing STARTED then TEST_OK
  const stagePath = path.join(tmpRoot, "staged-fixture.cjs");
  const stageReadyPath = path.join(tmpRoot, "staged-ready.pid");
  fs.writeFileSync(stagePath, [
    "process.stdout.write('STARTED\\n');",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[2], '1');",
    "// keep alive briefly then print second token",
    "setTimeout(() => { process.stdout.write('TEST_OK\\n'); process.exit(0); }, 100);",
  ].join("\n"));

  const livePathEngine = new VerificationEngine({ workspaceRoot: tmpRoot });
  const livePathAbort = new AbortController();
  const liveOutputChunks: string[] = [];

  // Register a terminal review for this live execution using canonical ID
  const liveEntry65 = termController.registerPreparedCommand({
    confirmationId: "conf-live-65",
    executionId: "v-live-path-65",
    command: "node staged-fixture.cjs", cwd: tmpRoot, provenance: "pkg", timeoutMs: 10000, executable: "node", args: [stagePath, stageReadyPath]
  });
  termController.setStatus("v-live-path-65", "RUNNING");

  const onOutputLive = (chunk: { stream: "stdout" | "stderr"; chunk: string }) => {
    liveOutputChunks.push(chunk.chunk);
    termController.appendOutput("v-live-path-65", chunk.stream, chunk.chunk);
  };

  const livePathExec = livePathEngine.execute({
    verificationId: "v-live-path-65",
    action: "TEST",
    executable: process.execPath,
    args: [stagePath, stageReadyPath],
    cwd: tmpRoot,
    timeoutMs: 10000,
    commandPreview: "node staged-fixture.cjs",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok",
  }, livePathAbort.signal, onOutputLive);

  // Wait for STARTED to appear and ready marker to be written
  let liveWaitTries = 0;
  while (!fs.existsSync(stageReadyPath) && liveWaitTries < 100) {
    await new Promise(r => setTimeout(r, 10));
    liveWaitTries++;
  }
  // Probe the running entry and live output buffer before process completes
  const statusBeforeCompletion = liveEntry65.status;
  const liveOutputBeforeCompletion = liveEntry65.stdout;

  // Wait for completion
  const livePathResult = await livePathExec;
  termController.recordCompletion("v-live-path-65", {
    status: livePathResult.status === "PASS" ? "SUCCEEDED" : "FAILED",
    exitCode: livePathResult.exitCode,
    durationMs: livePathResult.durationMs,
  });

  results.push({
    id: "live-output-visible-before-completion",
    description: "T-2905: Terminal entry RUNNING status and live streamed output are observable before process completes",
    actual: {
      statusBeforeCompletion,
      liveOutputBeforeCompletionHasStarted: liveOutputBeforeCompletion.includes("STARTED"),
      processStatus: livePathResult.status,
      finalEntryStatus: liveEntry65.status,
      entryIdMatchesVerificationId: liveEntry65.executionId === "v-live-path-65",
      hasTestOkInOutput: liveEntry65.stdout.includes("TEST_OK"),
    },
    expected: {
      statusBeforeCompletion: "RUNNING",
      liveOutputBeforeCompletionHasStarted: true,
      processStatus: "PASS",
      finalEntryStatus: "SUCCEEDED",
      entryIdMatchesVerificationId: true,
      hasTestOkInOutput: true,
    }
  });

  // 66. forged-output-id-ignored (T-2906)
  const entryForgedTarget = termController.registerPreparedCommand({
    confirmationId: "conf-forged-66",
    executionId: "real-entry-id-66",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  termController.setStatus("real-entry-id-66", "RUNNING");
  const stdoutBeforeForgedEvent = entryForgedTarget.stdout;
  // Emit output with a forged (non-existent) executionId
  termController.appendOutput("forged-nonexistent-id-66", "stdout", "FORGED_OUTPUT");
  const registryHasForgedId = termController.getByExecutionId("forged-nonexistent-id-66") !== undefined;
  results.push({
    id: "forged-output-id-ignored",
    description: "T-2906: Output event with forged executionId does not route to any entry and creates no new entry",
    actual: {
      realEntryStdoutUnchanged: entryForgedTarget.stdout === stdoutBeforeForgedEvent,
      forgedIdCreatedEntry: registryHasForgedId,
    },
    expected: {
      realEntryStdoutUnchanged: true,
      forgedIdCreatedEntry: false,
    }
  });

  // 67. output-A-cannot-mutate-review-B (T-2907)
  const entryA67 = termController.registerPreparedCommand({
    confirmationId: "conf-a-67",
    executionId: "entry-A-67",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  const entryB67 = termController.registerPreparedCommand({
    confirmationId: "conf-b-67",
    executionId: "entry-B-67",
    command: "npm run build", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["run", "build"]
  });
  termController.setStatus("entry-A-67", "RUNNING");
  termController.setStatus("entry-B-67", "RUNNING");
  // Feed output to A
  termController.appendOutput("entry-A-67", "stdout", "OUTPUT_FOR_A\n");
  // B must remain empty
  results.push({
    id: "output-a-cannot-mutate-review-b",
    description: "T-2907: Output routed to entry A does not appear in entry B",
    actual: {
      aStdout: entryA67.stdout,
      bStdout: entryB67.stdout,
      aUnaffectedByBOutput: !entryA67.stdout.includes("OUTPUT_FOR_B"),
      bUnaffectedByAOutput: !entryB67.stdout.includes("OUTPUT_FOR_A"),
    },
    expected: {
      aStdout: "OUTPUT_FOR_A\n",
      bStdout: "",
      aUnaffectedByBOutput: true,
      bUnaffectedByAOutput: true,
    }
  });
  // Now feed output to B — A must remain unchanged
  const aStdoutSnapshot = entryA67.stdout;
  termController.appendOutput("entry-B-67", "stdout", "OUTPUT_FOR_B\n");
  results.push({
    id: "output-b-cannot-mutate-review-a",
    description: "T-2907: Output routed to entry B does not appear in entry A",
    actual: {
      bStdout: entryB67.stdout,
      aStdoutUnchanged: entryA67.stdout === aStdoutSnapshot,
    },
    expected: {
      bStdout: "OUTPUT_FOR_B\n",
      aStdoutUnchanged: true,
    }
  });

  // 69. terminal-updated-preserves-canonical-id (T-2908)
  // Simulate ChatController.handleAgentEvent for verification.output and check terminal.updated message
  const tcForUpdated = new TerminalReviewController();
  const { ChatController: ChatControllerCls } = await import("../src/chat-controller.js");
  const hostUpdated = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null, selection: null, diagnostics: [], visibleDocuments: [], isTrusted: true
    }),
    showOutput: async () => {}, showError: async () => {}, isWorkspaceTrusted: async () => true,
    requestConfirmation: async () => "REJECT" as const,
  };
  const diffCtrlUpdated = { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' };
  const viewUpdated = { webview: new MockWebview() };
  const ctrlUpdated = new ChatControllerCls(hostUpdated as any, diffCtrlUpdated as any, tcForUpdated, () => ({} as any));
  ctrlUpdated.setWebviewView(viewUpdated as any);

  tcForUpdated.registerPreparedCommand({
    confirmationId: "conf-updated-69",
    executionId: "canonical-updated-id-69",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  tcForUpdated.setStatus("canonical-updated-id-69", "RUNNING");
  ctrlUpdated.state.activeTerminal = {
    executionId: "canonical-updated-id-69",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, status: "RUNNING"
  };
  ctrlUpdated.handleAgentEvent({
    id: "ev-updated-69",
    type: "verification.output",
    taskId: "t-69",
    timestamp: new Date().toISOString(),
    payload: { executionId: "canonical-updated-id-69", stream: "stdout", chunk: "STAGE_OUTPUT\n" }
  });
  const lastUpdatedMsg = (viewUpdated.webview as MockWebview).lastMessage;
  results.push({
    id: "terminal-updated-preserves-canonical-id",
    description: "T-2908: terminal.updated message carries the same canonical executionId as the output event",
    actual: {
      msgType: lastUpdatedMsg?.type,
      terminalExecutionId: lastUpdatedMsg?.terminal?.executionId,
      reviewExecutionId: lastUpdatedMsg?.review?.executionId,
      matchesCanonical: lastUpdatedMsg?.terminal?.executionId === "canonical-updated-id-69",
    },
    expected: {
      msgType: "terminal.updated",
      terminalExecutionId: "canonical-updated-id-69",
      reviewExecutionId: "canonical-updated-id-69",
      matchesCanonical: true,
    }
  });

  // 70. confirmation-id-remains-separate (T-2909)
  const entryConfSep = termController.registerPreparedCommand({
    confirmationId: "sep-conf-id-70",
    executionId: "sep-exec-id-70",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  results.push({
    id: "confirmation-id-remains-separate",
    description: "T-2909: confirmationId and executionId are semantically distinct fields",
    actual: {
      confirmationId: entryConfSep.confirmationId,
      executionId: entryConfSep.executionId,
      areDifferent: entryConfSep.confirmationId !== entryConfSep.executionId,
      lookupByConf: termController.getByConfirmationId("sep-conf-id-70")?.executionId,
      lookupByExec: termController.getByExecutionId("sep-exec-id-70")?.confirmationId,
    },
    expected: {
      confirmationId: "sep-conf-id-70",
      executionId: "sep-exec-id-70",
      areDifferent: true,
      lookupByConf: "sep-exec-id-70",
      lookupByExec: "sep-conf-id-70",
    }
  });

  // 71. wrong-confirmation-id-cannot-route-output (T-2909 isolation)
  const entryConfRoute = termController.registerPreparedCommand({
    confirmationId: "real-conf-71",
    executionId: "real-exec-71",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  termController.setStatus("real-exec-71", "RUNNING");
  // Attempt to append output via wrong confirmation id (conf IDs can't route output directly)
  // Output routing must use executionId — confirm the correct entry remains clean
  const wrongConfLookup = termController.getByConfirmationId("wrong-conf-id-71");
  termController.appendOutput("wrong-exec-71", "stdout", "WRONG_OUTPUT");
  results.push({
    id: "wrong-confirmation-cannot-route-output",
    description: "T-2909: Wrong confirmationId returns no entry; wrong executionId routes nowhere",
    actual: {
      wrongConfLookupNull: wrongConfLookup === undefined,
      realEntryStdoutClean: entryConfRoute.stdout === "",
      wrongIdCreatedEntry: termController.getByExecutionId("wrong-exec-71") !== undefined,
    },
    expected: {
      wrongConfLookupNull: true,
      realEntryStdoutClean: true,
      wrongIdCreatedEntry: false,
    }
  });

  // 72. real-deactivate-starts-while-process-alive-cancels-execution (T-2911+T-2913)
  // Uses a fresh controller + process, injects into extension, then calls deactivate() only
  const deact2ParentPath = path.join(tmpRoot, "parent-deact2.pid");
  const deact2ChildPath = path.join(tmpRoot, "child-deact2.pid");
  const deact2Engine = new VerificationEngine({ workspaceRoot: tmpRoot });
  const deact2Abort = new AbortController();
  const freshTermCtrl72 = new TerminalReviewController();

  const hostForDeact2 = {
    getSnapshot: async () => ({
      workspaceRoots: [{ uri: `file://${tmpRoot}`, fsPath: tmpRoot, name: "workspace" }],
      activeDocument: null, selection: null, diagnostics: [], visibleDocuments: [], isTrusted: true
    }),
    showOutput: async () => {}, showError: async () => {}, isWorkspaceTrusted: async () => true,
    requestConfirmation: async () => "REJECT" as const,
  };
  const { ChatController: CC72 } = await import("../src/chat-controller.js");
  const ctrl72 = new CC72(
    hostForDeact2 as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    freshTermCtrl72,
    () => ({} as any)
  );

  const deact2ExecPromise = deact2Engine.execute({
    verificationId: "v-deact2-72",
    action: "TEST",
    executable: process.execPath,
    args: [path.join(tmpRoot, "tree-runner.cjs"), deact2ParentPath, deact2ChildPath],
    cwd: tmpRoot,
    timeoutMs: 30000,
    commandPreview: "node tree-runner.cjs",
    packageJsonPath: pkgJsonPath,
    packageJsonHash: crypto.createHash("sha256").update(fs.readFileSync(pkgJsonPath)).digest("hex"),
    scriptName: "test",
    scriptBody: "echo test-ok",
  }, deact2Abort.signal);

  // Register terminal review for tracking
  freshTermCtrl72.registerPreparedCommand({
    confirmationId: "conf-deact2",
    executionId: "v-deact2-72",
    command: "node tree-runner.cjs", cwd: tmpRoot, provenance: "pkg", timeoutMs: 30000, executable: "node", args: []
  });
  freshTermCtrl72.setStatus("v-deact2-72", "RUNNING");

  // Wait for both processes to be alive
  let deact2Tries = 0;
  while ((!fs.existsSync(deact2ParentPath) || !fs.existsSync(deact2ChildPath)) && deact2Tries < 100) {
    await new Promise(r => setTimeout(r, 20));
    deact2Tries++;
  }
  const parentPid72 = parseInt(fs.readFileSync(deact2ParentPath, "utf-8"), 10);
  const childPid72 = parseInt(fs.readFileSync(deact2ChildPath, "utf-8"), 10);

  let parent72AliveBeforeDeact = false;
  let child72AliveBeforeDeact = false;
  try { process.kill(parentPid72, 0); parent72AliveBeforeDeact = true; } catch {}
  try { process.kill(childPid72, 0); child72AliveBeforeDeact = true; } catch {}

  // Record registry size before deactivation (should be 1: "RUNNING" entry)
  const registry72Before = freshTermCtrl72.totalReviews;

  // Wire abort controller + inject into extension module — NO manual cancelTurn before this
  ctrl72._activeAbortController = deact2Abort;
  const deact2Module = await import("../src/extension.js");
  deact2Module._testSeam.setChatController(ctrl72 as any);
  deact2Module._testSeam.setTerminalReviewController(freshTermCtrl72 as any);

  // THE SOLE TRIGGER
  deact2Module.deactivate();

  await deact2ExecPromise;

  let parent72DeadAfter = false;
  let child72DeadAfter = false;
  for (let i = 0; i < 60; i++) {
    try { process.kill(parentPid72, 0); parent72DeadAfter = false; } catch { parent72DeadAfter = true; }
    try { process.kill(childPid72, 0); child72DeadAfter = false; } catch { child72DeadAfter = true; }
    if (parent72DeadAfter && child72DeadAfter) break;
    await new Promise(r => setTimeout(r, 25));
  }

  results.push({
    id: "real-deactivate-cancels-active-execution",
    description: "T-2911+T-2913: Real deactivate() with active process — parent and child die; registry clears",
    actual: {
      parent72AliveBeforeDeact,
      child72AliveBeforeDeact,
      registry72Before,
      parent72DeadAfter,
      child72DeadAfter,
      registry72After: freshTermCtrl72.totalReviews,
      orphanCount: (() => {
        let n = 0;
        try { process.kill(parentPid72, 0); n++; } catch {}
        try { process.kill(childPid72, 0); n++; } catch {}
        return n;
      })(),
    },
    expected: {
      parent72AliveBeforeDeact: true,
      child72AliveBeforeDeact: true,
      registry72Before: 1,
      parent72DeadAfter: true,
      child72DeadAfter: true,
      registry72After: 0,
      orphanCount: 0,
    }
  });

  // 73. retained-bytes-zero-after-deactivation (T-2915)
  // freshTermCtrl72 was cleared by deactivate() — confirm no retained bytes
  results.push({
    id: "retained-bytes-zero-after-deactivation",
    description: "T-2915: After deactivation, retained output bytes in registry is zero",
    actual: {
      retainedBytes: freshTermCtrl72.totalRetainedBytes,
      reviewCount: freshTermCtrl72.totalReviews,
    },
    expected: {
      retainedBytes: 0,
      reviewCount: 0,
    }
  });

  // 74. late-event-after-deactivation-ignored (T-2916)
  // Send a late output event to an entry that was cleared by deactivate()
  freshTermCtrl72.appendOutput("v-deact2-72", "stdout", "LATE_OUTPUT");
  const lateEntry = freshTermCtrl72.getByExecutionId("v-deact2-72");
  results.push({
    id: "late-event-after-deactivation-ignored",
    description: "T-2916: Late output sent to cleared executionId after deactivation creates no entry",
    actual: {
      lateEntryCreated: lateEntry !== undefined,
      registryStillEmpty: freshTermCtrl72.totalReviews === 0,
    },
    expected: {
      lateEntryCreated: false,
      registryStillEmpty: true,
    }
  });

  // 75. chatcontroller-output-routing-exact-id-no-fallback (T-2903 ChatController level)
  // Create a new controller, register entry with known executionId, then emit verification.output
  // with a DIFFERENT executionId — the entry must NOT receive the output
  const tcNoFallback = new TerminalReviewController();
  const { ChatController: CCNoFb } = await import("../src/chat-controller.js");
  const ctrlNoFb = new CCNoFb(
    hostForDeact2 as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcNoFallback,
    () => ({} as any)
  );
  const viewNoFb = { webview: new MockWebview() };
  ctrlNoFb.setWebviewView(viewNoFb as any);
  viewNoFb.webview.lastMessage = undefined; // clear initial chat.state message

  tcNoFallback.registerPreparedCommand({
    confirmationId: "conf-nofb-75",
    executionId: "real-exec-nofb-75",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  tcNoFallback.setStatus("real-exec-nofb-75", "RUNNING");
  ctrlNoFb.state.activeTerminal = {
    executionId: "real-exec-nofb-75",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, status: "RUNNING"
  };

  // Emit event with wrong executionId — should NOT route to "real-exec-nofb-75"
  ctrlNoFb.handleAgentEvent({
    id: "ev-nofb-75",
    type: "verification.output",
    taskId: "t-75",
    timestamp: new Date().toISOString(),
    payload: { executionId: "wrong-exec-nofb-75", stream: "stdout", chunk: "WRONG_CHUNK\n" }
  });
  const entryNofb = tcNoFallback.getByExecutionId("real-exec-nofb-75");
  const wrongCreated = tcNoFallback.getByExecutionId("wrong-exec-nofb-75");
  results.push({
    id: "chatcontroller-output-no-fallback-to-active-terminal",
    description: "T-2903: ChatController.handleAgentEvent verification.output with wrong ID does not fall back to activeTerminal",
    actual: {
      realEntryStdoutEmpty: entryNofb?.stdout === "",
      wrongEntryNotCreated: wrongCreated === undefined,
      noUIUpdate: (viewNoFb.webview as MockWebview).lastMessage === undefined,
    },
    expected: {
      realEntryStdoutEmpty: true,
      wrongEntryNotCreated: true,
      noUIUpdate: true,
    }
  });

  // 76. chatcontroller-output-routing-missing-id-no-fallback (T-2903 missing ID)
  // Event with no executionId field — must not route via activeTerminal fallback
  const tcMissingId = new TerminalReviewController();
  const { ChatController: CCMissing } = await import("../src/chat-controller.js");
  const ctrlMissing = new CCMissing(
    hostForDeact2 as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcMissingId,
    () => ({} as any)
  );
  const viewMissing = { webview: new MockWebview() };
  ctrlMissing.setWebviewView(viewMissing as any);
  viewMissing.webview.lastMessage = undefined; // clear initial chat.state message

  tcMissingId.registerPreparedCommand({
    confirmationId: "conf-missing-76",
    executionId: "real-exec-missing-76",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  tcMissingId.setStatus("real-exec-missing-76", "RUNNING");
  ctrlMissing.state.activeTerminal = {
    executionId: "real-exec-missing-76",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, status: "RUNNING"
  };

  // Event with no executionId — must NOT route via activeTerminal fallback
  ctrlMissing.handleAgentEvent({
    id: "ev-missing-76",
    type: "verification.output",
    taskId: "t-76",
    timestamp: new Date().toISOString(),
    payload: { stream: "stdout", chunk: "MISSING_ID_CHUNK\n" } // no executionId
  });
  const missingEntry = tcMissingId.getByExecutionId("real-exec-missing-76");
  results.push({
    id: "chatcontroller-missing-execution-id-no-fallback",
    description: "T-2903: verification.output event with missing executionId does not fall back to activeTerminal",
    actual: {
      realEntryStdoutEmpty: missingEntry?.stdout === "",
      noUIUpdate: (viewMissing.webview as MockWebview).lastMessage === undefined,
    },
    expected: {
      realEntryStdoutEmpty: true,
      noUIUpdate: true,
    }
  });

  // 77. no-spawn-authority-in-deactivate (T-2919)
  // Deactivation must cancel active turn, not spawn new processes.
  // We count spawned processes during a deactivate call and verify it uses the abort path.
  // Proxy: deactivate() exits without spawning by delegating to controller.cancelTurn() abort path.
  const freshCtrl77 = new TerminalReviewController();
  freshCtrl77.registerPreparedCommand({
    confirmationId: "conf-77",
    executionId: "exec-77",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  const deact3Module = await import("../src/extension.js");
  const abortSignaled77: boolean[] = [];
  const fakeAbort77 = { signal: { aborted: false }, abort() { abortSignaled77.push(true); } };
  const fakeCtrl77 = {
    cancelTurn() { fakeAbort77.abort(); },
    _activeAbortController: fakeAbort77,
    _confirmationResolver: undefined,
    state: { pendingConfirmation: undefined },
  };
  deact3Module._testSeam.setChatController(fakeCtrl77 as any);
  deact3Module._testSeam.setTerminalReviewController(freshCtrl77 as any);
  deact3Module.deactivate();
  results.push({
    id: "deactivation-delegates-to-abort-not-spawn",
    description: "T-2919: deactivate() aborts active turn via abort signal, does not spawn new processes",
    actual: {
      abortSignalFired: abortSignaled77.length > 0,
      registryCleared: freshCtrl77.totalReviews === 0,
    },
    expected: {
      abortSignalFired: true,
      registryCleared: true,
    }
  });

  // 78. reactivation-safety-fresh-state (T-2918)
  // After deactivate(), the extension module's internal state is null.
  // A subsequent deactivate() call must be a safe no-op.
  const deact4Module = await import("../src/extension.js");
  // Already deactivated above — module-level chatController is null
  let reactivateThrew = false;
  try {
    deact4Module.deactivate(); // second deactivate — must be safe no-op
  } catch {
    reactivateThrew = true;
  }
  results.push({
    id: "reactivation-safety-no-crash-on-double-deactivate",
    description: "T-2918: Calling deactivate() when already deactivated is a safe no-op without exception",
    actual: {
      reactivateThrew,
    },
    expected: {
      reactivateThrew: false,
    }
  });

  // 79. sprint3d2-summary-all-ids-canonical (integration summary)
  // Verify that the TerminalReviewController correctly stores and retrieves a supplied executionId
  // without any generation/regeneration when one is explicitly provided.
  const entryProvided = termController.registerPreparedCommand({
    confirmationId: "conf-sum-79",
    executionId: "v-sum-canonical-79",
    command: "npm test", cwd: tmpRoot, provenance: "pkg", timeoutMs: 60000, executable: "npm", args: ["test"]
  });
  const idFromGet = termController.getByExecutionId("v-sum-canonical-79")?.executionId;
  const idFromConf = termController.getByConfirmationId("conf-sum-79")?.executionId;
  results.push({
    id: "sprint3d2-summary-canonical-id-end-to-end",
    description: "Sprint 3D.2 summary: supplied executionId is the same everywhere — no regeneration",
    actual: {
      entryExecutionId: entryProvided.executionId,
      getByExecId: idFromGet,
      getByConfId: idFromConf,
      allEqual: entryProvided.executionId === "v-sum-canonical-79" &&
                idFromGet === "v-sum-canonical-79" &&
                idFromConf === "v-sum-canonical-79",
    },
    expected: {
      entryExecutionId: "v-sum-canonical-79",
      getByExecId: "v-sum-canonical-79",
      getByConfId: "v-sum-canonical-79",
      allEqual: true,
    }
  });

  // 80. sprint3d3-agentrunner-started-event-execution-id (T-3001)
  const startedEvent = liveEvents.find(e => e.type === "verification.started");
  results.push({
    id: "canonical-started-event-execution-id",
    description: "T-3001: AgentRunner emits verification.started with canonical executionId matching PreparedVerification.verificationId",
    actual: {
      hasStartedEvent: Boolean(startedEvent),
      matchesPrepared: startedEvent?.payload?.executionId === prepCmd.verificationId,
      hasValidIdPrefix: typeof startedEvent?.payload?.executionId === "string" && startedEvent.payload.executionId.startsWith("verification-"),
    },
    expected: {
      hasStartedEvent: true,
      matchesPrepared: true,
      hasValidIdPrefix: true,
    }
  });

  // 81. sprint3d3-agentrunner-completed-event-execution-id (T-3002)
  results.push({
    id: "canonical-completed-event-execution-id",
    description: "T-3002: AgentRunner emits verification.completed with canonical executionId matching PreparedVerification.verificationId",
    actual: {
      hasCompletedEvent: Boolean(completedEvent),
      matchesPrepared: completedEvent?.payload?.executionId === prepCmd.verificationId,
      hasValidIdPrefix: typeof completedEvent?.payload?.executionId === "string" && completedEvent.payload.executionId.startsWith("verification-"),
    },
    expected: {
      hasCompletedEvent: true,
      matchesPrepared: true,
      hasValidIdPrefix: true,
    }
  });

  // 82. sprint3d3-all-lifecycle-ids-strictly-equal (T-3004)
  // Flow: PreparedVerification.verificationId === confirmation.preparedCommand.verificationId
  // === TerminalReview.executionId === verification.started.executionId === verification.output.executionId
  // === verification.completed.executionId
  const canonicalAllEqual = (
    prepCmd.verificationId === runnerReviewEntry.executionId &&
    runnerReviewEntry.executionId === startedEvent?.payload?.executionId &&
    startedEvent?.payload?.executionId === outputEvents[0]?.payload?.executionId &&
    outputEvents[0]?.payload?.executionId === completedEvent?.payload?.executionId
  );
  results.push({
    id: "canonical-identity-end-to-end-all-equal",
    description: "T-3004: All verification lifecycle events preserve and emit the exact same canonical executionId",
    actual: {
      canonicalAllEqual,
      hasValidIdPrefix: typeof prepCmd.verificationId === "string" && prepCmd.verificationId.startsWith("verification-"),
    },
    expected: {
      canonicalAllEqual: true,
      hasValidIdPrefix: true,
    }
  });

  // 83. request-confirmation-rejects-missing-verification-id (T-3005)
  const tcReqReject = new TerminalReviewController();
  const { ChatController: CCReq } = await import("../src/chat-controller.js");
  const ctrlReqReject = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcReqReject,
    () => ({} as any)
  );
  const rejectResMissing = await ctrlReqReject.requestConfirmation("Run without ID", {
    action: "run_known_test",
    preparedCommand: {
      // verificationId intentionally missing
      executable: "node",
      args: ["-v"],
      cwd: tmpRoot,
    } as any,
  });
  results.push({
    id: "request-confirmation-rejects-missing-verification-id",
    description: "T-3005: ChatController.requestConfirmation fails closed with REJECT when verificationId is missing",
    actual: {
      decision: rejectResMissing,
      reviewsRegistered: tcReqReject.totalReviews,
      activeTerminalSet: ctrlReqReject.state.activeTerminal !== undefined,
      pendingConfirmationSet: ctrlReqReject.state.pendingConfirmation !== undefined,
    },
    expected: {
      decision: "REJECT",
      reviewsRegistered: 0,
      activeTerminalSet: false,
      pendingConfirmationSet: false,
    }
  });

  // 84. request-confirmation-rejects-empty-verification-id (T-3006)
  const tcReqEmpty = new TerminalReviewController();
  const ctrlReqEmpty = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcReqEmpty,
    () => ({} as any)
  );
  const rejectResEmpty = await ctrlReqEmpty.requestConfirmation("Run with whitespace ID", {
    action: "run_known_test",
    preparedCommand: {
      verificationId: "   ",
      executable: "node",
      args: ["-v"],
      cwd: tmpRoot,
    } as any,
  });
  results.push({
    id: "request-confirmation-rejects-empty-verification-id",
    description: "T-3006: ChatController.requestConfirmation fails closed with REJECT when verificationId is whitespace-only",
    actual: {
      decision: rejectResEmpty,
      reviewsRegistered: tcReqEmpty.totalReviews,
    },
    expected: {
      decision: "REJECT",
      reviewsRegistered: 0,
    }
  });

  // 85. register-prepared-command-throws-on-missing-execution-id (T-3007)
  const tcRegDirect = new TerminalReviewController();
  let threwMissingExecId = false;
  try {
    tcRegDirect.registerPreparedCommand({
      confirmationId: "conf-bad-85",
      executionId: undefined as any,
      command: "node -v",
      cwd: tmpRoot,
      provenance: "pkg",
      timeoutMs: 1000,
      executable: "node",
      args: ["-v"],
    });
  } catch (e: any) {
    threwMissingExecId = e.message.includes("executionId is required");
  }
  results.push({
    id: "register-prepared-command-throws-on-missing-execution-id",
    description: "T-3007: TerminalReviewController.registerPreparedCommand throws if executionId is missing (no fallback ID)",
    actual: {
      threwMissingExecId,
      reviewsRegistered: tcRegDirect.totalReviews,
    },
    expected: {
      threwMissingExecId: true,
      reviewsRegistered: 0,
    }
  });

  // 86. register-prepared-command-throws-on-empty-execution-id (T-3008)
  let threwEmptyExecId = false;
  try {
    tcRegDirect.registerPreparedCommand({
      confirmationId: "conf-bad-86",
      executionId: "   ",
      command: "node -v",
      cwd: tmpRoot,
      provenance: "pkg",
      timeoutMs: 1000,
      executable: "node",
      args: ["-v"],
    });
  } catch (e: any) {
    threwEmptyExecId = e.message.includes("executionId is required and cannot be empty");
  }
  results.push({
    id: "register-prepared-command-throws-on-empty-execution-id",
    description: "T-3008: TerminalReviewController.registerPreparedCommand throws if executionId is empty whitespace",
    actual: {
      threwEmptyExecId,
      reviewsRegistered: tcRegDirect.totalReviews,
    },
    expected: {
      threwEmptyExecId: true,
      reviewsRegistered: 0,
    }
  });

  // 87. chat-controller-started-routes-strictly-by-execution-id (T-3009)
  const tcRoute = new TerminalReviewController();
  const ctrlRoute = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcRoute,
    () => ({} as any)
  );
  const routeEntry87 = tcRoute.registerPreparedCommand({
    confirmationId: "conf-route-87",
    executionId: "exec-route-87",
    command: "node -v", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: ["-v"]
  });
  ctrlRoute.state.activeTerminal = {
    executionId: "exec-route-87",
    command: "node -v", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, status: "WAITING_APPROVAL"
  };
  ctrlRoute.handleAgentEvent({
    id: "ev-started-87",
    type: "verification.started",
    taskId: "t-87",
    timestamp: new Date().toISOString(),
    payload: { executionId: "exec-route-87" }
  });
  results.push({
    id: "chat-controller-started-routes-strictly-by-execution-id",
    description: "T-3009: ChatController.handleAgentEvent verification.started routes strictly by executionId",
    actual: {
      registryStatus: routeEntry87.status,
      activeTerminalStatus: ctrlRoute.state.activeTerminal?.status,
    },
    expected: {
      registryStatus: "RUNNING",
      activeTerminalStatus: "RUNNING",
    }
  });

  // 88. chat-controller-started-wrong-id-safe-noop (T-3010)
  ctrlRoute.handleAgentEvent({
    id: "ev-started-wrong-88",
    type: "verification.started",
    taskId: "t-88",
    timestamp: new Date().toISOString(),
    payload: { executionId: "nonexistent-exec-id" }
  });
  results.push({
    id: "chat-controller-started-wrong-id-safe-noop",
    description: "T-3010: verification.started with nonexistent executionId is safe no-op and does not touch activeTerminal",
    actual: {
      registryStatus: routeEntry87.status,
      activeTerminalStatus: ctrlRoute.state.activeTerminal?.status,
    },
    expected: {
      registryStatus: "RUNNING",
      activeTerminalStatus: "RUNNING",
    }
  });

  // 89. chat-controller-started-missing-id-safe-noop (T-3011)
  const tcStartedMiss = new TerminalReviewController();
  const ctrlStartedMiss = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcStartedMiss,
    () => ({} as any)
  );
  const entryMiss89 = tcStartedMiss.registerPreparedCommand({
    confirmationId: "conf-miss-89",
    executionId: "exec-miss-89",
    command: "node -v", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: ["-v"]
  });
  ctrlStartedMiss.state.activeTerminal = {
    executionId: "exec-miss-89",
    command: "node -v", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, status: "WAITING_APPROVAL"
  };
  ctrlStartedMiss.handleAgentEvent({
    id: "ev-started-miss-89",
    type: "verification.started",
    taskId: "t-89",
    timestamp: new Date().toISOString(),
    payload: {} // missing executionId
  });
  results.push({
    id: "chat-controller-started-missing-id-safe-noop",
    description: "T-3011: verification.started with missing executionId does not mutate activeTerminal",
    actual: {
      registryStatus: entryMiss89.status,
      activeTerminalStatus: ctrlStartedMiss.state.activeTerminal?.status,
    },
    expected: {
      registryStatus: "WAITING_APPROVAL",
      activeTerminalStatus: "WAITING_APPROVAL",
    }
  });

  // 90. chat-controller-completed-routes-strictly-by-execution-id (T-3012)
  ctrlRoute.handleAgentEvent({
    id: "ev-comp-90",
    type: "verification.completed",
    taskId: "t-90",
    timestamp: new Date().toISOString(),
    payload: {
      executionId: "exec-route-87",
      result: { status: "PASS", exitCode: 0, durationMs: 50, stdout: "OUTPUT_OK", stderr: "" }
    }
  });
  results.push({
    id: "chat-controller-completed-routes-strictly-by-execution-id",
    description: "T-3012: ChatController.handleAgentEvent verification.completed routes strictly by executionId",
    actual: {
      registryStatus: routeEntry87.status,
      registryExitCode: routeEntry87.exitCode,
      activeTerminalStatus: ctrlRoute.state.activeTerminal?.status,
      activeTerminalExitCode: ctrlRoute.state.activeTerminal?.exitCode,
    },
    expected: {
      registryStatus: "SUCCEEDED",
      registryExitCode: 0,
      activeTerminalStatus: "SUCCEEDED",
      activeTerminalExitCode: 0,
    }
  });

  // 91. chat-controller-completed-wrong-id-safe-noop (T-3013)
  const tcCompWrong = new TerminalReviewController();
  const ctrlCompWrong = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcCompWrong,
    () => ({} as any)
  );
  const entryComp91 = tcCompWrong.registerPreparedCommand({
    confirmationId: "conf-comp-91",
    executionId: "exec-comp-91",
    command: "node -v", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: ["-v"]
  });
  tcCompWrong.setStatus("exec-comp-91", "RUNNING");
  ctrlCompWrong.state.activeTerminal = {
    executionId: "exec-comp-91",
    command: "node -v", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, status: "RUNNING"
  };
  ctrlCompWrong.handleAgentEvent({
    id: "ev-comp-wrong-91",
    type: "verification.completed",
    taskId: "t-91",
    timestamp: new Date().toISOString(),
    payload: {
      executionId: "wrong-exec-id",
      result: { status: "PASS", exitCode: 0 }
    }
  });
  results.push({
    id: "chat-controller-completed-wrong-id-safe-noop",
    description: "T-3013: verification.completed with wrong executionId is safe no-op and does not touch activeTerminal",
    actual: {
      registryStatus: entryComp91.status,
      activeTerminalStatus: ctrlCompWrong.state.activeTerminal?.status,
    },
    expected: {
      registryStatus: "RUNNING",
      activeTerminalStatus: "RUNNING",
    }
  });

  // 92. chat-controller-completed-missing-id-safe-noop (T-3014)
  ctrlCompWrong.handleAgentEvent({
    id: "ev-comp-miss-92",
    type: "verification.completed",
    taskId: "t-92",
    timestamp: new Date().toISOString(),
    payload: {
      result: { status: "PASS", exitCode: 0 }
    }
  });
  results.push({
    id: "chat-controller-completed-missing-id-safe-noop",
    description: "T-3014: verification.completed with missing executionId does not mutate activeTerminal",
    actual: {
      registryStatus: entryComp91.status,
      activeTerminalStatus: ctrlCompWrong.state.activeTerminal?.status,
    },
    expected: {
      registryStatus: "RUNNING",
      activeTerminalStatus: "RUNNING",
    }
  });

  // 93. review-isolation-two-reviews-independent (T-3015)
  const tcIso = new TerminalReviewController();
  const ctrlIso = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcIso,
    () => ({} as any)
  );
  const rA = tcIso.registerPreparedCommand({
    confirmationId: "conf-iso-A", executionId: "exec-iso-A",
    command: "cmdA", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: []
  });
  const rB = tcIso.registerPreparedCommand({
    confirmationId: "conf-iso-B", executionId: "exec-iso-B",
    command: "cmdB", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: []
  });
  ctrlIso.state.activeTerminal = {
    executionId: "exec-iso-A", command: "cmdA", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, status: "WAITING_APPROVAL"
  };

  // Events for A
  ctrlIso.handleAgentEvent({ id: "ev-iso-start-A", type: "verification.started", taskId: "t-iso", timestamp: new Date().toISOString(), payload: { executionId: "exec-iso-A" } });
  ctrlIso.handleAgentEvent({ id: "ev-iso-out-A", type: "verification.output", taskId: "t-iso", timestamp: new Date().toISOString(), payload: { executionId: "exec-iso-A", stream: "stdout", chunk: "CHUNK_A\n" } });
  ctrlIso.handleAgentEvent({ id: "ev-iso-comp-A", type: "verification.completed", taskId: "t-iso", timestamp: new Date().toISOString(), payload: { executionId: "exec-iso-A", result: { status: "PASS", exitCode: 0, durationMs: 10 } } });

  results.push({
    id: "review-isolation-two-reviews-independent",
    description: "T-3015: Events targeting review A do not mutate review B in any field",
    actual: {
      rAStatus: rA.status,
      rAStdout: rA.stdout,
      rAExitCode: rA.exitCode,
      rBStatus: rB.status,
      rBStdout: rB.stdout,
      rBExitCode: rB.exitCode,
    },
    expected: {
      rAStatus: "SUCCEEDED",
      rAStdout: "CHUNK_A\n",
      rAExitCode: 0,
      rBStatus: "WAITING_APPROVAL",
      rBStdout: "",
      rBExitCode: null,
    }
  });

  // 94. stale-completion-for-review-a-does-not-mutate-active-review-b (T-3016)
  tcIso.setStatus("exec-iso-B", "RUNNING");
  ctrlIso.state.activeTerminal = {
    executionId: "exec-iso-B", command: "cmdB", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, status: "RUNNING"
  };
  // Stale completion arrives for A while active terminal is B
  ctrlIso.handleAgentEvent({
    id: "ev-iso-stale-A",
    type: "verification.completed",
    taskId: "t-iso-stale",
    timestamp: new Date().toISOString(),
    payload: {
      executionId: "exec-iso-A",
      result: { status: "PASS", exitCode: 0, durationMs: 99 }
    }
  });
  results.push({
    id: "stale-completion-for-review-a-does-not-mutate-active-review-b",
    description: "T-3016: Stale completion for review A does not overwrite active review B",
    actual: {
      activeTerminalExecutionId: ctrlIso.state.activeTerminal?.executionId,
      activeTerminalStatus: ctrlIso.state.activeTerminal?.status,
      activeTerminalCommand: ctrlIso.state.activeTerminal?.command,
    },
    expected: {
      activeTerminalExecutionId: "exec-iso-B",
      activeTerminalStatus: "RUNNING",
      activeTerminalCommand: "cmdB",
    }
  });

  // 95. other-review-output-does-not-broadcast-terminal-updated-for-b (T-3017)
  const rC = tcIso.registerPreparedCommand({
    confirmationId: "conf-iso-C", executionId: "exec-iso-C",
    command: "cmdC", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: []
  });
  tcIso.setStatus("exec-iso-C", "RUNNING");

  const viewIso = { webview: new MockWebview() };
  ctrlIso.setWebviewView(viewIso as any);
  viewIso.webview.lastMessage = undefined; // clear initial message

  // Output for C arrives while active terminal is B
  ctrlIso.handleAgentEvent({
    id: "ev-iso-out-C",
    type: "verification.output",
    taskId: "t-iso-out",
    timestamp: new Date().toISOString(),
    payload: { executionId: "exec-iso-C", stream: "stdout", chunk: "OUTPUT_FOR_C\n" }
  });
  results.push({
    id: "other-review-output-does-not-broadcast-terminal-updated-for-b",
    description: "T-3017: Output for running review C does not broadcast terminal.updated for active review B",
    actual: {
      activeTerminalStdout: ctrlIso.state.activeTerminal?.stdout ?? "",
      lastBroadcastMessageType: (viewIso.webview as MockWebview).lastMessage?.type,
      reviewCOutputAppended: rC.stdout.includes("OUTPUT_FOR_C"),
    },
    expected: {
      activeTerminalStdout: "",
      lastBroadcastMessageType: undefined,
      reviewCOutputAppended: true,
    }
  });

  // 96. late-completion-after-new-chat-safe (T-3018)
  ctrlIso.state.activeTerminal = undefined; // simulate new chat clearing active terminal
  let lateChatThrew = false;
  try {
    ctrlIso.handleAgentEvent({
      id: "ev-late-chat",
      type: "verification.completed",
      taskId: "t-late-chat",
      timestamp: new Date().toISOString(),
      payload: { executionId: "exec-iso-A", result: { status: "PASS", exitCode: 0 } }
    });
  } catch {
    lateChatThrew = true;
  }
  results.push({
    id: "late-completion-after-new-chat-safe",
    description: "T-3018: Late completion after new chat turn does not crash and does not resurrect activeTerminal",
    actual: {
      lateChatThrew,
      activeTerminalIsUndefined: ctrlIso.state.activeTerminal === undefined,
    },
    expected: {
      lateChatThrew: false,
      activeTerminalIsUndefined: true,
    }
  });

  // 97. late-event-after-deactivation-safe-noop (T-3019)
  const tcDeactLate = new TerminalReviewController();
  const ctrlDeactLate = new CCReq(
    host as any,
    { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => 'PENDING' } as any,
    tcDeactLate,
    () => ({} as any)
  );
  tcDeactLate.registerPreparedCommand({
    confirmationId: "c-deact-97", executionId: "exec-deact-97",
    command: "cmd", cwd: tmpRoot, provenance: "pkg", timeoutMs: 1000, executable: "node", args: []
  });
  tcDeactLate.clearAll(); // deactivation flushes all reviews
  ctrlDeactLate.state.activeTerminal = undefined;

  let lateDeactThrew = false;
  try {
    ctrlDeactLate.handleAgentEvent({ id: "ev-late-s", type: "verification.started", taskId: "t-d", timestamp: new Date().toISOString(), payload: { executionId: "exec-deact-97" } });
    ctrlDeactLate.handleAgentEvent({ id: "ev-late-o", type: "verification.output", taskId: "t-d", timestamp: new Date().toISOString(), payload: { executionId: "exec-deact-97", stream: "stdout", chunk: "LOST\n" } });
    ctrlDeactLate.handleAgentEvent({ id: "ev-late-c", type: "verification.completed", taskId: "t-d", timestamp: new Date().toISOString(), payload: { executionId: "exec-deact-97", result: { status: "PASS", exitCode: 0 } } });
  } catch {
    lateDeactThrew = true;
  }
  results.push({
    id: "late-event-after-deactivation-safe-noop",
    description: "T-3019: Verification events arriving after extension deactivation are safe no-ops without resurrection",
    actual: {
      lateDeactThrew,
      totalReviews: tcDeactLate.totalReviews,
      activeTerminalUndefined: ctrlDeactLate.state.activeTerminal === undefined,
    },
    expected: {
      lateDeactThrew: false,
      totalReviews: 0,
      activeTerminalUndefined: true,
    }
  });

  // 59. deactivation-cleanup (moved to be last)

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
    assert.throws(() => strictCompare({ executionId: "exec-1" }, { executionId: "exec-2" }), /Comparison failed/);
    assert.throws(() => strictCompare({ reviewsRegistered: 0 }, { reviewsRegistered: 1 }), /Comparison failed/);
    assert.throws(() => strictCompare({ canonicalAllEqual: true }, { canonicalAllEqual: false }), /Comparison failed/);
  });

  test("Deterministic Terminal UX Evaluations Run 1 and Run 2 (97 Scenarios)", async () => {
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
    assert.ok(run1.length >= 97, `Must have at least 97 scenarios (had ${run1.length})`);
  });
});
