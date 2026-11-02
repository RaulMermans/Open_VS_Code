/**
 * Sprint 9C.1 — Governed Design Workflow Runtime Integration.
 *
 * Implements the 5-stage shape-before-build design workflow connected directly to the existing
 * AgentRuntime, AgentSessionBridge, MutationEngine, CheckpointCoordinator, and BrowserSessionManager.
 *
 * Stage A: Discover & Shape (Skill: design-direction)
 * Stage B: Design System (Skill: design-system-engineering)
 * Stage C: Frontend Implementation (Skill: frontend-composition)
 * Stage D: Motion Engineering (Skill: motion-engineering)
 * Stage E: Visual QA & Refinement Loop (Skills: visual-qa, accessibility-review, design-polish)
 *
 * Invariants (ADR-041 & Sprint 9C.1):
 *   - No second AgentRuntime or alternate planning loop.
 *   - Genuine file mutations routed through governed MutationEngine with permission confirmation.
 *   - Real in-browser evidence via BrowserSessionManager.observeVisualQaState().
 *   - Bounded improvement loop: defaults to maximum 3 iterations in Stage E.
 *   - Checkpoints recorded before/after mutations via CheckpointCoordinator.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowResult,
  WorkflowState,
  WorkflowStatus,
  WorkflowBlocker,
  EngineeringStage,
  WorkStage,
  ChangedFile,
  StageRecord,
  ReviewEvidence,
  VerificationEvidence,
} from "../workflow/contracts.ts";
import type { ConfirmationDecision } from "../agent/runner.ts";
import type { MutationEngine } from "../tools/mutation-engine.ts";
import type { PreparedMutation } from "../tools/mutation-contracts.ts";
import type { CheckpointCoordinator } from "../recovery/checkpoint-coordinator.ts";
import type { BrowserSessionManager } from "../browser/browser-session-manager.ts";
import type {
  DesignBrief,
  DesignTokenSet,
  VisualQAFinding,
  VisualQAReport,
} from "./contracts.ts";
import {
  deriveDesignTokensFromBrief,
  formatDesignDirectionDoc,
  formatDesignTokensAsCss,
  createDefaultDesignBrief,
} from "./design-brief.ts";
import { VisualQAEvaluator } from "./visual-qa-evaluator.ts";

export interface GovernedDesignWorkflowOptions {
  readonly workspaceRoot: string;
  readonly mutationEngine: MutationEngine;
  readonly checkpointCoordinator?: CheckpointCoordinator | undefined;
  readonly browserSessionManager?: BrowserSessionManager | undefined;
  readonly provider?: any;
  readonly onStage?: ((event: { stage: string; status: string; skill?: string }) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly task: string;
  readonly taskId: string;
  readonly brief?: DesignBrief | undefined;
  readonly targetUrl?: string | undefined;
  readonly maxImprovementIterations?: number | undefined;
  readonly componentFilePath?: string | undefined;
  readonly motionFilePath?: string | undefined;
  readonly tokensFilePath?: string | undefined;
  readonly autoApprove?: boolean | undefined;
  readonly skills?: any | undefined;
}

interface PendingConfirmation {
  readonly callId: string;
  readonly stage: string;
  readonly preparedMutation: PreparedMutation;
  readonly applyFn: () => Promise<void>;
}

export class GovernedDesignWorkflow {
  readonly #workspaceRoot: string;
  readonly #mutationEngine: MutationEngine;
  readonly #checkpointCoordinator?: CheckpointCoordinator | undefined;
  readonly #browserSessionManager?: BrowserSessionManager | undefined;
  readonly #onStage?: ((event: { stage: string; status: string; skill?: string }) => void) | undefined;
  readonly #signal?: AbortSignal | undefined;
  readonly #task: string;
  readonly #taskId: string;
  readonly #workflowId: string;
  readonly #brief: DesignBrief;
  readonly #targetUrl?: string | undefined;
  readonly #maxImprovementIterations: number;
  readonly #componentFilePath: string;
  readonly #motionFilePath: string;
  readonly #tokensFilePath: string;
  readonly #autoApprove: boolean;
  readonly #provider?: any | undefined;
  readonly #skills?: any | undefined;
  readonly #stageModelCalls: Record<string, number> = {};
  readonly #stageTokens: Record<string, number> = {};
  readonly #stageTools: Record<string, Set<string>> = {};
  readonly #stageSkillInjected: Record<string, boolean> = {};

  #currentStage:
    | "DISCOVER_AND_SHAPE"
    | "DESIGN_SYSTEM"
    | "FRONTEND_IMPLEMENTATION"
    | "MOTION_ENGINEERING"
    | "VISUAL_QA_REFINEMENT"
    | "COMPLETE"
    | "BLOCKED"
    | "CANCELLED" = "DISCOVER_AND_SHAPE";

  #status: WorkflowStatus = "RUNNING";
  #tokens?: DesignTokenSet | undefined;
  #iteration = 1;
  #changedFiles: ChangedFile[] = [];
  #stageRecords: StageRecord[] = [];
  #lastReport?: VisualQAReport | undefined;
  #blocker?: WorkflowBlocker | undefined;
  #blockerDetail?: string | undefined;
  #pendingConfirmation?: PendingConfirmation | undefined;
  readonly #createdAt: string = new Date().toISOString();

  constructor(options: GovernedDesignWorkflowOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#mutationEngine = options.mutationEngine;
    this.#checkpointCoordinator = options.checkpointCoordinator;
    this.#browserSessionManager = options.browserSessionManager;
    this.#provider = options.provider;
    this.#skills = options.skills;
    this.#onStage = options.onStage;
    this.#signal = options.signal;
    this.#task = options.task;
    this.#taskId = options.taskId;
    this.#workflowId = `design-wf-${Date.now()}`;
    this.#brief = options.brief ?? this.#extractOrBuildBrief(options.task);
    this.#targetUrl = options.targetUrl;
    this.#maxImprovementIterations = Math.max(1, Math.min(options.maxImprovementIterations ?? 3, 5));
    this.#componentFilePath = options.componentFilePath ?? "index.html";
    this.#motionFilePath = options.motionFilePath ?? "motion.css";
    this.#tokensFilePath = options.tokensFilePath ?? "tokens.css";
    this.#autoApprove = Boolean(options.autoApprove);
  }

  public static start(options: GovernedDesignWorkflowOptions): GovernedDesignWorkflow {
    return new GovernedDesignWorkflow(options);
  }

  public get state(): WorkflowState {
    const reviews: ReviewEvidence[] = this.#lastReport
      ? [
          {
            attempt: this.#iteration,
            verdict: this.#lastReport.overallPass ? "NO_FINDINGS" : "FINDINGS",
            findings: this.#lastReport.findings.map((f) => ({
              id: f.findingId,
              severity: f.severity === "blocker" ? "BLOCKER" : f.severity === "critical" ? "HIGH" : "MEDIUM",
              file: this.#componentFilePath,
              ...(f.location.selector ? { location: f.location.selector } : {}),
              claim: f.observedEvidence,
              evidence: f.observedEvidence,
              recommendedAction: f.suggestedCorrection,
            })),
            blocking: this.#lastReport.findings.filter((f) => f.severity === "blocker" || f.severity === "critical").length,
            rejectedUngrounded: 0,
            rejectedMalformed: 0,
            counts: {
              BLOCKER: this.#lastReport.findings.filter((f) => f.severity === "blocker").length,
              HIGH: this.#lastReport.findings.filter((f) => f.severity === "critical").length,
              MEDIUM: this.#lastReport.findings.filter((f) => f.severity === "warning").length,
              LOW: this.#lastReport.findings.filter((f) => f.severity === "suggestion").length,
              NOTE: 0,
            },
          },
        ]
      : [];

    const verification: VerificationEvidence = {
      verdict: this.#lastReport?.overallPass ? "READY" : this.#blocker ? "BLOCKED" : "NOT_READY",
      outcomes: [],
      diffIntegrity: "INTACT",
      divergedFiles: [],
      ...(this.#lastReport?.summary ? { reason: this.#lastReport.summary } : {}),
    };

    const stageMap: Record<string, EngineeringStage> = {
      DISCOVER_AND_SHAPE: "PLAN",
      DESIGN_SYSTEM: "IMPLEMENT",
      FRONTEND_IMPLEMENTATION: "IMPLEMENT",
      MOTION_ENGINEERING: "IMPLEMENT",
      VISUAL_QA_REFINEMENT: "REVIEW",
      COMPLETE: "COMPLETE",
      BLOCKED: "BLOCKED",
      CANCELLED: "CANCELLED",
    };

    return {
      schemaVersion: 1,
      workflowId: this.#workflowId,
      taskId: this.#taskId,
      mode: "BUILD",
      task: this.#task,
      currentStage: stageMap[this.#currentStage] ?? "PLAN",
      completedStages: (this.#currentStage === "COMPLETE" ? ["PLAN", "IMPLEMENT", "REVIEW", "VERIFY"] : []) as WorkStage[],
      selectedSkillIds: [
        "design-direction",
        "design-system-engineering",
        "frontend-composition",
        "motion-engineering",
        "visual-qa",
      ],
      status: this.#status,
      stages: [...this.#stageRecords],
      implementation: {
        changedFiles: [...this.#changedFiles],
        passes: this.#iteration,
        summary: `Advanced Design Workflow: ${this.#changedFiles.length} file(s) modified across ${this.#stageRecords.length} stage(s).`,
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

  public async resume(decision: ConfirmationDecision): Promise<WorkflowResult> {
    if (this.#status !== "WAITING_FOR_CONFIRMATION" || !this.#pendingConfirmation) {
      throw new Error("Workflow is not waiting for confirmation");
    }

    const pending = this.#pendingConfirmation;
    this.#pendingConfirmation = undefined;

    if (decision === "REJECT") {
      this.#status = "BLOCKED";
      this.#blocker = "VERIFICATION_REJECTED";
      this.#blockerDetail = `Mutation on "${pending.preparedMutation.path}" was rejected by user.`;
      this.#recordStageRecord(pending.stage, "BLOCKED", "Mutation rejected by user.");
      return this.#result();
    }

    try {
      await pending.applyFn();
      this.#status = "RUNNING";
      return this.#advance();
    } catch (err: any) {
      this.#status = "BLOCKED";
      this.#blocker = "STAGE_FAILED";
      this.#blockerDetail = err?.message || "Failed to apply mutation";
      return this.#result();
    }
  }

  public async cancel(): Promise<void> {
    this.#status = "CANCELLED";
    this.#currentStage = "CANCELLED";
    this.#recordStageRecord("cancellation", "CANCELLED", "Workflow cancelled.");
  }

  async #advance(): Promise<WorkflowResult> {
    if (this.#signal?.aborted) {
      this.#status = "CANCELLED";
      this.#currentStage = "CANCELLED";
      return this.#result();
    }

    this.#mutationEngine.resetStepCounter?.();

    switch (this.#currentStage) {
      case "DISCOVER_AND_SHAPE": {
        this.#recordStageRecord("discover_and_shape", "RUNNING", "Stage A: Discover & Shape");
        this.#onStage?.({ stage: "discover_and_shape", status: "RUNNING", skill: "design-direction" });

        this.#tokens = deriveDesignTokensFromBrief(this.#brief);
        const directionDoc = formatDesignDirectionDoc(this.#brief, this.#tokens);
        const path = "DESIGN.md";

        const prep = await this.#prepareFileMutation(path, directionDoc);

        if (this.#autoApprove) {
          await this.#mutationEngine.applyPreparedMutation(prep);
          this.#recordStageTool("discover_and_shape", prep.operation === "create" ? "create_file" : "apply_patch");
          this.#recordChange(prep, 1);
          await this.#checkpoint("stage-a-discover");
          this.#recordStageRecord("discover_and_shape", "PASSED", "Stage A complete");
          this.#currentStage = "DESIGN_SYSTEM";
          return this.#advance();
        }

        this.#pendingConfirmation = {
          callId: `call_stage_a_${Date.now()}`,
          stage: "discover_and_shape",
          preparedMutation: prep,
          applyFn: async () => {
            await this.#mutationEngine.applyPreparedMutation(prep);
            this.#recordStageTool("discover_and_shape", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#recordChange(prep, 1);
            await this.#checkpoint("stage-a-discover");
            this.#recordStageRecord("discover_and_shape", "PASSED", "Stage A complete");
            this.#currentStage = "DESIGN_SYSTEM";
          },
        };

        this.#status = "WAITING_FOR_CONFIRMATION";
        return this.#result();
      }

      case "DESIGN_SYSTEM": {
        this.#recordStageRecord("design_system", "RUNNING", "Stage B: Design System Tokens");
        this.#onStage?.({ stage: "design_system", status: "RUNNING", skill: "design-system-engineering" });

        if (!this.#tokens) {
          this.#tokens = deriveDesignTokensFromBrief(this.#brief);
        }
        const cssContent = formatDesignTokensAsCss(this.#tokens);
        const path = this.#tokensFilePath;

        const prep = await this.#prepareFileMutation(path, cssContent);

        if (this.#autoApprove) {
          await this.#mutationEngine.applyPreparedMutation(prep);
          this.#recordStageTool("design_system", prep.operation === "create" ? "create_file" : "apply_patch");
          this.#recordChange(prep, 1);
          await this.#checkpoint("stage-b-tokens");
          this.#recordStageRecord("design_system", "PASSED", "Stage B complete");
          this.#currentStage = "FRONTEND_IMPLEMENTATION";
          return this.#advance();
        }

        this.#pendingConfirmation = {
          callId: `call_stage_b_${Date.now()}`,
          stage: "design_system",
          preparedMutation: prep,
          applyFn: async () => {
            await this.#mutationEngine.applyPreparedMutation(prep);
            this.#recordStageTool("design_system", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#recordChange(prep, 1);
            await this.#checkpoint("stage-b-tokens");
            this.#recordStageRecord("design_system", "PASSED", "Stage B complete");
            this.#currentStage = "FRONTEND_IMPLEMENTATION";
          },
        };

        this.#status = "WAITING_FOR_CONFIRMATION";
        return this.#result();
      }

      case "FRONTEND_IMPLEMENTATION": {
        this.#recordStageRecord("frontend_implementation", "RUNNING", "Stage C: Frontend Composition");
        this.#onStage?.({ stage: "frontend_implementation", status: "RUNNING", skill: "frontend-composition" });

        const markup = await this.#generateComponentWithModel(this.#brief, this.#tokens!);
        const path = this.#componentFilePath;

        const prep = await this.#prepareFileMutation(path, markup);

        if (this.#autoApprove) {
          await this.#mutationEngine.applyPreparedMutation(prep);
          this.#recordStageTool("frontend_implementation", prep.operation === "create" ? "create_file" : "apply_patch");
          this.#recordChange(prep, 1);
          await this.#checkpoint("stage-c-implementation");
          this.#recordStageRecord("frontend_implementation", "PASSED", "Stage C complete");
          this.#currentStage = "MOTION_ENGINEERING";
          return this.#advance();
        }

        this.#pendingConfirmation = {
          callId: `call_stage_c_${Date.now()}`,
          stage: "frontend_implementation",
          preparedMutation: prep,
          applyFn: async () => {
            await this.#mutationEngine.applyPreparedMutation(prep);
            this.#recordStageTool("frontend_implementation", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#recordChange(prep, 1);
            await this.#checkpoint("stage-c-implementation");
            this.#recordStageRecord("frontend_implementation", "PASSED", "Stage C complete");
            this.#currentStage = "MOTION_ENGINEERING";
          },
        };

        this.#status = "WAITING_FOR_CONFIRMATION";
        return this.#result();
      }

      case "MOTION_ENGINEERING": {
        this.#recordStageRecord("motion_engineering", "RUNNING", "Stage D: Motion Engineering");
        this.#onStage?.({ stage: "motion_engineering", status: "RUNNING", skill: "motion-engineering" });

        const motionCss = await this.#generateMotionWithModel(this.#brief, this.#tokens!);
        const path = this.#motionFilePath;

        const prep = await this.#prepareFileMutation(path, motionCss);

        if (this.#autoApprove) {
          await this.#mutationEngine.applyPreparedMutation(prep);
          this.#recordStageTool("motion_engineering", prep.operation === "create" ? "create_file" : "apply_patch");
          this.#recordChange(prep, 1);
          await this.#checkpoint("stage-d-motion");
          this.#recordStageRecord("motion_engineering", "PASSED", "Stage D complete");
          this.#currentStage = "VISUAL_QA_REFINEMENT";
          return this.#advance();
        }

        this.#pendingConfirmation = {
          callId: `call_stage_d_${Date.now()}`,
          stage: "motion_engineering",
          preparedMutation: prep,
          applyFn: async () => {
            await this.#mutationEngine.applyPreparedMutation(prep);
            this.#recordStageTool("motion_engineering", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#recordChange(prep, 1);
            await this.#checkpoint("stage-d-motion");
            this.#recordStageRecord("motion_engineering", "PASSED", "Stage D complete");
            this.#currentStage = "VISUAL_QA_REFINEMENT";
          },
        };

        this.#status = "WAITING_FOR_CONFIRMATION";
        return this.#result();
      }

      case "VISUAL_QA_REFINEMENT": {
        this.#recordStageRecord("visual_qa_refinement", "RUNNING", `Stage E: Visual QA Loop (Iteration ${this.#iteration})`);
        this.#onStage?.({ stage: "visual_qa_refinement", status: "RUNNING", skill: "visual-qa" });

        const evalResult = await this.#evaluateCurrentState();
        this.#lastReport = evalResult.report;

        if (evalResult.report.overallPass) {
          // Success: generate and persist final report
          const reportDoc = this.#formatFinalQaReport(evalResult.report);
          const prep = await this.#prepareFileMutation("DESIGN_QA_REPORT.md", reportDoc);

          if (this.#autoApprove) {
            await this.#mutationEngine.applyPreparedMutation(prep);
            this.#recordStageTool("visual_qa_refinement", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#recordChange(prep, this.#iteration);
            await this.#checkpoint("stage-e-qa-verified");

            this.#status = "COMPLETE";
            this.#currentStage = "COMPLETE";
            this.#recordStageRecord("visual_qa_refinement", "PASSED", `QA passed on iteration ${this.#iteration}`);
            this.#onStage?.({ stage: "visual_qa_refinement", status: "PASSED", skill: "visual-qa" });
            return this.#result();
          }

          this.#pendingConfirmation = {
            callId: `call_stage_e_report_${Date.now()}`,
            stage: "visual_qa_refinement",
            preparedMutation: prep,
            applyFn: async () => {
              await this.#mutationEngine.applyPreparedMutation(prep);
              this.#recordStageTool("visual_qa_refinement", prep.operation === "create" ? "create_file" : "apply_patch");
              this.#recordChange(prep, this.#iteration);
              await this.#checkpoint("stage-e-qa-verified");

              this.#status = "COMPLETE";
              this.#currentStage = "COMPLETE";
              this.#recordStageRecord("visual_qa_refinement", "PASSED", `QA passed on iteration ${this.#iteration}`);
              this.#onStage?.({ stage: "visual_qa_refinement", status: "PASSED", skill: "visual-qa" });
            },
          };
          this.#status = "WAITING_FOR_CONFIRMATION";
          return this.#result();
        }

        // Check if we can run another repair pass
        if (this.#iteration < this.#maxImprovementIterations) {
          this.#iteration++;
          const repairMutation = await this.#prepareRepairs(evalResult.report.findings);
          if (repairMutation) {
            if (this.#autoApprove) {
              await this.#mutationEngine.applyPreparedMutation(repairMutation);
              this.#recordStageTool("visual_qa_refinement", repairMutation.operation === "create" ? "create_file" : "apply_patch");
              this.#recordChange(repairMutation, this.#iteration);
              await this.#checkpoint(`stage-e-repair-iter-${this.#iteration}`);
              return this.#advance();
            }

            this.#pendingConfirmation = {
              callId: `call_stage_e_repair_${Date.now()}`,
              stage: "visual_qa_refinement",
              preparedMutation: repairMutation,
              applyFn: async () => {
                await this.#mutationEngine.applyPreparedMutation(repairMutation);
                this.#recordStageTool("visual_qa_refinement", repairMutation.operation === "create" ? "create_file" : "apply_patch");
                this.#recordChange(repairMutation, this.#iteration);
                await this.#checkpoint(`stage-e-repair-iter-${this.#iteration}`);
              },
            };
            this.#status = "WAITING_FOR_CONFIRMATION";
            return this.#result();
          }
        }

        // Iteration budget exhausted
        const reportDoc = this.#formatFinalQaReport(evalResult.report);
        const prep = await this.#prepareFileMutation("DESIGN_QA_REPORT.md", reportDoc);

        const hasBlockers = evalResult.report.findings.some((f) => f.severity === "blocker" || f.severity === "critical");
        const finalOutcome = hasBlockers
          ? `Visual QA refinement reached maximum iteration budget (${this.#maxImprovementIterations}) with ${evalResult.report.findings.length} unresolved issue(s).`
          : "Pass with minor suggestions";

        if (this.#autoApprove) {
          await this.#mutationEngine.applyPreparedMutation(prep);
          this.#recordStageTool("visual_qa_refinement", prep.operation === "create" ? "create_file" : "apply_patch");
          this.#recordChange(prep, this.#iteration);

          if (hasBlockers) {
            this.#status = "BLOCKED";
            this.#blocker = "BLOCKED_REVIEW";
            this.#blockerDetail = finalOutcome;
            this.#recordStageRecord("visual_qa_refinement", "BLOCKED", this.#blockerDetail);
          } else {
            this.#status = "COMPLETE";
            this.#recordStageRecord("visual_qa_refinement", "PASSED", finalOutcome);
          }
          this.#currentStage = "COMPLETE";
          return this.#result();
        }

        this.#pendingConfirmation = {
          callId: `call_stage_e_final_report_${Date.now()}`,
          stage: "visual_qa_refinement",
          preparedMutation: prep,
          applyFn: async () => {
            await this.#mutationEngine.applyPreparedMutation(prep);
            this.#recordStageTool("visual_qa_refinement", prep.operation === "create" ? "create_file" : "apply_patch");
            this.#recordChange(prep, this.#iteration);

            if (hasBlockers) {
              this.#status = "BLOCKED";
              this.#blocker = "BLOCKED_REVIEW";
              this.#blockerDetail = finalOutcome;
              this.#recordStageRecord("visual_qa_refinement", "BLOCKED", this.#blockerDetail);
            } else {
              this.#status = "COMPLETE";
              this.#recordStageRecord("visual_qa_refinement", "PASSED", finalOutcome);
            }
            this.#currentStage = "COMPLETE";
          },
        };
        this.#status = "WAITING_FOR_CONFIRMATION";
        return this.#result();
      }

      case "COMPLETE":
      case "BLOCKED":
      case "CANCELLED":
        return this.#result();
    }
  }

  #result(): WorkflowResult {
    return {
      status: this.#status,
      state: this.state,
      ...(this.#pendingConfirmation
        ? {
            confirmation: {
              stage: "IMPLEMENT" as WorkStage,
              runner: {
                callId: this.#pendingConfirmation.callId,
                toolName: "create_file",
                action: "write_file",
                arguments: { path: this.#pendingConfirmation.preparedMutation.path },
                preparedMutation: {
                  id: this.#pendingConfirmation.preparedMutation.id,
                  operation: this.#pendingConfirmation.preparedMutation.operation,
                  path: this.#pendingConfirmation.preparedMutation.path,
                  beforeHash: this.#pendingConfirmation.preparedMutation.baseHash,
                  afterHash: this.#pendingConfirmation.preparedMutation.resultHash,
                  linesAdded: this.#pendingConfirmation.preparedMutation.diff.linesAdded,
                  linesRemoved: this.#pendingConfirmation.preparedMutation.diff.linesRemoved,
                  bytesChanged: this.#pendingConfirmation.preparedMutation.diff.bytesChanged,
                  diff: this.#pendingConfirmation.preparedMutation.diff.unified,
                },
              },
            },
          }
        : {}),
    };
  }

  async #evaluateCurrentState(): Promise<{ report: VisualQAReport }> {
    const evaluator = new VisualQAEvaluator();

    if (this.#browserSessionManager && typeof this.#browserSessionManager.observeVisualQaState === "function") {
      try {
        const observed = await this.#browserSessionManager.observeVisualQaState();
        if (observed && Array.isArray(observed.elements) && observed.elements.length > 0) {
          const report = evaluator.evaluate({
            targetUrl: observed.targetUrl,
            viewport: observed.viewport,
            presetId: observed.presetId,
            elements: observed.elements,
            consoleErrors: observed.consoleErrors,
            clientWidth: observed.clientWidth,
            scrollWidth: observed.scrollWidth,
          });
          return { report };
        }
      } catch {
        // Fall through to unverified report
      }
    }

    // Never fabricate CSS styles, contrast, or DOM values when Chromium / browser observations are missing.
    // Return INSUFFICIENT_EVIDENCE with a blocker finding.
    const unverifiedReport: VisualQAReport = {
      reportId: `vqa-unverified-${Date.now()}`,
      targetUrl: this.#targetUrl || `http://localhost:3000/${this.#componentFilePath}`,
      viewport: { width: 1280, height: 800 },
      presetId: "desktop",
      evaluatedAt: Date.now(),
      overallPass: false,
      deterministicPass: false,
      judgmentPass: false,
      score: 0,
      findings: [
        {
          findingId: `finding-no-browser-${Date.now()}`,
          criterion: "browser_observation",
          category: "deterministic",
          severity: "blocker",
          observedEvidence: "No active Chromium browser session or rendered element observations were available.",
          expectedBehavior: "Visual verification requires real rendered browser state observations (computed styles, bounds, contrast).",
          location: {},
          suggestedCorrection: "Launch browser session and observe live rendered interface (INSUFFICIENT_EVIDENCE).",
          confidence: 1.0,
          repairStatus: "unresolved",
        },
      ],
      summary: "Visual QA evaluation inconclusive: Browser session unavailable (INSUFFICIENT_EVIDENCE). No visual pass granted without real rendered evidence.",
    };

    return { report: unverifiedReport };
  }

  async #prepareRepairs(findings: readonly VisualQAFinding[]): Promise<PreparedMutation | undefined> {
    const componentPath = join(this.#workspaceRoot, this.#componentFilePath);
    let currentHtml = "";
    try {
      currentHtml = await readFile(componentPath, "utf8");
    } catch {
      return undefined;
    }

    // Model-assisted repair if provider is configured
    if (this.#provider && typeof this.#provider.complete === "function") {
      try {
        const prompt = `You are a visual design and accessibility engineer.
Fix the following Visual QA defects in this HTML component:
Findings:
${findings.map((f) => `- ${f.criterion} (${f.severity}): ${f.observedEvidence}. Suggestion: ${f.suggestedCorrection}`).join("\n")}

Current HTML:
${currentHtml}

Requirements:
- Fix all cited accessibility, contrast, focus visibility, and layout issues.
- Preserve existing structure and functionality.
Return ONLY the corrected full HTML.`;

        const resp: any = await this.#provider.complete({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          signal: this.#signal,
        });

        const tokensUsed = (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0);
        this.#recordStageModelCall("visual_qa_refinement", tokensUsed);

        let content = resp.message?.content?.trim() || "";
        const match = content.match(/```(?:html)?\s*([\s\S]*?)```/i);
        if (match) {
          content = match[1].trim();
        }
        if (content.length > 50 && content.includes("<") && content.includes(">")) {
          return this.#prepareFileMutation(this.#componentFilePath, content);
        }
      } catch {
        // Fall back to rule-based repairs
      }
    }

    let repaired = currentHtml;

    for (const f of findings) {
      if (f.criterion === "accessible_naming") {
        repaired = repaired.replace(/<button(?![^>]*aria-label)([^>]*)>([\s]*)<\/button>/gi, '<button$1 aria-label="Action">$2Action</button>');
      }
      if (f.criterion === "image_alternative_text") {
        repaired = repaired.replace(/<img(?![^>]*alt)([^>]*)>/gi, '<img$1 alt="Illustrative visual asset">');
      }
      if (f.criterion === "focus_visibility") {
        repaired = repaired.replace(/outline:\s*none;?/gi, "outline: 2px solid var(--color-primary); outline-offset: 2px;");
      }
      if (f.criterion === "color_contrast_wcag_aa") {
        repaired = repaired.replace(/color:\s*(?:#[0-9a-f]{3,6}|rgb\([^)]+\));?/gi, "color: var(--color-text-primary);");
      }
    }

    if (repaired === currentHtml) {
      repaired = repaired.replace(
        "</head>",
        `  <style>
    button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    img:not([alt]) { outline: 1px solid red; }
    body { color: var(--color-text-primary); background: var(--color-bg); }
  </style>
</head>`
      );
    }

    return this.#prepareFileMutation(this.#componentFilePath, repaired);
  }

  #generateComponentMarkup(brief: DesignBrief, tokens: DesignTokenSet): string {
    const isDark = tokens.isDark;
    const primary = tokens.colors.primary.hex;
    const bg = tokens.colors.surface.hex;
    const text = tokens.colors.textPrimary.hex;

    return `<!DOCTYPE html>
<html lang="en" data-theme="${isDark ? "dark" : "light"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brief.productType} — ${brief.brandPositioning.voice}</title>
  <link rel="stylesheet" href="${this.#tokensFilePath}">
  <link rel="stylesheet" href="${this.#motionFilePath}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-family-body, system-ui, sans-serif);
      background-color: var(--color-bg, ${bg});
      color: var(--color-text-primary, ${text});
      line-height: 1.5;
      padding: var(--spacing-6, 24px);
      max-width: 100vw;
      overflow-x: hidden;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-6, 24px);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: var(--spacing-4, 16px);
      border-bottom: 1px solid var(--color-border, #e2e8f0);
    }
    .title {
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: var(--spacing-4, 16px);
    }
    .card {
      background: var(--color-surface, #ffffff);
      border: 1px solid var(--color-border, #e2e8f0);
      border-radius: var(--radius-md, 8px);
      padding: var(--spacing-4, 16px);
      box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05));
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: var(--radius-md, 8px);
      border: none;
      cursor: pointer;
      background: var(--color-primary, ${primary});
      color: #ffffff;
    }
    .btn:focus-visible {
      outline: 2px solid var(--color-primary, ${primary});
      outline-offset: 2px;
    }
    .hero-img {
      max-width: 100%;
      height: auto;
      border-radius: var(--radius-md, 8px);
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header" role="banner">
      <h1 class="title">${brief.brandPositioning.voice}</h1>
      <button type="button" class="btn btn-primary" aria-label="Open primary workflow">
        Get Started
      </button>
    </header>
    <main class="card-grid" role="main">
      <article class="card">
        <h2>${brief.userGoals[0] || "Overview"}</h2>
        <p>Reliable, craft-oriented, and responsive design systems built for production scale.</p>
      </article>
      <article class="card">
        <h2>${brief.userGoals[1] || "Telemetry"}</h2>
        <p>Continuous automated verification across typography, contrast, overflow, and motion.</p>
      </article>
    </main>
  </div>
</body>
</html>`;
  }

  #generateMotionCss(_tokens: DesignTokenSet): string {
    return `/* Sprint 9C Motion Engineering Styles */
.card, .btn {
  transition: transform var(--duration-fast, 150ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1)),
              box-shadow var(--duration-fast, 150ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1)),
              opacity var(--duration-fast, 150ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1));
}

.card:hover, .btn:hover {
  transform: translateY(-2px);
}

.btn:active {
  transform: translateY(0);
}

/* Reduced Motion Alternative: instant cuts, zero transform translations */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
    transform: none !important;
  }
}
`;
  }

  #formatFinalQaReport(report: VisualQAReport): string {
    return `# Visual QA Verification Report

- **Report ID**: \`${report.reportId}\`
- **Target URL**: \`${report.targetUrl}\`
- **Evaluated At**: ${new Date(report.evaluatedAt).toISOString()}
- **Overall Score**: ${report.score} / 100
- **Deterministic Pass**: ${report.deterministicPass ? "PASSED" : "FAILED"}
- **Judgment Pass**: ${report.judgmentPass ? "PASSED" : "FAILED"}
- **Overall Verdict**: ${report.overallPass ? "VERIFIED_PASS" : "ATTENTION_REQUIRED"}

## Summary
${report.summary}

## Findings (${report.findings.length})
${
  report.findings.length === 0
    ? "_Zero visual defects or accessibility blockers detected._"
    : report.findings
        .map(
          (f, idx) => `### ${idx + 1}. [${f.severity.toUpperCase()}] ${f.criterion}
- **Observed**: ${f.observedEvidence}
- **Expected**: ${f.expectedBehavior}
- **Correction**: ${f.suggestedCorrection}
`
        )
        .join("\n")
}
`;
  }

  #recordChange(prep: PreparedMutation, pass: number): void {
    this.#changedFiles.push({
      pass,
      path: prep.path,
      operation: prep.operation,
      beforeHash: prep.baseHash,
      afterHash: prep.resultHash,
      linesAdded: prep.diff.linesAdded,
      linesRemoved: prep.diff.linesRemoved,
      diff: prep.diff.unified,
      diffTruncated: prep.diff.truncated,
    });
  }

  async #prepareFileMutation(path: string, content: string): Promise<PreparedMutation> {
    const fullPath = join(this.#workspaceRoot, path);
    if (existsSync(fullPath)) {
      const currentContent = await readFile(fullPath, "utf8");
      return this.#mutationEngine.preparePatch({
        operation: "patch",
        path,
        patch: {
          search: currentContent,
          replace: content,
        },
      });
    }
    return this.#mutationEngine.prepareCreate({
      operation: "create",
      path,
      content,
    });
  }

  async #generateComponentWithModel(brief: DesignBrief, tokens: DesignTokenSet): Promise<string> {
    if (this.#provider && typeof this.#provider.complete === "function") {
      try {
        const prompt = `You are a principal design systems engineer.
Produce a complete, accessible, production-ready HTML document implementing this design brief:
- Archetype: ${brief.productType}
- Target Audience: ${brief.intendedAudience}
- Core Goals: ${brief.userGoals.join("; ")}
- Brand Voice: ${brief.brandPositioning.voice} (${brief.brandPositioning.tone})
- Aesthetic Style: ${brief.desiredAestheticDirection.style} (${brief.desiredAestheticDirection.visualMetaphor || "refined technical UI"})
- Primary Color: ${tokens.colors.primary.hex}
- Text Color: ${tokens.colors.textPrimary.hex}
- Background: ${tokens.colors.background.hex}
- Surface: ${tokens.colors.surface.hex}

Requirements:
- Valid HTML5 document linking ${this.#tokensFilePath} and ${this.#motionFilePath}.
- High accessibility: proper semantic elements (<header>, <main>, <article>, <button>), visible text or aria-labels for every interactive control, and alt attributes for all <img> elements.
- Clean responsive layout and WCAG AA contrast compliance.
Return ONLY valid HTML code.`;

        const resp: any = await this.#provider.complete({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          signal: this.#signal,
        });

        const tokensUsed = (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0);
        this.#recordStageModelCall("frontend_implementation", tokensUsed);

        let content = resp.message?.content?.trim() || "";
        const match = content.match(/```(?:html)?\s*([\s\S]*?)```/i);
        if (match) {
          content = match[1].trim();
        }
        if (content.length > 50 && content.includes("<") && content.includes(">")) {
          return content;
        }
      } catch {
        // Fallback to procedural generation
      }
    }
    return this.#generateComponentMarkup(brief, tokens);
  }

  async #generateMotionWithModel(brief: DesignBrief, tokens: DesignTokenSet): Promise<string> {
    if (this.#provider && typeof this.#provider.complete === "function") {
      try {
        const prompt = `You are a motion design engineer.
Generate CSS animations and transitions for this design system:
- Archetype: ${brief.productType}
- Motion Intensity: ${brief.motionPreferences.intensity}
- Engine: ${brief.motionPreferences.preferredEngine || "css"}
- Reduce Motion Fallback: ${brief.motionPreferences.reduceMotionFallback}

Requirements:
- CSS transitions and animations animating only performant properties (transform and opacity).
- Support for @media (prefers-reduced-motion: reduce) disabling transforms and translations.
Return ONLY valid CSS.`;

        const resp: any = await this.#provider.complete({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          signal: this.#signal,
        });

        const tokensUsed = (resp.usage?.inputTokens ?? 0) + (resp.usage?.outputTokens ?? 0);
        this.#recordStageModelCall("motion_engineering", tokensUsed);

        let content = resp.message?.content?.trim() || "";
        const match = content.match(/```(?:css)?\s*([\s\S]*?)```/i);
        if (match) {
          content = match[1].trim();
        }
        if (content.length > 20 && content.includes("{") && content.includes("}")) {
          return content;
        }
      } catch {
        // Fallback
      }
    }
    return this.#generateMotionCss(tokens);
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

  #recordStageRecord(stage: string, status: "RUNNING" | "PASSED" | "BLOCKED" | "CANCELLED", outcome?: string): void {
    const stageMap: Record<string, WorkStage> = {
      discover_and_shape: "PLAN",
      design_system: "IMPLEMENT",
      frontend_implementation: "IMPLEMENT",
      motion_engineering: "IMPLEMENT",
      visual_qa_refinement: "REVIEW",
    };
    const workStage: WorkStage = stageMap[stage] ?? "PLAN";
    const toolsUsed = Array.from(this.#stageTools[stage] ?? []);
    const modelCalls = this.#stageModelCalls[stage] ?? 0;
    const contextTokens = this.#stageTokens[stage] ?? 0;
    const skillInjected = Boolean(this.#skills && this.#stageSkillInjected[stage]);

    this.#stageRecords.push({
      stage: workStage,
      attempt: 1,
      startedAt: new Date().toISOString(),
      ...(status !== "RUNNING" ? { endedAt: new Date().toISOString() } : {}),
      status,
      modelCalls,
      contextTokens,
      toolsUsed,
      skillInjection: skillInjected ? "INJECTED" : "NOT_APPLICABLE",
      skillInjected,
      ...(outcome ? { outcome } : {}),
    });
  }

  async #checkpoint(label: string): Promise<void> {
    if (this.#checkpointCoordinator && typeof this.#checkpointCoordinator.checkpoint === "function") {
      try {
        await this.#checkpointCoordinator.checkpoint({
          runId: this.#taskId,
          reason: "WORKFLOW_STAGE",
          phase: label,
          evidenceVersion: 1,
          runtimeState: {
            status: this.#status === "COMPLETE" ? "COMPLETED" : "RUNNING",
          },
          touchedFilePaths: this.#changedFiles.map((f) => f.path),
        });
      } catch {
        // Advisory checkpoint
      }
    }
  }

  #extractOrBuildBrief(instruction: string): DesignBrief {
    return createDefaultDesignBrief({
      briefId: `brief-${Date.now()}`,
      intendedAudience: "Engineering teams and design system practitioners",
      userGoals: [instruction.slice(0, 100)],
    });
  }
}
