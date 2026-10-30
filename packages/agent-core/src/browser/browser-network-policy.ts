import { URL } from "node:url";
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { BrowserNetworkPolicyConfig, BrowserNetworkFailure } from "./browser-contracts.ts";
import {
  parseIpv4Bytes,
  parseIpv6Bytes,
  inspectIpSecurity,
} from "../mcp/mcp-network-guard.ts";

type BrowserContext = any;
type Page = any;
type Route = any;
type Request = any;

export const CLOUD_METADATA_IPS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

export const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "instance-data",
  "metadata.tencentyun.com",
  "metadata.azure.com",
  "metadata",
]);

/**
 * Sprint 9A.1 / 9A.2: Do not permit wildcard ports or origins by default.
 * Authorized development origins and exact ports must be explicitly configured.
 */
export const DEFAULT_ALLOWED_LOCAL_ORIGINS: readonly string[] = Object.freeze([]);

export type BrowserNetworkBlockKind = "policy_denied" | "dns_failed";

export interface BrowserNetworkDiagnosticEvent {
  readonly kind: BrowserNetworkBlockKind;
  readonly failure: BrowserNetworkFailure;
}

export class BrowserNetworkPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserNetworkPolicyError";
    this.code = code;
  }
}

function matchOrigin(urlOrigin: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*:*") return true;
  if (pattern === urlOrigin) return true;

  // Wildcard port pattern: only if explicitly specified by operator configuration (e.g. http://localhost:*)
  if (pattern.endsWith(":*")) {
    const patternPrefix = pattern.slice(0, -2);
    try {
      const u = new URL(urlOrigin);
      const originPrefix = `${u.protocol}//${u.hostname}`;
      return originPrefix === patternPrefix;
    } catch {
      return false;
    }
  }

  // Canonicalize explicit default ports (e.g. http://host:80 -> http://host, https://host:443 -> https://host)
  try {
    const p = new URL(pattern);
    if ((p.pathname === "/" && !pattern.endsWith("/")) && !p.search && !p.hash && !p.username && !p.password) {
      return p.origin === urlOrigin;
    }
  } catch {
    // Non-URL pattern
  }

  return false;
}

function hasAuthorizedLoopbackOrigin(allowedOrigins: readonly string[]): boolean {
  for (const orig of allowedOrigins) {
    if (orig === "*" || orig === "*:*") return true;
    const candidate = orig.endsWith(":*") ? `${orig.slice(0, -2)}:80` : orig;
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
        return true;
      }
    } catch {
      // Ignore malformed pattern
    }
  }
  return false;
}

function createPinnedLookup(pinnedIp: string): net.LookupFunction {
  const ipFamily = net.isIP(pinnedIp) || (pinnedIp.includes(":") ? 6 : 4);
  return (_hostname: string, options: unknown, callback: (...args: any[]) => void) => {
    const opts = typeof options === "object" && options !== null ? (options as { all?: boolean }) : {};
    if (opts.all) {
      callback(null, [{ address: pinnedIp, family: ipFamily }]);
    } else {
      callback(null, pinnedIp, ipFamily);
    }
  };
}

function parseConnectHostPort(rawTarget: string): { host: string; port: number } | null {
  const trimmed = rawTarget.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket === -1) return null;
    const host = trimmed.slice(1, closeBracket);
    const rest = trimmed.slice(closeBracket + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: trimmed, port: 443 };
  }
  const host = trimmed.slice(0, lastColon);
  const port = Number(trimmed.slice(lastColon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Synchronous URL check for protocol, embedded credentials, hostname, IP ranges, and exact origin allowlist.
 */
export function isBrowserUrlPermitted(
  rawUrl: string,
  config: BrowserNetworkPolicyConfig = { allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS }
): { allowed: boolean; reason?: string } {
  // Safe empty page allowed for browser initialization
  if (rawUrl === "about:blank") {
    return { allowed: true };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Malformed URL: "${rawUrl}"` };
  }

  // 1. Strict protocol checks
  if (url.protocol === "file:") {
    return {
      allowed: false,
      reason: "Forbidden protocol: file:// URLs are strictly prohibited to prevent filesystem exfiltration.",
    };
  }

  if (url.protocol === "data:") {
    return {
      allowed: false,
      reason: "Forbidden protocol: data: URLs are prohibited to prevent uninspected script or payload execution.",
    };
  }

  if (url.protocol === "javascript:" || url.protocol === "vbscript:") {
    return {
      allowed: false,
      reason: `Forbidden protocol: "${url.protocol}" is strictly prohibited.`,
    };
  }

  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  const isWs = url.protocol === "ws:" || url.protocol === "wss:";
  if (!isHttp && !isWs) {
    return {
      allowed: false,
      reason: `Forbidden protocol: "${url.protocol}" is not permitted for browser navigation or networking.`,
    };
  }

  if (isWs && config.blockWebSockets === true) {
    return {
      allowed: false,
      reason: "WebSocket connections are blocked under the effective browser network policy.",
    };
  }

  if (url.username || url.password) {
    return {
      allowed: false,
      reason: "Embedded URL credentials are prohibited by browser network policy.",
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // 2. Cloud metadata endpoint rejection
  if (
    CLOUD_METADATA_IPS.has(hostname) ||
    CLOUD_METADATA_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".metadata.google.internal") ||
    hostname.endsWith(".internal")
  ) {
    return {
      allowed: false,
      reason: `Access to cloud metadata destination "${hostname}" is strictly blocked.`,
    };
  }

  // 3. Link-local check (169.254.0.0/16)
  if (hostname.startsWith("169.254.")) {
    return {
      allowed: false,
      reason: `Access to link-local destination "${hostname}" is strictly blocked.`,
    };
  }

  // 4. Full IPv4 + IPv6 inspection (including hex, octal, dword, ULA, link-local, and IPv4-mapped IPv6)
  if (parseIpv4Bytes(hostname) || parseIpv6Bytes(hostname)) {
    const ipCheck = inspectIpSecurity(hostname, {
      allowLocalhost: true, // evaluated against exact allowedOrigins below
      allowPrivateNetworks: config.blockPrivateSubnets === false,
    });
    if (ipCheck.isCloudMetadata) {
      return {
        allowed: false,
        reason: `Access to cloud metadata destination "${hostname}" is strictly blocked.`,
      };
    }
    if (ipCheck.restricted && !ipCheck.isLoopback) {
      return {
        allowed: false,
        reason: `Destination IP "${hostname}" (${ipCheck.normalizedIp ?? hostname}) is restricted: ${ipCheck.reason}`,
      };
    }
  }

  // 5. Exact origin allowlist check
  const allowedOrigins = config.allowedOrigins;
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return {
      allowed: false,
      reason: `No authorized browser origins configured. Navigation to "${url.origin}" is blocked fail-closed.`,
    };
  }

  // Standardize WS origin for matching against HTTP/HTTPS or WS/WSS allowlist entries
  const checkOrigin = isWs
    ? `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`
    : url.origin;

  const isAllowed = allowedOrigins.some(
    (pattern) => matchOrigin(checkOrigin, pattern) || matchOrigin(url.origin, pattern)
  );

  if (!isAllowed) {
    return {
      allowed: false,
      reason: `Destination origin "${url.origin}" is not authorized under the effective browser network policy.`,
    };
  }

  return { allowed: true };
}

/**
 * Asynchronous DNS verification against DNS rebinding attacks.
 * Resolves hostnames to underlying IP addresses and ensures no unapproved private,
 * loopback, link-local, or cloud metadata addresses are targeted via DNS deception.
 */
export async function verifyHostDnsSafety(
  hostname: string,
  allowedOrigins: readonly string[],
  customResolver?: ((hostname: string) => Promise<string[]>) | undefined
): Promise<{ safe: boolean; reason?: string; addresses?: string[] }> {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackAuthorized = hasAuthorizedLoopbackOrigin(allowedOrigins);

  // Reject metadata and link-local destinations immediately
  if (
    CLOUD_METADATA_IPS.has(lower) ||
    lower.startsWith("169.254.") ||
    CLOUD_METADATA_HOSTNAMES.has(lower) ||
    lower.endsWith(".metadata.google.internal") ||
    lower.endsWith(".internal")
  ) {
    return {
      safe: false,
      reason: `Destination "${hostname}" targets link-local/cloud metadata.`,
    };
  }

  // Direct loopback literals and localhost
  if (lower === "127.0.0.1" || lower === "::1") {
    if (!loopbackAuthorized) {
      return { safe: false, reason: `Loopback destination "${hostname}" is not authorized.` };
    }
    return { safe: true, addresses: [lower] };
  }

  if (lower === "localhost") {
    if (!loopbackAuthorized) {
      return { safe: false, reason: `Loopback destination "${hostname}" is not authorized.` };
    }
    if (customResolver) {
      try {
        const resolved = await customResolver(lower);
        if (!resolved || resolved.length === 0) {
          return { safe: false, reason: `DNS resolution returned no IP records for "${hostname}".` };
        }
        for (const ip of resolved) {
          const check = inspectIpSecurity(ip, {
            allowLocalhost: true,
            allowPrivateNetworks: false,
          });
          if (check.restricted) {
            return {
              safe: false,
              reason: `DNS Rebinding Blocked: Hostname "${hostname}" resolves to restricted IP "${ip}" (${check.reason}).`,
            };
          }
        }
        return { safe: true, addresses: resolved };
      } catch (err: any) {
        return {
          safe: false,
          reason: `DNS resolution failed for destination "${hostname}": ${err?.message || String(err)}`,
        };
      }
    }
    return { safe: true, addresses: ["127.0.0.1"] };
  }

  // Explicit IPv4 or IPv6 literal inspection (no uninspected IPv6 pass-through!)
  if (parseIpv4Bytes(lower) || parseIpv6Bytes(lower)) {
    const ipCheck = inspectIpSecurity(lower, {
      allowLocalhost: loopbackAuthorized,
      allowPrivateNetworks: false,
    });
    if (ipCheck.restricted) {
      return {
        safe: false,
        reason: `Destination IP "${hostname}" is restricted: ${ipCheck.reason}`,
      };
    }
    return { safe: true, addresses: [ipCheck.normalizedIp ?? lower] };
  }

  // Hostname resolution
  try {
    let resolvedIps: string[];
    if (customResolver) {
      resolvedIps = await customResolver(lower);
    } else {
      const records = await dns.promises.lookup(lower, { all: true });
      resolvedIps = records.map((r) => r.address);
    }

    if (!resolvedIps || resolvedIps.length === 0) {
      return {
        safe: false,
        reason: `DNS resolution returned no IP records for destination "${hostname}".`,
      };
    }

    const normalizedResolved: string[] = [];
    for (const ip of resolvedIps) {
      const cleanIp = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
      if (CLOUD_METADATA_IPS.has(cleanIp) || cleanIp.startsWith("169.254.")) {
        return {
          safe: false,
          reason: `DNS Rebinding Blocked: Hostname "${hostname}" resolves to link-local/cloud metadata IP "${ip}".`,
        };
      }
      // Non-loopback DNS hostnames resolving to 127.0.0.0/8 or ::1 is classic DNS rebinding!
      const check = inspectIpSecurity(cleanIp, {
        allowLocalhost: false,
        allowPrivateNetworks: false,
      });
      if (check.restricted || !check.isIp) {
        return {
          safe: false,
          reason: `DNS Rebinding Blocked: Hostname "${hostname}" resolves to restricted IP "${ip}" (${check.reason || "invalid IP record"}).`,
        };
      }
      normalizedResolved.push(check.normalizedIp ?? cleanIp);
    }
    return { safe: true, addresses: normalizedResolved };
  } catch (err: any) {
    // Fail closed on DNS lookup error
    return {
      safe: false,
      reason: `DNS resolution failed for destination "${hostname}": ${err?.message || String(err)}`,
    };
  }
}

/**
 * Attaches context-wide request policy covering all pages, popups, frames, subresources, and WebSockets.
 * Sprint 9A.2 P0: Calls verifyHostDnsSafety() before route.continue() on all requests,
 * redirect hops, and WebSockets; paired with BrowserEgressProxy for socket-level IP pinning.
 */
export async function attachNetworkPolicyToContext(
  context: BrowserContext,
  config: BrowserNetworkPolicyConfig,
  onBlocked?: (failure: BrowserNetworkFailure) => void,
  customResolver?: ((hostname: string) => Promise<string[]>) | undefined,
  onDiagnostic?: ((diag: BrowserNetworkDiagnosticEvent) => void) | undefined
): Promise<void> {
  const effectiveResolver = customResolver || config.customResolver;

  const reportBlock = (kind: BrowserNetworkBlockKind, failure: BrowserNetworkFailure) => {
    onBlocked?.(failure);
    onDiagnostic?.({ kind, failure });
  };

  // 1. Intercept all HTTP/HTTPS requests at the BrowserContext level
  await context.route("**/*", async (route: Route, request: Request) => {
    const url = request.url();

    // Check target URL structure and origin
    const check = isBrowserUrlPermitted(url, config);
    if (!check.allowed) {
      reportBlock("policy_denied", {
        url,
        method: request.method(),
        error: check.reason || "Blocked by browser network policy",
        timestamp: Date.now(),
      });
      try {
        await route.abort("blockedbyclient");
      } catch {
        // Safe abort failure
      }
      return;
    }

    // Sprint 9A.2 P0: Enforce DNS safety before route.continue()
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(url);
    } catch {
      // Handled above unless about:blank
    }

    if (parsedUrl && (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:")) {
      const dnsSafety = await verifyHostDnsSafety(
        parsedUrl.hostname,
        config.allowedOrigins,
        effectiveResolver
      );
      if (!dnsSafety.safe) {
        reportBlock("dns_failed", {
          url,
          method: request.method(),
          error: dnsSafety.reason || "Blocked by host DNS safety policy",
          timestamp: Date.now(),
        });
        try {
          await route.abort("blockedbyclient");
        } catch {
          // Safe abort failure
        }
        return;
      }
    }

    // Check redirect chain
    let redirectReq = request.redirectedFrom ? request.redirectedFrom() : null;
    let redirectCount = 0;
    let redirectBlocked = false;
    const maxRedirects = config.maxRedirects ?? 10;

    while (redirectReq) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        redirectBlocked = true;
        reportBlock("policy_denied", {
          url,
          method: request.method(),
          error: `Redirect chain exceeded limit of ${maxRedirects} hops`,
          timestamp: Date.now(),
        });
        break;
      }
      const redirectUrl = redirectReq.url();
      const redirectCheck = isBrowserUrlPermitted(redirectUrl, config);
      if (!redirectCheck.allowed) {
        redirectBlocked = true;
        reportBlock("policy_denied", {
          url: redirectUrl,
          method: redirectReq.method(),
          error: `Redirect chain hop blocked: ${redirectCheck.reason}`,
          timestamp: Date.now(),
        });
        break;
      }

      let redirectParsed: URL | undefined;
      try {
        redirectParsed = new URL(redirectUrl);
      } catch {
        // Safe parse
      }

      if (redirectParsed && (redirectParsed.protocol === "http:" || redirectParsed.protocol === "https:")) {
        const redirectDns = await verifyHostDnsSafety(
          redirectParsed.hostname,
          config.allowedOrigins,
          effectiveResolver
        );
        if (!redirectDns.safe) {
          redirectBlocked = true;
          reportBlock("dns_failed", {
            url: redirectUrl,
            method: redirectReq.method(),
            error: `Redirect hop DNS safety blocked: ${redirectDns.reason}`,
            timestamp: Date.now(),
          });
          break;
        }
      }

      redirectReq = redirectReq.redirectedFrom ? redirectReq.redirectedFrom() : null;
    }

    if (redirectBlocked) {
      try {
        await route.abort("blockedbyclient");
      } catch {
        // Safe abort failure
      }
      return;
    }

    try {
      await route.continue();
    } catch {
      // Safe continue failure
    }
  });

  // 2. Intercept WebSocket connections at the BrowserContext level
  if (typeof context.routeWebSocket === "function") {
    try {
      await context.routeWebSocket("**/*", async (ws: any) => {
        const wsUrl = typeof ws.url === "function" ? ws.url() : String(ws);
        const check = isBrowserUrlPermitted(wsUrl, config);
        if (!check.allowed) {
          reportBlock("policy_denied", {
            url: wsUrl,
            method: "WEBSOCKET",
            error: check.reason || "WebSocket connection blocked by browser network policy",
            timestamp: Date.now(),
          });
          try {
            ws.close({ code: 1008, reason: "Blocked by browser network policy" });
          } catch {
            // Safe close ignore
          }
          return;
        }

        let parsedWs: URL | undefined;
        try {
          parsedWs = new URL(wsUrl);
        } catch {
          // Safe parse
        }

        if (parsedWs) {
          const wsDns = await verifyHostDnsSafety(
            parsedWs.hostname,
            config.allowedOrigins,
            effectiveResolver
          );
          if (!wsDns.safe) {
            reportBlock("dns_failed", {
              url: wsUrl,
              method: "WEBSOCKET",
              error: wsDns.reason || "WebSocket connection blocked by DNS safety policy",
              timestamp: Date.now(),
            });
            try {
              ws.close({ code: 1008, reason: "Blocked by browser DNS safety policy" });
            } catch {
              // Safe close ignore
            }
            return;
          }
        }

        if (typeof ws.connectToServer === "function") {
          try {
            ws.connectToServer();
          } catch {
            // Safe connect ignore if unhandled
          }
        }
      });
    } catch {
      // Egress proxy still enforces socket-level WebSocket / CONNECT restrictions if routeWebSocket is unavailable
    }
  }
}

/**
 * Backward compatibility helper: attaches policy to a single Page's BrowserContext.
 */
export async function attachNetworkPolicyToPage(
  page: Page,
  config: BrowserNetworkPolicyConfig,
  onBlocked?: (failure: BrowserNetworkFailure) => void,
  customResolver?: ((hostname: string) => Promise<string[]>) | undefined
): Promise<void> {
  const context = page.context();
  if (context) {
    await attachNetworkPolicyToContext(context, config, onBlocked, customResolver);
  }
}

export interface BrowserEgressProxyOptions {
  readonly policy: BrowserNetworkPolicyConfig;
  readonly onBlocked?: ((failure: BrowserNetworkFailure) => void) | undefined;
  readonly onDiagnostic?: ((diag: BrowserNetworkDiagnosticEvent) => void) | undefined;
  readonly customResolver?: ((hostname: string) => Promise<string[]>) | undefined;
}

/**
 * Sandboxed local egress proxy that binds actual outbound browser sockets
 * to verified IP destinations, eliminating validation-to-connect DNS rebinding TOCTOU gaps.
 */
export class BrowserEgressProxy {
  readonly #policy: BrowserNetworkPolicyConfig;
  readonly #onBlocked?: ((failure: BrowserNetworkFailure) => void) | undefined;
  readonly #onDiagnostic?: ((diag: BrowserNetworkDiagnosticEvent) => void) | undefined;
  readonly #customResolver?: ((hostname: string) => Promise<string[]>) | undefined;
  readonly #sockets = new Set<import("node:stream").Duplex>();
  #server?: http.Server | undefined;
  #port?: number | undefined;

  constructor(options: BrowserEgressProxyOptions) {
    this.#policy = options.policy;
    this.#onBlocked = options.onBlocked;
    this.#onDiagnostic = options.onDiagnostic;
    this.#customResolver = options.customResolver ?? options.policy.customResolver;
  }

  #trackSocket(sock: import("node:stream").Duplex): void {
    this.#sockets.add(sock);
    sock.on("close", () => {
      this.#sockets.delete(sock);
    });
  }

  public get port(): number | undefined {
    return this.#port;
  }

  public get serverUrl(): string {
    if (!this.#port) {
      throw new BrowserNetworkPolicyError("PROXY_NOT_RUNNING", "Browser egress proxy is not running.");
    }
    return `http://127.0.0.1:${this.#port}`;
  }

  #report(kind: BrowserNetworkBlockKind, failure: BrowserNetworkFailure): void {
    this.#onBlocked?.(failure);
    this.#onDiagnostic?.({ kind, failure });
  }

  public async start(): Promise<void> {
    if (this.#server) return;

    this.#server = http.createServer(async (req, res) => {
      const rawUrl = req.url || "/";
      let targetUrl: string;
      if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
        targetUrl = rawUrl;
      } else {
        const hostHeader = req.headers.host || "";
        if (!hostHeader) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("400 Bad Request: Missing Host header\n");
          return;
        }
        targetUrl = `http://${hostHeader}${rawUrl}`;
      }

      const check = isBrowserUrlPermitted(targetUrl, this.#policy);
      if (!check.allowed) {
        this.#report("policy_denied", {
          url: targetUrl,
          method: req.method || "GET",
          error: check.reason || "Blocked by egress proxy policy",
          timestamp: Date.now(),
        });
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("403 Forbidden: Blocked by browser egress network policy\n");
        return;
      }

      let u: URL;
      try {
        u = new URL(targetUrl);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("400 Bad Request: Malformed destination URL\n");
        return;
      }

      const dnsCheck = await verifyHostDnsSafety(
        u.hostname,
        this.#policy.allowedOrigins,
        this.#customResolver
      );
      if (!dnsCheck.safe) {
        this.#report("dns_failed", {
          url: targetUrl,
          method: req.method || "GET",
          error: dnsCheck.reason || "DNS safety policy violation",
          timestamp: Date.now(),
        });
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end(`403 Forbidden: ${dnsCheck.reason}\n`);
        return;
      }

      const forwardHeaders = { ...req.headers };
      delete forwardHeaders["proxy-connection"];
      delete forwardHeaders["proxy-authorization"];
      forwardHeaders["host"] = u.host;

      const pinnedIp = dnsCheck.addresses?.[0] ?? u.hostname.replace(/^\[|\]$/g, "");
      const isHttps = u.protocol === "https:";
      const targetPort = u.port ? Number(u.port) : isHttps ? 443 : 80;
      const pinnedLookup = createPinnedLookup(pinnedIp);

      const requestFn = isHttps ? https.request : http.request;
      const forwardReq = requestFn(
        {
          host: isHttps ? u.hostname.replace(/^\[|\]$/g, "") : pinnedIp,
          ...(isHttps ? { servername: u.hostname.replace(/^\[|\]$/g, "") } : {}),
          port: targetPort,
          path: `${u.pathname}${u.search}`,
          method: req.method,
          headers: forwardHeaders,
          lookup: pinnedLookup,
        },
        (forwardRes) => {
          res.writeHead(forwardRes.statusCode || 200, forwardRes.headers);
          forwardRes.pipe(res);
        }
      );

      forwardReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`502 Bad Gateway: ${err.message}\n`);
        } else {
          res.destroy();
        }
      });

      res.on("close", () => {
        if (!res.writableEnded) {
          forwardReq.destroy();
        }
      });

      if (req.readableEnded) {
        forwardReq.end();
      } else {
        req.pipe(forwardReq);
      }
    });

    this.#server.on("connection", (sock) => {
      this.#trackSocket(sock);
    });

    // Handle direct HTTP Upgrade (e.g., ws:// WebSocket upgrade over HTTP proxy)
    this.#server.on("upgrade", async (req, clientSocket, head) => {
      const rawUrl = req.url || "/";
      let wsUrl: string;
      if (rawUrl.startsWith("ws://") || rawUrl.startsWith("wss://")) {
        wsUrl = rawUrl;
      } else if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
        wsUrl = rawUrl.replace(/^http/, "ws");
      } else {
        const hostHeader = req.headers.host || "";
        if (!hostHeader) {
          clientSocket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          clientSocket.destroy();
          return;
        }
        wsUrl = `ws://${hostHeader}${rawUrl}`;
      }

      const check = isBrowserUrlPermitted(wsUrl, this.#policy);
      if (!check.allowed) {
        this.#report("policy_denied", {
          url: wsUrl,
          method: "WEBSOCKET_UPGRADE",
          error: check.reason || "WebSocket upgrade blocked by egress proxy policy",
          timestamp: Date.now(),
        });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      let u: URL;
      try {
        u = new URL(wsUrl);
      } catch {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const dnsCheck = await verifyHostDnsSafety(
        u.hostname,
        this.#policy.allowedOrigins,
        this.#customResolver
      );
      if (!dnsCheck.safe) {
        this.#report("dns_failed", {
          url: wsUrl,
          method: "WEBSOCKET_UPGRADE",
          error: dnsCheck.reason || "WebSocket DNS safety policy violation",
          timestamp: Date.now(),
        });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const pinnedIp = dnsCheck.addresses?.[0] ?? u.hostname.replace(/^\[|\]$/g, "");
      const targetPort = u.port ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;
      this.#trackSocket(clientSocket);
      const upstream = net.connect(
        {
          host: pinnedIp,
          port: targetPort,
          lookup: createPinnedLookup(pinnedIp),
        },
        () => {
          const reqLines = [`${req.method || "GET"} ${u.pathname}${u.search} HTTP/${req.httpVersion || "1.1"}`];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i];
            const v = req.rawHeaders[i + 1];
            if (!k || v === undefined) continue;
            if (k.toLowerCase().startsWith("proxy-")) continue;
            reqLines.push(`${k}: ${v}`);
          }
          reqLines.push("", "");
          upstream.write(reqLines.join("\r\n"));
          if (head && head.length > 0) {
            upstream.write(head);
          }
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        }
      );
      this.#trackSocket(upstream);

      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });

    // Handle HTTPS and WebSocket CONNECT tunnels
    this.#server.on("connect", async (req, clientSocket, head) => {
      const parsedDest = parseConnectHostPort(req.url || "");
      if (!parsedDest) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const { host: destHost, port: destPort } = parsedDest;
      const hostForUrl = destHost.includes(":") ? `[${destHost}]` : destHost;
      const httpsCandidate = `https://${hostForUrl}:${destPort}`;
      const wsCandidate = `ws://${hostForUrl}:${destPort}`;

      const httpsCheck = isBrowserUrlPermitted(httpsCandidate, this.#policy);
      const wsCheck =
        this.#policy.blockWebSockets === true
          ? { allowed: false, reason: "WebSocket connections are blocked." }
          : isBrowserUrlPermitted(wsCandidate, this.#policy);

      if (!httpsCheck.allowed && !wsCheck.allowed) {
        this.#report("policy_denied", {
          url: httpsCandidate,
          method: "CONNECT",
          error: httpsCheck.reason || wsCheck.reason || "Blocked by egress proxy policy",
          timestamp: Date.now(),
        });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const dnsCheck = await verifyHostDnsSafety(
        destHost,
        this.#policy.allowedOrigins,
        this.#customResolver
      );
      if (!dnsCheck.safe) {
        this.#report("dns_failed", {
          url: httpsCandidate,
          method: "CONNECT",
          error: dnsCheck.reason || "DNS safety policy violation",
          timestamp: Date.now(),
        });
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      // Pin the outbound socket strictly to the verified IP (zero second DNS lookup).
      const pinnedIp = dnsCheck.addresses?.[0] ?? destHost;
      this.#trackSocket(clientSocket);
      const serverSocket = net.connect(
        {
          host: pinnedIp,
          port: destPort,
          lookup: createPinnedLookup(pinnedIp),
        },
        () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length > 0) {
            serverSocket.write(head);
          }
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        }
      );
      this.#trackSocket(serverSocket);

      serverSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => serverSocket.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      this.#server!.listen(0, "127.0.0.1", () => {
        const addr = this.#server!.address() as any;
        this.#port = addr.port;
        resolve();
      });
      this.#server!.on("error", reject);
    });
  }

  public async stop(): Promise<void> {
    if (this.#server) {
      if (typeof (this.#server as any).closeAllConnections === "function") {
        (this.#server as any).closeAllConnections();
      }
      for (const sock of this.#sockets) {
        try {
          sock.destroy();
        } catch {
          // Ignore socket destruction errors
        }
      }
      this.#sockets.clear();
      await new Promise<void>((resolve) => {
        this.#server!.close(() => resolve());
      });
      this.#server = undefined;
      this.#port = undefined;
    }
  }
}
