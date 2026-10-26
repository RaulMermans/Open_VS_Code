import { URL } from "node:url";
import type { BrowserNetworkPolicyConfig, BrowserNetworkFailure } from "./browser-contracts.ts";

// Minimal Playwright interfaces to prevent bundling overhead
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
]);

export const DEFAULT_ALLOWED_LOCAL_ORIGINS = Object.freeze([
  "http://localhost:*",
  "http://127.0.0.1:*",
  "http://[::1]:*",
]);

export class BrowserNetworkPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserNetworkPolicyError";
    this.code = code;
  }
}

/**
 * Checks whether an IPv4 address is within standard private address ranges:
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * - 169.254.0.0/16 (link-local)
 * - 0.0.0.0/8
 */
function isPrivateSubnetIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function matchOrigin(urlOrigin: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*:*") return true;
  if (pattern === urlOrigin) return true;

  // Wildcard port pattern: http://localhost:* or http://127.0.0.1:*
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

  // 1. Strict protocol checks
  if (url.protocol === "file:") {
    return {
      allowed: false,
      reason: "Forbidden protocol: file:// URLs are strictly prohibited to prevent filesystem exfiltration.",
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason: `Forbidden protocol: "${url.protocol}" is not permitted for browser navigation.`,
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // 2. Cloud metadata endpoint rejection
  if (CLOUD_METADATA_IPS.has(hostname) || CLOUD_METADATA_HOSTNAMES.has(hostname)) {
    return {
      allowed: false,
      reason: `Access to cloud metadata destination "${hostname}" is strictly blocked.`,
    };
  }

  // Check link-local IP range (169.254.x.x)
  if (hostname.startsWith("169.254.")) {
    return {
      allowed: false,
      reason: `Access to link-local destination "${hostname}" is strictly blocked.`,
    };
  }

  // 3. Origin allowlist check
  const allowedOrigins = config.allowedOrigins.length > 0 ? config.allowedOrigins : DEFAULT_ALLOWED_LOCAL_ORIGINS;
  const isAllowed = allowedOrigins.some((pattern) => matchOrigin(url.origin, pattern));

  if (!isAllowed) {
    return {
      allowed: false,
      reason: `Destination origin "${url.origin}" is not authorized under the effective browser network policy.`,
    };
  }

  // 4. Private network enforcement (if not an explicitly allowed localhost/loopback service)
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (config.blockPrivateSubnets !== false && !isLoopback) {
    if (isPrivateSubnetIp(hostname)) {
      return {
        allowed: false,
        reason: `Destination IP "${hostname}" resides in a blocked private subnet.`,
      };
    }
  }

  return { allowed: true };
}

export async function attachNetworkPolicyToPage(
  page: Page,
  config: BrowserNetworkPolicyConfig,
  onBlocked?: (failure: BrowserNetworkFailure) => void
): Promise<void> {
  await page.route("**/*", async (route: Route, request: Request) => {
    const url = request.url();
    const check = isBrowserUrlPermitted(url, config);
    if (!check.allowed) {
      if (onBlocked) {
        onBlocked({
          url,
          method: request.method(),
          error: check.reason || "Blocked by browser network policy",
          timestamp: Date.now(),
        });
      }
      try {
        await route.abort("blockedbyclient");
      } catch {
        // Safe abort failure if already closed
      }
      return;
    }

    try {
      await route.continue();
    } catch {
      // Safe continue failure if already closed
    }
  });
}
