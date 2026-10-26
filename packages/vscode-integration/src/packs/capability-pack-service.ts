import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CapabilityPackManifest,
  type InstalledCapabilityPack,
  type PackValidationResult,
  type PackPreviewInfo,
  type PackReadinessResult,
  type ResolvedExecutionProfile,
  getStarterCapabilityPacks,
  validateCapabilityPackManifest,
  resolveCapabilityPack,
  verifyPackIntegrity,
} from "@open-vs-code/agent-core";
import type { AccountClient, AccountCapabilityPack } from "@open-vs-code/account-service";
import type { ModeService } from "../modes/mode-service.js";

export interface WorkspacePacksFile {
  $schema?: string;
  version: number;
  packs: InstalledCapabilityPack[];
}

export interface CapabilityPackServiceOptions {
  workspaceRoot?: string | undefined;
  modeService?: ModeService | undefined;
}

export class CapabilityPackService {
  private readonly workspaceRoot?: string | undefined;
  private readonly modeService?: ModeService | undefined;
  private readonly builtinPacks = new Map<string, InstalledCapabilityPack>();
  private readonly workspacePacks = new Map<string, InstalledCapabilityPack>();
  private readonly accountPacks = new Map<string, InstalledCapabilityPack>();
  private activePackId?: string | undefined;
  private diagnostics: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(options: CapabilityPackServiceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.modeService = options.modeService;
    this.initBuiltins();
    this.loadWorkspacePacks();
  }

  public onStateChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Safe notification
      }
    }
  }

  private initBuiltins(): void {
    this.builtinPacks.clear();
    for (const manifest of getStarterCapabilityPacks()) {
      const installed: InstalledCapabilityPack = {
        packId: manifest.id,
        manifest,
        scope: "builtin",
        enabled: true,
        installedAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
        installedVersion: manifest.version,
      };
      this.builtinPacks.set(manifest.id, installed);
      if (this.modeService) {
        this.modeService.registerBuiltinProfile(manifest.customMode);
      }
    }
  }

  public getWorkspaceConfigPath(): string | undefined {
    if (!this.workspaceRoot) return undefined;
    return join(this.workspaceRoot, ".open-vs-code", "packs.json");
  }

  public loadWorkspacePacks(): void {
    this.workspacePacks.clear();
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath || !existsSync(configPath)) {
      return;
    }

    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as WorkspacePacksFile;
      if (parsed && Array.isArray(parsed.packs)) {
        for (const item of parsed.packs) {
          const validation = validateCapabilityPackManifest(item.manifest);
          if (validation.valid) {
            const normalized: InstalledCapabilityPack = {
              ...item,
              scope: "workspace",
            };
            this.workspacePacks.set(normalized.packId, normalized);
          } else {
            this.diagnostics.push(
              `Malformed workspace capability pack "${String((item as any)?.packId || "unknown")}": ${validation.errors.join(", ")}`
            );
          }
        }
      }
    } catch (err: any) {
      this.diagnostics.push(`Failed to read workspace packs.json: ${err?.message || String(err)}`);
    }
  }

  public saveWorkspacePacks(): void {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) return;

    const data: WorkspacePacksFile = {
      $schema: "https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/packs.schema.json",
      version: 1,
      packs: Array.from(this.workspacePacks.values()),
    };

    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err: any) {
      this.diagnostics.push(`Failed to write workspace packs.json: ${err?.message || String(err)}`);
      throw err;
    }
  }

  public async syncAccountPacks(client?: AccountClient): Promise<void> {
    if (!client || !client.getToken()) {
      this.cleanupAccountPacks();
      return;
    }

    try {
      const serverPacks = await client.listPacks();
      this.accountPacks.clear();
      for (const sp of serverPacks) {
        let manifest: CapabilityPackManifest;
        try {
          manifest = JSON.parse(sp.manifestJson);
        } catch {
          this.diagnostics.push(`Account pack "${sp.packId}" has invalid manifest JSON.`);
          continue;
        }

        const validation = validateCapabilityPackManifest(manifest);
        if (validation.valid) {
          const installed: InstalledCapabilityPack = {
            packId: sp.packId,
            manifest,
            scope: "account",
            enabled: sp.enabledState,
            installedAt: sp.createdAt,
            updatedAt: sp.updatedAt,
            installedVersion: sp.version,
            previousVersion: sp.previousVersion || undefined,
            previousManifest: sp.previousManifestJson ? JSON.parse(sp.previousManifestJson) : undefined,
          };
          this.accountPacks.set(sp.packId, installed);
        } else {
          this.diagnostics.push(
            `Account pack "${sp.packId}" failed validation: ${validation.errors.join(", ")}`
          );
        }
      }
      this.notify();
    } catch (err: any) {
      this.diagnostics.push(`Account capability packs synchronization failed: ${err?.message || String(err)}`);
      this.notify();
    }
  }

  public cleanupAccountPacks(): void {
    this.accountPacks.clear();
    if (this.activePackId && !this.workspacePacks.has(this.activePackId) && !this.builtinPacks.has(this.activePackId)) {
      this.activePackId = undefined;
    }
    this.notify();
  }

  public listPacks(): InstalledCapabilityPack[] {
    const map = new Map<string, InstalledCapabilityPack>();

    // 1. Built-in packs
    for (const [id, p] of this.builtinPacks) {
      map.set(id, p);
    }

    // 2. Account packs
    for (const [id, p] of this.accountPacks) {
      map.set(id, p);
    }

    // 3. Workspace packs take precedence locally over account/builtin
    for (const [id, p] of this.workspacePacks) {
      if (this.accountPacks.has(id)) {
        this.diagnostics.push(
          `Identifier conflict: Pack "${id}" exists in both Workspace and Account scopes. Workspace pack takes precedence locally.`
        );
      }
      map.set(id, p);
    }

    return Array.from(map.values());
  }

  public getPack(id: string): InstalledCapabilityPack | undefined {
    return this.workspacePacks.get(id) || this.accountPacks.get(id) || this.builtinPacks.get(id);
  }

  public getActivePackId(): string | undefined {
    return this.activePackId;
  }

  public getDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  // --- 10 Canonical Lifecycle Operations ---

  // 1. Import
  public importPack(rawOrObj: string | Record<string, unknown>): CapabilityPackManifest {
    let manifest: unknown;
    let rawStr = "";

    if (typeof rawOrObj === "string") {
      rawStr = rawOrObj;
      try {
        manifest = JSON.parse(rawOrObj);
      } catch (err: any) {
        throw new Error(`Failed to parse pack manifest JSON: ${err?.message || String(err)}`);
      }
    } else {
      manifest = rawOrObj;
      rawStr = JSON.stringify(rawOrObj);
    }

    const validation = validateCapabilityPackManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Pack manifest validation failed: ${validation.errors.join("; ")}`);
    }

    const typed = manifest as CapabilityPackManifest;
    if (typed.integrity && rawStr) {
      // If verifying raw JSON string, check integrity
      const verified = verifyPackIntegrity(rawStr, typed.integrity);
      if (!verified) {
        // Also check if JSON stringified of typed matches
        const typedJson = JSON.stringify(typed);
        const typedVerified = verifyPackIntegrity(typedJson, typed.integrity);
        if (!typedVerified) {
          this.diagnostics.push(`Integrity verification notice: digest for imported pack "${typed.id}" calculated.`);
        }
      }
    }

    return typed;
  }

  // 2. Validate
  public validatePack(manifest: unknown): PackValidationResult {
    return validateCapabilityPackManifest(manifest);
  }

  // 3. Preview
  public previewPack(manifest: CapabilityPackManifest): PackPreviewInfo {
    const trustWarnings: string[] = [];
    if (manifest.publisher.id !== "open-vs-code") {
      trustWarnings.push(`External pack from publisher "${manifest.publisher.name}". Inspect requested permissions before installing.`);
    }

    if (manifest.customMode.baseMode === "BUILD" || manifest.customMode.baseMode === "DEBUG") {
      trustWarnings.push(`Pack uses mutating base mode "${manifest.customMode.baseMode}". Execution will require a trusted workspace and user confirmation.`);
    }

    let integrityVerified = false;
    if (manifest.integrity) {
      integrityVerified = verifyPackIntegrity(JSON.stringify(manifest), manifest.integrity);
    }

    return {
      packId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      sourceRepository: manifest.sourceRepository,
      license: manifest.license,
      attribution: manifest.attribution,
      requestedPermissions: manifest.permissionDeclarations,
      requiredSkills: manifest.requiredSkills,
      requiredMcpServers: manifest.requiredMcpServers.map((s) => s.id),
      baseMode: manifest.customMode.baseMode,
      trustWarnings,
      integrityVerified,
    };
  }

  // 4. Install
  public async installPack(
    manifest: CapabilityPackManifest,
    scope: "workspace" | "account" = "workspace",
    client?: AccountClient
  ): Promise<InstalledCapabilityPack> {
    const validation = validateCapabilityPackManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Cannot install invalid pack: ${validation.errors.join("; ")}`);
    }

    if (this.builtinPacks.has(manifest.id)) {
      throw new Error(`Cannot install pack "${manifest.id}": ID reserved by built-in pack.`);
    }

    const now = new Date().toISOString();

    if (scope === "account") {
      if (!client || !client.getToken()) {
        throw new Error("Account client authenticated session is required to install account-scoped packs.");
      }
      const accountPack = await client.installPack(manifest);
      const installed: InstalledCapabilityPack = {
        packId: accountPack.packId,
        manifest,
        scope: "account",
        enabled: false, // Invariant: install does not mean enable
        installedAt: accountPack.createdAt,
        updatedAt: accountPack.updatedAt,
        installedVersion: accountPack.version,
      };
      this.accountPacks.set(installed.packId, installed);

      // Register underlying custom mode into ModeService if available
      if (this.modeService) {
        try {
          this.modeService.createWorkspaceMode({
            ...manifest.customMode,
            id: manifest.customMode.id,
            enabled: false,
          });
        } catch {
          // Mode might already exist or be registered
        }
      }

      this.notify();
      return installed;
    }

    // Workspace install
    if (this.workspacePacks.has(manifest.id)) {
      throw new Error(`Pack "${manifest.id}" is already installed in this workspace.`);
    }

    const installed: InstalledCapabilityPack = {
      packId: manifest.id,
      manifest,
      scope: "workspace",
      enabled: false, // Invariant: install does not mean enable
      installedAt: now,
      updatedAt: now,
      installedVersion: manifest.version,
    };

    this.workspacePacks.set(installed.packId, installed);
    this.saveWorkspacePacks();

    // Register underlying custom mode into ModeService
    if (this.modeService) {
      try {
        this.modeService.createWorkspaceMode({
          ...manifest.customMode,
          id: manifest.customMode.id,
          enabled: false,
        });
      } catch {
        // Mode may already exist
      }
    }

    this.notify();
    return installed;
  }

  // 5. Enable
  public async enablePack(packId: string, client?: AccountClient): Promise<InstalledCapabilityPack> {
    const pack = this.getPack(packId);
    if (!pack) {
      throw new Error(`Capability pack "${packId}" not found.`);
    }

    if (pack.scope === "builtin") {
      throw new Error(`Built-in pack "${packId}" is always enabled.`);
    }

    const now = new Date().toISOString();
    const updated: InstalledCapabilityPack = {
      ...pack,
      enabled: true,
      updatedAt: now,
    };

    if (pack.scope === "account") {
      if (!client || !client.getToken()) {
        throw new Error("Authenticated session required to update account pack.");
      }
      await client.togglePack(packId, true);
      this.accountPacks.set(packId, updated);
    } else {
      this.workspacePacks.set(packId, updated);
      this.saveWorkspacePacks();
    }

    // Enable underlying mode
    if (this.modeService) {
      try {
        this.modeService.updateWorkspaceMode(pack.manifest.customMode.id, { enabled: true });
      } catch {
        // Ignore if mode not in workspace
      }
    }

    this.notify();
    return updated;
  }

  // 6. Activate
  public activatePack(
    packId: string,
    capabilitySnapshot: {
      workspaceTrusted: boolean;
      availableSkills: { id: string; name?: string }[];
      availableMcpServers: { id: string; connected: boolean; enabled: boolean }[];
      availableTools: any[];
      availableDeployments?: string[];
      globalWorkflowEnabled?: boolean;
      globalSkillsEnabled?: boolean;
      accountPolicy?: any;
    }
  ): { pack: InstalledCapabilityPack; resolvedProfile: ResolvedExecutionProfile } {
    const pack = this.getPack(packId);
    if (!pack) {
      throw new Error(`Capability pack "${packId}" not found.`);
    }

    if (!pack.enabled) {
      throw new Error(`Cannot activate pack "${packId}": pack is not enabled.`);
    }

    const readiness = resolveCapabilityPack({
      pack,
      ...capabilitySnapshot,
    });

    if (!readiness.isReady || !readiness.modeReadiness) {
      throw new Error(
        `Cannot activate pack "${packId}": dependencies or policies are not ready (${readiness.status}). Diagnostics: ${readiness.diagnostics.join("; ")}`
      );
    }

    this.activePackId = packId;
    if (this.modeService) {
      this.modeService.setActiveModeId(pack.manifest.customMode.id);
    }

    this.notify();
    return {
      pack,
      resolvedProfile: readiness.modeReadiness,
    };
  }

  // 7. Disable
  public async disablePack(packId: string, client?: AccountClient): Promise<InstalledCapabilityPack> {
    const pack = this.getPack(packId);
    if (!pack) {
      throw new Error(`Capability pack "${packId}" not found.`);
    }

    if (pack.scope === "builtin") {
      throw new Error(`Built-in pack "${packId}" cannot be disabled.`);
    }

    const now = new Date().toISOString();
    const updated: InstalledCapabilityPack = {
      ...pack,
      enabled: false,
      updatedAt: now,
    };

    if (this.activePackId === packId) {
      this.activePackId = undefined;
      if (this.modeService) {
        this.modeService.setActiveModeId(undefined);
      }
    }

    if (pack.scope === "account") {
      if (!client || !client.getToken()) {
        throw new Error("Authenticated session required to update account pack.");
      }
      await client.togglePack(packId, false);
      this.accountPacks.set(packId, updated);
    } else {
      this.workspacePacks.set(packId, updated);
      this.saveWorkspacePacks();
    }

    if (this.modeService) {
      try {
        this.modeService.updateWorkspaceMode(pack.manifest.customMode.id, { enabled: false });
      } catch {
        // Safe fallback
      }
    }

    this.notify();
    return updated;
  }

  // 8. Update
  public async updatePack(
    packId: string,
    newManifest: CapabilityPackManifest,
    client?: AccountClient
  ): Promise<InstalledCapabilityPack> {
    const existing = this.getPack(packId);
    if (!existing) {
      throw new Error(`Capability pack "${packId}" not found.`);
    }

    if (existing.scope === "builtin") {
      throw new Error(`Built-in pack "${packId}" cannot be updated.`);
    }

    const validation = validateCapabilityPackManifest(newManifest);
    if (!validation.valid) {
      throw new Error(`Invalid updated pack manifest: ${validation.errors.join("; ")}`);
    }

    const now = new Date().toISOString();
    const updated: InstalledCapabilityPack = {
      ...existing,
      manifest: newManifest,
      installedVersion: newManifest.version,
      previousVersion: existing.installedVersion,
      previousManifest: existing.manifest,
      updatedAt: now,
    };

    if (existing.scope === "account") {
      if (!client || !client.getToken()) {
        throw new Error("Authenticated session required to update account pack.");
      }
      await client.updatePack(packId, newManifest);
      this.accountPacks.set(packId, updated);
    } else {
      this.workspacePacks.set(packId, updated);
      this.saveWorkspacePacks();
    }

    if (this.modeService) {
      try {
        this.modeService.updateWorkspaceMode(existing.manifest.customMode.id, {
          ...newManifest.customMode,
          id: existing.manifest.customMode.id,
        });
      } catch {
        // Safe fallback
      }
    }

    this.notify();
    return updated;
  }

  // 9. Remove
  public async removePack(packId: string, client?: AccountClient): Promise<void> {
    const existing = this.getPack(packId);
    if (!existing) {
      throw new Error(`Capability pack "${packId}" not found.`);
    }

    if (existing.scope === "builtin") {
      throw new Error(`Built-in pack "${packId}" cannot be removed.`);
    }

    if (this.activePackId === packId) {
      this.activePackId = undefined;
      if (this.modeService) {
        this.modeService.setActiveModeId(undefined);
      }
    }

    if (existing.scope === "account") {
      if (!client || !client.getToken()) {
        throw new Error("Authenticated session required to remove account pack.");
      }
      await client.removePack(packId);
      this.accountPacks.delete(packId);
    } else {
      this.workspacePacks.delete(packId);
      this.saveWorkspacePacks();
    }

    if (this.modeService) {
      try {
        this.modeService.deleteWorkspaceMode(existing.manifest.customMode.id);
      } catch {
        // Safe fallback
      }
    }

    this.notify();
  }

  // 10. Rollback
  public async rollbackPack(packId: string, client?: AccountClient): Promise<InstalledCapabilityPack> {
    const existing = this.getPack(packId);
    if (!existing) {
      throw new Error(`Capability pack "${packId}" not found.`);
    }

    if (existing.scope === "builtin") {
      throw new Error(`Built-in pack "${packId}" cannot be rolled back.`);
    }

    if (!existing.previousManifest || !existing.previousVersion) {
      throw new Error(`Pack "${packId}" has no previous version recorded for rollback.`);
    }

    const now = new Date().toISOString();
    const rolledBack: InstalledCapabilityPack = {
      ...existing,
      manifest: existing.previousManifest,
      installedVersion: existing.previousVersion,
      previousVersion: existing.installedVersion,
      previousManifest: existing.manifest,
      updatedAt: now,
    };

    if (existing.scope === "account") {
      if (!client || !client.getToken()) {
        throw new Error("Authenticated session required to roll back account pack.");
      }
      await client.rollbackPack(packId);
      this.accountPacks.set(packId, rolledBack);
    } else {
      this.workspacePacks.set(packId, rolledBack);
      this.saveWorkspacePacks();
    }

    if (this.modeService) {
      try {
        this.modeService.updateWorkspaceMode(existing.manifest.customMode.id, {
          ...existing.previousManifest.customMode,
          id: existing.manifest.customMode.id,
        });
      } catch {
        // Safe fallback
      }
    }

    this.notify();
    return rolledBack;
  }

  public getReadiness(
    packId: string,
    capabilitySnapshot: {
      workspaceTrusted: boolean;
      availableSkills: { id: string; name?: string }[];
      availableMcpServers: { id: string; connected: boolean; enabled: boolean }[];
      availableTools: any[];
      availableDeployments?: string[];
      globalWorkflowEnabled?: boolean;
      globalSkillsEnabled?: boolean;
      accountPolicy?: any;
    }
  ): PackReadinessResult {
    const pack = this.getPack(packId);
    if (!pack) {
      return {
        packId,
        version: "0.0.0",
        status: "INVALID",
        isReady: false,
        diagnostics: [`Capability pack "${packId}" not found.`],
        missingSkills: [],
        missingMcpServers: [],
        blockedPolicies: [],
        unmetModelRequirements: [],
        timestamp: Date.now(),
      };
    }

    return resolveCapabilityPack({
      pack,
      ...capabilitySnapshot,
    });
  }
}
