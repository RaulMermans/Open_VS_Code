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
  classifyMcpAction,
  SkillRegistry,
  defaultBuiltinSkillsRoot,
} from "@open-vs-code/agent-core";
import { VsCodeSecretProvider } from "../mcp/mcp-vscode-secrets.js";
import { isLoopbackHost } from "@open-vs-code/account-service";

export type IntegrationTab = "profile" | "mcp" | "skills" | "modes" | "diagnostics";

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

export interface IntegrationManagerState {
  readonly activeTab: IntegrationTab;
  readonly account: AccountState;
  readonly servers: McpServerDetail[];
  readonly skills: SkillDetail[];
  readonly skillsRuntimeEnabled: boolean;
  readonly diagnostics: string[];
  readonly inspectingServerId?: string;
  readonly inspectingSkillId?: string;
  readonly wizard?: AddMcpWizardState;
  readonly pendingConfirmation?: {
    action: "remove_server";
    serverId: string;
    serverName: string;
  };
  readonly isLoading: boolean;
  readonly statusMessage?: string;
}

export class IntegrationManagerController {
  private activeTab: IntegrationTab = "profile";
  private inspectingServerId?: string;
  private inspectingSkillId?: string;
  private wizard?: AddMcpWizardState;
  private pendingConfirmation?: {
    action: "remove_server";
    serverId: string;
    serverName: string;
  };
  private isLoading = false;
  private statusMessage?: string;
  private readonly listeners = new Set<(state: IntegrationManagerState) => void>();
  private secretProvider: VsCodeSecretProvider;
  private skillRegistry?: SkillRegistry;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accountManager: DesktopAccountManager,
    private readonly mcpService: McpService,
    private readonly outputChannel?: vscode.OutputChannel
  ) {
    this.secretProvider = new VsCodeSecretProvider(context.secrets);
    this.accountManager.onStateChange(() => {
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
    void this.notify();
  }

  public getActiveTab(): IntegrationTab {
    return this.activeTab;
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
    const skillsEnabled =
      vscode.workspace.getConfiguration("open-vs-code").get<boolean>("skills.enabled", false) === true;
    const diagnostics = await this.collectDiagnostics();

    return {
      activeTab: this.activeTab,
      account: accountState,
      servers: serverDetails,
      skills,
      skillsRuntimeEnabled: skillsEnabled,
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
    if (!this.skillRegistry) {
      this.skillRegistry = await SkillRegistry.discover({
        builtinRoot: defaultBuiltinSkillsRoot(),
        workspaceRoot: this.mcpService.getRoot(),
        workspaceTrusted: true,
      });
    }

    const skills = this.skillRegistry.entries;
    const diagnosticsBySkill = new Map<string, string[]>();
    for (const d of this.skillRegistry.diagnostics) {
      const list = diagnosticsBySkill.get(d.skill) || [];
      list.push(`${d.code}: ${d.message}`);
      diagnosticsBySkill.set(d.skill, list);
    }
    const skillsEnabled =
      vscode.workspace.getConfiguration("open-vs-code").get<boolean>("skills.enabled", false) === true;

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
}
