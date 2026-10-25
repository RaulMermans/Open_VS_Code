import type { AgentMode } from "../contracts/agent.ts";
import type { ToolAction } from "../contracts/tools.ts";
import { classifyPermission } from "../tools/permissions.ts";
import type {
  ModeResolverInput,
  ResolvedExecutionProfile,
} from "./contracts.ts";

const MUTATING_MODES: ReadonlySet<AgentMode> = new Set(["BUILD", "DEBUG"]);

export function resolveExecutionProfile(input: ModeResolverInput): ResolvedExecutionProfile {
  const {
    profile,
    workspaceTrusted,
    availableSkills,
    availableMcpServers,
    availableTools,
    availableDeployments,
    globalWorkflowEnabled = false,
    accountPolicy,
  } = input;

  const diagnostics: string[] = [];
  const permissionRestrictions: string[] = [];
  let isReady = true;

  // 1. Account policy validation
  if (accountPolicy?.allowedModes && !accountPolicy.allowedModes.includes(profile.id)) {
    isReady = false;
    diagnostics.push(`Profile "${profile.id}" is restricted by account administration policy.`);
  }

  // 2. Base mode validation & trust boundaries
  const baseMode: AgentMode = profile.baseMode;
  if (MUTATING_MODES.has(baseMode) && !workspaceTrusted) {
    isReady = false;
    diagnostics.push(`Mode "${profile.name}" uses base mode ${baseMode}, which requires a trusted workspace.`);
    permissionRestrictions.push("Mutating actions disabled in untrusted workspace.");
  }

  // 3. Skills resolution
  const availableSkillIds = new Set(availableSkills.map((s) => s.id));
  const appliedSkills: string[] = [];
  const missingRequiredSkills: string[] = [];
  const missingOptionalSkills: string[] = [];

  for (const skillId of profile.requiredSkills) {
    if (accountPolicy?.blockedIntegrations?.includes(`skill:${skillId}`)) {
      missingRequiredSkills.push(skillId);
      isReady = false;
      diagnostics.push(`Required skill "${skillId}" is blocked by account policy.`);
    } else if (availableSkillIds.has(skillId)) {
      appliedSkills.push(skillId);
    } else {
      missingRequiredSkills.push(skillId);
      isReady = false;
      diagnostics.push(`Missing mandatory dependency: required skill "${skillId}" is not installed.`);
    }
  }

  for (const skillId of profile.optionalSkills) {
    if (accountPolicy?.blockedIntegrations?.includes(`skill:${skillId}`)) {
      diagnostics.push(`Optional skill "${skillId}" is blocked by account policy.`);
      missingOptionalSkills.push(skillId);
    } else if (availableSkillIds.has(skillId)) {
      appliedSkills.push(skillId);
    } else {
      missingOptionalSkills.push(skillId);
      diagnostics.push(`Optional skill "${skillId}" is not installed; omitted.`);
    }
  }

  // 4. MCP Servers resolution
  const mcpServerMap = new Map(availableMcpServers.map((s) => [s.id, s]));
  const activeMcpServers: string[] = [];
  const missingRequiredMcpServers: string[] = [];
  const missingOptionalMcpServers: string[] = [];

  for (const serverId of profile.requiredMcpServers) {
    const server = mcpServerMap.get(serverId);
    if (accountPolicy?.blockedIntegrations?.includes(`mcp:${serverId}`)) {
      missingRequiredMcpServers.push(serverId);
      isReady = false;
      diagnostics.push(`Required MCP server "${serverId}" is blocked by account policy.`);
    } else if (!server) {
      missingRequiredMcpServers.push(serverId);
      isReady = false;
      diagnostics.push(`Missing mandatory dependency: required MCP server "${serverId}" is not registered.`);
    } else if (!server.enabled) {
      missingRequiredMcpServers.push(serverId);
      isReady = false;
      diagnostics.push(`Required MCP server "${serverId}" is disabled.`);
    } else if (!server.connected) {
      missingRequiredMcpServers.push(serverId);
      isReady = false;
      diagnostics.push(`Required MCP server "${serverId}" is disconnected.`);
    } else {
      activeMcpServers.push(serverId);
    }
  }

  for (const serverId of profile.optionalMcpServers) {
    const server = mcpServerMap.get(serverId);
    if (accountPolicy?.blockedIntegrations?.includes(`mcp:${serverId}`)) {
      missingOptionalMcpServers.push(serverId);
      diagnostics.push(`Optional MCP server "${serverId}" is blocked by account policy.`);
    } else if (!server || !server.enabled || !server.connected) {
      missingOptionalMcpServers.push(serverId);
      diagnostics.push(`Optional MCP server "${serverId}" is unavailable or disconnected; omitted.`);
    } else {
      activeMcpServers.push(serverId);
    }
  }

  // 5. Tool allowlist and permission restrictions
  // Invariant: profile cannot expand tools beyond baseMode permissions or availableTools
  const availableToolSet = new Set(availableTools);
  const effectiveTools: string[] = [];

  // Determine tools allowed under canonical PermissionGate for baseMode
  for (const toolName of availableTools) {
    // Map tool name to action category
    const action = toolName as ToolAction;
    const permission = classifyPermission({ action, mode: baseMode });

    if (permission === "DENY") {
      // Forbidden under baseMode
      continue;
    }

    if (profile.toolAllowlist !== undefined) {
      if (profile.toolAllowlist.includes(toolName)) {
        effectiveTools.push(toolName);
      }
    } else {
      effectiveTools.push(toolName);
    }
  }

  if (profile.toolAllowlist !== undefined) {
    for (const toolName of profile.toolAllowlist) {
      if (!availableToolSet.has(toolName)) {
        diagnostics.push(`Allowlisted tool "${toolName}" is not registered in the tool runtime.`);
      } else {
        const action = toolName as ToolAction;
        const perm = classifyPermission({ action, mode: baseMode });
        if (perm === "DENY") {
          permissionRestrictions.push(
            `Tool "${toolName}" rejected: forbidden by base mode ${baseMode} (PermissionGate non-bypass).`
          );
        }
      }
    }
  }

  // 6. Model Preference & Fallback
  let effectiveModelId = profile.preferredModelId;
  let modelFallbackNotice: string | undefined;

  if (profile.preferredModelId && availableDeployments && availableDeployments.length > 0) {
    if (!availableDeployments.includes(profile.preferredModelId)) {
      modelFallbackNotice = `Preferred model "${profile.preferredModelId}" is unavailable on configured endpoints; falling back to default deployment "${availableDeployments[0]}".`;
      diagnostics.push(modelFallbackNotice);
      effectiveModelId = availableDeployments[0];
    }
  }

  // 7. Workflow resolution
  let effectiveWorkflow: "direct" | "structured" = "direct";
  if (profile.workflowPreference === "structured") {
    if (globalWorkflowEnabled) {
      effectiveWorkflow = "structured";
    } else {
      diagnostics.push('Structured workflow requested by profile, but global workflow flag is disabled; running in "direct" mode.');
      effectiveWorkflow = "direct";
    }
  }

  // 8. Base mode communication notice
  if (MUTATING_MODES.has(baseMode)) {
    permissionRestrictions.push(
      `Mode utilizes base mode ${baseMode}. Tool mutations will request human confirmation through PermissionGate.`
    );
  } else {
    permissionRestrictions.push(`Mode utilizes base mode ${baseMode}. All mutations are strictly prohibited.`);
  }

  const snapshot: ResolvedExecutionProfile = {
    profileId: profile.id,
    profileVersion: profile.version,
    profileName: profile.name,
    source: profile.source,
    baseMode,
    effectiveTools: Object.freeze(effectiveTools),
    customInstructions: profile.customInstructions,
    appliedSkills: Object.freeze(appliedSkills),
    missingRequiredSkills: Object.freeze(missingRequiredSkills),
    missingOptionalSkills: Object.freeze(missingOptionalSkills),
    activeMcpServers: Object.freeze(activeMcpServers),
    missingRequiredMcpServers: Object.freeze(missingRequiredMcpServers),
    missingOptionalMcpServers: Object.freeze(missingOptionalMcpServers),
    effectiveModelId,
    modelFallbackNotice,
    effectiveWorkflow,
    isReady,
    diagnostics: Object.freeze(diagnostics),
    permissionRestrictions: Object.freeze(permissionRestrictions),
    timestamp: Date.now(),
  };

  return Object.freeze(snapshot);
}
