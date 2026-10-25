import * as http from "node:http";
import * as https from "node:https";
import { StringDecoder } from "node:string_decoder";
import type { McpToolDeclaration, McpToolCallResult, McpTransport } from "./mcp-transport.ts";
import {
  validateMcpEndpoint,
  validateRedirect,
  createSafeLookupFunction,
  type McpNetworkGuardOptions,
  type TrustedNetworkPolicy,
} from "./mcp-network-guard.ts";
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
  readonly trustedNetworkPolicy?: TrustedNetworkPolicy | undefined;
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
  private sessionId?: string | undefined;
  private activeProtocolVersion: string = PROTOCOL_VERSIONS.V2026_07_28;
  private connected = false;
  private activeRequests = new Set<http.ClientRequest>();

  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;

  constructor(
    endpoint: string,
    private readonly options: StreamableHttpTransportOptions = {}
  ) {
    const policy: TrustedNetworkPolicy = {
      allowLocalhost: options.allowLocalhost ?? true,
      allowPrivateNetworks: options.allowPrivateNetworks ?? options.trustedNetworkPolicy?.allowPrivateNetworks ?? false,
      allowedPrivateHosts: options.allowedPrivateHosts ?? options.trustedNetworkPolicy?.allowedPrivateHosts,
    };

    const validation = validateMcpEndpoint(endpoint, {
      ...policy,
      customResolver: options.customResolver,
    });
    if (!validation.valid || !validation.url) {
      throw new McpSecurityError(validation.error ?? "Invalid MCP endpoint URL");
    }
    this.endpointUrl = validation.url;
    if (options.preferredProtocolVersion) {
      this.activeProtocolVersion = options.preferredProtocolVersion;
    }

    const safeLookup = createSafeLookupFunction(policy, options.customResolver);
    this.httpAgent = new http.Agent({ lookup: safeLookup, keepAlive: false });
    this.httpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: false });
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
        try {
          await this.sendPostRequest(
            "ping",
            {},
            timeoutAbort.signal,
            PROTOCOL_VERSIONS.V2026_07_28
          );
        } catch (err: any) {
          if (err instanceof McpAuthRequiredError || err instanceof McpSecurityError) throw err;
          // Fall back to handshake if ping is unsupported or server expects earlier initialize
          if (err.code === -32601 || err.message?.includes("Method not found") || err.message?.includes("initialize")) {
            await this.performInitializeHandshake(timeoutAbort.signal, PROTOCOL_VERSIONS.V2025_11_25);
          } else {
            // Also try tools/list directly as discovery probe
            try {
              await this.sendPostRequest("tools/list", {}, timeoutAbort.signal, PROTOCOL_VERSIONS.V2026_07_28);
            } catch (probeErr: any) {
              if (probeErr instanceof McpAuthRequiredError || probeErr instanceof McpSecurityError) throw probeErr;
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
        this.activeProtocolVersion,
        name
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
    for (const req of this.activeRequests) {
      try {
        req.destroy(new Error("Transport closed"));
      } catch {}
    }
    this.activeRequests.clear();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private buildParamsWithMeta(
    params: Record<string, unknown>,
    protocolVersion: string
  ): Record<string, unknown> {
    if (protocolVersion !== PROTOCOL_VERSIONS.V2026_07_28) {
      return params;
    }

    return {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSIONS.V2026_07_28,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "open-vs-code",
          version: "0.1.0",
        },
      },
    };
  }

  private async sendPostNotification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    protocolVersion: string = this.activeProtocolVersion,
    toolName?: string
  ): Promise<void> {
    const payload = {
      jsonrpc: "2.0",
      method,
      params: this.buildParamsWithMeta(params, protocolVersion),
    };
    await this.executeHttpRequest(method, payload, signal, protocolVersion, false, toolName);
  }

  private async sendPostRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    protocolVersion: string = this.activeProtocolVersion,
    toolName?: string
  ): Promise<any> {
    const id = this.messageId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: this.buildParamsWithMeta(params, protocolVersion),
    };

    const response = await this.executeHttpRequest(method, payload, signal, protocolVersion, true, toolName);
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
    method: string,
    bodyPayload: unknown,
    callerSignal?: AbortSignal,
    protocolVersion: string = this.activeProtocolVersion,
    expectsResponse = true,
    toolName?: string
  ): Promise<any> {
    if (callerSignal?.aborted) throw new Error("Aborted");

    let currentUrl = new URL(this.endpointUrl.toString());
    let redirectCount = 0;
    const maxRedirects = 5;

    const auth = await resolveMcpAuthHeaders(this.options.authConfig, this.options.secretProvider);
    let authHeader: string | undefined = auth.headers.Authorization;

    const timeoutMs = this.options.requestTimeoutMs ?? 30000;
    const maxBytes = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    const serializedBody = Buffer.from(JSON.stringify(bodyPayload), "utf8");

    while (redirectCount <= maxRedirects) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": method,
        "Content-Length": String(serializedBody.byteLength),
      };

      if (toolName) {
        headers["Mcp-Name"] = toolName;
      }

      if (authHeader) {
        headers["Authorization"] = authHeader;
      }

      // ONLY send Mcp-Session-Id for older session-based protocol versions (2025-11-25)
      // NEVER send Mcp-Session-Id on modern 2026-07-28 stateless protocol
      if (protocolVersion !== PROTOCOL_VERSIONS.V2026_07_28 && this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }

      const response = await this.performSingleHttpExchange(
        currentUrl,
        headers,
        serializedBody,
        callerSignal,
        timeoutMs,
        maxBytes,
        expectsResponse
      );

      // Capture session header if server sends it (older protocols)
      if (response.headers["mcp-session-id"]) {
        const headerVal = response.headers["mcp-session-id"];
        const extracted = Array.isArray(headerVal) ? headerVal[0] : headerVal;
        if (extracted) {
          this.sessionId = extracted;
        }
      }

      // Handle Redirects
      if (response.statusCode >= 300 && response.statusCode < 400) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new McpSecurityError("Maximum redirect depth exceeded");
        }
        const location = response.headers["location"];
        const locationStr = Array.isArray(location) ? location[0] : location;
        if (!locationStr) {
          throw new McpSecurityError("Redirect missing Location header");
        }

        const policy: TrustedNetworkPolicy = {
          allowLocalhost: this.options.allowLocalhost ?? true,
          allowPrivateNetworks: this.options.allowPrivateNetworks ?? this.options.trustedNetworkPolicy?.allowPrivateNetworks ?? false,
          allowedPrivateHosts: this.options.allowedPrivateHosts ?? this.options.trustedNetworkPolicy?.allowedPrivateHosts,
        };

        const redirectValidation = validateRedirect(currentUrl, locationStr, policy);
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
      if (response.statusCode === 401) {
        const wwwAuth = response.headers["www-authenticate"];
        const wwwAuthStr = Array.isArray(wwwAuth) ? wwwAuth.join(", ") : wwwAuth;
        throw new McpAuthRequiredError(
          `Authentication required (HTTP 401): ${wwwAuthStr ?? "Missing or invalid token"}`
        );
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const errText = typeof response.body === "string" ? response.body : "";
        throw new McpProtocolError(
          `MCP server responded with HTTP ${response.statusCode}: ${errText.slice(0, 300)}`
        );
      }

      if (!expectsResponse) {
        return null;
      }

      return response.parsedResult;
    }

    throw new McpSecurityError("Maximum redirect depth exceeded");
  }

  private performSingleHttpExchange(
    targetUrl: URL,
    headers: Record<string, string>,
    body: Buffer,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    maxBytes: number,
    expectsResponse: boolean
  ): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body?: string | undefined;
    parsedResult?: any | undefined;
  }> {
    return new Promise((resolve, reject) => {
      if (callerSignal?.aborted) {
        return reject(new Error("Aborted"));
      }

      const isHttps = targetUrl.protocol === "https:";
      const client = isHttps ? https : http;
      const agent = isHttps ? this.httpsAgent : this.httpAgent;

      const reqOptions: http.RequestOptions = {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: "POST",
        headers,
        agent,
      };

      let timer: NodeJS.Timeout | undefined;
      let onCallerAbort: (() => void) | undefined;

      const req = client.request(reqOptions, (res) => {
        const statusCode = res.statusCode || 200;

        // Redirects don't parse body
        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          cleanup();
          return resolve({ statusCode, headers: res.headers });
        }

        // Error responses: read small error slice safely
        if (statusCode !== 200) {
          let errBody = "";
          let errBytes = 0;
          res.on("data", (chunk: Buffer) => {
            errBytes += chunk.byteLength;
            if (errBytes <= 16384) {
              errBody += chunk.toString("utf8");
            }
          });
          res.on("end", () => {
            cleanup();
            resolve({ statusCode, headers: res.headers, body: errBody });
          });
          res.on("error", (e) => {
            cleanup();
            reject(e);
          });
          return;
        }

        if (!expectsResponse) {
          res.resume();
          cleanup();
          return resolve({ statusCode, headers: res.headers });
        }

        const contentType = String(res.headers["content-type"] || "").toLowerCase();

        if (contentType.includes("text/event-stream")) {
          this.consumeSseStream(res, maxBytes)
            .then((parsedResult) => {
              cleanup();
              resolve({ statusCode, headers: res.headers, parsedResult });
            })
            .catch((err) => {
              cleanup();
              reject(err);
            });
        } else {
          this.consumeJsonStream(res, maxBytes)
            .then((parsedResult) => {
              cleanup();
              resolve({ statusCode, headers: res.headers, parsedResult });
            })
            .catch((err) => {
              cleanup();
              reject(err);
            });
        }
      });

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onCallerAbort && callerSignal) {
          callerSignal.removeEventListener("abort", onCallerAbort);
        }
        this.activeRequests.delete(req);
      };

      this.activeRequests.add(req);

      timer = setTimeout(() => {
        req.destroy(new McpProtocolError(`Timeout waiting for MCP response after ${timeoutMs}ms`));
      }, timeoutMs);

      if (callerSignal) {
        onCallerAbort = () => {
          req.destroy(new Error("Aborted"));
        };
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }

      req.on("error", (err: any) => {
        cleanup();
        if (err?.code === "ERR_MCP_SECURITY_RESTRICTION" || err instanceof McpSecurityError) {
          return reject(new McpSecurityError(err.message));
        }
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  private async consumeJsonStream(res: http.IncomingMessage, maxBytes: number): Promise<any> {
    const clHeader = res.headers["content-length"];
    if (clHeader) {
      const declaredLen = parseInt(String(clHeader), 10);
      if (!isNaN(declaredLen) && declaredLen > maxBytes) {
        res.destroy();
        throw new McpProtocolError(`Response payload exceeded size limit (${declaredLen} > ${maxBytes} bytes)`);
      }
    }

    let totalBytes = 0;
    let accumulated = "";
    const decoder = new StringDecoder("utf8");

    try {
      for await (const chunk of res) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.byteLength;
        if (totalBytes > maxBytes) {
          res.destroy();
          throw new McpProtocolError(`Response payload exceeded size limit (${totalBytes} > ${maxBytes} bytes)`);
        }
        accumulated += decoder.write(buf);
      }
      accumulated += decoder.end();

      try {
        return JSON.parse(accumulated);
      } catch (e: any) {
        throw new McpProtocolError(`Invalid JSON in MCP response: ${e.message}`);
      }
    } finally {
      res.destroy();
    }
  }

  private async consumeSseStream(res: http.IncomingMessage, maxBytes: number): Promise<any> {
    const clHeader = res.headers["content-length"];
    if (clHeader) {
      const declaredLen = parseInt(String(clHeader), 10);
      if (!isNaN(declaredLen) && declaredLen > maxBytes) {
        res.destroy();
        throw new McpProtocolError(`SSE response stream exceeded maximum size limit (${declaredLen} > ${maxBytes} bytes)`);
      }
    }

    let totalBytes = 0;
    let accumulatedText = "";
    let currentEventDataLines: string[] = [];
    let finalResult: any = null;
    const decoder = new StringDecoder("utf8");

    try {
      for await (const chunk of res) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.byteLength;
        if (totalBytes > maxBytes) {
          res.destroy();
          throw new McpProtocolError(`SSE response stream exceeded maximum size limit (${maxBytes} bytes)`);
        }
        accumulatedText += decoder.write(buf);

        const lines = accumulatedText.split("\n");
        // Keep remainder for next chunk
        accumulatedText = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          // Blank line: dispatch current accumulated SSE event
          if (line === "") {
            if (currentEventDataLines.length > 0) {
              const joined = currentEventDataLines.join("\n");
              try {
                const parsed = JSON.parse(joined);
                if (parsed.result !== undefined || parsed.error !== undefined) {
                  finalResult = parsed;
                }
              } catch {
                // Ignore non-JSON notifications or ping comments
              }
              currentEventDataLines = [];
            }
            continue;
          }

          if (line.startsWith(":")) {
            // Comment line
            continue;
          }

          if (line.startsWith("data:")) {
            let dataVal = line.slice(5);
            if (dataVal.startsWith(" ")) {
              dataVal = dataVal.slice(1);
            }
            currentEventDataLines.push(dataVal);
          }
        }
      }

      accumulatedText += decoder.end();
      if (accumulatedText.length > 0) {
        const line = accumulatedText.endsWith("\r") ? accumulatedText.slice(0, -1) : accumulatedText;
        if (line.startsWith("data:")) {
          let dataVal = line.slice(5);
          if (dataVal.startsWith(" ")) dataVal = dataVal.slice(1);
          currentEventDataLines.push(dataVal);
        }
      }

      if (currentEventDataLines.length > 0 && !finalResult) {
        try {
          const parsed = JSON.parse(currentEventDataLines.join("\n"));
          if (parsed.result !== undefined || parsed.error !== undefined) {
            finalResult = parsed;
          }
        } catch {}
      }
    } finally {
      res.destroy();
    }

    if (!finalResult) {
      throw new McpProtocolError("No JSON-RPC result received in SSE stream");
    }

    return finalResult;
  }
}
