import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AccountDatabase,
  AccountServer,
  AccountClient,
  AdminService,
  AuthService,
  AuditRepository,
} from "../../src/index.js";

describe("CapabilityPackService & Account API Integration (Sprint 8E)", () => {
  let tmpDir: string;
  let db: AccountDatabase;
  let server: AccountServer;
  let clientAlice: AccountClient;
  let clientBob: AccountClient;
  let serverUrl: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pack-test-"));
    const dbPath = join(tmpDir, "account.db");
    db = AccountDatabase.open(dbPath);

    const adminService = new AdminService(db);
    const authService = new AuthService(db);

    // Bootstrap Admin
    const admin = await adminService.bootstrapFirstAdmin("admin", "adminpassword123");

    // Create Alice & Bob
    await adminService.createUser(admin.id, {
      username: "alice",
      password: "alicepassword123",
      role: "USER",
    });

    await adminService.createUser(admin.id, {
      username: "bob",
      password: "bobpassword123",
      role: "USER",
    });

    // Start HTTP Server
    server = new AccountServer(db, { port: 0, host: "127.0.0.1" });
    const started = await server.start();
    serverUrl = started.url;

    // Login Alice & Bob
    const aliceAuth = await authService.login("alice", "alicepassword123");
    clientAlice = new AccountClient({
      baseUrl: serverUrl,
      token: aliceAuth.token,
    });

    const bobAuth = await authService.login("bob", "bobpassword123");
    clientBob = new AccountClient({
      baseUrl: serverUrl,
      token: bobAuth.token,
    });
  });

  after(async () => {
    if (server) await server.stop();
    if (db) db.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  const testManifestV1 = {
    schemaVersion: 1,
    id: "alice-review-pack",
    name: "Alice Review Pack",
    description: "Code review capability pack owned by Alice",
    version: "1.0.0",
    publisher: { id: "alice", name: "Alice Walker" },
    license: "MIT",
    openVsCodeVersion: "^0.1.0",
    permissionDeclarations: ["read_repository"],
    requiredSkills: ["security-review"],
    optionalSkills: [],
    requiredMcpServers: [],
    optionalMcpServers: [],
    customMode: {
      id: "alice-mode",
      name: "Alice Mode",
      description: "Alice mode",
      version: 1,
      schemaVersion: 1,
      source: "account",
      baseMode: "REVIEW",
      requiredSkills: [],
      optionalSkills: [],
      requiredMcpServers: [],
      optionalMcpServers: [],
      scope: "account",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    documentation: { summary: "Alice review pack" },
    integrity: { algorithm: "sha256", digest: "a".repeat(64) },
  };

  it("1. Alice installs a capability pack (starts disabled)", async () => {
    const installed = await clientAlice.installPack(testManifestV1);
    assert.equal(installed.packId, "alice-review-pack");
    assert.equal(installed.version, "1.0.0");
    assert.equal(installed.name, "Alice Review Pack");
    assert.equal(installed.enabledState, false, "Install must not enable");
  });

  it("2. Alice retrieves and lists her capability packs", async () => {
    const packs = await clientAlice.listPacks();
    assert.equal(packs.length, 1);
    assert.equal(packs[0]!.packId, "alice-review-pack");

    const single = await clientAlice.getPack("alice-review-pack");
    assert.equal(single.packId, "alice-review-pack");
    assert.equal(single.version, "1.0.0");
  });

  it("3. User isolation: Bob cannot see or access Alice's pack", async () => {
    const bobPacks = await clientBob.listPacks();
    assert.equal(bobPacks.length, 0);

    await assert.rejects(
      async () => clientBob.getPack("alice-review-pack"),
      (err: any) => err.statusCode === 404
    );
  });

  it("4. Bob can install his own pack with the same packId without collision", async () => {
    const bobManifest = {
      ...testManifestV1,
      name: "Bob's Own Custom Pack",
      publisher: { id: "bob", name: "Bob Builder" },
    };
    const bobInstalled = await clientBob.installPack(bobManifest);
    assert.equal(bobInstalled.packId, "alice-review-pack");
    assert.equal(bobInstalled.name, "Bob's Own Custom Pack");

    // Alice's pack remains intact
    const alicePack = await clientAlice.getPack("alice-review-pack");
    assert.equal(alicePack.name, "Alice Review Pack");
  });

  it("5. Alice toggles (enables and disables) her pack", async () => {
    const enabled = await clientAlice.togglePack("alice-review-pack", true);
    assert.equal(enabled.enabledState, true);

    const disabled = await clientAlice.togglePack("alice-review-pack", false);
    assert.equal(disabled.enabledState, false);
  });

  it("6. Alice updates her pack (preserves previousVersion for rollback)", async () => {
    const updatedManifest = {
      ...testManifestV1,
      version: "1.1.0",
      description: "Updated description for Alice review pack",
    };
    const updated = await clientAlice.updatePack("alice-review-pack", updatedManifest);
    assert.equal(updated.version, "1.1.0");
    assert.equal(updated.previousVersion, "1.0.0");
    assert.equal(updated.description, "Updated description for Alice review pack");
  });

  it("7. Alice rolls back her pack to previous version", async () => {
    const rolledBack = await clientAlice.rollbackPack("alice-review-pack");
    assert.equal(rolledBack.version, "1.0.0");
    assert.equal(rolledBack.previousVersion, "1.1.0");
  });

  it("8. Duplicate installation attempt by same user fails with 409 Conflict", async () => {
    await assert.rejects(
      async () => clientAlice.installPack(testManifestV1),
      (err: any) => err.statusCode === 409
    );
  });

  it("9. Alice removes her pack", async () => {
    await clientAlice.removePack("alice-review-pack");
    const packs = await clientAlice.listPacks();
    assert.equal(packs.length, 0);

    await assert.rejects(
      async () => clientAlice.getPack("alice-review-pack"),
      (err: any) => err.statusCode === 404
    );
  });

  it("10. Audit trail records all pack lifecycle actions", async () => {
    const auditRepo = new AuditRepository(db.connection);
    const events = auditRepo.query({});
    const packActions = events.filter((e) => e.action.startsWith("PACK_"));
    assert.ok(packActions.some((e) => e.action === "PACK_INSTALL"));
    assert.ok(packActions.some((e) => e.action === "PACK_TOGGLE"));
    assert.ok(packActions.some((e) => e.action === "PACK_UPDATE"));
    assert.ok(packActions.some((e) => e.action === "PACK_ROLLBACK"));
    assert.ok(packActions.some((e) => e.action === "PACK_REMOVE"));
  });
});
