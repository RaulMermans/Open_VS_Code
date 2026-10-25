import type {
  AuditEvent,
  IntegrationRegistration,
  IntegrationWorkspacePolicy,
  UserProfile,
  UserStatus,
} from "../types.js";
import type {
  CreateUserInput,
} from "../admin/admin-service.js";
import type {
  EffectiveWorkspaceIntegration,
  RegisterIntegrationInput,
  UpdateIntegrationInput,
} from "../integration/integration-service.js";
import { AccountServiceError } from "../errors.js";

export interface AccountClientOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class AccountClient {
  private baseUrl: string;
  private token?: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: AccountClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    requiresAuth = true
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (requiresAuth && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      const text = await response.text();
      let data: any = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }

      if (!response.ok) {
        const errObj = data?.error;
        const code = errObj?.code || `HTTP_${response.status}`;
        const message = errObj?.message || response.statusText || "Request failed";
        throw new AccountServiceError(code, message, response.status, errObj?.details);
      }

      return data as T;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new AccountServiceError("NETWORK_TIMEOUT", `Request to account service timed out after ${this.timeoutMs}ms.`, 504);
      }
      if (err instanceof AccountServiceError) {
        throw err;
      }
      throw new AccountServiceError("NETWORK_ERROR", `Failed to reach account service: ${err.message}`, 503);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async checkHealth(): Promise<{ status: string; version: string }> {
    return this.request<{ status: string; version: string }>("GET", "/api/v1/health", undefined, false);
  }

  async login(
    username: string,
    password: string
  ): Promise<{ user: UserProfile; token: string; session: { id: string; expiresAt: string } }> {
    const res = await this.request<{
      user: UserProfile;
      token: string;
      session: { id: string; expiresAt: string };
    }>("POST", "/api/v1/auth/login", { username, password }, false);

    this.token = res.token;
    return res;
  }

  async logout(): Promise<void> {
    try {
      await this.request<{ ok: boolean }>("POST", "/api/v1/auth/logout", {});
    } finally {
      this.token = undefined;
    }
  }

  async getProfile(): Promise<UserProfile> {
    const res = await this.request<{ user: UserProfile }>("GET", "/api/v1/auth/me");
    return res.user;
  }

  // Integrations
  async listIntegrations(): Promise<IntegrationRegistration[]> {
    const res = await this.request<{ integrations: IntegrationRegistration[] }>("GET", "/api/v1/integrations");
    return res.integrations;
  }

  async registerIntegration(input: RegisterIntegrationInput): Promise<IntegrationRegistration> {
    const res = await this.request<{ integration: IntegrationRegistration }>("POST", "/api/v1/integrations", input);
    return res.integration;
  }

  async getIntegration(id: string): Promise<IntegrationRegistration> {
    const res = await this.request<{ integration: IntegrationRegistration }>("GET", `/api/v1/integrations/${encodeURIComponent(id)}`);
    return res.integration;
  }

  async updateIntegration(id: string, input: UpdateIntegrationInput): Promise<IntegrationRegistration> {
    const res = await this.request<{ integration: IntegrationRegistration }>("PUT", `/api/v1/integrations/${encodeURIComponent(id)}`, input);
    return res.integration;
  }

  async deleteIntegration(id: string): Promise<void> {
    await this.request<{ ok: boolean }>("DELETE", `/api/v1/integrations/${encodeURIComponent(id)}`);
  }

  async getEffectiveWorkspaceIntegrations(workspaceId: string): Promise<EffectiveWorkspaceIntegration[]> {
    const res = await this.request<{ integrations: EffectiveWorkspaceIntegration[] }>(
      "GET",
      `/api/v1/integrations/workspace/${encodeURIComponent(workspaceId)}`
    );
    return res.integrations;
  }

  async setWorkspacePolicy(
    integrationId: string,
    workspaceId: string,
    enabledState: boolean,
    restrictions?: Record<string, unknown>
  ): Promise<IntegrationWorkspacePolicy> {
    const res = await this.request<{ policy: IntegrationWorkspacePolicy }>(
      "PUT",
      `/api/v1/integrations/${encodeURIComponent(integrationId)}/workspace/${encodeURIComponent(workspaceId)}`,
      { enabledState, applicablePermissionRestrictions: restrictions }
    );
    return res.policy;
  }

  // Admin APIs
  async adminCreateUser(input: CreateUserInput): Promise<UserProfile> {
    const res = await this.request<{ user: UserProfile }>("POST", "/api/v1/admin/users", input);
    return res.user;
  }

  async adminListUsers(): Promise<UserProfile[]> {
    const res = await this.request<{ users: UserProfile[] }>("GET", "/api/v1/admin/users");
    return res.users;
  }

  async adminSetStatus(userId: string, status: UserStatus): Promise<UserProfile> {
    const res = await this.request<{ user: UserProfile }>(
      "PATCH",
      `/api/v1/admin/users/${encodeURIComponent(userId)}/status`,
      { status }
    );
    return res.user;
  }

  async adminResetPassword(userId: string, newPassword: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      "POST",
      `/api/v1/admin/users/${encodeURIComponent(userId)}/reset-password`,
      { newPassword }
    );
  }

  async adminGetAuditLog(filters: {
    actor?: string;
    action?: string;
    target?: string;
    since?: string;
    limit?: number;
  } = {}): Promise<AuditEvent[]> {
    const params = new URLSearchParams();
    if (filters.actor) params.set("actor", filters.actor);
    if (filters.action) params.set("action", filters.action);
    if (filters.target) params.set("target", filters.target);
    if (filters.since) params.set("since", filters.since);
    if (filters.limit) params.set("limit", String(filters.limit));

    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await this.request<{ events: AuditEvent[] }>("GET", `/api/v1/admin/audit${qs}`);
    return res.events;
  }
}
