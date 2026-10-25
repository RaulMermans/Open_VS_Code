import * as crypto from "node:crypto";
import type { AccountDatabase } from "../db/connection.js";
import type { AuditEvent, User, UserProfile, UserRole, UserStatus } from "../types.js";
import { PasswordService } from "../auth/password-service.js";
import {
  BootstrapDisallowedError,
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
} from "../errors.js";

export interface CreateUserInput {
  readonly username: string;
  readonly password: string;
  readonly role?: UserRole;
}

export class AdminService {
  private readonly passwordService = new PasswordService();

  constructor(private readonly db: AccountDatabase) {}

  private assertAdmin(actorId: string): void {
    if (actorId === "SYSTEM_BOOTSTRAP" || actorId === "ADMIN_CLI") {
      return;
    }
    const actor = this.db.users.findById(actorId);
    if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
      throw new ForbiddenError("Administrative privileges required.");
    }
  }

  async bootstrapFirstAdmin(username: string, password: string): Promise<UserProfile> {
    const existingCount = this.db.users.count();
    if (existingCount > 0) {
      throw new BootstrapDisallowedError();
    }

    const cleanUsername = username?.trim();
    if (!cleanUsername || cleanUsername.length < 3) {
      throw new InvalidInputError("Username must be at least 3 characters long.");
    }

    const passwordHash = this.passwordService.hashPassword(password);
    const now = new Date().toISOString();

    const adminUser: User = {
      id: crypto.randomUUID(),
      username: cleanUsername,
      passwordHash,
      role: "ADMIN",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };

    this.db.users.create(adminUser);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: "SYSTEM_BOOTSTRAP",
      action: "USER_BOOTSTRAP",
      target: adminUser.id,
      timestamp: now,
      outcome: "SUCCESS",
      details: { username: cleanUsername, role: "ADMIN" },
    });

    return {
      id: adminUser.id,
      username: adminUser.username,
      role: adminUser.role,
      status: adminUser.status,
      createdAt: adminUser.createdAt,
      updatedAt: adminUser.updatedAt,
    };
  }

  async createUser(actorId: string, input: CreateUserInput): Promise<UserProfile> {
    this.assertAdmin(actorId);

    const cleanUsername = input.username?.trim();
    if (!cleanUsername || cleanUsername.length < 3) {
      throw new InvalidInputError("Username must be at least 3 characters long.");
    }

    const existing = this.db.users.findByUsername(cleanUsername);
    if (existing) {
      throw new ConflictError(`User "${cleanUsername}" already exists.`);
    }

    const role: UserRole = input.role === "ADMIN" ? "ADMIN" : "USER";
    const passwordHash = this.passwordService.hashPassword(input.password);
    const now = new Date().toISOString();

    const newUser: User = {
      id: crypto.randomUUID(),
      username: cleanUsername,
      passwordHash,
      role,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };

    this.db.users.create(newUser);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: actorId,
      action: "USER_CREATE",
      target: newUser.id,
      timestamp: now,
      outcome: "SUCCESS",
      details: { username: cleanUsername, role },
    });

    return {
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      status: newUser.status,
      createdAt: newUser.createdAt,
      updatedAt: newUser.updatedAt,
    };
  }

  async listUsers(actorId: string): Promise<UserProfile[]> {
    this.assertAdmin(actorId);

    const users = this.db.users.listAll();
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));
  }

  async setStatus(actorId: string, targetUserId: string, status: UserStatus): Promise<UserProfile> {
    this.assertAdmin(actorId);

    const user = this.db.users.findById(targetUserId);
    if (!user) {
      throw new NotFoundError("User");
    }

    const now = new Date().toISOString();
    this.db.users.updateStatus(targetUserId, status, now);

    // If account was disabled, revoke all active sessions immediately
    if (status === "DISABLED") {
      this.db.sessions.revokeAllForUser(targetUserId, now);
    }

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: actorId,
      action: "USER_STATUS_CHANGE",
      target: targetUserId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { previousStatus: user.status, newStatus: status },
    });

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status,
      createdAt: user.createdAt,
      updatedAt: now,
    };
  }

  async resetPassword(actorId: string, targetUserId: string, newPassword: string): Promise<void> {
    this.assertAdmin(actorId);

    const user = this.db.users.findById(targetUserId);
    if (!user) {
      throw new NotFoundError("User");
    }

    const passwordHash = this.passwordService.hashPassword(newPassword);
    const now = new Date().toISOString();

    this.db.users.updatePassword(targetUserId, passwordHash, now);
    // Revoke all existing sessions on password reset
    this.db.sessions.revokeAllForUser(targetUserId, now);

    this.db.audit.record({
      id: crypto.randomUUID(),
      actor: actorId,
      action: "USER_PASSWORD_RESET",
      target: targetUserId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { username: user.username },
    });
  }

  async getAuditLog(
    actorId: string,
    filters: { actor?: string; action?: string; target?: string; since?: string; limit?: number } = {}
  ): Promise<AuditEvent[]> {
    this.assertAdmin(actorId);
    return this.db.audit.query(filters);
  }
}
