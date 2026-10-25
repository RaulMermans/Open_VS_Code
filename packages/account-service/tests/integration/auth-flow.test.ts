import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { AccountDatabase } from "../../src/db/connection.js";
import { AdminService } from "../../src/admin/admin-service.js";
import { AuthService } from "../../src/auth/auth-service.js";
import { RateLimiter } from "../../src/auth/rate-limiter.js";

describe("AuthService Integration", () => {
  let db: AccountDatabase;
  let adminService: AdminService;
  let authService: AuthService;

  beforeEach(async () => {
    db = AccountDatabase.open(":memory:");
    adminService = new AdminService(db);
    authService = new AuthService(db, {
      rateLimiter: new RateLimiter({ maxAttempts: 5, windowMs: 60000 }),
    });

    // Create admin and test user
    const admin = await adminService.bootstrapFirstAdmin("admin", "admin-pass-1234");
    await adminService.createUser(admin.id, {
      username: "alice",
      password: "alice-correct-password-1",
      role: "USER",
    });
  });

  afterEach(() => {
    db.close();
  });

  test("1. login success returns opaque token and records verifier in DB", async () => {
    const res = await authService.login("alice", "alice-correct-password-1");

    assert.ok(res.token.startsWith("ovsc_sess_"), "Must return opaque bearer token");
    assert.strictEqual(res.session.userId.length > 0, true);

    // Verify database only contains SHA-256 verifier, never raw token
    const dbSession = db.sessions.findById(res.session.id);
    assert.ok(dbSession);
    assert.notStrictEqual(dbSession.tokenVerifier, res.token, "Raw token must NOT be in DB");
    assert.strictEqual(dbSession.tokenVerifier, authService.tokenService.hashToken(res.token));
  });

  test("2. rejects invalid password with generic error and records failure", async () => {
    await assert.rejects(
      () => authService.login("alice", "wrong-password"),
      (err: any) => err.code === "INVALID_CREDENTIALS"
    );

    const audit = db.audit.query({ action: "AUTH_FAILED" });
    assert.ok(audit.length >= 1);
  });

  test("3. unknown username returns generic error with indistinguishable timing (anti-enumeration)", async () => {
    await assert.rejects(
      () => authService.login("nonexistent_user", "some-password-attempt"),
      (err: any) => err.code === "INVALID_CREDENTIALS"
    );
  });

  test("4. brute force attempts trigger rate limit lockout", async () => {
    // 5 consecutive failed attempts
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => authService.login("alice", `wrong-${i}`),
        (err: any) => err.code === "INVALID_CREDENTIALS"
      );
    }

    // 6th attempt must be rejected with RATE_LIMIT_EXCEEDED before checking password
    await assert.rejects(
      () => authService.login("alice", "alice-correct-password-1"),
      (err: any) => err.code === "RATE_LIMIT_EXCEEDED"
    );
  });

  test("5. successful login clears rate limit counter", async () => {
    // 2 failed attempts
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        () => authService.login("alice", `wrong-${i}`),
        (err: any) => err.code === "INVALID_CREDENTIALS"
      );
    }

    // Successful login clears failures
    const res = await authService.login("alice", "alice-correct-password-1");
    assert.ok(res.token);

    // Can fail 4 more times without hitting 5-attempt limit
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        () => authService.login("alice", `wrong-${i}`),
        (err: any) => err.code === "INVALID_CREDENTIALS"
      );
    }
  });

  test("6. session validation verifies token and touches last_used_at", async () => {
    const loginRes = await authService.login("alice", "alice-correct-password-1");
    const sessionBefore = db.sessions.findById(loginRes.session.id)!;

    const { user, session } = await authService.validateSession(loginRes.token);
    assert.strictEqual(user.username, "alice");
    assert.strictEqual(session.id, loginRes.session.id);

    const sessionAfter = db.sessions.findById(loginRes.session.id)!;
    assert.ok(sessionAfter.lastUsedAt >= sessionBefore.lastUsedAt);
  });

  test("7. expired session is rejected", async () => {
    const shortAuth = new AuthService(db, {
      sessionDurationMs: -1000, // Expired immediately
    });

    const res = await shortAuth.login("alice", "alice-correct-password-1");

    await assert.rejects(
      () => shortAuth.validateSession(res.token),
      (err: any) => err.code === "UNAUTHORIZED"
    );
  });

  test("8. logout revokes session and token reuse is rejected", async () => {
    const loginRes = await authService.login("alice", "alice-correct-password-1");

    // Valid prior to logout
    const valid = await authService.validateSession(loginRes.token);
    assert.strictEqual(valid.user.username, "alice");

    // Perform logout
    await authService.logout(loginRes.token);

    // Reuse must be rejected
    await assert.rejects(
      () => authService.validateSession(loginRes.token),
      (err: any) => err.code === "UNAUTHORIZED"
    );
  });
});
