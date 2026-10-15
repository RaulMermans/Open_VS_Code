import { test, describe, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openWorkspaceLearning } from "@open-vs-code/agent-core";

const extensionPath = mkdtempSync(join(tmpdir(), "ovsc-ext-learning-"));
cpSync(resolve(__dirname, "../../agent-core/skills/builtins"), join(extensionPath, "dist", "skills", "builtins"), { recursive: true });
const workspaceRoot = mkdtempSync(join(tmpdir(), "ovsc-ws-learning-"));

const settings = { learning: true };
const shown = { info: [] as string[], quickPicks: 0 };
let modalAnswer: string | undefined;

const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    activeTextEditor: null,
    visibleTextEditors: [],
    showErrorMessage: () => {},
    showWarningMessage: async () => undefined,
    showInformationMessage: async (message: string, options?: { modal?: boolean }) => {
      shown.info.push(message);
      return options?.modal ? modalAnswer : undefined;
    },
    showQuickPick: async (items: any[]) => {
      shown.quickPicks += 1;
      return items[0];
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspaceRoot, toString: () => `file://${workspaceRoot}` }, name: "workspace" }],
    isTrusted: true,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => (key === "learning.enabled" ? settings.learning : fallback) }),
    getWorkspaceFolder: () => null,
    asRelativePath: () => "f.ts",
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  },
  languages: {
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
    getDiagnostics: () => [],
    registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
  },
  commands: {
    registerCommand: (id: string, callback: any) => {
      mockVscode.commands.registered[id] = callback;
      return { dispose: () => {} };
    },
    executeCommand: async () => {},
    registered: {} as any,
  },
  ProgressLocation: { Notification: 15 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
};

describe("Learning review command (Sprint 5D)", () => {
  before(async () => {
    const service = await openWorkspaceLearning({ workspaceRoot, enabled: true, workspaceTrusted: true, builtinSkillIds: [] });
    const fact = { kind: "PROJECT_FACT" as const, source: "OBSERVED_OUTCOME" as const, title: "This project uses npm", summary: "package-lock.json is present.", evidenceRefs: ["file:package-lock.json"], outcome: "SUCCESS" as const }
    await service.observe([{ ...fact, taskId: "t1" }, { ...fact, taskId: "t2" }]);
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
    const ext = require("../src/extension.ts");
    ext.activate({ subscriptions: [] as any[], extensionPath, secrets: { get: async () => undefined, store: async () => {} } });
  });

  const store = () => JSON.parse(readFileSync(join(workspaceRoot, ".open-vs-code/learning/learning.json"), "utf8"));

  test("dismissing the review dialog approves nothing", async () => {
    modalAnswer = undefined;
    await mockVscode.commands.registered["open-vs-code.reviewLearningCandidates"]();
    assert.strictEqual(shown.quickPicks, 1);
    assert.ok(shown.info.some((message) => message.startsWith("Memory: This project uses npm")));
    assert.strictEqual(store().records[0].status, "CANDIDATE");
  });

  test("an explicit Approve approves the candidate", async () => {
    modalAnswer = "Approve";
    await mockVscode.commands.registered["open-vs-code.reviewLearningCandidates"]();
    assert.strictEqual(store().records[0].status, "APPROVED");
    assert.ok(shown.info.includes("Memory approved."));
  });

  test("with learning disabled the command explains and does nothing", async () => {
    settings.learning = false;
    const before = shown.quickPicks;
    await mockVscode.commands.registered["open-vs-code.reviewLearningCandidates"]();
    assert.strictEqual(shown.quickPicks, before);
    assert.ok(shown.info.at(-1)!.includes("Learning is disabled"));
  });
});
