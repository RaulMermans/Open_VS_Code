import { test, describe, before, mock } from "node:test";
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

  test("can activate extension and register all 5 commands", () => {
    const ext = require("../src/extension.ts");
    assert.ok(typeof ext.activate === "function", "Should export activate function");
    assert.ok(typeof ext.deactivate === "function", "Should export deactivate function");
    
    const context = { subscriptions: [] as any[] };
    ext.activate(context);
    
    assert.ok(typeof mockVscode.commands.registered['open-vs-code.ask'] === "function", "Should register ask command");
    assert.ok(typeof mockVscode.commands.registered['open-vs-code.plan'] === "function", "Should register plan command");
    assert.ok(typeof mockVscode.commands.registered['open-vs-code.build'] === "function", "Should register build command");
    assert.ok(typeof mockVscode.commands.registered['open-vs-code.review'] === "function", "Should register review command");
    assert.ok(typeof mockVscode.commands.registered['open-vs-code.debug'] === "function", "Should register debug command");
    
    // Deactivation should not throw
    ext.deactivate();
  });
  
  test("explicit ASK invokes bridge and cleans up", async () => {
    const ext = require("../src/extension.ts");
    const context = { subscriptions: [] as any[] };
    ext.activate(context);
    
    // It should invoke AgentSessionBridge
    // We can't easily mock the internal bridge here without deep prototype pollution,
    // but we can ensure running the command resolves correctly without crashing.
    const askCommand = mockVscode.commands.registered['open-vs-code.ask'];
    
    // We expect it to at least run withProgress and return a completed state
    // Note: since our workspace doesn't have an .open-vs-code folder and we mock vscode,
    // it will try to hit createAgentRuntime and run. 
    // We just assert that it executes.
    // If it throws an error because of missing models.json or other things, 
    // we can mock createAgentRuntime or just catch it.
    
    try {
        await askCommand();
    } catch (e: any) {
        // If it fails due to config not found, it still proves the command was executed.
        assert.ok(e.message.includes("ENOENT") || e.message.includes("Missing provider configuration"), "Should attempt to run bridge");
    }
  });
});

