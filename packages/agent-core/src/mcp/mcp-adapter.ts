import type { ToolRegistration, ToolExecutionContext, ReviewableExecution } from "../tools/registry.ts";
import type { ToolAction } from "../contracts/tools.ts";
import type { McpToolMetadata } from "./mcp-catalog.ts";
import type { McpTransport } from "./mcp-transport.ts";
import type { McpConfig } from "./mcp-config.ts";

export interface McpStats {
  callsStarted: number;
  callsCompleted: number;
  callsRejected: number;
  callsCancelled: number;
  callsTimedOut: number;
  callsFailed: number;
  resultBytesRetained: number;
  resultsTruncated: number;
}

function validateSchema(schema: any, input: any): Error | null {
  if (!schema || typeof schema !== "object") return null;

  if (schema.oneOf || schema.anyOf || schema.allOf || schema.$ref) {
    return new Error("Unsupported schema feature: oneOf/anyOf/allOf/$ref");
  }

  if (schema.type === "object") {
    if (typeof input !== "object" || input === null) return new Error("Expected object");

    if (schema.required && Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in input) || input[req] === undefined) {
          return new Error(`Missing required property: ${req}`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, value] of Object.entries(input)) {
        if (schema.properties[key]) {
          const err = validateSchema(schema.properties[key], value);
          if (err) return new Error(`Property ${key}: ${err.message}`);
        } else if (schema.additionalProperties === false) {
          return new Error(`Unexpected property: ${key}`);
        }
      }
    }
  } else if (schema.type === "string") {
    if (typeof input !== "string") return new Error("Expected string");
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof input !== "number") return new Error("Expected number");
  } else if (schema.type === "boolean") {
    if (typeof input !== "boolean") return new Error("Expected boolean");
  } else if (schema.type === "array") {
    if (!Array.isArray(input)) return new Error("Expected array");
    if (schema.items) {
      for (let i = 0; i < input.length; i++) {
        const err = validateSchema(schema.items, input[i]);
        if (err) return new Error(`Array item ${i}: ${err.message}`);
      }
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(input)) {
      return new Error(`Expected one of: ${schema.enum.join(", ")}`);
    }
  }

  return null;
}

function getWarningMessage(act: ToolAction): string {
  switch (act) {
    case "mcp_sensitive_data_transmission":
      return "This tool transmits sensitive data to an external MCP server. Do you approve?";
    case "mcp_external_destructive":
      return "This tool performs potentially destructive actions on an external system. Do you approve?";
    case "mcp_external_side_effect":
      return "This tool performs an external side effect. Do you approve?";
    default:
      return "This tool's risk is unknown. Do you approve?";
  }
}

export function classifyMcpAction(
  metadata: McpToolMetadata,
  config?: McpConfig
): ToolAction {
  const serverConfig = config?.servers[metadata.serverId];
  const localPolicy =
    config?.toolPolicies?.[metadata.canonicalName] ??
    serverConfig?.policy?.toolPolicies?.[metadata.toolName];

  if (localPolicy === "read") {
    return "mcp_external_read";
  } else if (localPolicy === "side_effect") {
    return "mcp_external_side_effect";
  } else if (localPolicy === "sensitive") {
    return "mcp_sensitive_data_transmission";
  } else if (localPolicy === "destructive") {
    return "mcp_external_destructive";
  } else if (localPolicy === "unknown") {
    return "mcp_external_unknown";
  }
  // Server annotations CANNOT lower risk to read
  return "mcp_external_unknown";
}

export function createMcpToolRegistration(
  metadata: McpToolMetadata,
  transport: McpTransport,
  config: McpConfig,
  stats?: McpStats
): ToolRegistration {
  const action = classifyMcpAction(metadata, config);

  const isReviewable = action !== "mcp_external_read";

  return {
    definition: {
      name: metadata.canonicalName,
      description: `[MCP: ${metadata.serverId}] ${metadata.description}`,
      inputSchema: metadata.inputSchema || {},
      action,
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Expected object root for tool input");
      }
      const err = validateSchema(metadata.inputSchema, input);
      if (err) throw err;
      return input as Readonly<Record<string, unknown>>;
    },
    ...(isReviewable
      ? {
          prepareForReview: async (
            input: Readonly<Record<string, unknown>>,
            _context: ToolExecutionContext
          ): Promise<ReviewableExecution> => {
            return {
              id: `mcp-${Date.now()}`,
              reviewPayload: {
                server: metadata.serverId,
                tool: metadata.toolName,
                risk: action,
                warning: getWarningMessage(action),
                arguments: input,
              },
              apply: async (applyContext) => {
                return executeMcpCall(metadata, transport, input, applyContext, stats);
              },
            };
          },
        }
      : {}),
    execute: async (input: Readonly<Record<string, unknown>>, _context: ToolExecutionContext) => {
      return executeMcpCall(metadata, transport, input, _context, stats);
    },
  };
}

export const MAX_MCP_RESULT_BYTES = 50 * 1024;

async function executeMcpCall(
  metadata: McpToolMetadata,
  transport: McpTransport,
  input: Readonly<Record<string, unknown>>,
  context: ToolExecutionContext,
  stats?: McpStats
) {
  if (stats) stats.callsStarted++;
  try {
    const result = await transport.callTool(metadata.toolName, input, context.signal);

    let truncated = false;
    let finalContent = result.content;

    const maxContentBytes = MAX_MCP_RESULT_BYTES;
    const stringified = JSON.stringify(result.content);
    let bytesRetained = Buffer.byteLength(stringified, "utf8");

    if (bytesRetained > maxContentBytes) {
      truncated = true;
      const partial = stringified.substring(0, Math.min(500, maxContentBytes));
      finalContent = [
        {
          type: "text",
          text: `[TRUNCATED] Response exceeded ${maxContentBytes} bytes. Showing partial summary: ${partial}...`,
        },
      ];
      bytesRetained = Buffer.byteLength(JSON.stringify(finalContent), "utf8");
      if (stats) stats.resultsTruncated++;
    }

    if (stats) {
      stats.callsCompleted++;
      stats.resultBytesRetained += bytesRetained;
    }

    return {
      content: finalContent,
      isError: result.isError,
      truncated,
    };
  } catch (err: any) {
    if (context.signal.aborted) {
      if (stats) stats.callsCancelled++;
      throw new DOMException("Tool call cancelled", "AbortError");
    }
    if (err.message && (err.message.includes("Timeout") || err.message.includes("timeout"))) {
      if (stats) stats.callsTimedOut++;
    } else {
      if (stats) stats.callsFailed = (stats.callsFailed || 0) + 1;
    }

    return {
      error: {
        code: err.code || "MCP_CALL_ERROR",
        message: err.message || String(err),
      },
    };
  }
}
