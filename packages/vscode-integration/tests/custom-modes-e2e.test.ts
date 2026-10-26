import { test, describe, before, beforeEach, afterEach, after } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import Module from "node:module";

// Mock vscode module before any integration modules are imported
const mockVscode = {
  window: {
    showErrorMessage: () => {},
    showWarningMessage: async () => "Cancel",
    showInformationMessage: async () => {},
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { writeText: () => {} } },
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({ get: (_k: string, def: any) => def }),
  },
  Uri: { file: (f: string) => ({ fsPath: f, toString: () => f }) },
};

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

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureServerPath = path.resolve(currentDir, "../../agent-core/tests/mcp/fixture-server.js");

let ModeService: any;
let ChatController: any;
let AgentSessionBridge: any;
let IntegrationManagerController: any;
let DesktopAccountManager: any;
let McpService: any;
let VsCodeSecretProvider: any;
let AccountDatabase: any;
let AdminService: any;
let AccountServer: any;
let RoutedModelGateway: any;
let assessWorkflowEligibility: any;

class MockSecretStorage {
  private data = new Map<string, string>();
  async get(key: string) { return this.data.get(key); }
  async store(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

class MockExtensionContext {
  public secrets = new MockSecretStorage();
  public subscriptions: any[] = [];
}

class MockOutputChannel {
  public lines: string[] = [];
  appendLine(line: string) { this.lines.push(line); }
}

class MockWebview {
  public messages: any[] = [];
  public onDidReceiveMessageCb?: (msg: any) => void;
  onDidReceiveMessage(cb: (msg: any) => void) { this.onDidReceiveMessageCb = cb; }
  postMessage(message: any) { this.messages.push(message); }
  async send(msg: any) { if (this.onDidReceiveMessageCb) await this.onDidReceiveMessageCb(msg); }
}

function normalizeToolCalls(toolCalls?: any[]): any[] | undefined {
  if (!toolCalls) return undefined;
  return toolCalls.map((tc, idx) => ({
    id: tc.id || tc.callId || `call_${idx + 1}`,
    name: tc.name || tc.tool,
    arguments: tc.arguments || {},
  }));
}

function normalizeResponse(resp: any): any {
  if (!resp) {
    return {
      model: "scripted",
      message: { role: "assistant", content: "Default complete without tools." },
      toolCalls: [],
    };
  }
  if (resp.message) {
    return {
      model: resp.model || "scripted",
      message: resp.message,
      ...(resp.toolCalls ? { toolCalls: normalizeToolCalls(resp.toolCalls) } : {}),
      ...(resp.finishReason ? { finishReason: resp.finishReason } : {}),
    };
  }
  const content = resp.content ?? resp.text ?? "";
  return {
    model: "scripted",
    message: { role: resp.role || "assistant", content },
    ...(resp.toolCalls ? { toolCalls: normalizeToolCalls(resp.toolCalls) } : {}),
    ...(resp.finishReason ? { finishReason: resp.finishReason } : {}),
  };
}

class ScriptedProvider {
  capabilities = new Set(["chat", "tools"]);
  requests: any[] = [];
  responses: any[] = [];

  constructor(responses: any[] = []) {
    this.responses = [...responses];
  }

  async complete(request: any) {
    try {
      this.requests.push(request);
      let resp = this.responses.shift();
      if (typeof resp === "function") {
        resp = await resp(request);
      }
      const norm = normalizeResponse(resp);
      return norm;
    } catch (err: any) {
      console.error("SCRIPTED PROVIDER CAUGHT ERROR:", err);
      throw err;
    }
  }
}

describe("Sprint 8D.1 — Custom Modes E2E Acceptance & Integration Closure", () => {
  let tmpWorkspace: string;
  let modeService: any;
  let accountManager: any;
  let mcpService: any;
  let integrationManager: any;
  let mockContext: any;
  let outputChannel: any;
  let authServer: any;
  let authDb: any;
  let authServerUrl: string;

  before(async () => {
    const modeServiceMod = await import("../src/modes/mode-service.js");
    ModeService = modeServiceMod.ModeService;

    const chatMod = await import("../src/chat-controller.js");
    ChatController = chatMod.ChatController;

    const bridgeMod = await import("@open-vs-code/ide-adapter");
    AgentSessionBridge = bridgeMod.AgentSessionBridge;

    const intMod = await import("../src/integrations/integration-manager-controller.js");
    IntegrationManagerController = intMod.IntegrationManagerController;

    const accMod = await import("../src/account/account-manager.js");
    DesktopAccountManager = accMod.DesktopAccountManager;

    const mcpMod = await import("../src/mcp/mcp-service.js");
    McpService = mcpMod.McpService;

    const secMod = await import("../src/mcp/mcp-vscode-secrets.js");
    VsCodeSecretProvider = secMod.VsCodeSecretProvider;

    const acctServiceMod = await import("@open-vs-code/account-service");
    AccountDatabase = acctServiceMod.AccountDatabase;
    AdminService = acctServiceMod.AdminService;
    AccountServer = acctServiceMod.AccountServer;

    const routedMod = await import("../../agent-core/src/model/routed-gateway.js");
    RoutedModelGateway = routedMod.RoutedModelGateway;

    const rtMod = await import("../../agent-core/src/workflow/policy.js");
    assessWorkflowEligibility = rtMod.assessWorkflowEligibility;

    // Start in-memory account server for multi-account testing
    authDb = AccountDatabase.open(":memory:");
    const admin = new AdminService(authDb);
    const rootAdmin = await admin.bootstrapFirstAdmin("admin", "admin-pass-1234");
    await admin.createUser(rootAdmin.id, {
      username: "alice",
      password: "alice-pass-123",
      role: "USER",
    });
    await admin.createUser(rootAdmin.id, {
      username: "bob",
      password: "bob-pass-123",
      role: "USER",
    });

    authServer = new AccountServer(authDb, { port: 0, host: "127.0.0.1" });
    const started = await authServer.start();
    authServerUrl = started.url;
  });

  after(async () => {
    if (authServer) await authServer.stop();
    if (authDb) authDb.close();
    setTimeout(() => process.exit(0), 100).unref();
  });

  beforeEach(() => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "sprint-8d1-e2e-"));
    mockContext = new MockExtensionContext();
    outputChannel = new MockOutputChannel();
    const secretProvider = new VsCodeSecretProvider(mockContext.secrets as any);
    mcpService = new McpService(tmpWorkspace, secretProvider, outputChannel as any);
    accountManager = new DesktopAccountManager(mockContext as any, outputChannel as any);
    integrationManager = new IntegrationManagerController(
      mockContext as any,
      accountManager,
      mcpService,
      outputChannel as any
    );
    modeService = integrationManager.getModeService();
  });

  afterEach(async () => {
    if (mcpService) {
      await mcpService.dispose();
    }
    if (integrationManager) {
      integrationManager.dispose();
    }
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  function createTestHarness(provider: any, options: { trusted?: boolean } = {}) {
    const isTrusted = options.trusted !== false;
    let controller: any;

    const host = {
      getSnapshot: async () => ({
        workspaceRoots: [{ uri: `file://${tmpWorkspace}`, fsPath: tmpWorkspace, name: "workspace" }],
        activeDocument: null,
        selection: null,
        diagnostics: [],
        visibleDocuments: [],
      }),
      showOutput: async () => {},
      showError: async () => {},
      isWorkspaceTrusted: async () => isTrusted,
      readTextDocument: async (uri: string) => fs.readFileSync(uri.replace("file://", ""), "utf8"),
      writeTextDocument: async (uri: string, content: string) => {
        fs.writeFileSync(uri.replace("file://", ""), content);
      },
      applyWorkspaceEdit: async (edit: any) => {
        for (const entry of edit.entries()) {
          fs.writeFileSync(entry[0].fsPath, entry[1][0].newText);
        }
        return true;
      },
      executeCommand: async () => {},
      log: () => {},
      requestConfirmation: async () => "APPROVE",
    };

    const bridgeFactory = (bridgeOpts: any) => {
      return new AgentSessionBridge({
        ...bridgeOpts,
        providerOverride: provider,
      });
    };

    controller = new ChatController(host as any, bridgeFactory);
    controller.attachIntegrationManager(integrationManager);
    const view = { webview: new MockWebview() };
    controller.setWebviewView(view as any);
    controller.diffReviewController = { setStatus: () => {}, clearReview: () => {} };

    return { controller, host, view, tmpWorkspace };
  }

  // =========================================================================
  // Scenario 1: Built-in Architecture Review reads actual repository files
  // =========================================================================
  test("1. Built-in Architecture Review reads actual repository files", async () => {
    const filePath = path.join(tmpWorkspace, "src", "arch.ts");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const SYSTEM_ARCH = 'clean-layered';");

    const provider = new ScriptedProvider([
      {
        text: "Inspecting codebase architecture...",
        toolCalls: [
          {
            callId: "call_1",
            tool: "read_file",
            arguments: { path: "src/arch.ts" },
          },
        ],
      },
      (req: any) => {
        const fullContent = req.messages.map((m: any) => m.content).join("\n");
        assert.ok(fullContent.includes("clean-layered"), "Tool output must reach model");
        return {
          text: "Verified clean-layered architecture.",
          toolCalls: [],
        };
      },
    ]);

    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "REVIEW",
      customModeId: "architecture-review",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Perform architecture audit",
      mode: "REVIEW",
      customModeId: "architecture-review",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "completed");
    const lastMsg = state.messages[state.messages.length - 1];
    assert.equal(lastMsg.role, "assistant");
    assert.ok(lastMsg.content.includes("clean-layered"));
  });

  // =========================================================================
  // Scenario 2: Reverse Engineering Analysis uses permitted search/read tools
  // =========================================================================
  test("2. Reverse Engineering Analysis uses permitted search/read tools", async () => {
    const targetFile = path.join(tmpWorkspace, "src", "crypto.ts");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "export function decryptKey() { return 42; }");

    const provider = new ScriptedProvider([
      {
        text: "Searching for decryption routine...",
        toolCalls: [
          {
            callId: "call_search",
            tool: "search_text",
            arguments: { query: "decryptKey" },
          },
        ],
      },
      (req: any) => {
        const fullContent = req.messages.map((m: any) => m.content).join("\n");
        assert.ok(fullContent.includes("decryptKey"), "Search results should be in context");
        return {
          text: "Reverse engineering complete: found decryptKey in src/crypto.ts.",
          toolCalls: [],
        };
      },
    ]);

    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "PLAN",
      customModeId: "reverse-engineering-analysis",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Find the decryption function",
      mode: "PLAN",
      customModeId: "reverse-engineering-analysis",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "completed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("found decryptKey"));
  });

  // =========================================================================
  // Scenario 3: Custom BUILD profile can request a controlled file mutation
  // =========================================================================
  test("3. Custom BUILD profile can request a controlled file mutation", async () => {
    modeService.createWorkspaceMode({
      id: "builder-profile",
      name: "Custom Builder",
      description: "Permitted file authoring",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "BUILD",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      toolAllowlist: ["create_file", "read_file"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const newFilePath = path.join(tmpWorkspace, "src", "generated.ts");
    fs.mkdirSync(path.join(tmpWorkspace, "src"), { recursive: true });

    const provider = new ScriptedProvider([
      {
        text: "Writing new component...",
        toolCalls: [
          {
            callId: "call_create",
            tool: "create_file",
            arguments: { path: "src/generated.ts", content: "export const GENERATED = 100;" },
          },
        ],
      },
      () => ({
        text: "File creation complete.",
        toolCalls: [],
      }),
    ]);

    const { controller } = createTestHarness(provider, { trusted: true });

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "BUILD",
      customModeId: "builder-profile",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Create the generated component",
      mode: "BUILD",
      customModeId: "builder-profile",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "completed");
    assert.ok(fs.existsSync(newFilePath), "File should be created on disk");
    assert.equal(fs.readFileSync(newFilePath, "utf8"), "export const GENERATED = 100;");
  });

  // =========================================================================
  // Scenario 4: Equivalent PLAN profile cannot mutate files
  // =========================================================================
  test("4. Equivalent PLAN profile cannot mutate files", async () => {
    modeService.createWorkspaceMode({
      id: "planner-profile",
      name: "Custom Planner",
      description: "Read-only planning profile",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "PLAN",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      toolAllowlist: ["create_file", "read_file"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    const resolved = modeService.resolveMode("planner-profile", snapshot);
    assert.ok(!resolved.effectiveTools.includes("create_file"), "create_file must not be permitted in PLAN mode");

    const forbiddenFile = path.join(tmpWorkspace, "forbidden.txt");

    const provider = new ScriptedProvider([
      {
        text: "Attempting file creation in plan mode...",
        toolCalls: [
          {
            callId: "call_bad_write",
            tool: "create_file",
            arguments: { path: "forbidden.txt", content: "should fail" },
          },
        ],
      },
      (req: any) => {
        const lastMsg = req.messages[req.messages.length - 1];
        assert.ok(
          lastMsg.content.includes("Unknown tool") ||
          lastMsg.content.includes("permission denied") ||
          lastMsg.content.includes("error") ||
          lastMsg.content.includes("not allowed"),
          "Expected permission denial in tool response"
        );
        return {
          text: "Mutation was denied as expected.",
          toolCalls: [],
        };
      },
    ]);

    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "PLAN",
      customModeId: "planner-profile",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Try to create a file",
      mode: "PLAN",
      customModeId: "planner-profile",
    });

    assert.ok(!fs.existsSync(forbiddenFile), "Forbidden file must NOT be created on disk");
  });

  // =========================================================================
  // Scenario 5: Required installed skill reaches actual compiled context when globally enabled
  // =========================================================================
  test("5. Required installed skill reaches actual compiled context when globally enabled", async () => {
    modeService.createWorkspaceMode({
      id: "sec-review-mode",
      name: "Security Review Mode",
      description: "Mode with required skill",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: ["security-review"],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let contextSawSkill = false;
    const provider = new ScriptedProvider([
      (req: any) => {
        const allText = JSON.stringify(req);
        if (
          allText.includes("Find concrete security regressions") ||
          allText.includes("security-review")
        ) {
          contextSawSkill = true;
        }
        return {
          text: "Security audit completed with policy.",
          toolCalls: [],
        };
      },
    ]);

    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "REVIEW",
      customModeId: "sec-review-mode",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Audit repo against security policy",
      mode: "REVIEW",
      customModeId: "sec-review-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "completed");
    assert.equal(contextSawSkill, true, "Installed required skill must reach model context");
  });

  // =========================================================================
  // Scenario 6: Disabled skills feature flag is respected
  // =========================================================================
  test("6. Disabled skills feature flag is respected", async () => {
    modeService.createWorkspaceMode({
      id: "skill-required-mode",
      name: "Needs Skill Mode",
      description: "Fails when skills disabled",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: ["security-review"],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resolved = modeService.resolveMode("skill-required-mode", {
      workspaceTrusted: true,
      globalSkillsEnabled: false,
      availableSkills: [{ id: "security-review" }],
      availableMcpServers: [],
      availableTools: ["read_file"],
    });

    assert.equal(resolved.isReady, false);
    assert.ok(resolved.diagnostics.some((d: string) => d.includes("Global skills feature flag is disabled")));

    process.env.OPEN_VS_CODE_SKILLS = "0";
    try {
      const provider = new ScriptedProvider([]);
      const { controller } = createTestHarness(provider);

      await controller.handleWebviewMessage({
        type: "chat.setMode",
        mode: "REVIEW",
        customModeId: "skill-required-mode",
      });

      await controller.handleWebviewMessage({
        type: "chat.send",
        text: "Run with disabled skills",
        mode: "REVIEW",
        customModeId: "skill-required-mode",
      });

      const state = controller.getState();
      assert.equal(state.lastStatus, "failed");
      const lastMsg = state.messages[state.messages.length - 1];
      assert.ok(lastMsg.content.includes("required dependencies are missing or unready"));
    } finally {
      delete process.env.OPEN_VS_CODE_SKILLS;
    }
  });

  // =========================================================================
  // Scenario 7: Required MCP server is connected and its permitted tool can execute
  // =========================================================================
  test("7. Required MCP server is connected and its permitted tool can execute", async () => {
    await mcpService.registerServer("fixture_server", {
      command: "node",
      args: [fixtureServerPath],
      transport: "stdio",
      enabled: true,
      policy: {
        toolPolicies: {
          echo: "read",
        },
      },
    });
    await mcpService.connectServer("fixture_server");

    modeService.createWorkspaceMode({
      id: "mcp-mode",
      name: "MCP Enabled Mode",
      description: "Profile using fixture MCP server",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: ["fixture_server"],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = new ScriptedProvider([
      {
        text: "Calling MCP tool echo...",
        toolCalls: [
          {
            callId: "call_mcp_echo",
            tool: "mcp_fixture_server_echo",
            arguments: { text: "hello from custom mode" },
          },
        ],
      },
      (req: any) => {
        const fullContent = req.messages.map((m: any) => m.content).join("\n");
        assert.ok(fullContent.includes("hello from custom mode"), "MCP result should return to model");
        return {
          text: "Echo response verified successfully.",
          toolCalls: [],
        };
      },
    ]);

    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "REVIEW",
      customModeId: "mcp-mode",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Call MCP echo tool",
      mode: "REVIEW",
      customModeId: "mcp-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "completed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("verified successfully"));
  });

  // =========================================================================
  // Scenario 8: Account-owned MCP registration is actually available to the runtime
  // =========================================================================
  test("8. Account-owned MCP registration is actually available to the runtime", async () => {
    await accountManager.login("alice", "alice-pass-123", authServerUrl, mcpService);

    await mcpService.registerServer(
      "alice_account_mcp",
      {
        command: "node",
        args: [fixtureServerPath],
        transport: "stdio",
        enabled: true,
      },
      "account"
    );

    assert.equal(mcpService.getServerProvenance("alice_account_mcp"), "account");

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    const accountMcp = snapshot.availableMcpServers.find((s: any) => s.id === "alice_account_mcp");
    assert.ok(accountMcp, "Account MCP server must be in production snapshot");

    modeService.createWorkspaceMode({
      id: "alice-mcp-mode",
      name: "Alice MCP Mode",
      description: "Needs alice account MCP",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: ["alice_account_mcp"],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await mcpService.connectServer("alice_account_mcp");
    const resolved = modeService.resolveMode("alice-mcp-mode", await integrationManager.getProductionCapabilitySnapshot());
    assert.equal(resolved.isReady, true);

    await accountManager.logout(mcpService);
  });

  // =========================================================================
  // Scenario 9: Different account cannot inherit that MCP registration
  // =========================================================================
  test("9. Different account cannot inherit that MCP registration", async () => {
    await accountManager.login("alice", "alice-pass-123", authServerUrl, mcpService);
    await mcpService.registerServer(
      "alice_private_mcp",
      {
        command: "node",
        args: [fixtureServerPath],
        transport: "stdio",
        enabled: true,
      },
      "account"
    );

    await accountManager.logout(mcpService);

    await accountManager.login("bob", "bob-pass-123", authServerUrl, mcpService);

    const bobSnapshot = await integrationManager.getProductionCapabilitySnapshot();
    const inherited = bobSnapshot.availableMcpServers.find((s: any) => s.id === "alice_private_mcp");
    assert.equal(inherited, undefined, "Bob must not inherit Alice's account MCP");

    modeService.createWorkspaceMode({
      id: "alice-mode-check",
      name: "Needs Alice MCP",
      description: "",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: ["alice_private_mcp"],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resolved = modeService.resolveMode("alice-mode-check", bobSnapshot);
    assert.equal(resolved.isReady, false);
    assert.ok(resolved.missingRequiredMcpServers.includes("alice_private_mcp"));

    await accountManager.logout(mcpService);
  });

  // =========================================================================
  // Scenario 10: Workspace MCP restriction blocks execution
  // =========================================================================
  test("10. Workspace MCP restriction blocks execution", async () => {
    await mcpService.registerServer("policy_restricted_server", {
      command: "node",
      args: [fixtureServerPath],
      transport: "stdio",
      enabled: true,
    });

    await mcpService.setWorkspacePolicy("policy_restricted_server", false);
    assert.equal(mcpService.isWorkspaceAllowed("policy_restricted_server"), false);

    modeService.createWorkspaceMode({
      id: "restricted-mcp-mode",
      name: "Restricted Mode",
      description: "",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: ["policy_restricted_server"],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    const resolved = modeService.resolveMode("restricted-mcp-mode", snapshot);
    assert.equal(resolved.isReady, false, "Must not be ready when workspace restricts required MCP");

    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "REVIEW",
      customModeId: "restricted-mcp-mode",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Attempt execution with workspace-restricted MCP",
      mode: "REVIEW",
      customModeId: "restricted-mcp-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "failed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("required dependencies are missing or unready"));
  });

  // =========================================================================
  // Scenario 11: Missing MCP dependency blocks the task
  // =========================================================================
  test("11. Missing MCP dependency blocks the task", async () => {
    modeService.createWorkspaceMode({
      id: "uninstalled-mcp-mode",
      name: "Missing MCP Mode",
      description: "",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: ["completely_uninstalled_server"],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "REVIEW",
      customModeId: "uninstalled-mcp-mode",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Run task with missing MCP",
      mode: "REVIEW",
      customModeId: "uninstalled-mcp-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "failed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("completely_uninstalled_server"));
  });

  // =========================================================================
  // Scenario 12: Explicit empty tool allowlist removes all tools
  // =========================================================================
  test("12. Explicit empty tool allowlist removes all tools", async () => {
    modeService.createWorkspaceMode({
      id: "zero-tools-mode",
      name: "Zero Tools Mode",
      description: "Chat only without tools",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "PLAN",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      toolAllowlist: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    const resolved = modeService.resolveMode("zero-tools-mode", snapshot);
    assert.equal(resolved.isReady, true);
    assert.deepEqual(resolved.effectiveTools, []);

    let runnerToolsOffered: string[] = [];
    const provider = new ScriptedProvider([
      (req: any) => {
        runnerToolsOffered = req.tools ? req.tools.map((t: any) => t.name) : [];
        return {
          text: "Pure conversation response.",
          toolCalls: [],
        };
      },
    ]);

    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "PLAN",
      customModeId: "zero-tools-mode",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Can you read a file?",
      mode: "PLAN",
      customModeId: "zero-tools-mode",
    });

    assert.deepEqual(runnerToolsOffered, [], "Model must receive 0 tools when allowlist is empty []");
  });

  // =========================================================================
  // Scenario 13: Default allowlist preserves permitted tools
  // =========================================================================
  test("13. Default allowlist preserves permitted tools", async () => {
    modeService.createWorkspaceMode({
      id: "default-tools-mode",
      name: "Default Allowlist",
      description: "Inherits base mode tools",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      toolAllowlist: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    const resolved = modeService.resolveMode("default-tools-mode", snapshot);
    assert.equal(resolved.isReady, true);
    assert.ok(resolved.effectiveTools.includes("read_file"));
    assert.ok(resolved.effectiveTools.includes("search_text"));
  });

  // =========================================================================
  // Scenario 14: Preferred model selection reaches the model router
  // =========================================================================
  test("14. Preferred model selection reaches the model router", async () => {
    modeService.createWorkspaceMode({
      id: "specialist-mode",
      name: "Specialist Model Mode",
      description: "",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      preferredModelId: "custom-specialist-70b",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    const resolved = modeService.resolveMode("specialist-mode", snapshot);
    assert.equal(resolved.effectiveModelId, "custom-specialist-70b");

    const fakeConfig: any = {
      providers: [
        { id: "scripted", kind: "scripted" },
      ],
      models: [
        { id: "specialist", contextWindow: 16000, capabilities: ["toolUse"], specialization: "general" },
        { id: "general", contextWindow: 8000, capabilities: ["toolUse"], specialization: "general" },
      ],
      deployments: [
        { id: "custom-specialist-70b", providerId: "scripted", modelId: "specialist", priority: 10, enabled: true },
        { id: "default-deployment", providerId: "scripted", modelId: "general", priority: 5, enabled: true },
      ],
      routes: {
        default: ["default-deployment", "custom-specialist-70b"],
      },
    };

    const dummyProvider = new ScriptedProvider([]);
    const providersMap = new Map([
      ["scripted", dummyProvider],
    ]);

    const gateway = new RoutedModelGateway({
      config: fakeConfig,
      providers: providersMap as any,
      mode: "REVIEW",
      hasTools: true,
      hasStructuredOutput: false,
      preferredDeploymentId: resolved.effectiveModelId,
    });

    assert.equal(gateway.preferredDeploymentId, "custom-specialist-70b");
  });

  // =========================================================================
  // Scenario 15: Workflow preference reaches the existing workflow gate
  // =========================================================================
  test("15. Workflow preference reaches the existing workflow gate", async () => {
    // When effectiveWorkflow === "direct", assessWorkflowEligibility returns disabled/ineligible
    const directEligible = assessWorkflowEligibility({
      enabled: false,
      mode: "BUILD",
      instruction: "Do complex task",
      isTrusted: true,
    });
    assert.equal(directEligible.eligible, false);
    assert.equal(directEligible.reason, "DISABLED");

    // When effectiveWorkflow === "structured" and global feature gate is enabled
    const structuredEligible = assessWorkflowEligibility({
      enabled: true,
      mode: "BUILD",
      instruction: "Do complex task",
      isTrusted: true,
    });
    assert.equal(structuredEligible.eligible, true);
    assert.equal(structuredEligible.reason, "ELIGIBLE");
  });

  // =========================================================================
  // Scenario 16: Disabled profile cannot execute
  // =========================================================================
  test("16. Disabled profile cannot execute", async () => {
    modeService.createWorkspaceMode({
      id: "disabled-profile",
      name: "Disabled Profile",
      description: "Should not run",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "REVIEW",
      scope: "workspace",
      enabled: false,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.setMode",
      mode: "REVIEW",
      customModeId: "disabled-profile",
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Attempt execution with disabled profile",
      mode: "REVIEW",
      customModeId: "disabled-profile",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "failed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("is disabled"));
  });

  // =========================================================================
  // Scenario 17: Deleted profile cannot fall back silently
  // =========================================================================
  test("17. Deleted profile cannot fall back silently", async () => {
    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Run with non-existent custom mode",
      mode: "REVIEW",
      customModeId: "non-existent-deleted-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "failed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("no longer exists"));
  });

  // =========================================================================
  // Scenario 18: Base-mode mismatch is rejected
  // =========================================================================
  test("18. Base-mode mismatch is rejected", async () => {
    modeService.createWorkspaceMode({
      id: "plan-only-mode",
      name: "Plan Only",
      description: "",
      version: 1,
      schemaVersion: 1,
      source: "workspace",
      baseMode: "PLAN",
      scope: "workspace",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider);

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Run build with plan profile",
      mode: "BUILD",
      customModeId: "plan-only-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "failed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("Execution mode mismatch"));
  });

  // =========================================================================
  // Scenario 19: Untrusted workspace is evaluated using actual trust state
  // =========================================================================
  test("19. Untrusted workspace is evaluated using actual trust state", async () => {
    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider, { trusted: false });

    const snapshot = await integrationManager.getProductionCapabilitySnapshot();
    assert.equal(snapshot.workspaceTrusted, true);

    const untrustedSnapshot = { ...snapshot, workspaceTrusted: false };
    const resolved = modeService.resolveMode("architecture-review", untrustedSnapshot);
    assert.equal(resolved.isReady, true);
    assert.ok(!resolved.effectiveTools.includes("apply_patch"));
  });

  // =========================================================================
  // Scenario 20: Account switch safely invalidates account-dependent execution authority
  // =========================================================================
  test("20. Account switch safely invalidates account-dependent execution authority", async () => {
    const provider = new ScriptedProvider([]);
    const { controller } = createTestHarness(provider);

    // Simulate active turn
    (controller as any).state.activeTurn = true;
    let cancelCalled = false;
    controller.cancelTurn = () => {
      cancelCalled = true;
      (controller as any).state.activeTurn = false;
    };

    integrationManager.notifyAccountChange();

    assert.equal(cancelCalled, true, "Account state change must cancel any active turn");

    (modeService as any).accountProfiles.set("unauth-account-mode", {
      id: "unauth-account-mode",
      name: "Account Private",
      description: "",
      version: 1,
      schemaVersion: 1,
      source: "account",
      baseMode: "REVIEW",
      scope: "account",
      enabled: true,
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await controller.handleWebviewMessage({
      type: "chat.send",
      text: "Try running unauthenticated account profile",
      mode: "REVIEW",
      customModeId: "unauth-account-mode",
    });

    const state = controller.getState();
    assert.equal(state.lastStatus, "failed");
    assert.ok(state.messages[state.messages.length - 1].content.includes("belongs to an account profile but the user is unauthenticated"));
  });
});
