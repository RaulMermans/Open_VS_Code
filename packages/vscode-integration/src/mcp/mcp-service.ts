import * as path from "node:path";
import type * as vscode from "vscode";
import {
  McpCatalog,
  loadMcpConfigWithDiagnostics,
  type McpConfigLoadResult,
  type McpToolMetadata,
  type McpConnectionState,
  type McpServerConfig,
  type SecretProvider,
  type McpPolicyConfig,
  type McpAuthConfig,
  McpMetricsTracker,
} from "@open-vs-code/agent-core";

export interface McpServerSummary {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly state: McpConnectionState;
  readonly toolCount: number;
  readonly tools: McpToolMetadata[];
  readonly auth?: McpAuthConfig;
  readonly error?: string;
  readonly urlOrCommand: string;
  readonly policy?: McpPolicyConfig;
  readonly workspaceScoped: boolean;
  readonly enabled: boolean;
}

export class McpService {
  private catalog?: McpCatalog;
  private currentConfigResult?: McpConfigLoadResult;
  private metrics = new McpMetricsTracker();

  constructor(
    private readonly workspaceRoot: string | undefined,
    private readonly secretProvider: SecretProvider,
    private readonly outputChannel?: vscode.OutputChannel,
  ) {}

  public getRoot(): string | undefined {
    return this.workspaceRoot;
  }

  public getMetrics(): McpMetricsTracker {
    return this.metrics;
  }

  public async getConfigResult(): Promise<McpConfigLoadResult> {
    if (!this.workspaceRoot) {
      return { config: { servers: {} }, diagnostics: [], rawFound: false };
    }
    const result = await loadMcpConfigWithDiagnostics(this.workspaceRoot);
    this.currentConfigResult = result;
    return result;
  }

  public async getCatalog(): Promise<McpCatalog> {
    if (this.catalog) {
      return this.catalog;
    }
    const { config } = await this.getConfigResult();
    this.catalog = new McpCatalog(config, {
      secretProvider: this.secretProvider,
      metrics: this.metrics,
      eventSink: (ev) => {
        if (ev?.type === "mcp.server_failed" || ev?.type === "mcp.tool_timeout") {
          this.outputChannel?.appendLine(`[MCP ${ev.type}] ${ev.serverId || ""}: ${ev.error || ""}`);
        }
      },
    });
    await this.catalog.discover();
    return this.catalog;
  }

  public async listServers(): Promise<McpServerSummary[]> {
    const configResult = await this.getConfigResult();
    const catalog = await this.getCatalog();
    const allTools = catalog.getTools();
    const statuses = catalog.getServerStatuses();
    const statusMap = new Map(statuses.map((s) => [s.serverId, s]));

    const summaries: McpServerSummary[] = [];

    for (const [serverId, srv] of Object.entries(configResult.config.servers)) {
      const status = statusMap.get(serverId);
      const serverTools = allTools.filter((t) => t.serverId === serverId);
      const urlOrCommand =
        srv.transport === "streamable_http" || srv.transport === "http" || srv.transport === "sse"
          ? srv.url || ""
          : `${srv.command} ${(srv.args || []).join(" ")}`.trim();

      summaries.push({
        id: serverId,
        name: srv.displayName || (srv as any).name || serverId,
        transport: srv.transport,
        state: status?.state || (srv.enabled ? "DISCONNECTED" : "DISABLED"),
        toolCount: serverTools.length,
        tools: serverTools,
        auth: srv.auth,
        error: status?.lastError,
        urlOrCommand,
        policy: srv.policy,
        workspaceScoped: srv.workspaceScoped ?? true,
        enabled: srv.enabled,
      });
    }

    return summaries;
  }

  public async connectServer(serverId: string): Promise<{ success: boolean; message: string }> {
    const configResult = await this.getConfigResult();
    const serverConfig = configResult.config.servers[serverId];
    if (!serverConfig) {
      return { success: false, message: `Server "${serverId}" is not defined in configuration.` };
    }
    const catalog = await this.getCatalog();
    const ok = await catalog.connectServer(serverId, serverConfig);
    const status = catalog.getServerStatus(serverId);

    if (ok) {
      const toolCount = catalog.getTools().filter((t) => t.serverId === serverId).length;
      return {
        success: true,
        message: `Connected to MCP server "${serverId}" (${toolCount} tools discovered).`,
      };
    }
    return {
      success: false,
      message: `Failed to connect to MCP server "${serverId}": ${status?.lastError || "Unknown error"}`,
    };
  }

  public async disconnectServer(serverId: string): Promise<{ success: boolean; message: string }> {
    const catalog = await this.getCatalog();
    await catalog.disconnectServer(serverId);
    return {
      success: true,
      message: `Disconnected MCP server "${serverId}".`,
    };
  }

  public async refreshDiscovery(): Promise<{ servers: number; tools: number; diagnostics: number }> {
    if (this.catalog) {
      await this.catalog.close();
      this.catalog = undefined;
    }
    const configResult = await this.getConfigResult();
    const catalog = await this.getCatalog();
    const tools = catalog.getTools();
    const serverCount = Object.keys(configResult.config.servers).length;

    return {
      servers: serverCount,
      tools: tools.length,
      diagnostics: configResult.diagnostics.length,
    };
  }

  public async getDiagnostics(): Promise<string[]> {
    const lines: string[] = [];
    const configResult = await this.getConfigResult();

    for (const d of configResult.diagnostics) {
      lines.push(`[Config ${d.severity.toUpperCase()}] ${d.serverId ? `[${d.serverId}] ` : ""}${d.message}`);
    }

    if (this.catalog) {
      const statuses = this.catalog.getServerStatuses();
      for (const status of statuses) {
        if (status.state === "FAILED" || status.state === "DEGRADED" || status.state === "AUTH_REQUIRED") {
          lines.push(`[Server ${status.state}] [${status.serverId}]: ${status.lastError || "Requires attention"}`);
        }
      }
    }

    return lines;
  }

  public async dispose(): Promise<void> {
    if (this.catalog) {
      await this.catalog.close();
      this.catalog = undefined;
    }
  }
}
