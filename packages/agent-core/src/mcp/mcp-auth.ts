import * as crypto from "node:crypto";

/**
 * Secret storage provider abstraction.
 * VS Code Extension host wires this to `vscode.ExtensionContext.secrets`.
 * CLI or tests wire this to an in-memory or environment-backed provider.
 */
export interface SecretProvider {
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export class InMemorySecretProvider implements SecretProvider {
  private secrets = new Map<string, string>();

  async getSecret(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.secrets.delete(key);
  }
}

export type McpAuthType = "none" | "bearer" | "oauth2" | "secret_ref";

export interface McpAuthConfig {
  readonly type: McpAuthType;
  /** Secret key name inside SecretStorage (never the plain token) */
  readonly secretKey?: string | undefined;
  /** Environment variable name fallback */
  readonly tokenEnv?: string | undefined;
  /** OAuth2 client id reference if statically configured */
  readonly clientId?: string | undefined;
  /** OAuth2 authorization server URL override */
  readonly authorizationServer?: string | undefined;
  /** Requested OAuth scopes */
  readonly scopes?: string[] | undefined;
}

export interface McpAuthHeaders {
  readonly headers: Record<string, string>;
  readonly authRequired: boolean;
  readonly reason?: string | undefined;
}

/**
 * Resolve authentication headers for an MCP server.
 */
export async function resolveMcpAuthHeaders(
  authConfig?: McpAuthConfig,
  secretProvider?: SecretProvider
): Promise<McpAuthHeaders> {
  if (!authConfig || authConfig.type === "none") {
    return { headers: {}, authRequired: false };
  }

  if (authConfig.type === "bearer" || authConfig.type === "secret_ref") {
    let token: string | undefined;

    if (authConfig.secretKey && secretProvider) {
      token = await secretProvider.getSecret(authConfig.secretKey);
    }

    if (!token && authConfig.tokenEnv) {
      token = process.env[authConfig.tokenEnv];
    }

    if (!token || !token.trim()) {
      return {
        headers: {},
        authRequired: true,
        reason: `Authentication required: Missing Bearer token in secret "${authConfig.secretKey ?? authConfig.tokenEnv}"`,
      };
    }

    return {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
      },
      authRequired: false,
    };
  }

  if (authConfig.type === "oauth2") {
    let token: string | undefined;
    if (authConfig.secretKey && secretProvider) {
      token = await secretProvider.getSecret(authConfig.secretKey);
    }

    if (!token && authConfig.tokenEnv) {
      token = process.env[authConfig.tokenEnv];
    }

    if (!token || !token.trim()) {
      return {
        headers: {},
        authRequired: true,
        reason: "OAuth 2.1 authorization required. Complete authorization in VS Code.",
      };
    }

    return {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
      },
      authRequired: false,
    };
  }

  return { headers: {}, authRequired: false };
}

/**
 * Generate PKCE code_verifier and code_challenge (RFC 7636 / OAuth 2.1).
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string; method: "S256" } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = hash.toString("base64url");
  return { codeVerifier, codeChallenge, method: "S256" };
}

/**
 * Parse a WWW-Authenticate header.
 */
export function parseWwwAuthenticate(headerValue?: string | null): {
  scheme?: string | undefined;
  realm?: string | undefined;
  error?: string | undefined;
  resourceMetadataUri?: string | undefined;
} {
  if (!headerValue) return {};
  const trimmed = headerValue.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const scheme = spaceIdx > 0 ? trimmed.slice(0, spaceIdx).toLowerCase() : trimmed.toLowerCase();
  const paramsStr = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : "";

  const result: { scheme: string; realm?: string | undefined; error?: string | undefined; resourceMetadataUri?: string | undefined } = { scheme };

  const matches = paramsStr.matchAll(/([a-zA-Z0-9_-]+)="?([^",]+)"?/g);
  for (const match of matches) {
    const key = match[1]?.toLowerCase();
    const val = match[2];
    if (val !== undefined) {
      if (key === "realm") result.realm = val;
      else if (key === "error") result.error = val;
      else if (key === "resource_metadata") result.resourceMetadataUri = val;
    }
  }

  return result;
}

/**
 * Protected Resource Metadata (RFC 9728).
 */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers?: string[];
  readonly scopes_supported?: string[];
  readonly bearer_methods_supported?: string[];
}
