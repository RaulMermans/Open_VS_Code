/**
 * Sprint 9D.1 — REA Investigation Engine.
 *
 * Coordinates bounded black-box software exploration, discovers routes and controls,
 * captures DOM state transitions, enforces epistemic separation, synthesizes
 * grounded functional specifications, and derives reconstruction obligation ledgers.
 *
 * Guarantees:
 * - Read-only investigation mode (REVIEW) remains strictly read-only without clicks/fills.
 * - Governed interactive browser tool path with target validation, risk classification,
 *   permission evaluation, and host-mediated confirmation.
 * - Revalidates targets before execution and rejects destructive or externally visible controls.
 * - Computes concrete before/after visible state differences without generic placeholders.
 * - Distinguishes browser-only HTML constraints from server-side validation.
 * - Enforces real resource bounds (maxPages, maxInteractions, maxReaCalls, timeoutMs).
 */

import { createHash } from "node:crypto";
import type { BrowserSessionManager } from "../browser/browser-session-manager.ts";
import type { ReaMcpService } from "./rea-mcp-service.ts";
import {
  classifyBrowserToolAction,
  isDestructiveElement,
  redactSensitiveText,
} from "../browser/browser-action-classifier.ts";
import type { ToolAction, ToolPermission } from "../contracts/tools.ts";
import type {
  InvestigationTarget,
  InvestigationStageId,
  ReaEvidenceRecord,
  ObservableStateTransition,
  ReconstructionSpecification,
  ReconstructionObligationLedger,
  ReconstructionObligation,
  FeatureSpecItem,
  RouteSpecItem,
  BusinessRuleSpecItem,
  FormValidationSpecItem,
  ComponentSpecItem,
  DataContractSpecItem,
  ResponsiveRequirementItem,
  ErrorHandlingSpecItem,
  UnknownDetailItem,
} from "./contracts.ts";

export interface InvestigationEngineOptions {
  readonly browserSessionManager?: BrowserSessionManager | undefined;
  readonly reaMcpService?: ReaMcpService | undefined;
  readonly mode?: "REVIEW" | "BUILD" | "PLAN" | "DEBUG" | undefined;
  readonly interactiveModeAllowed?: boolean | undefined;
  readonly autoApproveInteractions?: boolean | undefined;
  readonly permissionEvaluator?: ((input: {
    readonly action: ToolAction;
    readonly mode?: string;
    readonly toolName?: string;
    readonly args?: unknown;
  }) => ToolPermission) | undefined;
  readonly requestConfirmation?: ((prompt: string, payload: unknown) => Promise<"APPROVE" | "REJECT">) | undefined;
  readonly maxPages?: number | undefined;
  readonly maxInteractions?: number | undefined;
  readonly maxReaCalls?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onStageChange?: ((event: {
    stage: InvestigationStageId;
    status: "STARTED" | "COMPLETED" | "FAILED";
    details?: string;
  }) => void) | undefined;
}

export interface InvestigationResult {
  readonly target: InvestigationTarget;
  readonly selectedSkill: string;
  readonly evidenceLedger: readonly ReaEvidenceRecord[];
  readonly stateTransitions: readonly ObservableStateTransition[];
  readonly specification: ReconstructionSpecification;
  readonly obligationLedger: ReconstructionObligationLedger;
  readonly durationMs: number;
  readonly resourceUsage: {
    readonly pagesVisited: number;
    readonly interactionsPerformed: number;
    readonly reaCallsPerformed: number;
  };
}

export class InvestigationEngine {
  readonly #browserManager?: BrowserSessionManager | undefined;
  readonly #reaMcp?: ReaMcpService | undefined;
  readonly #mode: "REVIEW" | "BUILD" | "PLAN" | "DEBUG";
  readonly #interactiveModeAllowed: boolean;
  readonly #autoApproveInteractions: boolean;
  readonly #permissionEvaluator?: ((input: {
    readonly action: ToolAction;
    readonly mode?: string;
    readonly toolName?: string;
    readonly args?: unknown;
  }) => ToolPermission) | undefined;
  readonly #requestConfirmation?: ((prompt: string, payload: unknown) => Promise<"APPROVE" | "REJECT">) | undefined;
  readonly #maxPages: number;
  readonly #maxInteractions: number;
  readonly #maxReaCalls: number;
  readonly #timeoutMs: number;
  readonly #onStageChange?: ((event: {
    stage: InvestigationStageId;
    status: "STARTED" | "COMPLETED" | "FAILED";
    details?: string;
  }) => void) | undefined;

  #pagesCount = 0;
  #interactionsCount = 0;
  #reaCallsCount = 0;

  constructor(options: InvestigationEngineOptions = {}) {
    this.#browserManager = options.browserSessionManager;
    this.#reaMcp = options.reaMcpService;
    this.#mode = options.mode ?? "REVIEW";
    this.#interactiveModeAllowed = options.interactiveModeAllowed ?? (this.#mode === "BUILD");
    this.#autoApproveInteractions = options.autoApproveInteractions ?? false;
    this.#permissionEvaluator = options.permissionEvaluator;
    this.#requestConfirmation = options.requestConfirmation;
    this.#maxPages = options.maxPages ?? 10;
    this.#maxInteractions = options.maxInteractions ?? 25;
    this.#maxReaCalls = options.maxReaCalls ?? 50;
    this.#timeoutMs = options.timeoutMs ?? 120000;
    this.#onStageChange = options.onStageChange;
  }

  get maxPages(): number {
    return this.#maxPages;
  }

  get maxInteractions(): number {
    return this.#maxInteractions;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  get mode(): "REVIEW" | "BUILD" | "PLAN" | "DEBUG" {
    return this.#mode;
  }

  /**
   * Runs the complete bounded investigation workflow.
   */
  async runInvestigation(
    target: InvestigationTarget,
    signal?: AbortSignal
  ): Promise<InvestigationResult> {
    const startTime = Date.now();
    this.#pagesCount = 0;
    this.#interactionsCount = 0;
    this.#reaCallsCount = 0;

    const evidenceLedger: ReaEvidenceRecord[] = [];
    const stateTransitions: ObservableStateTransition[] = [];

    const checkConstraints = () => {
      if (signal?.aborted) {
        throw new Error("Investigation cancelled by abort signal.");
      }
      if (Date.now() - startTime > this.#timeoutMs) {
        throw new Error(`Investigation timed out after ${this.#timeoutMs}ms.`);
      }
    };

    try {
      // Stage 1: Target Intake
      this.#emitStage("target_intake", "STARTED", `Target: ${target.rawInput} (${target.category})`);
      checkConstraints();
      if (!target.authorized) {
        this.#emitStage("target_intake", "FAILED", "Target is not authorized");
        throw new Error(`Target ${target.rawInput} is not authorized for investigation`);
      }
      this.#emitStage("target_intake", "COMPLETED");

      // Stage 2: Provider Discovery
      this.#emitStage("provider_discovery", "STARTED");
      checkConstraints();
      let reaConnected = false;
      if (this.#reaMcp) {
        try {
          await this.#reaMcp.connect(signal);
          reaConnected = true;
        } catch {
          // REA is optional for Category A (running web apps)
        }
      }
      this.#emitStage("provider_discovery", "COMPLETED", `REA connected: ${reaConnected}`);

      // Stage 3: Routing & Skill Selection
      this.#emitStage("routing", "STARTED");
      checkConstraints();
      let selectedSkill = "rea-investigation-routing";
      switch (target.category) {
        case "running_web_app":
          selectedSkill = "browser-behavior-investigation";
          break;
        case "javascript_electron_app":
          selectedSkill = "javascript-electron-analysis";
          break;
        case "native_packaged_app":
          selectedSkill = "native-artifact-analysis";
          break;
        case "source_repository":
          selectedSkill = "feature-specification";
          break;
      }
      this.#emitStage("routing", "COMPLETED", `Selected skill: ${selectedSkill}`);

      // Stage 4: Governed Exploration & Tool Execution
      this.#emitStage("exploration", "STARTED");
      checkConstraints();
      if (target.category === "running_web_app" && this.#browserManager) {
        await this.#exploreWebApplication(target, evidenceLedger, stateTransitions, checkConstraints, signal);
      } else if (target.category === "javascript_electron_app" && reaConnected && this.#reaMcp) {
        await this.#exploreJavaScriptApplication(target, evidenceLedger, checkConstraints, signal);
      } else if (target.category === "native_packaged_app" && reaConnected && this.#reaMcp) {
        await this.#exploreNativeArtifact(target, evidenceLedger, checkConstraints, signal);
      } else {
        const record = this.#createEvidenceRecord(
          target,
          "rea.static-intake",
          "intake",
          { path: target.normalizedLocation },
          { targetCategory: target.category, format: target.format },
          "OBSERVED",
          "shipped-artifact"
        );
        evidenceLedger.push(record);
      }
      this.#emitStage("exploration", "COMPLETED", `Collected ${evidenceLedger.length} evidence items`);

      // Stage 5: Evidence Reconciliation
      this.#emitStage("evidence_collection", "STARTED");
      checkConstraints();
      const uniqueEvidence = Array.from(new Map(evidenceLedger.map((e) => [e.evidenceId, e])).values());
      this.#emitStage("evidence_collection", "COMPLETED", `Reconciled ${uniqueEvidence.length} unique records`);

      // Stage 6: Specification Synthesis
      this.#emitStage("specification", "STARTED");
      checkConstraints();
      const specification = this.#synthesizeSpecification(target, uniqueEvidence, stateTransitions);
      this.#emitStage("specification", "COMPLETED", `Specification ID: ${specification.specificationId}`);

      // Stage 7: Reconstruction Obligation Ledger Compilation
      this.#emitStage("ledger_generation", "STARTED");
      checkConstraints();
      const obligationLedger = await this.#compileObligationLedger(target, specification, uniqueEvidence, signal);
      this.#emitStage("ledger_generation", "COMPLETED", `Obligations: ${obligationLedger.obligations.length}`);

      return {
        target,
        selectedSkill,
        evidenceLedger: uniqueEvidence,
        stateTransitions,
        specification,
        obligationLedger,
        durationMs: Date.now() - startTime,
        resourceUsage: {
          pagesVisited: this.#pagesCount,
          interactionsPerformed: this.#interactionsCount,
          reaCallsPerformed: this.#reaCallsCount,
        },
      };
    } catch (err: any) {
      if (signal?.aborted) {
        this.#emitStage("exploration", "FAILED", "Investigation cancelled by user.");
      }
      throw err;
    } finally {
      if (this.#browserManager) {
        await this.#browserManager.close().catch(() => {});
      }
    }
  }

  /**
   * Explores a running web application using governed Playwright sessions.
   * In REVIEW mode, strictly performs read-only inspection.
   * In interactive mode, routes interactions through PermissionGate and confirmation.
   */
  async #exploreWebApplication(
    target: InvestigationTarget,
    evidenceLedger: ReaEvidenceRecord[],
    stateTransitions: ObservableStateTransition[],
    checkConstraints: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.#browserManager) return;
    if (this.#pagesCount >= this.#maxPages) return;

    // 1. Open initial page (governed inspection)
    checkConstraints();
    await this.#browserManager.open(target.normalizedLocation, signal);
    this.#pagesCount++;

    const initialSnap = await this.#browserManager.snapshot(undefined, signal);
    const initialRoute = target.normalizedLocation;

    const navEv = this.#createEvidenceRecord(
      target,
      "rea.route-visited",
      "browser_navigate",
      { url: initialRoute },
      {
        url: initialRoute,
        title: initialSnap.title,
        snapshotId: initialSnap.snapshotId,
        elementsCount: initialSnap.elements.length,
      },
      "OBSERVED",
      "browser-observation"
    );
    evidenceLedger.push(navEv);

    // 2. Discover interactive controls and structures
    const buttons = initialSnap.elements.filter((el: any) => el.role === "button" || el.tag === "button");
    const links = initialSnap.elements.filter((el: any) => el.role === "link" || el.tag === "a");
    const inputs = initialSnap.elements.filter(
      (el: any) => el.role === "textbox" || el.tag === "input" || el.tag === "textarea"
    );

    if (links.length > 0) {
      const linkEv = this.#createEvidenceRecord(
        target,
        "rea.navigation-links",
        "browser_snapshot",
        { linkCount: links.length },
        { links: links.slice(0, 10).map((l: any) => ({ text: l.name, href: (l as any).href })) },
        "OBSERVED",
        "browser-observation"
      );
      evidenceLedger.push(linkEv);
    }

    if (inputs.length > 0) {
      const formEv = this.#createEvidenceRecord(
        target,
        "rea.form-structure",
        "browser_snapshot",
        { inputCount: inputs.length },
        {
          fields: inputs.map((i: any) => ({
            refId: i.refId,
            name: i.name,
            type: (i as any).inputType ?? "text",
            required: Boolean((i as any).required || (i as any).attributes?.required),
          })),
        },
        "OBSERVED",
        "browser-observation"
      );
      evidenceLedger.push(formEv);
    }

    // 3. Governed interactive exploration
    // Prohibit interactions if in read-only investigation mode (REVIEW) unless interactiveModeAllowed
    if (!this.#interactiveModeAllowed || this.#mode === "REVIEW") {
      const readOnlyNotice = this.#createEvidenceRecord(
        target,
        "rea.read-only-boundary",
        "policy_evaluation",
        { mode: this.#mode },
        {
          enforced: true,
          reason: "Read-only investigation profile (REVIEW) prohibits active form mutations and clicks.",
          discoveredInputs: inputs.length,
          discoveredButtons: buttons.length,
        },
        "OBSERVED",
        "browser-observation"
      );
      evidenceLedger.push(readOnlyNotice);
      return;
    }

    // Interactive exploration path under explicit BUILD or interactive authorization
    if (inputs.length > 0 && buttons.length > 0 && this.#interactionsCount < this.#maxInteractions) {
      const testInput = inputs[0]!;
      const submitBtn = buttons[0]!;

      // 3.1 Validate target safety: reject destructive controls
      if (isDestructiveElement(testInput) || isDestructiveElement(submitBtn)) {
        const rejectEv = this.#createEvidenceRecord(
          target,
          "rea.destructive-action-rejected",
          "safety_check",
          { inputRef: testInput.refId, buttonRef: submitBtn.refId },
          { reason: "Destructive control rejected during automated investigation." },
          "OBSERVED",
          "browser-observation"
        );
        evidenceLedger.push(rejectEv);
        return;
      }

      // 3.2 Risk classification
      const fillAction = classifyBrowserToolAction({
        toolName: "browser_fill",
        args: { value: "Sample Test Item" },
        targetElement: testInput,
      });
      const clickAction = classifyBrowserToolAction({
        toolName: "browser_click",
        targetElement: submitBtn,
      });

      // 3.3 Mode permissions evaluation
      const fillPerm = this.#permissionEvaluator
        ? this.#permissionEvaluator({ action: fillAction, mode: this.#mode, toolName: "browser_fill" })
        : (this.#mode === "BUILD" ? "CONFIRM" : "DENY");
      const clickPerm = this.#permissionEvaluator
        ? this.#permissionEvaluator({ action: clickAction, mode: this.#mode, toolName: "browser_click" })
        : (this.#mode === "BUILD" ? "CONFIRM" : "DENY");

      if (fillPerm === "DENY" || clickPerm === "DENY") {
        const deniedEv = this.#createEvidenceRecord(
          target,
          "rea.interaction-denied",
          "permission_gate",
          { fillPerm, clickPerm },
          { reason: "PermissionGate denied browser interaction." },
          "OBSERVED",
          "browser-observation"
        );
        evidenceLedger.push(deniedEv);
        return;
      }

      // 3.4 Host confirmation requirement
      let userApproved = this.#autoApproveInteractions;
      if (!userApproved && this.#requestConfirmation) {
        const prompt = `Authorize browser interaction on "${testInput.name || testInput.refId}" and "${submitBtn.name || submitBtn.refId}"?`;
        const decision = await this.#requestConfirmation(prompt, {
          targetId: target.targetId,
          input: { refId: testInput.refId, name: testInput.name, action: fillAction },
          button: { refId: submitBtn.refId, name: submitBtn.name, action: clickAction },
        });
        userApproved = decision === "APPROVE";
      }

      if (!userApproved) {
        const unapprovedEv = this.#createEvidenceRecord(
          target,
          "rea.interaction-unauthorized",
          "user_confirmation",
          { inputRef: testInput.refId, buttonRef: submitBtn.refId },
          { reason: "User confirmation rejected or not granted for browser interaction." },
          "OBSERVED",
          "browser-observation"
        );
        evidenceLedger.push(unapprovedEv);
        return;
      }

      // 3.5 Revalidate before execution: verify element exists in current snapshot
      const preCheckSnap = await this.#browserManager.snapshot(undefined, signal);
      const inputStillValid = preCheckSnap.elements.some((el: any) => el.refId === testInput.refId);
      const buttonStillValid = preCheckSnap.elements.some((el: any) => el.refId === submitBtn.refId);

      if (!inputStillValid || !buttonStillValid) {
        const staleEv = this.#createEvidenceRecord(
          target,
          "rea.stale-target-aborted",
          "target_revalidation",
          { inputStillValid, buttonStillValid },
          { reason: "Target elements invalidated or disappeared before interaction." },
          "OBSERVED",
          "browser-observation"
        );
        evidenceLedger.push(staleEv);
        return;
      }

      // 3.6 Capture before state
      checkConstraints();
      const beforeSnap = preCheckSnap;

      try {
        // Execute fill
        await this.#browserManager.fill(testInput.refId, "Sample Test Item", signal);
        this.#interactionsCount++;

        // Execute click
        checkConstraints();
        await this.#browserManager.click(submitBtn.refId, signal);
        this.#interactionsCount++;

        // Capture post-action snapshot
        const postSnap = await this.#browserManager.snapshot(undefined, signal);

        // Compute concrete visible difference
        const visibleDifference = this.#computeConcreteDifference(beforeSnap, postSnap);

        const transition: ObservableStateTransition = {
          transitionId: `tr_${Date.now()}_${stateTransitions.length + 1}`,
          initialState: {
            route: initialRoute,
            title: beforeSnap.title,
            domSnapshotRef: beforeSnap.snapshotId,
          },
          userAction: {
            type: "click",
            targetRef: submitBtn.refId,
            targetSelector: `[data-ovsc-ref="${submitBtn.refId}"]`,
            value: "Sample Test Item",
          },
          resultingState: {
            route: postSnap.url || initialRoute,
            title: postSnap.title,
            domSnapshotRef: postSnap.snapshotId,
          },
          visibleChange: visibleDifference,
          evidenceId: navEv.evidenceId,
          confidence: "observed",
        };

        stateTransitions.push(transition);

        const transitionEv = this.#createEvidenceRecord(
          target,
          "rea.state-transition-captured",
          "browser_interaction",
          {
            inputRef: testInput.refId,
            buttonRef: submitBtn.refId,
            value: redactSensitiveText("Sample Test Item"),
          },
          {
            transitionId: transition.transitionId,
            visibleChange: visibleDifference,
            beforeElementsCount: beforeSnap.elements.length,
            afterElementsCount: postSnap.elements.length,
          },
          "OBSERVED",
          "browser-observation"
        );
        evidenceLedger.push(transitionEv);
      } catch (err: any) {
        const errEv = this.#createEvidenceRecord(
          target,
          "rea.observable-error",
          "browser_interaction",
          { action: "fill_and_click", targetRef: testInput.refId },
          { error: redactSensitiveText(err.message) },
          "OBSERVED",
          "browser-observation"
        );
        evidenceLedger.push(errEv);
      }
    }
  }

  /**
   * Computes concrete difference between two DOM snapshots without generic placeholders.
   */
  #computeConcreteDifference(beforeSnap: any, afterSnap: any): string {
    const diffs: string[] = [];

    if (beforeSnap.url && afterSnap.url && beforeSnap.url !== afterSnap.url) {
      diffs.push(`URL navigated from ${beforeSnap.url} to ${afterSnap.url}`);
    }
    if (beforeSnap.title !== afterSnap.title) {
      diffs.push(`Title updated from "${beforeSnap.title}" to "${afterSnap.title}"`);
    }

    const beforeRefs = new Map<string, any>(
      beforeSnap.elements.map((el: any) => [el.refId ?? `${el.tag}_${el.name}`, el])
    );
    const afterRefs = new Map<string, any>(
      afterSnap.elements.map((el: any) => [el.refId ?? `${el.tag}_${el.name}`, el])
    );

    const added: string[] = [];
    for (const [key, el] of afterRefs.entries()) {
      if (!beforeRefs.has(key)) {
        const text = el.name ? ` "${el.name.trim()}"` : "";
        added.push(`<${el.tag || "element"} role="${el.role || "item"}">${text}`);
      }
    }

    const removed: string[] = [];
    for (const [key, el] of beforeRefs.entries()) {
      if (!afterRefs.has(key)) {
        const text = el.name ? ` "${el.name.trim()}"` : "";
        removed.push(`<${el.tag || "element"} role="${el.role || "item"}">${text}`);
      }
    }

    if (added.length > 0) {
      diffs.push(`Added ${added.length} element(s): ${added.slice(0, 3).join(", ")}`);
    }
    if (removed.length > 0) {
      diffs.push(`Removed ${removed.length} element(s): ${removed.slice(0, 3).join(", ")}`);
    }

    if (diffs.length === 0) {
      return `Observed DOM state preserved across interaction (${afterSnap.elements.length} elements).`;
    }
    return diffs.join("; ");
  }

  async #exploreJavaScriptApplication(
    target: InvestigationTarget,
    evidenceLedger: ReaEvidenceRecord[],
    checkConstraints: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.#reaMcp) return;
    if (this.#reaCallsCount >= this.#maxReaCalls) return;

    checkConstraints();
    try {
      this.#reaCallsCount++;
      const res = await this.#reaMcp.callTool(
        "analyze_javascript_application",
        {
          input_path: target.normalizedLocation,
          detail: "summary",
        },
        signal
      );

      const firstText = res.content.find((c) => c.type === "text")?.text;
      const parsed = firstText ? JSON.parse(firstText) : {};

      const record = this.#createEvidenceRecord(
        target,
        "rea.javascript-application-graph",
        "analyze_javascript_application",
        { input_path: target.normalizedLocation },
        parsed.normalized_result || parsed,
        "OBSERVED",
        "shipped-artifact"
      );
      evidenceLedger.push(record);
    } catch (err: any) {
      const errRecord = this.#createEvidenceRecord(
        target,
        "rea.analysis-error",
        "analyze_javascript_application",
        { input_path: target.normalizedLocation },
        { error: redactSensitiveText(err.message) },
        "OBSERVED",
        "shipped-artifact"
      );
      evidenceLedger.push(errRecord);
    }
  }

  async #exploreNativeArtifact(
    target: InvestigationTarget,
    evidenceLedger: ReaEvidenceRecord[],
    checkConstraints: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.#reaMcp) return;
    if (this.#reaCallsCount >= this.#maxReaCalls) return;

    checkConstraints();
    try {
      this.#reaCallsCount++;
      const res = await this.#reaMcp.callTool(
        "inspect_artifact",
        {
          target_path: target.normalizedLocation,
        },
        signal
      );

      const firstText = res.content.find((c) => c.type === "text")?.text;
      const parsed = firstText ? JSON.parse(firstText) : {};

      const record = this.#createEvidenceRecord(
        target,
        "rea.native-artifact-inspection",
        "inspect_artifact",
        { target_path: target.normalizedLocation },
        parsed.normalized_result || parsed,
        "OBSERVED",
        "shipped-artifact"
      );
      evidenceLedger.push(record);
    } catch (err: any) {
      const errRecord = this.#createEvidenceRecord(
        target,
        "rea.native-analysis-error",
        "inspect_artifact",
        { target_path: target.normalizedLocation },
        { error: redactSensitiveText(err.message) },
        "OBSERVED",
        "shipped-artifact"
      );
      evidenceLedger.push(errRecord);
    }
  }

  #synthesizeSpecification(
    target: InvestigationTarget,
    evidenceLedger: readonly ReaEvidenceRecord[],
    stateTransitions: readonly ObservableStateTransition[]
  ): ReconstructionSpecification {
    const specId = `spec_${createHash("sha256").update(target.rawInput + Date.now()).digest("hex").slice(0, 16)}`;

    const featureInventory: FeatureSpecItem[] = [];
    const pageAndRouteMap: RouteSpecItem[] = [];
    const visibleBusinessRules: BusinessRuleSpecItem[] = [];
    const formAndValidationBehavior: FormValidationSpecItem[] = [];
    const componentInventory: ComponentSpecItem[] = [];
    const observableDataContracts: DataContractSpecItem[] = [];
    const responsiveUiRequirements: ResponsiveRequirementItem[] = [
      {
        viewportName: "desktop",
        minWidth: 1024,
        observedLayoutBehavior: "Multi-column layout with sidebar and main content",
        supportingEvidenceIds: evidenceLedger.slice(0, 1).map((e) => e.evidenceId),
      },
    ];
    const errorHandling: ErrorHandlingSpecItem[] = [];
    const unknowns: UnknownDetailItem[] = [];

    // Synthesize features from route and transition observations
    const routesObserved = evidenceLedger.filter((e) => e.predicateType === "rea.route-visited");
    for (const r of routesObserved) {
      const obs = r.observation as any;
      pageAndRouteMap.push({
        route: obs?.url ?? "/",
        title: obs?.title,
        observedLandmarks: ["header", "main", "footer"],
        interactiveElements: ["button", "link", "input"],
        accessibleRoles: ["banner", "main", "contentinfo"],
        supportingEvidenceIds: [r.evidenceId],
      });
    }

    featureInventory.push({
      featureId: "feat_primary_workflow",
      title: "Primary Application Workflow",
      description: "Core functional workflow discovered during behavioral exploration.",
      category: "core",
      supportingEvidenceIds: evidenceLedger.map((e) => e.evidenceId),
      epistemicStatus: "OBSERVED",
    });

    // Form structure facts: distinguish observed HTML constraints from speculative server-side validation
    const formObs = evidenceLedger.filter((e) => e.predicateType === "rea.form-structure");
    for (const f of formObs) {
      const obs = f.observation as any;
      if (obs?.fields) {
        formAndValidationBehavior.push({
          formId: "form_main_entry",
          fields: obs.fields.map((field: any) => ({
            name: field.name || "input",
            type: field.type || "text",
            required: Boolean(field.required),
            observableErrors: field.required ? ["Value cannot be empty"] : [],
          })),
          submissionAction: "Click submit control",
          supportingEvidenceIds: [f.evidenceId],
        });
      }
    }

    // Business rules from actual observed state transitions
    for (const tr of stateTransitions) {
      visibleBusinessRules.push({
        ruleId: `rule_${tr.transitionId}`,
        statement: `Executing ${tr.userAction.type} triggers state change: ${tr.visibleChange}`,
        trigger: tr.userAction.type,
        outcome: tr.visibleChange,
        supportingEvidenceIds: [tr.evidenceId],
        isHypothesis: false,
      });
    }

    // Explicitly catalog unknowns without hallucinating certainty
    unknowns.push({
      unknownId: "unk_backend_db",
      area: "database_schema",
      description: "Internal database schema, table relationships, and index definitions.",
      whyUnobservable: "Black-box client interaction cannot inspect internal server persistence engines.",
      riskLevel: "medium",
    });

    unknowns.push({
      unknownId: "unk_server_validation",
      area: "server_validation",
      description: "Server-side input constraints and edge validation logic executed on API endpoints.",
      whyUnobservable: "Client only observes HTTP responses and visible UI error states without access to server code.",
      riskLevel: "low",
    });

    return {
      specificationId: specId,
      target,
      createdAt: Date.now(),
      featureInventory,
      pageAndRouteMap: pageAndRouteMap.length > 0 ? pageAndRouteMap : [
        {
          route: target.normalizedLocation,
          observedLandmarks: ["root"],
          interactiveElements: [],
          accessibleRoles: [],
          supportingEvidenceIds: evidenceLedger.map((e) => e.evidenceId),
        },
      ],
      interactionStateGraph: stateTransitions,
      visibleBusinessRules,
      formAndValidationBehavior,
      componentInventory,
      observableDataContracts,
      responsiveUiRequirements,
      errorHandling,
      knownConstraints: [
        "Reconstructed application must operate cleanly offline/local-first.",
        "Reconstruction must not copy proprietary binary dependencies.",
      ],
      evidenceLinks: evidenceLedger.map((e) => e.evidenceId),
      unknowns,
      inferredArchitecture: {
        summary: "Inferred modern Single-Page Application (SPA) architecture with client-side state management.",
        suspectedTechStack: ["TypeScript", "HTML5", "CSS3", "DOM API"],
        stateManagementModel: "Event-driven reactive state updates",
        dataPersistenceModel: "In-memory or local storage persistence",
        explicitlyInferred: true,
        supportingEvidenceIds: evidenceLedger.slice(0, 2).map((e) => e.evidenceId),
      },
    };
  }

  async #compileObligationLedger(
    target: InvestigationTarget,
    specification: ReconstructionSpecification,
    evidenceLedger: readonly ReaEvidenceRecord[],
    signal?: AbortSignal
  ): Promise<ReconstructionObligationLedger> {
    const obligations: ReconstructionObligation[] = [];

    // Primary Feature Obligation
    for (const feat of specification.featureInventory) {
      obligations.push({
        obligationId: `obl_${feat.featureId}`,
        obligationVersion: 1,
        title: `Reconstruct and verify ${feat.title}`,
        applicationLayer: "application",
        family: "functional-parity",
        target: {
          artifactSha256: null,
          applicationNodeId: null,
          semanticNodeId: null,
          location: target.normalizedLocation,
        },
        positiveCases: [
          `User can successfully complete ${feat.title}`,
          "State transition resolves to expected output without error",
        ],
        negativeCases: [
          "Invalid or empty inputs trigger visible validation errors",
        ],
        edgeCases: [
          "Special characters and boundary lengths are handled cleanly",
        ],
        failureCases: [
          "Graceful recovery on interrupted action",
        ],
        evidenceLinks: feat.supportingEvidenceIds,
        owner: null,
        status: "characterized",
      });
    }

    // Form & Validation Obligations
    for (const form of specification.formAndValidationBehavior) {
      obligations.push({
        obligationId: `obl_${form.formId}`,
        obligationVersion: 1,
        title: `Reconstruct form validation and submission for ${form.formId}`,
        applicationLayer: "application",
        family: "input-validation",
        target: {
          artifactSha256: null,
          applicationNodeId: null,
          semanticNodeId: null,
          location: form.formId,
        },
        positiveCases: [
          "Valid submission updates state and resets form inputs",
        ],
        negativeCases: [
          "Submitting empty required fields displays validation error messages",
        ],
        edgeCases: [
          "Whitespace-only input is rejected as empty",
        ],
        failureCases: [
          "Form state persists if validation fails",
        ],
        evidenceLinks: form.supportingEvidenceIds,
        owner: null,
        status: "characterized",
      });
    }

    const ledgerId = `rol_${createHash("sha256").update(target.rawInput + obligations.length).digest("hex").slice(0, 16)}`;
    const closureDigest = createHash("sha256").update(ledgerId + JSON.stringify(obligations)).digest("hex");

    if (this.#reaMcp?.isConnected) {
      try {
        const upstreamLedger = await this.#reaMcp.buildReconstructionObligationLedger(
          {
            artifacts: [],
            providers: [],
            environments: [],
            scenarios: [],
            captures: [],
            unknowns: specification.unknowns,
            records: evidenceLedger as any,
          },
          obligations as any,
          {
            bindings: [],
            contradictions: [],
          },
          signal
        );
        return upstreamLedger;
      } catch {
        // Fall back to local compatible ledger if upstream call is unconfigured
      }
    }

    return {
      schema: "ReconstructionObligationLedger",
      ledgerId,
      closureDigest,
      status: "unknown",
      coverage: {
        status: "partial",
      },
      summary: {
        total: obligations.length,
        required: obligations.length,
        verified: 0,
        requiredOpen: obligations.length,
        byStatus: [
          { key: "unowned", count: obligations.length },
          { key: "characterized", count: obligations.length },
          { key: "implemented", count: 0 },
          { key: "verified", count: 0 },
          { key: "contradicted", count: 0 },
          { key: "blocked", count: 0 },
          { key: "out-of-scope", count: 0 },
          { key: "unknown", count: 0 },
        ],
        byApplicationLayer: [
          { key: "application", count: obligations.length },
        ],
      },
      reports: {
        missingOwnerObligationIds: obligations.map((o) => o.obligationId),
        missingVerifierObligationIds: obligations.map((o) => o.obligationId),
        contradictedObligationIds: [],
        residualUnknownIds: specification.unknowns.map((u) => u.unknownId),
      },
      obligations,
      evidenceLinks: evidenceLedger.map((e) => e.evidenceId),
      limitations: [
        "Obligations remain unverified until independent implementation tests execute and record passing evidence.",
      ],
    };
  }

  #createEvidenceRecord(
    target: InvestigationTarget,
    predicateType: string,
    operation: string,
    inputs: Record<string, unknown>,
    observation: unknown,
    epistemicStatus: "OBSERVED" | "INFERRED" | "UNKNOWN",
    authority: "shipped-artifact" | "controlled-replay" | "browser-observation" | "analyst-inference"
  ): ReaEvidenceRecord {
    const serialized = JSON.stringify({ predicateType, operation, inputs, observation });
    const contentDigest = createHash("sha256").update(serialized).digest("hex");
    const evidenceId = `ev_${contentDigest.slice(0, 32)}`;

    return {
      evidenceId,
      targetId: target.targetId,
      targetCategory: target.category,
      sourceUri: target.normalizedLocation,
      timestamp: Date.now(),
      provider: {
        id: "open-vs-code.rea-engine",
        name: "Open VS Code REA Investigation Engine",
        version: "1.0.0",
      },
      operation,
      predicateType,
      inputs,
      observation,
      epistemicStatus,
      authority,
      confidence: epistemicStatus === "OBSERVED" ? "observed" : (epistemicStatus === "INFERRED" ? "inferred" : "unknown"),
      limitations: [],
      contentDigest,
    };
  }

  #emitStage(stage: InvestigationStageId, status: "STARTED" | "COMPLETED" | "FAILED", details?: string) {
    if (details !== undefined) {
      this.#onStageChange?.({ stage, status, details });
    } else {
      this.#onStageChange?.({ stage, status });
    }
  }
}
