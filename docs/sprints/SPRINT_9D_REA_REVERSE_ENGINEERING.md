# Sprint 9D Report: REA Reverse Engineering — Software Investigation, Evidence-Driven Reconstruction & Agent Specialization

## 1. Executive Summary

Sprint 9D delivers a production-oriented Reverse Engineering Capability Pack and skill ecosystem for Open VS Code, grounded in the methodology and open-source implementation of **Reverse Engineer Anything (REA)** (version `6.8.0`, pinned commit `f95bdbce76fa538d9383a36c7dde0468078b42f4`).

Developers and reverse engineering practitioners can now investigate authorized software targets—running web applications (URL-only, black-box), packaged JavaScript / Electron applications, native or packaged binaries, or source repositories—and synthesize a grounded functional specification, compile deterministic reconstruction obligation ledgers, and execute governed clean-room reconstructions with cryptographic closure verification.

### Core Architecture Highlights

1. **Dual Capability Pack Architecture (ADR-042)**:
   - **REA Investigation Pack** (`rea-investigation-pack`, schema `open-vs-code/capability-pack@v1`): Read-only exploration and analysis under `REVIEW` canonical base mode. Inspects authorized software, discovers features and state graphs, gathers evidence records, and produces specifications and obligation ledgers without repository mutation or arbitrary execution.
   - **REA Reconstruction Pack** (`rea-reconstruction-pack`, schema `open-vs-code/capability-pack@v1`): Governed clean-room implementation under `BUILD` canonical base mode. Consumes approved specifications, enforces explicit user authorization via `PermissionGate`, synthesizes independent clean-room code, executes verification suites, and deterministically closes obligations.

2. **Epistemic Classification & Evidence Discipline**:
   - Every claim is explicitly tagged with its epistemic status: `OBSERVED` (directly witnessed runtime behavior or file artifact), `INFERRED` (hypotheses, architectural patterns, unobserved business rules), or `UNKNOWN` (unobservable persistence, server-side secrets).
   - Inferred hypotheses are never treated as confirmed facts.
   - Residual unknowns declare why they are unobservable, their risk level, and required mitigations.

3. **Four Distinct Investigation Workflows**:
   - **Category A (Running Web Application)**: URL-only, black-box exploration using real Chromium via `BrowserSessionManager`. Inspects navigation, forms, interactive controls, and observable DOM state transitions without requiring source code.
   - **Category B (JavaScript / Electron Application)**: Inspects ASAR archives and unpacked directories, connects to the local REA MCP server to execute `analyze_javascript_application`, extracts static application graphs and IPC boundaries.
   - **Category C (Native or Packaged Application)**: Probes magic bytes (Mach-O, ELF, PE) and safe binary headers. Transparently audits external provider prerequisites (Ghidra, Hopper, IDA Pro, Kuna) and reports unconfigured dependencies with exact remediation without assuming they are installed.
   - **Category D (Existing Source Repository)**: Uses standard Open VS Code repository tools first, invoking REA only when shipped runtime artifacts or decompilation observations are required.

4. **8 Specialized Built-in Skills**:
   - `rea-investigation-routing`: Deterministic target categorization, scope gating, and workflow routing.
   - `browser-behavior-investigation`: Bounded web exploration, form mapping, and state transition capture.
   - `javascript-electron-analysis`: Electron/ASAR artifact inspection and IPC bridge analysis.
   - `native-artifact-analysis`: Safe executable probing and decompiler prerequisite diagnostics.
   - `feature-specification`: Grounded synthesis of functional requirements and interaction graphs.
   - `evidence-reconciliation`: Triangulation of multiple evidence records and contradiction detection.
   - `reconstruction-planning`: Clean-room implementation planning and obligation assignment.
   - `reconstruction-verification`: Test-driven obligation closure and cryptographic digest computation.

---

## 2. Upstream Audit & Pinned Provenance

- **Repository**: [https://github.com/morluto/rea](https://github.com/morluto/rea)
- **Pinned Commit**: `f95bdbce76fa538d9383a36c7dde0468078b42f4`
- **Release Version**: `6.8.0`
- **License**: MIT (audited and recorded in `THIRD_PARTY_NOTICES.md` and `REFERENCE_MAP.md`).
- **MCP Tool Catalog**: REA advertises 234 MCP tools over stdio JSON-RPC.
- **Guided Prompts Supported & Verified**:
  - `investigate_feature`: Structured behavioral and security inquiry for specific features.
  - `compare_application_versions`: Version-to-version diffing and behavioral drift analysis.
  - `verify_reconstruction`: Obligation verification and parity assessment against specifications.
  - `audit_residual_unknowns`: Systematic auditing of unobservable architectural layers.
  - `trace_crash`: Root-cause diagnosis for process signals and abnormal terminations.
  - `prepare_bounded_process_capture`: Guided sandbox preparation for bounded runtime execution.

---

## 3. Mandatory Executable Demonstrations

### Demo A: Black-Box Web Application Investigation & Governed Clean-Room Reconstruction
- **Test File**: `packages/agent-core/tests/rea/demo-a-web-reconstruction.test.ts`
- **Scenario**: A running local web application (`http://127.0.0.1:<port>/tasks-app`) hosting an interactive form-based Task Management application.
- **Investigation**: Engine received **only the URL**; no source code was provided. Real headless Chromium navigated to the application, took accessibility snapshots, identified textbox controls and submit buttons, executed permitted interactions, and captured observable state transitions (`initialState` -> `userAction` -> `resultingState` -> `visibleChange`).
- **Specification & Ledger**: Synthesized functional specification with observed business rules and explicit unknowns (`database_schema`), compiling an initial `ReconstructionObligationLedger` with `characterized` obligations.
- **Reconstruction**: Governed `ReconstructionEngine` enforced explicit human approval (`userAuthorized: false` failed closed). When authorized, clean-room HTML/JS modules were generated, independent verification tests were executed, state transition parity was verified, and the ledger transitioned to `verified` with a deterministic closure digest.

### Demo B: JavaScript / Electron Static Investigation via Real REA MCP
- **Test File**: `packages/agent-core/tests/rea/demo-b-electron-investigation.test.ts`
- **Scenario**: An authorized Electron application fixture containing `package.json`, main process script, preload context bridge, and renderer UI.
- **Classification**: `classifyInvestigationTarget` categorized the artifact as `javascript_electron_app` with format `unpacked_electron_directory`.
- **Tool Execution**: `ReaMcpService` connected to `/tmp/rea-upstream/scripts/rea.mjs` and invoked `analyze_javascript_application`. REA returned an evidence record with SHA-256 digest and static module graph.
- **Guided Prompt**: Invoked `investigate_feature` prompt with `{ feature: "IpcDataTransfer", target_path: fixtureDir }`, receiving grounded analysis guidance.
- **Provider Diagnostics**: Confirmed safe native macOS inspection availability on Darwin and verified that unconfigured external disassemblers (Ghidra, Hopper, IDA Pro) fail closed with clear installation guidance.

### Demo C: Version Comparison, Obligation Verification & Residual Unknowns Audit
- **Test File**: `packages/agent-core/tests/rea/demo-c-version-verification.test.ts`
- **Scenario**: Comparative analysis between v1.0.0 baseline and v1.1.0 reconstruction.
- **Prompts**: Successfully invoked REA prompts `compare_application_versions`, `verify_reconstruction`, and `audit_residual_unknowns`.
- **Obligation Lifecycle**: Evaluated obligation progression from `characterized` to `verified` with PASS test evidence snippets and cryptographic digests. Verified that `closureDigest` is deterministically recalculated, changing from initial baseline to verified closure while accounting for residual unknowns.

---

## 4. Verification & Regression Results

All verification suites passed cleanly across the monorepo:

| Suite | Status | Details |
| --- | --- | --- |
| **Lint** (`oxlint`) | **PASS** | 0 warnings, 0 errors across all workspaces (39 account-service, 298 agent-core, 6 cli). |
| **Typecheck** (`tsc --noEmit`) | **PASS** | 0 errors across `@open-vs-code/account-service`, `@open-vs-code/agent-core`, `@open-vs-code/cli`, `@open-vs-code/ide-adapter`, `@open-vs-code/vscode-integration`. |
| **Build** (`npm run build`) | **PASS** | Bundled extension and 21 built-in skills copied cleanly to distribution. |
| **REA Test Suite** (`tests/rea/*.test.ts`) | **PASS** | 16/16 tests passed (Target classification, REA MCP service, investigation engine, reconstruction engine, Demo A, Demo B, Demo C). |
| **Skills Evaluation** (`eval:skills`) | **PASS** | 38/40 (95.0%) accuracy across 21 skills; all skills strictly within declared token budgets (<850 tokens). |
| **Runtime Evaluation** (`eval:runtime`) | **PASS** | 14/14 tests passed; 111 scenarios across 12 categories evaluated with zero divergence. |
| **Workflow Evaluation** (`eval:workflow`) | **PASS** | 14/14 eligibility cases passed; 5/5 structured fixtures verified; review bias probed. |
| **Progress Evaluation** (`eval:progress`) | **PASS** | 6/6 loops detected; 0 false stalls on progressing tasks; non-progress recovery verified. |
| **Learning Evaluation** (`eval:learning`) | **PASS** | 10/10 contract fixtures passed; 0 false promotions; 87.2% storage reduction. |
| **Performance Evaluation** (`eval:performance`) | **PASS** | 5/5 tests passed; 100 measured scenarios deterministic. |
| **Recovery Evaluation** (`eval:recovery`) | **PASS** | 58/58 tests passed; journal read integrity, fail-closed durability, and crash recovery verified. |
| **VS Code Integration Tests** | **PASS** | 277/277 tests passed across 40 suites. |
| **Desktop Smoke Tests** (`desktop:smoke`) | **PASS** | 14/14 tests passed; packaging, codesign, bundled extension activation verified. |
| **Desktop Acceptance Tests** (`desktop:accept`) | **PASS** | 6/6 tests passed; real packaged Electron app, VSCodium extension host, codesign, and Visual Browser QA panel verified. |

---

## 5. Architectural Invariants Preserved

1. **Zero New AgentRuntimes**: REA capabilities run entirely within the canonical `AgentRuntime` and Open VS Code Capability Pack / Mode architecture.
2. **Deterministic Security Boundary**: Human authorization is strictly required for clean-room reconstruction; file mutation without user consent fails closed with `ReconstructionAuthorizationError`.
3. **No Phantom Tools**: Tool schemas and prompt signatures directly reflect the connected REA server's advertised catalog.
4. **Local-First Operation**: All evidence, specifications, and obligation ledgers remain stored locally; loopback targets obey strict network isolation and SSRF rejection policies.
5. **Epistemic Truthfulness**: Hypotheses are never treated as facts; residual unknowns declare exact reasons for unobservability.

**Acceptance Status**: `SPRINT_9D_ACCEPTED`
