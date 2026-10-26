import type { McpConfig, McpServerConfig } from "./mcp-config.ts";
import { StdioMcpTransport, type McpTransport } from "./mcp-transport.ts";
import { TestMcpTransport } from "./mcp-test-transport.ts";
import { StreamableHttpMcpTransport, McpAuthRequiredError, McpSecurityError } from "./mcp-http-transport.ts";
import type { McpConnectionState, McpServerStatus } from "./mcp-connection-state.ts";
import type { SecretProvider } from "./mcp-auth.ts";
import { McpMetricsTracker } from "./mcp-metrics.ts";

/** Maximum serialized schema bytes before rejection (64 KB). */
export const MAX_SCHEMA_BYTES = 64 * 1024;

/** Maximum JSON nesting depth allowed in an MCP schema. */
export const MAX_SCHEMA_DEPTH = 16;

/** Measure the maximum nesting depth of a parsed JSON value (without recursion beyond limit). */
function measureDepth(value: unknown, depth: number): number {
  if (depth >= MAX_SCHEMA_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) {
      const d = measureDepth(item, depth + 1);
      if (d >= MAX_SCHEMA_DEPTH) return d;
      if (d > max) max = d;
    }
    return max;
  }
  if (value !== null && typeof value === "object") {
    let max = depth;
    for (const v of Object.values(value as Record<string, unknown>)) {
      const d = measureDepth(v, depth + 1);
      if (d >= MAX_SCHEMA_DEPTH) return d;
      if (d > max) max = d;
    }
    return max;
  }
  return depth;
}

export interface McpToolMetadata {
  serverId: string;
  toolName: string;
  canonicalName: string;
  description: string;
  inputSchemaSummary?: string;
  inputSchema?: any; // kept but not necessarily sent to model until selected
  annotations?: {
    readOnlyHint?: boolean;
    [key: string]: unknown;
  };
  schemaHash?: string;
  estimatedSchemaTokens: number;
}

const safeBaseEnvNames = [
  "PATH", "HOME", "USER", "TMPDIR", "TEMP", "SystemRoot", "USERPROFILE"
];

export interface McpCatalogOptions {
  readonly eventSink?: ((ev: any) => void) | undefined;
  readonly secretProvider?: SecretProvider | undefined;
  readonly metrics?: McpMetricsTracker | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

export class McpCatalog {
  private transports = new Map<string, McpTransport>();
  private tools = new Map<string, McpToolMetadata>();
  private serverStates = new Map<string, McpConnectionState>();
  private serverErrors = new Map<string, string>();
  private lastConnectedTimes = new Map<string, string>();
  private reconnectCounts = new Map<string, number>();

  private eventSink?: ((ev: any) => void) | undefined;
  private secretProvider?: SecretProvider | undefined;
  private metrics: McpMetricsTracker;
  private maxReconnectAttempts: number;

  constructor(
    private config: McpConfig,
    optionsOrSink?: ((ev: any) => void) | McpCatalogOptions
  ) {
    if (typeof optionsOrSink === "function") {
      this.eventSink = optionsOrSink;
      this.metrics = new McpMetricsTracker();
      this.maxReconnectAttempts = 3;
    } else if (optionsOrSink && typeof optionsOrSink === "object") {
      this.eventSink = optionsOrSink.eventSink;
      this.secretProvider = optionsOrSink.secretProvider;
      this.metrics = optionsOrSink.metrics ?? new McpMetricsTracker();
      this.maxReconnectAttempts = optionsOrSink.maxReconnectAttempts ?? 3;
    } else {
      this.metrics = new McpMetricsTracker();
      this.maxReconnectAttempts = 3;
    }

    // Initialize initial state for all configured servers
    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      if (!serverConfig.enabled) {
        this.serverStates.set(serverId, "DISABLED");
      } else {
        this.serverStates.set(serverId, "DISCONNECTED");
      }
    }
  }

  private emit(type: string, payload: any) {
    if (this.eventSink) {
      this.eventSink({
        id: `mcp-ev-${Date.now()}-${Math.random()}`,
        type,
        timestamp: new Date().toISOString(),
        payload,
      });
    }
  }

  getMetrics(): McpMetricsTracker {
    return this.metrics;
  }

  getConfig(): McpConfig {
    return this.config;
  }

  /**
   * Register or update an MCP server configuration in the catalog.
   * State defaults to DISCONNECTED (if enabled) or DISABLED (if disabled).
   * Does NOT auto-connect or execute tools.
   */
  registerServer(serverId: string, config: McpServerConfig): void {
    this.config.servers[serverId] = config;
    if (config.enabled) {
      this.serverStates.set(serverId, "DISCONNECTED");
    } else {
      this.serverStates.set(serverId, "DISABLED");
    }
  }

  getServerState(serverId: string): McpConnectionState {
    return this.serverStates.get(serverId) ?? "DISCONNECTED";
  }

  getServerStatuses(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];
    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      const state = this.serverStates.get(serverId) ?? (serverConfig.enabled ? "DISCONNECTED" : "DISABLED");
      const serverTools = Array.from(this.tools.values()).filter((t) => t.serverId === serverId);
      const transportInstance = this.transports.get(serverId);
      let negotiatedVersion: string | undefined;
      if (transportInstance instanceof StreamableHttpMcpTransport) {
        negotiatedVersion = transportInstance.getNegotiatedProtocolVersion();
      }

      statuses.push({
        serverId,
        displayName: serverConfig.displayName ?? serverId,
        transport: serverConfig.transport,
        state,
        toolsCount: serverTools.length,
        negotiatedProtocolVersion: negotiatedVersion,
        lastConnectedAt: this.lastConnectedTimes.get(serverId),
        lastError: this.serverErrors.get(serverId),
        authRequired: state === "AUTH_REQUIRED",
        authType: serverConfig.auth?.type,
        endpointOrCommand: serverConfig.url || serverConfig.command,
      });
    }
    return statuses;
  }

  getServerStatus(serverId: string): McpServerStatus | undefined {
    return this.getServerStatuses().find((s) => s.serverId === serverId);
  }

  getDiagnostics(serverId: string): string[] {
    const diagnostics: string[] = [];
    const serverConfig = this.config.servers[serverId];
    if (!serverConfig) {
      diagnostics.push(`Server "${serverId}" is not found in configuration.`);
      return diagnostics;
    }

    const state = this.serverStates.get(serverId) ?? "DISCONNECTED";
    diagnostics.push(`Server: ${serverId} (Transport: ${serverConfig.transport}, State: ${state})`);

    const lastErr = this.serverErrors.get(serverId);
    if (lastErr) {
      diagnostics.push(`Error: ${lastErr}`);
    }

    if (state === "AUTH_REQUIRED") {
      diagnostics.push(
        `Authentication is required for "${serverId}". Check SecretStorage for key "${serverConfig.auth?.secretKey ?? "token"}" or provide environment variable "${serverConfig.auth?.tokenEnv ?? ""}".`
      );
    }

    if (state === "FAILED") {
      const attempts = this.reconnectCounts.get(serverId) ?? 0;
      diagnostics.push(`Connection failed after ${attempts} reconnect attempt(s).`);
    }

    return diagnostics;
  }

  async discover(signal?: AbortSignal): Promise<void> {
    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      if (!serverConfig.enabled) {
        this.serverStates.set(serverId, "DISABLED");
        continue;
      }

      await this.connectServer(serverId, serverConfig, signal);
    }
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.discover(signal);
  }

  async connectServer(serverId: string, serverConfig: McpServerConfig, signal?: AbortSignal): Promise<boolean> {
    this.serverStates.set(serverId, "CONNECTING");
    this.emit("mcp.server_connecting", { serverId });

    let transport: McpTransport | undefined = (serverConfig as any).testTransport ?? this.transports.get(serverId);
    if (!transport) {
      if (serverConfig.transport === "stdio") {
        if (!serverConfig.command) {
          this.serverStates.set(serverId, "FAILED");
          this.serverErrors.set(serverId, "Missing executable command");
          return false;
        }

        // Filter env
        const env: Record<string, string> = {};
        for (const name of safeBaseEnvNames) {
          if (process.env[name] !== undefined) {
            env[name] = process.env[name]!;
          }
        }
        if (serverConfig.envFrom) {
          for (const key of serverConfig.envFrom) {
            if (process.env[key] !== undefined) {
              env[key] = process.env[key]!;
            }
          }
        }

        transport = new StdioMcpTransport(serverConfig.command, serverConfig.args || [], env);
      } else if (
        serverConfig.transport === "streamable_http" ||
        serverConfig.transport === "http" ||
        serverConfig.transport === "sse"
      ) {
        const endpoint = serverConfig.url;
        if (!endpoint) {
          this.serverStates.set(serverId, "FAILED");
          this.serverErrors.set(serverId, "Missing endpoint URL for remote HTTP transport");
          return false;
        }

        try {
          transport = new StreamableHttpMcpTransport(endpoint, {
            authConfig: serverConfig.auth,
            secretProvider: this.secretProvider,
            metrics: this.metrics,
          });
        } catch (e: any) {
          this.serverStates.set(serverId, "FAILED");
          this.serverErrors.set(serverId, e.message);
          return false;
        }
      } else if (serverConfig.transport === "test") {
        transport = new TestMcpTransport(serverId);
      } else {
        this.serverStates.set(serverId, "FAILED");
        this.serverErrors.set(serverId, `Unsupported transport: ${serverConfig.transport}`);
        return false;
      }
    }

    this.transports.set(serverId, transport);

    try {
      await transport.connect(signal);
      this.serverStates.set(serverId, "CONNECTED");
      this.serverErrors.delete(serverId);
      this.lastConnectedTimes.set(serverId, new Date().toISOString());
      this.reconnectCounts.set(serverId, 0);
      this.emit("mcp.server_connected", { serverId });

      const serverTools = await transport.listTools(signal);
      const discovered: McpToolMetadata[] = [];
      const seenInServer = new Set<string>();

      // Clear any prior tools registered for this server to prevent duplicate collisions
      for (const [canonicalName, meta] of Array.from(this.tools.entries())) {
        if (meta.serverId === serverId) {
          this.tools.delete(canonicalName);
        }
      }

      for (const tool of serverTools) {
        if (seenInServer.has(tool.name)) {
          throw new Error(`Same-server duplicate tool name: ${tool.name}`);
        }
        seenInServer.add(tool.name);

        // Policy filtering (allowedTools / deniedTools)
        if (serverConfig.policy?.deniedTools && serverConfig.policy.deniedTools.includes(tool.name)) {
          continue;
        }
        if (serverConfig.policy?.allowedTools && !serverConfig.policy.allowedTools.includes(tool.name)) {
          continue;
        }

        const safeServer = serverId.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
        const safeTool = tool.name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
        const canonicalName = `mcp_${safeServer}_${safeTool}`;

        if (this.tools.has(canonicalName)) {
          throw new Error(`Tool collision detected for ${canonicalName}`);
        }

        if (
          tool.inputSchema !== undefined &&
          (typeof tool.inputSchema !== "object" || tool.inputSchema === null || Array.isArray(tool.inputSchema))
        ) {
          console.warn(`Malformed schema for MCP tool ${canonicalName}: schema must be a non-null object`);
          this.serverStates.set(serverId, "DEGRADED");
          continue;
        }

        let schemaString = "";
        try {
          schemaString = JSON.stringify(tool.inputSchema || {});
        } catch {
          console.warn(`Malformed schema for MCP tool ${canonicalName}: schema is not JSON-serializable`);
          this.serverStates.set(serverId, "DEGRADED");
          continue;
        }

        // Size bound: reject schemas that are too large (64 KB)
        if (schemaString.length > MAX_SCHEMA_BYTES) {
          console.warn(
            `MCP tool ${canonicalName} schema exceeds size limit (${schemaString.length} bytes > ${MAX_SCHEMA_BYTES}): skipping`
          );
          this.serverStates.set(serverId, "DEGRADED");
          continue;
        }

        // Depth bound: reject schemas that are too deeply nested (16 levels)
        if (measureDepth(tool.inputSchema || {}, 0) >= MAX_SCHEMA_DEPTH) {
          console.warn(`MCP tool ${canonicalName} schema exceeds depth limit (${MAX_SCHEMA_DEPTH}): skipping`);
          this.serverStates.set(serverId, "DEGRADED");
          continue;
        }

        const meta: McpToolMetadata = {
          serverId,
          toolName: tool.name,
          canonicalName,
          description: tool.description || "",
          inputSchema: tool.inputSchema || {},
          estimatedSchemaTokens: Math.ceil(schemaString.length / 4),
        };
        this.tools.set(canonicalName, meta);
        discovered.push(meta);
      }

      this.emit("mcp.tools_discovered", { serverId, tools: discovered.map((t) => t.canonicalName) });
      return true;
    } catch (e: any) {
      if (e instanceof McpAuthRequiredError) {
        this.serverStates.set(serverId, "AUTH_REQUIRED");
        this.serverErrors.set(serverId, e.message);
      } else if (e instanceof McpSecurityError) {
        this.serverStates.set(serverId, "FAILED");
        this.serverErrors.set(serverId, e.message);
      } else {
        this.serverStates.set(serverId, "FAILED");
        this.serverErrors.set(serverId, e.message || String(e));
      }

      console.warn(`Failed to connect to MCP server ${serverId}: ${e.message || e}`);
      transport.close().catch(() => {});
      this.transports.delete(serverId);
      return false;
    }
  }

  /**
   * Disconnect a single server safely.
   */
  async disconnectServer(serverId: string): Promise<void> {
    const transport = this.transports.get(serverId);
    if (transport) {
      await transport.close().catch(() => {});
      this.transports.delete(serverId);
    }

    // Remove discovered tools for this server
    for (const [canonicalName, meta] of Array.from(this.tools.entries())) {
      if (meta.serverId === serverId) {
        this.tools.delete(canonicalName);
      }
    }

    const wasEnabled = this.config.servers[serverId]?.enabled;
    this.serverStates.set(serverId, wasEnabled ? "DISCONNECTED" : "DISABLED");
    this.emit("mcp.server_closed", { serverId });
  }

  /**
   * Unregister an MCP server from the catalog completely.
   * Disconnects active transport, flushes discovered tools, and removes configuration.
   */
  async unregisterServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    delete this.config.servers[serverId];
    this.serverStates.delete(serverId);
    this.serverErrors.delete(serverId);
    this.lastConnectedTimes.delete(serverId);
    this.reconnectCounts.delete(serverId);
    for (const [canonicalName, meta] of Array.from(this.tools.entries())) {
      if (meta.serverId === serverId) {
        this.tools.delete(canonicalName);
      }
    }
  }

  /**
   * Reconnect a server with bounded retry logic (max attempts).
   */
  async reconnectServer(serverId: string, signal?: AbortSignal): Promise<boolean> {
    const serverConfig = this.config.servers[serverId];
    if (!serverConfig) return false;

    const currentAttempts = this.reconnectCounts.get(serverId) ?? 0;
    if (currentAttempts >= this.maxReconnectAttempts) {
      this.serverStates.set(serverId, "FAILED");
      this.serverErrors.set(
        serverId,
        `Reconnect failed: maximum retry attempts (${this.maxReconnectAttempts}) exhausted`
      );
      this.metrics.recordReconnectAttempt();
      return false;
    }

    this.reconnectCounts.set(serverId, currentAttempts + 1);
    this.metrics.recordReconnectAttempt();

    await this.disconnectServer(serverId);
    return await this.connectServer(serverId, serverConfig, signal);
  }

  getTools(): McpToolMetadata[] {
    return Array.from(this.tools.values());
  }

  getTransport(serverId: string): McpTransport | undefined {
    return this.transports.get(serverId);
  }

  getConnectedServers(): string[] {
    const connected: string[] = [];
    for (const [serverId, state] of this.serverStates.entries()) {
      if (state === "CONNECTED" || state === "DEGRADED") {
        connected.push(serverId);
      }
    }
    return connected;
  }

  async close(): Promise<void> {
    for (const [serverId, transport] of this.transports.entries()) {
      await transport.close().catch(() => {});
      this.emit("mcp.server_closed", { serverId });
    }
    this.transports.clear();
    this.tools.clear();
    for (const serverId of Object.keys(this.config.servers)) {
      this.serverStates.set(serverId, "DISCONNECTED");
    }
  }
}
