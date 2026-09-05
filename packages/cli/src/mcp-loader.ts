import * as fs from "node:fs/promises";
import * as path from "node:path";
import { McpConfig } from "@open-vs-code/agent-core";

export async function loadMcpConfig(workspaceRoot: string): Promise<McpConfig> {
  const configPath = path.join(workspaceRoot, ".open-vs-code", "mcp.json");
  try {
    const data = await fs.readFile(configPath, "utf-8");
    return JSON.parse(data) as McpConfig;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.warn(`Warning: Could not read MCP config at ${configPath}: ${err.message}`);
    }
    return { servers: {} };
  }
}
