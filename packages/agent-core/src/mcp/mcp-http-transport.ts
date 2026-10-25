import type { McpToolDeclaration, McpToolCallResult, McpTransport } from "./mcp-transport.ts";
import { validateMcpEndpoint, validateRedirect, type McpNetworkGuardOptions } from "./mcp-network-guard.ts";
import { resolveMcpAuthHeaders, type McpAuthConfig, type SecretProvider } from "./mcp-auth.ts";
import type { McpMetricsTracker } from "./mcp-metrics.ts";

export interface StreamableHttpTransportOptions extends McpNetworkGuardOptions {
  readonly requestTimeoutMs?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly authConfig?: McpAuthConfig | undefined;
  readonly secretProvider?: SecretProvider | undefined;
  readonly preferredProtocolVersion?: string | undefined;
  readonly metrics?: McpMetricsTracker | undefined;
}

export class McpProtocolError extends Error {
  constructor(message: string, public readonly code?: number, public readonly data?: unknown) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

export class McpAuthRequiredError extends Error {
  constructor(message: string, public readonly reason?: string) {
    super(message);
    this.name = "McpAuthRequiredError";
  }
}

export const PROTOCOL_VERSIONS = {
  V2026_07_28: "2026-07-28",
  V2025_11_25: "2025-11-25",
  V2024_11_05: "2024-11-05",
} as const;

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB ceiling for protocol frames

export class StreamableHttpMcpTransport implements McpTransport {
  private endpointUrl: URL;
  private messageId = 1;
  private sessionId?: string;
  private activeProtocolVersion: string = PROTOCOL_VERSIONS.V2026_07_28;
  private connected = false;
  private inFlightAbortControllers = new Set<AbortController>();

  constructor(
    endpoint: string,
    private readonly options: StreamableHttpTransportOptions = {}
  ) {
    const validation = validateMcpEndpoint(endpoint, {
      allowLocalhost: options.allowLocalhost ?? true,
    });
    if (!validation.valid || !validation.url) {
      throw new McpSecurityError(validation.error ?? "Invalid MCP endpoint URL");
    }
    this.endpointUrl = validation.url;
    if (options.preferredProtocolVersion) {
      this.activeProtocolVersion = options.preferredProtocolVersion;
    }
  }

  getNegotiatedProtocolVersion(): string {
    return this.activeProtocolVersion;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Aborted");

    const connectTimeoutMs = this.options.connectTimeoutMs ?? 10000;
    const timeoutAbort = new AbortController();
    const timer = setTimeout(() => timeoutAbort.abort(new Error("Connection timeout")), connectTimeoutMs);

    const onCallerAbort = () => timeoutAbort.abort(new Error("Aborted"));
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      this.options.metrics?.recordConnectionAttempt(this.endpointUrl.hostname, "streamable_http");

      // Check auth headers first
      const auth = await resolveMcpAuthHeaders(this.options.authConfig, this.options.secretProvider);
      if (auth.authRequired) {
        throw new McpAuthRequiredError(auth.reason ?? "Authentication required", auth.reason);
      }

      // Initial probe or handshake
      if (this.activeProtocolVersion === PROTOCOL_VERSIONS.V2026_07_28) {
        // Modern stateless MCP 2026-07-28:
        // Try tools/list probe or ping
        try {
          await this.sendPostRequest(
            "ping",
            {},
            timeoutAbort.signal,
            PROTOCOL_VERSIONS.V2026_07_28
          );
        } catch (err: any) {
          if (err instanceof McpAuthRequiredError) throw err;
          // Fall back to handshake if ping is unsupported or server expects earlier initialize
          if (err.code === -32601 || err.message?.includes("Method not found") || err.message?.includes("initialize")) {
            await this.performInitializeHandshake(timeoutAbort.signal, PROTOCOL_VERSIONS.V2025_11_25);
          } else {
            // Also try tools/list directly as discovery probe
            try {
              await this.sendPostRequest("tools/list", {}, timeoutAbort.signal, PROTOCOL_VERSIONS.V2026_07_28);
            } catch (probeErr: any) {
              if (probeErr instanceof McpAuthRequiredError) throw probeErr;
              // Try earlier handshake version
              await this.performInitializeHandshake(timeoutAbort.signal, PROTOCOL_VERSIONS.V2025_11_25);
            }
          }
        }
      } else {
        // Older versions (2025-11-25 / 2024-11-05) require explicit initialize handshake
        await this.performInitializeHandshake(timeoutAbort.signal, this.activeProtocolVersion);
      }

      this.connected = true;
      this.options.metrics?.recordConnectionSuccess(this.endpointUrl.hostname, this.activeProtocolVersion, 0);
    } catch (err: any) {
      this.connected = false;
      this.options.metrics?.recordConnectionFailure(this.endpointUrl.hostname, err.message);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async performInitializeHandshake(signal: AbortSignal, version: string): Promise<void> {
    const initResult = await this.sendPostRequest(
      "initialize",
      {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "open-vs-code", version: "0.1.0" },
      },
      signal,
      version
    );

    this.activeProtocolVersion = version;

    // Send initialized notification if handshake succeeded
    try {
      await this.sendPostNotification("notifications/initialized", {}, signal, version);
    } catch {
      // Notification failures on older servers are non-fatal
    }

    if (initResult && typeof initResult === "object" && (initResult as any).protocolVersion) {
      this.activeProtocolVersion = String((initResult as any).protocolVersion);
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDeclaration[]> {
    if (!this.connected) {
      await this.connect(signal);
    }

    const startTime = Date.now();
    const result = await this.sendPostRequest(
      "tools/list",
      {},
      signal,
      this.activeProtocolVersion
    );

    const tools = (result && typeof result === "object" && Array.isArray((result as any).tools))
      ? (result as any).tools
      : [];

    this.options.metrics?.recordDiscovery(this.endpointUrl.hostname, tools.length, Date.now() - startTime);
    return tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolCallResult> {
    if (!this.connected) {
      await this.connect(signal);
    }

    this.options.metrics?.recordToolCallStart();

    try {
      const result = await this.sendPostRequest(
        "tools/call",
        { name, arguments: args },
        signal,
        this.activeProtocolVersion
      );

      const content = (result && typeof result === "object" && Array.isArray((result as any).content))
        ? (result as any).content
        : [];
      const isError = !!(result && typeof result === "object" && (result as any).isError);

      return { content, isError };
    } catch (err: any) {
      if (signal?.aborted) {
        this.options.metrics?.recordCancellation();
      } else if (err.message?.includes("Timeout") || err.message?.includes("timeout")) {
        this.options.metrics?.recordTimeout();
      } else {
        this.options.metrics?.recordToolCallFailure();
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    for (const controller of this.inFlightAbortControllers) {
      controller.abort(new Error("Transport closed"));
    }
    this.inFlightAbortControllers.clear();
  }

  private async sendPostNotification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    protocolVersion: string = this.activeProtocolVersion
  ): Promise<void> {
    const payload = {
      jsonrpc: "2.0",
      method,
      params,
      ...(protocolVersion === PROTOCOL_VERSIONS.V2026_07_28
        ? { _meta: { "io.modelcontextprotocol/protocolVersion": protocolVersion } }
        : {}),
    };
    await this.executeHttpRequest(payload, signal, protocolVersion, false);
  }

  private async sendPostRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    protocolVersion: string = this.activeProtocolVersion
  ): Promise<any> {
    const id = this.messageId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
      ...(protocolVersion === PROTOCOL_VERSIONS.V2026_07_28
        ? { _meta: { "io.modelcontextprotocol/protocolVersion": protocolVersion } }
        : {}),
    };

    const response = await this.executeHttpRequest(payload, signal, protocolVersion, true);
    if (!response) {
      throw new McpProtocolError("Empty response received from MCP server");
    }

    if (response.error) {
      throw new McpProtocolError(
        response.error.message || `RPC Error (${response.error.code})`,
        response.error.code,
        response.error.data
      );
    }

    return response.result;
  }

  private async executeHttpRequest(
    bodyPayload: unknown,
    callerSignal?: AbortSignal,
    protocolVersion: string = this.activeProtocolVersion,
    expectsResponse = true
  ): Promise<any> {
    if (callerSignal?.aborted) throw new Error("Aborted");

    const controller = new AbortController();
    this.inFlightAbortControllers.add(controller);

    const onCallerAbort = () => controller.abort(new Error("Aborted"));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const timeoutMs = this.options.requestTimeoutMs ?? 30000;
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Timeout waiting for MCP response after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      let currentUrl = new URL(this.endpointUrl.toString());
      let redirectCount = 0;
      const maxRedirects = 5;

      const auth = await resolveMcpAuthHeaders(this.options.authConfig, this.options.secretProvider);
      let authHeader: string | undefined = auth.headers.Authorization;

      while (redirectCount <= maxRedirects) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "MCP-Protocol-Version": protocolVersion,
        };

        if (authHeader) {
          headers["Authorization"] = authHeader;
        }

        if (this.sessionId) {
          headers["Mcp-Session-Id"] = this.sessionId;
        }

        const res = await fetch(currentUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(bodyPayload),
          signal: controller.signal,
          redirect: "manual",
        });

        // Capture session header if server sends it
        const newSessionId = res.headers.get("mcp-session-id");
        if (newSessionId) {
          this.sessionId = newSessionId;
        }

        // Handle Redirects
        if (res.status >= 300 && res.status < 400) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new McpSecurityError("Too many redirects");
          }
          const location = res.headers.get("location");
          if (!location) {
            throw new McpSecurityError("Redirect missing Location header");
          }
          const redirectValidation = validateRedirect(currentUrl, location);
          if (!redirectValidation.valid || !redirectValidation.targetUrl) {
            throw new McpSecurityError(redirectValidation.error ?? "Invalid redirect target");
          }
          currentUrl = redirectValidation.targetUrl;
          if (redirectValidation.shouldStripAuth) {
            authHeader = undefined;
          }
          continue;
        }

        // Handle Authentication challenges
        if (res.status === 401) {
          const wwwAuth = res.headers.get("www-authenticate");
          throw new McpAuthRequiredError(
            `Authentication required (HTTP 401): ${wwwAuth ?? "Missing or invalid token"}`
          );
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new McpProtocolError(
            `MCP server responded with HTTP ${res.status}: ${errText.slice(0, 300)}`
          );
        }

        if (!expectsResponse) {
          return null;
        }

        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        const maxBytes = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

        if (contentType.includes("text/event-stream")) {
          return await this.parseSseResponseStream(res, controller.signal, maxBytes);
        } else {
          return await this.parseJsonResponse(res, maxBytes);
        }
      }

      throw new McpSecurityError("Maximum redirect depth exceeded");
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.inFlightAbortControllers.delete(controller);
    }
  }

  private async parseJsonResponse(res: Response, maxBytes: number): Promise<any> {
    const rawBuffer = await res.arrayBuffer();
    if (rawBuffer.byteLength > maxBytes) {
      throw new McpProtocolError(`Response payload exceeded size limit (${rawBuffer.byteLength} > ${maxBytes} bytes)`);
    }
    const text = new TextDecoder().decode(rawBuffer);
    try {
      return JSON.parse(text);
    } catch (e: any) {
      throw new McpProtocolError(`Invalid JSON in MCP response: ${e.message}`);
    }
  }

  private async parseSseResponseStream(res: Response, signal: AbortSignal, maxBytes: number): Promise<any> {
    if (!res.body) {
      throw new McpProtocolError("Missing SSE response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let totalBytes = 0;
    let finalResult: any = null;

    try {
      while (true) {
        if (signal.aborted) throw new Error("Aborted");

        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          reader.cancel().catch(() => {});
          throw new McpProtocolError(`SSE response stream exceeded maximum size limit (${maxBytes} bytes)`);
        }

        accumulated += decoder.decode(value, { stream: true });
        const lines = accumulated.split("\n");
        accumulated = lines.pop() ?? "";

        let currentData = "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            if (currentData) {
              try {
                const parsed = JSON.parse(currentData);
                if (parsed.result !== undefined || parsed.error !== undefined) {
                  finalResult = parsed;
                }
              } catch {
                // Ignore intermediate ping/keepalive or unparseable SSE lines
              }
              currentData = "";
            }
            continue;
          }

          if (trimmed.startsWith("data:")) {
            currentData += trimmed.slice(5).trim();
          }
        }
      }

      if (accumulated.trim()) {
        const trimmed = accumulated.trim();
        if (trimmed.startsWith("data:")) {
          try {
            const parsed = JSON.parse(trimmed.slice(5).trim());
            if (parsed.result !== undefined || parsed.error !== undefined) {
              finalResult = parsed;
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!finalResult) {
      throw new McpProtocolError("No JSON-RPC result received in SSE stream");
    }

    return finalResult;
  }
}
