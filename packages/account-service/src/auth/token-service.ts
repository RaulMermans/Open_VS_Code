import * as crypto from "node:crypto";

export const TOKEN_PREFIX = "ovsc_sess_";

export class TokenService {
  /**
   * Generates a high-entropy cryptographically random session token.
   * Format: ovsc_sess_<64 hex characters>
   */
  generateSessionToken(): string {
    const randomHex = crypto.randomBytes(32).toString("hex");
    return `${TOKEN_PREFIX}${randomHex}`;
  }

  /**
   * Computes a SHA-256 verifier hash of the session token.
   * Only the verifier is stored in the database; raw tokens are never persisted.
   */
  hashToken(token: string): string {
    if (!token || typeof token !== "string") {
      throw new Error("Token must be a non-empty string.");
    }
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Validates whether a token string adheres to the standard prefix and length.
   */
  isValidTokenFormat(token: string): boolean {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
      return false;
    }
    const hexPart = token.slice(TOKEN_PREFIX.length);
    return hexPart.length === 64 && /^[0-9a-f]{64}$/i.test(hexPart);
  }
}
