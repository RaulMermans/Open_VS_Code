import * as http from "node:http";
import type { AddressInfo } from "node:net";

export class HttpMcpFixtureServer {
  private server?: http.Server | undefined;
  private port?: number | undefined;
  public lastRequest?: {
    method: string;
    pathname: string;
    headers: http.IncomingHttpHeaders;
    body: any;
  } | undefined;

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

    // Redirect test routes
    if (pathname === "/redirect/safe") {
      res.writeHead(302, { Location: `http://127.0.0.1:${this.port}/mcp` });
      res.end();
      return;
    }

    if (pathname === "/redirect/ssrf-metadata") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }

    if (pathname === "/redirect/ssrf-private") {
      res.writeHead(302, { Location: "http://10.0.0.1/private" });
      res.end();
      return;
    }

    // RFC 9728 Protected Resource Metadata
    if (pathname === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          resource: `http://127.0.0.1:${this.port}/auth/mcp`,
          authorization_servers: [`http://127.0.0.1:${this.port}/auth-server`],
          scopes_supported: ["read", "write"],
        })
      );
      return;
    }

    // RFC 8414 OAuth Authorization Server Metadata
    if (pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: `http://127.0.0.1:${this.port}/auth-server`,
          authorization_endpoint: `http://127.0.0.1:${this.port}/authorize`,
          token_endpoint: `http://127.0.0.1:${this.port}/token`,
          code_challenge_methods_supported: ["S256"],
        })
      );
      return;
    }

    // Authenticated route
    if (pathname.startsWith("/auth/mcp")) {
      const authHeader = req.headers["authorization"];
      if (authHeader !== "Bearer test-valid-token") {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="http://127.0.0.1:${this.port}/.well-known/oauth-protected-resource"`,
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // Read body for POST requests
    if (req.method === "POST") {
      if (
        pathname !== "/mcp" &&
        !pathname.startsWith("/mcp-") &&
        !pathname.startsWith("/auth/mcp")
      ) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const json = JSON.parse(body);
          this.lastRequest = {
            method: req.method || "",
            pathname,
            headers: req.headers,
            body: json,
          };
          this.handleJsonRpc(req, res, pathname, json);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleJsonRpc(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    msg: any
  ): void {
    const { id, method, params } = msg;

    // Older protocol session check (2025-11-25)
    if (pathname.includes("/mcp-2025")) {
      if (method === "initialize") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "sess-2025-xyz",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "test-2025-server", version: "1.0.0" },
            },
          })
        );
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || sessionId !== "sess-2025-xyz") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Invalid session ID" } }));
        return;
      }
    }

    // Legacy 2024-11-05
    if (pathname.includes("/mcp-2024") && method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "test-2024-server", version: "1.0.0" },
          },
        })
      );
      return;
    }

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
                name: "echo",
                description: "Echo input text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
              {
                name: "stream_progress",
                description: "Emits streaming progress notifications before result",
                inputSchema: { type: "object", properties: { steps: { type: "number" } } },
              },
              {
                name: "slow_tool",
                description: "Hangs or responds late",
                inputSchema: { type: "object", properties: { delayMs: { type: "number" } } },
              },
              {
                name: "oversized_result",
                description: "Returns oversized output exceeding byte budget",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "server_error",
                description: "Returns an error",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "infinite_stream",
                description: "Streams without terminating",
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

      if (toolName === "echo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: params.arguments?.text || "" }],
              isError: false,
            },
          })
        );
        return;
      }

      if (toolName === "stream_progress") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        res.write(`event: notification\ndata: ${JSON.stringify({ method: "progress", params: { step: 1 } })}\n\n`);
        res.write(`event: notification\ndata: ${JSON.stringify({ method: "progress", params: { step: 2 } })}\n\n`);
        res.write(
          `event: response\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "streaming finished" }], isError: false },
          })}\n\n`
        );
        res.end();
        return;
      }

      if (toolName === "infinite_stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders();
        // Send initial large bursts immediately to exceed small budget
        for (let i = 0; i < 20; i++) {
          res.write(`event: chunk\ndata: ${JSON.stringify({ data: "x".repeat(100) })}\n\n`);
        }
        const interval = setInterval(() => {
          if (!res.writableEnded) {
            res.write(`event: chunk\ndata: ${JSON.stringify({ data: "chunk-" + Date.now() })}\n\n`);
          }
        }, 50);

        req.on("close", () => {
          clearInterval(interval);
        });
        return;
      }

      if (toolName === "slow_tool") {
        const delay = params.arguments?.delayMs || 2000;
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "delayed response" }], isError: false },
              })
            );
          }
        }, delay);
        return;
      }

      if (toolName === "oversized_result") {
        const hugeText = "A".repeat(60 * 1024); // 60 KB
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: hugeText }],
              isError: false,
            },
          })
        );
        return;
      }

      if (toolName === "server_error") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32001, message: "Execution error inside tool" },
          })
        );
        return;
      }
    }

    // Default unknown method
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    );
  }
}
