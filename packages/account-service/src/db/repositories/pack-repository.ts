import type { DatabaseConnection, AccountCapabilityPack } from "../../types.js";

interface CapabilityPackRow {
  id: string;
  owner_user_id: string;
  pack_id: string;
  name: string;
  description: string;
  version: string;
  publisher: string;
  license: string;
  manifest_json: string;
  scope: string;
  enabled_state: number;
  previous_version: string | null;
  previous_manifest_json: string | null;
  created_at: string;
  updated_at: string;
  schema_version: number;
}

function mapRow(row: CapabilityPackRow): AccountCapabilityPack {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    packId: row.pack_id,
    name: row.name,
    description: row.description,
    version: row.version,
    publisher: row.publisher,
    license: row.license,
    manifestJson: row.manifest_json,
    scope: "account",
    enabledState: row.enabled_state === 1,
    previousVersion: row.previous_version,
    previousManifestJson: row.previous_manifest_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schemaVersion: row.schema_version,
  };
}

export class CapabilityPackRepository {
  constructor(private readonly db: DatabaseConnection) {}

  listByOwner(ownerUserId: string): AccountCapabilityPack[] {
    const rows = this.db.all<CapabilityPackRow>(
      "SELECT * FROM capability_packs WHERE owner_user_id = ? ORDER BY name ASC;",
      [ownerUserId]
    );
    return rows.map(mapRow);
  }

  findByOwnerAndPackId(ownerUserId: string, packId: string): AccountCapabilityPack | undefined {
    const row = this.db.get<CapabilityPackRow>(
      "SELECT * FROM capability_packs WHERE owner_user_id = ? AND pack_id = ?;",
      [ownerUserId, packId]
    );
    return row ? mapRow(row) : undefined;
  }

  findById(id: string): AccountCapabilityPack | undefined {
    const row = this.db.get<CapabilityPackRow>(
      "SELECT * FROM capability_packs WHERE id = ?;",
      [id]
    );
    return row ? mapRow(row) : undefined;
  }

  insert(pack: AccountCapabilityPack): void {
    this.db.run(
      `INSERT INTO capability_packs (
        id, owner_user_id, pack_id, name, description, version,
        publisher, license, manifest_json, scope, enabled_state,
        previous_version, previous_manifest_json, created_at, updated_at, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        pack.id,
        pack.ownerUserId,
        pack.packId,
        pack.name,
        pack.description,
        pack.version,
        pack.publisher,
        pack.license,
        pack.manifestJson,
        pack.scope,
        pack.enabledState ? 1 : 0,
        pack.previousVersion ?? null,
        pack.previousManifestJson ?? null,
        pack.createdAt,
        pack.updatedAt,
        pack.schemaVersion,
      ]
    );
  }

  update(pack: AccountCapabilityPack): void {
    this.db.run(
      `UPDATE capability_packs SET
        name = ?, description = ?, version = ?, publisher = ?,
        license = ?, manifest_json = ?, enabled_state = ?,
        previous_version = ?, previous_manifest_json = ?, updated_at = ?
      WHERE id = ?;`,
      [
        pack.name,
        pack.description,
        pack.version,
        pack.publisher,
        pack.license,
        pack.manifestJson,
        pack.enabledState ? 1 : 0,
        pack.previousVersion ?? null,
        pack.previousManifestJson ?? null,
        pack.updatedAt,
        pack.id,
      ]
    );
  }

  delete(id: string): void {
    this.db.run("DELETE FROM capability_packs WHERE id = ?;", [id]);
  }
}
