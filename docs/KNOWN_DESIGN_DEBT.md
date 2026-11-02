# Known Design Debt & Production Release Blockers

This document tracks known limitations and defects in the Advanced Design & Motion subsystem (Sprint 9C and Sprint 9C.1). These defects represent **Design V1 Release Blockers** and must be resolved before declaring the design capability production-ready.

In accordance with Sprint 9D architectural directives, Sprint 9D reverse engineering and reconstruction strictly avoids relying on these unverified Advanced Design template paths. Reconstructions use the canonical `AgentRuntime`, `MutationEngine`, and verified test execution instead.

---

## Blocker Inventory

| ID | Title | Severity | Impacted Component | Status | Target Resolution |
|---|---|---|---|---|---|
| **DD-01** | Template-driven markup and motion generation | High | `GovernedDesignWorkflow` (Stage C & D) | Open (Release Blocker) | Sprint 10 Design V1 |
| **DD-02** | GovernedDesignWorkflow model provider omission | High | `GovernedDesignWorkflow` | Open (Release Blocker) | Sprint 10 Design V1 |
| **DD-03** | Browser QA synthetic fallback risk | Medium | `BrowserPanelController.#handleRunVisualQa` | Open (Release Blocker) | Sprint 10 Design V1 |
| **DD-04** | Structured workflow disabled by default in desktop | Medium | Desktop Configuration (`config.json`) | Open (Release Blocker) | Desktop Beta |
| **DD-05** | Stage path create-only restriction (no edit) | High | `design-workflow.ts` / `governed-design-workflow.ts` | Open (Release Blocker) | Sprint 10 Design V1 |
| **DD-06** | Hardcoded model-call and token metrics | Low | `GovernedDesignWorkflow.getMetrics` | Open (Release Blocker) | Sprint 10 Telemetry |
| **DD-07** | QA report file writes bypass confirmation | Medium | `BrowserPanelController` QA report writer | Open (Release Blocker) | Sprint 10 Design V1 |

---

## Detailed Blocker Specifications

### DD-01: Template-Driven Frontend Markup & Motion Generation
- **Description**: Stage C (Frontend Implementation) and Stage D (Motion Engineering) synthesize HTML markup, CSS variables, and animation declarations primarily using deterministic template heuristics derived from `DesignBrief` rather than dynamic LLM generation.
- **Impact**: Output variety is bounded by the static templates; novel or unconventional layouts from user briefs are normalized into standard patterns.
- **Acceptance Criteria for Closure**:
  1. Frontend code generation invokes the configured model via `ModelRouter` using the `frontend-composition` and `motion-engineering` skills.
  2. Generated code is synthesized directly from model streaming output rather than static string interpolation.
  3. Template fallback is invoked only if model inference fails and is explicitly flagged as `SYNTHETIC_FALLBACK`.

### DD-02: GovernedDesignWorkflow Model Provider Omission
- **Description**: `GovernedDesignWorkflow` runs sequentially through stages A through E without delegating prompt reasoning to the active `ModelProvider` or `AgentRunner`.
- **Impact**: The design engine operates in a deterministic scripted mode rather than acting as an AI pair designer.
- **Acceptance Criteria for Closure**:
  1. `GovernedDesignWorkflow` accepts a bound `ModelRouter` and `TaskContext`.
  2. Prompts are constructed using loaded stage skills and dispatched to the model provider.
  3. Human confirmations are requested for code mutations produced by the model.

### DD-03: Browser QA Synthetic Fallback Risk
- **Description**: While `BrowserSessionManager.observeVisualQaState()` inspects real DOM elements when a live browser is attached, headless or unattached environments can fall back to synthetic DOM/style values in automated QA sweeps.
- **Impact**: Potential false-positive contrast or layout passes if the fallback values happen to satisfy the heuristics.
- **Acceptance Criteria for Closure**:
  1. In the absence of an active Playwright browser session, `observeVisualQaState()` must return `INSUFFICIENT_EVIDENCE` or fail closed rather than returning synthetic placeholder styles.
  2. Automated test reports must declare provenance (`live_browser_dom` vs `unsupported_measurement`).

### DD-04: Structured Workflow Disabled by Default in Desktop
- **Description**: Structured engineering workflow (`workflowPreference: "structured"`) defaults to disabled in the desktop application configuration to maintain low-latency direct chat for casual users.
- **Impact**: Desktop users do not automatically benefit from structured multi-stage design pipelines unless explicitly configured.
- **Acceptance Criteria for Closure**:
  1. Add a user-visible workflow preference toggle in the Settings UI.
  2. Provide capability pack activation that selectively enables structured workflow per project or custom mode.

### DD-05: Stage Path Create-Only Restriction
- **Description**: The current design implementation stage path assumes greenfield generation (`create_file`) for `index.html`, `styles.css`, and `app.js`. Incremental modification of existing application codebases via `apply_patch` is not fully supported in the design workflow.
- **Impact**: Cannot run the design workflow against existing, complex frontends without overwriting existing files.
- **Acceptance Criteria for Closure**:
  1. Support diff-based patching via `MutationEngine.prepareMutation()` with `type: "patch"`.
  2. Inspect existing workspace styles and markup before generating changes.

### DD-06: Hardcoded Model-Call and Token Metrics
- **Description**: Metrics returned by `GovernedDesignWorkflow.getMetrics()` include estimated or static token counts rather than live provider-reported tokens.
- **Impact**: Inaccurate token cost accounting in activity timelines and billing diagnostics.
- **Acceptance Criteria for Closure**:
  1. Thread actual token usage counters from `ModelClient` response headers / chunks through `DesignWorkflowMetrics`.
  2. Record prompt tokens, completion tokens, and cache hits per stage.

### DD-07: QA Report File Writes Bypass Confirmation
- **Description**: Some automated QA audit summaries generated by the browser panel controller write directly to disk or scratch buffers without requesting `IdeHost.requestConfirmation()`.
- **Impact**: Violates strict permission boundary requiring all workspace file writes to be confirmed by the human operator.
- **Acceptance Criteria for Closure**:
  1. Ensure all report writes route through `MutationEngine` or require explicit user confirmation.
  2. Out-of-repo artifacts must be restricted to ephemeral temp directories with automatic cleanup.
