import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { AccountDatabase, AdminService, AccountServer } from "@open-vs-code/account-service";
import {
  DesktopAccountManager,
  ACCOUNT_SESSION_SECRET_KEY,
} from "../src/account/account-manager.js";
import { McpService } from "../src/mcp/mcp-service.js";
import { VsCodeSecretProvider } from "../src/mcp/mcp-vscode-secrets.js";
import { classifyPermission } from "@open-vs-code/agent-core";

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

describe("DesktopAccountManager Integration", () => {
  let db: AccountDatabase;
  let adminService: AdminService;
  let server: AccountServer;
  let serverUrl: string;
  let mockContext: MockExtensionContext;
  let outputChannel: MockOutputChannel;

  before(async () => {
    db = AccountDatabase.open(":memory:");
    adminService = new AdminService(db);

    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-super-pass");
    await adminService.createUser(admin.id, {
      username: "engineer",
      password: "engineer-password-1",
      role: "USER",
    });

    server = new AccountServer(db, { port: 0, host: "127.0.0.1" });
    const started = await server.start();
    serverUrl = started.url;
  });

  after(async () => {
    await server.stop();
    db.close();
  });

  beforeEach(() => {
    mockContext = new MockExtensionContext();
    outputChannel = new MockOutputChannel();
  });

  test("1. unauthenticated initialization leaves local coding fully functional", async () => {
    const manager = new DesktopAccountManager(mockContext as any, outputChannel as any);
    const state = await manager.initialize();

    assert.strictEqual(state.status, "UNAUTHENTICATED");
    assert.strictEqual(state.user, undefined);
    assert.strictEqual(state.isStale, false);
  });

  test("2. login authenticates, stores session in SecretStorage, and restores MCP integrations", async () => {
    const manager = new DesktopAccountManager(mockContext as any, outputChannel as any);

    // Seed an integration in the account backend for engineer
    const user = db.users.findByUsername("engineer")!;
    await server.integrationService.register(user.id, {
      serverId: "persisted-postgres",
      displayName: "PostgreSQL MCP Server",
      transport: "stdio",
      nonSecretConfig: { command: "npx", args: ["-y", "postgres-mcp"] },
      credentialReference: "pg_password_ref",
      enabledPreference: true,
    });

    const secretProvider = new VsCodeSecretProvider(mockContext.secrets as any);
    await secretProvider.setSecret("pg_password_ref", "super_secret_db_pass");

    const mcpService = new McpService(undefined, secretProvider, outputChannel as any);

    // Perform desktop login
    const profile = await manager.login("engineer", "engineer-password-1", serverUrl, mcpService);
    assert.strictEqual(profile.username, "engineer");

    const state = manager.getState();
    assert.strictEqual(state.status, "ONLINE");
    assert.strictEqual(state.isStale, false);

    // Verify session was stored in SecretStorage
    const storedSecret = await mockContext.secrets.get(ACCOUNT_SESSION_SECRET_KEY);
    assert.ok(storedSecret);
    const sessionData = JSON.parse(storedSecret);
    assert.strictEqual(sessionData.username, "engineer");
    assert.ok(sessionData.token.startsWith("ovsc_sess_"));

    // Verify integration was restored into McpCatalog with DISCONNECTED state (not auto-connected)
    const catalog = await mcpService.getCatalog();
    const serverStatus = catalog.getServerStatus("persisted-postgres");
    assert.ok(serverStatus, "Restored integration must exist in catalog");
    assert.strictEqual(serverStatus.state, "DISCONNECTED", "Must not be auto-connected");
  });

  test("3. offline degradation caches profile as stale without interrupting IDE", async () => {
    const manager = new DesktopAccountManager(mockContext as any, outputChannel as any);

    // Initial successful login
    await manager.login("engineer", "engineer-password-1", serverUrl);
    assert.strictEqual(manager.getState().status, "ONLINE");

    // Simulate backend going offline by pointing to unreachable port
    const unreachableUrl = "http://127.0.0.1:59999";
    const stored = JSON.parse((await mockContext.secrets.get(ACCOUNT_SESSION_SECRET_KEY))!);
    const modified = { ...stored, serverUrl: unreachableUrl };
    await mockContext.secrets.store(ACCOUNT_SESSION_SECRET_KEY, JSON.stringify(modified));

    // Re-initialize manager (simulating IDE restart while offline)
    const offlineManager = new DesktopAccountManager(mockContext as any, outputChannel as any);
    const state = await offlineManager.initialize();

    assert.strictEqual(state.status, "OFFLINE");
    assert.strictEqual(state.isStale, true);
    assert.strictEqual(state.user?.username, "engineer");
    assert.ok(state.error?.includes("unreachable") || state.error?.includes("ECONNREFUSED"));
  });

  test("4. MCP security inheritance: account role does NOT bypass tool PermissionGate", async () => {
    // Verify that destructive tool actions still require explicit confirmation
    const destructiveDecision = classifyPermission({
      mode: "BUILD",
      action: "mcp_external_destructive",
    });

    assert.strictEqual(
      destructiveDecision,
      "CONFIRM",
      "Destructive tool actions must ALWAYS require confirmation, regardless of account role"
    );

    const sensitiveDecision = classifyPermission({
      mode: "PLAN",
      action: "mcp_sensitive_data_transmission",
    });

    assert.strictEqual(
      sensitiveDecision,
      "DENY",
      "Plan mode must strictly deny sensitive data transmission"
    );
  });

  test("5. logout clears SecretStorage and marks status unauthenticated", async () => {
    const manager = new DesktopAccountManager(mockContext as any, outputChannel as any);
    await manager.login("engineer", "engineer-password-1", serverUrl);

    assert.strictEqual(manager.getState().status, "ONLINE");
    await manager.logout();

    assert.strictEqual(manager.getState().status, "UNAUTHENTICATED");
    assert.strictEqual(manager.getState().user, undefined);
    assert.strictEqual(await mockContext.secrets.get(ACCOUNT_SESSION_SECRET_KEY), undefined);
  });
});
