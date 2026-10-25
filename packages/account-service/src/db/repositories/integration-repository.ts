import type { DatabaseConnection, IntegrationRegistration, McpTransportType } from "../../types.js";

interface IntegrationRow {
  id: string;
  owner_user_id: string;
  server_id: string;
  display_name: string;
  transport: string;
  non_secret_config: string;
  credential_reference: string | null;
  enabled_preference: number;
  created_at: string;
  updated_at: string;
  schema_version: number;
}

function mapRow(row: IntegrationRow): IntegrationRegistration {
  let parsedConfig: Record<string, unknown> = {};
  try {
    parsedConfig = JSON.parse(row.non_secret_config);
  } catch {
    parsedConfig = {};
  }

  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    serverId: row.server_id,
    displayName: row.display_name,
    transport: row.transport as McpTransportType,
    nonSecretConfig: parsedConfig,
    credentialReference: row.credential_reference,
    enabledPreference: row.enabled_preference === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schemaVersion: row.schema_version,
  };
}

export class IntegrationRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(reg: IntegrationRegistration): void {
    this.db.run(
      `INSERT INTO integration_registrations
       (id, owner_user_id, server_id, display_name, transport, non_secret_config, credential_reference, enabled_preference, created_at, updated_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        reg.id,
        reg.ownerUserId,
        reg.serverId,
        reg.displayName,
        reg.transport,
        JSON.stringify(reg.nonSecretConfig),
        reg.credentialReference ?? null,
        reg.enabledPreference ? 1 : 0,
        reg.createdAt,
        reg.updatedAt,
        reg.schemaVersion,
      ]
    );
  }

  findById(id: string): IntegrationRegistration | undefined {
    const row = this.db.get<IntegrationRow>("SELECT * FROM integration_registrations WHERE id = ?;", [id]);
    return row ? mapRow(row) : undefined;
  }

  findByOwnerAndId(ownerUserId: string, id: string): IntegrationRegistration | undefined {
    const row = this.db.get<IntegrationRow>(
      "SELECT * FROM integration_registrations WHERE id = ? AND owner_user_id = ?;",
      [id, ownerUserId]
    );
    return row ? mapRow(row) : undefined;
  }

  findByOwnerAndServerId(ownerUserId: string, serverId: string): IntegrationRegistration | undefined {
    const row = this.db.get<IntegrationRow>(
      "SELECT * FROM integration_registrations WHERE owner_user_id = ? AND server_id = ?;",
      [ownerUserId, serverId]
    );
    return row ? mapRow(row) : undefined;
  }

  listByOwner(ownerUserId: string): IntegrationRegistration[] {
    const rows = this.db.all<IntegrationRow>(
      "SELECT * FROM integration_registrations WHERE owner_user_id = ? ORDER BY created_at ASC;",
      [ownerUserId]
    );
    return rows.map(mapRow);
  }

  update(reg: IntegrationRegistration): boolean {
    const result = this.db.run(
      `UPDATE integration_registrations
       SET display_name = ?, transport = ?, non_secret_config = ?, credential_reference = ?, enabled_preference = ?, updated_at = ?, schema_version = ?
       WHERE id = ? AND owner_user_id = ?;`,
      [
        reg.displayName,
        reg.transport,
        JSON.stringify(reg.nonSecretConfig),
        reg.credentialReference ?? null,
        reg.enabledPreference ? 1 : 0,
        reg.updatedAt,
        reg.schemaVersion,
        reg.id,
        reg.ownerUserId,
      ]
    );
    return result.changes > 0;
  }

  delete(id: string, ownerUserId: string): boolean {
    const result = this.db.run(
      "DELETE FROM integration_registrations WHERE id = ? AND owner_user_id = ?;",
      [id, ownerUserId]
    );
    return result.changes > 0;
  }
}
