import type * as vscode from "vscode";
import { AccountClient, type UserProfile, type IntegrationRegistration } from "@open-vs-code/account-service";
import type { McpService } from "../mcp/mcp-service.js";
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel?: vscode.OutputChannel
  ) {
    const configUrl = this.getConfiguredServerUrl();
    this.client = new AccountClient({ baseUrl: configUrl });
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

  public async initialize(mcpService?: McpService): Promise<AccountState> {
    const serverUrl = this.getConfiguredServerUrl();
    this.client.setBaseUrl(serverUrl);

    let rawSecret: string | undefined;
    try {
      rawSecret = await this.context.secrets.get(ACCOUNT_SESSION_SECRET_KEY);
    } catch {
      rawSecret = undefined;
    }

    if (!rawSecret) {
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
      this.status = "UNAUTHENTICATED";
      this.notify();
      return this.getState();
    }

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
        await this.syncIntegrations(mcpService);
      }
    } catch (err: any) {
      if (err.statusCode === 401 || err.statusCode === 403 || err.code === "UNAUTHORIZED" || err.code === "ACCOUNT_DISABLED") {
        this.outputChannel?.appendLine(`[Account] Session rejected (${err.code}): ${err.message}. Clearing credentials.`);
        await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
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
    mcpService?: McpService
  ): Promise<UserProfile> {
    const effectiveUrl = serverUrl || this.getConfiguredServerUrl();
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
        await this.syncIntegrations(mcpService);
      }

      this.notify();
      return result.user;
    } catch (err: any) {
      this.status = "UNAUTHENTICATED";
      this.user = undefined;
      this.lastError = err.message;
      this.notify();
      throw err;
    }
  }

  public async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Best effort remote revocation
    } finally {
      await this.context.secrets.delete(ACCOUNT_SESSION_SECRET_KEY);
      this.status = "UNAUTHENTICATED";
      this.user = undefined;
      this.isStale = false;
      this.lastError = undefined;
      this.outputChannel?.appendLine("[Account] Logged out successfully.");
      this.notify();
    }
  }

  public async syncIntegrations(mcpService: McpService): Promise<SyncResult> {
    if (this.status === "UNAUTHENTICATED") {
      return { total: 0, restored: 0, skipped: 0, isOffline: false, errors: ["Not authenticated."] };
    }

    if (this.status === "OFFLINE") {
      this.outputChannel?.appendLine("[Account] Skipping remote integration sync while offline.");
      return { total: 0, restored: 0, skipped: 0, isOffline: true, errors: ["Account backend is offline."] };
    }

    const errors: string[] = [];
    let registrations: IntegrationRegistration[] = [];

    try {
      registrations = await this.client.listIntegrations();
    } catch (err: any) {
      const msg = `Failed to fetch registrations: ${err.message}`;
      this.outputChannel?.appendLine(`[Account] ${msg}`);
      return { total: 0, restored: 0, skipped: 0, isOffline: true, errors: [msg] };
    }

    let restored = 0;
    let skipped = 0;

    const catalog = await mcpService.getCatalog();

    for (const reg of registrations) {
      try {
        const config: McpServerConfig = {
          name: reg.serverId,
          displayName: reg.displayName,
          transport: reg.transport,
          enabled: reg.enabledPreference,
          ...(reg.credentialReference ? { auth: { type: "bearer", secretKey: reg.credentialReference } } : {}),
          ...(reg.nonSecretConfig as any),
        };

        // Register into catalog; status will be DISCONNECTED or DISABLED (never automatically connected)
        catalog.registerServer(reg.serverId, config);
        restored++;
      } catch (err: any) {
        skipped++;
        const errMsg = `Failed to restore integration ${reg.serverId}: ${err.message}`;
        errors.push(errMsg);
        this.outputChannel?.appendLine(`[Account] ${errMsg}`);
      }
    }

    this.lastSyncTime = new Date().toISOString();
    this.outputChannel?.appendLine(
      `[Account] Synchronized ${restored}/${registrations.length} integrations from account profile.`
    );
    this.notify();

    return {
      total: registrations.length,
      restored,
      skipped,
      isOffline: false,
      errors,
    };
  }
}
