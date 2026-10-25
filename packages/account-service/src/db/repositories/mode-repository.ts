import type { DatabaseConnection, AccountModeProfile } from "../../types.js";

interface ModeProfileRow {
  id: string;
  owner_user_id: string;
  profile_id: string;
  name: string;
  description: string;
  icon: string | null;
  version: number;
  base_mode: string;
  custom_instructions: string | null;
  required_skills: string;
  optional_skills: string;
  required_mcp_servers: string;
  optional_mcp_servers: string;
  tool_allowlist: string | null;
  preferred_model_id: string | null;
  workflow_preference: string | null;
  context_guidance: string | null;
  verification_preferences: string | null;
  source_repo_references: string | null;
  scope: string;
  enabled_state: number;
  created_at: string;
  updated_at: string;
  schema_version: number;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapRow(row: ModeProfileRow): AccountModeProfile {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    profileId: row.profile_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    version: row.version,
    baseMode: row.base_mode as AccountModeProfile["baseMode"],
    customInstructions: row.custom_instructions,
    requiredSkills: parseJsonArray(row.required_skills),
    optionalSkills: parseJsonArray(row.optional_skills),
    requiredMcpServers: parseJsonArray(row.required_mcp_servers),
    optionalMcpServers: parseJsonArray(row.optional_mcp_servers),
    toolAllowlist: row.tool_allowlist ? parseJsonArray(row.tool_allowlist) : null,
    preferredModelId: row.preferred_model_id,
    workflowPreference: (row.workflow_preference as "direct" | "structured" | null) ?? null,
    contextGuidance: row.context_guidance,
    verificationPreferences: parseJsonObject(row.verification_preferences),
    sourceRepoReferences: row.source_repo_references ? parseJsonArray(row.source_repo_references) : null,
    scope: "account",
    enabledState: row.enabled_state === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schemaVersion: row.schema_version,
  };
}

export class ModeProfileRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(profile: AccountModeProfile): void {
    this.db.run(
      `INSERT INTO mode_profiles
       (id, owner_user_id, profile_id, name, description, icon, version, base_mode, custom_instructions,
        required_skills, optional_skills, required_mcp_servers, optional_mcp_servers, tool_allowlist,
        preferred_model_id, workflow_preference, context_guidance, verification_preferences,
        source_repo_references, scope, enabled_state, created_at, updated_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        profile.id,
        profile.ownerUserId,
        profile.profileId,
        profile.name,
        profile.description,
        profile.icon ?? null,
        profile.version,
        profile.baseMode,
        profile.customInstructions ?? null,
        JSON.stringify(profile.requiredSkills),
        JSON.stringify(profile.optionalSkills),
        JSON.stringify(profile.requiredMcpServers),
        JSON.stringify(profile.optionalMcpServers),
        profile.toolAllowlist ? JSON.stringify(profile.toolAllowlist) : null,
        profile.preferredModelId ?? null,
        profile.workflowPreference ?? null,
        profile.contextGuidance ?? null,
        profile.verificationPreferences ? JSON.stringify(profile.verificationPreferences) : null,
        profile.sourceRepoReferences ? JSON.stringify(profile.sourceRepoReferences) : null,
        profile.scope,
        profile.enabledState ? 1 : 0,
        profile.createdAt,
        profile.updatedAt,
        profile.schemaVersion,
      ]
    );
  }

  findByOwnerAndProfileId(ownerUserId: string, profileId: string): AccountModeProfile | undefined {
    const row = this.db.get<ModeProfileRow>(
      "SELECT * FROM mode_profiles WHERE owner_user_id = ? AND profile_id = ?;",
      [ownerUserId, profileId]
    );
    return row ? mapRow(row) : undefined;
  }

  listByOwner(ownerUserId: string): AccountModeProfile[] {
    const rows = this.db.all<ModeProfileRow>(
      "SELECT * FROM mode_profiles WHERE owner_user_id = ? ORDER BY created_at ASC;",
      [ownerUserId]
    );
    return rows.map(mapRow);
  }

  update(profile: AccountModeProfile): boolean {
    const result = this.db.run(
      `UPDATE mode_profiles
       SET name = ?, description = ?, icon = ?, version = ?, base_mode = ?, custom_instructions = ?,
           required_skills = ?, optional_skills = ?, required_mcp_servers = ?, optional_mcp_servers = ?,
           tool_allowlist = ?, preferred_model_id = ?, workflow_preference = ?, context_guidance = ?,
           verification_preferences = ?, source_repo_references = ?, enabled_state = ?, updated_at = ?
       WHERE owner_user_id = ? AND profile_id = ?;`,
      [
        profile.name,
        profile.description,
        profile.icon ?? null,
        profile.version,
        profile.baseMode,
        profile.customInstructions ?? null,
        JSON.stringify(profile.requiredSkills),
        JSON.stringify(profile.optionalSkills),
        JSON.stringify(profile.requiredMcpServers),
        JSON.stringify(profile.optionalMcpServers),
        profile.toolAllowlist ? JSON.stringify(profile.toolAllowlist) : null,
        profile.preferredModelId ?? null,
        profile.workflowPreference ?? null,
        profile.contextGuidance ?? null,
        profile.verificationPreferences ? JSON.stringify(profile.verificationPreferences) : null,
        profile.sourceRepoReferences ? JSON.stringify(profile.sourceRepoReferences) : null,
        profile.enabledState ? 1 : 0,
        profile.updatedAt,
        profile.ownerUserId,
        profile.profileId,
      ]
    );
    return result.changes > 0;
  }

  delete(ownerUserId: string, profileId: string): boolean {
    const result = this.db.run(
      "DELETE FROM mode_profiles WHERE owner_user_id = ? AND profile_id = ?;",
      [ownerUserId, profileId]
    );
    return result.changes > 0;
  }
}
