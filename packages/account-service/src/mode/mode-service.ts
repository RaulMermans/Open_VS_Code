import { randomUUID } from "node:crypto";
import type { AccountDatabase } from "../db/connection.js";
import { ModeProfileRepository } from "../db/repositories/mode-repository.js";
import { AuditRepository } from "../db/repositories/audit-repository.js";
import type { AccountModeProfile } from "../types.js";
import { ConflictError, InvalidInputError, NotFoundError } from "../errors.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VALID_BASE_MODES = new Set(["ASK", "PLAN", "BUILD", "DEBUG", "REVIEW"]);

export interface RegisterModeInput {
  profileId: string;
  name: string;
  description: string;
  icon?: string | null | undefined;
  version?: number | undefined;
  baseMode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";
  customInstructions?: string | null | undefined;
  requiredSkills?: string[] | undefined;
  optionalSkills?: string[] | undefined;
  requiredMcpServers?: string[] | undefined;
  optionalMcpServers?: string[] | undefined;
  toolAllowlist?: string[] | null | undefined;
  preferredModelId?: string | null | undefined;
  workflowPreference?: "direct" | "structured" | null | undefined;
  contextGuidance?: string | null | undefined;
  verificationPreferences?: Record<string, unknown> | null | undefined;
  sourceRepoReferences?: string[] | null | undefined;
  enabledState?: boolean | undefined;
}

export interface UpdateModeInput {
  name?: string | undefined;
  description?: string | undefined;
  icon?: string | null | undefined;
  version?: number | undefined;
  baseMode?: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW" | undefined;
  customInstructions?: string | null | undefined;
  requiredSkills?: string[] | undefined;
  optionalSkills?: string[] | undefined;
  requiredMcpServers?: string[] | undefined;
  optionalMcpServers?: string[] | undefined;
  toolAllowlist?: string[] | null | undefined;
  preferredModelId?: string | null | undefined;
  workflowPreference?: "direct" | "structured" | null | undefined;
  contextGuidance?: string | null | undefined;
  verificationPreferences?: Record<string, unknown> | null | undefined;
  sourceRepoReferences?: string[] | null | undefined;
  enabledState?: boolean | undefined;
}

export class ModeService {
  private readonly modeRepo: ModeProfileRepository;
  private readonly auditRepo: AuditRepository;

  constructor(private readonly db: AccountDatabase) {
    this.modeRepo = new ModeProfileRepository(db.connection);
    this.auditRepo = new AuditRepository(db.connection);
  }

  async list(ownerUserId: string): Promise<AccountModeProfile[]> {
    return this.modeRepo.listByOwner(ownerUserId);
  }

  async get(ownerUserId: string, profileId: string): Promise<AccountModeProfile> {
    const profile = this.modeRepo.findByOwnerAndProfileId(ownerUserId, profileId);
    if (!profile) {
      throw new NotFoundError(`Mode profile "${profileId}" not found for this account.`);
    }
    return profile;
  }

  async register(ownerUserId: string, input: RegisterModeInput): Promise<AccountModeProfile> {
    if (!input.profileId || typeof input.profileId !== "string" || !ID_PATTERN.test(input.profileId)) {
      throw new InvalidInputError(`Invalid profileId "${String(input.profileId)}". Must match ${ID_PATTERN.source}`);
    }

    if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new InvalidInputError("Name is required.");
    }

    if (!input.baseMode || !VALID_BASE_MODES.has(input.baseMode)) {
      throw new InvalidInputError(`Invalid baseMode "${String(input.baseMode)}". Must be one of: ASK, PLAN, BUILD, DEBUG, REVIEW.`);
    }

    const existing = this.modeRepo.findByOwnerAndProfileId(ownerUserId, input.profileId);
    if (existing) {
      throw new ConflictError(`Mode profile "${input.profileId}" already exists for this account.`);
    }

    const now = new Date().toISOString();
    const profile: AccountModeProfile = {
      id: randomUUID(),
      ownerUserId,
      profileId: input.profileId,
      name: input.name.trim(),
      description: input.description ?? "",
      icon: input.icon ?? null,
      version: input.version ?? 1,
      baseMode: input.baseMode,
      customInstructions: input.customInstructions ?? null,
      requiredSkills: input.requiredSkills ?? [],
      optionalSkills: input.optionalSkills ?? [],
      requiredMcpServers: input.requiredMcpServers ?? [],
      optionalMcpServers: input.optionalMcpServers ?? [],
      toolAllowlist: input.toolAllowlist ?? null,
      preferredModelId: input.preferredModelId ?? null,
      workflowPreference: input.workflowPreference ?? null,
      contextGuidance: input.contextGuidance ?? null,
      verificationPreferences: input.verificationPreferences ?? null,
      sourceRepoReferences: input.sourceRepoReferences ?? null,
      scope: "account",
      enabledState: input.enabledState !== false,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };

    this.modeRepo.create(profile);

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "MODE_CREATE",
      target: input.profileId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { name: profile.name, baseMode: profile.baseMode },
    });

    return profile;
  }

  async update(ownerUserId: string, profileId: string, input: UpdateModeInput): Promise<AccountModeProfile> {
    const existing = await this.get(ownerUserId, profileId);

    if (input.baseMode && !VALID_BASE_MODES.has(input.baseMode)) {
      throw new InvalidInputError(`Invalid baseMode "${String(input.baseMode)}". Must be one of: ASK, PLAN, BUILD, DEBUG, REVIEW.`);
    }

    const now = new Date().toISOString();
    const updated: AccountModeProfile = {
      ...existing,
      name: input.name !== undefined ? input.name.trim() : existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      icon: input.icon !== undefined ? input.icon : existing.icon,
      version: input.version !== undefined ? input.version : existing.version + 1,
      baseMode: input.baseMode !== undefined ? input.baseMode : existing.baseMode,
      customInstructions: input.customInstructions !== undefined ? input.customInstructions : existing.customInstructions,
      requiredSkills: input.requiredSkills !== undefined ? input.requiredSkills : existing.requiredSkills,
      optionalSkills: input.optionalSkills !== undefined ? input.optionalSkills : existing.optionalSkills,
      requiredMcpServers: input.requiredMcpServers !== undefined ? input.requiredMcpServers : existing.requiredMcpServers,
      optionalMcpServers: input.optionalMcpServers !== undefined ? input.optionalMcpServers : existing.optionalMcpServers,
      toolAllowlist: input.toolAllowlist !== undefined ? input.toolAllowlist : existing.toolAllowlist,
      preferredModelId: input.preferredModelId !== undefined ? input.preferredModelId : existing.preferredModelId,
      workflowPreference: input.workflowPreference !== undefined ? input.workflowPreference : existing.workflowPreference,
      contextGuidance: input.contextGuidance !== undefined ? input.contextGuidance : existing.contextGuidance,
      verificationPreferences: input.verificationPreferences !== undefined ? input.verificationPreferences : existing.verificationPreferences,
      sourceRepoReferences: input.sourceRepoReferences !== undefined ? input.sourceRepoReferences : existing.sourceRepoReferences,
      enabledState: input.enabledState !== undefined ? input.enabledState : existing.enabledState,
      updatedAt: now,
    };

    const success = this.modeRepo.update(updated);
    if (!success) {
      throw new NotFoundError(`Failed to update mode profile "${profileId}".`);
    }

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "MODE_UPDATE",
      target: profileId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { version: updated.version },
    });

    return updated;
  }

  async delete(ownerUserId: string, profileId: string): Promise<void> {
    const existing = await this.get(ownerUserId, profileId);
    const success = this.modeRepo.delete(ownerUserId, profileId);
    if (!success) {
      throw new NotFoundError(`Failed to delete mode profile "${profileId}".`);
    }

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "MODE_DELETE",
      target: profileId,
      timestamp: new Date().toISOString(),
      outcome: "SUCCESS",
      details: { name: existing.name },
    });
  }
}
