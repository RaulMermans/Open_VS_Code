import type { McpAuthConfig } from "./mcp-auth.ts";
import type { McpConnectionState } from "./mcp-connection-state.ts";
import { validateMcpEndpoint } from "./mcp-network-guard.ts";

export type McpToolPolicyType = "read" | "side_effect" | "sensitive" | "destructive" | "unknown";

export interface McpServerPolicy {
  readonly allowedTools?: string[] | undefined;
  readonly deniedTools?: string[] | undefined;
  readonly toolPolicies?: Record<string, McpToolPolicyType> | undefined;
  readonly maxBudget?: number | undefined;
}

export type McpPolicyConfig = McpServerPolicy;

export interface McpServerConfig {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly transport: "stdio" | "streamable_http" | "http" | "sse" | "test";
  readonly command?: string | undefined;
  readonly args?: string[] | undefined;
  readonly envFrom?: string[] | undefined;
  readonly url?: string | undefined;
  readonly enabled: boolean;
  readonly workspaceScoped?: boolean | undefined;
  readonly auth?: McpAuthConfig | undefined;
  readonly policy?: McpServerPolicy | undefined;
  readonly validationStatus?: {
    readonly valid: boolean;
    readonly errors?: string[] | undefined;
  } | undefined;
  readonly lastVerified?: {
    readonly state?: McpConnectionState | undefined;
    readonly lastConnectedAt?: string | undefined;
    readonly lastError?: string | undefined;
  } | undefined;
}

export interface McpConfig {
  readonly version?: number | undefined;
  readonly servers: Record<string, McpServerConfig>;
  readonly toolPolicies?: Record<string, McpToolPolicyType> | undefined;
}

export interface McpConfigDiagnostic {
  readonly serverId?: string | undefined;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export function validateMcpConfigDetailed(data: unknown): {
  readonly config: McpConfig;
  readonly diagnostics: McpConfigDiagnostic[];
} {
  const diagnostics: McpConfigDiagnostic[] = [];

  if (typeof data !== "object" || data === null) {
    diagnostics.push({ message: "MCP configuration must be a valid JSON object", severity: "error" });
    return { config: { servers: {} }, diagnostics };
  }

  const raw = data as any;
  if (typeof raw.servers !== "object" || raw.servers === null) {
    diagnostics.push({ message: "MCP configuration missing 'servers' object", severity: "error" });
    return { config: { servers: {} }, diagnostics };
  }

  const validServers: Record<string, McpServerConfig> = {};

  for (const [key, srv] of Object.entries(raw.servers)) {
    if (typeof srv !== "object" || srv === null) {
      diagnostics.push({ serverId: key, message: `Server configuration for "${key}" must be an object`, severity: "error" });
      continue;
    }
    const s = srv as any;

    if (typeof s.enabled !== "boolean") {
      diagnostics.push({ serverId: key, message: `Server "${key}" must define boolean property "enabled"`, severity: "error" });
      continue;
    }

    const transport = s.transport;
    if (
      transport !== "stdio" &&
      transport !== "streamable_http" &&
      transport !== "http" &&
      transport !== "sse" &&
      transport !== "test"
    ) {
      diagnostics.push({
        serverId: key,
        message: `Server "${key}" has unsupported transport "${transport}". Supported: "stdio", "streamable_http", "http", "sse", "test"`,
        severity: "error",
      });
      continue;
    }

    // stdio validation
    if (transport === "stdio") {
      if (typeof s.command !== "string" || !s.command.trim()) {
        diagnostics.push({ serverId: key, message: `Server "${key}" (stdio) requires a valid "command" string`, severity: "error" });
        continue;
      }

      const cmdBasename = (s.command.split(/[/\\]/).pop() || "").toLowerCase();
      if (
        cmdBasename === "npx" ||
        cmdBasename === "bunx" ||
        (cmdBasename === "npm" && s.args?.[0] === "exec") ||
        (cmdBasename === "pnpm" && s.args?.[0] === "dlx") ||
        (cmdBasename === "yarn" && s.args?.[0] === "dlx")
      ) {
        diagnostics.push({
          serverId: key,
          message: `Server "${key}" specifies blocked package launcher "${cmdBasename}". Auto-installers are disallowed for security.`,
          severity: "error",
        });
        continue;
      }

      if (s.args !== undefined && !Array.isArray(s.args)) {
        diagnostics.push({ serverId: key, message: `Server "${key}" "args" must be an array of strings`, severity: "error" });
        continue;
      }
      if (s.args?.some((a: any) => typeof a !== "string")) {
        diagnostics.push({ serverId: key, message: `Server "${key}" "args" elements must all be strings`, severity: "error" });
        continue;
      }

      if (s.envFrom !== undefined && !Array.isArray(s.envFrom)) {
        diagnostics.push({ serverId: key, message: `Server "${key}" "envFrom" must be an array of strings`, severity: "error" });
        continue;
      }
      if (s.envFrom?.some((e: any) => typeof e !== "string")) {
        diagnostics.push({ serverId: key, message: `Server "${key}" "envFrom" elements must all be strings`, severity: "error" });
        continue;
      }
    }

    // remote HTTP / SSE validation
    if (transport === "streamable_http" || transport === "http" || transport === "sse") {
      const urlStr = s.url || s.endpoint;
      if (typeof urlStr !== "string" || !urlStr.trim()) {
        diagnostics.push({ serverId: key, message: `Server "${key}" (${transport}) requires a valid "url" endpoint string`, severity: "error" });
        continue;
      }

      const urlValidation = validateMcpEndpoint(urlStr);
      if (!urlValidation.valid) {
        diagnostics.push({ serverId: key, message: `Server "${key}" invalid endpoint: ${urlValidation.error}`, severity: "error" });
        continue;
      }
    }

    // Auth config validation (if provided)
    let authConfig: McpAuthConfig | undefined;
    if (s.auth !== undefined) {
      if (typeof s.auth !== "object" || s.auth === null) {
        diagnostics.push({ serverId: key, message: `Server "${key}" "auth" must be an object`, severity: "error" });
        continue;
      }
      const a = s.auth;
      if (a.type !== "none" && a.type !== "bearer" && a.type !== "oauth2" && a.type !== "secret_ref") {
        diagnostics.push({ serverId: key, message: `Server "${key}" has unknown auth type "${a.type}"`, severity: "error" });
        continue;
      }
      authConfig = {
        type: a.type,
        secretKey: typeof a.secretKey === "string" ? a.secretKey : undefined,
        tokenEnv: typeof a.tokenEnv === "string" ? a.tokenEnv : undefined,
        clientId: typeof a.clientId === "string" ? a.clientId : undefined,
        authorizationServer: typeof a.authorizationServer === "string" ? a.authorizationServer : undefined,
        scopes: Array.isArray(a.scopes) ? a.scopes.filter((sc: any) => typeof sc === "string") : undefined,
      };
    }

    // Policy config validation (if provided)
    let policy: McpServerPolicy | undefined;
    if (s.policy !== undefined && typeof s.policy === "object" && s.policy !== null) {
      const p = s.policy;
      let toolPolicies: Record<string, McpToolPolicyType> | undefined;
      if (p.toolPolicies && typeof p.toolPolicies === "object") {
        toolPolicies = {};
        for (const [tk, tv] of Object.entries(p.toolPolicies)) {
          if (tv === "read" || tv === "side_effect" || tv === "sensitive" || tv === "destructive" || tv === "unknown") {
            toolPolicies[tk] = tv;
          }
        }
      }
      policy = {
        allowedTools: Array.isArray(p.allowedTools) ? p.allowedTools.filter((t: any) => typeof t === "string") : undefined,
        deniedTools: Array.isArray(p.deniedTools) ? p.deniedTools.filter((t: any) => typeof t === "string") : undefined,
        toolPolicies,
        maxBudget: typeof p.maxBudget === "number" ? p.maxBudget : undefined,
      };
    }

    validServers[key] = {
      id: key,
      displayName: typeof s.displayName === "string" ? s.displayName : (typeof s.name === "string" ? s.name : undefined),
      transport,
      command: s.command,
      args: s.args,
      envFrom: s.envFrom,
      url: s.url || s.endpoint,
      enabled: s.enabled,
      workspaceScoped: typeof s.workspaceScoped === "boolean" ? s.workspaceScoped : true,
      auth: authConfig,
      policy,
      validationStatus: { valid: true },
      lastVerified: s.lastVerified,
    };
  }

  let toolPolicies: Record<string, McpToolPolicyType> | undefined;
  if (raw.toolPolicies !== undefined) {
    if (typeof raw.toolPolicies === "object" && raw.toolPolicies !== null) {
      toolPolicies = {};
      for (const [k, v] of Object.entries(raw.toolPolicies)) {
        if (v === "read" || v === "side_effect" || v === "sensitive" || v === "destructive" || v === "unknown") {
          toolPolicies[k] = v;
        }
      }
    }
  }

  const result: McpConfig = {
    version: typeof raw.version === "number" ? raw.version : 1,
    servers: validServers,
    ...(toolPolicies ? { toolPolicies } : {}),
  };

  return { config: result, diagnostics };
}

export function validateMcpConfig(data: unknown): McpConfig | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as any;
  if (typeof raw.servers !== "object" || raw.servers === null) return null;

  const { config, diagnostics } = validateMcpConfigDetailed(data);
  // If top-level object was completely invalid
  if (diagnostics.some(d => !d.serverId && d.severity === "error")) {
    return null;
  }
  return config;
}
