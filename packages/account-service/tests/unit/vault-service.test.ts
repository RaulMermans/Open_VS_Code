import { test, describe } from "node:test";
import assert from "node:assert";
import { AesGcmVaultService } from "../../src/vault/aes-gcm-vault.js";
import { DisabledVaultService } from "../../src/vault/vault-service.js";

describe("VaultService", () => {
  const masterKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("1. disabled vault throws fail-closed error", async () => {
    const disabled = new DisabledVaultService();
    assert.strictEqual(disabled.isConfigured(), false);

    await assert.rejects(
      () => disabled.encrypt(),
      /Server-side credential vault is disabled/
    );
  });

  test("2. unconfigured AesGcmVault throws fail-closed error without master key", async () => {
    const unconfigured = new AesGcmVaultService();
    assert.strictEqual(unconfigured.isConfigured(), false);

    await assert.rejects(
      () => unconfigured.encrypt("user-1", "mcp_token", "secret123"),
      (err: any) => err.code === "VAULT_NOT_CONFIGURED" || /not configured/.test(err.message)
    );
  });

  test("3. encrypts and decrypts provider secret using AES-256-GCM authenticated encryption", async () => {
    const vault = new AesGcmVaultService(masterKey);
    assert.strictEqual(vault.isConfigured(), true);

    const plaintext = "sk-ant-api-key-live-123456789";
    const ciphertext = await vault.encrypt("user-1", "mcp_secret", plaintext);

    assert.ok(ciphertext.startsWith("v1$aes256gcm$"), "Ciphertext must declare version and algorithm");
    assert.notStrictEqual(ciphertext, plaintext);
    assert.ok(!ciphertext.includes(plaintext), "Plaintext must not appear in ciphertext");

    const decrypted = await vault.decrypt("user-1", "mcp_secret", ciphertext);
    assert.strictEqual(decrypted, plaintext);
  });

  test("4. isolates secrets between different users (HKDF derivation)", async () => {
    const vault = new AesGcmVaultService(masterKey);
    const plaintext = "shared-secret-value";

    const ciphertextUser1 = await vault.encrypt("user-1", "mcp_token", plaintext);

    // Attempting to decrypt User 1's ciphertext as User 2 must fail auth tag check
    await assert.rejects(
      () => vault.decrypt("user-2", "mcp_token", ciphertextUser1),
      /Vault record tampering detected or authentication tag mismatch/
    );
  });

  test("5. rejects tampered ciphertext (authenticated encryption verification)", async () => {
    const vault = new AesGcmVaultService(masterKey);
    const ciphertext = await vault.encrypt("user-1", "mcp_token", "super-secret");

    const parts = ciphertext.split("$");
    // Tamper with the last byte of encrypted data
    const lastByte = parts[5]!.slice(-2);
    const tamperedHex = parts[5]!.slice(0, -2) + (lastByte === "aa" ? "bb" : "aa");
    parts[5] = tamperedHex;
    const tamperedCiphertext = parts.join("$");

    await assert.rejects(
      () => vault.decrypt("user-1", "mcp_token", tamperedCiphertext),
      /Vault record tampering detected or authentication tag mismatch/
    );
  });
});
