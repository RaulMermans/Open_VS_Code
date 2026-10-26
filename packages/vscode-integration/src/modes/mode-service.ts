import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CustomModeProfile,
  type ResolvedExecutionProfile,
  type ModeResolverInput,
  type RegisteredToolInfo,
  getStarterModeProfiles,
  validateCustomModeProfile,
  resolveExecutionProfile,
} from "@open-vs-code/agent-core";
import type { AccountClient, AccountModeProfile } from "@open-vs-code/account-service";

export interface WorkspaceModesFile {
  $schema?: string;
  version: number;
  modes: CustomModeProfile[];
}

export interface ModeServiceOptions {
  workspaceRoot?: string | undefined;
}

export class ModeService {
  private readonly workspaceRoot?: string | undefined;
  private readonly builtinProfiles = new Map<string, CustomModeProfile>();
  private readonly workspaceProfiles = new Map<string, CustomModeProfile>();
  private readonly workspacePackProfiles = new Map<string, CustomModeProfile>();
  private readonly accountProfiles = new Map<string, CustomModeProfile>();
  private readonly accountPackProfiles = new Map<string, CustomModeProfile>();
  private activeModeId?: string | undefined;
  private diagnostics: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(options: ModeServiceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.initBuiltins();
    this.loadWorkspaceProfiles();
  }

  public onStateChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Safe notification
      }
    }
  }

  private initBuiltins(): void {
    this.builtinProfiles.clear();
    for (const profile of getStarterModeProfiles()) {
      this.builtinProfiles.set(profile.id, profile);
    }
  }

  public registerBuiltinProfile(profile: CustomModeProfile): void {
    this.builtinProfiles.set(profile.id, profile);
    this.notify();
  }

  public registerAccountPackProfile(profile: CustomModeProfile): void {
    const validation = validateCustomModeProfile(profile);
    if (!validation.valid) {
      throw new Error(`Invalid account pack mode profile: ${validation.errors.join("; ")}`);
    }
    const normalized: CustomModeProfile = {
      ...profile,
      source: "account",
      scope: "account",
    };
    this.accountPackProfiles.set(normalized.id, normalized);
    this.notify();
  }

  public unregisterAccountPackProfile(id: string): void {
    this.accountPackProfiles.delete(id);
    if (this.activeModeId === id) {
      this.activeModeId = undefined;
    }
    this.notify();
  }

  public registerWorkspacePackProfile(profile: CustomModeProfile): void {
    const validation = validateCustomModeProfile(profile);
    if (!validation.valid) {
      throw new Error(`Invalid workspace pack mode profile: ${validation.errors.join("; ")}`);
    }
    const normalized: CustomModeProfile = {
      ...profile,
      source: "workspace",
      scope: "workspace",
    };
    this.workspacePackProfiles.set(normalized.id, normalized);
    this.notify();
  }

  public unregisterWorkspacePackProfile(id: string): void {
    this.workspacePackProfiles.delete(id);
    if (this.activeModeId === id) {
      this.activeModeId = undefined;
    }
    this.notify();
  }

  public getWorkspaceConfigPath(): string | undefined {
    if (!this.workspaceRoot) return undefined;
    return join(this.workspaceRoot, ".open-vs-code", "modes.json");
  }

  public loadWorkspaceProfiles(): void {
    this.workspaceProfiles.clear();
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath || !existsSync(configPath)) {
      return;
    }

    try {
      const raw = readFileSync(configPath, "utf8");
      let parsed: WorkspaceModesFile;
      try {
        parsed = JSON.parse(raw) as WorkspaceModesFile;
      } catch (parseErr: any) {
        const backupPath = `${configPath}.corrupt.${Date.now()}`;
        try {
          writeFileSync(backupPath, raw, "utf8");
        } catch {
          // Safe backup
        }
        this.diagnostics.push(
          `Workspace modes.json is corrupt: ${parseErr?.message || String(parseErr)}. Backed up to ${backupPath}. Recovering with empty workspace profiles.`
        );
        return;
      }

      if (parsed && Array.isArray(parsed.modes)) {
        for (const item of parsed.modes) {
          const validation = validateCustomModeProfile(item);
          if (validation.valid) {
            // Force source & scope to workspace
            const normalized: CustomModeProfile = {
              ...item,
              source: "workspace",
              scope: "workspace",
            };
            this.workspaceProfiles.set(normalized.id, normalized);
          } else {
            this.diagnostics.push(
              `Malformed workspace custom mode profile "${String((item as any)?.id || "unknown")}": ${validation.errors.join(", ")}`
            );
          }
        }
      }
    } catch (err: any) {
      this.diagnostics.push(`Failed to read workspace modes.json: ${err?.message || String(err)}`);
    }
  }

  public saveWorkspaceProfiles(): void {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) return;

    const dir = dirname(configPath);
    const tempPath = join(dir, `.modes.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);

    const data: WorkspaceModesFile = {
      $schema: "https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/modes.schema.json",
      version: 1,
      modes: Array.from(this.workspaceProfiles.values()),
    };

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tempPath, configPath);
    } catch (err: any) {
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // Safe cleanup
      }
      this.diagnostics.push(`Failed to write workspace modes.json: ${err?.message || String(err)}`);
      throw err;
    }
  }

  public async syncAccountModes(client?: AccountClient): Promise<void> {
    if (!client || !client.getToken()) {
      this.accountProfiles.clear();
      this.notify();
      return;
    }

    try {
      const serverModes = await client.listModes();
      this.accountProfiles.clear();
      for (const sm of serverModes) {
        const profile: CustomModeProfile = {
          id: sm.profileId,
          name: sm.name,
          description: sm.description,
          icon: sm.icon || undefined,
          version: sm.version,
          schemaVersion: 1,
          source: "account",
          baseMode: sm.baseMode,
          customInstructions: sm.customInstructions || undefined,
          requiredSkills: sm.requiredSkills,
          optionalSkills: sm.optionalSkills,
          requiredMcpServers: sm.requiredMcpServers,
          optionalMcpServers: sm.optionalMcpServers,
          toolAllowlist: sm.toolAllowlist || undefined,
          preferredModelId: sm.preferredModelId || undefined,
          workflowPreference: sm.workflowPreference || undefined,
          contextGuidance: sm.contextGuidance || undefined,
          verificationPreferences: sm.verificationPreferences as any,
          sourceRepoReferences: sm.sourceRepoReferences || undefined,
          scope: "account",
          enabled: sm.enabledState,
          createdAt: sm.createdAt,
          updatedAt: sm.updatedAt,
        };

        const validation = validateCustomModeProfile(profile);
        if (validation.valid) {
          this.accountProfiles.set(profile.id, profile);
        } else {
          this.diagnostics.push(
            `Account mode "${sm.profileId}" failed validation: ${validation.errors.join(", ")}`
          );
        }
      }
      this.notify();
    } catch (err: any) {
      this.diagnostics.push(`Account custom modes synchronization failed: ${err?.message || String(err)}`);
      this.notify();
    }
  }

  public cleanupAccountModes(): void {
    this.accountProfiles.clear();
    this.accountPackProfiles.clear();
    // If active mode was account-scoped or account-pack-scoped, revert to undefined
    if (
      this.activeModeId &&
      !this.workspaceProfiles.has(this.activeModeId) &&
      !this.workspacePackProfiles.has(this.activeModeId) &&
      !this.builtinProfiles.has(this.activeModeId)
    ) {
      this.activeModeId = undefined;
    }
    this.notify();
  }

  public listModes(): CustomModeProfile[] {
    const map = new Map<string, CustomModeProfile>();

    // 1. Builtins first
    for (const [id, p] of this.builtinProfiles) {
      map.set(id, p);
    }

    // 2. Account profiles from AccountService
    for (const [id, p] of this.accountProfiles) {
      map.set(id, p);
    }

    // 3. Account pack profiles
    for (const [id, p] of this.accountPackProfiles) {
      map.set(id, p);
    }

    // 4. Workspace pack profiles
    for (const [id, p] of this.workspacePackProfiles) {
      map.set(id, p);
    }

    // 5. Workspace profiles take precedence locally over account/builtin/packs
    for (const [id, p] of this.workspaceProfiles) {
      if (this.accountProfiles.has(id) || this.accountPackProfiles.has(id)) {
        this.diagnostics.push(
          `Identifier conflict: A profile with ID "${id}" exists in both Workspace and Account scopes. Workspace profile takes precedence locally.`
        );
      }
      map.set(id, p);
    }

    return Array.from(map.values());
  }

  public getMode(id: string, preferredScope?: "builtin" | "workspace" | "account"): CustomModeProfile | undefined {
    if (preferredScope === "workspace") return this.workspaceProfiles.get(id) || this.workspacePackProfiles.get(id);
    if (preferredScope === "account") return this.accountProfiles.get(id) || this.accountPackProfiles.get(id);
    if (preferredScope === "builtin") return this.builtinProfiles.get(id);

    // Default resolution precedence: Workspace > WorkspacePack > Account > AccountPack > Builtin
    return (
      this.workspaceProfiles.get(id) ||
      this.workspacePackProfiles.get(id) ||
      this.accountProfiles.get(id) ||
      this.accountPackProfiles.get(id) ||
      this.builtinProfiles.get(id)
    );
  }

  public createWorkspaceMode(profile: CustomModeProfile): CustomModeProfile {
    const validation = validateCustomModeProfile(profile);
    if (!validation.valid) {
      throw new Error(`Invalid custom mode profile: ${validation.errors.join("; ")}`);
    }

    if (this.builtinProfiles.has(profile.id)) {
      throw new Error(`Cannot create workspace profile with ID "${profile.id}": ID reserved by built-in profile.`);
    }

    if (this.workspaceProfiles.has(profile.id)) {
      throw new Error(`A workspace profile with ID "${profile.id}" already exists.`);
    }

    const normalized: CustomModeProfile = {
      ...profile,
      source: "workspace",
      scope: "workspace",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.workspaceProfiles.set(normalized.id, normalized);
    this.saveWorkspaceProfiles();
    this.notify();
    return normalized;
  }

  public updateWorkspaceMode(id: string, updates: Partial<CustomModeProfile>): CustomModeProfile {
    const existing = this.workspaceProfiles.get(id);
    if (!existing) {
      throw new Error(`Workspace custom mode profile "${id}" not found.`);
    }

    const updated: CustomModeProfile = {
      ...existing,
      ...updates,
      id: existing.id, // ID is immutable
      source: "workspace",
      scope: "workspace",
      version: updates.version !== undefined ? updates.version : existing.version + 1,
      updatedAt: new Date().toISOString(),
    };

    const validation = validateCustomModeProfile(updated);
    if (!validation.valid) {
      throw new Error(`Invalid custom mode profile update: ${validation.errors.join("; ")}`);
    }

    this.workspaceProfiles.set(id, updated);
    this.saveWorkspaceProfiles();
    this.notify();
    return updated;
  }

  public deleteWorkspaceMode(id: string): void {
    if (this.builtinProfiles.has(id)) {
      throw new Error(`Cannot delete built-in profile "${id}".`);
    }

    if (!this.workspaceProfiles.has(id)) {
      throw new Error(`Workspace custom mode profile "${id}" not found.`);
    }

    this.workspaceProfiles.delete(id);
    if (this.activeModeId === id) {
      this.activeModeId = undefined;
    }
    this.saveWorkspaceProfiles();
    this.notify();
  }

  public duplicateMode(id: string, targetScope: "workspace" | "account"): CustomModeProfile {
    const source = this.getMode(id);
    if (!source) {
      throw new Error(`Mode profile "${id}" not found.`);
    }

    // Generate unique slug id
    let newId = `${source.id}-copy`;
    let counter = 1;
    while (this.getMode(newId)) {
      counter++;
      newId = `${source.id}-copy-${counter}`;
    }

    const duplicate: CustomModeProfile = {
      ...source,
      id: newId,
      name: `${source.name} (Copy)`,
      source: targetScope,
      scope: targetScope,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (targetScope === "workspace") {
      return this.createWorkspaceMode(duplicate);
    }

    return duplicate;
  }

  public toggleModeEnabled(id: string, enabled: boolean): void {
    const workspace = this.workspaceProfiles.get(id);
    if (workspace) {
      this.updateWorkspaceMode(id, { enabled });
      return;
    }

    const builtin = this.builtinProfiles.get(id);
    if (builtin) {
      // Create a workspace override with enabled toggled
      const override: CustomModeProfile = {
        ...builtin,
        source: "workspace",
        scope: "workspace",
        enabled,
        updatedAt: new Date().toISOString(),
      };
      this.workspaceProfiles.set(id, override);
      this.saveWorkspaceProfiles();
      this.notify();
      return;
    }

    throw new Error(`Mode profile "${id}" cannot be toggled locally.`);
  }

  public getActiveModeId(): string | undefined {
    return this.activeModeId;
  }

  public setActiveModeId(id: string | undefined): void {
    if (id !== undefined) {
      const mode = this.getMode(id);
      if (!mode) {
        throw new Error(`Mode profile "${id}" not found.`);
      }
      if (!mode.enabled) {
        throw new Error(`Mode profile "${id}" is disabled.`);
      }
    }
    this.activeModeId = id;
    this.notify();
  }

  public resolveMode(
    id: string,
    context: {
      workspaceTrusted: boolean;
      availableSkills: { id: string; name?: string }[];
      availableMcpServers: { id: string; connected: boolean; enabled: boolean }[];
      availableTools: (string | RegisteredToolInfo)[];
      availableDeployments?: string[];
      globalWorkflowEnabled?: boolean;
      globalSkillsEnabled?: boolean;
      accountPolicy?: { allowedModes?: string[]; blockedIntegrations?: string[] };
    }
  ): ResolvedExecutionProfile {
    const profile = this.getMode(id);
    if (!profile) {
      throw new Error(`Cannot resolve mode: profile "${id}" not found.`);
    }

    return resolveExecutionProfile({
      profile,
      workspaceTrusted: context.workspaceTrusted,
      availableSkills: context.availableSkills,
      availableMcpServers: context.availableMcpServers,
      availableTools: context.availableTools,
      availableDeployments: context.availableDeployments,
      globalWorkflowEnabled: context.globalWorkflowEnabled,
      globalSkillsEnabled: context.globalSkillsEnabled,
      accountPolicy: context.accountPolicy,
    });
  }

  public getDiagnostics(): string[] {
    return [...this.diagnostics];
  }
}
