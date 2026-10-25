/**
 * Network Security Guard for MCP remote connections.
 *
 * Safeguards against:
 * - SSRF (Server-Side Request Forgery)
 * - DNS rebinding
 * - Unsafe redirects
 * - Private network access
 * - Cloud metadata endpoint access (AWS/GCP/Azure)
 * - Credential leakage across domains
 */

export interface McpUrlValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly url?: URL;
  readonly isLoopback?: boolean;
}

const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.tencentyun.com",
  "100.100.100.200", // Alibaba Cloud metadata
]);

/**
 * Check if an IPv4 address belongs to a private or reserved range.
 */
function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [b0, b1] = parts;
  if (b0 === undefined || b1 === undefined) return false;

  // 0.0.0.0/8
  if (b0 === 0) return true;
  // 10.0.0.0/8
  if (b0 === 10) return true;
  // 127.0.0.0/8 (Loopback - handled separately)
  if (b0 === 127) return false;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.168.0.0/16
  if (b0 === 192 && b1 === 168) return true;
  // 169.254.0.0/16 (Link-local / cloud metadata)
  if (b0 === 169 && b1 === 254) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 224.0.0.0/4 (Multicast)
  if (b0 >= 224 && b0 <= 239) return true;
  // 240.0.0.0/4 (Reserved)
  if (b0 >= 240) return true;

  return false;
}

/**
 * Check if hostname is local loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

export interface McpNetworkGuardOptions {
  readonly allowLocalhost?: boolean;
}

/**
 * Validate an MCP remote URL before connecting.
 */
export function validateMcpEndpoint(
  urlStr: string,
  options: McpNetworkGuardOptions = { allowLocalhost: true }
): McpUrlValidationResult {
  if (typeof urlStr !== "string" || !urlStr.trim()) {
    return { valid: false, error: "MCP endpoint URL must be a non-empty string" };
  }

  let url: URL;
  try {
    url = new URL(urlStr.trim());
  } catch (err: any) {
    return { valid: false, error: `Invalid URL format: ${err.message}` };
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback = isLoopbackHost(hostname);

  // Scheme verification
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      valid: false,
      error: `Unsupported protocol "${url.protocol}". Remote MCP endpoints must use HTTPS (or HTTP for loopback).`,
    };
  }

  // Non-HTTPS requires loopback
  if (url.protocol === "http:") {
    if (!options.allowLocalhost || !isLoopback) {
      return {
        valid: false,
        error: `Insecure HTTP protocol is only permitted for local loopback (localhost, 127.0.0.1, [::1]). Remote endpoints must use HTTPS.`,
      };
    }
  }

  // Cloud metadata block
  if (CLOUD_METADATA_HOSTS.has(hostname) || hostname.endsWith(".metadata.google.internal")) {
    return {
      valid: false,
      error: `SSRF Blocked: Connection to cloud metadata endpoint (${hostname}) is forbidden.`,
    };
  }

  // Check IPv4 private and link-local ranges
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isPrivateOrReservedIpv4(hostname)) {
      return {
        valid: false,
        error: `SSRF Blocked: Connection to private or link-local IP range (${hostname}) is forbidden.`,
      };
    }
  }

  // Check IPv6 link-local and unique local address ranges
  const cleanIpv6 = hostname.replace(/^\[|\]$/g, "");
  if (cleanIpv6.startsWith("fe80:") || cleanIpv6.startsWith("fc00:") || cleanIpv6.startsWith("fd00:")) {
    return {
      valid: false,
      error: `SSRF Blocked: Connection to IPv6 private/link-local address (${hostname}) is forbidden.`,
    };
  }

  return { valid: true, url, isLoopback };
}

/**
 * Validate an HTTP redirect target during request execution.
 */
export function validateRedirect(
  currentUrl: URL,
  redirectLocation: string
): { readonly valid: boolean; readonly error?: string; readonly targetUrl?: URL; readonly shouldStripAuth?: boolean } {
  let targetUrl: URL;
  try {
    targetUrl = new URL(redirectLocation, currentUrl);
  } catch (e: any) {
    return { valid: false, error: `Invalid redirect Location header: ${e.message}` };
  }

  // Cannot redirect from HTTPS to HTTP (downgrade attack)
  if (currentUrl.protocol === "https:" && targetUrl.protocol === "http:") {
    return {
      valid: false,
      error: "Protocol downgrade attack blocked: Redirect from HTTPS to HTTP is forbidden.",
    };
  }

  // Validate target endpoint with same SSRF rules
  const validation = validateMcpEndpoint(targetUrl.href);
  if (!validation.valid) {
    return { valid: false, error: `Unsafe redirect blocked: ${validation.error}` };
  }

  // If initial request was remote HTTPS, redirect cannot point to local loopback (SSRF bounce attack)
  if (!isLoopbackHost(currentUrl.hostname) && validation.isLoopback) {
    return {
      valid: false,
      error: "SSRF bounce attack blocked: Remote server redirected to local loopback.",
    };
  }

  // Strip Authorization on cross-origin redirects
  const isCrossOrigin = currentUrl.origin !== targetUrl.origin;

  return {
    valid: true,
    targetUrl,
    shouldStripAuth: isCrossOrigin,
  };
}
