import type { RegisteredToolInfo } from "../modes/contracts.ts";
import { resolveExecutionProfile } from "../modes/resolver.ts";
import type {
  CapabilityPackManifest,
  InstalledCapabilityPack,
  PackReadinessResult,
  PackReadinessStatus,
} from "./contracts.ts";
import { validateCapabilityPackManifest } from "./validation.ts";

export interface PackResolverInput {
  readonly pack: CapabilityPackManifest | InstalledCapabilityPack;
  readonly workspaceTrusted: boolean;
  readonly availableSkills: readonly { readonly id: string; readonly name?: string | undefined }[];
  readonly availableMcpServers: readonly { readonly id: string; readonly connected: boolean; readonly enabled: boolean }[];
  readonly availableTools: readonly (string | RegisteredToolInfo)[];
  readonly availableDeployments?: readonly string[] | undefined;
  readonly availableModelCapabilities?: readonly string[] | undefined;
  readonly globalWorkflowEnabled?: boolean | undefined;
  readonly globalSkillsEnabled?: boolean | undefined;
  readonly currentOpenVsCodeVersion?: string | undefined;
  readonly accountPolicy?: {
    readonly allowedModes?: readonly string[] | undefined;
    readonly blockedIntegrations?: readonly string[] | undefined;
    readonly allowedPacks?: readonly string[] | undefined;
  } | undefined;
}

export function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

export function isVersionCompatible(requiredRange: string, currentVersion: string): boolean {
  if (typeof requiredRange !== "string" || typeof currentVersion !== "string") {
    return false;
  }
  const cur = parseSemver(currentVersion);
  if (!cur) return false;

  const trimmed = requiredRange.trim();
  if (trimmed === "*" || trimmed === ">=0.0.0") return true;

  if (trimmed.startsWith("^")) {
    const req = parseSemver(trimmed.slice(1));
    if (!req) return false;
    if (cur.major !== req.major) return false;
    if (cur.minor < req.minor) return false;
    if (cur.minor === req.minor && cur.patch < req.patch) return false;
    return true;
  }

  if (trimmed.startsWith("~")) {
    const req = parseSemver(trimmed.slice(1));
    if (!req) return false;
    if (cur.major !== req.major) return false;
    if (cur.minor !== req.minor) return false;
    if (cur.patch < req.patch) return false;
    return true;
  }

  if (trimmed.startsWith(">=")) {
    const req = parseSemver(trimmed.slice(2));
    if (!req) return false;
    if (cur.major > req.major) return true;
    if (cur.major === req.major && cur.minor > req.minor) return true;
    if (cur.major === req.major && cur.minor === req.minor && cur.patch >= req.patch) return true;
    return false;
  }

  const exact = parseSemver(trimmed);
  if (exact) {
    return cur.major === exact.major && cur.minor === exact.minor && cur.patch === exact.patch;
  }

  return false;
}

export function resolveCapabilityPack(input: PackResolverInput): PackReadinessResult {
  const {
    pack,
    workspaceTrusted,
    availableSkills,
    availableMcpServers,
    availableTools,
    availableDeployments,
    globalWorkflowEnabled = false,
    globalSkillsEnabled,
    currentOpenVsCodeVersion = "0.1.0",
    accountPolicy,
  } = input;

  const manifest: CapabilityPackManifest = "manifest" in pack ? pack.manifest : pack;
  const isInstalledPack = "enabled" in pack;
  const isEnabled = isInstalledPack ? (pack as InstalledCapabilityPack).enabled : true;

  const diagnostics: string[] = [];
  const missingSkills: string[] = [];
  const missingMcpServers: string[] = [];
  const blockedPolicies: string[] = [];
  const unmetModelRequirements: string[] = [];

  // 1. Schema Validation
  const validation = validateCapabilityPackManifest(manifest);
  if (!validation.valid) {
    return {
      packId: manifest.id || "unknown",
      version: manifest.version || "0.0.0",
      status: "INVALID",
      isReady: false,
      diagnostics: validation.errors,
      missingSkills: [],
      missingMcpServers: [],
      blockedPolicies: [],
      unmetModelRequirements: [],
      timestamp: Date.now(),
    };
  }

  // 2. Open VS Code Version Compatibility
  if (!isVersionCompatible(manifest.openVsCodeVersion, currentOpenVsCodeVersion)) {
    const msg = `Pack "${manifest.id}" requires Open VS Code version "${manifest.openVsCodeVersion}", but current version is "${currentOpenVsCodeVersion}".`;
    diagnostics.push(msg);
    return {
      packId: manifest.id,
      version: manifest.version,
      status: "INCOMPATIBLE",
      isReady: false,
      diagnostics: Object.freeze(diagnostics),
      missingSkills: [],
      missingMcpServers: [],
      blockedPolicies: [],
      unmetModelRequirements: [],
      timestamp: Date.now(),
    };
  }

  // 3. Account Policies
  if (accountPolicy?.allowedPacks && !accountPolicy.allowedPacks.includes(manifest.id)) {
    const msg = `Pack "${manifest.id}" is blocked by account policy.`;
    blockedPolicies.push(msg);
    diagnostics.push(msg);
  }

  if (accountPolicy?.blockedIntegrations?.includes(`pack:${manifest.id}`)) {
    const msg = `Pack "${manifest.id}" is explicitly blocked by account administration.`;
    blockedPolicies.push(msg);
    diagnostics.push(msg);
  }

  // 4. Workspace Trust & Base Mode
  const baseMode = manifest.customMode.baseMode;
  const isMutating = baseMode === "BUILD" || baseMode === "DEBUG";
  let untrusted = false;
  if (isMutating && !workspaceTrusted) {
    untrusted = true;
    diagnostics.push(
      `Pack "${manifest.id}" uses mutating base mode ${baseMode}, which requires a trusted workspace.`
    );
  }

  // 5. Skills Resolution
  const availableSkillIds = new Set(availableSkills.map((s) => s.id));
  for (const skillId of manifest.requiredSkills) {
    if (accountPolicy?.blockedIntegrations?.includes(`skill:${skillId}`)) {
      missingSkills.push(skillId);
      blockedPolicies.push(`Required skill "${skillId}" is blocked by account policy.`);
      diagnostics.push(`Required skill "${skillId}" is blocked by account policy.`);
    } else if (availableSkillIds.has(skillId)) {
      if (globalSkillsEnabled === false) {
        missingSkills.push(skillId);
        diagnostics.push(`Global skills feature flag is disabled; required skill "${skillId}" cannot be applied.`);
      }
    } else {
      missingSkills.push(skillId);
      diagnostics.push(`Missing mandatory skill: "${skillId}" is not installed.`);
    }
  }

  // 6. MCP Servers Resolution
  const mcpServerMap = new Map(availableMcpServers.map((s) => [s.id, s]));
  for (const req of manifest.requiredMcpServers) {
    const server = mcpServerMap.get(req.id);
    if (accountPolicy?.blockedIntegrations?.includes(`mcp:${req.id}`)) {
      missingMcpServers.push(req.id);
      blockedPolicies.push(`Required MCP server "${req.id}" is blocked by account policy.`);
      diagnostics.push(`Required MCP server "${req.id}" is blocked by account policy.`);
    } else if (!server) {
      missingMcpServers.push(req.id);
      diagnostics.push(`Missing mandatory MCP dependency: server "${req.id}" is not registered.`);
    } else if (!server.enabled) {
      missingMcpServers.push(req.id);
      diagnostics.push(`Required MCP server "${req.id}" is disabled.`);
    } else if (!server.connected) {
      missingMcpServers.push(req.id);
      diagnostics.push(`Required MCP server "${req.id}" is disconnected.`);
    }
  }

  // 7. Model Requirements
  if (manifest.preferredModel) {
    if (manifest.preferredModel.deploymentId) {
      if (availableDeployments !== undefined) {
        if (!availableDeployments.includes(manifest.preferredModel.deploymentId)) {
          unmetModelRequirements.push(manifest.preferredModel.deploymentId);
          diagnostics.push(
            `Preferred model deployment "${manifest.preferredModel.deploymentId}" is not available on active endpoints.`
          );
        }
      }
    }
    if (manifest.preferredModel.capabilities && manifest.preferredModel.capabilities.length > 0) {
      if (input.availableModelCapabilities !== undefined) {
        for (const cap of manifest.preferredModel.capabilities) {
          if (!input.availableModelCapabilities.includes(cap)) {
            unmetModelRequirements.push(`capability:${cap}`);
            diagnostics.push(
              `Required model capability "${cap}" is not supported by active model deployments.`
            );
          }
        }
      }
    }
  }

  // 8. Resolve underlying custom mode profile
  const modeReadiness = resolveExecutionProfile({
    profile: manifest.customMode,
    workspaceTrusted,
    availableSkills,
    availableMcpServers,
    availableTools,
    availableDeployments,
    globalWorkflowEnabled,
    globalSkillsEnabled,
    accountPolicy,
  });

  for (const diag of modeReadiness.diagnostics) {
    if (!diagnostics.includes(diag)) {
      diagnostics.push(diag);
    }
  }

  // 9. Determine Status
  let status: PackReadinessStatus;
  if (untrusted) {
    status = "UNTRUSTED";
  } else if (blockedPolicies.length > 0) {
    status = "BLOCKED_BY_POLICY";
  } else if (!isEnabled) {
    status = "INSTALLED_INACTIVE";
  } else if (missingSkills.length > 0 || missingMcpServers.length > 0 || !modeReadiness.isReady) {
    status = "MISSING_DEPENDENCIES";
  } else if (unmetModelRequirements.length > 0) {
    status = "INCOMPATIBLE";
  } else {
    status = "READY";
  }

  const isReady = status === "READY";

  return {
    packId: manifest.id,
    version: manifest.version,
    status,
    isReady,
    modeReadiness,
    diagnostics: Object.freeze(diagnostics),
    missingSkills: Object.freeze(missingSkills),
    missingMcpServers: Object.freeze(missingMcpServers),
    blockedPolicies: Object.freeze(blockedPolicies),
    unmetModelRequirements: Object.freeze(unmetModelRequirements),
    timestamp: Date.now(),
  };
}
