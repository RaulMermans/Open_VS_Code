import type { ToolRegistration, ToolExecutionContext, ReviewableExecution } from "../tools/registry.ts";
import type { ToolAction } from "../contracts/tools.ts";
import type { McpToolMetadata } from "./mcp-catalog.ts";
import type { McpTransport } from "./mcp-transport.ts";
import type { McpConfig } from "./mcp-config.ts";

export interface McpStats {
  callsStarted: number;
  callsCompleted: number;
  callsRejected: number; // Not tracked inside execute directly, tracked in app.ts, wait... if it is not called it is rejected? Actually, confirmation flow handles rejection. We can track it there. Wait, AgentRunner doesn't call execute if rejected. So we track rejection where? In app.ts!
  callsCancelled: number;
  callsTimedOut: number;
  resultBytesRetained: number;
  resultsTruncated: number;
}

export function createMcpToolRegistration(
  metadata: McpToolMetadata,
  transport: McpTransport,
  config: McpConfig,
  stats?: McpStats
): ToolRegistration {
  const localPolicy = config.toolPolicies?.[metadata.canonicalName];
  
  // Risk classification
  let action: ToolAction = "mcp_external_unknown";
  
  if (localPolicy === "read") action = "mcp_external_read";
  else if (localPolicy === "side_effect") action = "mcp_external_side_effect";
  else if (localPolicy === "unknown") action = "mcp_external_unknown";
  else {
    action = "mcp_external_unknown";
  }

  const safeName = metadata.canonicalName.replace(/[^a-z0-9_]/gi, "_").toLowerCase();

  return {
    definition: {
      name: safeName,
      description: `[MCP: ${metadata.serverId}] ${metadata.description}`,
      inputSchema: metadata.inputSchema || {},
      action,
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null) return {};
      return input as Readonly<Record<string, unknown>>;
    },
    ...(action === "mcp_external_side_effect" || action === "mcp_external_unknown"
      ? {
          prepareForReview: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ReviewableExecution> => {
            return {
              id: `mcp-${Date.now()}`,
              reviewPayload: {
                server: metadata.serverId,
                tool: metadata.toolName,
                risk: action,
                warning: "This tool performs an external side effect or its risk is unknown. Do you approve?",
                arguments: input
              },
              apply: async (applyContext) => {
                return executeMcpCall(metadata, transport, input, applyContext, stats);
              }
            };
          }
        }
      : {}),
    execute: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) => {
      return executeMcpCall(metadata, transport, input, context, stats);
    }
  };
}

async function executeMcpCall(metadata: McpToolMetadata, transport: McpTransport, input: Readonly<Record<string, unknown>>, context: ToolExecutionContext, stats?: McpStats) {
  if (stats) stats.callsStarted++;
  try {
    const result = await transport.callTool(metadata.toolName, input, context.signal);
    
    // Bounds check
    let truncated = false;
    let finalContent = result.content;
    
    const maxContentBytes = 50 * 1024; // 50KB bound
    const stringified = JSON.stringify(result.content);
    let bytesRetained = stringified.length;
    
    if (stringified.length > maxContentBytes) {
      truncated = true;
      const partial = stringified.substring(0, Math.min(500, maxContentBytes));
      finalContent = [{ type: "text", text: `[TRUNCATED] Response exceeded ${maxContentBytes} bytes. Showing partial summary: ${partial}...` }];
      bytesRetained = JSON.stringify(finalContent).length;
      if (stats) stats.resultsTruncated++;
    }

    if (stats) {
      stats.callsCompleted++;
      stats.resultBytesRetained += bytesRetained;
    }

    return {
      content: finalContent,
      isError: result.isError,
      truncated
    };
  } catch (err: any) {
    if (context.signal.aborted) {
      if (stats) stats.callsCancelled++;
      throw new DOMException("Tool call cancelled", "AbortError");
    }
    if (err.message && err.message.includes("Timeout")) {
      if (stats) stats.callsTimedOut++;
    } else {
      if (stats) stats.callsCompleted++; // Errored but completed
    }
    
    // Return bounded error observation
    return {
      error: {
        code: err.code || "MCP_CALL_ERROR",
        message: err.message || String(err)
      }
    };
  }
}
