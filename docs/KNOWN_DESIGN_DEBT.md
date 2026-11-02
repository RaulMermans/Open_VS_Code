# Known Design Debt & Production Release Blockers

This document tracks known limitations and defects in the Advanced Design & Motion subsystem (Sprint 9C and Sprint 9C.1). These defects represent **Design V1 Release Blockers** and must be resolved before declaring the design capability production-ready.

In accordance with Sprint 9D architectural directives, Sprint 9D reverse engineering and reconstruction strictly avoids relying on these unverified Advanced Design template paths. Reconstructions use the canonical `AgentRuntime`, `MutationEngine`, and verified test execution instead.

---

## Blocker Inventory

| ID | Title | Severity | Impacted Component | Status | Target Resolution |
|---|---|---|---|---|---|
| **DD-01** | Template-driven markup and motion generation | High | `GovernedDesignWorkflow` (Stage C & D) | Closed (Sprint 10A.1) | Resolved with model provider code synthesis |
| **DD-02** | GovernedDesignWorkflow model provider omission | High | `GovernedDesignWorkflow` | Closed (Sprint 10A.1) | Resolved with provider option and complete() delegation |
| **DD-03** | Browser QA synthetic fallback risk | Medium | `GovernedDesignWorkflow.#evaluateCurrentState` | Closed (Sprint 10A.1) | Resolved with INSUFFICIENT_EVIDENCE blocker on missing Chromium |
| **DD-04** | Structured workflow disabled by default in desktop | Medium | Desktop Configuration (`config.json`) | Closed (Sprint 10A.1) | Resolved: ModeResolver emits DISABLED with enable command |
| **DD-05** | Stage path create-only restriction (no edit) | High | `governed-design-workflow.ts` | Closed (Sprint 10A.1) | Resolved: prepareFileMutation creates patches for existing files |
| **DD-06** | Hardcoded model-call and token metrics | Low | `GovernedDesignWorkflow.#recordStageRecord` | Closed (Sprint 10A.1) | Resolved: Live tracked stage model calls, tokens & tools |
| **DD-07** | QA report file writes bypass confirmation | Medium | `GovernedDesignWorkflow` Stage E | Closed (Sprint 10A.1) | Resolved: All QA report mutations gated on confirmation |
| **DD-08** | REA Investigation to Reconstruction handoff gap | High | `GovernedReaWorkflow.startReconstruction` | Closed (Sprint 10A.1C) | Resolved with ReaEvidenceBundle and fail-closed INVESTIGATION_REQUIRED |
| **DD-09** | Production verification wiring in REA reconstruction | High | `GovernedReaWorkflow` Stage 4 | Closed (Sprint 10A.1C) | Resolved: Wired createReaProductionTestRunner and loopback verifier |
| **DD-10** | Unbound confirmation tokens in reconstruction resume | High | `GovernedReaWorkflow.resume` | Closed (Sprint 10A.1C) | Resolved: Required exact active confirmation token and TOCTOU hash check |

---

## Detailed Blocker Specifications & Resolutions

### DD-01: Template-Driven Frontend Markup & Motion Generation
- **Description**: Stage C (Frontend Implementation) and Stage D (Motion Engineering) synthesize HTML markup, CSS variables, and animation declarations primarily using deterministic template heuristics derived from `DesignBrief` rather than dynamic LLM generation.
- **Resolution (Sprint 10A.1)**: Connected dynamic model completion via `#generateComponentWithModel` and `#generateMotionWithModel`. When a model provider is present, requests are completed with brief context and validated before applying. Falls back to brief-driven procedural layout only when offline.
- **Status**: Closed.

### DD-02: GovernedDesignWorkflow Model Provider Omission
- **Description**: `GovernedDesignWorkflow` runs sequentially through stages A through E without delegating prompt reasoning to the active `ModelProvider` or `AgentRunner`.
- **Resolution (Sprint 10A.1)**: Passed `provider` and `skills` through `GovernedDesignWorkflowOptions`. Wired model synthesis and model-assisted repair in Stage E refinement loop.
- **Status**: Closed.

### DD-03: Browser QA Synthetic Fallback Risk
- **Description**: While `BrowserSessionManager.observeVisualQaState()` inspects real DOM elements when a live browser is attached, headless or unattached environments can fall back to synthetic DOM/style values in automated QA sweeps.
- **Resolution (Sprint 10A.1)**: Removed synthetic DOM / computed style fabrication entirely. When Chromium browser observations are absent or fail, `#evaluateCurrentState` yields `INSUFFICIENT_EVIDENCE` with an explicit blocker finding. Zero visual PASS granted without real rendered evidence.
- **Status**: Closed.

### DD-04: Structured Workflow Disabled by Default in Desktop
- **Description**: Structured engineering workflow (`workflowPreference: "structured"`) defaults to disabled in the desktop application configuration to maintain low-latency direct chat for casual users.
- **Resolution (Sprint 10A.1)**: Added command `open-vs-code.enableWorkflow` ("Open VS Code: Enable Structured Workflow") in `packages/vscode-integration`. `ModeResolver` distinguishes `DISABLED` readiness status when `globalWorkflowEnabled: false`, setting `isReady = false` with actionable diagnostics. `AgentRuntime` fails closed if a specialized mode is executed without required workflow enablement.
- **Status**: Closed.

### DD-05: Stage Path Create-Only Restriction
- **Description**: The current design implementation stage path assumes greenfield generation (`create_file`) for `index.html`, `styles.css`, and `app.js`. Incremental modification of existing application codebases via `apply_patch` is not fully supported in the design workflow.
- **Resolution (Sprint 10A.1)**: Replaced greenfield `prepareCreate` with `#prepareFileMutation`. If a target file already exists on disk, `MutationEngine.preparePatch` is invoked with exact search/replace diffing, preserving existing files and project structures.
- **Status**: Closed.

### DD-06: Hardcoded Model-Call and Token Metrics
- **Description**: Metrics returned by `GovernedDesignWorkflow.getMetrics()` include estimated or static token counts rather than live provider-reported tokens.
- **Resolution (Sprint 10A.1)**: Implemented live stage telemetry tracking via `#stageModelCalls`, `#stageTokens`, `#stageTools`, and `#stageSkillInjected`. Stage records report actual model calls (0 if deterministic), actual provider tokens, and exact tools executed.
- **Status**: Closed.

### DD-07: QA Report File Writes Bypass Confirmation
- **Description**: Some automated QA audit summaries generated by the browser panel controller write directly to disk or scratch buffers without requesting `IdeHost.requestConfirmation()`.
- **Resolution (Sprint 10A.1)**: `DESIGN_QA_REPORT.md` is now routed through `#prepareFileMutation` and enters `WAITING_FOR_CONFIRMATION` for human approval unless `autoApprove: true` is explicitly configured.
- **Status**: Closed.

---

## Sprint 10A.1B Specialized Execution Closure Addendum

Sprint 10A.1B audited and closed the remaining production defects across Design and REA:
1. **Design Honest Model Execution**: Removed silent fallback to procedural templates when model completion throws or returns malformed markup; the stage fails closed as `BLOCKED`. Procedural fallbacks when the provider is intentionally omitted are explicitly stamped with `TEMPLATE_BASED_OUTPUT` banners.
2. **REA Reconstruction Authorization**: Closed the implicit authorization bug in `GovernedReaWorkflow`; reconstruction planning and file mutations now strictly suspend for host-mediated human approval (`WAITING_FOR_CONFIRMATION`) with cryptographic binding and empty directory rollback on rejection.
3. **REA Model Synthesis**: Connected `GovernedReaWorkflow` and `ReconstructionEngine` to the active model provider gateway, grounding synthesis in feature inventories, observed state transitions, and obligations.
4. **Execution Telemetry Truthfulness**: Replaced remaining static telemetry in `GovernedReaWorkflow` with live model call, token, and tool metrics (`modelCalls = 0` when uncalled).
