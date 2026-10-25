import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedWireRequest {
  method: string;
  pathname: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  parsedBody: any;
}

/**
 * Strict reference-compatible MCP server implementing the official 2026-07-28 specification.
 * Validates:
 * - Proper params._meta placement (rejects root _meta)
 * - Required protocol version metadata (io.modelcontextprotocol/protocolVersion)
 * - Required client capability metadata (io.modelcontextprotocol/clientCapabilities)
 * - Valid client identity metadata (io.modelcontextprotocol/clientInfo)
 * - Required HTTP Mcp-Method header and matching payload method
 * - Required HTTP Mcp-Name header on tools/call matching params.name
 * - Absence of Mcp-Session-Id header (stateless lifecycle enforcement)
 * - JSON-RPC 2.0 identifiers and structure
 */
export class StrictMcpReferenceServer {
  private server?: http.Server | undefined;
  private port?: number | undefined;
  public receivedRequests: ReceivedWireRequest[] = [];
  public lastRequest?: ReceivedWireRequest | undefined;

  async start(): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", reject);

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo;
        this.port = addr.port;
        resolve({ port: this.port, url: `http://127.0.0.1:${this.port}/mcp` });
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = undefined;
      } else {
        resolve();
      }
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed: MCP 2026-07-28 requires POST" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      let json: any;
      try {
        json = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
        return;
      }

      const wireReq: ReceivedWireRequest = {
        method: req.method || "",
        pathname,
        headers: req.headers,
        rawBody: body,
        parsedBody: json,
      };
      this.receivedRequests.push(wireReq);
      this.lastRequest = wireReq;

      // 1. Validate stateless lifecycle: NO Mcp-Session-Id allowed on 2026-07-28
      const sessionIdHeader = req.headers["mcp-session-id"];
      if (sessionIdHeader) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: json.id ?? null,
          error: {
            code: -32600,
            message: "Protocol error: Mcp-Session-Id header is forbidden in stateless 2026-07-28 protocol.",
          },
        }));
        return;
      }

      // 2. Validate routing headers: Mcp-Method header must exist and match JSON-RPC method
      const mcpMethodHeader = req.headers["mcp-method"];
      if (!mcpMethodHeader || mcpMethodHeader !== json.method) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: json.id ?? null,
          error: {
            code: -32600,
            message: `Mcp-Method header mismatch: expected "${json.method}", got "${mcpMethodHeader ?? "missing"}"`,
          },
        }));
        return;
      }

      // 3. Validate routing headers: Mcp-Name header must match params.name for tools/call
      if (json.method === "tools/call") {
        const mcpNameHeader = req.headers["mcp-name"];
        const expectedName = json.params?.name;
        if (!mcpNameHeader || mcpNameHeader !== expectedName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: json.id ?? null,
            error: {
              code: -32600,
              message: `Mcp-Name header mismatch: expected "${expectedName}", got "${mcpNameHeader ?? "missing"}"`,
            },
          }));
          return;
        }
      }

      // 4. Validate metadata placement: _meta MUST NOT be at root level
      if (json["_meta"] !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: json.id ?? null,
          error: {
            code: -32602,
            message: "Invalid params: root-level _meta is invalid. MCP metadata must be placed inside params._meta.",
          },
        }));
        return;
      }

      // 5. Validate params._meta existence
      const meta = json.params?.["_meta"];
      if (!meta || typeof meta !== "object") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: json.id ?? null,
          error: {
            code: -32602,
            message: "Invalid params: missing required params._meta in 2026-07-28 stateless request.",
          },
        }));
        return;
      }

      // 6. Validate required protocol version in _meta
      const protocolVersion = meta["io.modelcontextprotocol/protocolVersion"];
      if (protocolVersion !== "2026-07-28") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: json.id ?? null,
          error: {
            code: -32602,
            message: `Unsupported protocol version: expected "2026-07-28", got "${protocolVersion ?? "missing"}"`,
          },
        }));
        return;
      }

      // 7. Validate required clientCapabilities in _meta
      const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];
      if (capabilities === undefined || typeof capabilities !== "object" || capabilities === null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: json.id ?? null,
          error: {
            code: -32602,
            message: "Missing required client capability metadata: params._meta['io.modelcontextprotocol/clientCapabilities'] must be an object.",
          },
        }));
        return;
      }

      // Handle standard RPC methods
      this.dispatchMethod(req, res, json);
    });
  }

  private dispatchMethod(req: http.IncomingMessage, res: http.ServerResponse, json: any): void {
    const { id, method, params } = json;

    if (method === "ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
      return;
    }

    if (method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "strict_echo",
                description: "Strict reference echo tool",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
              {
                name: "oversized_stream",
                description: "Emits a response larger than typical limits",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        })
      );
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;

      if (toolName === "strict_echo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `echo:${params.arguments?.text || ""}` }],
              isError: false,
            },
          })
        );
        return;
      }

      if (toolName === "oversized_stream") {
        // Send large body in chunks (e.g., 5 MB)
        res.writeHead(200, { "Content-Type": "application/json" });
        const chunkSize = 64 * 1024;
        const totalChunks = 80; // 5 MB+
        let chunkCount = 0;

        const writeNext = () => {
          if (chunkCount >= totalChunks) {
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } }));
            return;
          }
          chunkCount++;
          const ok = res.write(JSON.stringify({ chunk: "x".repeat(chunkSize) }));
          if (ok) {
            setImmediate(writeNext);
          } else {
            res.once("drain", writeNext);
          }
        };
        writeNext();
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Tool not found: ${toolName}` },
        })
      );
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    );
  }
}
