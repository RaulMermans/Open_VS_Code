import * as crypto from "node:crypto";
import type { AccountDatabase } from "../db/connection.js";
import type { IntegrationRegistration, IntegrationWorkspacePolicy, McpTransportType } from "../types.js";
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";

export interface RegisterIntegrationInput {
  readonly serverId: string;
  readonly displayName: string;
  readonly transport: McpTransportType;
  readonly nonSecretConfig: Record<string, unknown>;
  readonly credentialReference?: string | null;
  readonly enabledPreference?: boolean;
}

export interface UpdateIntegrationInput {
  readonly displayName?: string;
  readonly transport?: McpTransportType;
  readonly nonSecretConfig?: Record<string, unknown>;
  readonly credentialReference?: string | null;
  readonly enabledPreference?: boolean;
}

export interface EffectiveWorkspaceIntegration {
  readonly registration: IntegrationRegistration;
  readonly workspaceEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly restrictions?: Record<string, unknown> | null;
}

const SUSPICIOUS_SECRET_KEY_PATTERN = /(password|api[_-]?key|secret|auth[_-]?token|bearer|private[_-]?key)/i;

export class IntegrationService {
  constructor(private readonly db: AccountDatabase) {}

  private validateConfig(config: Record<string, unknown>): void {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new InvalidInputError("nonSecretConfig must be a valid JSON object.");
    }

    // Inspect config keys for raw plaintext secrets
    for (const [key, value] of Object.entries(config)) {
      if (SUSPICIOUS_SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value.length > 5) {
        // If it looks like a literal token rather than an env reference or secret-storage key
        if (!value.startsWith("${") && !value.startsWith("env:") && !value.startsWith("secret:")) {
          throw new InvalidInputError(
            `Key "${key}" appears to contain a literal secret. Secrets must not be stored in nonSecretConfig. Use credentialReference instead.`
          );
        }
      }
    }
  }

  async register(ownerUserId: string, input: RegisterIntegrationInput): Promise<IntegrationRegistration> {
    if (!ownerUserId) {
      throw new ForbiddenError();
    }
    const serverId = input.serverId?.trim();
    if (!serverId || !/^[a-zA-Z0-9_-]{1,64}$/.test(serverId)) {
      throw new InvalidInputError("serverId must be 1-64 alphanumeric characters, dashes or underscores.");
    }
    const displayName = input.displayName?.trim() || serverId;
    const transport = input.transport;
    if (!["stdio", "streamable-http", "sse", "http"].includes(transport)) {
      throw new InvalidInputError("Invalid MCP transport type.");
    }

    this.validateConfig(input.nonSecretConfig || {});

    const existing = this.db.integrations.findByOwnerAndServerId(ownerUserId, serverId);
    if (existing) {
      throw new ConflictError(`Integration registration "${serverId}" already exists for this account.`);
    }

    const now = new Date().toISOString();
    const registration: IntegrationRegistration = {
      id: crypto.randomUUID(),
      ownerUserId,
      serverId,
      displayName,
      transport,
      nonSecretConfig: input.nonSecretConfig || {},
      credentialReference: input.credentialReference?.trim() || null,
      enabledPreference: input.enabledPreference ?? true,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };

    this.db.integrations.create(registration);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: ownerUserId,
      action: "INTEGRATION_REGISTER",
      target: registration.id,
      timestamp: now,
      outcome: "SUCCESS",
      details: { serverId, transport },
    });

    return registration;
  }

  async list(ownerUserId: string): Promise<IntegrationRegistration[]> {
    if (!ownerUserId) {
      throw new ForbiddenError();
    }
    return this.db.integrations.listByOwner(ownerUserId);
  }

  async get(ownerUserId: string, id: string): Promise<IntegrationRegistration> {
    if (!ownerUserId) {
      throw new ForbiddenError();
    }
    const item = this.db.integrations.findByOwnerAndId(ownerUserId, id);
    if (!item) {
      throw new NotFoundError("Integration registration");
    }
    return item;
  }

  async update(ownerUserId: string, id: string, input: UpdateIntegrationInput): Promise<IntegrationRegistration> {
    if (!ownerUserId) {
      throw new ForbiddenError();
    }
    const existing = this.db.integrations.findByOwnerAndId(ownerUserId, id);
    if (!existing) {
      throw new NotFoundError("Integration registration");
    }

    if (input.nonSecretConfig) {
      this.validateConfig(input.nonSecretConfig);
    }

    const now = new Date().toISOString();
    let credRef: string | null = existing.credentialReference ?? null;
    if (input.credentialReference !== undefined) {
      credRef = input.credentialReference ? input.credentialReference.trim() : null;
    }

    const updated: IntegrationRegistration = {
      ...existing,
      displayName: input.displayName?.trim() || existing.displayName,
      transport: input.transport || existing.transport,
      nonSecretConfig: input.nonSecretConfig || existing.nonSecretConfig,
      credentialReference: credRef,
      enabledPreference: input.enabledPreference !== undefined ? input.enabledPreference : existing.enabledPreference,
      updatedAt: now,
    };

    this.db.integrations.update(updated);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: ownerUserId,
      action: "INTEGRATION_UPDATE",
      target: id,
      timestamp: now,
      outcome: "SUCCESS",
      details: { serverId: updated.serverId },
    });

    return updated;
  }

  async delete(ownerUserId: string, id: string): Promise<void> {
    if (!ownerUserId) {
      throw new ForbiddenError();
    }
    const existing = this.db.integrations.findByOwnerAndId(ownerUserId, id);
    if (!existing) {
      throw new NotFoundError("Integration registration");
    }

    this.db.integrations.delete(id, ownerUserId);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: ownerUserId,
      action: "INTEGRATION_DELETE",
      target: id,
      timestamp: new Date().toISOString(),
      outcome: "SUCCESS",
      details: { serverId: existing.serverId },
    });
  }

  async setWorkspacePolicy(
    userId: string,
    integrationId: string,
    workspaceIdentity: string,
    enabledState: boolean,
    restrictions?: Record<string, unknown> | null
  ): Promise<IntegrationWorkspacePolicy> {
    if (!userId) {
      throw new ForbiddenError();
    }
    const integration = this.db.integrations.findByOwnerAndId(userId, integrationId);
    if (!integration) {
      throw new NotFoundError("Integration registration");
    }

    const cleanWs = workspaceIdentity?.trim();
    if (!cleanWs) {
      throw new InvalidInputError("workspaceIdentity must be a non-empty string.");
    }

    const existingPolicy = this.db.policies.findByUserIntegrationAndWorkspace(userId, integrationId, cleanWs);
    const policyId = existingPolicy?.id ?? crypto.randomUUID();

    const policy: IntegrationWorkspacePolicy = {
      id: policyId,
      userId,
      integrationId,
      workspaceIdentity: cleanWs,
      enabledState,
      applicablePermissionRestrictions: restrictions ?? null,
    };

    this.db.policies.upsert(policy);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: userId,
      action: "WORKSPACE_POLICY_UPDATE",
      target: policyId,
      timestamp: new Date().toISOString(),
      outcome: "SUCCESS",
      details: { integrationId, workspaceIdentity: cleanWs, enabledState },
    });

    return policy;
  }

  async getEffectiveIntegrations(userId: string, workspaceIdentity: string): Promise<EffectiveWorkspaceIntegration[]> {
    if (!userId) {
      throw new ForbiddenError();
    }
    const registrations = this.db.integrations.listByOwner(userId);
    const policies = this.db.policies.findByUserAndWorkspace(userId, workspaceIdentity.trim());
    const policyMap = new Map(policies.map((p) => [p.integrationId, p]));

    return registrations.map((registration) => {
      const policy = policyMap.get(registration.id);
      const workspaceEnabled = policy ? policy.enabledState : true; // default workspace enabled
      const effectiveEnabled = registration.enabledPreference && workspaceEnabled;

      return {
        registration,
        workspaceEnabled,
        effectiveEnabled,
        restrictions: policy?.applicablePermissionRestrictions ?? null,
      };
    });
  }
}
