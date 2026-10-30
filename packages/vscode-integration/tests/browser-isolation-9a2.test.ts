import { test, describe, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";

describe("Sprint 9A.2 — VS Code Extension Browser Session Isolation (Workspaces & Accounts)", () => {
  let tmpRoot: string;
  let workspaceA: string;
  let workspaceB: string;
  let globalStoragePath: string;
  let fakeBrowserBin: string;
  let prevBrowserEnv: string | undefined;

  let workspaceFolderListeners: Array<() => void> = [];
  let configChangeListeners: Array<(e: any) => void> = [];
  let currentWorkspacePath = "";
  let isTrustedState = true;
  const perWorkspaceOrigins = new Map<string, string[]>();

  const mockVscode = {
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
      activeTextEditor: null,
      visibleTextEditors: [],
      showErrorMessage: () => {},
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => "Reject",
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
      onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
      registerWebviewViewProvider: () => ({ dispose: () => {} }),
    },
    workspace: {
      get workspaceFolders() {
        return currentWorkspacePath
          ? [{ uri: { fsPath: currentWorkspacePath, toString: () => `file://${currentWorkspacePath}` }, name: path.basename(currentWorkspacePath) }]
          : [];
      },
      get isTrusted() {
        return isTrustedState;
      },
      getConfiguration: (_section: string, scopeUri?: { fsPath?: string }) => {
        const keyPath = scopeUri?.fsPath ? path.resolve(scopeUri.fsPath) : path.resolve(currentWorkspacePath || "/");
        return {
          get: (key: string, fallback: unknown) => {
            if (key === "browser.allowedOrigins") {
              return perWorkspaceOrigins.get(keyPath) ?? fallback;
            }
            if (key === "browser.headless") {
              return true;
            }
            return fallback;
          },
        };
      },
      getWorkspaceFolder: () => null,
      asRelativePath: (u: any) => String(u?.fsPath || u),
      findFiles: async () => [],
      registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
      onDidChangeWorkspaceFolders: (cb: () => void) => {
        workspaceFolderListeners.push(cb);
        return { dispose: () => {} };
      },
      onDidChangeConfiguration: (cb: (e: any) => void) => {
        configChangeListeners.push(cb);
        return { dispose: () => {} };
      },
    },
    Uri: {
      file: (s: string) => ({ fsPath: s, toString: () => `file://${s}` }),
      joinPath: (base: any, ...parts: string[]) => ({
        fsPath: path.join(base.fsPath, ...parts),
        toString: () => `file://${path.join(base.fsPath, ...parts)}`,
      }),
    },
    languages: {
      onDidChangeDiagnostics: () => ({ dispose: () => {} }),
      getDiagnostics: () => [],
      registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
    },
    commands: {
      registered: {} as Record<string, (...args: any[]) => any>,
      registerCommand: (id: string, cb: (...args: any[]) => any) => {
        mockVscode.commands.registered[id] = cb;
        return { dispose: () => {} };
      },
      executeCommand: async () => undefined,
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  };

  let ext: any;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-ext-browser-iso-"));
    workspaceA = path.join(tmpRoot, "workspace-alpha");
    workspaceB = path.join(tmpRoot, "workspace-beta");
    globalStoragePath = path.join(tmpRoot, "global-storage");
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
    fs.mkdirSync(globalStoragePath, { recursive: true });

    // Create dummy executable marker so detectBrowserProvisioning() resolves READY even without launching Chromium
    fakeBrowserBin = path.join(tmpRoot, "fake-chromium-bin");
    fs.writeFileSync(fakeBrowserBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    prevBrowserEnv = process.env.OPEN_VS_CODE_BROWSER_EXECUTABLE;
    process.env.OPEN_VS_CODE_BROWSER_EXECUTABLE = fakeBrowserBin;

    currentWorkspacePath = workspaceA;
    perWorkspaceOrigins.set(path.resolve(workspaceA), ["http://127.0.0.1:3001"]);
    perWorkspaceOrigins.set(path.resolve(workspaceB), ["http://127.0.0.1:4002"]);

    const originalResolveFilename = (Module as any)._resolveFilename;
    (Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
      if (request === "vscode") return "vscode";
      return originalResolveFilename.call(this, request, ...rest);
    };
    const originalRequire = (Module as any).prototype.require;
    (Module as any).prototype.require = function (id: string) {
      if (id === "vscode") return mockVscode;
      return originalRequire.call(this, id);
    };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ext = require("../src/extension.ts");
  });

  after(async () => {
    if (ext?.deactivate) {
      await ext.deactivate();
    }
    if (prevBrowserEnv === undefined) {
      delete process.env.OPEN_VS_CODE_BROWSER_EXECUTABLE;
    } else {
      process.env.OPEN_VS_CODE_BROWSER_EXECUTABLE = prevBrowserEnv;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("1. Activating extension and rendering Integrations panel does NOT launch browser or allocate active session", async () => {
    workspaceFolderListeners = [];
    configChangeListeners = [];
    isTrustedState = true;
    currentWorkspacePath = workspaceA;

    const secretMap = new Map<string, string>();
    const context = {
      subscriptions: [] as any[],
      extensionUri: { fsPath: tmpRoot, toString: () => `file://${tmpRoot}` },
      extensionPath: tmpRoot,
      storageUri: { fsPath: path.join(tmpRoot, "ws-storage") },
      globalStorageUri: { fsPath: globalStoragePath },
      globalState: {
        get: (_k: string, d?: any) => d,
        update: async () => {},
      },
      secrets: {
        get: async (k: string) => secretMap.get(k),
        store: async (k: string, v: string) => { secretMap.set(k, v); },
        delete: async (k: string) => { secretMap.delete(k); },
      },
    };

    ext.activate(context);

    // Inspecting capabilities for the Integrations Hub must NOT instantiate or start BrowserSessionManager
    const hub = ext._testSeam.integrationManager;
    assert.ok(hub, "IntegrationManagerController should be initialized");
    const capSnap = await hub.getProductionCapabilitySnapshot();
    assert.ok(capSnap.availableTools.some((t: any) => t.name === "browser_open"));
    assert.strictEqual(
      ext._testSeam.activeBrowserSessionManager,
      null,
      "Rendering/querying Integrations Hub must never allocate or launch a BrowserSessionManager"
    );
  });

  test("2. Two real workspaces and two account identities remain strictly isolated and invalidate prior sessions", async () => {
    const getMgr = ext._testSeam.getGovernedBrowserSessionManager as (
      ws: string,
      acc?: string
    ) => any;

    // Account Alice in Workspace A
    const aliceWsA = getMgr(workspaceA, "account-alice");
    assert.ok(aliceWsA);
    assert.strictEqual(aliceWsA.getStatus(), "UNINITIALIZED", "Lazy creation must not launch Chromium eagerly");
    assert.strictEqual(aliceWsA.getAccountId(), "account-alice");
    assert.strictEqual(aliceWsA.getWorkspaceRoot(), path.resolve(workspaceA));

    const invalidatedEvents: Array<{ sessionId: string; reason: unknown }> = [];
    aliceWsA.onEvent((ev: any) => {
      if (ev.type === "session_invalidated") {
        invalidatedEvents.push({ sessionId: ev.sessionId, reason: ev.details.reason });
      }
    });

    // Same workspace + same account reuses exact scoped manager
    const aliceWsASame = getMgr(workspaceA, "account-alice");
    assert.strictEqual(aliceWsASame, aliceWsA);

    // Switching to Workspace B for Alice MUST invalidate and dispose Workspace A's session
    const aliceWsB = getMgr(workspaceB, "account-alice");
    assert.ok(aliceWsB);
    assert.notStrictEqual(aliceWsB.getSessionId(), aliceWsA.getSessionId());
    assert.strictEqual(aliceWsA.getStatus(), "CLOSED", "Workspace A session must be closed on workspace switch");
    assert.ok(
      invalidatedEvents.some((e) => e.sessionId === aliceWsA.getSessionId() && e.reason === "workspace_change"),
      "Must emit session_invalidated with workspace_change"
    );

    // Switching from Account Alice to Account Bob in Workspace B MUST invalidate Alice's Workspace B session
    let aliceWsBInvalidatedReason: unknown;
    aliceWsB.onEvent((ev: any) => {
      if (ev.type === "session_invalidated") {
        aliceWsBInvalidatedReason = ev.details.reason;
      }
    });

    const bobWsB = getMgr(workspaceB, "account-bob");
    assert.ok(bobWsB);
    assert.notStrictEqual(bobWsB.getSessionId(), aliceWsB.getSessionId());
    assert.strictEqual(bobWsB.getAccountId(), "account-bob");
    assert.strictEqual(aliceWsB.getStatus(), "CLOSED", "Alice session must close on switch to Bob");
    assert.strictEqual(aliceWsBInvalidatedReason, "account_switch");

    // Configuration change (stale browser.allowedOrigins protection) invalidates active session
    perWorkspaceOrigins.set(path.resolve(workspaceB), ["http://127.0.0.1:5005"]);
    for (const cb of configChangeListeners) {
      cb({ affectsConfiguration: (s: string) => s === "open-vs-code.browser" });
    }
    assert.strictEqual(bobWsB.getStatus(), "CLOSED", "Browser config change must invalidate cached session");
    assert.strictEqual(ext._testSeam.activeBrowserSessionManager, null);

    // Local-first anonymous session works without any authenticated account
    const anonLocal = getMgr(workspaceA);
    assert.ok(anonLocal);
    assert.strictEqual(anonLocal.getAccountId(), "anonymous");

    // Workspace folder change event disposes active session
    for (const cb of workspaceFolderListeners) {
      cb();
    }
    assert.strictEqual(anonLocal.getStatus(), "CLOSED");
    assert.strictEqual(ext._testSeam.activeBrowserSessionManager, null);

    // Untrusted workspace is strictly denied browser session authority
    const preTrustMgr = getMgr(workspaceA, "account-alice");
    assert.ok(preTrustMgr);
    isTrustedState = false;
    const untrustedMgr = getMgr(workspaceA, "account-alice");
    assert.strictEqual(untrustedMgr, undefined);
    assert.strictEqual(preTrustMgr.getStatus(), "CLOSED");
    isTrustedState = true;

    // Extension shutdown (deactivate) invalidates and disposes any active session
    const shutdownMgr = getMgr(workspaceA, "account-bob");
    assert.ok(shutdownMgr);
    let shutdownReason: unknown;
    shutdownMgr.onEvent((ev: any) => {
      if (ev.type === "session_invalidated") shutdownReason = ev.details.reason;
    });
    await ext.deactivate();
    assert.strictEqual(shutdownMgr.getStatus(), "CLOSED");
    assert.strictEqual(shutdownReason, "extension_shutdown");
    assert.strictEqual(ext._testSeam.activeBrowserSessionManager, null);
  });
});
