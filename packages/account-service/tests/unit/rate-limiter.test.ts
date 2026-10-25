import { test, describe } from "node:test";
import assert from "node:assert";
import { RateLimiter } from "../../src/auth/rate-limiter.js";

describe("RateLimiter", () => {
  test("1. allows attempts below threshold", () => {
    const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 60000 });
    const key = "ip:127.0.0.1";

    assert.strictEqual(limiter.isRateLimited(key), false);
    limiter.recordFailure(key);
    limiter.recordFailure(key);
    assert.strictEqual(limiter.isRateLimited(key), false);
  });

  test("2. locks out after exceeding maxAttempts", () => {
    const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 60000 });
    const key = "user:alice";

    limiter.recordFailure(key);
    limiter.recordFailure(key);
    assert.strictEqual(limiter.isRateLimited(key), false);

    limiter.recordFailure(key);
    assert.strictEqual(limiter.isRateLimited(key), true);
  });

  test("3. resets failure counter on successful login", () => {
    const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 60000 });
    const key = "user:bob";

    limiter.recordFailure(key);
    limiter.recordFailure(key);
    limiter.recordSuccess(key);

    assert.strictEqual(limiter.isRateLimited(key), false);
    limiter.recordFailure(key);
    assert.strictEqual(limiter.isRateLimited(key), false);
  });

  test("4. expires window after windowMs elapses", () => {
    const limiter = new RateLimiter({ maxAttempts: 2, windowMs: 1000 });
    const key = "ip:10.0.0.1";
    const t0 = 100000;

    limiter.recordFailure(key, t0);
    limiter.recordFailure(key, t0);
    assert.strictEqual(limiter.isRateLimited(key, t0), true);

    // After window expiration
    assert.strictEqual(limiter.isRateLimited(key, t0 + 1001), false);
  });
});
