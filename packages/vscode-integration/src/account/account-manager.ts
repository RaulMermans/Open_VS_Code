import type * as vscode from "vscode";
import {
  AccountClient,
  type UserProfile,
  type IntegrationRegistration,
  type EffectiveWorkspaceIntegration,
  validateAccountServerUrl,
} from "@open-vs-code/account-service";
import type { McpService } from "../mcp/mcp-service.js";
import type { ModeService } from "../modes/mode-service.js";
import type { McpServerConfig } from "@open-vs-code/agent-core";

export type AccountStatus = "UNAUTHENTICATED" | "CONNECTING" | "ONLINE" | "OFFLINE";

export interface AccountSessionData {
  readonly token: string;
  readonly serverUrl: string;
  readonly username: string;
  readonly expiresAt: string;
  readonly cachedProfile?: UserProfile;
}

export interface AccountState {
  readonly status: AccountStatus;
  readonly serverUrl: string;
  readonly user?: UserProfile;
  readonly isStale: boolean;
  readonly lastSyncTime?: string;
  readonly error?: string;
}

export interface SyncResult {
  readonly total: number;
  readonly restored: number;
  readonly skipped: number;
  readonly isOffline: boolean;
  readonly errors: string[];
}

export const ACCOUNT_SESSION_SECRET_KEY = "open-vs-code.accountSession";

export class DesktopAccountManager {
  private client: AccountClient;
  private status: AccountStatus = "UNAUTHENTICATED";
  private user?: UserProfile | undefined;
  private isStale = false;
  private lastSyncTime?: string | undefined;
  private lastError?: string | undefined;
  private readonly stateChangeListeners = new Set<(state: AccountState) => void>();
  private accountOwnedServerIds = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel?: vscode.OutputChannel
  ) {
    const configUrl = this.getConfiguredServerUrl();
    this.client = new AccountClient({ baseUrl: configUrl });
  }

  public getAccountOwnedServerIds(): ReadonlySet<string> {
    return this.accountOwnedServerIds;
  }

  private getConfiguredServerUrl(): string {
    const defaultUrl = "http://127.0.0.1:4040";
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscodeMod = require("vscode");
      return (
        vscodeMod.workspace?.getConfiguration("open-vs-code")?.get("account.serverUrl", defaultUrl) || defaultUrl
      );
    } catch {
      return defaultUrl;
    }
  }

  public onStateChange(listener: (state: AccountState) => void): { dispose: () => void } {
    this.stateChangeListeners.add(listener);
    return {
      dispose: () => this.stateChangeListeners.delete(listener),
    };
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.stateChangeListeners) {
      try {
        listener(state);
      } catch {
        // Safe notification
      }
    }
  }

  public getState(): AccountState {
    const state: {
      status: AccountStatus;
      serverUrl: string;
      isStale: boolean;
      user?: UserProfile;
      lastSyncTime?: string;
      error?: string;
    } = {
      status: this.status,
      serverUrl: this.client.getBaseUrl(),
      isStale: this.isStale,
    };

    if (this.user) state.user = this.user;
    if (this.lastSyncTime) state.lastSyncTime = this.lastSyncTime;
    if (this.lastError) state.error = this.lastError;

    return state;
  }

  public getClient(): AccountClient {
    return this.client;
  }

  public async cleanupAccountIntegrations(mcpService?: McpService, modeService?: ModeService): Promise<void> {
    if (mcpService && this.accountOwnedServerIds.size > 0) {
      for (const serverId of Array.from(this.accountOwnedServerIds)) {
        try {
          await mcpService.unregisterServer(serverId);
        } catch {
          // Safe unregister
        }
      }
    }
    this.accountOwnedServerIds.clear();
    if (modeService) {
      modeService.cleanupAccountModes();
    }
  }

  public async initialize(mcpService?: McpService, modeService?: ModeService): Promise<AccountState> {
    let rawSecret: string | undefined;
    try {
      rawSecret = await this.context.secrets.get(ACCOUNT_SESSION_SECRET_KEY);
    } catch {
      rawSecret = undefined;
    }

    if (!rawSecret) {
      await this.cleanupAccountIntegrations(mcpService, modeService);
      this.status = "UNAUTHENTICATED";
      this.user = undefined;
      this.isStale = false;
      this.notify();
      return this.getState();
    }

    let sessionData: AccountSessionData;
    try {
      sessionData = JSON.parse(rawSecret);
    } catch {
      await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
      await this.cleanupAccountIntegrations(mcpService, modeService);
      this.status = "UNAUTHENTICATED";
      this.notify();
      return this.getState();
    }

    const configuredUrl = this.getConfiguredServerUrl();
    const effectiveUrl = sessionData.serverUrl || configuredUrl;

    // Origin integrity: if user explicitly configured a server URL setting that differs in origin from the session,
    // invalidate to prevent accidental credential forwarding across distinct backend servers.
    if (configuredUrl !== "http://127.0.0.1:4040" && sessionData.serverUrl) {
      try {
        const storedOrigin = validateAccountServerUrl(sessionData.serverUrl).origin;
        const configuredOrigin = validateAccountServerUrl(configuredUrl).origin;
        if (storedOrigin !== configuredOrigin) {
          this.outputChannel?.appendLine(
            `[Account] Configured server URL origin (${configuredOrigin}) differs from session origin (${storedOrigin}). Invalidating session to prevent credential forwarding.`
          );
          await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
          await this.cleanupAccountIntegrations(mcpService, modeService);
          this.status = "UNAUTHENTICATED";
          this.user = undefined;
          this.notify();
          return this.getState();
        }
      } catch {
        // Safe check
      }
    }

    this.client.setBaseUrl(effectiveUrl);
    this.client.setToken(sessionData.token);
    this.status = "CONNECTING";
    this.notify();

    try {
      const profile = await this.client.getProfile();
      this.status = "ONLINE";
      this.user = profile;
      this.isStale = false;
      this.lastError = undefined;

      // Update cached profile
      const updatedData: AccountSessionData = {
        ...sessionData,
        cachedProfile: profile,
      };
      await this.context.secrets.store(ACCOUNT_SESSION_SECRET_KEY, JSON.stringify(updatedData));

      this.outputChannel?.appendLine(`[Account] Authenticated as ${profile.username} (${profile.role}).`);

      if (mcpService) {
        await this.syncIntegrations(mcpService, undefined, modeService);
      } else if (modeService) {
        await modeService.syncAccountModes(this.client);
      }
    } catch (err: any) {
      if (
        err.statusCode === 401 ||
        err.statusCode === 403 ||
        err.code === "UNAUTHORIZED" ||
        err.code === "ACCOUNT_DISABLED"
      ) {
        this.outputChannel?.appendLine(`[Account] Session rejected (${err.code}): ${err.message}. Clearing credentials.`);
        await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
        await this.cleanupAccountIntegrations(mcpService, modeService);
        this.status = "UNAUTHENTICATED";
        this.user = undefined;
        this.isStale = false;
        this.lastError = err.message;
      } else {
        // Offline / reachability issue
        this.status = "OFFLINE";
        this.user = sessionData.cachedProfile;
        this.isStale = true;
        this.lastError = `Backend unreachable: ${err.message}`;
        this.outputChannel?.appendLine(`[Account] Account backend offline. Local coding remains fully functional.`);
      }
    }

    this.notify();
    return this.getState();
  }

  public async login(
    username: string,
    password: string,
    serverUrl?: string,
    mcpService?: McpService,
    modeService?: ModeService
  ): Promise<UserProfile> {
    const effectiveUrl = serverUrl || this.getConfiguredServerUrl();

    // Clean up any existing account integrations prior to new login to guarantee account isolation
    await this.cleanupAccountIntegrations(mcpService, modeService);

    this.client.setBaseUrl(effectiveUrl);
    this.status = "CONNECTING";
    this.notify();

    try {
      const result = await this.client.login(username, password);
      this.status = "ONLINE";
      this.user = result.user;
      this.isStale = false;
      this.lastError = undefined;

      const sessionData: AccountSessionData = {
        token: result.token,
        serverUrl: effectiveUrl,
        username: result.user.username,
        expiresAt: result.session.expiresAt,
        cachedProfile: result.user,
      };

      await this.context.secrets.store(ACCOUNT_SESSION_SECRET_KEY, JSON.stringify(sessionData));
      this.outputChannel?.appendLine(`[Account] Successfully logged in as ${result.user.username}.`);

      if (mcpService) {
        await this.syncIntegrations(mcpService, undefined, modeService);
      } else if (modeService) {
        await modeService.syncAccountModes(this.client);
      }

      this.notify();
      return result.user;
    } catch (err: any) {
      this.status = "UNAUTHENTICATED";
      this.user = undefined;
      this.lastError = err.message;
      this.client.setToken(undefined);
      await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
      this.notify();
      throw err;
    }
  }

  public async logout(mcpService?: McpService, modeService?: ModeService): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Best effort remote revocation
    } finally {
      this.client.setToken(undefined);
      await this.cleanupAccountIntegrations(mcpService, modeService);
      await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
      this.status = "UNAUTHENTICATED";
      this.user = undefined;
      this.isStale = false;
      this.lastError = undefined;
      this.outputChannel?.appendLine("[Account] Logged out successfully. Account integrations removed.");
      this.notify();
    }
  }

  public async syncIntegrations(
    mcpService: McpService,
    workspaceIdentity?: string,
    modeService?: ModeService
  ): Promise<SyncResult> {
    if (this.status === "UNAUTHENTICATED") {
      return { total: 0, restored: 0, skipped: 0, isOffline: false, errors: ["Not authenticated."] };
    }

    if (this.status === "OFFLINE") {
      this.outputChannel?.appendLine("[Account] Skipping remote integration sync while offline.");
      return { total: 0, restored: 0, skipped: 0, isOffline: true, errors: ["Account backend is offline."] };
    }

    const errors: string[] = [];
    const effectiveWs = workspaceIdentity || mcpService.getRoot() || "default";

    interface SyncItem {
      registration: IntegrationRegistration;
      effectiveEnabled: boolean;
    }

    let itemsToSync: SyncItem[] = [];

    try {
      if (effectiveWs) {
        try {
          const effective = await this.client.getEffectiveWorkspaceIntegrations(effectiveWs);
          itemsToSync = effective.map((e) => ({
            registration: e.registration,
            effectiveEnabled: e.effectiveEnabled,
          }));
        } catch {
          // Fall back to plain list if workspace query fails
          const regs = await this.client.listIntegrations();
          itemsToSync = regs.map((r) => ({
            registration: r,
            effectiveEnabled: r.enabledPreference,
          }));
        }
      } else {
        const regs = await this.client.listIntegrations();
        itemsToSync = regs.map((r) => ({
          registration: r,
          effectiveEnabled: r.enabledPreference,
        }));
      }
    } catch (err: any) {
      const msg = `Failed to fetch registrations: ${err.message}`;
      this.outputChannel?.appendLine(`[Account] ${msg}`);
      return { total: 0, restored: 0, skipped: 0, isOffline: true, errors: [msg] };
    }

    const remoteServerIds = new Set<string>(itemsToSync.map((item) => item.registration.serverId));

    // Stale reconciliation: unregister account-owned servers that were deleted on the backend
    for (const serverId of Array.from(this.accountOwnedServerIds)) {
      if (!remoteServerIds.has(serverId)) {
        try {
          await mcpService.unregisterServer(serverId);
          this.accountOwnedServerIds.delete(serverId);
          this.outputChannel?.appendLine(`[Account] Removed stale account integration "${serverId}".`);
        } catch (err: any) {
          errors.push(`Failed to remove stale integration "${serverId}": ${err.message}`);
        }
      }
    }

    let restored = 0;
    let skipped = 0;

    for (const item of itemsToSync) {
      const reg = item.registration;
      try {
        // Integrity check: if server is already defined by workspace configuration (.open-vs-code/mcp.json),
        // do NOT overwrite it with account-owned configuration!
        const existingProvenance = mcpService.getServerProvenance(reg.serverId);
        if (existingProvenance === "workspace") {
          skipped++;
          const notice = `Integration "${reg.serverId}" is already defined in workspace configuration; preserving workspace configuration.`;
          this.outputChannel?.appendLine(`[Account] ${notice}`);
          continue;
        }

        const config: McpServerConfig = {
          name: reg.serverId,
          displayName: reg.displayName,
          transport: reg.transport,
          enabled: reg.enabledPreference,
          ...(reg.credentialReference ? { auth: { type: "bearer", secretKey: reg.credentialReference } } : {}),
          ...(reg.nonSecretConfig as any),
        };

        // Register with source "account"
        await mcpService.registerServer(reg.serverId, config, "account");
        await mcpService.setWorkspacePolicy(reg.serverId, item.effectiveEnabled);
        this.accountOwnedServerIds.add(reg.serverId);
        restored++;
      } catch (err: any) {
        skipped++;
        const errMsg = `Failed to restore integration ${reg.serverId}: ${err.message}`;
        errors.push(errMsg);
        this.outputChannel?.appendLine(`[Account] ${errMsg}`);
      }
    }

    if (modeService) {
      try {
        await modeService.syncAccountModes(this.client);
      } catch (err: any) {
        errors.push(`Failed to sync account modes: ${err.message}`);
      }
    }

    this.lastSyncTime = new Date().toISOString();
    this.outputChannel?.appendLine(
      `[Account] Synchronized ${restored}/${itemsToSync.length} integrations from account profile.`
    );
    this.notify();

    return {
      total: itemsToSync.length,
      restored,
      skipped,
      isOffline: false,
      errors,
    };
  }
}
