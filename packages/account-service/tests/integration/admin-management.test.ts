import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AccountDatabase } from "../../src/db/connection.js";
import { AdminService } from "../../src/admin/admin-service.js";
import { AuthService } from "../../src/auth/auth-service.js";

describe("AdminService Integration", () => {
  let db: AccountDatabase;
  let adminService: AdminService;
  let authService: AuthService;

  beforeEach(() => {
    db = AccountDatabase.open(":memory:");
    adminService = new AdminService(db);
    authService = new AuthService(db);
  });

  afterEach(() => {
    db.close();
  });

  test("1. bootstraps initial administrator when database is empty", async () => {
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-super-password-2026");

    assert.strictEqual(admin.username, "admin");
    assert.strictEqual(admin.role, "ADMIN");
    assert.strictEqual(admin.status, "ACTIVE");

    const audit = db.audit.listRecent();
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0]?.action, "USER_BOOTSTRAP");
    assert.strictEqual(audit[0]?.outcome, "SUCCESS");
  });

  test("2. rejects second bootstrap attempt when accounts already exist", async () => {
    await adminService.bootstrapFirstAdmin("admin", "admin-super-password-2026");

    await assert.rejects(
      () => adminService.bootstrapFirstAdmin("hacker", "evil-password-1234"),
      (err: any) => err.code === "BOOTSTRAP_DISALLOWED"
    );
  });

  test("3. non-admin user cannot create accounts", async () => {
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    const regularUser = await adminService.createUser(admin.id, {
      username: "bob",
      password: "bob-secure-password",
      role: "USER",
    });

    await assert.rejects(
      () => adminService.createUser(regularUser.id, {
        username: "eve",
        password: "eve-secure-password",
        role: "USER",
      }),
      (err: any) => err.code === "FORBIDDEN"
    );
  });

  test("4. admin creates user accounts and explicit roles", async () => {
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");

    const user1 = await adminService.createUser(admin.id, {
      username: "alice",
      password: "alice-secure-password",
      role: "USER",
    });
    assert.strictEqual(user1.username, "alice");
    assert.strictEqual(user1.role, "USER");

    const user2 = await adminService.createUser(admin.id, {
      username: "carol",
      password: "carol-secure-password",
      role: "ADMIN",
    });
    assert.strictEqual(user2.username, "carol");
    assert.strictEqual(user2.role, "ADMIN");

    const allUsers = await adminService.listUsers(admin.id);
    assert.strictEqual(allUsers.length, 3);
  });

  test("5. disabling account revokes all active sessions immediately", async () => {
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    const user = await adminService.createUser(admin.id, {
      username: "dan",
      password: "dan-password-123",
      role: "USER",
    });

    // Login as dan
    const loginRes = await authService.login("dan", "dan-password-123");
    assert.ok(loginRes.token);

    // Validate session works while active
    const valid = await authService.validateSession(loginRes.token);
    assert.strictEqual(valid.user.username, "dan");

    // Admin disables Dan's account
    await adminService.setStatus(admin.id, user.id, "DISABLED");

    // Existing session must be revoked
    await assert.rejects(
      () => authService.validateSession(loginRes.token),
      (err: any) => err.code === "UNAUTHORIZED" || err.code === "ACCOUNT_DISABLED"
    );

    // Dan cannot log in again
    await assert.rejects(
      () => authService.login("dan", "dan-password-123"),
      (err: any) => err.code === "ACCOUNT_DISABLED"
    );
  });

  test("6. resetting user password revokes all active sessions", async () => {
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    const user = await adminService.createUser(admin.id, {
      username: "frank",
      password: "frank-old-password",
      role: "USER",
    });

    // Login with old password
    const loginRes = await authService.login("frank", "frank-old-password");
    assert.ok(loginRes.token);

    // Admin resets password
    await adminService.resetPassword(admin.id, user.id, "frank-new-password");

    // Old session is revoked
    await assert.rejects(
      () => authService.validateSession(loginRes.token),
      (err: any) => err.code === "UNAUTHORIZED"
    );

    // Old password fails
    await assert.rejects(
      () => authService.login("frank", "frank-old-password"),
      (err: any) => err.code === "INVALID_CREDENTIALS"
    );

    // New password succeeds
    const newLogin = await authService.login("frank", "frank-new-password");
    assert.ok(newLogin.token);
  });

  test("7. audit log records all administrative actions", async () => {
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    const user = await adminService.createUser(admin.id, {
      username: "gina",
      password: "gina-password-123",
    });
    await adminService.setStatus(admin.id, user.id, "DISABLED");

    const events = await adminService.getAuditLog(admin.id);
    const actions = events.map((e) => e.action);

    assert.ok(actions.includes("USER_BOOTSTRAP"));
    assert.ok(actions.includes("USER_CREATE"));
    assert.ok(actions.includes("USER_STATUS_CHANGE"));
  });
});
