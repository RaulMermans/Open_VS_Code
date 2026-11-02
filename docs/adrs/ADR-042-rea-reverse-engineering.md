# ADR-042: Reverse Engineering Anything (REA) — Software Investigation, Evidence-Driven Reconstruction & Agent Specialization

- **Status**: Accepted
- **Date**: 2026-11-02
- **Sprint**: 9D (REA Reverse Engineering — Software Investigation, Evidence-Driven Reconstruction & Agent Specialization)
- **Preceded by**: ADR-029 (Skills Runtime), ADR-034 (MCP Transports & Governance), ADR-037 (Custom Modes Engine & Execution Profiles), ADR-038 (Capability Packs Architecture), ADR-039 (Governed Playwright Browser Runtime), ADR-040 (Browser Panel Observation UX), ADR-041 (Advanced Design & Motion)

---

## 1. Context

Developers and reverse engineering specialists frequently need to investigate authorized external software—ranging from running web applications and packaged Electron/ASAR bundles to native binaries and unmapped repositories—to understand their functional behavior, discover hidden state machines, verify conformance, and reconstruct clean-room, equivalent implementations.

However, standard software development assistants treat reverse engineering as a generic source-code analysis problem:
1. **Lack of Black-Box Runtime Investigation**: When given a running web application without source code, generic agents fail to systematically navigate routes, probe interactive elements, observe state transitions, and deduce form contracts.
2. **Epistemic Conflation (Hallucinated Certainty)**: AI models routinely confuse hypotheses or inferences about internal backend architectures with concrete observations, leading to speculative claims and fragile reconstructions.
3. **Monolithic Multi-Agent Swarms**: Unrestricted autonomous agent teams introduce high token waste, non-deterministic state, uncheckpointed mutations, and security risks.
4. **Tool Invention & Schema Drift**: Integrations frequently fabricate tool names, assume uninstalled reverse engineering suites (e.g. Ghidra, Hopper, IDA, JADX) are present, or fail closed clumsily when providers are missing.
5. **Absence of Grounded Reconstruction Obligations**: Reconstructed applications are often declared complete without rigorous evidence-backed verification against observed behavior, edge cases, negative tests, and unresolved unknowns.

Sprint 9D addresses these challenges by integrating the open-source **Reverse Engineer Anything (REA)** methodology and toolset (pinned to version `6.8.0`, commit `f95bdbce76fa538d9383a36c7dde0468078b42f4`) into Open VS Code. This integration preserves Open VS Code's single-runtime architecture, governed browser automation, and local-first security boundaries.

---

## 2. Architectural Decisions

### 2.1 Single Authoritative Runtime with Bifurcated Capability Packs

Rather than introducing a second agent runtime or multi-agent swarms, reverse engineering and reconstruction are partitioned into two focused **Capability Packs** built upon Open VS Code's existing single-agent architecture:

```text
                               Target Intake
                                     │
                                     ▼
                        Target Classification Engine
               (Web App / JS-Electron / Native / Source Repo)
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           ▼                                                   ▼
┌─────────────────────────────────┐         ┌─────────────────────────────────┐
│     REA Investigation Pack      │         │    REA Reconstruction Pack      │
│  - Mode: REVIEW (Read-Only)     │         │  - Mode: BUILD (Governed Edit)  │
│  - Black-Box Exploration        │         │  - Human Authorization Gate     │
│  - REA MCP Tools & Prompts      │         │  - Clean-Room Implementation    │
│  - Playwright Browser Session   │         │  - Independent Test Suites      │
│  - Structured Evidence Ledger   │         │  - Obligation Verification      │
│  - Specification & Obligations  │         │  - Comparative Regression Check │
└─────────────────────────────────┘         └─────────────────────────────────┘
```

1. **REA Investigation Pack** (`rea-investigation-pack@1.0.0`):
   - **Base Mode**: `REVIEW` (read-only mode).
   - **Purpose**: Systematically inspects authorized targets, discovers routes/controls, captures evidence, distinguishes observations from inferences, and compiles a grounded reconstruction specification.
   - **Security Ceiling**: Strictly prohibits modifying repository files or executing arbitrary target binaries.
2. **REA Reconstruction Pack** (`rea-reconstruction-pack@1.0.0`):
   - **Base Mode**: `BUILD` (governed modification mode).
   - **Purpose**: Consumes an approved investigation specification and reconstruction obligation ledger, synthesizes independent clean-room code, and verifies obligations against test evidence.
   - **Security Ceiling**: All file mutations require human confirmation via `IdeHost.requestConfirmation` and `PermissionGate`.

Both capability packs share the underlying skill registry and MCP server registrations without duplicating manifests. Installation never triggers automatic package downloads, script execution, or target connection.

---

### 2.2 Deterministic Target Classification & Investigation Routing

Investigation workflows must not route all software targets through an identical sequence. A deterministic classifier inspects the target before any tool is invoked:

1. **Category A: Running Web Application**:
   - Target is an authorized `http://` or `https://` URL.
   - Requires origin allowlist validation and port safety checks.
   - Investigated via governed Playwright browser interaction (`BrowserSessionManager`), discovering pages, navigation transitions, form behaviors, accessibility landmarks, and error recovery states. Source code is NOT required.
2. **Category B: JavaScript / Electron Application**:
   - Target is an ASAR archive, unpacked Electron bundle, or packaged JavaScript application directory.
   - Investigated via REA MCP tools (`analyze_javascript_application`, `inspect_artifact`), extracting application graphs, routes, semantic symbols, and component boundaries without executing target code.
3. **Category C: Native or Packaged Binary**:
   - Target is a Mach-O, ELF, PE, DMG, APK, IPA, or archive binary.
   - Evaluates provider availability (`native-macos`, `rea-artifact-graph`, etc.). Fails closed or reports precise remediation for unconfigured heavyweight providers (Ghidra, Hopper, IDA, Kuna, JADX) rather than fabricating output.
4. **Category D: Source Code Repository**:
   - Target is a standard source repository with project configuration (`package.json`, `Cargo.toml`, etc.).
   - Standard repository tools (`read_file`, `search_text`, `find_files`) are prioritized. REA is only invoked if shipped artifacts or runtime observations are required.

---

### 2.3 Strict Epistemic Evidence Separation

All findings collected during an investigation are recorded in a structured evidence ledger with strict epistemic tagging:

- **`OBSERVED`**: Concrete, reproducible runtime facts directly gathered through tool execution (e.g., live DOM element attributes, accessibility roles, HTTP status codes, exact binary layout headers, ASAR file digests).
- **`INFERRED`**: Hypotheses, architectural patterns, or behavioral models formulated by LLM reasoning (e.g., suspected database schema, inferred business rule logic, presumed backend API structure). Inferences must explicitly cite the `OBSERVED` evidence IDs that support them.
- **`UNKNOWN`**: Explicit implementation details that cannot be directly observed from the black-box boundary (e.g., server-side hashing algorithms, database constraints, hidden backend microservices).

**Hard Invariant**: Model inferences are NEVER promoted to observed facts without new runtime or artifact evidence.

---

### 2.4 Reconstruction Obligations & Ledger Integration

Clean-room software reconstruction is governed by REA's deterministic **Reconstruction Obligation Ledger** methodology:

1. **Finite Obligations**: Derived from observed facts and reviewed specifications, each obligation specifies:
   - `obligationId`, `title`, `applicationLayer` (e.g. `cli`, `electron`, `application`, `runtime`).
   - Required positive test cases, negative validation cases, edge cases, and failure recovery cases.
   - Cites supporting evidence IDs.
2. **Closure Criteria**: An obligation is NEVER marked closed simply because code was generated. Closure requires:
   - A unique assigned owner in the reconstruction manifest.
   - An independent, passing test verifier execution.
   - Test result evidence recorded in the ledger.
   - Zero unresolved contradictions or blockers.
3. **REA MCP Tool Integration**: When REA is connected, `build_reconstruction_obligation_ledger` is invoked directly to generate deterministic ledgers with cryptographic closure digests (`closure_digest`). If REA is disconnected, a compatible local contract is computed without falsely claiming upstream verifier execution.

---

### 2.5 Eight Specialized Progressive Disclosure Skills

To respect context token budgets (<1,000 tokens per skill) and avoid prompt saturation, reverse engineering knowledge is modularized into eight built-in skills:

1. `rea-investigation-routing`: Target intake, classification, and investigation strategy selection.
2. `browser-behavior-investigation`: Bounded black-box web application exploration, route maps, and DOM state transitions.
3. `javascript-electron-analysis`: ASAR inspection, script extraction, and static application graph reconstruction.
4. `native-artifact-analysis`: Safe binary inspection, symbol discovery, and provider prerequisite checking.
5. `feature-specification`: Grounded synthesis of functional requirements, UI layouts, and business rules from evidence.
6. `evidence-reconciliation`: Reconciling static and runtime observations, detecting contradictions, and managing unknowns.
7. `reconstruction-planning`: Clean-room architectural design and derivation of testable reconstruction obligations.
8. `reconstruction-verification`: Comparative verification of reconstructed applications against reference evidence.

---

### 2.6 REA MCP Integration & Guided Prompts

REA connects via Open VS Code's standard `McpService` / `McpCatalog` infrastructure:

- **Server Configuration**: Version-pinned to `rea-agents@6.8.0`, executed over stdio.
- **Tool Allowlisting**: Tools are discovered dynamically and governed by existing permission policies.
- **Guided Prompts**: Supports REA's standard guided MCP prompts (`investigate_feature`, `compare_application_versions`, `verify_reconstruction`, `audit_residual_unknowns`, `trace_crash`, `prepare_bounded_process_capture`). Prompts provide structured investigation guidance and never grant ambient tool permissions.
- **Provider Diagnostics**: Accurately reports missing analysis providers (Ghidra, Hopper, IDA, Kuna, SQLite) with actionable remediation paths instead of throwing unhandled exceptions.

---

### 2.7 Governed Reconstruction Workflow

Reconstruction begins strictly **AFTER** explicit human authorization:

```text
Investigation Spec + Obligation Ledger
                 │
                 ▼
     Human Authorization Gate
                 │ (Approved)
                 ▼
        Implementation Plan
                 │
                 ▼
Canonical AgentRuntime (MutationEngine + PermissionGate)
                 │
                 ▼
     Local Verification Engine (Unit / E2E Tests)
                 │
                 ▼
Comparative Verification (DOM State + Visual Parity)
                 │
                 ▼
   Obligation Ledger Closure & Coverage Report
```

- Reconstructed code is completely independent and clean-room.
- Never copies proprietary binaries or circumvents DRM/licenses.
- Verified against reference observations deterministically.

---

## 3. Consequences

### Positive
- Enables principled, black-box reverse engineering of running websites and packaged applications.
- Eliminates hallucinated facts by enforcing strict `OBSERVED` vs `INFERRED` vs `UNKNOWN` separation.
- Provides test-driven reconstruction verification through deterministic obligation ledgers.
- Integrates seamlessly with existing Open VS Code browser automation, permission gates, and single-runtime core.
- Maintains strict provider transparency without requiring heavy reverse engineering installations.

### Negative / Trade-Offs
- Deep decompilation and binary disassembly require operator-supplied native engines (Ghidra, Hopper, IDA).
- Black-box web investigation cannot observe server-side databases or backend algorithms; these remain documented as `UNKNOWN`.

---

## 4. Amendment — Sprint 9D.1: Governed Runtime Integration & Evidence Integrity Closure

- **Status**: Accepted
- **Sprint**: 9D.1
- **Date**: 2026-11-02

### 4.1 Production Pipeline Integration (`GovernedReaWorkflow`)
REA workflows are authoritatively integrated into `createAgentRuntime` via `GovernedReaWorkflow`. The pipeline invariant strictly holds:
`ChatController -> Custom Mode & Capability Pack -> AgentSessionBridge -> AgentRuntime -> GovernedReaWorkflow -> PermissionGate -> Existing Tools & McpCatalog -> MutationEngine -> Verified Artifacts`.
No secondary agent or alternate planning loop exists. REA tools and skills are routed directly through Open VS Code's canonical model gateways and skill registries.

### 4.2 Browser Action Governance
`InvestigationEngine` in `REVIEW` mode is strictly read-only: form filling and clicks are forbidden. In interactive mode, actions require risk classification, human confirmation via `IdeHost.requestConfirmation`, automatic rejection of destructive controls (`delete`, `remove`, `destroy`, `drop`, `reset`, `purge`), and target element revalidation prior to execution.

### 4.3 Filesystem Mutation Governance
`ReconstructionEngine` writes exclusively through `MutationEngine.applyPreparedMutation()`. Direct filesystem writes (`mkdirSync`, `writeFileSync`) are prohibited. Path containment is strictly enforced; adversarial attempts at `../../` directory traversal, absolute path writes outside the workspace root, or symlink workspace escapes are rejected fail closed.

### 4.4 Zero-Fabrication Verification Policy
Reconstruction verification requires an independent, executing verifier. If no `testRunner` is present, obligations remain marked `UNVERIFIED` and `verifiedObligationCount` remains 0. Fabricated PASS strings and SHA-256 digests of mock confirmations are strictly prohibited. Each verified obligation produces an `ObligationVerificationRecord` with concrete input fixtures, observed outcomes, artifact digests, and verifier identity.

### 4.5 Comparative Web Verification (`ComparativeWebVerifier`)
Final acceptance of web reconstructions requires dual-application comparative verification. Equivalent controlled scenarios (route exploration, negative form validation, positive state transitions, and sequential mutations) are executed against both Reference App A and Reconstructed App B, reporting exact behavioral parity or concrete discrepancies.

### 4.6 Shared McpCatalog Lifecycle & Portable Toolchain Discovery
`ReaMcpService` registers with the authoritative `McpCatalog`, preventing duplicate processes and port collisions. Advertised tools are filtered by target category (`web`, `electron`/`javascript`, `native`). Toolchain execution utilizes portable Node >= 22 discovery (`resolveNodeExecutable()`), and provider availability is probed dynamically rather than assumed from static defaults.
