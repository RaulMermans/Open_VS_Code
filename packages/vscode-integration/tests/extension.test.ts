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
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }), onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} })
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace", toString: () => "file:///test/workspace" }, name: "workspace" }],
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    getWorkspaceFolder: () => null,
    asRelativePath: () => "f.ts",
    findFiles: async () => [],
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} })
  },
  Uri: {
    file: (s: string) => ({ fsPath: s, toString: () => "file://" + s }),
    joinPath: (base: any, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/"), toString: () => "file://" + [base.fsPath, ...parts].join("/") }),
  },
  languages: {
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
    getDiagnostics: () => [],
    registerInlineCompletionItemProvider: (selector: any, provider: any) => {
      mockVscode.languages.registeredProviders.push({ selector, provider });
      return { dispose: () => {} };
    },
    registeredProviders: [] as any[],
  },

  commands: {
    registerCommand: (id: string, callback: any) => {
      mockVscode.commands.registered[id] = callback;
      return { dispose: () => {} };
    },
    executeCommand: async () => {},
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
  
  test("explicit ASK focuses chat and sets mode without model call, send triggers bridge", async () => {
    const ext = require("../src/extension.ts");
    const context = { subscriptions: [] as any[] };
    ext.activate(context);
    
    let bridgeCalled = false;
    let bridgeMode = "";
    let bridgeCalls = 0;
    
    ext._testSeam.bridgeFactory = (options: any) => {
       return {
          runTask: async (instruction: string, mode: string, signal: AbortSignal) => {
             bridgeCalled = true;
             bridgeMode = mode;
             bridgeCalls++;
             return { status: "COMPLETED", turns: 1, finalState: { status: "COMPLETED", events: [] }, events: [], contextDiagnostics: [], toolCalls: [] };
          }
       };
    };
    
    const askCommand = mockVscode.commands.registered['open-vs-code.ask'];
    
    assert.strictEqual(bridgeCalled, false, "No bridge invocations at activation");
    
    await askCommand();
    
    assert.strictEqual(bridgeCalled, false, "Command should only reveal UI, not invoke bridge");
    
    // Simulate webview send
    const chatController = ext._testSeam.chatController;
    await chatController.handleWebviewMessage({ type: 'chat.send', text: 'test', mode: 'ASK' });
    
    assert.strictEqual(bridgeCalled, true, "Bridge runTask should be called");
    assert.strictEqual(bridgeMode, "ASK", "Should be ASK mode");
    assert.strictEqual(bridgeCalls, 1, "Bridge stub calls = 1");
    assert.strictEqual(chatController['_activeSessionBridge'], undefined, "Active session cleared after task completes");
    
    ext._testSeam.bridgeFactory = null;
  });

  test("deactivation cleanup", async () => {
    const ext = require("../src/extension.ts");
    let aborted = false;
    
    ext.activate({ subscriptions: [] });
    
    ext._testSeam.bridgeFactory = (options: any) => {
       return {
          runTask: async (instruction: string, mode: string, signal: AbortSignal) => {
             signal.addEventListener("abort", () => { aborted = true; });
             await new Promise(r => setTimeout(r, 100)); // wait a bit
             return { status: "CANCELLED", turns: 0, finalState: { status: "CANCELLED", events: [] }, events: [], contextDiagnostics: [], toolCalls: [] };
          }
       };
    };
    
    const chatController = ext._testSeam.chatController;
    chatController.handleWebviewMessage({ type: 'chat.send', text: 'test', mode: 'ASK' });
    
    for (let i = 0; i < 50; i++) {
      if (chatController['_activeAbortController']) break;
      await new Promise(r => setTimeout(r, 10));
    }
    
    await ext.deactivate();
    
    assert.strictEqual(aborted, true, "Active request should be aborted on deactivate");
    assert.strictEqual(ext._testSeam.chatController, null, "Chat controller reference should be cleared");
    
    ext._testSeam.bridgeFactory = null;
  });
});

