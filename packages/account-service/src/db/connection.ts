import type { DatabaseConnection } from "../types.js";
import { createDatabase } from "./sqlite-driver.js";
import { runMigrations } from "./migrations.js";
import { UserRepository } from "./repositories/user-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";
import { IntegrationRepository } from "./repositories/integration-repository.js";
import { PolicyRepository } from "./repositories/policy-repository.js";
import { AuditRepository } from "./repositories/audit-repository.js";

export class AccountDatabase {
  public readonly users: UserRepository;
  public readonly sessions: SessionRepository;
  public readonly integrations: IntegrationRepository;
  public readonly policies: PolicyRepository;
  public readonly audit: AuditRepository;

  constructor(public readonly connection: DatabaseConnection) {
    this.users = new UserRepository(connection);
    this.sessions = new SessionRepository(connection);
    this.integrations = new IntegrationRepository(connection);
    this.policies = new PolicyRepository(connection);
    this.audit = new AuditRepository(connection);
  }

  static open(dbPath: string): AccountDatabase {
    const conn = createDatabase(dbPath);
    runMigrations(conn);
    return new AccountDatabase(conn);
  }

  close(): void {
    this.connection.close();
  }
}
