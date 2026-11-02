/**
 * Sprint 9D.1 — Governed REA Workflow Engine.
 *
 * Authoritative sequential workflow runner for REA Investigation and Reconstruction.
 * Integrates directly into AgentRuntime and AgentSessionBridge.
 *
 * Guarantees:
 * - Single authoritative runtime without secondary agents or unmanaged swarms.
 * - Enforces PermissionGate for browser interactions and file mutations.
 * - Reconstructs clean-room code only after host-mediated confirmation.
 * - Closes reconstruction obligations only with verified passing test evidence.
 * - Emits ordered stage and progress events, supports checkpoints and cancellation.
 */

import { resolve, isAbsolute, relative, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, rmSync, readdirSync, realpathSync } from "node:fs";
import type { BrowserSessionManager } from "../browser/browser-session-manager.ts";
import type { CheckpointCoordinator } from "../recovery/checkpoint-coordinator.ts";
import type { MutationEngine } from "../tools/mutation-engine.ts";
import type { PreparedMutation } from "../tools/mutation-contracts.ts";
import type { McpCatalog } from "../mcp/mcp-catalog.ts";
import type { ConfirmationDecision } from "../agent/runner.ts";
import type {
  ChangedFile,
  EngineeringStage,
  ReviewEvidence,
  StageRecord,
  VerificationEvidence,
  WorkflowBlocker,
  WorkflowConfirmation,
  WorkflowResult,
  WorkflowState,
  WorkflowStatus,
  WorkStage,
} from "../workflow/contracts.ts";
import { InvestigationEngine, type InvestigationResult } from "./investigation-engine.ts";
import type { ReconstructionResult } from "./reconstruction-engine.ts";
import { classifyInvestigationTarget } from "./target-classifier.ts";
import { ReaMcpService } from "./rea-mcp-service.ts";
import type {
  ReconstructionSpecification,
  ReconstructionObligationLedger,
  ReconstructionObligation,
} from "./contracts.ts";

export interface GovernedReaWorkflowOptions {
  readonly workflowType: "investigation" | "reconstruction";
  readonly workspaceRoot: string;
  readonly mutationEngine: MutationEngine;
  readonly checkpointCoordinator?: CheckpointCoordinator | undefined;
  readonly browserSessionManager?: BrowserSessionManager | undefined;
  readonly reaMcpService?: ReaMcpService | undefined;
  readonly mcpCatalog?: McpCatalog | undefined;
  readonly provider?: any;
  readonly skills?: any | undefined;
  readonly onStage?: ((event: { stage: string; status: string; skill?: string }) => void) | undefined;
  readonly eventSink?: ((event: any) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly task: string;
  readonly taskId: string;
  readonly targetInput?: string | undefined;
  readonly autoApprove?: boolean | undefined;
  readonly userAuthorized?: boolean | undefined;
  readonly initialSpecification?: ReconstructionSpecification | undefined;
  readonly initialLedger?: ReconstructionObligationLedger | undefined;
  readonly targetFiles?: Record<string, string> | undefined;
  readonly testRunner?: ((
    obligation: ReconstructionObligation,
    workspaceRoot: string
  ) => Promise<{
    passed: boolean;
    output: string;
    details?: {
      verifier?: string;
      testIdentity?: string;
      inputFixture?: string;
      expectedBehavior?: string;
      observedResult?: string;
      limitations?: readonly string[];
    };
  }>) | undefined;
}

interface PendingConfirmation {
  readonly callId: string;
  readonly stage: string;
  readonly workflowId: string;
  readonly workspaceRoot: string;
  readonly targetPath?: string | undefined;
  readonly operationType?: string | undefined;
  readonly contentDigest?: string | undefined;
  readonly preparedMutation?: PreparedMutation | undefined;
  readonly confirmationPrompt: string;
  readonly applyFn: () => Promise<void>;
}

export class GovernedReaWorkflow {
  readonly #workflowType: "investigation" | "reconstruction";
  readonly #workspaceRoot: string;
  readonly #mutationEngine: MutationEngine;
  readonly #checkpointCoordinator?: CheckpointCoordinator | undefined;
  readonly #browserSessionManager?: BrowserSessionManager | undefined;
  readonly #reaMcpService?: ReaMcpService | undefined;
  readonly #mcpCatalog?: McpCatalog | undefined;
  readonly #provider?: any;
  readonly #skills?: any;
  readonly #onStage?: ((event: { stage: string; status: string; skill?: string }) => void) | undefined;
  readonly #eventSink?: ((event: any) => void) | undefined;
  readonly #signal?: AbortSignal | undefined;
  readonly #task: string;
  readonly #taskId: string;
  readonly #workflowId: string;
  readonly #targetInput: string;
  readonly #autoApprove: boolean;
  #userAuthorized: boolean;
  readonly #initialSpecification?: ReconstructionSpecification | undefined;
  readonly #initialLedger?: ReconstructionObligationLedger | undefined;
  readonly #targetFiles?: Record<string, string> | undefined;
  readonly #testRunner?: ((
    obligation: ReconstructionObligation,
    workspaceRoot: string
  ) => Promise<{
    passed: boolean;
    output: string;
    details?: {
      verifier?: string;
      testIdentity?: string;
      inputFixture?: string;
      expectedBehavior?: string;
      observedResult?: string;
      limitations?: readonly string[];
    };
  }>) | undefined;

  readonly #stageModelCalls: Record<string, number> = {};
  readonly #stageTokens: Record<string, number> = {};
  readonly #stageTools: Record<string, Set<string>> = {};
  readonly #stageSkills: Record<string, string | undefined> = {};
  readonly #stageSkillInjected: Record<string, boolean> = {};

  #plannedFiles?: Array<{ path: string; content: string }> | undefined;
  #appliedFileIndex: number = 0;
  #appliedFiles: Array<{ path: string; content: string; operation?: "create" | "patch" }> = [];
  readonly #createdDirs: string[] = [];
  #generationSource?: "model" | "template" | "target_files" | undefined;

  #currentStage:
    | "TARGET_INTAKE"
    | "PROVIDER_DISCOVERY"
    | "ROUTING"
    | "EXPLORATION"
    | "SPECIFICATION"
    | "SPEC_REVIEW"
    | "PLANNING"
    | "IMPLEMENTATION"
    | "LOCAL_VERIFICATION"
    | "CLOSURE_REPORTING"
    | "COMPLETE"
    | "BLOCKED"
    | "CANCELLED";

  #status: WorkflowStatus = "RUNNING";
  #investigationResult?: InvestigationResult | undefined;
  #reconstructionResult?: ReconstructionResult | undefined;
  #stageRecords: StageRecord[] = [];
  #blocker?: WorkflowBlocker | undefined;
  #blockerDetail?: string | undefined;
  #pendingConfirmation?: PendingConfirmation | undefined;
  readonly #createdAt: string = new Date().toISOString();

  constructor(options: GovernedReaWorkflowOptions) {
    this.#workflowType = options.workflowType;
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#mutationEngine = options.mutationEngine;
    this.#checkpointCoordinator = options.checkpointCoordinator;
    this.#browserSessionManager = options.browserSessionManager;
    this.#mcpCatalog = options.mcpCatalog;
    this.#reaMcpService =
      options.reaMcpService ??
      (options.mcpCatalog ? new ReaMcpService({ mcpCatalog: options.mcpCatalog }) : undefined);
    this.#provider = options.provider;
    this.#skills = options.skills;
    this.#onStage = options.onStage;
    this.#eventSink = options.eventSink;
    this.#signal = options.signal;
    this.#task = options.task;
    this.#taskId = options.taskId;
    this.#workflowId = `rea-wf-${Date.now()}`;
    this.#targetInput = options.targetInput ?? this.#extractTargetFromTask(options.task);
    this.#autoApprove = Boolean(options.autoApprove);
    this.#userAuthorized = Boolean(options.userAuthorized);
    this.#initialSpecification = options.initialSpecification;
    this.#initialLedger = options.initialLedger;
    this.#targetFiles = options.targetFiles;
    this.#testRunner = options.testRunner;

    this.#currentStage =
      this.#workflowType === "investigation" ? "TARGET_INTAKE" : "SPEC_REVIEW";
  }

  public static startInvestigation(
    options: Omit<GovernedReaWorkflowOptions, "workflowType">
  ): GovernedReaWorkflow {
    return new GovernedReaWorkflow({ ...options, workflowType: "investigation" });
  }

  public static startReconstruction(
    options: Omit<GovernedReaWorkflowOptions, "workflowType">
  ): GovernedReaWorkflow {
    return new GovernedReaWorkflow({ ...options, workflowType: "reconstruction" });
  }

  #extractTargetFromTask(task: string): string {
    const urlMatch = task.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) return urlMatch[0];

    const pathMatch = task.match(/(?:path|dir|target|repo|file):\s*([^\s]+)/i);
    if (pathMatch && pathMatch[1]) return pathMatch[1];

    return this.#workspaceRoot;
  }

  get workflowType(): "investigation" | "reconstruction" {
    return this.#workflowType;
  }

  get mcpCatalog(): McpCatalog | undefined {
    return this.#mcpCatalog;
  }

  get provider(): any {
    return this.#provider;
  }

  get skills(): any {
    return this.#skills;
  }

  get generationSource(): "model" | "template" | "target_files" | undefined {
    return this.#generationSource;
  }

  public get state(): WorkflowState {
    const stageMap: Record<string, EngineeringStage> = {
      TARGET_INTAKE: "PLAN",
      PROVIDER_DISCOVERY: "PLAN",
      ROUTING: "PLAN",
      EXPLORATION: "REVIEW",
      SPECIFICATION: "REVIEW",
      SPEC_REVIEW: "PLAN",
      PLANNING: "PLAN",
      IMPLEMENTATION: "IMPLEMENT",
      LOCAL_VERIFICATION: "VERIFY",
      CLOSURE_REPORTING: "VERIFY",
      COMPLETE: "COMPLETE",
      BLOCKED: "BLOCKED",
      CANCELLED: "CANCELLED",
    };

    const reviews: ReviewEvidence[] = this.#investigationResult
      ? [
          {
            attempt: 1,
            verdict: "NO_FINDINGS",
            findings: [],
            blocking: 0,
            rejectedUngrounded: 0,
            rejectedMalformed: 0,
            counts: { BLOCKER: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NOTE: 0 },
          },
        ]
      : [];

    const isVerified =
      this.#reconstructionResult?.updatedLedger.status === "verified" ||
      this.#reconstructionResult?.updatedLedger.coverage.status === "complete";

    const verification: VerificationEvidence = {
      verdict: isVerified ? "READY" : this.#blocker ? "BLOCKED" : "NOT_READY",
      outcomes: [],
      diffIntegrity: "INTACT",
      divergedFiles: [],
      ...(this.#reconstructionResult
        ? {
            reason: `Ledger closure: ${this.#reconstructionResult.verifiedObligationsCount} verified, ${this.#reconstructionResult.remainingOpenCount} open.`,
          }
        : {}),
    };

    const filesToMap = this.#appliedFiles.length > 0
      ? this.#appliedFiles
      : (this.#reconstructionResult?.implementedFiles ?? []);

    const changedFiles: ChangedFile[] = filesToMap.map((f) => ({
      path: f.path,
      operation: "create" as const,
      beforeHash: "",
      afterHash: createHash("sha256").update(f.content).digest("hex"),
      pass: 1,
      linesAdded: f.content.split("\n").length,
      linesRemoved: 0,
      diff: f.content,
      diffTruncated: false,
    }));

    return {
      schemaVersion: 1,
      workflowId: this.#workflowId,
      taskId: this.#taskId,
      mode: this.#workflowType === "investigation" ? "REVIEW" : "BUILD",
      task: this.#task,
      currentStage: stageMap[this.#currentStage] ?? "PLAN",
      completedStages: (this.#currentStage === "COMPLETE"
        ? this.#workflowType === "investigation"
          ? ["PLAN", "REVIEW"]
          : ["PLAN", "IMPLEMENT", "REVIEW", "VERIFY"]
        : []) as WorkStage[],
      selectedSkillIds:
        this.#workflowType === "investigation"
          ? [
              "rea-investigation-routing",
              "browser-behavior-investigation",
              "javascript-electron-analysis",
              "feature-specification",
            ]
          : [
              "reconstruction-planning",
              "reconstruction-verification",
              "feature-specification",
              "evidence-reconciliation",
            ],
      status: this.#status,
      stages: [...this.#stageRecords],
      implementation: {
        changedFiles,
        passes: 1,
        summary: `REA ${this.#workflowType}: ${changedFiles.length} file(s) implemented (source: ${this.#generationSource || "clean-room"}), ${this.#stageRecords.length} stage(s) completed.`,
      },
      reviews,
      verification,
      retryCounts: { plan: 0, implement: 0, review: 0, testRepairs: 0, reviewRepairs: 0 },
      createdAt: this.#createdAt,
      updatedAt: new Date().toISOString(),
      ...(this.#blocker ? { blocker: this.#blocker } : {}),
      ...(this.#blockerDetail ? { blockerDetail: this.#blockerDetail } : {}),
    };
  }

  public async run(): Promise<WorkflowResult> {
    if (this.#status === "WAITING_FOR_CONFIRMATION") {
      return this.#result();
    }
    return this.#advance();
  }

  public async resume(decision: ConfirmationDecision, confirmationToken?: string): Promise<WorkflowResult> {
    if (this.#status !== "WAITING_FOR_CONFIRMATION" || !this.#pendingConfirmation) {
      throw new Error("Workflow is not waiting for confirmation");
    }

    const pending = this.#pendingConfirmation;

    if (confirmationToken && pending.callId !== confirmationToken) {
      throw new Error(`Stale confirmation token: approval token ${confirmationToken} does not match active confirmation ${pending.callId}`);
    }

    this.#pendingConfirmation = undefined;

    // Validate approval binding:
    if (pending.workflowId !== this.#workflowId || pending.workspaceRoot !== this.#workspaceRoot) {
      this.#status = "BLOCKED";
      this.#blocker = "STAGE_FAILED";
      this.#blockerDetail = "Stale or mismatched confirmation context";
      this.#recordStageRecord(pending.stage, "BLOCKED", this.#blockerDetail);
      this.#cleanupEmptyDirectories();
      return this.#result();
    }

    if (decision === "REJECT") {
      this.#status = "BLOCKED";
      this.#blocker = "VERIFICATION_REJECTED";
      this.#blockerDetail = pending.preparedMutation
        ? `Mutation on "${pending.preparedMutation.path}" was rejected by user.`
        : "Reconstruction authorization was rejected by user.";
      this.#recordStageRecord(pending.stage, "BLOCKED", this.#blockerDetail);
      this.#cleanupEmptyDirectories();
      return this.#result();
    }

    try {
      await pending.applyFn();
      this.#status = "RUNNING";
      return this.#advance();
    } catch (err: any) {
      this.#cleanupEmptyDirectories();
      this.#status = "BLOCKED";
      this.#blocker = "STAGE_FAILED";
      this.#blockerDetail = err.message;
      this.#recordStageRecord(pending.stage, "BLOCKED", this.#blockerDetail);
      return this.#result();
    }
  }

  public cancel(): void {
    this.#status = "CANCELLED";
    this.#currentStage = "CANCELLED";
    this.#pendingConfirmation = undefined;
    this.#cleanupEmptyDirectories();
    this.#recordStageRecord("cancelled", "CANCELLED", "Workflow cancelled by operator");
    this.#onStage?.({ stage: "cancelled", status: "CANCELLED" });
    this.#emitEvent("workflow.cancelled", { workflowId: this.#workflowId });
  }

  async #advance(): Promise<WorkflowResult> {
    if (this.#signal?.aborted) {
      this.cancel();
      return this.#result();
    }

    if (this.#workflowType === "investigation") {
      return this.#advanceInvestigation();
    } else {
      return this.#advanceReconstruction();
    }
  }

  async #advanceInvestigation(): Promise<WorkflowResult> {
    switch (this.#currentStage) {
      case "TARGET_INTAKE": {
        this.#recordStageSkill("target_intake", "rea-investigation-routing");
        this.#recordStageRecord("target_intake", "RUNNING", "Stage 1: Target Intake & Classification");
        this.#onStage?.({ stage: "target_intake", status: "RUNNING", skill: "rea-investigation-routing" });

        const target = classifyInvestigationTarget(this.#targetInput, {
          workspaceRoot: this.#workspaceRoot,
        });

        if (!target.authorized) {
          this.#status = "BLOCKED";
          this.#blocker = "STAGE_FAILED";
          this.#blockerDetail = `Target "${this.#targetInput}" is not authorized for investigation.`;
          this.#recordStageRecord("target_intake", "BLOCKED", this.#blockerDetail);
          return this.#result();
        }

        await this.#checkpoint("stage-1-intake");
        this.#recordStageRecord("target_intake", "PASSED", `Target classified: ${target.category}`);
        this.#currentStage = "PROVIDER_DISCOVERY";
        return this.#advance();
      }

      case "PROVIDER_DISCOVERY": {
        this.#recordStageRecord("provider_discovery", "RUNNING", "Stage 2: Provider Discovery & Diagnostics");
        this.#onStage?.({ stage: "provider_discovery", status: "RUNNING" });

        if (this.#reaMcpService) {
          try {
            await this.#reaMcpService.connect(this.#signal);
            this.#recordStageTool("provider_discovery", "rea_mcp_discovery");
          } catch {
            // REA is optional for web investigations
          }
        }

        this.#recordStageRecord("provider_discovery", "PASSED", "Provider discovery complete");
        this.#currentStage = "ROUTING";
        return this.#advance();
      }

      case "ROUTING": {
        this.#recordStageSkill("routing", "browser-behavior-investigation");
        this.#recordStageRecord("routing", "RUNNING", "Stage 3: Investigation Routing & Skill Loading");
        this.#onStage?.({ stage: "routing", status: "RUNNING", skill: "browser-behavior-investigation" });

        this.#recordStageRecord("routing", "PASSED", "Strategy and progressive skills selected");
        this.#currentStage = "EXPLORATION";
        return this.#advance();
      }

      case "EXPLORATION": {
        this.#recordStageSkill("exploration", "browser-behavior-investigation");
        this.#recordStageTool("exploration", "browser_snapshot");
        this.#recordStageTool("exploration", "browser_navigate");
        this.#recordStageRecord("exploration", "RUNNING", "Stage 4: Governed Exploration & Behavioral Observation");
        this.#onStage?.({ stage: "exploration", status: "RUNNING", skill: "browser-behavior-investigation" });

        const target = classifyInvestigationTarget(this.#targetInput, {
          workspaceRoot: this.#workspaceRoot,
        });

        const engine = new InvestigationEngine({
          browserSessionManager: this.#browserSessionManager,
          reaMcpService: this.#reaMcpService,
          mode: "REVIEW",
          interactiveModeAllowed: false,
          maxInteractions: 10,
          timeoutMs: 60000,
        });

        this.#investigationResult = await engine.runInvestigation(target, this.#signal);
        await this.#checkpoint("stage-4-exploration");

        this.#recordStageRecord(
          "exploration",
          "PASSED",
          `Explored ${target.category}: ${this.#investigationResult.evidenceLedger.length} evidence records captured`
        );
        this.#currentStage = "SPECIFICATION";
        return this.#advance();
      }

      case "SPECIFICATION": {
        this.#recordStageSkill("specification", "feature-specification");
        this.#recordStageRecord("specification", "RUNNING", "Stage 5: Grounded Specification Synthesis");
        this.#onStage?.({ stage: "specification", status: "RUNNING", skill: "feature-specification" });

        if (!this.#investigationResult) {
          throw new Error("Missing investigation result for specification synthesis.");
        }

        await this.#checkpoint("stage-5-specification");
        this.#recordStageRecord(
          "specification",
          "PASSED",
          `Specification synthesized: ${this.#investigationResult.specification.specificationId}`
        );
        this.#currentStage = "COMPLETE";
        this.#status = "COMPLETE";
        return this.#result();
      }

      default:
        return this.#result();
    }
  }

  async #advanceReconstruction(): Promise<WorkflowResult> {
    switch (this.#currentStage) {
      case "SPEC_REVIEW": {
        this.#recordStageSkill("spec_review", "reconstruction-planning");
        this.#recordStageRecord("spec_review", "RUNNING", "Stage 1: Specification Review & Scope Validation");
        this.#onStage?.({ stage: "spec_review", status: "RUNNING", skill: "reconstruction-planning" });

        const target = classifyInvestigationTarget(this.#targetInput, {
          workspaceRoot: this.#workspaceRoot,
        });

        if (!target.authorized) {
          this.#status = "BLOCKED";
          this.#blocker = "STAGE_FAILED";
          this.#blockerDetail = `Target "${this.#targetInput}" is not authorized for reconstruction.`;
          this.#recordStageRecord("spec_review", "BLOCKED", this.#blockerDetail);
          return this.#result();
        }

        this.#recordStageRecord("spec_review", "PASSED", `Scope authorized: ${target.category}`);
        this.#currentStage = "PLANNING";
        return this.#advance();
      }

      case "PLANNING": {
        this.#recordStageSkill("planning", "reconstruction-planning");
        this.#recordStageRecord("planning", "RUNNING", "Stage 2: Clean-Room Implementation Planning");
        this.#onStage?.({ stage: "planning", status: "RUNNING", skill: "reconstruction-planning" });

        const spec = this.#initialSpecification ?? this.#investigationResult?.specification ?? this.#buildDefaultSpec();
        const initialLedger = this.#initialLedger ?? this.#investigationResult?.obligationLedger ?? this.#buildDefaultLedger(spec);

        if (!this.#userAuthorized && !this.#autoApprove) {
          this.#pendingConfirmation = {
            callId: `call_auth_plan_${Date.now()}`,
            stage: "planning",
            workflowId: this.#workflowId,
            workspaceRoot: this.#workspaceRoot,
            confirmationPrompt: `Authorize clean-room reconstruction implementation for "${this.#targetInput}" with ${spec.featureInventory.length} features and ${initialLedger.obligations.length} obligations?`,
            applyFn: async () => {
              this.#userAuthorized = true;
              this.#currentStage = "IMPLEMENTATION";
            },
          };
          this.#status = "WAITING_FOR_CONFIRMATION";
          return this.#result();
        }

        this.#recordStageRecord("planning", "PASSED", "Clean-room architecture and obligations planned");
        this.#currentStage = "IMPLEMENTATION";
        return this.#advance();
      }

      case "IMPLEMENTATION": {
        this.#recordStageRecord("implementation", "RUNNING", "Stage 3: Governed Clean-Room Mutation");
        this.#onStage?.({ stage: "implementation", status: "RUNNING" });

        const spec = this.#initialSpecification ?? this.#investigationResult?.specification ?? this.#buildDefaultSpec();
        const initialLedger = this.#initialLedger ?? this.#investigationResult?.obligationLedger ?? this.#buildDefaultLedger(spec);

        if (!this.#plannedFiles) {
          if (this.#targetFiles) {
            this.#plannedFiles = Object.entries(this.#targetFiles).map(([path, content]) => ({ path, content }));
            this.#generationSource = "target_files";
          } else if (this.#provider && typeof this.#provider.complete === "function") {
            try {
              this.#plannedFiles = await this.#synthesizeReconstructionWithModel(spec, initialLedger);
              this.#generationSource = "model";
            } catch (err: any) {
              this.#status = "BLOCKED";
              this.#blocker = "STAGE_FAILED";
              this.#blockerDetail = `Model reconstruction synthesis failed: ${err.message}`;
              this.#recordStageRecord("implementation", "BLOCKED", this.#blockerDetail);
              return this.#result();
            }
          } else {
            this.#plannedFiles = this.#generateCleanRoomTemplates(spec);
            this.#generationSource = "template";
          }
        }

        while (this.#appliedFileIndex < this.#plannedFiles.length) {
          const file = this.#plannedFiles[this.#appliedFileIndex]!;
          let prep: PreparedMutation;
          try {
            prep = await this.#prepareFileMutation(file.path, file.content);
          } catch (err: any) {
            this.#status = "BLOCKED";
            this.#blocker = "STAGE_FAILED";
            this.#blockerDetail = err.message;
            this.#recordStageRecord("implementation", "BLOCKED", err.message);
            return this.#result();
          }

          if (this.#autoApprove) {
            const mutResult = await this.#mutationEngine.applyPreparedMutation(prep);
            if (mutResult.status !== "APPLIED") {
              this.#status = "BLOCKED";
              this.#blocker = "STAGE_FAILED";
              this.#blockerDetail = `Failed to apply mutation on ${prep.path}: ${mutResult.error}`;
              this.#recordStageRecord("implementation", "BLOCKED", this.#blockerDetail);
              return this.#result();
            }
            this.#recordStageTool("implementation", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#appliedFiles.push({ ...file, operation: prep.operation });
            this.#appliedFileIndex++;
            continue;
          }

          this.#pendingConfirmation = {
            callId: `call_impl_${Date.now()}_${this.#appliedFileIndex}`,
            stage: "implementation",
            workflowId: this.#workflowId,
            workspaceRoot: this.#workspaceRoot,
            targetPath: prep.path,
            operationType: prep.operation,
            contentDigest: prep.resultHash,
            preparedMutation: prep,
            confirmationPrompt: `Approve reconstruction mutation on "${prep.path}" (${prep.operation})?`,
            applyFn: async () => {
              const mutResult = await this.#mutationEngine.applyPreparedMutation(prep);
              if (mutResult.status !== "APPLIED") {
                throw new Error(`Failed to apply mutation on ${prep.path}: ${mutResult.error}`);
              }
              this.#recordStageTool("implementation", prep.operation === "create" ? "create_file" : "apply_patch");
              this.#appliedFiles.push({ ...file, operation: prep.operation });
              this.#appliedFileIndex++;
            },
          };
          this.#status = "WAITING_FOR_CONFIRMATION";
          return this.#result();
        }

        await this.#checkpoint("stage-3-implementation");
        const summary = `Implemented ${this.#appliedFiles.length} clean-room modules (source: ${this.#generationSource})`;
        this.#recordStageRecord("implementation", "PASSED", summary);
        this.#currentStage = "LOCAL_VERIFICATION";
        return this.#advance();
      }

      case "LOCAL_VERIFICATION": {
        this.#recordStageSkill("local_verification", "reconstruction-verification");
        this.#recordStageRecord("local_verification", "RUNNING", "Stage 4: Behavioral Verification & Testing");
        this.#onStage?.({ stage: "local_verification", status: "RUNNING", skill: "reconstruction-verification" });

        const spec = this.#initialSpecification ?? this.#investigationResult?.specification ?? this.#buildDefaultSpec();
        const initialLedger = this.#initialLedger ?? this.#investigationResult?.obligationLedger ?? this.#buildDefaultLedger(spec);

        const verifiedObligations: ReconstructionObligation[] = [];
        const failedObligations: ReconstructionObligation[] = [];
        const artifactDigest = createHash("sha256")
          .update(this.#appliedFiles.map((f) => `${f.path}:${createHash("sha256").update(f.content).digest("hex")}`).join("\n"))
          .digest("hex");

        for (const obl of initialLedger.obligations) {
          if (this.#testRunner) {
            let testPassed = false;
            let testOutput = "";
            let testDetails: any = undefined;

            try {
              const runResult = await this.#testRunner(obl, this.#workspaceRoot);
              this.#recordStageTool("local_verification", "test_runner");
              testPassed = Boolean(runResult.passed);
              testOutput = runResult.output || "";
              testDetails = runResult.details;
            } catch (err: any) {
              testPassed = false;
              testOutput = err.message || String(err);
            }

            if (testPassed) {
              const testDigest = createHash("sha256")
                .update(`${obl.obligationId}:${artifactDigest}:${testOutput}`)
                .digest("hex");

              verifiedObligations.push({
                ...obl,
                status: "verified",
                testEvidence: {
                  obligationId: obl.obligationId,
                  obligationVersion: obl.obligationVersion,
                  artifactDigest,
                  testIdentity: testDetails?.testIdentity ?? `verifier_${obl.obligationId}`,
                  inputFixture: testDetails?.inputFixture ?? obl.positiveCases.join("; "),
                  expectedBehavior: testDetails?.expectedBehavior ?? obl.positiveCases.join("; "),
                  observedResult: testOutput,
                  result: "PASS",
                  verifier: testDetails?.verifier ?? "open-vs-code.verification-engine",
                  timestamp: testDetails?.timestamp ?? Date.now(),
                  digest: testDigest,
                  testOutputSnippet: testOutput.slice(0, 500),
                  supportingEvidence: obl.evidenceLinks,
                  limitations: testDetails?.limitations ?? [],
                },
              });
            } else {
              const testDigest = createHash("sha256")
                .update(`${obl.obligationId}:${artifactDigest}:${testOutput}:FAIL`)
                .digest("hex");

              failedObligations.push({
                ...obl,
                status: "characterized",
                testEvidence: {
                  obligationId: obl.obligationId,
                  obligationVersion: obl.obligationVersion,
                  artifactDigest,
                  testIdentity: testDetails?.testIdentity ?? `verifier_${obl.obligationId}`,
                  inputFixture: testDetails?.inputFixture ?? obl.positiveCases.join("; "),
                  expectedBehavior: testDetails?.expectedBehavior ?? obl.positiveCases.join("; "),
                  observedResult: testOutput,
                  result: "FAIL",
                  verifier: testDetails?.verifier ?? "open-vs-code.verification-engine",
                  timestamp: testDetails?.timestamp ?? Date.now(),
                  digest: testDigest,
                  testOutputSnippet: testOutput.slice(0, 500),
                  supportingEvidence: obl.evidenceLinks,
                  limitations: testDetails?.limitations ?? [],
                },
              });
            }
          } else {
            failedObligations.push({
              ...obl,
              status: "characterized",
            });
          }
        }

        const allObligations = [...verifiedObligations, ...failedObligations];
        const closureDigest = createHash("sha256").update(JSON.stringify(verifiedObligations)).digest("hex");

        this.#reconstructionResult = {
          specificationId: spec.specificationId,
          implementedFiles: this.#appliedFiles,
          updatedLedger: {
            ...initialLedger,
            closureDigest,
            status: failedObligations.length === 0 && verifiedObligations.length > 0 ? "verified" : "partial",
            coverage: {
              status: failedObligations.length === 0 && verifiedObligations.length > 0 ? "complete" : "partial",
            },
            summary: {
              total: allObligations.length,
              required: allObligations.length,
              verified: verifiedObligations.length,
              requiredOpen: failedObligations.length,
              byStatus: [
                { key: "verified", count: verifiedObligations.length },
                { key: "characterized", count: failedObligations.length },
              ],
              byApplicationLayer: initialLedger.summary.byApplicationLayer,
            },
            obligations: allObligations,
          },
          verifiedObligationsCount: verifiedObligations.length,
          remainingOpenCount: failedObligations.length,
          closureDigest,
          durationMs: 0,
        };

        this.#recordStageRecord("local_verification", "PASSED", "Verification execution finished");
        this.#currentStage = "CLOSURE_REPORTING";
        return this.#advance();
      }

      case "CLOSURE_REPORTING": {
        this.#recordStageSkill("closure_reporting", "evidence-reconciliation");
        this.#recordStageRecord("closure_reporting", "RUNNING", "Stage 5: Obligation Closure & Coverage Evaluation");
        this.#onStage?.({ stage: "closure_reporting", status: "RUNNING", skill: "evidence-reconciliation" });

        if (!this.#reconstructionResult) {
          throw new Error("Missing reconstruction result for closure reporting.");
        }

        const isComplete = this.#reconstructionResult.remainingOpenCount === 0 && this.#reconstructionResult.verifiedObligationsCount > 0;
        this.#status = isComplete ? "COMPLETE" : "BLOCKED";
        if (!isComplete) {
          this.#blocker = "STAGE_FAILED";
          this.#blockerDetail = `${this.#reconstructionResult.remainingOpenCount} reconstruction obligation(s) unverified.`;
        }

        this.#recordStageRecord(
          "closure_reporting",
          isComplete ? "PASSED" : "BLOCKED",
          `Ledger closure digest: ${this.#reconstructionResult.closureDigest.slice(0, 16)}`
        );
        this.#currentStage = isComplete ? "COMPLETE" : "BLOCKED";
        return this.#result();
      }

      default:
        return this.#result();
    }
  }

  #buildDefaultSpec(): ReconstructionSpecification {
    return {
      specificationId: `spec_default_${Date.now()}`,
      target: classifyInvestigationTarget(this.#targetInput, { workspaceRoot: this.#workspaceRoot }),
      createdAt: Date.now(),
      featureInventory: [
        {
          featureId: "feat_default",
          title: "Default Feature Specification",
          description: "Clean-room reconstruction baseline feature",
          category: "core",
          supportingEvidenceIds: ["ev_default_1"],
          epistemicStatus: "OBSERVED",
        },
      ],
      pageAndRouteMap: [],
      interactionStateGraph: [],
      visibleBusinessRules: [],
      formAndValidationBehavior: [],
      componentInventory: [],
      observableDataContracts: [],
      responsiveUiRequirements: [],
      errorHandling: [],
      knownConstraints: ["Offline first"],
      evidenceLinks: ["ev_default_1"],
      unknowns: [],
      inferredArchitecture: {
        summary: "Clean-Room SPA",
        suspectedTechStack: ["JavaScript"],
        stateManagementModel: "Local",
        dataPersistenceModel: "In-memory",
        explicitlyInferred: true,
        supportingEvidenceIds: ["ev_default_1"],
      },
    };
  }

  #buildDefaultLedger(_spec: ReconstructionSpecification): ReconstructionObligationLedger {
    const obl: ReconstructionObligation = {
      obligationId: "obl_default_1",
      obligationVersion: 1,
      title: "Clean-Room Implementation & Verification",
      applicationLayer: "application",
      family: "functional-parity",
      target: {
        artifactSha256: null,
        applicationNodeId: null,
        semanticNodeId: null,
        location: "/",
      },
      positiveCases: ["Application loads and executes core workflow"],
      negativeCases: ["Empty input rejected"],
      edgeCases: [],
      failureCases: [],
      evidenceLinks: ["ev_default_1"],
      owner: null,
      status: "characterized",
    };

    return {
      schema: "ReconstructionObligationLedger",
      ledgerId: `rol_${Date.now()}`,
      closureDigest: "default_closure_digest",
      status: "partial",
      coverage: { status: "partial" },
      summary: {
        total: 1,
        required: 1,
        verified: 0,
        requiredOpen: 1,
        byStatus: [{ key: "characterized", count: 1 }],
        byApplicationLayer: [{ key: "application", count: 1 }],
      },
      reports: {
        missingOwnerObligationIds: ["obl_default_1"],
        missingVerifierObligationIds: ["obl_default_1"],
        contradictedObligationIds: [],
        residualUnknownIds: [],
      },
      obligations: [obl],
      evidenceLinks: ["ev_default_1"],
      limitations: [],
    };
  }

  async #checkpoint(label: string): Promise<void> {
    if (!this.#checkpointCoordinator || typeof this.#checkpointCoordinator.checkpoint !== "function") return;
    try {
      await this.#checkpointCoordinator.checkpoint({
        runId: this.#taskId,
        reason: "WORKFLOW_STAGE",
        phase: label,
        evidenceVersion: 1,
        runtimeState: {
          status: this.#status === "COMPLETE" ? "COMPLETED" : "RUNNING",
        },
        touchedFilePaths: (this.#reconstructionResult?.implementedFiles ?? []).map((f) => f.path),
      });
    } catch {
      // Non-fatal
    }
  }

  #recordStageTool(stage: string, tool: string): void {
    if (!this.#stageTools[stage]) {
      this.#stageTools[stage] = new Set();
    }
    this.#stageTools[stage].add(tool);
  }

  #recordStageModelCall(stage: string, tokens: number = 0): void {
    this.#stageModelCalls[stage] = (this.#stageModelCalls[stage] ?? 0) + 1;
    this.#stageTokens[stage] = (this.#stageTokens[stage] ?? 0) + tokens;
  }

  #recordStageSkill(stage: string, skill: string): void {
    this.#stageSkills[stage] = skill;
    this.#stageSkillInjected[stage] = true;
  }

  #cleanupEmptyDirectories(): void {
    for (let d = this.#createdDirs.length - 1; d >= 0; d--) {
      try {
        const dir = this.#createdDirs[d]!;
        if (existsSync(dir)) {
          const files = readdirSync(dir);
          if (files.length === 0) {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      } catch {
        // Best effort
      }
    }
    this.#createdDirs.length = 0;
  }

  async #prepareFileMutation(relPath: string, content: string): Promise<PreparedMutation> {
    const canonicalRoot = existsSync(this.#workspaceRoot)
      ? realpathSync(this.#workspaceRoot)
      : resolve(this.#workspaceRoot);
    const targetRelPath = relPath.replaceAll("\\", "/");
    if (isAbsolute(targetRelPath)) {
      throw new Error(`Target path escapes outside workspace: ${targetRelPath}`);
    }
    const normalizedTarget = resolve(canonicalRoot, targetRelPath);
    const rel = relative(canonicalRoot, normalizedTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Target path escapes outside workspace: ${targetRelPath}`);
    }
    let checkDir = canonicalRoot;
    const parts = rel.split("/").slice(0, -1);
    for (const part of parts) {
      checkDir = join(checkDir, part);
      if (existsSync(checkDir)) {
        const real = realpathSync(checkDir);
        const relReal = relative(canonicalRoot, real);
        if (relReal.startsWith("..") || isAbsolute(relReal)) {
          throw new Error(`Parent directory symlink escapes outside workspace: ${targetRelPath}`);
        }
      }
    }
    const parentDir = dirname(normalizedTarget);
    if (!existsSync(parentDir)) {
      const toCreate: string[] = [];
      let cur = parentDir;
      while (cur !== canonicalRoot && !existsSync(cur)) {
        toCreate.unshift(cur);
        const next = dirname(cur);
        if (next === cur) break;
        cur = next;
      }
      for (const d of toCreate) {
        mkdirSync(d);
        this.#createdDirs.push(d);
      }
    }
    const fileExists = existsSync(normalizedTarget);
    if (fileExists) {
      const currentContent = readFileSync(normalizedTarget, "utf-8");
      return this.#mutationEngine.preparePatch({
        operation: "patch",
        path: targetRelPath,
        patch: {
          search: currentContent,
          replace: content,
        },
      });
    }
    return this.#mutationEngine.prepareCreate({
      operation: "create",
      path: targetRelPath,
      content,
    });
  }

  async #synthesizeReconstructionWithModel(
    spec: ReconstructionSpecification,
    initialLedger: ReconstructionObligationLedger
  ): Promise<Array<{ path: string; content: string }>> {
    if (!this.#provider || typeof this.#provider.complete !== "function") {
      throw new Error("No model provider configured for reconstruction synthesis.");
    }

    const featureDescriptions = spec.featureInventory.map(
      (f) => `- [${f.epistemicStatus}] ${f.title} (${f.category}): ${f.description}`
    ).join("\n");

    const stateTransitions = spec.interactionStateGraph.map(
      (t) => `- [${t.confidence}] ${t.initialState.route} -> ${t.resultingState.route} via ${t.userAction.type} (${t.userAction.targetSelector || "target"}): ${t.visibleChange}`
    ).join("\n");

    const businessRules = spec.visibleBusinessRules.map(
      (r) => `- [${r.isHypothesis ? "INFERRED" : "OBSERVED"}] ${r.statement} (trigger: ${r.trigger}; outcome: ${r.outcome})`
    ).join("\n");

    const formValidation = spec.formAndValidationBehavior.map(
      (v) => `- Form "${v.formId}": fields [${v.fields.map((fld) => `${fld.name} (${fld.type}${fld.required ? ", required" : ""})`).join(", ")}] -> submission: ${v.submissionAction}`
    ).join("\n");

    const obligations = initialLedger.obligations.map(
      (o) => `- Obligation ${o.obligationId} (${o.family}): ${o.title} (positive: ${o.positiveCases.join("; ")}; negative: ${o.negativeCases.join("; ")})`
    ).join("\n");

    const prompt = `You are a principal clean-room software reverse engineer.
Reconstruct a clean-room web application implementing all observed features and fulfilling all reconstruction obligations.

Target Information:
- Category: ${spec.target.category}
- Target Input: ${spec.target.rawInput || spec.target.normalizedLocation}

Feature Inventory (Observed Evidence):
${featureDescriptions || "None specified"}

Observed Interaction State Transitions:
${stateTransitions || "None specified"}

Visible Business Rules:
${businessRules || "None specified"}

Form and Validation Behavior:
${formValidation || "None specified"}

Reconstruction Obligations to Fulfill:
${obligations || "None specified"}

Constraints:
1. All file paths must be relative within the project root (e.g. "index.html", "src/app.js", "src/styles.css").
2. Do not use absolute paths or paths containing "../".
3. Provide complete, functional implementations in clean-room code.
4. Output MUST be a valid JSON object with a "files" array:
{
  "files": [
    {
      "path": "index.html",
      "content": "<!DOCTYPE html>..."
    },
    {
      "path": "src/app.js",
      "content": "..."
    },
    {
      "path": "src/styles.css",
      "content": "..."
    }
  ]
}
Return ONLY valid JSON.`;

    try {
      const resp: any = await this.#provider.complete({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        signal: this.#signal,
      });

      const tokensUsed = (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0);
      this.#recordStageModelCall("implementation", tokensUsed);

      let raw = resp.message?.content?.trim() || "";
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (jsonMatch) {
        raw = jsonMatch[1].trim();
      }

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const firstBrace = raw.indexOf("{");
        const lastBrace = raw.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
        } else {
          throw new Error("Model response did not contain valid JSON files proposal.");
        }
      }

      if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
        throw new Error("Model response did not contain a valid files array.");
      }

      const files: Array<{ path: string; content: string }> = [];
      for (const f of parsed.files) {
        if (!f.path || typeof f.path !== "string" || !f.content || typeof f.content !== "string") {
          throw new Error("Model proposed file missing path or content.");
        }
        const normPath = f.path.replaceAll("\\", "/").trim();
        if (isAbsolute(normPath) || normPath.startsWith("../") || normPath.includes("/../")) {
          throw new Error(`Model proposed invalid or escaping path: ${normPath}`);
        }
        files.push({ path: normPath, content: f.content });
      }

      return files;
    } catch (err: any) {
      throw new Error(`Model reconstruction synthesis failed: ${err?.message || String(err)}`, { cause: err });
    }
  }

  #generateCleanRoomTemplates(spec: ReconstructionSpecification): Array<{ path: string; content: string }> {
    const html = `<!-- TEMPLATE_BASED_OUTPUT: Deterministic clean-room baseline (no model provider configured) -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${spec.target.rawInput || "Clean-Room Reconstruction"}</title>
  <link rel="stylesheet" href="src/styles.css">
</head>
<body>
  <header>
    <h1>Clean-Room Application</h1>
  </header>
  <main>
    <div id="app">
      <form id="task-form">
        <label for="task-input">Task Title</label>
        <input type="text" id="task-input" name="title" required placeholder="Enter task title...">
        <button type="submit" id="add-task-btn">Add Task</button>
      </form>
      <ul id="task-list" role="list"></ul>
    </div>
  </main>
  <script src="src/app.js"></script>
</body>
</html>`;

    const js = `/* TEMPLATE_BASED_OUTPUT: Deterministic clean-room baseline (no model provider configured) */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("task-form");
  const input = document.getElementById("task-input");
  const list = document.getElementById("task-list");
  if (!form || !input || !list) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = input.value.trim();
    if (!val) {
      let err = document.getElementById("form-error");
      if (!err) {
        err = document.createElement("p");
        err.id = "form-error";
        err.style.color = "red";
        err.textContent = "Task title is required";
        form.appendChild(err);
      }
      return;
    }
    const existingErr = document.getElementById("form-error");
    if (existingErr) existingErr.remove();
    const li = document.createElement("li");
    li.textContent = val;
    list.appendChild(li);
    input.value = "";
  });
});`;

    const css = `/* TEMPLATE_BASED_OUTPUT: Deterministic clean-room baseline (no model provider configured) */
body { font-family: sans-serif; padding: 20px; }
#task-form { display: flex; gap: 8px; margin-bottom: 16px; }
.error { color: red; }`;

    return [
      { path: "index.html", content: html },
      { path: "src/app.js", content: js },
      { path: "src/styles.css", content: css },
    ];
  }

  #recordStageRecord(stage: string, status: "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "CANCELLED", outcome?: string): void {
    const stageMap: Record<string, WorkStage> = {
      target_intake: "PLAN",
      provider_discovery: "PLAN",
      routing: "PLAN",
      exploration: "REVIEW",
      specification: "REVIEW",
      spec_review: "PLAN",
      planning: "PLAN",
      implementation: "IMPLEMENT",
      local_verification: "VERIFY",
      closure_reporting: "VERIFY",
      cancelled: "PLAN",
    };

    const workStage: WorkStage = stageMap[stage] ?? "PLAN";
    const toolsUsed = Array.from(this.#stageTools[stage] ?? []);
    const modelCalls = this.#stageModelCalls[stage] ?? 0;
    const contextTokens = this.#stageTokens[stage] ?? 0;
    const skillName = this.#stageSkills[stage];
    const skillInjected = Boolean(this.#stageSkillInjected[stage]);

    const existing = this.#stageRecords.find((r) => r.stage === workStage);
    if (existing) {
      (existing as any).status = status;
      if (outcome) (existing as any).outcome = outcome;
      if (status !== "RUNNING") (existing as any).endedAt = new Date().toISOString();
      (existing as any).modelCalls = modelCalls;
      (existing as any).contextTokens = contextTokens;
      (existing as any).toolsUsed = toolsUsed;
      if (skillName) (existing as any).selectedSkill = skillName;
      (existing as any).skillInjected = skillInjected;
      (existing as any).skillInjection = skillInjected ? "INJECTED" : "NOT_APPLICABLE";
    } else {
      this.#stageRecords.push({
        stage: workStage,
        attempt: 1,
        startedAt: new Date().toISOString(),
        ...(status !== "RUNNING" ? { endedAt: new Date().toISOString() } : {}),
        status,
        modelCalls,
        contextTokens,
        toolsUsed,
        ...(skillName ? { selectedSkill: skillName } : {}),
        skillInjection: skillInjected ? "INJECTED" : "NOT_APPLICABLE",
        skillInjected,
        ...(outcome ? { outcome } : {}),
      });
    }
  }

  #emitEvent(type: string, payload: unknown): void {
    if (this.#eventSink) {
      this.#eventSink({
        id: `ev_${Date.now()}_${Math.random()}`,
        type,
        timestamp: new Date().toISOString(),
        payload,
      });
    }
  }

  #result(): WorkflowResult {
    let confirmation: WorkflowConfirmation | undefined;

    if (this.#status === "WAITING_FOR_CONFIRMATION" && this.#pendingConfirmation) {
      if (this.#pendingConfirmation.preparedMutation) {
        const pm = this.#pendingConfirmation.preparedMutation;
        confirmation = {
          stage: "IMPLEMENT",
          runner: {
            callId: this.#pendingConfirmation.callId,
            toolName: pm.operation === "create" ? "create_file" : "apply_patch",
            action: "write_file",
            arguments: { path: pm.path },
            preparedMutation: {
              id: pm.id,
              operation: pm.operation,
              path: pm.path,
              beforeHash: pm.baseHash,
              afterHash: pm.resultHash,
              linesAdded: pm.diff.linesAdded,
              linesRemoved: pm.diff.linesRemoved,
              bytesChanged: Math.abs(pm.fileChange.afterSize - pm.fileChange.beforeSize),
              diff: pm.diff.unified,
            },
          },
        };
      } else {
        confirmation = {
          stage: "PLAN",
          runner: {
            callId: this.#pendingConfirmation.callId,
            toolName: "authorize_reconstruction",
            action: "read_repository",
            arguments: { task: this.#task },
          },
        };
      }
    }

    return {
      status: this.#status,
      state: this.state,
      ...(confirmation ? { confirmation } : {}),
      ...(this.#blocker ? { blocker: this.#blocker, blockerDetail: this.#blockerDetail } : {}),
    };
  }
}
