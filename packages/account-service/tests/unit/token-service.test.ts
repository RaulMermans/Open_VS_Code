import { test, describe } from "node:test";
import assert from "node:assert";
import { TokenService, TOKEN_PREFIX } from "../../src/auth/token-service.js";

describe("TokenService", () => {
  const service = new TokenService();

  test("1. generates high-entropy random session token with standard prefix", () => {
    const token = service.generateSessionToken();

    assert.ok(token.startsWith(TOKEN_PREFIX), "Must start with standard token prefix");
    const hex = token.slice(TOKEN_PREFIX.length);
    assert.strictEqual(hex.length, 64, "Token random payload must be 32 bytes (64 hex characters)");
    assert.strictEqual(service.isValidTokenFormat(token), true);
  });

  test("2. produces distinct unique tokens across calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tokens.add(service.generateSessionToken());
    }
    assert.strictEqual(tokens.size, 50, "All generated tokens must be distinct");
  });

  test("3. hashes token with SHA-256 for verifier storage", () => {
    const token = service.generateSessionToken();
    const verifier1 = service.hashToken(token);
    const verifier2 = service.hashToken(token);

    assert.strictEqual(verifier1, verifier2, "Token hash must be deterministic");
    assert.strictEqual(verifier1.length, 64, "SHA-256 verifier must be 64 hex characters");
    assert.notStrictEqual(token, verifier1, "Raw token must not equal verifier hash");
  });

  test("4. validates token formats strictly", () => {
    assert.strictEqual(service.isValidTokenFormat(""), false);
    assert.strictEqual(service.isValidTokenFormat("invalid"), false);
    assert.strictEqual(service.isValidTokenFormat("ovsc_sess_too_short"), false);
    assert.strictEqual(
      service.isValidTokenFormat("ovsc_sess_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
      true
    );
    assert.strictEqual(
      service.isValidTokenFormat("ovsc_sess_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg"), // 'g' is non-hex
      false
    );
  });
});
