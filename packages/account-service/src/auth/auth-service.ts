import * as crypto from "node:crypto";
import type { AccountDatabase } from "../db/connection.js";
import type { Session, SessionWithToken, User, UserProfile } from "../types.js";
import { PasswordService } from "./password-service.js";
import { TokenService } from "./token-service.js";
import { RateLimiter } from "./rate-limiter.js";
import {
  AccountDisabledError,
  InvalidCredentialsError,
  RateLimitExceededError,
  UnauthorizedError,
} from "../errors.js";

export interface AuthServiceOptions {
  readonly sessionDurationMs?: number;
  readonly rateLimiter?: RateLimiter;
}

export class AuthService {
  public readonly passwordService = new PasswordService();
  public readonly tokenService = new TokenService();
  public readonly rateLimiter: RateLimiter;
  private readonly sessionDurationMs: number;

  constructor(
    private readonly db: AccountDatabase,
    options: AuthServiceOptions = {}
  ) {
    this.sessionDurationMs = options.sessionDurationMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
  }

  async login(username: string, password: string, clientIp = "127.0.0.1"): Promise<SessionWithToken> {
    const ipKey = `ip:${clientIp}`;
    const userKey = `user:${username.toLowerCase().trim()}`;

    if (this.rateLimiter.isRateLimited(ipKey) || this.rateLimiter.isRateLimited(userKey)) {
      this.db.audit.record({
        id: crypto.randomUUID(),
        actor: username || clientIp,
        action: "AUTH_FAILED",
        target: "session",
        timestamp: new Date().toISOString(),
        outcome: "DENIED",
        details: { reason: "RATE_LIMIT_EXCEEDED", clientIp },
      });
      throw new RateLimitExceededError();
    }

    const cleanUsername = username?.trim();
    const user = cleanUsername ? this.db.users.findByUsername(cleanUsername) : undefined;

    if (!user) {
      // Mitigate username enumeration by executing scrypt calculation with dummy salt
      this.passwordService.performDummyVerification(password);
      this.rateLimiter.recordFailure(ipKey);
      this.rateLimiter.recordFailure(userKey);

      this.db.audit.record({
        id: crypto.randomUUID(),
        actor: cleanUsername || clientIp,
        action: "AUTH_FAILED",
        target: "session",
        timestamp: new Date().toISOString(),
        outcome: "FAILED",
        details: { reason: "USER_NOT_FOUND", clientIp },
      });

      throw new InvalidCredentialsError();
    }

    if (user.status === "DISABLED") {
      this.rateLimiter.recordFailure(ipKey);
      this.rateLimiter.recordFailure(userKey);

      this.db.audit.record({
        id: crypto.randomUUID(),
        actor: user.id,
        action: "AUTH_FAILED",
        target: "session",
        timestamp: new Date().toISOString(),
        outcome: "DENIED",
        details: { reason: "ACCOUNT_DISABLED", clientIp },
      });

      throw new AccountDisabledError();
    }

    const isValidPassword = this.passwordService.verifyPassword(password, user.passwordHash);
    if (!isValidPassword) {
      this.rateLimiter.recordFailure(ipKey);
      this.rateLimiter.recordFailure(userKey);

      this.db.audit.record({
        id: crypto.randomUUID(),
        actor: user.id,
        action: "AUTH_FAILED",
        target: "session",
        timestamp: new Date().toISOString(),
        outcome: "FAILED",
        details: { reason: "INVALID_PASSWORD", clientIp },
      });

      throw new InvalidCredentialsError();
    }

    // Success: clear rate limits for user and IP
    this.rateLimiter.recordSuccess(ipKey);
    this.rateLimiter.recordSuccess(userKey);

    const token = this.tokenService.generateSessionToken();
    const tokenVerifier = this.tokenService.hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionDurationMs);

    const session: Session = {
      id: crypto.randomUUID(),
      userId: user.id,
      tokenVerifier,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      lastUsedAt: now.toISOString(),
    };

    this.db.sessions.create(session);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: user.id,
      action: "AUTH_LOGIN",
      target: session.id,
      timestamp: now.toISOString(),
      outcome: "SUCCESS",
      details: { clientIp, role: user.role },
    });

    return { session, token };
  }

  async logout(token: string, clientIp = "127.0.0.1"): Promise<void> {
    if (!token || !this.tokenService.isValidTokenFormat(token)) {
      return;
    }

    const tokenVerifier = this.tokenService.hashToken(token);
    const session = this.db.sessions.findByTokenVerifier(tokenVerifier);
    if (!session) {
      return;
    }

    const now = new Date().toISOString();
    this.db.sessions.revoke(session.id, now);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: session.userId,
      action: "AUTH_LOGOUT",
      target: session.id,
      timestamp: now,
      outcome: "SUCCESS",
      details: { clientIp },
    });
  }

  async validateSession(token: string): Promise<{ user: User; session: Session }> {
    if (!token || !this.tokenService.isValidTokenFormat(token)) {
      throw new UnauthorizedError("Invalid session token format.");
    }

    const tokenVerifier = this.tokenService.hashToken(token);
    const session = this.db.sessions.findByTokenVerifier(tokenVerifier);
    if (!session) {
      throw new UnauthorizedError("Session not found or expired.");
    }

    if (session.revokedAt) {
      throw new UnauthorizedError("Session has been revoked.");
    }

    const now = new Date();
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      throw new UnauthorizedError("Session has expired.");
    }

    const user = this.db.users.findById(session.userId);
    if (!user) {
      throw new UnauthorizedError("User no longer exists.");
    }

    if (user.status === "DISABLED") {
      throw new AccountDisabledError();
    }

    // Touch session last_used_at
    this.db.sessions.touch(session.id, now.toISOString());

    return { user, session };
  }

  revokeSession(sessionId: string, actor: string): void {
    const session = this.db.sessions.findById(sessionId);
    if (!session) return;

    const now = new Date().toISOString();
    this.db.sessions.revoke(sessionId, now);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor,
      action: "SESSION_REVOKE",
      target: sessionId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { targetUserId: session.userId },
    });
  }

  revokeAllUserSessions(userId: string, actor: string): void {
    const now = new Date().toISOString();
    this.db.sessions.revokeAllForUser(userId, now);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor,
      action: "SESSION_REVOKE",
      target: `all_sessions:${userId}`,
      timestamp: now,
      outcome: "SUCCESS",
      details: { targetUserId: userId },
    });
  }

  toProfile(user: User): UserProfile {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
