import { test, describe, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";

const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    activeTextEditor: null,
    visibleTextEditors: [],
    showErrorMessage: () => {},
    showWarningMessage: async () => "Approve",
    showInputBox: async () => "Test Instruction",
    withProgress: async (opts: any, task: any) => {
      const token = { onCancellationRequested: () => {} };
      const progress = { report: () => {} };
      return task(progress, token);
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} })
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace", toString: () => "file:///test/workspace" }, name: "workspace" }],
    isTrusted: true,
    getWorkspaceFolder: () => null,
    asRelativePath: () => "f.ts",
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} })
  },
  languages: {
    getDiagnostics: () => []
  },
  commands: {
    registerCommand: (id: string, callback: any) => {
      mockVscode.commands.registered[id] = callback;
      return { dispose: () => {} };
    },
    registered: {} as any
  },
  ProgressLocation: {
    Notification: 15
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
  }
};

describe("VS Code Extension Smoke Test", () => {
  before(() => {
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
  });

  test("can activate extension and register commands", () => {
    const ext = require("../src/extension.ts");
    assert.ok(typeof ext.activate === "function", "Should export activate function");
    assert.ok(typeof ext.deactivate === "function", "Should export deactivate function");
    
    ext.activate({ subscriptions: [] } as any);
    assert.ok(typeof mockVscode.commands.registered['open-vs-code.ask'] === "function", "Should register ask command");
  });
});
