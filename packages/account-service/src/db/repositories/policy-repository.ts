import type { DatabaseConnection, IntegrationWorkspacePolicy } from "../../types.js";

interface PolicyRow {
  id: string;
  user_id: string;
  integration_id: string;
  workspace_identity: string;
  enabled_state: number;
  applicable_permission_restrictions: string | null;
}

function mapRow(row: PolicyRow): IntegrationWorkspacePolicy {
  let restrictions: Record<string, unknown> | null = null;
  if (row.applicable_permission_restrictions) {
    try {
      restrictions = JSON.parse(row.applicable_permission_restrictions);
    } catch {
      restrictions = null;
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    integrationId: row.integration_id,
    workspaceIdentity: row.workspace_identity,
    enabledState: row.enabled_state === 1,
    applicablePermissionRestrictions: restrictions,
  };
}

export class PolicyRepository {
  constructor(private readonly db: DatabaseConnection) {}

  upsert(policy: IntegrationWorkspacePolicy): void {
    const restrictionsStr = policy.applicablePermissionRestrictions
      ? JSON.stringify(policy.applicablePermissionRestrictions)
      : null;

    this.db.run(
      `INSERT INTO integration_workspace_policies
       (id, user_id, integration_id, workspace_identity, enabled_state, applicable_permission_restrictions)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, integration_id, workspace_identity) DO UPDATE SET
         enabled_state = excluded.enabled_state,
         applicable_permission_restrictions = excluded.applicable_permission_restrictions;`,
      [
        policy.id,
        policy.userId,
        policy.integrationId,
        policy.workspaceIdentity,
        policy.enabledState ? 1 : 0,
        restrictionsStr,
      ]
    );
  }

  findByUserAndWorkspace(userId: string, workspaceIdentity: string): IntegrationWorkspacePolicy[] {
    const rows = this.db.all<PolicyRow>(
      `SELECT * FROM integration_workspace_policies
       WHERE user_id = ? AND workspace_identity = ?;`,
      [userId, workspaceIdentity]
    );
    return rows.map(mapRow);
  }

  findByUserIntegrationAndWorkspace(
    userId: string,
    integrationId: string,
    workspaceIdentity: string
  ): IntegrationWorkspacePolicy | undefined {
    const row = this.db.get<PolicyRow>(
      `SELECT * FROM integration_workspace_policies
       WHERE user_id = ? AND integration_id = ? AND workspace_identity = ?;`,
      [userId, integrationId, workspaceIdentity]
    );
    return row ? mapRow(row) : undefined;
  }

  delete(userId: string, integrationId: string, workspaceIdentity: string): boolean {
    const result = this.db.run(
      `DELETE FROM integration_workspace_policies
       WHERE user_id = ? AND integration_id = ? AND workspace_identity = ?;`,
      [userId, integrationId, workspaceIdentity]
    );
    return result.changes > 0;
  }
}
