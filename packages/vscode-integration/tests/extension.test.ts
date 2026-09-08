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
    
    let bridgeCalled = false;
    let bridgeMode = "";
    let providerCalls = 0;
    
    ext._testSeam.bridgeFactory = (options: any) => {
       return {
          runTask: async (instruction: string, mode: string, signal: AbortSignal) => {
             bridgeCalled = true;
             bridgeMode = mode;
             providerCalls++;
          }
       };
    };
    
    const askCommand = mockVscode.commands.registered['open-vs-code.ask'];
    
    // Activation safety: 0 calls
    assert.strictEqual(bridgeCalled, false);
    
    await askCommand();
    
    assert.strictEqual(bridgeCalled, true, "Bridge runTask should be called");
    assert.strictEqual(bridgeMode, "ASK", "Should be ASK mode");
    assert.strictEqual(providerCalls, 1, "Provider calls = 1");
    assert.strictEqual(ext._testSeam.activeBridge, null, "Active session cleared");
    
    ext._testSeam.bridgeFactory = null;
  });

  test("deactivation cleanup", async () => {
    const ext = require("../src/extension.ts");
    let aborted = false;
    
    // Setup a fake active request
    ext.activate({ subscriptions: [] });
    const askCommand = mockVscode.commands.registered['open-vs-code.ask'];
    
    // Intercept bridge to just wait and check abort
    ext._testSeam.bridgeFactory = (options: any) => {
       return {
          runTask: async (instruction: string, mode: string, signal: AbortSignal) => {
             signal.addEventListener("abort", () => { aborted = true; });
             await new Promise(r => setTimeout(r, 100)); // wait a bit
          }
       };
    };
    
    // don't await, let it run in background
    askCommand();
    
    // give it a tick to start
    await new Promise(r => setImmediate(r));
    
    ext.deactivate();
    
    assert.strictEqual(aborted, true, "Active request should be aborted on deactivate");
    assert.strictEqual(ext._testSeam.activeBridge, null, "Bridge reference should be cleared");
    
    ext._testSeam.bridgeFactory = null;
  });
});

