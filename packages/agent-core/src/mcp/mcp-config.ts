export interface McpConfig {
  servers: Record<string, McpServerConfig>;
  toolPolicies?: Record<string, "read" | "side_effect" | "unknown">;
}

export interface McpServerConfig {
  transport: "stdio" | "test";
  command?: string;
  args?: string[];
  envFrom?: string[];
  enabled: boolean;
}



export function validateMcpConfig(data: unknown): McpConfig | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as any;
  if (typeof raw.servers !== "object" || raw.servers === null) return null;

  const validServers: Record<string, McpServerConfig> = {};
  for (const [key, srv] of Object.entries(raw.servers)) {
    if (typeof srv !== "object" || srv === null) continue;
    const s = srv as any;
    
    if (typeof s.enabled !== "boolean") continue;
    if (s.transport !== "stdio" && s.transport !== "test") continue;
    
    if (s.transport === "stdio") {
      if (typeof s.command !== "string") continue;
      
      const cmdBasename = (s.command.split(/[/\\]/).pop() || "").toLowerCase();
      if (
        cmdBasename === "npx" ||
        cmdBasename === "bunx" ||
        (cmdBasename === "npm" && s.args?.[0] === "exec") ||
        (cmdBasename === "pnpm" && s.args?.[0] === "dlx") ||
        (cmdBasename === "yarn" && s.args?.[0] === "dlx")
      ) {
        continue; // Silently omit instead of throwing
      }
      
      if (s.args !== undefined && !Array.isArray(s.args)) continue;
      if (s.args?.some((a: any) => typeof a !== "string")) continue;
      
      if (s.envFrom !== undefined && !Array.isArray(s.envFrom)) continue;
      if (s.envFrom?.some((e: any) => typeof e !== "string")) continue;
    }

    validServers[key] = {
      transport: s.transport,
      command: s.command,
      args: s.args,
      envFrom: s.envFrom,
      enabled: s.enabled
    };
  }

  let toolPolicies: Record<string, "read" | "side_effect" | "unknown"> | undefined;
  if (raw.toolPolicies !== undefined) {
    if (typeof raw.toolPolicies !== "object" || raw.toolPolicies === null) return null;
    toolPolicies = {};
    for (const [k, v] of Object.entries(raw.toolPolicies)) {
      if (v === "read" || v === "side_effect" || v === "unknown") {
        toolPolicies[k] = v;
      }
    }
  }

  const result: any = { servers: validServers };
  if (toolPolicies) {
    result.toolPolicies = toolPolicies;
  }
  return result as McpConfig;
}
