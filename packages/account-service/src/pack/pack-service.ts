import { randomUUID } from "node:crypto";
import type { AccountDatabase } from "../db/connection.js";
import { CapabilityPackRepository } from "../db/repositories/pack-repository.js";
import { AuditRepository } from "../db/repositories/audit-repository.js";
import type { AccountCapabilityPack } from "../types.js";
import { ConflictError, InvalidInputError, NotFoundError } from "../errors.js";
import { validateCapabilityPackManifest, verifyPackIntegrity } from "@open-vs-code/agent-core";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export class CapabilityPackService {
  private readonly packRepo: CapabilityPackRepository;
  private readonly auditRepo: AuditRepository;

  constructor(private readonly db: AccountDatabase) {
    this.packRepo = new CapabilityPackRepository(db.connection);
    this.auditRepo = new AuditRepository(db.connection);
  }

  async list(ownerUserId: string): Promise<AccountCapabilityPack[]> {
    return this.packRepo.listByOwner(ownerUserId);
  }

  async get(ownerUserId: string, packId: string): Promise<AccountCapabilityPack> {
    const pack = this.packRepo.findByOwnerAndPackId(ownerUserId, packId);
    if (!pack) {
      throw new NotFoundError(`Capability pack "${packId}" not found for this account.`);
    }
    return pack;
  }

  async install(ownerUserId: string, manifest: any): Promise<AccountCapabilityPack> {
    if (!manifest || typeof manifest !== "object") {
      throw new InvalidInputError("Manifest must be a non-null object.");
    }

    const validation = validateCapabilityPackManifest(manifest);
    if (!validation.valid) {
      throw new InvalidInputError(`Capability pack manifest validation failed: ${validation.errors.join("; ")}`);
    }

    if (!verifyPackIntegrity(manifest, manifest.integrity)) {
      throw new InvalidInputError(
        "Manifest integrity verification failed: digest mismatch. Checksum provides integrity, not publisher authenticity."
      );
    }

    const packId = manifest.id;
    if (!packId || typeof packId !== "string" || !ID_PATTERN.test(packId)) {
      throw new InvalidInputError(`Invalid packId "${String(packId)}". Must match ${ID_PATTERN.source}`);
    }

    const name = manifest.name;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new InvalidInputError("Name is required.");
    }

    const version = manifest.version;
    if (!version || typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
      throw new InvalidInputError(`Invalid SemVer version "${String(version)}".`);
    }

    const existing = this.packRepo.findByOwnerAndPackId(ownerUserId, packId);
    if (existing) {
      throw new ConflictError(`Capability pack "${packId}" already exists for this account.`);
    }

    const now = new Date().toISOString();
    const publisherName = typeof manifest.publisher === "object" ? manifest.publisher?.name || manifest.publisher?.id || "unknown" : String(manifest.publisher || "unknown");
    const license = typeof manifest.license === "string" ? manifest.license : "unknown";

    const pack: AccountCapabilityPack = {
      id: randomUUID(),
      ownerUserId,
      packId,
      name: name.trim(),
      description: typeof manifest.description === "string" ? manifest.description : "",
      version,
      publisher: publisherName,
      license,
      manifestJson: typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      scope: "account",
      enabledState: false, // Invariant: Install does not mean enable
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };

    this.packRepo.insert(pack);

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "PACK_INSTALL",
      target: packId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { packId, version, name: pack.name },
    });

    return pack;
  }

  async toggle(ownerUserId: string, packId: string, enabledState: boolean): Promise<AccountCapabilityPack> {
    const existing = await this.get(ownerUserId, packId);
    const now = new Date().toISOString();
    const updated: AccountCapabilityPack = {
      ...existing,
      enabledState,
      updatedAt: now,
    };

    this.packRepo.update(updated);

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "PACK_TOGGLE",
      target: packId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { packId, enabledState },
    });

    return updated;
  }

  async update(ownerUserId: string, packId: string, newManifest: any): Promise<AccountCapabilityPack> {
    const existing = await this.get(ownerUserId, packId);

    if (!newManifest || typeof newManifest !== "object") {
      throw new InvalidInputError("New manifest must be a non-null object.");
    }

    const validation = validateCapabilityPackManifest(newManifest);
    if (!validation.valid) {
      throw new InvalidInputError(`New manifest validation failed: ${validation.errors.join("; ")}`);
    }

    if (!verifyPackIntegrity(newManifest, newManifest.integrity)) {
      throw new InvalidInputError(
        "New manifest integrity verification failed: digest mismatch. Checksum provides integrity, not publisher authenticity."
      );
    }

    const newVersion = newManifest.version;
    if (!newVersion || typeof newVersion !== "string" || !SEMVER_PATTERN.test(newVersion)) {
      throw new InvalidInputError(`Invalid SemVer version "${String(newVersion)}".`);
    }

    const now = new Date().toISOString();
    const publisherName = typeof newManifest.publisher === "object" ? newManifest.publisher?.name || newManifest.publisher?.id || existing.publisher : existing.publisher;
    const license = typeof newManifest.license === "string" ? newManifest.license : existing.license;

    const updated: AccountCapabilityPack = {
      ...existing,
      name: typeof newManifest.name === "string" ? newManifest.name.trim() : existing.name,
      description: typeof newManifest.description === "string" ? newManifest.description : existing.description,
      version: newVersion,
      publisher: publisherName,
      license,
      manifestJson: typeof newManifest === "string" ? newManifest : JSON.stringify(newManifest),
      previousVersion: existing.version,
      previousManifestJson: existing.manifestJson,
      updatedAt: now,
    };

    this.packRepo.update(updated);

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "PACK_UPDATE",
      target: packId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { packId, fromVersion: existing.version, toVersion: newVersion },
    });

    return updated;
  }

  async rollback(ownerUserId: string, packId: string): Promise<AccountCapabilityPack> {
    const existing = await this.get(ownerUserId, packId);
    if (!existing.previousVersion || !existing.previousManifestJson) {
      throw new InvalidInputError(`No previous version recorded for pack "${packId}" to roll back to.`);
    }

    const now = new Date().toISOString();
    let prevParsed: any = {};
    try {
      prevParsed = JSON.parse(existing.previousManifestJson);
    } catch {
      throw new InvalidInputError(`Corrupt previous manifest JSON for pack "${packId}".`);
    }

    const validation = validateCapabilityPackManifest(prevParsed);
    if (!validation.valid) {
      throw new InvalidInputError(`Rollback manifest validation failed: ${validation.errors.join("; ")}`);
    }

    if (!verifyPackIntegrity(prevParsed, prevParsed.integrity)) {
      throw new InvalidInputError("Rollback manifest integrity verification failed: digest mismatch.");
    }

    const rolledBack: AccountCapabilityPack = {
      ...existing,
      name: prevParsed.name || existing.name,
      description: prevParsed.description ?? existing.description,
      version: existing.previousVersion,
      manifestJson: existing.previousManifestJson,
      previousVersion: existing.version,
      previousManifestJson: existing.manifestJson,
      updatedAt: now,
    };

    this.packRepo.update(rolledBack);

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "PACK_ROLLBACK",
      target: packId,
      timestamp: now,
      outcome: "SUCCESS",
      details: { packId, rolledBackTo: existing.previousVersion },
    });

    return rolledBack;
  }

  async remove(ownerUserId: string, packId: string): Promise<void> {
    const existing = await this.get(ownerUserId, packId);
    this.packRepo.delete(existing.id);

    this.auditRepo.record({
      id: randomUUID(),
      actor: ownerUserId,
      action: "PACK_REMOVE",
      target: packId,
      timestamp: new Date().toISOString(),
      outcome: "SUCCESS",
      details: { packId, name: existing.name },
    });
  }
}
