import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type McpConfig, validateMcpConfig } from "./mcp-config.ts";

export async function loadMcpConfig(workspaceRoot: string): Promise<McpConfig> {
  const configPath = path.join(workspaceRoot, ".open-vs-code", "mcp.json");
  try {
    const data = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(data);
    const valid = validateMcpConfig(parsed);
    if (!valid) {
      console.warn(`Warning: Invalid MCP config structure at ${configPath}`);
      return { servers: {} };
    }
    return valid;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.warn(`Warning: Could not read MCP config at ${configPath}: ${err.message}`);
    }
    return { servers: {} };
  }
}
