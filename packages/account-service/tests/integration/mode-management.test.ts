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
} from "../../src/index.js";

describe("ModeService & Account API Integration (Sprint 8D)", () => {
  let tmpDir: string;
  let db: AccountDatabase;
  let server: AccountServer;
  let clientAlice: AccountClient;
  let clientBob: AccountClient;
  let aliceId: string;
  let bobId: string;
  let serverUrl: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mode-test-"));
    const dbPath = join(tmpDir, "account.db");
    db = AccountDatabase.open(dbPath);

    const adminService = new AdminService(db);
    const authService = new AuthService(db);

    // Bootstrap Admin
    const admin = await adminService.bootstrapFirstAdmin("admin", "adminpassword123");

    // Create Alice & Bob
    const alice = await adminService.createUser(admin.id, {
      username: "alice",
      password: "alicepassword123",
      role: "USER",
    });
    aliceId = alice.id;

    const bob = await adminService.createUser(admin.id, {
      username: "bob",
      password: "bobpassword123",
      role: "USER",
    });
    bobId = bob.id;

    // Start HTTP Server
    server = new AccountServer(db, { port: 0, host: "127.0.0.1" });
    const started = await server.start();
    serverUrl = started.url;

    // Login Alice
    const aliceAuth = await authService.login("alice", "alicepassword123");
    clientAlice = new AccountClient({
      baseUrl: serverUrl,
      token: aliceAuth.token,
    });

    // Login Bob
    const bobAuth = await authService.login("bob", "bobpassword123");
    clientBob = new AccountClient({
      baseUrl: serverUrl,
      token: bobAuth.token,
    });
  });

  after(async () => {
    if (server) await server.stop();
    if (db) db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("1. Alice creates a custom mode profile", async () => {
    const created = await clientAlice.createMode({
      profileId: "alice-sec-mode",
      name: "Alice Security Mode",
      description: "Custom security review profile",
      baseMode: "REVIEW",
      customInstructions: "Strictly check for injection vulnerabilities.",
      requiredSkills: ["sec-audit"],
      optionalSkills: ["code-metrics"],
      requiredMcpServers: ["db-inspect"],
      optionalMcpServers: [],
      toolAllowlist: ["read_repository", "search_repository", "read_markdown"],
      preferredModelId: "qwen-7b",
      workflowPreference: "direct",
    });

    assert.equal(created.profileId, "alice-sec-mode");
    assert.equal(created.name, "Alice Security Mode");
    assert.equal(created.baseMode, "REVIEW");
    assert.equal(created.scope, "account");
    assert.equal(created.ownerUserId, aliceId);
    assert.deepEqual(created.requiredSkills, ["sec-audit"]);
  });

  it("2. Alice retrieves and lists her mode profiles", async () => {
    const list = await clientAlice.listModes();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.profileId, "alice-sec-mode");

    const single = await clientAlice.getMode("alice-sec-mode");
    assert.equal(single.name, "Alice Security Mode");
    assert.equal(single.description, "Custom security review profile");
  });

  it("3. User isolation: Bob cannot see, get, update, or delete Alice's mode profile", async () => {
    const bobList = await clientBob.listModes();
    assert.equal(bobList.length, 0);

    // Bob trying to get Alice's mode
    await assert.rejects(
      async () => clientBob.getMode("alice-sec-mode"),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    // Bob trying to update Alice's mode
    await assert.rejects(
      async () => clientBob.updateMode("alice-sec-mode", { name: "Hacked" }),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );

    // Bob trying to delete Alice's mode
    await assert.rejects(
      async () => clientBob.deleteMode("alice-sec-mode"),
      (err: any) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it("4. Bob can create his own mode with the same profileId without collision (account-scoped)", async () => {
    const bobCreated = await clientBob.createMode({
      profileId: "alice-sec-mode", // same ID, different owner
      name: "Bob's Variant",
      description: "Bob's version of the mode",
      baseMode: "PLAN",
    });

    assert.equal(bobCreated.profileId, "alice-sec-mode");
    assert.equal(bobCreated.ownerUserId, bobId);
    assert.equal(bobCreated.name, "Bob's Variant");

    // Alice's mode is unaffected
    const aliceMode = await clientAlice.getMode("alice-sec-mode");
    assert.equal(aliceMode.name, "Alice Security Mode");
  });

  it("5. Alice updates her mode profile", async () => {
    const updated = await clientAlice.updateMode("alice-sec-mode", {
      name: "Alice Security Mode v2",
      description: "Updated description",
      customInstructions: "Updated instructions.",
      version: 2,
    });

    assert.equal(updated.name, "Alice Security Mode v2");
    assert.equal(updated.description, "Updated description");
    assert.equal(updated.version, 2);
    assert.equal(updated.customInstructions, "Updated instructions.");
  });

  it("6. Duplicate creation attempt by same user fails with ConflictError", async () => {
    await assert.rejects(
      async () => {
        await clientAlice.createMode({
          profileId: "alice-sec-mode",
          name: "Duplicate",
          description: "",
          baseMode: "REVIEW",
        });
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        return true;
      }
    );
  });

  it("7. Alice deletes her mode profile", async () => {
    await clientAlice.deleteMode("alice-sec-mode");

    const list = await clientAlice.listModes();
    assert.equal(list.length, 0);

    // Bob's profile is still there
    const bobMode = await clientBob.getMode("alice-sec-mode");
    assert.equal(bobMode.name, "Bob's Variant");
  });
});
