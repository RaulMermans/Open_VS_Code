import type { DatabaseConnection, User, UserRole, UserStatus } from "../../types.js";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role as UserRole,
    status: row.status as UserStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UserRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(user: User): void {
    this.db.run(
      `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [user.id, user.username, user.passwordHash, user.role, user.status, user.createdAt, user.updatedAt]
    );
  }

  findById(id: string): User | undefined {
    const row = this.db.get<UserRow>("SELECT * FROM users WHERE id = ?;", [id]);
    return row ? mapRow(row) : undefined;
  }

  findByUsername(username: string): User | undefined {
    const row = this.db.get<UserRow>("SELECT * FROM users WHERE username = ? COLLATE NOCASE;", [username]);
    return row ? mapRow(row) : undefined;
  }

  listAll(): User[] {
    const rows = this.db.all<UserRow>("SELECT * FROM users ORDER BY created_at ASC;");
    return rows.map(mapRow);
  }

  updateStatus(id: string, status: UserStatus, updatedAt: string = new Date().toISOString()): void {
    this.db.run("UPDATE users SET status = ?, updated_at = ? WHERE id = ?;", [status, updatedAt, id]);
  }

  updatePassword(id: string, passwordHash: string, updatedAt: string = new Date().toISOString()): void {
    this.db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?;", [passwordHash, updatedAt, id]);
  }

  count(): number {
    const row = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM users;");
    return row?.c ?? 0;
  }
}
