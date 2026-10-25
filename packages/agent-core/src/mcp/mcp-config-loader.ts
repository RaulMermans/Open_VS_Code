import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type McpConfig, validateMcpConfigDetailed, type McpConfigDiagnostic } from "./mcp-config.ts";

export interface McpConfigLoadResult {
  readonly config: McpConfig;
  readonly diagnostics: McpConfigDiagnostic[];
  readonly rawFound: boolean;
}

export async function loadMcpConfigWithDiagnostics(workspaceRoot: string): Promise<McpConfigLoadResult> {
  const configPath = path.join(workspaceRoot, ".open-vs-code", "mcp.json");
  try {
    const data = await fs.readFile(configPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (parseErr: any) {
      return {
        config: { servers: {} },
        diagnostics: [
          { message: `Malformed JSON in MCP configuration at ${configPath}: ${parseErr.message}`, severity: "error" },
        ],
        rawFound: true,
      };
    }

    const { config, diagnostics } = validateMcpConfigDetailed(parsed);
    return { config, diagnostics, rawFound: true };
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      return {
        config: { servers: {} },
        diagnostics: [{ message: `Could not read MCP config at ${configPath}: ${err.message}`, severity: "error" }],
        rawFound: false,
      };
    }
    return { config: { servers: {} }, diagnostics: [], rawFound: false };
  }
}

export async function loadMcpConfig(workspaceRoot: string): Promise<McpConfig> {
  const { config, diagnostics } = await loadMcpConfigWithDiagnostics(workspaceRoot);
  for (const d of diagnostics) {
    if (d.severity === "error") {
      console.warn(`[MCP Config Diagnostic] ${d.serverId ? `[${d.serverId}] ` : ""}${d.message}`);
    }
  }
  return config;
}
