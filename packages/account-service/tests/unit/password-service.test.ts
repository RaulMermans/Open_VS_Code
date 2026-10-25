import { test, describe } from "node:test";
import assert from "node:assert";
import { PasswordService } from "../../src/auth/password-service.js";

describe("PasswordService", () => {
  const service = new PasswordService();

  test("1. hashes password using Scrypt format with salt", () => {
    const password = "correct-horse-battery-staple";
    const hash = service.hashPassword(password);

    assert.ok(hash.startsWith("scrypt$N=16384,r=8,p=1$"), "Must use scrypt format");
    const parts = hash.split("$");
    assert.strictEqual(parts.length, 4, "Must contain algorithm, params, salt, and key");
    assert.strictEqual(parts[2]?.length, 32, "Salt must be 16 bytes (32 hex characters)");
    assert.strictEqual(parts[3]?.length, 128, "Key must be 64 bytes (128 hex characters)");
  });

  test("2. produces different hashes for same password (salted)", () => {
    const password = "SuperSecretPassword123!";
    const hash1 = service.hashPassword(password);
    const hash2 = service.hashPassword(password);

    assert.notStrictEqual(hash1, hash2, "Salts must ensure different hashes");
    assert.strictEqual(service.verifyPassword(password, hash1), true);
    assert.strictEqual(service.verifyPassword(password, hash2), true);
  });

  test("3. verifies valid password successfully", () => {
    const password = "validPassword_2026!";
    const hash = service.hashPassword(password);

    assert.strictEqual(service.verifyPassword(password, hash), true);
  });

  test("4. rejects invalid password", () => {
    const password = "validPassword_2026!";
    const hash = service.hashPassword(password);

    assert.strictEqual(service.verifyPassword("wrongPassword_2026!", hash), false);
    assert.strictEqual(service.verifyPassword("", hash), false);
  });

  test("5. rejects fast plain SHA-256 or MD5 hashes", () => {
    const sha256Hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.strictEqual(service.verifyPassword("test", sha256Hash), false);
  });

  test("6. rejects malformed or truncated hashes safely without throwing", () => {
    assert.strictEqual(service.verifyPassword("test", "scrypt$invalid"), false);
    assert.strictEqual(service.verifyPassword("test", "scrypt$N=16384$abc$def"), false);
    assert.strictEqual(service.verifyPassword("test", ""), false);
  });

  test("7. enforces minimum password length (>= 8 chars)", () => {
    assert.throws(
      () => service.hashPassword("short"),
      /at least 8 characters/
    );
  });

  test("8. performDummyVerification executes scrypt without error for anti-enumeration", () => {
    assert.doesNotThrow(() => {
      service.performDummyVerification("non-existent-user-password");
    });
  });
});
