export interface RateLimiterOptions {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
}

interface AttemptRecord {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000; // 15 minutes default
  }

  isRateLimited(key: string, now: number = Date.now()): boolean {
    const record = this.attempts.get(key);
    if (!record) return false;
    if (now >= record.resetAt) {
      this.attempts.delete(key);
      return false;
    }
    return record.count >= this.maxAttempts;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const record = this.attempts.get(key);
    if (!record || now >= record.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      record.count += 1;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  getRemainingWaitMs(key: string, now: number = Date.now()): number {
    const record = this.attempts.get(key);
    if (!record || now >= record.resetAt) return 0;
    return Math.max(0, record.resetAt - now);
  }

  clear(): void {
    this.attempts.clear();
  }
}
