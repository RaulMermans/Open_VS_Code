import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AccountDatabase } from "../../src/db/connection.js";
import { AdminService } from "../../src/admin/admin-service.js";
import { IntegrationService } from "../../src/integration/integration-service.js";
import type { UserProfile } from "../../src/types.js";

describe("IntegrationService Registry Integration", () => {
  let db: AccountDatabase;
  let adminService: AdminService;
  let integrationService: IntegrationService;
  let userAlice: UserProfile;
  let userBob: UserProfile;

  beforeEach(async () => {
    db = AccountDatabase.open(":memory:");
    adminService = new AdminService(db);
    integrationService = new IntegrationService(db);

    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    userAlice = await adminService.createUser(admin.id, {
      username: "alice",
      password: "alice-password-123",
      role: "USER",
    });
    userBob = await adminService.createUser(admin.id, {
      username: "bob",
      password: "bob-password-123",
      role: "USER",
    });
  });

  afterEach(() => {
    db.close();
  });

  test("1. registers MCP integration associated with authenticated owner", async () => {
    const reg = await integrationService.register(userAlice.id, {
      serverId: "github-mcp",
      displayName: "GitHub Integration",
      transport: "streamable-http",
      nonSecretConfig: {
        url: "https://api.github.com/mcp",
        timeout: 5000,
      },
      credentialReference: "github_pat",
      enabledPreference: true,
    });

    assert.strictEqual(reg.ownerUserId, userAlice.id);
    assert.strictEqual(reg.serverId, "github-mcp");
    assert.strictEqual(reg.transport, "streamable-http");
    assert.strictEqual(reg.credentialReference, "github_pat");
    assert.strictEqual(reg.enabledPreference, true);
  });

  test("2. rejects literal plaintext secrets in nonSecretConfig", async () => {
    await assert.rejects(
      () => integrationService.register(userAlice.id, {
        serverId: "insecure-mcp",
        displayName: "Insecure Server",
        transport: "streamable-http",
        nonSecretConfig: {
          url: "https://api.example.com",
          apiKey: "sk-live-raw-secret-token-12345", // Literal secret
        },
      }),
      /appears to contain a literal secret.*Use credentialReference instead/
    );
  });

  test("3. permits env reference or secret reference in nonSecretConfig", async () => {
    const reg = await integrationService.register(userAlice.id, {
      serverId: "secure-mcp",
      displayName: "Secure Server",
      transport: "streamable-http",
      nonSecretConfig: {
        url: "https://api.example.com",
        apiKey: "${env:MY_API_KEY}", // Safe template reference
      },
      credentialReference: "my_api_key_ref",
    });
    assert.strictEqual(reg.serverId, "secure-mcp");
  });

  test("4. isolates integrations between users (cross-user access denial)", async () => {
    const regAlice = await integrationService.register(userAlice.id, {
      serverId: "alice-private-mcp",
      displayName: "Alice Server",
      transport: "stdio",
      nonSecretConfig: { command: "node", args: ["server.js"] },
    });

    // Bob cannot list Alice's integrations
    const bobList = await integrationService.list(userBob.id);
    assert.strictEqual(bobList.length, 0);

    // Bob cannot fetch Alice's integration by ID
    await assert.rejects(
      () => integrationService.get(userBob.id, regAlice.id),
      (err: any) => err.code === "NOT_FOUND"
    );

    // Bob cannot update Alice's integration
    await assert.rejects(
      () => integrationService.update(userBob.id, regAlice.id, { displayName: "Hacked" }),
      (err: any) => err.code === "NOT_FOUND"
    );

    // Bob cannot delete Alice's integration
    await assert.rejects(
      () => integrationService.delete(userBob.id, regAlice.id),
      (err: any) => err.code === "NOT_FOUND"
    );
  });

  test("5. enforces unique serverId per user", async () => {
    await integrationService.register(userAlice.id, {
      serverId: "unique-server",
      displayName: "Server 1",
      transport: "stdio",
      nonSecretConfig: { command: "mcp" },
    });

    // Duplicate for same user must fail
    await assert.rejects(
      () => integrationService.register(userAlice.id, {
        serverId: "unique-server",
        displayName: "Server 1 Duplicate",
        transport: "stdio",
        nonSecretConfig: { command: "mcp" },
      }),
      (err: any) => err.code === "CONFLICT"
    );

    // Another user can have the same serverId without collision
    const regBob = await integrationService.register(userBob.id, {
      serverId: "unique-server",
      displayName: "Bob's Server",
      transport: "stdio",
      nonSecretConfig: { command: "mcp" },
    });
    assert.strictEqual(regBob.ownerUserId, userBob.id);
  });

  test("6. associates permitted integrations with workspaces and calculates effective status", async () => {
    const reg = await integrationService.register(userAlice.id, {
      serverId: "workspace-mcp",
      displayName: "Workspace MCP",
      transport: "streamable-http",
      nonSecretConfig: { url: "http://127.0.0.1:8080/mcp" },
      enabledPreference: true,
    });

    const workspaceA = "/Users/alice/projects/project-a";
    const workspaceB = "/Users/alice/projects/project-b";

    // Workspace A: explicitly disabled
    await integrationService.setWorkspacePolicy(userAlice.id, reg.id, workspaceA, false);

    // Workspace B: enabled with tool restrictions
    await integrationService.setWorkspacePolicy(userAlice.id, reg.id, workspaceB, true, {
      blockedTools: ["dangerous_action"],
    });

    const effectiveA = await integrationService.getEffectiveIntegrations(userAlice.id, workspaceA);
    assert.strictEqual(effectiveA.length, 1);
    assert.strictEqual(effectiveA[0]?.effectiveEnabled, false);
    assert.strictEqual(effectiveA[0]?.workspaceEnabled, false);

    const effectiveB = await integrationService.getEffectiveIntegrations(userAlice.id, workspaceB);
    assert.strictEqual(effectiveB.length, 1);
    assert.strictEqual(effectiveB[0]?.effectiveEnabled, true);
    assert.strictEqual(effectiveB[0]?.workspaceEnabled, true);
    assert.deepStrictEqual(effectiveB[0]?.restrictions, { blockedTools: ["dangerous_action"] });
  });
});
