import * as vscode from "vscode";
import { DesktopAccountManager, type AccountState } from "../account/account-manager.js";
import {
  McpService,
  type McpServerSummary,
  type IntegrationProvenance,
} from "../mcp/mcp-service.js";
import {
  type McpToolMetadata,
  type McpServerConfig,
  type McpConfig,
  type McpConnectionState,
  type McpPolicyConfig,
  type ResolvedExecutionProfile,
  type RegisteredToolInfo,
  classifyMcpAction,
  resolveExecutionProfile,
  loadRoutingConfig,
  SkillRegistry,
  defaultBuiltinSkillsRoot,
  type CapabilityPackManifest,
  type InstalledCapabilityPack,
  type PackPreviewInfo,
  type PackReadinessStatus,
  type CustomModeProfile,
  resolveCapabilityPack,
} from "@open-vs-code/agent-core";
import { VsCodeSecretProvider } from "../mcp/mcp-vscode-secrets.js";
import { isLoopbackHost } from "@open-vs-code/account-service";
import { ModeService } from "../modes/mode-service.js";
import { CapabilityPackService } from "../packs/capability-pack-service.js";

export type IntegrationTab = "profile" | "mcp" | "skills" | "modes" | "packs" | "diagnostics";

export interface CapabilityPackSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly license: string;
  readonly scope: "builtin" | "workspace" | "account";
  readonly enabled: boolean;
  readonly isReady: boolean;
  readonly isActive: boolean;
  readonly status: PackReadinessStatus;
  readonly baseMode: string;
  readonly requiredSkillCount: number;
  readonly requiredMcpCount: number;
  readonly diagnostics: readonly string[];
}

export interface CapabilityPackDetailDto extends CapabilityPackSummaryDto {
  readonly sourceRepository: { readonly url: string; readonly commit?: string; readonly release?: string };
  readonly attribution?: string;
  readonly openVsCodeVersion: string;
  readonly permissionDeclarations: readonly string[];
  readonly requiredSkills: readonly string[];
  readonly optionalSkills: readonly string[];
  readonly requiredMcpServers: readonly { readonly id: string; readonly name?: string }[];
  readonly optionalMcpServers: readonly { readonly id: string; readonly name?: string }[];
  readonly customMode: CustomModeProfile;
  readonly documentation: { readonly summary: string; readonly guidelines?: string; readonly readme?: string };
  readonly integrity: { readonly algorithm: string; readonly digest: string };
  readonly previousVersion?: string;
  readonly hasRollback: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface McpServerDetail {
  readonly id: string;
  readonly name: string;
  readonly transport: "stdio" | "streamable_http" | "sse" | string;
  readonly source: IntegrationProvenance;
  readonly state: McpConnectionState;
  readonly enabled: boolean;
  readonly workspaceEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly authStatus: {
    readonly type?: string;
    readonly secretKey?: string;
    readonly hasCredential: boolean;
  };
  readonly toolCount: number;
  readonly tools: McpToolMetadata[];
  readonly lastConnectedAt?: string;
  readonly error?: string;
  readonly urlOrCommand: string;
  readonly policy?: McpPolicyConfig;
}

export interface SkillDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "builtin" | "workspace";
  readonly filePath: string;
  readonly enabled: boolean;
  readonly diagnostics: string[];
  readonly inputSchema?: Record<string, unknown>;
}

export interface AddMcpWizardValidation {
  readonly valid: boolean;
  readonly networkPolicyCheck: string;
  readonly executableOrUrlCheck: string;
  readonly credentialCheck: string;
  readonly warnings: string[];
}

export interface AddMcpWizardDraft {
  transport: "stdio" | "streamable_http" | "sse";
  serverId: string;
  displayName: string;
  url?: string;
  command?: string;
  args?: string[];
  envFrom?: string[];
  credentialRef?: string;
  secretValue?: string;
  workspaceScoped?: boolean;
  persistToAccount?: boolean;
}

export interface AddMcpWizardState {
  step: 1 | 2 | 3 | 4 | 5;
  draft: AddMcpWizardDraft;
  validationResult?: AddMcpWizardValidation;
  connecting?: boolean;
  discoveredTools?: McpToolMetadata[];
  error?: string;
}

export interface CustomModeSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon?: string | undefined;
  readonly baseMode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";
  readonly source: "builtin" | "workspace" | "account";
  readonly scope: "builtin" | "workspace" | "account";
  readonly enabled: boolean;
  readonly isReady: boolean;
  readonly isActive: boolean;
  readonly version: number;
  readonly requiredSkillCount: number;
  readonly requiredMcpCount: number;
  readonly missingRequiredCount: number;
  readonly diagnostics: readonly string[];
}

export interface CustomModeDetailDto extends CustomModeSummaryDto {
  readonly customInstructions?: string | undefined;
  readonly requiredSkills: readonly string[];
  readonly optionalSkills: readonly string[];
  readonly requiredMcpServers: readonly string[];
  readonly optionalMcpServers: readonly string[];
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly preferredModelId?: string | undefined;
  readonly workflowPreference?: "direct" | "structured" | undefined;
  readonly effectiveTools: readonly string[];
  readonly permissionRestrictions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModeWizardDraft {
  id?: string | undefined;
  name: string;
  description: string;
  baseMode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";
  icon?: string | undefined;
  customInstructions?: string | undefined;
  requiredSkills: string[];
  optionalSkills: string[];
  requiredMcpServers: string[];
  optionalMcpServers: string[];
  toolAllowlist?: string[] | undefined;
  preferredModelId?: string | undefined;
  workflowPreference?: "direct" | "structured" | undefined;
  scope: "workspace" | "account";
}

export interface ModeWizardState {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  draft: ModeWizardDraft;
  isEditing?: boolean | undefined;
  originalId?: string | undefined;
  validationErrors?: readonly string[] | undefined;
  validationWarnings?: readonly string[] | undefined;
  resolvedPreview?: ResolvedExecutionProfile | undefined;
}

export interface IntegrationManagerState {
  readonly activeTab: IntegrationTab;
  readonly account: AccountState;
  readonly servers: McpServerDetail[];
  readonly skills: SkillDetail[];
  readonly skillsRuntimeEnabled: boolean;
  readonly modes: CustomModeSummaryDto[];
  readonly activeModeId?: string | undefined;
  readonly inspectingModeId?: string | undefined;
  readonly inspectingModeDetail?: CustomModeDetailDto | undefined;
  readonly modeWizard?: ModeWizardState | undefined;
  readonly packs: CapabilityPackSummaryDto[];
  readonly activePackId?: string | undefined;
  readonly inspectingPackId?: string | undefined;
  readonly inspectingPackDetail?: CapabilityPackDetailDto | undefined;
  readonly packPreview?: PackPreviewInfo | undefined;
  readonly diagnostics: string[];
  readonly inspectingServerId?: string | undefined;
  readonly inspectingSkillId?: string | undefined;
  readonly wizard?: AddMcpWizardState | undefined;
  readonly pendingConfirmation?: {
    action: "remove_server";
    serverId: string;
    serverName: string;
  } | undefined;
  readonly isLoading: boolean;
  readonly statusMessage?: string | undefined;
}

export class IntegrationManagerController {
  private activeTab: IntegrationTab = "profile";
  private inspectingServerId?: string | undefined;
  private inspectingSkillId?: string | undefined;
  private inspectingModeId?: string | undefined;
  private inspectingPackId?: string | undefined;
  private packPreview?: PackPreviewInfo | undefined;
  private wizard?: AddMcpWizardState | undefined;
  private modeWizard?: ModeWizardState | undefined;
  private pendingConfirmation?: {
    action: "remove_server";
    serverId: string;
    serverName: string;
  } | undefined;
  private isLoading = false;
  private statusMessage?: string | undefined;
  private readonly listeners = new Set<(state: IntegrationManagerState) => void>();
  private secretProvider: VsCodeSecretProvider;
  private skillRegistry?: SkillRegistry;
  private readonly modeService: ModeService;
  private readonly capabilityPackService: CapabilityPackService;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accountManager: DesktopAccountManager,
    private readonly mcpService: McpService,
    private readonly outputChannel?: vscode.OutputChannel,
    modeService?: ModeService,
    capabilityPackService?: CapabilityPackService
  ) {
    this.modeService = modeService || new ModeService({ workspaceRoot: mcpService.getRoot() });
    this.capabilityPackService =
      capabilityPackService ||
      new CapabilityPackService({ workspaceRoot: mcpService.getRoot(), modeService: this.modeService });
    this.secretProvider = new VsCodeSecretProvider(context.secrets);
    this.accountManager.onStateChange(() => {
      void this.notify();
    });
    this.modeService.onStateChange(() => {
      void this.notify();
    });
    this.capabilityPackService.onStateChange(() => {
      void this.notify();
    });
  }

  public onStateChange(listener: (state: IntegrationManagerState) => void): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  }

  public dispose(): void {
    this.listeners.clear();
  }

  private async notify(): Promise<void> {
    const state = await this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Safe notification
      }
    }
  }

  public setTab(tab: IntegrationTab): void {
    this.activeTab = tab;
    this.inspectingServerId = undefined;
    this.inspectingSkillId = undefined;
    this.inspectingModeId = undefined;
    this.inspectingPackId = undefined;
    this.packPreview = undefined;
    void this.notify();
  }

  public setActiveTab(tab: IntegrationTab): void {
    this.setTab(tab);
  }

  public getActiveTab(): IntegrationTab {
    return this.activeTab;
  }

  public async getProductionCapabilitySnapshot(): Promise<{
    workspaceTrusted: boolean;
    availableSkills: { id: string; name?: string }[];
    availableMcpServers: { id: string; connected: boolean; enabled: boolean }[];
    availableTools: RegisteredToolInfo[];
    availableDeployments?: string[];
    globalWorkflowEnabled: boolean;
    globalSkillsEnabled: boolean;
    accountPolicy?: { allowedModes?: string[]; blockedIntegrations?: string[] };
  }> {
    const isTrusted = vscode.workspace.isTrusted ?? true;
    const skills = await this.getSkillsInventory();
    const skillsConfig = vscode.workspace.getConfiguration("open-vs-code").get<boolean>("skills.enabled", true);
    const skillsEnabled = skillsConfig !== false && process.env.OPEN_VS_CODE_SKILLS !== "0";
    const workflowConfig = vscode.workspace.getConfiguration("open-vs-code").get<boolean>("workflow.enabled", true);
    const globalWorkflowEnabled = workflowConfig !== false && process.env.OPEN_VS_CODE_STRUCTURED_WORKFLOW !== "0";
    const serverSummaries = await this.mcpService.listServers();

    const availableTools: RegisteredToolInfo[] = [
      { name: "read_file", action: "read_repository" },
      { name: "list_directory", action: "read_repository" },
      { name: "search_text", action: "search_repository" },
      { name: "find_files", action: "search_repository" },
    ];

    if (isTrusted) {
      availableTools.push(
        { name: "apply_patch", action: "write_file" },
        { name: "create_file", action: "write_file" },
        { name: "run_verification", action: "run_known_test" }
      );
    }

    const mcpConfig = (await this.mcpService.getConfigResult()).config;
    for (const s of serverSummaries) {
      if (s.state === "CONNECTED" && s.effectiveEnabled && s.tools) {
        for (const t of s.tools) {
          availableTools.push({
            name: t.canonicalName || t.toolName,
            action: (t as any).action || classifyMcpAction(t, mcpConfig),
          });
        }
      }
    }

    let availableDeployments: string[] | undefined;
    const root = this.mcpService.getRoot();
    if (root) {
      try {
        const routingConfig = await loadRoutingConfig(root);
        if (routingConfig?.deployments) {
          availableDeployments = routingConfig.deployments.map((d: any) => d.id);
        }
      } catch {
        // Safe fallback
      }
    }

    const accountState = this.accountManager.getState();
    const accountPolicy = (accountState.user as any)?.policy;

    return {
      workspaceTrusted: isTrusted,
      availableSkills: skillsEnabled
        ? skills.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name }))
        : [],
      availableMcpServers: serverSummaries.map((s) => ({
        id: s.id,
        connected: s.state === "CONNECTED",
        enabled: s.effectiveEnabled,
      })),
      availableTools,
      availableDeployments,
      globalWorkflowEnabled,
      globalSkillsEnabled: skillsEnabled,
      accountPolicy,
    };
  }

  public async getState(): Promise<IntegrationManagerState> {
    const accountState = this.accountManager.getState();
    const serverSummaries = await this.mcpService.listServers();
    const catalog = await this.mcpService.getCatalog();
    const configResult = await this.mcpService.getConfigResult();

    const serverDetails: McpServerDetail[] = [];
    for (const summary of serverSummaries) {
      let hasCredential = false;
      const secretKey = summary.auth?.secretKey;
      if (secretKey) {
        try {
          const val = await this.secretProvider.getSecret(secretKey);
          hasCredential = Boolean(val);
        } catch {
          hasCredential = false;
        }
      }

      serverDetails.push({
        id: summary.id,
        name: summary.name,
        transport: summary.transport,
        source: summary.source,
        state: summary.state,
        enabled: summary.enabled,
        workspaceEnabled: summary.workspaceEnabled,
        effectiveEnabled: summary.effectiveEnabled,
        authStatus: {
          type: summary.auth?.type,
          secretKey,
          hasCredential,
        },
        toolCount: summary.toolCount,
        tools: summary.tools,
        lastConnectedAt: catalog.getServerStatus(summary.id)?.lastConnectedAt,
        error: summary.error,
        urlOrCommand: summary.urlOrCommand,
        policy: summary.policy,
      });
    }

    const skills = await this.getSkillsInventory();
    const diagnostics = await this.collectDiagnostics();
    const resolverContext = await this.getProductionCapabilitySnapshot();

    const rawModes = this.modeService.listModes();
    const modeSummaries: CustomModeSummaryDto[] = [];

    for (const m of rawModes) {
      let resolved: ResolvedExecutionProfile;
      try {
        resolved = this.modeService.resolveMode(m.id, resolverContext);
      } catch (err: any) {
        resolved = {
          profileId: m.id,
          profileVersion: m.version,
          profileName: m.name,
          source: m.source,
          baseMode: m.baseMode,
          effectiveTools: [],
          appliedSkills: [],
          missingRequiredSkills: [],
          missingOptionalSkills: [],
          activeMcpServers: [],
          missingRequiredMcpServers: [],
          missingOptionalMcpServers: [],
          effectiveWorkflow: "direct",
          isReady: false,
          diagnostics: [err?.message || "Failed to resolve mode profile"],
          permissionRestrictions: [],
          timestamp: Date.now(),
        };
      }

      modeSummaries.push({
        id: m.id,
        name: m.name,
        description: m.description,
        icon: m.icon,
        baseMode: m.baseMode,
        source: m.source,
        scope: m.scope,
        enabled: m.enabled,
        isReady: resolved.isReady,
        isActive: this.modeService.getActiveModeId() === m.id,
        version: m.version,
        requiredSkillCount: m.requiredSkills.length,
        requiredMcpCount: m.requiredMcpServers.length,
        missingRequiredCount: resolved.missingRequiredSkills.length + resolved.missingRequiredMcpServers.length,
        diagnostics: resolved.diagnostics,
      });
    }

    let inspectingModeDetail: CustomModeDetailDto | undefined;
    if (this.inspectingModeId) {
      const mode = this.modeService.getMode(this.inspectingModeId);
      if (mode) {
        const resolved = this.modeService.resolveMode(mode.id, resolverContext);
        inspectingModeDetail = {
          id: mode.id,
          name: mode.name,
          description: mode.description,
          icon: mode.icon,
          baseMode: mode.baseMode,
          source: mode.source,
          scope: mode.scope,
          enabled: mode.enabled,
          isReady: resolved.isReady,
          isActive: this.modeService.getActiveModeId() === mode.id,
          version: mode.version,
          requiredSkillCount: mode.requiredSkills.length,
          requiredMcpCount: mode.requiredMcpServers.length,
          missingRequiredCount: resolved.missingRequiredSkills.length + resolved.missingRequiredMcpServers.length,
          diagnostics: resolved.diagnostics,
          customInstructions: mode.customInstructions,
          requiredSkills: mode.requiredSkills,
          optionalSkills: mode.optionalSkills,
          requiredMcpServers: mode.requiredMcpServers,
          optionalMcpServers: mode.optionalMcpServers,
          toolAllowlist: mode.toolAllowlist,
          preferredModelId: mode.preferredModelId,
          workflowPreference: mode.workflowPreference,
          effectiveTools: resolved.effectiveTools,
          permissionRestrictions: resolved.permissionRestrictions,
          createdAt: mode.createdAt,
          updatedAt: mode.updatedAt,
        };
      }
    }

    if (this.modeWizard) {
      const draft = this.modeWizard.draft;
      const previewProfile: any = {
        id: draft.id || "preview-mode",
        name: draft.name || "Preview Mode",
        description: draft.description || "",
        icon: draft.icon,
        version: 1,
        schemaVersion: 1,
        source: draft.scope,
        baseMode: draft.baseMode,
        customInstructions: draft.customInstructions,
        requiredSkills: draft.requiredSkills,
        optionalSkills: draft.optionalSkills,
        requiredMcpServers: draft.requiredMcpServers,
        optionalMcpServers: draft.optionalMcpServers,
        toolAllowlist: draft.toolAllowlist,
        preferredModelId: draft.preferredModelId,
        workflowPreference: draft.workflowPreference,
        scope: draft.scope,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.modeWizard.resolvedPreview = resolveExecutionProfile({
        profile: previewProfile,
        workspaceTrusted: resolverContext.workspaceTrusted,
        availableSkills: resolverContext.availableSkills,
        availableMcpServers: resolverContext.availableMcpServers,
        availableTools: resolverContext.availableTools,
        globalWorkflowEnabled: resolverContext.globalWorkflowEnabled,
        globalSkillsEnabled: resolverContext.globalSkillsEnabled,
        accountPolicy: resolverContext.accountPolicy,
      });
    }

    const rawPacks = this.capabilityPackService.listPacks();
    const packSummaries: CapabilityPackSummaryDto[] = [];

    for (const p of rawPacks) {
      const readiness = resolveCapabilityPack({
        pack: p,
        ...resolverContext,
      });

      packSummaries.push({
        id: p.packId,
        name: p.manifest.name,
        description: p.manifest.description,
        version: p.installedVersion,
        publisher: { id: p.manifest.publisher.id, name: p.manifest.publisher.name },
        license: p.manifest.license,
        scope: p.scope,
        enabled: p.enabled,
        isReady: readiness.isReady,
        isActive: this.capabilityPackService.getActivePackId() === p.packId,
        status: readiness.status,
        baseMode: p.manifest.customMode.baseMode,
        requiredSkillCount: p.manifest.requiredSkills.length,
        requiredMcpCount: p.manifest.requiredMcpServers.length,
        diagnostics: readiness.diagnostics,
      });
    }

    let inspectingPackDetail: CapabilityPackDetailDto | undefined;
    if (this.inspectingPackId) {
      const pack = this.capabilityPackService.getPack(this.inspectingPackId);
      if (pack) {
        const readiness = resolveCapabilityPack({
          pack,
          ...resolverContext,
        });

        inspectingPackDetail = {
          id: pack.packId,
          name: pack.manifest.name,
          description: pack.manifest.description,
          version: pack.installedVersion,
          publisher: { id: pack.manifest.publisher.id, name: pack.manifest.publisher.name },
          license: pack.manifest.license,
          scope: pack.scope,
          enabled: pack.enabled,
          isReady: readiness.isReady,
          isActive: this.capabilityPackService.getActivePackId() === pack.packId,
          status: readiness.status,
          baseMode: pack.manifest.customMode.baseMode,
          requiredSkillCount: pack.manifest.requiredSkills.length,
          requiredMcpCount: pack.manifest.requiredMcpServers.length,
          diagnostics: readiness.diagnostics,
          sourceRepository: pack.manifest.sourceRepository,
          attribution: pack.manifest.attribution,
          openVsCodeVersion: pack.manifest.openVsCodeVersion,
          permissionDeclarations: pack.manifest.permissionDeclarations,
          requiredSkills: pack.manifest.requiredSkills,
          optionalSkills: pack.manifest.optionalSkills,
          requiredMcpServers: pack.manifest.requiredMcpServers,
          optionalMcpServers: pack.manifest.optionalMcpServers,
          customMode: pack.manifest.customMode,
          documentation: pack.manifest.documentation,
          integrity: pack.manifest.integrity,
          previousVersion: pack.previousVersion,
          hasRollback: Boolean(pack.previousVersion && pack.previousManifest),
          installedAt: pack.installedAt,
          updatedAt: pack.updatedAt,
        };
      }
    }

    return {
      activeTab: this.activeTab,
      account: accountState,
      servers: serverDetails,
      skills,
      skillsRuntimeEnabled: resolverContext.globalSkillsEnabled,
      modes: modeSummaries,
      activeModeId: this.modeService.getActiveModeId(),
      inspectingModeId: this.inspectingModeId,
      inspectingModeDetail,
      modeWizard: this.modeWizard,
      packs: packSummaries,
      activePackId: this.capabilityPackService.getActivePackId(),
      inspectingPackId: this.inspectingPackId,
      inspectingPackDetail,
      packPreview: this.packPreview,
      diagnostics,
      inspectingServerId: this.inspectingServerId,
      inspectingSkillId: this.inspectingSkillId,
      wizard: this.wizard,
      pendingConfirmation: this.pendingConfirmation,
      isLoading: this.isLoading,
      statusMessage: this.statusMessage,
    };
  }

  // --- MCP Server Management ---

  public async connectServer(serverId: string): Promise<{ success: boolean; message: string }> {
    this.isLoading = true;
    this.statusMessage = `Connecting to server "${serverId}"...`;
    void this.notify();

    try {
      const res = await this.mcpService.connectServer(serverId);
      this.statusMessage = res.message;
      return res;
    } finally {
      this.isLoading = false;
      void this.notify();
    }
  }

  public async disconnectServer(serverId: string): Promise<{ success: boolean; message: string }> {
    this.isLoading = true;
    this.statusMessage = `Disconnecting server "${serverId}"...`;
    void this.notify();

    try {
      const res = await this.mcpService.disconnectServer(serverId);
      this.statusMessage = res.message;
      return res;
    } finally {
      this.isLoading = false;
      void this.notify();
    }
  }

  public async toggleServerEnabled(serverId: string, enabled: boolean): Promise<void> {
    await this.mcpService.setServerEnabled(serverId, enabled);

    // If account-owned, update remote preference
    if (this.accountManager.getState().status === "ONLINE") {
      try {
        await this.accountManager.getClient().updateIntegration(serverId, {
          enabledPreference: enabled,
        });
      } catch {
        // Safe backend sync
      }
    }
    void this.notify();
  }

  public async toggleWorkspacePolicy(serverId: string, enabledInWorkspace: boolean): Promise<void> {
    await this.mcpService.setWorkspacePolicy(serverId, enabledInWorkspace);

    // If account-owned and online, persist workspace policy
    if (this.accountManager.getState().status === "ONLINE") {
      const ws = this.mcpService.getRoot() || "default";
      try {
        await this.accountManager.getClient().setWorkspacePolicy(serverId, ws, enabledInWorkspace);
      } catch {
        // Safe backend sync
      }
    }
    void this.notify();
  }

  public inspectTools(serverId: string | undefined): void {
    this.inspectingServerId = serverId;
    void this.notify();
  }

  public inspectSkill(skillId: string | undefined): void {
    this.inspectingSkillId = skillId;
    void this.notify();
  }

  public promptRemoveServer(serverId: string, serverName: string): void {
    this.pendingConfirmation = {
      action: "remove_server",
      serverId,
      serverName,
    };
    void this.notify();
  }

  public cancelConfirmation(): void {
    this.pendingConfirmation = undefined;
    void this.notify();
  }

  public async executeRemoveServer(serverId: string): Promise<void> {
    this.pendingConfirmation = undefined;
    this.isLoading = true;
    this.statusMessage = `Removing integration "${serverId}"...`;
    void this.notify();

    try {
      const prov = this.mcpService.getServerProvenance(serverId);
      if (prov === "account" && this.accountManager.getState().status === "ONLINE") {
        try {
          await this.accountManager.getClient().deleteIntegration(serverId);
        } catch {
          // Best effort remote deletion
        }
      }
      await this.mcpService.unregisterServer(serverId);
      this.statusMessage = `Integration "${serverId}" removed successfully.`;
    } catch (err: any) {
      this.statusMessage = `Failed to remove integration "${serverId}": ${err.message}`;
    } finally {
      this.isLoading = false;
      void this.notify();
    }
  }

  public async refreshDiscovery(): Promise<void> {
    this.isLoading = true;
    this.statusMessage = "Refreshing MCP discovery...";
    void this.notify();

    try {
      const res = await this.mcpService.refreshDiscovery();
      this.statusMessage = `Discovery complete: ${res.servers} servers, ${res.tools} tools.`;
    } catch (err: any) {
      this.statusMessage = `Discovery refresh failed: ${err.message}`;
    } finally {
      this.isLoading = false;
      void this.notify();
    }
  }

  // --- Add MCP Wizard ---

  public startAddWizard(): void {
    this.wizard = {
      step: 1,
      draft: {
        transport: "streamable_http",
        serverId: "",
        displayName: "",
        workspaceScoped: true,
        persistToAccount: this.accountManager.getState().status === "ONLINE",
      },
    };
    this.activeTab = "mcp";
    void this.notify();
  }

  public cancelWizard(): void {
    this.wizard = undefined;
    void this.notify();
  }

  public wizardSetStep1Transport(transport: "stdio" | "streamable_http" | "sse"): void {
    if (!this.wizard) this.startAddWizard();
    this.wizard!.draft.transport = transport;
    this.wizard!.step = 2;
    void this.notify();
  }

  public wizardUpdateDraft(updates: Partial<AddMcpWizardDraft> & { id?: string }): void {
    if (!this.wizard) return;
    const normalized = { ...updates };
    if (normalized.id && !normalized.serverId) {
      normalized.serverId = normalized.id;
    }
    this.wizard.draft = { ...this.wizard.draft, ...normalized };
    void this.notify();
  }

  public async wizardValidateAndAdvance(): Promise<void> {
    if (!this.wizard) return;
    const draft = this.wizard.draft;

    const warnings: string[] = [];
    let valid = true;
    let networkPolicyCheck = "N/A";
    let executableOrUrlCheck = "N/A";
    let credentialCheck = "None required";

    if (!draft.serverId?.trim()) {
      valid = false;
      warnings.push("Server ID is required and must contain alphanumeric characters and hyphens only.");
    } else if (!/^[a-zA-Z0-9_-]+$/.test(draft.serverId.trim())) {
      valid = false;
      warnings.push("Server ID must contain only alphanumeric characters, underscores, and hyphens.");
    }

    if (draft.transport === "streamable_http" || draft.transport === "sse") {
      if (!draft.url?.trim()) {
        valid = false;
        executableOrUrlCheck = "Missing endpoint URL";
        warnings.push("Endpoint URL is required for HTTP/SSE transports.");
      } else {
        try {
          const parsed = new URL(draft.url.trim());
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            valid = false;
            warnings.push(`Unsupported protocol "${parsed.protocol}". Must use HTTPS or loopback HTTP.`);
          } else if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
            valid = false;
            warnings.push(
              `Remote plaintext HTTP is forbidden: "${draft.url}". Must use TLS (https://) or local loopback.`
            );
          } else {
            networkPolicyCheck = parsed.protocol === "https:" ? "Secure TLS (HTTPS)" : "Verified Loopback HTTP";
            executableOrUrlCheck = `Valid endpoint (${parsed.host})`;
            if (parsed.protocol === "https:" && !isLoopbackHost(parsed.hostname)) {
              warnings.push(`Third-party server "${parsed.host}": ensure you trust this provider before connecting.`);
            }
          }
        } catch {
          valid = false;
          warnings.push("Malformed URL format.");
        }
      }

      if (draft.credentialRef?.trim()) {
        const hasSecret = await this.secretProvider.getSecret(draft.credentialRef.trim());
        if (hasSecret || draft.secretValue) {
          credentialCheck = `Bearer token provisioned for key "${draft.credentialRef.trim()}"`;
        } else {
          warnings.push(
            `Secret key "${draft.credentialRef.trim()}" is not yet stored in SecretStorage. Provide a token value below or configure it.`
          );
        }
      }
    } else if (draft.transport === "stdio") {
      if (!draft.command?.trim()) {
        valid = false;
        executableOrUrlCheck = "Missing executable command";
        warnings.push("Executable command is required for stdio transport.");
      } else {
        const cmd = draft.command.trim();
        executableOrUrlCheck = `Command: ${cmd}`;
        if (["npx", "npm", "bunx", "yarn"].includes(cmd.toLowerCase())) {
          warnings.push(
            `Automated package execution via "${cmd}" triggers untrusted external execution. Ensure packages are pre-installed.`
          );
        }
      }
      networkPolicyCheck = "Local Subprocess (shell: false, minimal environment)";
    }

    this.wizard.validationResult = {
      valid,
      networkPolicyCheck,
      executableOrUrlCheck,
      credentialCheck,
      warnings,
    };
    this.wizard.step = 3;
    void this.notify();
  }

  public wizardGoToStep(step: 1 | 2 | 3 | 4 | 5): void {
    if (!this.wizard) return;
    this.wizard.step = step;
    void this.notify();
  }

  public async wizardSave(connectNow: boolean): Promise<boolean> {
    if (!this.wizard) return false;
    const draft = this.wizard.draft;

    const serverId = draft.serverId.trim();
    const displayName = draft.displayName?.trim() || serverId;

    let secretKey: string | undefined;
    if (draft.credentialRef?.trim()) {
      secretKey = draft.credentialRef.trim();
      if (draft.secretValue?.trim()) {
        await this.secretProvider.setSecret(secretKey, draft.secretValue.trim());
      }
    }

    const config: McpServerConfig = {
      id: serverId,
      displayName,
      transport: draft.transport,
      enabled: true,
      workspaceScoped: draft.workspaceScoped ?? true,
      ...(draft.url ? { url: draft.url.trim() } : {}),
      ...(draft.command ? { command: draft.command.trim() } : {}),
      ...(draft.args ? { args: draft.args } : {}),
      ...(draft.envFrom ? { envFrom: draft.envFrom } : {}),
      ...(secretKey ? { auth: { type: "bearer", secretKey } } : {}),
    };

    let source: IntegrationProvenance = "local";

    // Persist to account backend if user requested and is logged in
    if (draft.persistToAccount && this.accountManager.getState().status === "ONLINE") {
      try {
        const client = this.accountManager.getClient();
        const accountTransport = draft.transport === "streamable_http" ? "streamable-http" : draft.transport;
        await client.registerIntegration({
          serverId,
          displayName,
          transport: accountTransport,
          nonSecretConfig: {
            ...(draft.url ? { url: draft.url.trim() } : {}),
            ...(draft.command ? { command: draft.command.trim() } : {}),
            ...(draft.args ? { args: draft.args } : {}),
            ...(draft.envFrom ? { envFrom: draft.envFrom } : {}),
            workspaceScoped: draft.workspaceScoped ?? true,
          },
          credentialReference: secretKey || null,
          enabledPreference: true,
        });
        source = "account";
      } catch (err: any) {
        this.wizard.error = `Failed to persist to account: ${err.message}. Saving locally instead.`;
      }
    }

    // Register locally into McpService
    await this.mcpService.registerServer(serverId, config, source);

    if (connectNow) {
      this.wizard.step = 4;
      this.wizard.connecting = true;
      void this.notify();

      const connRes = await this.mcpService.connectServer(serverId);
      this.wizard.connecting = false;

      if (connRes.success) {
        const catalog = await this.mcpService.getCatalog();
        const tools = catalog.getTools().filter((t) => t.serverId === serverId);
        this.wizard.discoveredTools = tools;
        this.wizard.step = 5;
        void this.notify();
        return true;
      } else {
        this.wizard.error = connRes.message;
        void this.notify();
        return false;
      }
    } else {
      // Finished without immediate connection
      this.wizard = undefined;
      this.statusMessage = `Server "${serverId}" registered successfully.`;
      void this.notify();
      return true;
    }
  }

  // --- Skills Section ---

  public async getSkillsInventory(): Promise<SkillDetail[]> {
    this.skillRegistry = await SkillRegistry.discover({
      builtinRoot: defaultBuiltinSkillsRoot(),
      workspaceRoot: this.mcpService.getRoot(),
      workspaceTrusted: true,
    });

    const skills = this.skillRegistry.entries;
    const diagnosticsBySkill = new Map<string, string[]>();
    for (const d of this.skillRegistry.diagnostics) {
      const list = diagnosticsBySkill.get(d.skill) || [];
      list.push(`${d.code}: ${d.message}`);
      diagnosticsBySkill.set(d.skill, list);
    }
    const skillsConfig = vscode.workspace.getConfiguration("open-vs-code").get<boolean>("skills.enabled", true);
    const skillsEnabled = skillsConfig !== false && process.env.OPEN_VS_CODE_SKILLS !== "0";

    return skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      filePath: s.relativePath,
      enabled: skillsEnabled,
      diagnostics: diagnosticsBySkill.get(s.id) || [],
      inputSchema: undefined,
    }));
  }

  public async openSkillFile(skillId: string): Promise<void> {
    const skills = await this.getSkillsInventory();
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) return;

    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(skill.filePath));
      await vscode.window.showTextDocument(doc);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open skill file: ${err.message}`);
    }
  }

  // --- Diagnostics ---

  public async collectDiagnostics(): Promise<string[]> {
    const list: string[] = [];

    const account = this.accountManager.getState();
    if (account.status === "OFFLINE") {
      list.push(`[Account OFFLINE] ${account.error || "Account backend is currently unreachable. Local features remain operational."}`);
    } else if (account.status === "UNAUTHENTICATED") {
      list.push("[Account INFO] Logged out. Integrations running in local-only workspace mode.");
    }

    const mcpDiags = await this.mcpService.getDiagnostics();
    list.push(...mcpDiags);

    const skills = await this.getSkillsInventory();
    for (const skill of skills) {
      for (const diag of skill.diagnostics) {
        list.push(`[Skill Diagnostic] [${skill.name}]: ${diag}`);
      }
    }

    return list;
  }

  // --- Custom Modes Management (Sprint 8D) ---

  public inspectMode(modeId?: string): void {
    this.inspectingModeId = modeId;
    this.inspectingServerId = undefined;
    this.inspectingSkillId = undefined;
    void this.notify();
  }

  public startModeWizard(modeId?: string): void {
    if (modeId) {
      const mode = this.modeService.getMode(modeId);
      if (mode) {
        this.modeWizard = {
          step: 1,
          draft: {
            id: mode.id,
            name: mode.name,
            description: mode.description,
            baseMode: mode.baseMode,
            icon: mode.icon,
            customInstructions: mode.customInstructions,
            requiredSkills: [...mode.requiredSkills],
            optionalSkills: [...mode.optionalSkills],
            requiredMcpServers: [...mode.requiredMcpServers],
            optionalMcpServers: [...mode.optionalMcpServers],
            toolAllowlist: mode.toolAllowlist ? [...mode.toolAllowlist] : undefined,
            preferredModelId: mode.preferredModelId,
            workflowPreference: mode.workflowPreference,
            scope: mode.scope === "account" ? "account" : "workspace",
          },
          isEditing: true,
          originalId: mode.id,
        };
        void this.notify();
        return;
      }
    }

    this.modeWizard = {
      step: 1,
      draft: {
        name: "",
        description: "",
        baseMode: "PLAN",
        requiredSkills: [],
        optionalSkills: [],
        requiredMcpServers: [],
        optionalMcpServers: [],
        scope: "workspace",
      },
      isEditing: false,
    };
    void this.notify();
  }

  public cancelModeWizard(): void {
    this.modeWizard = undefined;
    void this.notify();
  }

  public updateModeWizardDraft(draftUpdates: Partial<ModeWizardDraft>): void {
    if (!this.modeWizard) return;
    this.modeWizard.draft = {
      ...this.modeWizard.draft,
      ...draftUpdates,
    };
    void this.notify();
  }

  public setModeWizardStep(step: number): void {
    if (!this.modeWizard) return;
    if (step >= 1 && step <= 9) {
      this.modeWizard.step = step as ModeWizardState["step"];
      void this.notify();
    }
  }

  public async saveModeWizard(activateNow = false): Promise<void> {
    if (!this.modeWizard) return;
    const draft = this.modeWizard.draft;
    const slugId = draft.id || draft.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");

    const profileData: any = {
      id: slugId,
      name: draft.name,
      description: draft.description,
      icon: draft.icon || "code",
      version: 1,
      schemaVersion: 1,
      source: draft.scope,
      baseMode: draft.baseMode,
      customInstructions: draft.customInstructions,
      requiredSkills: draft.requiredSkills || [],
      optionalSkills: draft.optionalSkills || [],
      requiredMcpServers: draft.requiredMcpServers || [],
      optionalMcpServers: draft.optionalMcpServers || [],
      toolAllowlist: draft.toolAllowlist,
      preferredModelId: draft.preferredModelId,
      workflowPreference: draft.workflowPreference,
      scope: draft.scope,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (draft.scope === "account") {
      const client = this.accountManager.getClient();
      if (!client.getToken()) {
        throw new Error("Must be logged in to save an account custom mode profile.");
      }
      if (this.modeWizard.isEditing && this.modeWizard.originalId) {
        await client.updateMode(this.modeWizard.originalId, profileData);
      } else {
        await client.createMode({
          profileId: slugId,
          ...profileData,
        });
      }
      await this.modeService.syncAccountModes(client);
    } else {
      if (this.modeWizard.isEditing && this.modeWizard.originalId) {
        this.modeService.updateWorkspaceMode(this.modeWizard.originalId, profileData);
      } else {
        this.modeService.createWorkspaceMode(profileData);
      }
    }

    if (activateNow) {
      this.modeService.setActiveModeId(slugId);
    }

    this.modeWizard = undefined;
    void this.notify();
  }

  public async deleteMode(modeId: string): Promise<void> {
    const mode = this.modeService.getMode(modeId);
    if (!mode) return;
    if (mode.scope === "account") {
      const client = this.accountManager.getClient();
      if (client.getToken()) {
        await client.deleteMode(modeId);
        await this.modeService.syncAccountModes(client);
      }
    } else {
      this.modeService.deleteWorkspaceMode(modeId);
    }
    if (this.inspectingModeId === modeId) {
      this.inspectingModeId = undefined;
    }
    void this.notify();
  }

  public duplicateMode(modeId: string, targetScope: "workspace" | "account" = "workspace"): void {
    this.modeService.duplicateMode(modeId, targetScope);
    void this.notify();
  }

  public toggleModeEnabled(modeId: string, enabled: boolean): void {
    this.modeService.toggleModeEnabled(modeId, enabled);
    void this.notify();
  }

  public setActiveMode(modeId?: string): void {
    this.modeService.setActiveModeId(modeId);
    void this.notify();
  }

  public getActiveModeId(): string | undefined {
    return this.modeService.getActiveModeId();
  }

  public getModeService(): ModeService {
    return this.modeService;
  }

  public getAccountManager(): DesktopAccountManager {
    return this.accountManager;
  }

  public getMcpService(): McpService {
    return this.mcpService;
  }

  public onAccountStateChange(listener: (state: AccountState) => void): { dispose: () => void } {
    return this.accountManager.onStateChange(listener);
  }

  public notifyAccountChange(): void {
    (this.accountManager as any).notify();
  }

  // --- Tool Permission Helper ---
  public classifyToolPermission(
    metadata: McpToolMetadata,
    config?: McpConfig
  ): {
    action: string;
    permissionGate: "ALLOW" | "CONFIRM";
    isDestructive: boolean;
    isSensitive: boolean;
    description: string;
  } {
    const action = classifyMcpAction(metadata, config);
    const permissionGate = action === "mcp_external_read" ? "ALLOW" : "CONFIRM";
    const isDestructive = action === "mcp_external_destructive";
    const isSensitive = action === "mcp_sensitive_data_transmission";

    let description = "Unclassified external tool; requires confirmation.";
    if (action === "mcp_external_read") {
      description = "Read-only inspection; allowed by default.";
    } else if (action === "mcp_external_side_effect") {
      description = "Modifies state; requires user confirmation.";
    } else if (action === "mcp_sensitive_data_transmission") {
      description = "Transmits workspace contents externally; requires user confirmation.";
    } else if (action === "mcp_external_destructive") {
      description = "Destructive external action; requires explicit user confirmation.";
    }

    return {
      action,
      permissionGate,
      isDestructive,
      isSensitive,
      description,
    };
  }

  // --- Capability Packs Management (Sprint 8E) ---

  public getCapabilityPackService(): CapabilityPackService {
    return this.capabilityPackService;
  }

  public inspectPack(packId?: string): void {
    this.inspectingPackId = packId;
    this.inspectingModeId = undefined;
    this.inspectingServerId = undefined;
    this.inspectingSkillId = undefined;
    void this.notify();
  }

  public setPackPreview(preview: PackPreviewInfo | undefined): void {
    this.packPreview = preview;
    void this.notify();
  }

  public importPack(rawOrObj: string | Record<string, unknown>): CapabilityPackManifest {
    return this.capabilityPackService.importPack(rawOrObj);
  }

  public previewPack(manifest: CapabilityPackManifest): PackPreviewInfo {
    return this.capabilityPackService.previewPack(manifest);
  }

  public async installPack(
    manifest: CapabilityPackManifest,
    scope: "workspace" | "account" = "workspace"
  ): Promise<InstalledCapabilityPack> {
    const client = this.accountManager.getClient();
    const installed = await this.capabilityPackService.installPack(manifest, scope, client);
    this.inspectingPackId = installed.packId;
    this.packPreview = undefined;
    void this.notify();
    return installed;
  }

  public async enablePack(packId: string): Promise<InstalledCapabilityPack> {
    const client = this.accountManager.getClient();
    const updated = await this.capabilityPackService.enablePack(packId, client);
    void this.notify();
    return updated;
  }

  public async disablePack(packId: string): Promise<InstalledCapabilityPack> {
    const client = this.accountManager.getClient();
    const updated = await this.capabilityPackService.disablePack(packId, client);
    void this.notify();
    return updated;
  }

  public async activatePack(
    packId: string
  ): Promise<{ pack: InstalledCapabilityPack; resolvedProfile: ResolvedExecutionProfile }> {
    const snapshot = await this.getProductionCapabilitySnapshot();
    const res = this.capabilityPackService.activatePack(packId, snapshot);
    void this.notify();
    return res;
  }

  public async updatePack(
    packId: string,
    newManifest: CapabilityPackManifest
  ): Promise<InstalledCapabilityPack> {
    const client = this.accountManager.getClient();
    const updated = await this.capabilityPackService.updatePack(packId, newManifest, client);
    void this.notify();
    return updated;
  }

  public async rollbackPack(packId: string): Promise<InstalledCapabilityPack> {
    const client = this.accountManager.getClient();
    const rolledBack = await this.capabilityPackService.rollbackPack(packId, client);
    void this.notify();
    return rolledBack;
  }

  public async removePack(packId: string): Promise<void> {
    const client = this.accountManager.getClient();
    await this.capabilityPackService.removePack(packId, client);
    if (this.inspectingPackId === packId) {
      this.inspectingPackId = undefined;
    }
    void this.notify();
  }
}
