/**
 * Core type definitions for Open VS Code Private Account Service
 * (Sprint 8B)
 */

export type UserRole = "ADMIN" | "USER";
export type UserStatus = "ACTIVE" | "DISABLED";

export interface User {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserProfile {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly tokenVerifier: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string;
}

export interface SessionWithToken {
  readonly session: Session;
  readonly token: string;
}

export type McpTransportType = "stdio" | "streamable-http" | "sse" | "http";

export interface IntegrationRegistration {
  readonly id: string;
  readonly ownerUserId: string;
  readonly serverId: string;
  readonly displayName: string;
  readonly transport: McpTransportType;
  readonly nonSecretConfig: Record<string, unknown>;
  readonly credentialReference?: string | null;
  readonly enabledPreference: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

export interface IntegrationWorkspacePolicy {
  readonly id: string;
  readonly userId: string;
  readonly integrationId: string;
  readonly workspaceIdentity: string;
  readonly enabledState: boolean;
  readonly applicablePermissionRestrictions?: Record<string, unknown> | null;
}

export type AuditAction =
  | "AUTH_LOGIN"
  | "AUTH_LOGOUT"
  | "AUTH_FAILED"
  | "USER_BOOTSTRAP"
  | "USER_CREATE"
  | "USER_STATUS_CHANGE"
  | "USER_PASSWORD_RESET"
  | "SESSION_REVOKE"
  | "SESSION_EXPIRE"
  | "INTEGRATION_REGISTER"
  | "INTEGRATION_UPDATE"
  | "INTEGRATION_DELETE"
  | "WORKSPACE_POLICY_UPDATE"
  | "MODE_CREATE"
  | "MODE_UPDATE"
  | "MODE_DELETE"
  | "VAULT_ACCESS"
  | "ACCESS_DENIED";

export interface AccountModeProfile {
  readonly id: string;
  readonly ownerUserId: string;
  readonly profileId: string;
  readonly name: string;
  readonly description: string;
  readonly icon?: string | null | undefined;
  readonly version: number;
  readonly baseMode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";
  readonly customInstructions?: string | null | undefined;
  readonly requiredSkills: readonly string[];
  readonly optionalSkills: readonly string[];
  readonly requiredMcpServers: readonly string[];
  readonly optionalMcpServers: readonly string[];
  readonly toolAllowlist?: readonly string[] | null | undefined;
  readonly preferredModelId?: string | null | undefined;
  readonly workflowPreference?: "direct" | "structured" | null | undefined;
  readonly contextGuidance?: string | null | undefined;
  readonly verificationPreferences?: Record<string, unknown> | null | undefined;
  readonly sourceRepoReferences?: readonly string[] | null | undefined;
  readonly scope: "account";
  readonly enabledState: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: number;
}

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILED";

export interface AuditEvent {
  readonly id: string;
  readonly actor: string;
  readonly action: AuditAction;
  readonly target: string;
  readonly timestamp: string;
  readonly outcome: AuditOutcome;
  readonly details?: Record<string, unknown> | null;
}

export interface VaultService {
  encrypt(ownerUserId: string, secretName: string, plaintext: string): Promise<string>;
  decrypt(ownerUserId: string, secretName: string, ciphertext: string): Promise<string>;
  isConfigured(): boolean;
}

export interface DatabaseConnection {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(sql: string, params?: unknown[]): T | undefined;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  close(): void;
}
