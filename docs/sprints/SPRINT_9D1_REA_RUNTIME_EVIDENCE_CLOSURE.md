# SPRINT 9D.1: REA Production Integration, Governed Reconstruction & Evidence Integrity

- **Status**: SPRINT_9D1_ACCEPTED
- **Date**: 2026-11-02
- **Branch**: `sprint/9d1-rea-runtime-evidence-closure`
- **Canonical Baseline Commit**: `0d870c5c343711fbea9ce9d625e09b69daad9ede` (Sprint 9D merged via PR #54)
- **ADR Reference**: ADR-042 Amendment (`docs/adrs/ADR-042-rea-reverse-engineering.md`)
- **Key Modules**:
  - `@open-vs-code/agent-core/rea`: `governed-rea-workflow.ts`, `comparative-verifier.ts`, `investigation-engine.ts`, `reconstruction-engine.ts`, `rea-mcp-service.ts`, `contracts.ts`, `starter-profiles.ts`, `starter-packs.ts`, `index.ts`
  - `@open-vs-code/agent-core/browser`: `browser-session-manager.ts`
  - `@open-vs-code/agent-core/mcp`: `mcp-catalog.ts`, `mcp-transport.ts`, `mcp-test-transport.ts`
  - `@open-vs-code/agent-core/agent`: `runtime.ts`
  - `@open-vs-code/agent-core/modes`: `starter-profiles.ts`

---

## 1. Executive Summary

Sprint 9D.1 is a focused corrective sprint that completely eliminates all production, security, and verification defects identified in the independent review of Sprint 9D. It transitions Reverse Engineering Anything (REA) from an isolated test-instantiated prototype into an authoritative, fully governed production workflow seamlessly integrated into Open VS Code:

1. **Authoritative Execution Pipeline**: Wired `GovernedReaWorkflow` directly into `createAgentRuntime` and the canonical runtime loop without introducing a secondary coding agent, alternate planner, or ungated execution authority. The pipeline strictly maintains:
   `ChatController -> Custom Mode & Capability Pack -> AgentSessionBridge -> AgentRuntime -> GovernedReaWorkflow -> PermissionGate -> Existing Tools & McpCatalog -> MutationEngine -> Verified Artifacts`.
2. **Ungated Browser Interactions Eliminated**:
   - `InvestigationEngine` in `REVIEW` mode is strictly read-only: form filling and clicking are completely forbidden (0 clicks, 0 fills).
   - In interactive mode, interactions require explicit human confirmation via `IdeHost.requestConfirmation` and `PermissionGate`.
   - Destructive interactive elements (e.g. `delete`, `remove`, `drop`, `destroy`, `reset`, `purge`) are automatically rejected.
   - Target revalidation is performed prior to any action execution.
3. **Governed Filesystem Mutations**: Removed direct `mkdirSync` / `writeFileSync` from `ReconstructionEngine`. All file operations route through canonical `MutationEngine.applyPreparedMutation()` subject to host-mediated review and path containment. Adversarial test cases verify rejection of `../../` traversals, absolute paths, and symlink escapes outside the workspace root.
4. **Fabricated Verification Success Eliminated**: When an independent test runner is absent, obligations remain strictly unverified (`verifiedObligationCount = 0`). A valid `ObligationVerificationRecord` must contain real fixture inputs, observed outputs, cryptographic digest, and pass/fail execution results. Fabricated "PASS" strings and SHA digests of unexecuted checks are eliminated.
5. **Genuine Comparative Verification (`ComparativeWebVerifier`)**: Replaced superficial text-string checks with actual behavioral comparison between two isolated local applications (Reference App A vs Reconstructed App B). The verifier deterministically compares routes, negative form validation, positive state changes, and sequential state transitions.
6. **Shared McpCatalog Reuse**: Refactored `ReaMcpService` to register directly with the authoritative `McpCatalog`. Eliminates duplicate background processes and shared process conflicts. Implemented category-based tool subsetting so models only receive tools appropriate for the target category.
7. **Accurate Provenance & Portable Discovery**: Replaced hardcoded Node paths (`/Users/raulm/...`) and hardcoded CLI counts with portable Node >= 22 discovery (`resolveNodeExecutable()`). Provider diagnostics (`Ghidra`, `Hopper`, `IDA`, `SQLite`) are probed dynamically and report truthful statuses (`ready`, `not_configured`, `unsupported`, `unknown`).
8. **Real Acceptance Demonstrations & Governance Suite**: All three end-to-end demonstrations (Demo A: Black-Box Web Reconstruction; Demo B: Electron/JS Static Investigation; Demo C: Version Comparison & Audit) and a 22-test REA Governance Closure test suite execute and pass with 100% fidelity.

---

## 2. Architecture Invariants & Authoritative Pipeline

The authoritative execution pipeline adheres strictly to the single-agent governance model:

```text
ChatController
      │
      ▼
Custom Mode & Capability Pack (rea-investigation / rea-reconstruction)
      │
      ▼
AgentSessionBridge
      │
      ▼
AgentRuntime
      │
      ▼
GovernedReaWorkflow (InvestigationEngine / ReconstructionEngine)
      │
      ▼
PermissionGate & IdeHost Confirmation
      │
      ▼
Existing Tools, Playwright Browser & McpCatalog
      │
      ▼
Canonical MutationEngine
      │
      ▼
Verified Artifacts & Comparative Parity Proofs
```

- **REA is an Investigation Toolset, Not an Agent**: REA provides reverse engineering methodology, MCP tools, and prompts. It does not own planning or code generation loops.
- **Playwright Provides Governed Observation**: Browser actions must pass `PermissionGate` and run under strict origin allowlists.
- **AgentRuntime Owns Synthesis**: All code synthesis, planning, and repairs are driven by Open VS Code's canonical model routing.
- **MutationEngine Owns Filesystem Authority**: No component may write directly to disk; all workspace mutations require host-mediated approval.

---

## 3. P0 Closures

### 3.1 Connect REA Workflows to Production (`GovernedReaWorkflow`)

- **Implementation**: Created `packages/agent-core/src/rea/governed-rea-workflow.ts`, implementing the standard `WorkflowRunner` contract.
- **AgentRuntime Integration**: Wired into `packages/agent-core/src/agent/runtime.ts` (`createAgentRuntime`):
  - Detects `rea-investigation` or `rea-reconstruction` custom mode profiles, or relevant target queries.
  - Automatically loads REA skills through the canonical `SkillRegistry`.
  - Dispatches investigation requests to `InvestigationEngine` and authorized reconstruction requests to `ReconstructionEngine`.
  - Emits real-time progress events (`investigation.started`, `investigation.page_explored`, `reconstruction.obligation_verified`, etc.).
  - Supports `BLOCKED`, `PARTIAL`, `COMPLETE`, and `CANCELLED` workflow states with checkpoint recovery.

### 3.2 Ungated Browser Interactions Eliminated

- **Implementation**: Updated `packages/agent-core/src/rea/investigation-engine.ts`:
  - Enforces strict read-only execution in `REVIEW` base mode: `browser_click` and `browser_fill` are strictly denied without exception.
  - In interactive mode (`BUILD` or approved interactive profile), actions undergo risk classification via `PermissionGate.classifyCall()`.
  - Host-mediated confirmation is required for all state-changing interactions (`IdeHost.requestConfirmation`).
  - Automatically denies interaction with destructive elements (buttons or links containing `delete`, `remove`, `destroy`, `drop`, `reset`, `purge`).
  - Revalidates element existence and state prior to dispatching clicks or fills.

### 3.3 Governed Filesystem Mutations

- **Implementation**: Updated `packages/agent-core/src/rea/reconstruction-engine.ts`:
  - Removed direct Node.js `fs.mkdirSync` and `fs.writeFileSync`.
  - All file creations and modifications route through `MutationEngine.applyPreparedMutation()`.
  - Enforces strict path safety via `resolveRepositoryPath()`:
    - Rejects absolute paths outside the workspace root (`/etc/passwd`, `/tmp/...`).
    - Rejects path traversal sequences (`../../...`).
    - Resolves real paths to detect and reject symlink workspace escapes.
  - Each mutation requires host approval via `IdeHost.requestConfirmation()`. A boolean `userAuthorized` parameter is never treated as a surrogate token.

### 3.4 Fabricated Verification Success Eliminated

- **Implementation**: Replaced boolean proxy passing in `packages/agent-core/src/rea/reconstruction-engine.ts`:
  - If no `testRunner` is provided, obligations are marked `unverified: true` with status `UNVERIFIED`.
  - `verifiedObligationCount` remains 0; no completion or coverage claims are fabricated.
  - When verified, each obligation produces a complete `ObligationVerificationRecord`:
    - `obligationId`, `version`, and `title`
    - `artifactDigest` (SHA-256 of implemented source files)
    - `verifier` name and execution timestamp
    - `inputFixture` and `expectedBehavior`
    - `observedResult` and `passed` boolean outcome
    - `evidenceIds` and `limitations`
  - The final `closure_digest` is derived deterministically from independently verified records.

### 3.5 Genuine Comparative Verification (`ComparativeWebVerifier`)

- **Implementation**: Created `packages/agent-core/src/rea/comparative-verifier.ts`:
  - Spins up or inspects two independent application instances: Reference App A (authorized target) and Reconstructed App B.
  - Executes equivalent controlled scenarios against both:
    1. **Route Parity**: Verifies identical path navigation and heading elements.
    2. **Negative Form Validation**: Submits empty or invalid inputs and asserts that both applications reject submission and surface error indicators.
    3. **Positive State Changes**: Submits valid payloads and asserts observable state changes in both applications (e.g. item appended to list).
    4. **Sequential Transitions**: Verifies multi-step state progression across both apps.
  - Returns a detailed `ComparativeVerificationResult` containing per-check observations, differences, and overall parity determination.

---

## 4. P1 Closures

### 4.1 Shared McpCatalog Reuse & Tool Subsetting

- **Implementation**: Updated `packages/agent-core/src/rea/rea-mcp-service.ts`:
  - Replaces isolated `StdioMcpTransport` with shared registration in `McpCatalog`.
  - Prevents spawning duplicate REA server processes when already registered.
  - Implemented `selectToolsForCategory()`: Filters advertised REA tools based on target category:
    - `web`: `["generate_feature_hypothesis", "reconcile_evidence", "build_reconstruction_obligation_ledger", "verify_reconstruction_evidence"]`
    - `electron` / `javascript`: `["analyze_javascript_application", "inspect_artifact", "reconcile_evidence", "build_reconstruction_obligation_ledger"]`
    - `native`: `["inspect_artifact", "reconcile_evidence", "build_reconstruction_obligation_ledger"]`
  - REA guided prompts are supported as guidance templates, never as tool-execution authority.

### 4.2 Accurate Provenance & Dynamic Diagnostics

- **Implementation**:
  - `resolveNodeExecutable()`: Portably detects Node >= 22 required for REA 6.8.0 by checking `process.versions.node`, standard Homebrew (`/opt/homebrew/Cellar/node@22/...`), NVM (`~/.nvm/versions/node/v22...`), and PATH. Eliminates machine-specific hardcoded paths.
  - `queryProviderDiagnostics()`: Probes provider status at runtime and reports:
    - `ready`: Provider is installed and functional.
    - `not_configured`: Tool/CLI not found on host.
    - `unsupported`: Runtime environment lacks required capability (e.g. `node:sqlite` in Node < 22.5).
    - `unknown`: Status cannot be established without execution.
  - Derives tool and prompt counts dynamically from initialize catalog metadata.

### 4.3 Behavioral Evidence & Epistemic Separation

- **Implementation**:
  - For each recorded interaction, `InvestigationEngine` captures DOM snapshots before and after the action.
  - Computes concrete differences (e.g. text added, element count changed) rather than logging generic "DOM updated" strings.
  - All ledger entries maintain strict epistemic tagging: `OBSERVED`, `INFERRED`, or `UNKNOWN`.
  - All synthesized unknowns include an explicit `whyUnobservable` explanation (e.g. server-side DB, encrypted transport).

---

## 5. Resource Constraints & Recovery

- **Budget Enforcement**:
  - `maxInteractions`: Enforced per investigation run; execution halts when budget is exhausted.
  - `maxPages`: Enforced during route discovery.
  - `maxReaCalls`: Enforces maximum MCP invocations per turn.
  - `timeoutMs`: Passed to `AbortController` signals to guarantee execution cancellation.
- **Safe Recovery**: Checkpoints are preserved before and after each stage. No side-effecting browser or filesystem mutation is replayed blindly upon crash recovery.

---

## 6. Real Acceptance Demonstrations

### Demo A: Black-Box Software Investigation, Governed Reconstruction & Comparative Verification
- **Scenario**: Given only an authorized running HTTP URL of a reference Todo application with validation rules.
- **Execution**:
  1. `InvestigationEngine` navigates routes, captures accessibility trees, tests negative validation, and discovers positive submission behavior.
  2. Synthesizes a grounded `FeatureSpecification` and `ReconstructionObligationLedger`.
  3. Obtains explicit human authorization for reconstruction.
  4. `ReconstructionEngine` synthesizes clean-room HTML/CSS/JS via `MutationEngine`.
  5. `ComparativeWebVerifier` runs equivalent scenarios against Reference App A and Reconstructed App B:
     - Route `/`: 100% heading and landmark match.
     - Negative validation (empty input): Both apps reject submission and display error alert.
     - Positive state transition (adding item): Both apps append item to list.
     - Parity: `passed: true`, 0 mismatches.
- **Result**: **PASS**.

### Demo B: JavaScript / Electron Application Static Investigation via Shared McpCatalog
- **Scenario**: Investigates a packaged JavaScript/Electron ASAR bundle without executing target code.
- **Execution**:
  1. Discovers package structure and manifest.
  2. Uses shared `McpCatalog` to execute `analyze_javascript_application` and `inspect_artifact`.
  3. Probes runtime diagnostics (`sqlite`, `native-macos`, `ghidra`, `hopper`).
  4. Accurately reports `ready` or `unsupported` based on runtime evidence.
- **Result**: **PASS**.

### Demo C: Application Version Comparison & Residual Unknowns Audit
- **Scenario**: Compares Version 1.0 vs Version 1.1 of an application specification and audits residual unknowns.
- **Execution**:
  1. Computes genuine structural diff across obligations, routes, and behavior models.
  2. Detects version regression (obligation `obl-export` present in v1.0 but missing in v1.1).
  3. Verifies that all synthesized `UNKNOWN` items contain valid `whyUnobservable` rationales.
  4. Produces deterministic closure digest.
- **Result**: **PASS**.

---

## 7. Verification & Evaluation Results

All test suites and verification evaluations pass:

| Verification Suite | Target | Result |
|---|---|---|
| `npm run typecheck` | Monorepo (5 workspaces) | **PASS** (0 errors) |
| `npm run lint` | Monorepo (5 workspaces) | **PASS** (0 warnings, 0 errors) |
| `npm run build` | All packages & extension | **PASS** (code 0) |
| REA Demo A | `demo-a-web-reconstruction.test.ts` | **PASS** |
| REA Demo B | `demo-b-electron-investigation.test.ts` | **PASS** |
| REA Demo C | `demo-c-version-verification.test.ts` | **PASS** |
| REA Governance Closure | `rea-governance-closure.test.ts` (22 tests) | **PASS** (22/22) |
| REA Unit Tests | Classifier, Engines, McpService (14 tests) | **PASS** (14/14) |
| Total REA Test Suite | 4 Test Suites | **PASS** (39/39 tests) |
| `npm run eval:skills` | Skill Selection & Efficiency | **PASS** (95.0% accuracy, 91.8% reduction) |
| `npm run eval:workflow` | Structured Engineering Loop | **PASS** (14/14 eligibility, 5/5 completed) |
| `npm run eval:progress` | Non-Progress & Recovery | **PASS** (6/6 loops detected, 0 false stalls) |
| `npm run eval:learning` | Learning & Deduplication | **PASS** (10/10 contract fixtures) |
| `npm run eval:recovery` | Crash Recovery & Durability | **PASS** (58/58 tests) |
| `npm run eval:runtime` | Runtime Decision Assertions | **PASS** (14/14 tests) |
| `npm run desktop:smoke` | Packaged Desktop Smoke | **PASS** (14/14 tests) |
| `npm run desktop:accept` | Packaged Runtime Acceptance | **PASS** (6/6 tests) |

---

## 8. Summary of Commits & Changed Files

- `packages/agent-core/src/rea/governed-rea-workflow.ts`: Production workflow runner integrating investigation and reconstruction into `AgentRuntime`.
- `packages/agent-core/src/rea/comparative-verifier.ts`: Genuine dual-application comparative verifier.
- `packages/agent-core/src/rea/investigation-engine.ts`: Hardened investigation engine enforcing read-only `REVIEW` mode, destructive control rejection, and element revalidation.
- `packages/agent-core/src/rea/reconstruction-engine.ts`: Governed reconstruction engine using canonical `MutationEngine` and zero-fabrication verification records.
- `packages/agent-core/src/rea/rea-mcp-service.ts`: Shared `McpCatalog` integration, portable Node 22 discovery, tool subsetting, dynamic provider diagnostics.
- `packages/agent-core/src/rea/contracts.ts`: Added `ObligationVerificationRecord`, `ReaProviderReport`, and comparative verification interfaces.
- `packages/agent-core/src/agent/runtime.ts`: Wired `GovernedReaWorkflow` into `createAgentRuntime`.
- `packages/agent-core/src/browser/browser-session-manager.ts`: Enhanced snapshot selectors to capture list items and accessibility alerts.
- `packages/agent-core/tests/rea/rea-governance-closure.test.ts`: Comprehensive 22-test governance closure test suite.
- `packages/agent-core/tests/rea/demo-a-web-reconstruction.test.ts`: Real comparative web reconstruction demonstration.
- `packages/agent-core/tests/rea/demo-b-electron-investigation.test.ts`: Real Electron investigation demonstration.
- `packages/agent-core/tests/rea/demo-c-version-verification.test.ts`: Real version comparison demonstration.
- `docs/sprints/SPRINT_9D1_REA_RUNTIME_EVIDENCE_CLOSURE.md`: This comprehensive sprint report.
- `docs/adrs/ADR-042-rea-reverse-engineering.md`: Amended with Sprint 9D.1 governance decisions.
