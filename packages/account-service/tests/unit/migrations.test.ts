import { test, describe } from "node:test";
import assert from "node:assert";
import { createDatabase } from "../../src/db/sqlite-driver.js";
import { runMigrations } from "../../src/db/migrations.js";

describe("Database Migrations", () => {
  test("1. applies migrations cleanly to empty database", () => {
    const db = createDatabase(":memory:");
    try {
      const res = runMigrations(db);
      assert.strictEqual(res.currentVersion, 1);
      assert.deepStrictEqual(res.applied, [1]);

      // Verify tables exist
      const tables = db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
      );
      const names = new Set(tables.map((t: { name: string }) => t.name));
      assert.ok(names.has("users"));
      assert.ok(names.has("sessions"));
      assert.ok(names.has("integration_registrations"));
      assert.ok(names.has("integration_workspace_policies"));
      assert.ok(names.has("audit_events"));
      assert.ok(names.has("schema_migrations"));
    } finally {
      db.close();
    }
  });

  test("2. runs migrations idempotently without duplicate errors", () => {
    const db = createDatabase(":memory:");
    try {
      const first = runMigrations(db);
      assert.deepStrictEqual(first.applied, [1]);

      const second = runMigrations(db);
      assert.deepStrictEqual(second.applied, [], "No new migrations should be applied on second run");
      assert.strictEqual(second.currentVersion, 1);
    } finally {
      db.close();
    }
  });

  test("3. enforces foreign key cascading deletions", () => {
    const db = createDatabase(":memory:");
    try {
      runMigrations(db);

      // Insert user
      db.run(
        "INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);",
        ["u1", "alice", "hash", "USER", "ACTIVE", new Date().toISOString(), new Date().toISOString()]
      );

      // Insert session
      db.run(
        "INSERT INTO sessions (id, user_id, token_verifier, created_at, expires_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?);",
        ["s1", "u1", "v1", new Date().toISOString(), new Date().toISOString(), null, new Date().toISOString()]
      );

      // Insert integration
      db.run(
        "INSERT INTO integration_registrations (id, owner_user_id, server_id, display_name, transport, non_secret_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
        ["i1", "u1", "mcp1", "MCP 1", "stdio", "{}", new Date().toISOString(), new Date().toISOString()]
      );

      assert.strictEqual(db.all("SELECT * FROM sessions WHERE user_id = 'u1';").length, 1);
      assert.strictEqual(db.all("SELECT * FROM integration_registrations WHERE owner_user_id = 'u1';").length, 1);

      // Delete user
      db.run("DELETE FROM users WHERE id = 'u1';");

      // Sessions and integrations must cascade delete
      assert.strictEqual(db.all("SELECT * FROM sessions WHERE user_id = 'u1';").length, 0);
      assert.strictEqual(db.all("SELECT * FROM integration_registrations WHERE owner_user_id = 'u1';").length, 0);
    } finally {
      db.close();
    }
  });
});
