import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { AccountDatabase } from "../../src/db/connection.js";
import { AdminService } from "../../src/admin/admin-service.js";
import { AccountServer } from "../../src/server/http-server.js";
import { AccountClient } from "../../src/client/account-client.js";

describe("AccountServer HTTP API Integration", () => {
  let db: AccountDatabase;
  let adminService: AdminService;
  let server: AccountServer;
  let serverUrl: string;
  let client: AccountClient;

  before(async () => {
    db = AccountDatabase.open(":memory:");
    adminService = new AdminService(db);

    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    await adminService.createUser(admin.id, {
      username: "alice",
      password: "alice-password-123",
      role: "USER",
    });

    server = new AccountServer(db, { port: 0, host: "127.0.0.1" });
    const started = await server.start();
    serverUrl = started.url;
    client = new AccountClient({ baseUrl: serverUrl });
  });

  after(async () => {
    await server.stop();
    db.close();
  });

  test("1. public health check returns ok", async () => {
    const health = await client.checkHealth();
    assert.strictEqual(health.status, "ok");
    assert.strictEqual(health.version, "0.1.0");
  });

  test("2. public registration / signup endpoint is strictly disallowed", async () => {
    const res = await fetch(`${serverUrl}/api/v1/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "hacker", password: "password123" }),
    });

    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error.code, "PUBLIC_SIGNUP_DISABLED");
  });

  test("3. login returns valid bearer token and profile", async () => {
    const res = await client.login("alice", "alice-password-123");

    assert.strictEqual(res.user.username, "alice");
    assert.strictEqual(res.user.role, "USER");
    assert.ok(res.token.startsWith("ovsc_sess_"));

    const me = await client.getProfile();
    assert.strictEqual(me.username, "alice");
  });

  test("4. protected routes reject unauthenticated requests", async () => {
    const unauthClient = new AccountClient({ baseUrl: serverUrl });

    await assert.rejects(
      () => unauthClient.getProfile(),
      (err: any) => err.statusCode === 401 && err.code === "UNAUTHORIZED"
    );
  });

  test("5. regular user cannot access admin endpoints", async () => {
    // client is authenticated as Alice (USER)
    await assert.rejects(
      () => client.adminListUsers(),
      (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN"
    );

    await assert.rejects(
      () => client.adminCreateUser({ username: "mallory", password: "mallory-pass" }),
      (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN"
    );
  });

  test("6. admin can manage users via API", async () => {
    const adminClient = new AccountClient({ baseUrl: serverUrl });
    await adminClient.login("admin", "admin-pass-1234");

    const users = await adminClient.adminListUsers();
    assert.ok(users.length >= 2);

    const created = await adminClient.adminCreateUser({
      username: "david",
      password: "david-pass-1234",
      role: "USER",
    });
    assert.strictEqual(created.username, "david");

    const updated = await adminClient.adminSetStatus(created.id, "DISABLED");
    assert.strictEqual(updated.status, "DISABLED");

    await adminClient.adminResetPassword(created.id, "david-new-pass-1234");

    const audit = await adminClient.adminGetAuditLog();
    assert.ok(audit.length >= 3);
  });

  test("7. integration CRUD lifecycle over HTTP", async () => {
    // As Alice: register integration
    const reg = await client.registerIntegration({
      serverId: "sqlite-mcp",
      displayName: "SQLite MCP Server",
      transport: "stdio",
      nonSecretConfig: { command: "uvx", args: ["mcp-server-sqlite"] },
      credentialReference: null,
      enabledPreference: true,
    });
    assert.strictEqual(reg.serverId, "sqlite-mcp");

    // List integrations
    const list = await client.listIntegrations();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.serverId, "sqlite-mcp");

    // Get integration by ID
    const fetched = await client.getIntegration(reg.id);
    assert.strictEqual(fetched.id, reg.id);

    // Update integration
    const updated = await client.updateIntegration(reg.id, {
      displayName: "Updated SQLite Server",
      enabledPreference: false,
    });
    assert.strictEqual(updated.displayName, "Updated SQLite Server");
    assert.strictEqual(updated.enabledPreference, false);

    // Set and check workspace policy
    await client.setWorkspacePolicy(reg.id, "/Users/alice/repo", true, { readOnly: true });
    const effective = await client.getEffectiveWorkspaceIntegrations("/Users/alice/repo");
    assert.strictEqual(effective.length, 1);
    assert.strictEqual(effective[0]?.workspaceEnabled, true);

    // Delete integration
    await client.deleteIntegration(reg.id);
    const listAfter = await client.listIntegrations();
    assert.strictEqual(listAfter.length, 0);
  });

  test("8. enforces 64 KB request body size ceiling", async () => {
    const oversizedPayload = "a".repeat(70 * 1024); // 70 KB > 64 KB limit

    const res = await fetch(`${serverUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: oversizedPayload }),
    });

    assert.strictEqual(res.status, 413, "Must reject payload > 64 KB with HTTP 413");
  });

  test("9. refuses to start plain HTTP on non-loopback host without TLS", async () => {
    const remoteServer = new AccountServer(db, { port: 0, host: "192.168.1.50" });

    await assert.rejects(
      () => remoteServer.start(),
      (err: any) => err.code === "SECURITY_VIOLATION"
    );
  });
});
