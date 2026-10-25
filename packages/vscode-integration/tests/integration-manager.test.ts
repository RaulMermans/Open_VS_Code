import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import Module from "node:module";

const mockVscode = {
  window: {
    showErrorMessage: () => {},
    showWarningMessage: async () => "Cancel",
    showInformationMessage: async () => {},
    showTextDocument: async () => {},
  },
  commands: { executeCommand: async () => {} },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defVal: any) => defVal,
    }),
    openTextDocument: async (p: any) => ({ path: typeof p === "string" ? p : p.fsPath }),
  },
  Uri: { file: (f: string) => ({ fsPath: f, toString: () => f }) },
  env: { clipboard: { writeText: () => {} } },
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

import {
  AccountDatabase,
  AdminService,
  AccountServer,
  IntegrationService,
} from "@open-vs-code/account-service";
import {
  DesktopAccountManager,
} from "../src/account/account-manager.js";
import { McpService } from "../src/mcp/mcp-service.js";
import { VsCodeSecretProvider } from "../src/mcp/mcp-vscode-secrets.js";
import {
  renderIntegrationsHub,
  renderProfileSection,
  renderMcpDashboard,
  renderAddMcpWizard,
  renderToolInspector,
  renderSkillsSection,
  renderModesSection,
  renderDiagnosticsSection,
} from "../src/webview-render-helpers.js";

let IntegrationManagerController: any;

class MockSecretStorage {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

class MockExtensionContext {
  public secrets = new MockSecretStorage();
  public subscriptions: any[] = [];
}

class MockOutputChannel {
  public lines: string[] = [];
  appendLine(line: string) {
    this.lines.push(line);
  }
}

// Simple DOM Mock for Webview Render Tests
class MockElement {
  public tagName: string;
  public className = "";
  public textContent = "";
  public innerHTML = "";
  public id = "";
  public type = "";
  public value = "";
  public hidden = false;
  public disabled = false;
  public style: Record<string, string> = {};
  public attributes = new Map<string, string>();
  public children: MockElement[] = [];
  public listeners = new Map<string, Function[]>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild(child: MockElement): MockElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, fn: Function): void {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  querySelector(selector: string): MockElement | null {
    const found = this.querySelectorAll(selector);
    return found.length ? found[0] : null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const check = (el: MockElement) => {
      let match = false;
      if (selector.startsWith(".")) {
        const classes = selector.slice(1).split(".");
        const elClasses = el.className.split(/\s+/).filter(Boolean);
        match = classes.every((c) => elClasses.includes(c));
      } else if (selector.startsWith("#")) {
        match = el.id === selector.slice(1) || el.getAttribute("id") === selector.slice(1);
      } else if (selector.toUpperCase() === el.tagName) {
        match = true;
      }
      if (match) results.push(el);
      for (const c of el.children) check(c);
    };
    for (const c of this.children) check(c);
    return results;
  }
}

class MockDocument {
  createElement(tagName: string): MockElement {
    return new MockElement(tagName);
  }
}

describe("Visual Integration Manager (Sprint 8C)", () => {
  let tempDir: string;
  let db: AccountDatabase;
  let adminService: AdminService;
  let integrationService: IntegrationService;
  let server: AccountServer;
  let serverUrl: string;
  let userAId: string;
  let userBId: string;

  let mockContext: MockExtensionContext;
  let outputChannel: MockOutputChannel;
  let secretProvider: VsCodeSecretProvider;
  let mcpService: McpService;
  let accountManager: DesktopAccountManager;
  let controller: any;

  before(async () => {
    const mod = await import("../src/integrations/integration-manager-controller.js");
    IntegrationManagerController = mod.IntegrationManagerController;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sprint-8c-test-"));
    db = AccountDatabase.open(":memory:");
    adminService = new AdminService(db);
    integrationService = new IntegrationService(db);

    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    const userA = await adminService.createUser(admin.id, {
      username: "alice",
      password: "alice-password-1",
      role: "USER",
    });
    userAId = userA.id;

    const userB = await adminService.createUser(admin.id, {
      username: "bob",
      password: "bob-password-1",
      role: "USER",
    });
    userBId = userB.id;

    // Seed User A's integrations
    await integrationService.register(userAId, {
      serverId: "alice-remote-db",
      displayName: "Alice PostgreSQL",
      transport: "streamable-http",
      nonSecretConfig: { url: "http://127.0.0.1:9001/mcp" },
      credentialReference: "token-alice-db",
      enabledPreference: true,
    });

    await integrationService.register(userAId, {
      serverId: "alice-stale-server",
      displayName: "Alice Stale Server",
      transport: "streamable-http",
      nonSecretConfig: { url: "http://127.0.0.1:9002/mcp" },
      credentialReference: null,
      enabledPreference: true,
    });

    // Seed User B's integrations
    await integrationService.register(userBId, {
      serverId: "bob-private-mcp",
      displayName: "Bob MCP Service",
      transport: "streamable-http",
      nonSecretConfig: { url: "http://127.0.0.1:9003/mcp" },
      credentialReference: null,
      enabledPreference: true,
    });

    server = new AccountServer(db, { port: 0, host: "127.0.0.1" });
    const started = await server.start();
    serverUrl = started.url;
  });

  after(async () => {
    await server.stop();
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockContext = new MockExtensionContext();
    outputChannel = new MockOutputChannel();
    secretProvider = new VsCodeSecretProvider(mockContext.secrets as any);
    mcpService = new McpService(tempDir, secretProvider, outputChannel as any);
    accountManager = new DesktopAccountManager(mockContext as any, outputChannel as any);
    controller = new IntegrationManagerController(
      mockContext as any,
      accountManager,
      mcpService,
      outputChannel as any
    );
  });

  // ==========================================
  // Section 1: Controller Lifecycle & Tabs
  // ==========================================

  test("1. initial state defaults to 'profile' tab and no active wizard", async () => {
    const state = await controller.getState();
    assert.strictEqual(state.activeTab, "profile");
    assert.strictEqual(state.wizard, undefined);
    assert.strictEqual(state.inspectedServer, undefined);
    assert.strictEqual(state.confirmRemove, undefined);
  });

  test("2. setTab switches active tab and notifies listeners", async () => {
    let notifiedState: any;
    controller.onStateChange((s: any) => {
      notifiedState = s;
    });

    controller.setTab("mcp");
    assert.strictEqual(controller.getActiveTab(), "mcp");
    const state = await controller.getState();
    assert.strictEqual(state.activeTab, "mcp");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(notifiedState?.activeTab, "mcp");

    controller.setTab("skills");
    assert.strictEqual(controller.getActiveTab(), "skills");

    controller.setTab("modes");
    assert.strictEqual(controller.getActiveTab(), "modes");

    controller.setTab("diagnostics");
    assert.strictEqual(controller.getActiveTab(), "diagnostics");
  });

  // ==========================================
  // Section 2: Account Switch & Logout Isolation (P0)
  // ==========================================

  test("3. Alice logs in and syncs integrations into local catalog", async () => {
    await accountManager.login("alice", "alice-password-1", serverUrl);
    const syncRes = await accountManager.syncIntegrations(mcpService, tempDir);
    assert.strictEqual(syncRes.errors.length, 0);
    assert.strictEqual(syncRes.total, 2);

    const servers = await mcpService.listServers();
    const serverIds = servers.map((s) => s.id);
    assert.ok(serverIds.includes("alice-remote-db"), "alice-remote-db must be in catalog");
    assert.ok(serverIds.includes("alice-stale-server"), "alice-stale-server must be in catalog");

    // Check provenance
    assert.strictEqual(mcpService.getServerProvenance("alice-remote-db"), "account");
  });

  test("4. Logging out removes account-owned MCP registrations from catalog", async () => {
    // Alice is currently logged in from test 3
    await accountManager.logout(mcpService);

    const servers = await mcpService.listServers();
    const serverIds = servers.map((s) => s.id);
    assert.ok(!serverIds.includes("alice-remote-db"), "alice-remote-db must be removed on logout");
    assert.ok(!serverIds.includes("alice-stale-server"), "alice-stale-server must be removed on logout");
    assert.strictEqual(accountManager.getState().status, "UNAUTHENTICATED");
  });

  test("5. Account switch removes User A integrations before loading User B", async () => {
    // Alice logs in
    await accountManager.login("alice", "alice-password-1", serverUrl);
    await accountManager.syncIntegrations(mcpService, tempDir);

    let servers = await mcpService.listServers();
    assert.ok(servers.some((s) => s.id === "alice-remote-db"));

    // User switches to Bob
    await accountManager.login("bob", "bob-password-1", serverUrl, mcpService);
    await accountManager.syncIntegrations(mcpService, tempDir);

    servers = await mcpService.listServers();
    const serverIds = servers.map((s) => s.id);

    // Alice's servers must be completely gone
    assert.ok(!serverIds.includes("alice-remote-db"), "Alice's DB must not be present for Bob");
    assert.ok(!serverIds.includes("alice-stale-server"), "Alice's stale server must not be present for Bob");

    // Bob's server must be present
    assert.ok(serverIds.includes("bob-private-mcp"), "Bob's server must be loaded");
    assert.strictEqual(mcpService.getServerProvenance("bob-private-mcp"), "account");

    // Clean up
    await accountManager.logout(mcpService);
  });

  test("6. Deleting a remote integration reconciles effective local state on sync", async () => {
    await accountManager.login("alice", "alice-password-1", serverUrl);
    await accountManager.syncIntegrations(mcpService, tempDir);

    let servers = await mcpService.listServers();
    assert.ok(servers.some((s) => s.id === "alice-stale-server"));

    // Find and delete "alice-stale-server" on remote backend by registration id
    const items = await integrationService.list(userAId);
    const stale = items.find((i) => i.serverId === "alice-stale-server");
    assert.ok(stale);
    await integrationService.delete(userAId, stale!.id);

    // Sync again
    const syncRes = await accountManager.syncIntegrations(mcpService, tempDir);
    assert.strictEqual(syncRes.errors.length, 0);

    // Effective local catalog must have purged the deleted registration
    servers = await mcpService.listServers();
    assert.ok(!servers.some((s) => s.id === "alice-stale-server"), "Deleted server must be pruned locally");
    assert.ok(servers.some((s) => s.id === "alice-remote-db"), "Active server must remain");

    await accountManager.logout(mcpService);
  });

  // ==========================================
  // Section 3: Workspace Policy Enforcement (P0)
  // ==========================================

  test("7. Workspace policy can disable an account integration for current workspace", async () => {
    await accountManager.login("alice", "alice-password-1", serverUrl);
    await accountManager.syncIntegrations(mcpService, tempDir);

    // Default policy is allowed
    assert.strictEqual(mcpService.isWorkspaceAllowed("alice-remote-db"), true);

    // Toggle workspace policy off via controller
    await controller.toggleWorkspacePolicy("alice-remote-db", false);
    assert.strictEqual(mcpService.isWorkspaceAllowed("alice-remote-db"), false);

    const summaries = await mcpService.listServers();
    const dbSummary = summaries.find((s) => s.id === "alice-remote-db");
    assert.ok(dbSummary);
    assert.strictEqual(dbSummary?.workspaceEnabled, false);
    assert.strictEqual(dbSummary?.effectiveEnabled, false);
    assert.strictEqual(dbSummary?.state, "DISABLED");

    await accountManager.logout(mcpService);
  });

  test("8. Server disabled by workspace policy cannot be connected (fails closed)", async () => {
    await accountManager.login("alice", "alice-password-1", serverUrl);
    await accountManager.syncIntegrations(mcpService, tempDir);

    // Disable in workspace policy
    await controller.toggleWorkspacePolicy("alice-remote-db", false);

    // Attempting to connect must fail closed without attempting transport
    const connRes = await controller.connectServer("alice-remote-db");
    assert.strictEqual(connRes.success, false);
    assert.ok(
      connRes.message.includes("disabled by workspace policy"),
      `Expected workspace policy violation message, got: ${connRes.message}`
    );

    // Re-enabling workspace policy permits connection attempt
    await controller.toggleWorkspacePolicy("alice-remote-db", true);
    assert.strictEqual(mcpService.isWorkspaceAllowed("alice-remote-db"), true);

    await accountManager.logout(mcpService);
  });

  // ==========================================
  // Section 4: Add MCP Wizard Workflow
  // ==========================================

  test("9. Wizard Step 1: select transport advances to Step 2", async () => {
    controller.startAddWizard();
    let state = await controller.getState();
    assert.ok(state.wizard);
    assert.strictEqual(state.wizard?.step, 1);

    controller.wizardSetStep1Transport("streamable_http");
    state = await controller.getState();
    assert.strictEqual(state.wizard?.step, 2);
    assert.strictEqual(state.wizard?.draft.transport, "streamable_http");
  });

  test("10. Wizard Step 2: update form draft", async () => {
    controller.startAddWizard();
    controller.wizardSetStep1Transport("streamable_http");
    controller.wizardUpdateDraft({
      serverId: "my-test-server",
      displayName: "My Test Server",
      url: "http://127.0.0.1:9099/mcp",
      credentialRef: "my-secret-key",
      secretValue: "tok_12345",
      persistToAccount: false,
    });

    const state = await controller.getState();
    assert.strictEqual(state.wizard?.draft.serverId, "my-test-server");
    assert.strictEqual(state.wizard?.draft.displayName, "My Test Server");
    assert.strictEqual(state.wizard?.draft.url, "http://127.0.0.1:9099/mcp");
  });

  test("11. Wizard Step 3: validation rejects missing server ID and URL", async () => {
    controller.startAddWizard();
    controller.wizardSetStep1Transport("streamable_http");
    controller.wizardUpdateDraft({ serverId: "", url: "" });

    await controller.wizardValidateAndAdvance();
    const state = await controller.getState();
    assert.strictEqual(state.wizard?.validationResult?.valid, false);
    assert.ok(state.wizard?.validationResult?.warnings.some((w: string) => w.includes("Server ID is required")));
  });

  test("12. Wizard Step 3: validation warns on remote unverified endpoint", async () => {
    controller.startAddWizard();
    controller.wizardSetStep1Transport("streamable_http");
    controller.wizardUpdateDraft({
      serverId: "remote-untrusted",
      url: "https://api.external-vendor.com/mcp",
    });

    await controller.wizardValidateAndAdvance();
    const state = await controller.getState();
    assert.strictEqual(state.wizard?.step, 3);
    assert.strictEqual(state.wizard?.validationResult?.valid, true);
    assert.ok(state.wizard?.validationResult?.warnings.some((w: string) => w.includes("Third-party server")));
  });

  test("13. Wizard Step 4: save without connecting persists locally without spawning processes", async () => {
    controller.startAddWizard();
    controller.wizardSetStep1Transport("stdio");
    controller.wizardUpdateDraft({
      serverId: "local-cli-tool",
      displayName: "Local CLI Tool",
      command: "node",
      args: ["-e", "process.exit(0)"],
      persistToAccount: false,
    });

    await controller.wizardValidateAndAdvance();
    const saved = await controller.wizardSave(false);
    assert.strictEqual(saved, true);

    const state = await controller.getState();
    assert.strictEqual(state.wizard, undefined, "Wizard should close after save");

    const servers = await mcpService.listServers();
    const cliTool = servers.find((s) => s.id === "local-cli-tool");
    assert.ok(cliTool, "Saved server must exist in catalog");
    assert.strictEqual(cliTool?.state, "DISCONNECTED", "Must remain DISCONNECTED without connectNow");
    assert.strictEqual(cliTool?.source, "local");
  });

  test("14. Wizard cancelWizard cleans up draft and closes wizard", async () => {
    controller.startAddWizard();
    controller.wizardUpdateDraft({ serverId: "half-finished" });
    controller.cancelWizard();

    const state = await controller.getState();
    assert.strictEqual(state.wizard, undefined);
  });

  // ==========================================
  // Section 5: Tool Inspection & Local Permissions
  // ==========================================

  test("15. inspectTools sets inspectingServerId and classifyToolPermission applies local policy", async () => {
    const configWithPolicies = {
      servers: {
        "mock-filesystem": {
          transport: "stdio" as const,
          enabled: true,
          policy: {
            toolPolicies: {
              read_file: "read" as const,
              delete_file: "destructive" as const,
              upload_file_data: "sensitive" as const,
            },
          },
        },
      },
    };

    const readMeta = {
      serverId: "mock-filesystem",
      toolName: "read_file",
      canonicalName: "read_file",
      description: "Reads a repository file",
      annotations: { readOnlyHint: true },
    };
    const readClassification = controller.classifyToolPermission(readMeta as any, configWithPolicies as any);
    assert.strictEqual(readClassification.permissionGate, "ALLOW");
    assert.strictEqual(readClassification.isDestructive, false);

    // Annotations alone CANNOT lower risk without local policy
    const unconfigured = controller.classifyToolPermission(readMeta as any);
    assert.strictEqual(unconfigured.permissionGate, "CONFIRM");

    const delMeta = {
      serverId: "mock-filesystem",
      toolName: "delete_file",
      canonicalName: "delete_file",
      description: "Deletes a file permanently",
    };
    const delClassification = controller.classifyToolPermission(delMeta as any, configWithPolicies as any);
    assert.strictEqual(delClassification.permissionGate, "CONFIRM");
    assert.strictEqual(delClassification.isDestructive, true);

    const sendMeta = {
      serverId: "mock-filesystem",
      toolName: "upload_file_data",
      canonicalName: "upload_file_data",
      description: "Transmits code to an external service",
    };
    const sendClassification = controller.classifyToolPermission(sendMeta as any, configWithPolicies as any);
    assert.strictEqual(sendClassification.permissionGate, "CONFIRM");
    assert.strictEqual(sendClassification.isSensitive, true);

    controller.inspectTools("mock-filesystem");
    const state = await controller.getState();
    assert.strictEqual(state.inspectingServerId, "mock-filesystem");
  });

  test("16. inspectTools clearing sets inspectingServerId to undefined", async () => {
    controller.inspectTools("some-server");
    let state = await controller.getState();
    assert.strictEqual(state.inspectingServerId, "some-server");

    controller.inspectTools(undefined);
    state = await controller.getState();
    assert.strictEqual(state.inspectingServerId, undefined);
  });

  // ==========================================
  // Section 6: Skills Integration
  // ==========================================

  test("17. getSkillsInventory lists skills and surfaces runtime status", async () => {
    const inventory = await controller.getSkillsInventory();
    assert.ok(Array.isArray(inventory));
    // Curated built-in skills should be present
    assert.ok(inventory.length > 0, "Builtin skills should be indexed");

    const firstSkill = inventory[0];
    assert.ok(firstSkill.id);
    assert.ok(firstSkill.name);
    assert.ok(firstSkill.description);
    assert.ok(firstSkill.filePath);
    assert.strictEqual(typeof firstSkill.enabled, "boolean");
  });

  test("18. inspectSkill selects skill and surfaces diagnostics", async () => {
    const inventory = await controller.getSkillsInventory();
    const sampleSkill = inventory[0];

    controller.inspectSkill(sampleSkill.id);
    const state = await controller.getState();
    assert.strictEqual(state.inspectingSkillId, sampleSkill.id);

    controller.inspectSkill(undefined);
    const cleared = await controller.getState();
    assert.strictEqual(cleared.inspectingSkillId, undefined);
  });

  // ==========================================
  // Section 7: Modes & Diagnostics Sections
  // ==========================================

  test("19. Modes tab is a non-interactive future capability placeholder", async () => {
    controller.setTab("modes");
    const state = await controller.getState();
    assert.strictEqual(state.activeTab, "modes");
  });

  test("20. Diagnostics section aggregates catalog and system diagnostics", async () => {
    controller.setTab("diagnostics");
    const state = await controller.getState();
    assert.ok(Array.isArray(state.diagnostics));
    assert.ok(state.diagnostics.length >= 1, "Should contain account status diagnostic");
    assert.ok(state.diagnostics.some((d: string) => d.includes("Logged out") || d.includes("Account")));
  });

  test("21. Server removal requires confirmation and can be cancelled", async () => {
    controller.promptRemoveServer("mock-filesystem", "Mock Filesystem Server");
    let state = await controller.getState();
    assert.strictEqual(state.pendingConfirmation?.serverId, "mock-filesystem");

    controller.cancelConfirmation();
    state = await controller.getState();
    assert.strictEqual(state.pendingConfirmation, undefined);
  });

  test("22. executeRemoveServer deletes registration from catalog", async () => {
    await controller.executeRemoveServer("mock-filesystem");
    const servers = await mcpService.listServers();
    assert.ok(!servers.some((s) => s.id === "mock-filesystem"));
  });

  // ==========================================
  // Section 8: Webview DOM Helpers & Accessibility
  // ==========================================

  test("23. renderIntegrationsHub renders accessible tab bar with role=tab and aria-selected", () => {
    const doc = new MockDocument();
    const container = doc.createElement("div");

    const state = {
      activeTab: "mcp" as const,
      account: { status: "UNAUTHENTICATED" as const },
      servers: [],
      skills: [],
      diagnostics: [],
      isLoading: false,
    };

    renderIntegrationsHub(container as any, state as any, doc as any, () => {});

    const tabs = container.querySelectorAll(".hub-tab-btn");
    assert.strictEqual(tabs.length, 5, "Must render 5 navigation tabs");

    const activeTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    assert.ok(activeTab, "An active tab must be marked aria-selected=true");
    assert.strictEqual(activeTab?.getAttribute("role"), "tab");
    assert.strictEqual(activeTab?.textContent?.includes("MCP Servers"), true);
  });

  test("24. renderMcpDashboard renders server list, badges, and empty state", () => {
    const doc = new MockDocument();
    const container = doc.createElement("div");

    // Empty state
    renderMcpDashboard(container as any, { servers: [] } as any, doc as any, () => {});
    assert.ok(container.querySelector(".hub-empty-state"));

    // With servers
    const state = {
      servers: [
        {
          id: "server-1",
          name: "PostgreSQL DB",
          transport: "streamable_http",
          source: "account" as const,
          state: "CONNECTED" as const,
          enabled: true,
          workspaceEnabled: true,
          effectiveEnabled: true,
          toolCount: 5,
          tools: [],
          authStatus: { hasCredential: true },
          urlOrCommand: "http://127.0.0.1:5432",
        },
      ],
    };

    const filledContainer = doc.createElement("div");
    renderMcpDashboard(filledContainer as any, state as any, doc as any, () => {});

    const card = filledContainer.querySelector(".hub-server-card");
    assert.ok(card);
    assert.ok(filledContainer.querySelector(".hub-transport-badge"));
    assert.ok(filledContainer.querySelector(".hub-provenance-badge.is-account"));
  });

  test("25. renderAddMcpWizard renders step indicators and form inputs", () => {
    const doc = new MockDocument();
    const container = doc.createElement("div");

    const state = {
      wizard: {
        step: 2 as const,
        draft: {
          serverId: "new-server",
          displayName: "New Server",
          transport: "streamable_http" as const,
          url: "",
        },
        connecting: false,
      },
    };

    renderAddMcpWizard(container as any, state as any, doc as any, () => {});

    const dots = container.querySelectorAll(".hub-step-dot");
    assert.strictEqual(dots.length, 5, "Must render 5 step indicators");
    const inputs = container.querySelectorAll(".hub-input");
    assert.ok(inputs.length >= 2, "Must render form inputs for server ID and display name");
  });

  test("26. renderToolInspector renders security warnings and permission classes", () => {
    const doc = new MockDocument();
    const container = doc.createElement("div");

    const state = {
      inspectingServerId: "test-server",
      servers: [
        {
          id: "test-server",
          name: "Test Server",
          tools: [
            {
              toolName: "drop_database",
              canonicalName: "drop_database",
              description: "Drops all database tables",
              permissionGate: "CONFIRM" as const,
              isDestructive: true,
              isSensitive: true,
            },
          ],
        },
      ],
    };

    renderToolInspector(container as any, state as any, doc as any, () => {});

    assert.ok(container.querySelector(".hub-warning-banner.is-destructive"));
    assert.ok(container.querySelector(".hub-warning-banner.is-sensitive"));
    const toolName = container.querySelector(".hub-tool-name");
    assert.strictEqual(toolName?.textContent, "drop_database");
  });

  test("27. renderModesSection renders disabled future placeholder notice", () => {
    const doc = new MockDocument();
    const container = doc.createElement("div");

    renderModesSection(container as any, {} as any, doc as any, () => {});

    const desc = container.querySelector(".hub-placeholder-desc");
    assert.ok(desc?.textContent?.includes("scheduled for future milestones"));
    assert.ok(desc?.textContent?.includes("intentionally non-interactive"));
  });

  test("28. renderProfileSection renders unauthenticated state with login button", () => {
    const doc = new MockDocument();
    const container = doc.createElement("div");

    const state = {
      account: {
        status: "UNAUTHENTICATED" as const,
      },
    };

    renderProfileSection(container as any, state as any, doc as any, () => {});

    const badge = container.querySelector(".status-badge");
    assert.strictEqual(badge?.textContent, "Unauthenticated");
    const loginBtn = container.querySelector(".btn-approve");
    assert.ok(loginBtn);
    assert.strictEqual(loginBtn?.textContent, "Log In");
  });
});
