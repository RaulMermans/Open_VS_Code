import { test, describe, before, beforeEach } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceRoot = mkdtempSync(join(tmpdir(), "ovsc-ws-mcp-"));
mkdirSync(join(workspaceRoot, ".open-vs-code"), { recursive: true });

const mockMcpJson = {
  version: 2,
  servers: {
    "test-server": {
      name: "Test Runner",
      transport: "test",
      command: "test-cmd",
      enabled: true,
      policy: {
        allowedTools: ["test_tool"],
      },
    },
    "disabled-server": {
      name: "Disabled Server",
      transport: "test",
      command: "disabled-cmd",
      enabled: false,
    },
  },
};

writeFileSync(join(workspaceRoot, ".open-vs-code", "mcp.json"), JSON.stringify(mockMcpJson, null, 2));

const shown = {
  quickPicks: [] as any[],
  info: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
  output: [] as string[],
};

const mockSecretsStore = new Map<string, string>();

const mockVscode = {
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => shown.output.push(line),
      show: () => {},
      dispose: () => {},
    }),
    activeTextEditor: null,
    visibleTextEditors: [],
    showTextDocument: async () => {},
    showErrorMessage: (msg: string) => {
      shown.errors.push(msg);
      return Promise.resolve();
    },
    showWarningMessage: async (msg: string) => {
      shown.warnings.push(msg);
      return undefined;
    },
    showInformationMessage: async (message: string, ...items: any[]) => {
      shown.info.push(message);
      return items[0];
    },
    showQuickPick: async (items: any[], options: any) => {
      shown.quickPicks.push({ items, options });
      if (Array.isArray(items) && items.length > 0) {
        return items[0];
      }
      return undefined;
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: workspaceRoot, toString: () => `file://${workspaceRoot}` }, name: "workspace" },
    ],
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    getWorkspaceFolder: () => null,
    asRelativePath: () => "f.ts",
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    openTextDocument: async (uriOrPath: any) => ({
      uri: uriOrPath,
      getText: () => "{}",
    }),
    fs: {
      createDirectory: async () => {},
      writeFile: async () => {},
    },
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
    executeCommand: async (id: string, ...args: any[]) => {
      if (mockVscode.commands.registered[id]) {
        return mockVscode.commands.registered[id](...args);
      }
    },
    registered: {} as any,
  },
  Uri: {
    file: (f: string) => ({ fsPath: f, toString: () => `file://${f}` }),
  },
  ProgressLocation: { Notification: 15 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
};

describe("MCP VS Code Commands & Management (Sprint 8A)", () => {
  before(() => {
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
    ext.activate({
      subscriptions: [] as any[],
      extensionPath: workspaceRoot,
      secrets: {
        get: async (key: string) => mockSecretsStore.get(key),
        store: async (key: string, val: string) => {
          mockSecretsStore.set(key, val);
        },
        delete: async (key: string) => {
          mockSecretsStore.delete(key);
        },
      },
    });
  });

  beforeEach(() => {
    shown.quickPicks = [];
    shown.info = [];
    shown.warnings = [];
    shown.errors = [];
    shown.output = [];
  });

  test("1. VsCodeSecretProvider stores and retrieves secrets safely", async () => {
    const { VsCodeSecretProvider } = require("../src/mcp/mcp-vscode-secrets.ts");
    const secrets = {
      get: async (k: string) => mockSecretsStore.get(k),
      store: async (k: string, v: string) => {
        mockSecretsStore.set(k, v);
      },
      delete: async (k: string) => {
        mockSecretsStore.delete(k);
      },
    };
    const provider = new VsCodeSecretProvider(secrets as any);

    await provider.setSecret("test.token", "secret123");
    const val = await provider.getSecret("test.token");
    assert.strictEqual(val, "secret123");

    await provider.deleteSecret("test.token");
    const after = await provider.getSecret("test.token");
    assert.strictEqual(after, undefined);
  });

  test("2. open-vs-code.listMcpServers shows configured servers with state and transport", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.listMcpServers"]);
    await mockVscode.commands.registered["open-vs-code.listMcpServers"]();

    assert.ok(shown.quickPicks.length >= 1);
    const { items, options } = shown.quickPicks[0];
    assert.strictEqual(options.title, "Configured MCP Servers");
    assert.ok(items.some((item: any) => item.label.includes("Test Runner")));
    assert.ok(items.some((item: any) => item.label.includes("Disabled Server")));
  });

  test("3. open-vs-code.inspectMcpServer presents server lifecycle actions and metadata", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.inspectMcpServer"]);
    await mockVscode.commands.registered["open-vs-code.inspectMcpServer"]("test-server");

    assert.ok(shown.quickPicks.length >= 1);
    const { items, options } = shown.quickPicks[0];
    assert.ok(options.title.includes("MCP Server: Test Runner"));
    assert.ok(items.some((item: any) => item.action === "inspectTools"));
    assert.ok(items.some((item: any) => item.action === "refresh"));
    assert.ok(items.some((item: any) => item.action === "diagnostics"));
  });

  test("4. open-vs-code.openMcpConfig opens the configuration file", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.openMcpConfig"]);
    await mockVscode.commands.registered["open-vs-code.openMcpConfig"]();
    // Successfully opened text document
    assert.strictEqual(shown.errors.length, 0);
  });

  test("5. open-vs-code.connectMcpServer and disconnectMcpServer manage lifecycle", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.connectMcpServer"]);
    assert.ok(mockVscode.commands.registered["open-vs-code.disconnectMcpServer"]);

    // Disconnect server
    await mockVscode.commands.registered["open-vs-code.disconnectMcpServer"]("test-server");
    assert.ok(shown.info.some((m) => m.includes("Disconnected MCP server")));

    // Reconnect server
    await mockVscode.commands.registered["open-vs-code.connectMcpServer"]("test-server");
    assert.ok(shown.info.some((m) => m.includes("Connected to MCP server")));
  });

  test("6. open-vs-code.refreshMcpDiscovery reports server and tool discovery count", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.refreshMcpDiscovery"]);
    await mockVscode.commands.registered["open-vs-code.refreshMcpDiscovery"]();

    assert.ok(shown.info.some((m) => m.includes("MCP discovery refreshed")));
    assert.ok(shown.output.some((line) => line.includes("MCP discovery refreshed")));
  });

  test("7. open-vs-code.viewMcpDiagnostics reports clean status or actionable warnings", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.viewMcpDiagnostics"]);
    await mockVscode.commands.registered["open-vs-code.viewMcpDiagnostics"]();

    assert.ok(
      shown.info.some((m) => m.includes("All configured MCP servers")) ||
        shown.quickPicks.some((qp) => qp.options.title.includes("Diagnostics")),
    );
  });

  test("8. open-vs-code.inspectMcpTools displays tool security classification and schema", async () => {
    assert.ok(mockVscode.commands.registered["open-vs-code.inspectMcpTools"]);
    await mockVscode.commands.registered["open-vs-code.inspectMcpTools"]("test-server");

    // Since test-server in TestMcpTransport discovers test tools
    assert.ok(shown.info.length >= 1 || shown.quickPicks.length >= 1);
  });
});
