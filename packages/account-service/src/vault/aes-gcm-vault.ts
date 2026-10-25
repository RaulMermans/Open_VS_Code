import * as crypto from "node:crypto";
import type { VaultService } from "../types.js";
import { SecurityViolationError, VaultNotConfiguredError } from "../errors.js";

export class AesGcmVaultService implements VaultService {
  private readonly masterKeyBuffer?: Buffer;

  constructor(masterKey?: string | Buffer) {
    if (masterKey) {
      if (typeof masterKey === "string") {
        if (/^[0-9a-f]{64}$/i.test(masterKey)) {
          this.masterKeyBuffer = Buffer.from(masterKey, "hex");
        } else {
          // Hash any string passphrase to 32 bytes using SHA-256
          this.masterKeyBuffer = crypto.createHash("sha256").update(masterKey).digest();
        }
      } else {
        this.masterKeyBuffer = masterKey;
      }
    } else if (process.env.OPEN_VS_CODE_VAULT_KEY) {
      const envKey = process.env.OPEN_VS_CODE_VAULT_KEY.trim();
      if (/^[0-9a-f]{64}$/i.test(envKey)) {
        this.masterKeyBuffer = Buffer.from(envKey, "hex");
      } else {
        this.masterKeyBuffer = crypto.createHash("sha256").update(envKey).digest();
      }
    }
  }

  isConfigured(): boolean {
    return !!this.masterKeyBuffer && this.masterKeyBuffer.length >= 32;
  }

  private deriveKey(ownerUserId: string, secretName: string, salt: Buffer): Buffer {
    if (!this.masterKeyBuffer) {
      throw new VaultNotConfiguredError();
    }
    const info = Buffer.from(`ovsc_vault:${ownerUserId}:${secretName}`, "utf8");
    const derived = crypto.hkdfSync("sha256", this.masterKeyBuffer, salt, info, 32);
    return Buffer.from(derived);
  }

  async encrypt(ownerUserId: string, secretName: string, plaintext: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new VaultNotConfiguredError();
    }
    if (!ownerUserId || !secretName || typeof plaintext !== "string") {
      throw new Error("Invalid parameters for vault encryption.");
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const derivedKey = this.deriveKey(ownerUserId, secretName, salt);

    const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `v1$aes256gcm$${salt.toString("hex")}$${iv.toString("hex")}$${authTag.toString("hex")}$${encrypted.toString("hex")}`;
  }

  async decrypt(ownerUserId: string, secretName: string, ciphertext: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new VaultNotConfiguredError();
    }
    if (!ciphertext || typeof ciphertext !== "string") {
      throw new Error("Ciphertext must be a non-empty string.");
    }

    const parts = ciphertext.split("$");
    if (parts.length !== 6 || parts[0] !== "v1" || parts[1] !== "aes256gcm") {
      throw new SecurityViolationError("Malformed or unsupported vault ciphertext format.");
    }

    const saltHex = parts[2];
    const ivHex = parts[3];
    const authTagHex = parts[4];
    const dataHex = parts[5];

    if (!saltHex || !ivHex || !authTagHex || !dataHex) {
      throw new SecurityViolationError("Missing components in vault ciphertext.");
    }

    try {
      const salt = Buffer.from(saltHex, "hex");
      const iv = Buffer.from(ivHex, "hex");
      const authTag = Buffer.from(authTagHex, "hex");
      const encryptedData = Buffer.from(dataHex, "hex");

      const derivedKey = this.deriveKey(ownerUserId, secretName, salt);
      const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      throw new SecurityViolationError("Vault record tampering detected or authentication tag mismatch.");
    }
  }
}
