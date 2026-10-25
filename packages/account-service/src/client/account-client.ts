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
import {
  AccountServiceError,
  UntrustedEndpointError,
  UntrustedRedirectError,
} from "../errors.js";

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

export function validateAccountServerUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UntrustedEndpointError(`Invalid account server URL: "${url}". Must be a valid absolute URL.`);
  }

  if (parsed.username || parsed.password) {
    throw new UntrustedEndpointError("Account server URL must not contain embedded user credentials.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UntrustedEndpointError(
      `Unsupported protocol "${parsed.protocol}". Only HTTPS or loopback HTTP endpoints are permitted.`
    );
  }

  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new UntrustedEndpointError(
      `Remote plaintext HTTP is forbidden for account service endpoints: "${url}". Must use TLS (https://) or local loopback development address.`
    );
  }

  return parsed;
}

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
    const validated = validateAccountServerUrl(options.baseUrl);
    this.baseUrl = `${validated.origin}${validated.pathname === "/" ? "" : validated.pathname.replace(/\/+$/, "")}`;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  setBaseUrl(url: string): void {
    const validated = validateAccountServerUrl(url);
    const newBaseUrl = `${validated.origin}${validated.pathname === "/" ? "" : validated.pathname.replace(/\/+$/, "")}`;
    if (this.baseUrl && this.baseUrl !== newBaseUrl) {
      // Switching backend server URL: clear token to avoid accidental credential forwarding across distinct origins!
      this.token = undefined;
    }
    this.baseUrl = newBaseUrl;
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
    let currentUrl = `${this.baseUrl}${path}`;
    const initialOrigin = new URL(currentUrl).origin;
    let maxRedirects = 3;

    while (true) {
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
          redirect: "manual",
        };
        if (body !== undefined) {
          init.body = JSON.stringify(body);
        }

        const response = await fetch(currentUrl, init);

        // Handle redirects securely
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (maxRedirects <= 0) {
            throw new UntrustedRedirectError("Too many redirects from account service.");
          }
          maxRedirects--;

          const location = response.headers.get("location");
          if (!location) {
            throw new UntrustedRedirectError("Redirect response missing Location header.");
          }

          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, currentUrl);
          } catch {
            throw new UntrustedRedirectError(`Invalid redirect target: "${location}".`);
          }

          if (redirectUrl.username || redirectUrl.password) {
            throw new UntrustedRedirectError("Redirect target must not contain embedded credentials.");
          }

          const currentParsed = new URL(currentUrl);
          if (currentParsed.protocol === "https:" && redirectUrl.protocol === "http:") {
            throw new UntrustedRedirectError("Insecure protocol downgrade from HTTPS to HTTP is forbidden.");
          }

          if (redirectUrl.protocol === "http:" && !isLoopbackHost(redirectUrl.hostname)) {
            throw new UntrustedRedirectError(
              `Redirect to remote plaintext HTTP endpoint is forbidden: "${redirectUrl.toString()}".`
            );
          }

          if (requiresAuth && redirectUrl.origin !== initialOrigin) {
            throw new UntrustedRedirectError(
              `Cross-origin redirect to "${redirectUrl.origin}" rejected to protect authentication credentials.`
            );
          }

          currentUrl = redirectUrl.toString();
          continue;
        }

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

          if (requiresAuth && (response.status === 401 || code === "ACCOUNT_DISABLED")) {
            this.token = undefined;
          }
          throw new AccountServiceError(code, message, response.status, errObj?.details);
        }

        return data as T;
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw new AccountServiceError(
            "NETWORK_TIMEOUT",
            `Request to account service timed out after ${this.timeoutMs}ms.`,
            504
          );
        }
        if (err instanceof AccountServiceError) {
          throw err;
        }
        throw new AccountServiceError("NETWORK_ERROR", `Failed to reach account service: ${err.message}`, 503);
      } finally {
        clearTimeout(timeoutId);
      }
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
