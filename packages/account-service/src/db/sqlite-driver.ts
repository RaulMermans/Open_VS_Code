import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { DatabaseConnection } from "../types.js";
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
 * Fallback CLI-based driver for environments where node:sqlite is unavailable
 */
class SqliteCliConnection implements DatabaseConnection {
  private tempDbPath?: string;
  private targetDbPath: string;

  constructor(dbPath: string) {
    if (dbPath === ":memory:") {
      this.tempDbPath = path.join("/tmp", `ovsc_acc_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
      this.targetDbPath = this.tempDbPath;
    } else {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.targetDbPath = dbPath;
    }
    this.exec("PRAGMA foreign_keys = ON;");
  }

  private runSql(sql: string, json = false): string {
    const args = [this.targetDbPath];
    if (json) {
      args.push("-json");
    }
    args.push(sql);
    const output = execFileSync("/usr/bin/sqlite3", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim();
  }

  private escapeParam(val: unknown): string {
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number" || typeof val === "bigint") return String(val);
    if (typeof val === "boolean") return val ? "1" : "0";
    const str = String(val);
    return "'" + str.replace(/'/g, "''") + "'";
  }

  private interpolate(sql: string, params?: unknown[]): string {
    if (!params || params.length === 0) return sql;
    let idx = 0;
    return sql.replace(/\?/g, () => {
      if (idx >= params.length) return "NULL";
      const val = params[idx++];
      return this.escapeParam(val);
    });
  }

  exec(sql: string): void {
    this.runSql(sql);
  }

  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const interpolated = this.interpolate(sql, params);
    this.runSql(interpolated);
    const changesRaw = this.runSql("SELECT changes() AS c; -json", true);
    let changes = 0;
    try {
      const parsed = JSON.parse(changesRaw);
      changes = parsed[0]?.c ?? 0;
    } catch {
      // ignore
    }
    return { changes, lastInsertRowid: 0 };
  }

  get<T = unknown>(sql: string, params?: unknown[]): T | undefined {
    const items = this.all<T>(sql, params);
    return items[0];
  }

  all<T = unknown>(sql: string, params?: unknown[]): T[] {
    const interpolated = this.interpolate(sql, params);
    const raw = this.runSql(interpolated, true);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as T[];
    } catch {
      return [];
    }
  }

  close(): void {
    if (this.tempDbPath && fs.existsSync(this.tempDbPath)) {
      try {
        fs.unlinkSync(this.tempDbPath);
      } catch {
        // Safe temp file cleanup
      }
    }
  }
}

/**
 * Factory for creating a DatabaseConnection.
 * Prefers native Node node:sqlite, falls back gracefully to system sqlite3 CLI.
 */
export function createDatabase(dbPath: string): DatabaseConnection {
  const sqliteMod = loadSqliteModule();
  if (typeof sqliteMod?.DatabaseSync === "function") {
    return new NodeSqliteConnection(dbPath);
  }
  return new SqliteCliConnection(dbPath);
}
