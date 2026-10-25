import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import * as http from "node:http";
import { StreamableHttpMcpTransport } from "@open-vs-code/agent-core";

/**
 * Independent MCP Protocol Conformance Server
 * Decoupled implementation compliant with official MCP Spec 2026-07-28
 *
 * Source: Model Context Protocol Specification (https://spec.modelcontextprotocol.io)
 * Protocol Revisions: 2026-07-28 (Streamable HTTP, per-request _meta), 2025-11-25 (Mcp-Session-Id)
 * Exercised operations:
 *   - initialize (protocol version negotiation, client capabilities, server info)
 *   - tools/list (tool declarations, JSON Schema validation)
 *   - tools/call (execution of independent tool, text content formatting)
 *   - resources/list (resource inventory querying)
 *   - prompts/list (prompt template discovery)
 *   - header routing (Mcp-Method verification)
 *   - error formatting (standard JSON-RPC 2.0 error codes: -32600, -32601, -32602)
 */
class IndependentMcpServer {
  private server?: http.Server | undefined;
  public port = 0;
  public recordedRequests: Array<{ method?: string | undefined; headers: http.IncomingHttpHeaders; body: any }> = [];

  async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        let bodyStr = "";
        req.on("data", (chunk) => {
          bodyStr += chunk.toString("utf8");
        });

        req.on("end", () => {
          let body: any = {};
          try {
            if (bodyStr) body = JSON.parse(bodyStr);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
            return;
          }

          this.recordedRequests.push({
            method: req.method,
            headers: req.headers,
            body,
          });

          // MCP Header routing check
          const mcpMethodHeader = req.headers["mcp-method"];

          // Handle JSON-RPC methods
          const rpcMethod = body.method;
          const rpcId = body.id;

          if (mcpMethodHeader && mcpMethodHeader !== rpcMethod) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                error: { code: -32600, message: "Mcp-Method header does not match RPC method" },
              })
            );
            return;
          }

          if (rpcMethod === "ping") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: {} }));
            return;
          }

          if (rpcMethod === "initialize") {
            const clientVersion = body.params?.["_meta"]?.["io.modelcontextprotocol/protocolVersion"] || "2026-07-28";
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Mcp-Session-Id": "sess_independent_98765",
            });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  protocolVersion: clientVersion,
                  capabilities: {
                    tools: { listChanged: true },
                    resources: { subscribe: false },
                    prompts: { listChanged: false },
                  },
                  serverInfo: {
                    name: "independent-mcp-server",
                    version: "1.0.0",
                  },
                },
              })
            );
            return;
          }

          if (rpcMethod === "tools/list") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  tools: [
                    {
                      name: "independent_echo",
                      description: "Echoes input back to client",
                      inputSchema: {
                        type: "object",
                        properties: {
                          message: { type: "string" },
                        },
                        required: ["message"],
                      },
                    },
                    {
                      name: "independent_calc",
                      description: "Simple calculator",
                      inputSchema: {
                        type: "object",
                        properties: {
                          a: { type: "number" },
                          b: { type: "number" },
                        },
                        required: ["a", "b"],
                      },
                    },
                  ],
                },
              })
            );
            return;
          }

          if (rpcMethod === "tools/call") {
            const toolName = body.params?.name;
            const args = body.params?.arguments || {};

            if (toolName === "independent_echo") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcId,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: `ECHO: ${args.message || ""}`,
                      },
                    ],
                    isError: false,
                  },
                })
              );
              return;
            }

            if (toolName === "independent_calc") {
              const sum = (Number(args.a) || 0) + (Number(args.b) || 0);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcId,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: String(sum),
                      },
                    ],
                    isError: false,
                  },
                })
              );
              return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                error: { code: -32602, message: `Tool not found: ${toolName}` },
              })
            );
            return;
          }

          if (rpcMethod === "resources/list") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  resources: [
                    {
                      uri: "memory://sample-data.txt",
                      name: "Sample Data",
                      mimeType: "text/plain",
                    },
                  ],
                },
              })
            );
            return;
          }

          if (rpcMethod === "prompts/list") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpcId,
                result: {
                  prompts: [
                    {
                      name: "code_review_prompt",
                      description: "Perform structured code review",
                    },
                  ],
                },
              })
            );
            return;
          }

          // Method not found
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpcId,
              error: { code: -32601, message: `Method not found: ${rpcMethod}` },
            })
          );
        });
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}

describe("Independent MCP Interoperability Smoke", () => {
  let server: IndependentMcpServer;
  let serverUrl: string;

  before(async () => {
    server = new IndependentMcpServer();
    serverUrl = await server.start();
  });

  after(async () => {
    await server.stop();
  });

  test("1. executes full MCP lifecycle: initialize, tools/list, tools/call, resources, prompts", async () => {
    const transport = new StreamableHttpMcpTransport(serverUrl);
    await transport.connect();

    // 1. tools/list via McpTransport
    const tools = await transport.listTools();
    assert.ok(Array.isArray(tools), "Must return tools array");
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0]?.name, "independent_echo");

    // Verify tools/list request was sent with proper routing headers & stateless _meta
    const toolsReq = server.recordedRequests.find((r) => r.body?.method === "tools/list");
    assert.ok(toolsReq, "tools/list request must be received by server");
    assert.strictEqual(toolsReq.headers["mcp-method"], "tools/list");
    assert.strictEqual(
      toolsReq.body.params?.["_meta"]?.["io.modelcontextprotocol/protocolVersion"],
      "2026-07-28"
    );

    // 2. tools/call via McpTransport
    const callResult = await transport.callTool("independent_echo", { message: "Sprint 8B verified" });
    assert.strictEqual(callResult.isError, false);
    assert.strictEqual(callResult.content[0]?.text, "ECHO: Sprint 8B verified");

    // Verify tools/call request routing headers
    const callReq = server.recordedRequests.find((r) => r.body?.method === "tools/call");
    assert.ok(callReq);
    assert.strictEqual(callReq.headers["mcp-method"], "tools/call");
    assert.strictEqual(callReq.headers["mcp-name"], "independent_echo");

    // 3. resources/list direct spec-compatible POST
    const resResponse = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Method": "resources/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req_res_1",
        method: "resources/list",
        params: {},
      }),
    });
    const resData: any = await resResponse.json();
    assert.ok(Array.isArray(resData.result?.resources));
    assert.strictEqual(resData.result.resources[0].uri, "memory://sample-data.txt");

    // 5. prompts/list direct spec-compatible POST
    const promptResponse = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Method": "prompts/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req_prompt_1",
        method: "prompts/list",
        params: {},
      }),
    });
    const promptData: any = await promptResponse.json();
    assert.ok(Array.isArray(promptData.result?.prompts));
    assert.strictEqual(promptData.result.prompts[0].name, "code_review_prompt");

    await transport.close();
  });

  test("2. verifies error handling for unknown tools", async () => {
    const transport = new StreamableHttpMcpTransport(serverUrl);
    await transport.connect();

    await assert.rejects(
      () => transport.callTool("non_existent_tool", {}),
      /Tool not found/
    );

    await transport.close();
  });
});
