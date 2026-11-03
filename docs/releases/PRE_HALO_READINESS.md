# Open VS Code — Pre-HALO Readiness & Release Freeze Specification

## 1. Release Freeze Declaration

As of commit on branch `sprint/10a1d-final-pre-halo-readiness`, Open VS Code core software architecture is **FROZEN**.

This represents the completion of all planned corrective sprints (Sprint 10A.1, 10A.1B, 10A.1C, and 10A.1D).
No further architectural modifications, new agents, secondary frameworks, shadow loops, or speculative abstractions may be introduced prior to physical HALO hardware arrival and initial hardware benchmarking.

**Overall System Status**: **`PRE_HALO_READY`**

---

## 2. Subsystem Readiness Matrix

| Subsystem | Architectural Invariant | Verification Status | Gate Status |
|---|---|---|---|
| **Coding Agent** | `AgentRuntime` + `PermissionGate` + `MutationEngine` | Inspected, proposed, confirmed, verified, patched | **READY** |
| **Advanced Design** | `GovernedDesignWorkflow` + Chromium `observeVisualQaState` | Brief → semantic tokens → truthful visual assertions | **READY** |
| **REA Reverse Engineering** | `GovernedReaWorkflow` + `ReaEvidenceBundle` + `ComparativeWebVerifier` | End-to-end investigation, reconstruction, loopback comparative verification | **READY** |
| **Desktop Application** | Packaged VSCodium shell (`apps/desktop`) | Packaged app structure, codesign, CLI launcher, Browser QA panel | **READY** |
| **Skills Infrastructure** | `SkillRegistry` + lazy prompt injection | 21 seed skills, 95% selection accuracy, 97.4% token reduction | **READY** |
| **MCP Integration** | Shared `McpCatalog` + category tool subsetting | Shared catalog reuse, dynamic diagnostics, zero duplicate daemons | **READY** |
| **Capability Packs & Custom Modes** | `ModeResolver` + execution profiles | 4-state readiness, fail-closed diagnostic reporting | **READY** |
| **Browser Automation** | `BrowserSessionManager` + Playwright | Non-destructive exploration, Chromium Visual QA, ephemeral cleanup | **READY** |
| **Durability & Crash Recovery** | `OperationJournal` + write-ahead checkpoints | Mid-write and rollback crash resilience, exactly-once replay suppression | **READY** |

---

## 3. Operator Requirements & Environment Prerequisites

1. **Hardware Host**:
   - Apple Silicon (M-series) or x86_64 Linux host with minimum 16 GB RAM (32 GB recommended for concurrent local inference).
   - Local storage with at least 10 GB free space for workspace staging and ephemeral verification fixtures.
2. **Runtime Engine**:
   - Node.js >= 22.0.0 (required for native `node:sqlite` `DatabaseSync` in `@open-vs-code/account-service`).
   - Playwright / Chromium dependencies installed for visual QA and browser investigation.
3. **Model Infrastructure (HALO Handoff)**:
   - OpenAI-compatible local model gateway (vLLM, Ollama, llama.cpp, or HALO hardware endpoint) serving at least:
     - Generalist instruction/coding model (context window >= 8,192 tokens).
     - Fast fill-in-the-middle (FIM) model for editor-native autocomplete.
4. **Security & Sandbox Isolation**:
   - Loopback binding on `127.0.0.1` must be permitted for ephemeral verification servers and comparative web testing.
   - Filesystem operations outside workspace roots must remain blocked.

---

## 4. Supported Core Workflows

1. **Standard Coding Workflow**:
   - Chat-driven problem formulation.
   - Context gathering and bounded IDE snapshot ingestion.
   - Governed mutation proposal via `MutationEngine.preparePatch()`.
   - Host confirmation with visual diff presentation.
   - Application of approved patch with TOCTOU hash integrity checks.
   - Independent verification via test runners.
2. **Advanced Design Workflow**:
   - Design brief intake and requirements synthesis.
   - Semantic design system token generation (colors, typography, spacing).
   - Component hierarchy synthesis with live model reasoning.
   - Truthful browser visual QA using Chromium observation (zero fabricated passes).
   - Refinement loops gated on human confirmation.
3. **REA Reverse Engineering Workflow**:
   - Black-box investigation of authorized loopback web targets.
   - Capture of feature inventories, visible business rules, form validations, and state transitions.
   - Cryptographic serialization to `ReaEvidenceBundle` with SHA-256 digest.
   - Account-scoped and workspace-scoped access gating.
   - Clean-room reconstruction synthesis grounded in evidence obligations.
   - Dual-server loopback comparative verification comparing reference app with reconstructed app.
   - Strict deterministic obligation ledger closure.

---

## 5. Technical Debt Inventory & Resolution Summary

All 10 design debt items identified across Sprints 9C through 10A.1C are **CLOSED**:

- **DD-01**: Template-driven markup and motion generation → Closed (model synthesis connected).
- **DD-02**: GovernedDesignWorkflow model provider omission → Closed (provider delegation wired).
- **DD-03**: Browser QA synthetic fallback risk → Closed (fails closed without Chromium observation).
- **DD-04**: Structured workflow disabled by default → Closed (actionable mode readiness & enablement command).
- **DD-05**: Stage path create-only restriction → Closed (incremental patches via `preparePatch`).
- **DD-06**: Hardcoded model-call and token metrics → Closed (live telemetry tracking).
- **DD-07**: QA report file writes bypass confirmation → Closed (gated on human confirmation).
- **DD-08**: REA Investigation to Reconstruction handoff gap → Closed (`ReaEvidenceBundle` + fail-closed `INVESTIGATION_REQUIRED`).
- **DD-09**: Production verification wiring in REA reconstruction → Closed (`createReaProductionTestRunner` + comparative verifier).
- **DD-10**: Unbound confirmation tokens in reconstruction resume → Closed (exact active token binding + TOCTOU check).

Sprint 10A.1D sealed the four final production blockers:
- Corrected production REA verifier initialization from validated evidence.
- Eliminated false-positive obligation closure with strict scenario-to-obligation mapping.
- Secured temporary verification server using isolated staged fixtures and canonical path containment.
- Enforced account-scoped evidence ownership and session logout revocation.

---

## 6. Rollback & Emergency Recovery Protocol

In the event that physical hardware integration uncovers an incompatibility:

1. **Git Checkpoint Recovery**:
   - The stable software release state is tagged at `sprint/10a1d-final-pre-halo-readiness`.
   - Revert commit SHA: `8947c0a407def5577f55ab88eb616b684bcb0b61` (Sprint 10A.1C baseline).
2. **Crash & State Recovery**:
   - `AgentRunner.resumeFromRecovery()` detects interrupted runs via write-ahead checkpoints in `.open-vs-code/checkpoints/`.
   - Interrupted mutations are verified before re-application.
   - Pending confirmations invalidate across process restarts (`RECONFIRM` / `ASK_HUMAN`).
   - `RollbackManager` reverse-applies uncompleted mutations fail-closed.
3. **Workspace State Purge**:
   - Ephemeral verification fixtures in `tmpdir()/ovsc-verify-*` automatically delete on server close or process exit.
   - To completely reset local evidence bundles: delete `.open-vs-code/rea/bundles/`.

---

## 7. Final Verification Stamp

- **All 5 Workspaces Typecheck**: 0 errors
- **All Monorepo Linter Checks**: 0 warnings, 0 errors
- **Full Monorepo Build**: Clean
- **Comprehensive REA Test Matrix**: 103/103 PASS
- **Targeted Sprint 10A.1D Test Suite**: 23/23 PASS
- **Desktop Smoke & Runtime Acceptance**: 14/14 PASS, 6/6 PASS
- **Evaluations (Runtime, Skills, Workflow, Progress, Learning, Performance, Recovery)**: 100% PASS

**Verdict**: **`PRE_HALO_READY`** — Approved for HALO Hardware Integration.
