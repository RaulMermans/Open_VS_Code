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
