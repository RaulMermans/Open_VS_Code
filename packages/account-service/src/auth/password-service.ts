import * as crypto from "node:crypto";

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEYLEN = 64;

// Static dummy salt for timing equalization against non-existent accounts
const DUMMY_SALT = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

export class PasswordService {
  /**
   * Hashes a password using Scrypt with a secure random salt.
   * Format: scrypt$N=16384,r=8,p=1$<saltHex>$<derivedKeyHex>
   */
  hashPassword(password: string): string {
    if (!password || typeof password !== "string" || password.length < 8) {
      throw new Error("Password must be at least 8 characters long.");
    }
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.scryptSync(password, salt, KEYLEN, {
      N: DEFAULT_N,
      r: DEFAULT_R,
      p: DEFAULT_P,
      maxmem: 64 * 1024 * 1024,
    });
    return `scrypt$N=${DEFAULT_N},r=${DEFAULT_R},p=${DEFAULT_P}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
  }

  /**
   * Verifies a candidate password against the stored hash in constant time.
   */
  verifyPassword(password: string, storedHash: string): boolean {
    if (!password || !storedHash || typeof storedHash !== "string") {
      return false;
    }

    const parts = storedHash.split("$");
    if (parts.length !== 4 || parts[0] !== "scrypt") {
      // Unrecognized hash format (reject plain sha256 or unknown algorithms)
      return false;
    }

    const paramsStr = parts[1];
    const saltHex = parts[2];
    const keyHex = parts[3];

    if (!paramsStr || !saltHex || !keyHex) {
      return false;
    }

    const params = new Map<string, number>();
    for (const item of paramsStr.split(",")) {
      const [k, v] = item.split("=");
      if (k && v) {
        params.set(k.trim(), parseInt(v.trim(), 10));
      }
    }

    const N = params.get("N") ?? DEFAULT_N;
    const r = params.get("r") ?? DEFAULT_R;
    const p = params.get("p") ?? DEFAULT_P;

    try {
      const salt = Buffer.from(saltHex, "hex");
      const expectedKey = Buffer.from(keyHex, "hex");

      const candidateKey = crypto.scryptSync(password, salt, expectedKey.length, {
        N,
        r,
        p,
        maxmem: 64 * 1024 * 1024,
      });

      if (candidateKey.length !== expectedKey.length) {
        return false;
      }

      return crypto.timingSafeEqual(candidateKey, expectedKey);
    } catch {
      return false;
    }
  }

  /**
   * Performs a dummy password verification with identical computational cost
   * to mitigate timing-based username enumeration.
   */
  performDummyVerification(password: string): void {
    try {
      crypto.scryptSync(password || "dummy-pwd", DUMMY_SALT, KEYLEN, {
        N: DEFAULT_N,
        r: DEFAULT_R,
        p: DEFAULT_P,
        maxmem: 64 * 1024 * 1024,
      });
    } catch {
      // Safe dummy ignore
    }
  }
}
