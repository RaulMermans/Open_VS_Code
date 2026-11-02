import type { AgentMode } from "../contracts/agent.ts";
import type { ToolAction } from "../contracts/tools.ts";

export type ModeProvenance = "builtin" | "workspace" | "account";

export interface CustomModeProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon?: string | undefined;
  readonly version: number;
  readonly schemaVersion: 1;
  readonly source: ModeProvenance;
  readonly baseMode: AgentMode;
  readonly customInstructions?: string | undefined;
  readonly requiredSkills: readonly string[];
  readonly optionalSkills: readonly string[];
  readonly requiredMcpServers: readonly string[];
  readonly optionalMcpServers: readonly string[];
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly preferredModelId?: string | undefined;
  readonly workflowPreference?: "direct" | "structured" | undefined;
  readonly contextGuidance?: string | undefined;
  readonly verificationPreferences?: {
    readonly testCommandOverride?: string | undefined;
  } | undefined;
  readonly sourceRepoReferences?: readonly string[] | undefined;
  readonly scope: "builtin" | "workspace" | "account";
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModeValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface ModeValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ModeValidationIssue[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export type ModeReadinessStatus = "READY" | "NOT_CONFIGURED" | "DISABLED" | "UNSUPPORTED";

export interface ResolvedExecutionProfile {
  readonly profileId: string;
  readonly profileVersion: number;
  readonly profileName: string;
  readonly source: ModeProvenance;
  readonly baseMode: AgentMode;
  readonly effectiveTools: readonly string[];
  readonly customInstructions?: string | undefined;
  readonly contextGuidance?: string | undefined;
  readonly appliedSkills: readonly string[];
  readonly missingRequiredSkills: readonly string[];
  readonly missingOptionalSkills: readonly string[];
  readonly activeMcpServers: readonly string[];
  readonly missingRequiredMcpServers: readonly string[];
  readonly missingOptionalMcpServers: readonly string[];
  readonly effectiveModelId?: string | undefined;
  readonly modelFallbackNotice?: string | undefined;
  readonly effectiveWorkflow: "direct" | "structured";
  readonly readinessStatus: ModeReadinessStatus;
  readonly isReady: boolean;
  readonly diagnostics: readonly string[];
  readonly permissionRestrictions: readonly string[];
  readonly timestamp: number;
}

export interface RegisteredToolInfo {
  readonly name: string;
  readonly action?: ToolAction | string | undefined;
}

export interface ModeResolverInput {
  readonly profile: CustomModeProfile;
  readonly workspaceTrusted: boolean;
  readonly availableSkills: readonly { readonly id: string; readonly name?: string | undefined }[];
  readonly availableMcpServers: readonly { readonly id: string; readonly connected: boolean; readonly enabled: boolean }[];
  readonly availableTools: readonly (string | RegisteredToolInfo)[];
  readonly availableDeployments?: readonly string[] | undefined;
  readonly globalWorkflowEnabled?: boolean | undefined;
  readonly globalSkillsEnabled?: boolean | undefined;
  readonly accountPolicy?: {
    readonly allowedModes?: readonly string[] | undefined;
    readonly blockedIntegrations?: readonly string[] | undefined;
  } | undefined;
}
