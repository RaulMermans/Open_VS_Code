import type { McpConfig } from "./mcp-config.ts";
import { StdioMcpTransport } from "./mcp-transport.ts";
import { TestMcpTransport } from "./mcp-test-transport.ts";
import type { McpTransport } from "./mcp-transport.ts";

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

export class McpCatalog {
  private transports = new Map<string, McpTransport>();
  private tools = new Map<string, McpToolMetadata>();
  private connectedServers = new Set<string>();

  constructor(private config: McpConfig, private eventSink?: (ev: any) => void) {}

  private emit(type: string, payload: any) {
    if (this.eventSink) {
      this.eventSink({ id: `mcp-ev-${Date.now()}-${Math.random()}`, type, timestamp: new Date().toISOString(), payload });
    }
  }

  async discover(signal?: AbortSignal): Promise<void> {
    for (const [serverId, serverConfig] of Object.entries(this.config.servers)) {
      if (!serverConfig.enabled) continue;

      let transport: McpTransport | undefined = (serverConfig as any).testTransport ?? this.transports.get(serverId);
      if (!transport) {
        if (serverConfig.transport === "stdio") {
          if (!serverConfig.command) continue;

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
        } else if (serverConfig.transport === "test") {
          transport = new TestMcpTransport(serverId);
        } else {
          continue; // Unsupported
        }
      }

      this.transports.set(serverId, transport);
      
      try {
        await transport.connect(signal);
        this.connectedServers.add(serverId);
        this.emit("mcp.server_connected", { serverId });
        
        const serverTools = await transport.listTools(signal);
        const discovered = [];
        const seenInServer = new Set<string>();

        for (const tool of serverTools) {
          if (seenInServer.has(tool.name)) {
            throw new Error(`Same-server duplicate tool name: ${tool.name}`);
          }
          seenInServer.add(tool.name);

          const safeServer = serverId.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
          const safeTool = tool.name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
          const canonicalName = `mcp_${safeServer}_${safeTool}`;

          if (this.tools.has(canonicalName)) {
             throw new Error(`Tool collision detected for ${canonicalName}`);
          }
          
          if (tool.inputSchema !== undefined && (typeof tool.inputSchema !== "object" || tool.inputSchema === null || Array.isArray(tool.inputSchema))) {
            console.warn(`Malformed schema for MCP tool ${canonicalName}: schema must be a non-null object`);
            continue;
          }

          let schemaString = "";
          try {
            schemaString = JSON.stringify(tool.inputSchema || {});
          } catch {
            console.warn(`Malformed schema for MCP tool ${canonicalName}: schema is not JSON-serializable`);
            continue;
          }

          // Size bound: reject schemas that are too large to be legitimate
          if (schemaString.length > MAX_SCHEMA_BYTES) {
            console.warn(`MCP tool ${canonicalName} schema exceeds size limit (${schemaString.length} bytes > ${MAX_SCHEMA_BYTES}): skipping`);
            continue;
          }

          // Depth bound: reject schemas that are too deeply nested (schema-bomb / stack-overflow protection)
          if (measureDepth(tool.inputSchema || {}, 0) >= MAX_SCHEMA_DEPTH) {
            console.warn(`MCP tool ${canonicalName} schema exceeds depth limit (${MAX_SCHEMA_DEPTH}): skipping`);
            continue;
          }
          
          const meta = {
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
        this.emit("mcp.tools_discovered", { serverId, tools: discovered.map(t => t.canonicalName) });
      } catch (e) {
        console.warn(`Failed to connect to MCP server ${serverId}: ${e}`);
        transport.close().catch(() => {});
        this.transports.delete(serverId);
      }
    }
  }

  getTools(): McpToolMetadata[] {
    return Array.from(this.tools.values());
  }

  getTransport(serverId: string): McpTransport | undefined {
    return this.transports.get(serverId);
  }

  getConnectedServers(): string[] {
    return Array.from(this.connectedServers);
  }

  async close(): Promise<void> {
    for (const [serverId, transport] of this.transports.entries()) {
      await transport.close().catch(() => {});
      this.emit("mcp.server_closed", { serverId });
    }
    this.transports.clear();
    this.tools.clear();
    this.connectedServers.clear();
  }
}
