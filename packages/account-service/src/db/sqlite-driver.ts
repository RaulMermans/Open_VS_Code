import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseConnection } from "../types.js";
import { UnsupportedDatabaseRuntimeError } from "../errors.js";
function loadSqliteModule(): any {
  if (typeof process !== "undefined" && typeof (process as any).getBuiltinModule === "function") {
    try {
      return (process as any).getBuiltinModule("node:sqlite");
    } catch {
      // ignore
    }
  }
  if (typeof require === "function") {
    try {
      return require("node:sqlite");
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Native Node DatabaseSync driver for Node >= 22
 */
class NodeSqliteConnection implements DatabaseConnection {
  private db: any;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    // Dynamic load for node:sqlite
    const sqliteMod = loadSqliteModule();
    if (!sqliteMod?.DatabaseSync) {
      throw new Error("node:sqlite DatabaseSync is not available");
    }
    this.db = new sqliteMod.DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params || []));
    return {
      changes: typeof result?.changes === "number" ? result.changes : 0,
      lastInsertRowid: result?.lastInsertRowid ?? 0,
    };
  }

  get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params || [])) as T | undefined;
  }

  all<T = unknown>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params || [])) as T[];
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Fallback CLI-based driver for environments where node:sqlite is unavailable.
 * Fails closed to prevent data corruption, missing transaction isolation,
 * zero row counts, and bypassed foreign key cascading.
 */
export class SqliteCliConnection implements DatabaseConnection {
  constructor(_dbPath: string) {
    throw new UnsupportedDatabaseRuntimeError(
      "SqliteCliConnection cannot guarantee foreign key constraints, transactional isolation across statements, or DML row counts. Node.js >= 22.0.0 with native 'node:sqlite' DatabaseSync is required."
    );
  }

  exec(_sql: string): void {
    throw new UnsupportedDatabaseRuntimeError();
  }

  run(_sql: string, _params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    throw new UnsupportedDatabaseRuntimeError();
  }

  get<T = unknown>(_sql: string, _params?: unknown[]): T | undefined {
    throw new UnsupportedDatabaseRuntimeError();
  }

  all<T = unknown>(_sql: string, _params?: unknown[]): T[] {
    throw new UnsupportedDatabaseRuntimeError();
  }

  close(): void {}
}

/**
 * Factory for creating a DatabaseConnection.
 * Enforces native Node 22+ node:sqlite DatabaseSync. Fails closed with an actionable
 * dependency error if native SQLite is unavailable.
 */
export function createDatabase(dbPath: string): DatabaseConnection {
  const sqliteMod = loadSqliteModule();
  if (typeof sqliteMod?.DatabaseSync === "function") {
    return new NodeSqliteConnection(dbPath);
  }
  throw new UnsupportedDatabaseRuntimeError();
}
