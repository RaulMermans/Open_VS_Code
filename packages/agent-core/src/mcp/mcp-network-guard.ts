import * as dns from "node:dns";

/**
 * Network Security Guard for MCP remote connections.
 *
 * Safeguards against:
 * - SSRF (Server-Side Request Forgery)
 * - DNS rebinding at connection time
 * - Unsafe redirects and downgrade attacks
 * - Private network access (RFC 1918, IPv6 ULA, link-local)
 * - IPv4-mapped IPv6 representations
 * - Alternate IP formats (hex, octal, dword)
 * - Cloud metadata endpoint access (AWS/GCP/Azure/Alibaba/Tencent)
 * - Credential leakage across origins
 */

export interface McpUrlValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly url?: URL;
  readonly isLoopback?: boolean;
}

export interface TrustedNetworkPolicy {
  /** Whether local loopback is permitted (localhost, 127.0.0.1, [::1]). Defaults to true for local development. */
  readonly allowLocalhost?: boolean | undefined;
  /** Whether private networks (RFC 1918, IPv6 ULA) are permitted. Defaults to false (strictly blocked). */
  readonly allowPrivateNetworks?: boolean | undefined;
  /** Explicit list of approved private hostnames or IP addresses (e.g. ['mcp.internal.corp', '10.50.0.2']). */
  readonly allowedPrivateHosts?: readonly string[] | undefined;
}

export interface McpNetworkGuardOptions extends TrustedNetworkPolicy {
  readonly customResolver?: ((hostname: string) => Promise<string[]>) | undefined;
}

const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.tencentyun.com",
  "100.100.100.200", // Alibaba Cloud metadata
  "instance-data",
  "metadata",
]);

/**
 * Parse an IPv4 string supporting dotted-decimal, octal, hex, or 32-bit integer representations.
 * Returns [b0, b1, b2, b3] or null if not a valid IPv4.
 */
export function parseIpv4Bytes(ipStr: string): [number, number, number, number] | null {
  const trimmed = ipStr.trim();

  // Single integer / dword representation (e.g., 2130706433 or 0x7f000001)
  if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 0 || num > 0xffffffff) return null;
    return [
      (num >>> 24) & 0xff,
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff,
    ];
  }

  if (/^\d+$/.test(trimmed)) {
    // Only parse as single dword if it has no dots
    const num = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 0 || num > 0xffffffff) return null;
    return [
      (num >>> 24) & 0xff,
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff,
    ];
  }

  // Dotted notation (4 segments)
  const parts = trimmed.split(".");
  if (parts.length !== 4) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    if (!part || !/^[0-9a-fA-FxX]+$/.test(part)) return null;
    let val: number;
    if (part.startsWith("0x") || part.startsWith("0X")) {
      val = parseInt(part, 16);
    } else if (part.startsWith("0") && part.length > 1) {
      val = parseInt(part, 8);
    } else {
      val = parseInt(part, 10);
    }
    if (isNaN(val) || val < 0 || val > 255) return null;
    bytes.push(val);
  }

  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
}

function parseHexWords(s: string): number[] | null {
  if (!s) return [];
  const words = s.split(":");
  const result: number[] = [];
  for (const w of words) {
    if (!w || !/^[0-9a-f]{1,4}$/.test(w)) return null;
    result.push(parseInt(w, 16));
  }
  return result;
}

/**
 * Parse an IPv6 address string into its 16 byte values, resolving compression (::) and IPv4-mapped IPv6.
 */
export function parseIpv6Bytes(ipv6Str: string): number[] | null {
  let clean = ipv6Str.trim().toLowerCase().replace(/^\[|\]$/g, "");
  // Strip scope identifier if present (e.g. fe80::1%eth0)
  const scopeIdx = clean.indexOf("%");
  if (scopeIdx !== -1) {
    clean = clean.slice(0, scopeIdx);
  }

  // Check for IPv4-mapped IPv6 (e.g. ::ffff:192.168.1.1 or ::ffff:7f00:1)
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const trailingPart = clean.slice(lastColon + 1);
    if (trailingPart.includes(".")) {
      const v4Bytes = parseIpv4Bytes(trailingPart);
      if (!v4Bytes) return null;
      const prefix = clean.slice(0, lastColon);
      const prefixWithHex = `${prefix}:${((v4Bytes[0] << 8) | v4Bytes[1]).toString(16)}:${((v4Bytes[2] << 8) | v4Bytes[3]).toString(16)}`;
      return parseIpv6Bytes(prefixWithHex);
    }
  }

  // Split on double colon
  const doubleColonParts = clean.split("::");
  if (doubleColonParts.length > 2) return null; // Only one :: allowed

  let words: number[];
  if (doubleColonParts.length === 2) {
    const head = parseHexWords(doubleColonParts[0]!);
    const tail = parseHexWords(doubleColonParts[1]!);
    if (!head || !tail) return null;
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) return null;
    words = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
  } else {
    const parsed = parseHexWords(clean);
    if (!parsed || parsed.length !== 8) return null;
    words = parsed;
  }

  const bytes: number[] = [];
  for (const w of words) {
    bytes.push((w >> 8) & 0xff);
    bytes.push(w & 0xff);
  }
  return bytes;
}

export interface IpCheckResult {
  readonly isIp: boolean;
  readonly restricted: boolean;
  readonly isLoopback: boolean;
  readonly isPrivate: boolean;
  readonly isCloudMetadata: boolean;
  readonly reason?: string | undefined;
  readonly normalizedIp?: string | undefined;
}

/**
 * Inspect an IP string (IPv4 or IPv6 in any valid encoding) and evaluate its security restrictions.
 */
export function inspectIpSecurity(
  rawIp: string,
  policy: TrustedNetworkPolicy = {}
): IpCheckResult {
  const allowLocalhost = policy.allowLocalhost ?? true;
  const allowPrivate = policy.allowPrivateNetworks ?? false;
  const allowedHosts = new Set(policy.allowedPrivateHosts?.map((h) => h.toLowerCase()) ?? []);

  // Check IPv4
  const v4Bytes = parseIpv4Bytes(rawIp);
  if (v4Bytes) {
    const [b0, b1, b2, b3] = v4Bytes;
    const normalized = `${b0}.${b1}.${b2}.${b3}`;

    // Cloud metadata: 169.254.169.254, 100.100.100.200
    if ((b0 === 169 && b1 === 254 && b2 === 169 && b3 === 254) || (b0 === 100 && b1 === 100 && b2 === 100 && b3 === 200)) {
      return {
        isIp: true,
        restricted: true,
        isLoopback: false,
        isPrivate: true,
        isCloudMetadata: true,
        reason: `SSRF Blocked: Connection to cloud metadata IP (${normalized}) is forbidden.`,
        normalizedIp: normalized,
      };
    }

    // Loopback: 127.0.0.0/8
    if (b0 === 127) {
      if (!allowLocalhost) {
        return {
          isIp: true,
          restricted: true,
          isLoopback: true,
          isPrivate: false,
          isCloudMetadata: false,
          reason: `SSRF Blocked: Connection to local loopback (${normalized}) is not permitted.`,
          normalizedIp: normalized,
        };
      }
      return {
        isIp: true,
        restricted: false,
        isLoopback: true,
        isPrivate: false,
        isCloudMetadata: false,
        normalizedIp: normalized,
      };
    }

    // Private RFC 1918 & reserved ranges
    let isPrivate = false;
    let rangeDesc = "";

    // 0.0.0.0/8 (Broadcast/This network)
    if (b0 === 0) {
      isPrivate = true;
      rangeDesc = "0.0.0.0/8 (unspecified network)";
    }
    // 10.0.0.0/8
    else if (b0 === 10) {
      isPrivate = true;
      rangeDesc = "10.0.0.0/8 (RFC 1918 private subnet)";
    }
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    else if (b0 === 172 && b1 >= 16 && b1 <= 31) {
      isPrivate = true;
      rangeDesc = "172.16.0.0/12 (RFC 1918 private subnet)";
    }
    // 192.168.0.0/16
    else if (b0 === 192 && b1 === 168) {
      isPrivate = true;
      rangeDesc = "192.168.0.0/16 (RFC 1918 private subnet)";
    }
    // 169.254.0.0/16 (Link-local)
    else if (b0 === 169 && b1 === 254) {
      isPrivate = true;
      rangeDesc = "169.254.0.0/16 (link-local network)";
    }
    // 100.64.0.0/10 (Carrier-grade NAT)
    else if (b0 === 100 && b1 >= 64 && b1 <= 127) {
      isPrivate = true;
      rangeDesc = "100.64.0.0/10 (carrier-grade NAT)";
    }
    // 224.0.0.0/4 (Multicast) or 240.0.0.0/4 (Reserved)
    else if (b0 >= 224) {
      isPrivate = true;
      rangeDesc = `${b0 >= 240 ? "240.0.0.0/4 (reserved)" : "224.0.0.0/4 (multicast)"}`;
    }

    if (isPrivate) {
      // Check if explicitly approved in trusted network policy
      if (allowPrivate && (allowedHosts.has(normalized) || allowedHosts.has(rawIp.toLowerCase()))) {
        return {
          isIp: true,
          restricted: false,
          isLoopback: false,
          isPrivate: true,
          isCloudMetadata: false,
          normalizedIp: normalized,
        };
      }
      return {
        isIp: true,
        restricted: true,
        isLoopback: false,
        isPrivate: true,
        isCloudMetadata: false,
        reason: `SSRF Blocked: Connection to private or link-local IP range ${rangeDesc} (${normalized}) is forbidden.`,
        normalizedIp: normalized,
      };
    }

    return {
      isIp: true,
      restricted: false,
      isLoopback: false,
      isPrivate: false,
      isCloudMetadata: false,
      normalizedIp: normalized,
    };
  }

  // Check IPv6
  const v6Bytes = parseIpv6Bytes(rawIp);
  if (v6Bytes && v6Bytes.length === 16) {
    // Check IPv4-mapped IPv6 (bytes 0..9 === 0, bytes 10..11 === 0xff)
    const isV4Mapped = v6Bytes.slice(0, 10).every((b) => b === 0) && v6Bytes[10] === 0xff && v6Bytes[11] === 0xff;
    if (isV4Mapped) {
      const v4Sub: [number, number, number, number] = [v6Bytes[12]!, v6Bytes[13]!, v6Bytes[14]!, v6Bytes[15]!];
      const checkMapped = inspectIpSecurity(`${v4Sub[0]}.${v4Sub[1]}.${v4Sub[2]}.${v4Sub[3]}`, policy);
      return {
        ...checkMapped,
        reason: checkMapped.reason ? `SSRF Blocked: IPv4-mapped IPv6 (${rawIp}) resolved to: ${checkMapped.reason}` : undefined,
      };
    }

    // Loopback ::1 (bytes 0..14 === 0, byte 15 === 1)
    const isLoopbackV6 = v6Bytes.slice(0, 15).every((b) => b === 0) && v6Bytes[15] === 1;
    if (isLoopbackV6) {
      if (!allowLocalhost) {
        return {
          isIp: true,
          restricted: true,
          isLoopback: true,
          isPrivate: false,
          isCloudMetadata: false,
          reason: `SSRF Blocked: Connection to IPv6 loopback (::1) is not permitted.`,
          normalizedIp: "::1",
        };
      }
      return {
        isIp: true,
        restricted: false,
        isLoopback: true,
        isPrivate: false,
        isCloudMetadata: false,
        normalizedIp: "::1",
      };
    }

    // Unique Local Address fc00::/7 (byte 0 is 0xfc or 0xfd)
    const isUla = (v6Bytes[0]! & 0xfe) === 0xfc;
    // Link-local fe80::/10 (byte 0 is 0xfe, byte 1 & 0xc0 is 0x80)
    const isLinkLocal = v6Bytes[0] === 0xfe && (v6Bytes[1]! & 0xc0) === 0x80;
    // Multicast ff00::/8
    const isMulticast = v6Bytes[0] === 0xff;

    if (isUla || isLinkLocal || isMulticast) {
      const desc = isUla ? "IPv6 unique-local (fc00::/7)" : isLinkLocal ? "IPv6 link-local (fe80::/10)" : "IPv6 multicast (ff00::/8)";
      if (allowPrivate && (allowedHosts.has(rawIp.toLowerCase()) || allowedHosts.has(rawIp.replace(/^\[|\]$/g, "").toLowerCase()))) {
        return {
          isIp: true,
          restricted: false,
          isLoopback: false,
          isPrivate: true,
          isCloudMetadata: false,
          normalizedIp: rawIp,
        };
      }
      return {
        isIp: true,
        restricted: true,
        isLoopback: false,
        isPrivate: true,
        isCloudMetadata: false,
        reason: `SSRF Blocked: Connection to ${desc} (${rawIp}) is forbidden.`,
        normalizedIp: rawIp,
      };
    }

    return {
      isIp: true,
      restricted: false,
      isLoopback: false,
      isPrivate: false,
      isCloudMetadata: false,
      normalizedIp: rawIp,
    };
  }

  return {
    isIp: false,
    restricted: false,
    isLoopback: false,
    isPrivate: false,
    isCloudMetadata: false,
  };
}

/**
 * Check if hostname is local loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  const parsed = inspectIpSecurity(normalized, { allowLocalhost: true });
  return parsed.isIp && parsed.isLoopback;
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
  if (
    CLOUD_METADATA_HOSTS.has(hostname) ||
    hostname.endsWith(".metadata.google.internal") ||
    hostname.endsWith(".internal")
  ) {
    return {
      valid: false,
      error: `SSRF Blocked: Connection to cloud metadata endpoint (${hostname}) is forbidden.`,
    };
  }

  // Inspect hostname if it represents an IP (decimal, hex, octal, dword, IPv6, IPv4-mapped)
  const ipCheck = inspectIpSecurity(hostname, options);
  if (ipCheck.isIp && ipCheck.restricted) {
    return {
      valid: false,
      error: ipCheck.reason ?? `SSRF Blocked: Destination IP (${hostname}) is restricted.`,
    };
  }

  return { valid: true, url, isLoopback };
}

/**
 * Validate an HTTP redirect target during request execution.
 */
export function validateRedirect(
  currentUrl: URL,
  redirectLocation: string,
  policy: TrustedNetworkPolicy = { allowLocalhost: true }
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
  const validation = validateMcpEndpoint(targetUrl.href, policy);
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

/**
 * Create a connection-time lookup function for http.Agent / https.Agent that enforces
 * verified destination IP constraints at socket creation time, preventing DNS rebinding.
 */
export function createSafeLookupFunction(
  policy: TrustedNetworkPolicy = {},
  customResolver?: ((hostname: string) => Promise<string[]>) | undefined
): (
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
) => void {
  return (hostname, options, callback) => {
    // If hostname is loopback
    if (isLoopbackHost(hostname)) {
      if (policy.allowLocalhost === false) {
        const err: any = new Error(`SSRF Blocked: Loopback connection to "${hostname}" is forbidden.`);
        err.code = "ERR_MCP_SECURITY_RESTRICTION";
        return callback(err, null);
      }
      if (options.all) {
        return callback(null, [{ address: "127.0.0.1", family: 4 }]);
      }
      return callback(null, "127.0.0.1", 4);
    }

    // Cloud metadata hostname block
    const lowerHost = hostname.toLowerCase();
    if (
      CLOUD_METADATA_HOSTS.has(lowerHost) ||
      lowerHost.endsWith(".metadata.google.internal") ||
      lowerHost.endsWith(".internal")
    ) {
      const err: any = new Error(`SSRF Blocked: Connection to cloud metadata endpoint (${hostname}) is forbidden.`);
      err.code = "ERR_MCP_SECURITY_RESTRICTION";
      return callback(err, null);
    }

    if (customResolver) {
      customResolver(hostname)
        .then((resolvedIps) => {
          if (!resolvedIps || resolvedIps.length === 0) {
            const err: any = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
            err.code = "ENOTFOUND";
            return callback(err, null);
          }

          for (const ip of resolvedIps) {
            const check = inspectIpSecurity(ip, policy);
            if (check.restricted) {
              const err: any = new Error(check.reason ?? `SSRF Blocked: ${hostname} resolved to restricted IP ${ip}`);
              err.code = "ERR_MCP_SECURITY_RESTRICTION";
              return callback(err, null);
            }
          }

          const primary = resolvedIps[0]!;
          const family = primary.includes(":") ? 6 : 4;
          if (options.all) {
            const results = resolvedIps.map((addr) => ({ address: addr, family: addr.includes(":") ? 6 : 4 }));
            return callback(null, results);
          }
          return callback(null, primary, family);
        })
        .catch((e) => callback(e, null));
      return;
    }

    // Standard DNS resolution with connection-time verification
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, null);
      if (!addresses || addresses.length === 0) {
        const notFound: any = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        notFound.code = "ENOTFOUND";
        return callback(notFound, null);
      }

      for (const addr of addresses) {
        const check = inspectIpSecurity(addr.address, policy);
        if (check.restricted) {
          const secErr: any = new Error(
            check.reason ?? `SSRF Blocked: ${hostname} resolved to restricted IP ${addr.address}`
          );
          secErr.code = "ERR_MCP_SECURITY_RESTRICTION";
          return callback(secErr, null);
        }
      }

      if (options.all) {
        return callback(null, addresses);
      }
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
