import { URL } from "node:url";
import * as dns from "node:dns";
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
]);

export const CLOUD_METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "instance-data",
  "metadata.tencentyun.com",
  "metadata",
]);

/**
 * Sprint 9A.1: Do not permit wildcard ports by default.
 * Authorized development origins and ports must be explicitly configured.
 */
export const DEFAULT_ALLOWED_LOCAL_ORIGINS: readonly string[] = Object.freeze([]);

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

  // Wildcard port pattern: only if explicitly specified by user configuration (e.g. http://localhost:*)
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

  return false;
}

/**
 * Synchronous URL check for protocol, hostname, origin allowlist, and direct IP formats.
 */
export function isBrowserUrlPermitted(
  rawUrl: string,
  config: BrowserNetworkPolicyConfig = { allowedOrigins: DEFAULT_ALLOWED_LOCAL_ORIGINS }
): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `Malformed URL: "${rawUrl}"` };
  }

  // Safe empty page allowed for initialization
  if (rawUrl === "about:blank") {
    return { allowed: true };
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

  // 4. IP parsing (detecting hex, octal, dword, or IPv4-mapped IPv6)
  const ipv4Bytes = parseIpv4Bytes(hostname);
  if (ipv4Bytes) {
    const canonicalIp = `${ipv4Bytes[0]}.${ipv4Bytes[1]}.${ipv4Bytes[2]}.${ipv4Bytes[3]}`;
    const check = inspectIpSecurity(canonicalIp, {
      allowLocalhost: true, // evaluated against allowedOrigins below
      allowPrivateNetworks: false,
    });
    if (check.restricted && !check.isLoopback) {
      return {
        allowed: false,
        reason: `Destination IP "${hostname}" (${canonicalIp}) is restricted: ${check.reason}`,
      };
    }
  }

  const ipv6Bytes = parseIpv6Bytes(hostname);
  if (ipv6Bytes) {
    // If IPv4-mapped IPv6 (::ffff:x.x.x.x)
    const isMapped =
      ipv6Bytes.slice(0, 10).every((b) => b === 0) &&
      ipv6Bytes[10] === 0xff &&
      ipv6Bytes[11] === 0xff;
    if (isMapped) {
      const mappedIpv4 = `${ipv6Bytes[12]}.${ipv6Bytes[13]}.${ipv6Bytes[14]}.${ipv6Bytes[15]}`;
      const check = inspectIpSecurity(mappedIpv4, {
        allowLocalhost: true,
        allowPrivateNetworks: false,
      });
      if (check.restricted && !check.isLoopback) {
        return {
          allowed: false,
          reason: `IPv4-mapped IPv6 destination "${hostname}" resolves to restricted private IP "${mappedIpv4}".`,
        };
      }
    }
  }

  // 5. Origin allowlist check
  const allowedOrigins = config.allowedOrigins;
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return {
      allowed: false,
      reason: `No authorized browser origins configured. Navigation to "${url.origin}" is blocked fail-closed.`,
    };
  }

  // Standardize WS origin for matching
  const checkOrigin = isWs
    ? `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`
    : url.origin;

  const isAllowed = allowedOrigins.some((pattern) => matchOrigin(checkOrigin, pattern) || matchOrigin(url.origin, pattern));

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
 * loopback, or metadata addresses are targeted via DNS deception.
 */
export async function verifyHostDnsSafety(
  hostname: string,
  allowedOrigins: readonly string[]
): Promise<{ safe: boolean; reason?: string }> {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isDirectLoopback = lower === "localhost" || lower === "127.0.0.1" || lower === "::1";

  if (isDirectLoopback) {
    // Direct loopback is permitted only if loopback origin was authorized in allowedOrigins
    const hasLoopbackOrigin = allowedOrigins.some((orig) =>
      orig.includes("localhost") || orig.includes("127.0.0.1") || orig.includes("[::1]") || orig === "*"
    );
    if (!hasLoopbackOrigin) {
      return { safe: false, reason: `Loopback destination "${hostname}" is not authorized.` };
    }
    return { safe: true };
  }

  // Reject metadata and link-local destinations
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

  // If already an IP address, inspect IP security directly
  const ipv4 = parseIpv4Bytes(lower);
  if (ipv4) {
    const canonical = `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.${ipv4[3]}`;
    const check = inspectIpSecurity(canonical, {
      allowLocalhost: false,
      allowPrivateNetworks: false,
    });
    if (check.restricted && !check.isLoopback) {
      return {
        safe: false,
        reason: `Destination IP "${hostname}" is restricted: ${check.reason}`,
      };
    }
    return { safe: true };
  }

  if (parseIpv6Bytes(lower)) {
    return { safe: true };
  }

  try {
    const records = await dns.promises.lookup(lower, { all: true });
    for (const record of records) {
      const ip = record.address;
      // Check metadata
      if (CLOUD_METADATA_IPS.has(ip) || ip.startsWith("169.254.")) {
        return {
          safe: false,
          reason: `DNS Rebinding Blocked: Hostname "${hostname}" resolves to link-local/cloud metadata IP "${ip}".`,
        };
      }
      // Check private subnets & loopback rebinding
      const check = inspectIpSecurity(ip, {
        allowLocalhost: false, // DNS hostnames resolving to 127.0.0.1 is classic DNS rebinding!
        allowPrivateNetworks: false,
      });
      if (check.restricted) {
        return {
          safe: false,
          reason: `DNS Rebinding Blocked: Hostname "${hostname}" resolves to restricted IP "${ip}" (${check.reason}).`,
        };
      }
    }
    return { safe: true };
  } catch (err: any) {
    // If DNS resolution fails, fail closed
    return {
      safe: false,
      reason: `DNS resolution failed for destination "${hostname}": ${err?.message || String(err)}`,
    };
  }
}

/**
 * Attaches context-wide request policy covering all pages, popups, and frames.
 */
export async function attachNetworkPolicyToContext(
  context: BrowserContext,
  config: BrowserNetworkPolicyConfig,
  onBlocked?: (failure: BrowserNetworkFailure) => void
): Promise<void> {
  // 1. Intercept all HTTP/HTTPS requests at the BrowserContext level
  await context.route("**/*", async (route: Route, request: Request) => {
    const url = request.url();

    // Check target URL
    const check = isBrowserUrlPermitted(url, config);
    if (!check.allowed) {
      onBlocked?.({
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

    // Check redirect chain
    let redirectReq = request.redirectedFrom ? request.redirectedFrom() : null;
    let redirectCount = 0;
    let redirectBlocked = false;
    const maxRedirects = config.maxRedirects ?? 10;

    while (redirectReq) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        redirectBlocked = true;
        onBlocked?.({
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
        onBlocked?.({
          url: redirectUrl,
          method: redirectReq.method(),
          error: `Redirect chain hop blocked: ${redirectCheck.reason}`,
          timestamp: Date.now(),
        });
        break;
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

  // 2. Intercept WebSocket connections if supported by the Playwright version
  if (typeof context.routeWebSocket === "function") {
    try {
      await context.routeWebSocket("**/*", (ws: any) => {
        const wsUrl = typeof ws.url === "function" ? ws.url() : String(ws);
        const check = isBrowserUrlPermitted(wsUrl, config);
        if (!check.allowed) {
          onBlocked?.({
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
      });
    } catch {
      // routeWebSocket may not be available on all protocols
    }
  }
}

/**
 * Backward compatibility helper: attaches policy to a single Page.
 */
export async function attachNetworkPolicyToPage(
  page: Page,
  config: BrowserNetworkPolicyConfig,
  onBlocked?: (failure: BrowserNetworkFailure) => void
): Promise<void> {
  const context = page.context();
  if (context) {
    await attachNetworkPolicyToContext(context, config, onBlocked);
  }
}
