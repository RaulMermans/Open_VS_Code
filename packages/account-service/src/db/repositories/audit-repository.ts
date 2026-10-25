import type { AuditAction, AuditEvent, AuditOutcome, DatabaseConnection } from "../../types.js";

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  outcome: string;
  details: string | null;
}

function mapRow(row: AuditRow): AuditEvent {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details);
    } catch {
      details = null;
    }
  }

  return {
    id: row.id,
    actor: row.actor,
    action: row.action as AuditAction,
    target: row.target,
    timestamp: row.timestamp,
    outcome: row.outcome as AuditOutcome,
    details,
  };
}

export class AuditRepository {
  constructor(private readonly db: DatabaseConnection) {}

  record(event: AuditEvent): void {
    const detailsStr = event.details ? JSON.stringify(event.details) : null;
    this.db.run(
      `INSERT INTO audit_events (id, actor, action, target, timestamp, outcome, details)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [event.id, event.actor, event.action, event.target, event.timestamp, event.outcome, detailsStr]
    );
  }

  listRecent(limit = 100): AuditEvent[] {
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const rows = this.db.all<AuditRow>(
      "SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT ?;",
      [safeLimit]
    );
    return rows.map(mapRow);
  }

  query(filters: {
    actor?: string;
    action?: string;
    target?: string;
    since?: string;
    limit?: number;
  }): AuditEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.actor) {
      conditions.push("actor = ?");
      params.push(filters.actor);
    }
    if (filters.action) {
      conditions.push("action = ?");
      params.push(filters.action);
    }
    if (filters.target) {
      conditions.push("target = ?");
      params.push(filters.target);
    }
    if (filters.since) {
      conditions.push("timestamp >= ?");
      params.push(filters.since);
    }

    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
    const safeLimit = Math.min(Math.max(1, filters.limit ?? 100), 500);
    params.push(safeLimit);

    const rows = this.db.all<AuditRow>(
      `SELECT * FROM audit_events ${whereClause} ORDER BY timestamp DESC LIMIT ?;`,
      params
    );
    return rows.map(mapRow);
  }
}
