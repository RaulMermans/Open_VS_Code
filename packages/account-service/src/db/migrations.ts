import type { DatabaseConnection } from "../types.js";

export interface Migration {
  readonly version: number;
  readonly description: string;
  readonly up: (db: DatabaseConnection) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Initial schema: users, sessions, integrations, policies, audit_events",
    up: (db: DatabaseConnection) => {
      db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('ADMIN', 'USER')),
          status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_verifier TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          last_used_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_token_verifier ON sessions(token_verifier);

        CREATE TABLE IF NOT EXISTS integration_registrations (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          transport TEXT NOT NULL,
          non_secret_config TEXT NOT NULL,
          credential_reference TEXT,
          enabled_preference INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(owner_user_id, server_id)
        );

        CREATE INDEX IF NOT EXISTS idx_integrations_owner ON integration_registrations(owner_user_id);

        CREATE TABLE IF NOT EXISTS integration_workspace_policies (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          integration_id TEXT NOT NULL REFERENCES integration_registrations(id) ON DELETE CASCADE,
          workspace_identity TEXT NOT NULL,
          enabled_state INTEGER NOT NULL DEFAULT 1,
          applicable_permission_restrictions TEXT,
          UNIQUE(user_id, integration_id, workspace_identity)
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_policies_user_ws ON integration_workspace_policies(user_id, workspace_identity);

        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILED')),
          details TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor);
      `);
    },
  },
  {
    version: 2,
    description: "Sprint 8D: mode_profiles table for user-owned custom mode profiles",
    up: (db: DatabaseConnection) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mode_profiles (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          icon TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          base_mode TEXT NOT NULL CHECK (base_mode IN ('ASK', 'PLAN', 'BUILD', 'DEBUG', 'REVIEW')),
          custom_instructions TEXT,
          required_skills TEXT NOT NULL,
          optional_skills TEXT NOT NULL,
          required_mcp_servers TEXT NOT NULL,
          optional_mcp_servers TEXT NOT NULL,
          tool_allowlist TEXT,
          preferred_model_id TEXT,
          workflow_preference TEXT,
          context_guidance TEXT,
          verification_preferences TEXT,
          source_repo_references TEXT,
          scope TEXT NOT NULL DEFAULT 'account',
          enabled_state INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(owner_user_id, profile_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mode_profiles_owner ON mode_profiles(owner_user_id);
        CREATE INDEX IF NOT EXISTS idx_mode_profiles_owner_profile ON mode_profiles(owner_user_id, profile_id);
      `);
    },
  },
];

export function runMigrations(db: DatabaseConnection): { applied: number[]; currentVersion: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `);

  const appliedRows = db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version ASC;");
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  const freshlyApplied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (!appliedSet.has(migration.version)) {
      db.exec("BEGIN TRANSACTION;");
      try {
        migration.up(db);
        db.run(
          "INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?);",
          [migration.version, new Date().toISOString(), migration.description]
        );
        db.exec("COMMIT;");
        freshlyApplied.push(migration.version);
      } catch (err) {
        db.exec("ROLLBACK;");
        throw new Error(
          `Failed to apply migration version ${migration.version} (${migration.description}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
  }

  const latestRow = db.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations;");
  const currentVersion = latestRow?.version ?? 0;

  return { applied: freshlyApplied, currentVersion };
}
