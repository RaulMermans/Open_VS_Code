import type { DatabaseConnection, Session } from "../../types.js";

interface SessionRow {
  id: string;
  user_id: string;
  token_verifier: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string;
}

function mapRow(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenVerifier: row.token_verifier,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export class SessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(session: Session): void {
    this.db.run(
      `INSERT INTO sessions (id, user_id, token_verifier, created_at, expires_at, revoked_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [session.id, session.userId, session.tokenVerifier, session.createdAt, session.expiresAt, session.revokedAt, session.lastUsedAt]
    );
  }

  findById(id: string): Session | undefined {
    const row = this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?;", [id]);
    return row ? mapRow(row) : undefined;
  }

  findByTokenVerifier(tokenVerifier: string): Session | undefined {
    const row = this.db.get<SessionRow>("SELECT * FROM sessions WHERE token_verifier = ?;", [tokenVerifier]);
    return row ? mapRow(row) : undefined;
  }

  touch(id: string, lastUsedAt: string = new Date().toISOString()): void {
    this.db.run("UPDATE sessions SET last_used_at = ? WHERE id = ?;", [lastUsedAt, id]);
  }

  revoke(id: string, revokedAt: string = new Date().toISOString()): void {
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL;", [revokedAt, id]);
  }

  revokeAllForUser(userId: string, revokedAt: string = new Date().toISOString()): void {
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL;", [revokedAt, userId]);
  }

  deleteExpired(nowIso: string = new Date().toISOString()): number {
    const result = this.db.run("DELETE FROM sessions WHERE expires_at <= ?;", [nowIso]);
    return result.changes;
  }
}
