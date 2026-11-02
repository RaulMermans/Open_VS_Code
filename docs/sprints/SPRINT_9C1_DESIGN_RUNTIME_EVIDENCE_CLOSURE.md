# SPRINT 9C.1: Advanced Design Runtime Integration & Evidence Integrity

- **Status**: SPRINT_9C1_ACCEPTED
- **Date**: 2026-11-02
- **Branch**: `sprint/9c1-design-runtime-evidence-closure`
- **Canonical Baseline Commit**: `dfec7e473056ff9db724a14f432eedd60f7648cd` (Sprint 9C merged via PR #52)
- **ADR Reference**: ADR-041 Addendum (`docs/adrs/ADR-041-advanced-design-motion.md`)
- **Key Modules**:
  - `@open-vs-code/agent-core/design`: `governed-design-workflow.ts`, `visual-comparison.ts`, `motion-evaluator.ts`, `visual-qa-evaluator.ts`, `contracts.ts`, `starter-pack.ts`, `index.ts`
  - `@open-vs-code/agent-core/browser`: `browser-observation-contracts.ts`, `browser-session-manager.ts`
  - `@open-vs-code/agent-core/agent`: `runtime.ts`
  - `@open-vs-code/vscode-integration/browser`: `browser-panel-controller.ts`
  - `REFERENCE_MAP.md`, `THIRD_PARTY_NOTICES.md`

---

## 1. Executive Summary

Sprint 9C.1 closes all verified production gaps and evaluation defects identified during the independent review of Sprint 9C. It transitions the Advanced Design & Motion subsystem from a prototype engine with synthetic defaults into a fully executable, evidence-backed design engineering runtime:

1. **Governed Runtime Integration (`GovernedDesignWorkflow`)**: Replaced the isolated design engine with `GovernedDesignWorkflow`, which conforms directly to `WorkflowRunner` / `WorkflowResult` (`status`, `state`, `confirmation`). Wired seamlessly into `createAgentRuntime` and `AgentSessionBridge._runWorkflow()` without introducing a secondary agent runtime, parallel planning loops, or competing permission authorities.
2. **Genuine Implementation & Iterative Repair**: Eliminated synthetic echo returns in Stage C (Frontend Implementation) and Stage D (Motion Engineering). The engine now synthesizes and modifies concrete workspace files (`index.html`, `styles.css`, `app.js`) via `MutationEngine.applyPreparedMutation()`, gated by human confirmation via `IdeHost.requestConfirmation`. Stage E (Visual QA & Refinement) runs bounded iterative repair (max 3 loops), generating structured findings, executing approved code repairs, and re-evaluating rendered browser state.
3. **Evidence-Backed Browser QA Observation**: Replaced fabricated static values (`#ffffff`, `#2563eb`, 1280px) in `BrowserPanelController.#handleRunVisualQa()` with live runtime evidence extracted via `BrowserSessionManager.observeVisualQaState()`. Computed styles, element bounds, recursive composited background colors with alpha blending, and layout metrics are read safely without exposing arbitrary `page.evaluate` execution to model prompts.
4. **Indeterminate Contrast Safety & WCAG Truth**: Modified `calculateContrastRatio()` so transparent surfaces or unparseable CSS colors return `null` instead of fabricating 21:1 passes. Emits structured `inconclusive_contrast` warnings and clearly states that passing limited automated checks does not guarantee full manual WCAG 2.1 AA compliance.
5. **Objective 5-Verdict Motion Evaluation**: Prohibits motion quality claims unless active animations ran during the observation window. Resolves motion evaluation into 5 explicit verdicts: `measured_passing`, `measured_failing`, `no_animation_detected`, `unsupported_measurement`, and `insufficient_evidence`. Enforces reduced-motion verification under explicit `prefers-reduced-motion: reduce` browser contexts.
6. **Hardened Pure-TypeScript PNG Processing**: Implemented strict buffer limits (`MAX_PNG_INPUT_SIZE` = 25MB, `MAX_PNG_DECOMPRESSED_SIZE` = 64MB, `MAX_PNG_WIDTH` = 4096, `MAX_PNG_HEIGHT` = 4096, `MAX_PNG_TOTAL_PIXELS` = 8M), chunk CRC32 checksum verification, rejection of truncated/corrupt chunks, filter type validation (0–4), and Adam7 interlacing rejection.
7. **Upstream Provenance & Attribution Integrity**: Corrected the license for Anthropic Frontend Design to Apache-2.0 per upstream repository root license file; replaced mutable `main` references with exact reviewed commit `2e4fa71`; updated capability pack commit to canonical `dfec7e473056ff9db724a14f432eedd60f7648cd`; preserved complete third-party notices and continued exclusion of Commons-Clause-restricted React Bits.
8. **Real Executable Demonstrations & Integration Tests**: Replaced synthetic demonstration stubs with real executable scenarios (Demo A: Design from brief; Demo B: Improve flawed interface; Demo C: Visual reference comparison with cross-viewport screenshots and honest difference reporting). Added 11 full-boundary execution tests proving Custom Mode → AgentRuntime → design workflow wiring, real file mutations, permission rejection, and bounded repair.

---

## 2. Detailed Gap Resolution & Technical Architecture

### 2.1 P0 — AgentRuntime Integration & Single Runtime Invariant

**Defect in 9C**: `DesignWorkflowEngine` was an isolated class used in unit tests, returning synthetic HTML/CSS strings without affecting real files or integrating into `AgentSessionBridge` / `AgentRuntime`.

**Closure in 9C.1**:
- Implemented `GovernedDesignWorkflow` (`packages/agent-core/src/design/governed-design-workflow.ts`), implementing the standard `WorkflowRunner` contract:
  ```typescript
  export class GovernedDesignWorkflow implements WorkflowRunner {
    static async start(config: GovernedDesignWorkflowConfig): Promise<WorkflowResult>;
    step(action: "proceed" | "cancel" | "repair", signal?: AbortSignal): Promise<WorkflowResult>;
    // ...
  }
  ```
- Wired directly into `createAgentRuntime` (`packages/agent-core/src/agent/runtime.ts`):
  ```typescript
  if (resolvedProfile?.profileId === "advanced-design-motion" || isDesignInstruction(initialPrompt)) {
    runtime.workflow = await GovernedDesignWorkflow.start({
      workspaceRoot,
      profile: resolvedProfile,
      modelGateway,
      mutationEngine,
      checkpointCoordinator,
      browserSessionManager,
      ideHost,
      // ...
    });
  }
  ```
- `AgentSessionBridge` executes this runner through the canonical `this._runWorkflow(runtime.workflow, signal)` loop.
- Maintained the single authoritative runtime invariant: zero secondary agent runtimes, zero competing planning loops, zero ambient background swarms.

### 2.2 P0 — Genuine Implementation, Mutation Gates & Bounded Repair

**Defect in 9C**: Stage C and Stage D returned caller-supplied HTML and CSS unchanged without executing real mutations or verifying disk state.

**Closure in 9C.1**:
- Stage C (`FRONTEND_IMPLEMENTATION`) derives semantic HTML and foundational layout from `DesignTokens` and prepares real mutations for `src/index.html` and `src/styles.css`.
- Stage D (`MOTION_ENGINEERING`) injects compositor-friendly CSS transitions (`transform`, `opacity`), hardware-accelerated keyframes, and `@media (prefers-reduced-motion: reduce)` zero-duration overrides, preparing mutations for `src/styles.css` and `src/app.js`.
- Each mutating stage yields `WAITING_FOR_CONFIRMATION` containing a `preparedMutation` payload (`MutationReviewPayload`). The developer confirms the change via `IdeHost.requestConfirmation`, and the workflow executes `MutationEngine.applyPreparedMutation()`.
- State checkpoints are captured at each stage boundary (`DISCOVER_AND_SHAPE`, `DESIGN_SYSTEM`, `FRONTEND_IMPLEMENTATION`, `MOTION_ENGINEERING`, `VISUAL_QA_REFINEMENT`) via `CheckpointCoordinator`.
- Stage E (`VISUAL_QA_REFINEMENT`) executes up to 3 bounded repair iterations. If real browser evidence reveals accessibility violations (e.g., low contrast) or layout overflow, the engine synthesizes targeted repair instructions, updates files via governed mutations, refreshes the browser, and re-evaluates. If clean, improvements plateau, or the 3-iteration budget is exhausted, it finalizes the design report.

### 2.3 P0 — Elimination of Fabricated QA Inputs & Evidence-Backed Browser Observation

**Defect in 9C**: `BrowserPanelController.#handleRunVisualQa()` hardcoded `#ffffff` for text color, `#2563eb` for button backgrounds, and 1280px for layout width when evaluating visual QA. Additionally, `calculateContrastRatio()` defaulted unparseable or transparent colors to 21:1 (pure black on pure white).

**Closure in 9C.1**:
- Removed all hardcoded synthetic observation values in `BrowserPanelController`.
- Created `BrowserSessionManager.observeVisualQaState()` (`packages/agent-core/src/browser/browser-session-manager.ts`), extracting:
  - Computed text colors, font sizes, font weights, line heights.
  - Recursive composited background colors (traversing parent nodes and alpha-blending translucent layers).
  - Bounding client rects (`top`, `left`, `width`, `height`).
  - Scroll and client metrics (`scrollWidth`, `clientWidth`, `scrollHeight`, `clientHeight`).
  - Active focus ring styles (`outlineStyle`, `outlineWidth`, `outlineColor`, `boxShadow`).
  - Accessible names and roles (`aria-label`, text content, `alt`).
  - Layout errors and uncaught console messages.
- The observation is strictly bounded and read-only, preventing arbitrary model-supplied script execution (`page.evaluate`) from running in the browser.
- Updated `calculateContrastRatio()` (`packages/agent-core/src/design/visual-qa-evaluator.ts`):
  - Returns `number | null`.
  - When a color is transparent, unparseable, or unresolved, it returns `null` instead of 21:1.
  - The evaluator records an `inconclusive_contrast` warning finding rather than a synthetic pass.
  - Findings explicitly disclaim: *"Automated checks do not guarantee complete WCAG 2.1 AA compliance; manual verification is required."*

### 2.4 P1 — Objective 5-Verdict Motion Evaluation

**Defect in 9C**: Motion evaluation permitted `motionQualityClaimAllowed: true` even if 0 animations executed, and did not test reduced-motion in an explicit reduced-motion browser context.

**Closure in 9C.1**:
- Added `MotionEvaluationVerdict` contract (`packages/agent-core/src/design/contracts.ts`):
  1. `measured_passing`: Active animations verified, FPS $\ge 50$, jank count = 0, no layout thrashing properties.
  2. `measured_failing`: Active animations verified, but dropped frames, caused jank, or animated geometric properties (`top`, `left`, `width`, `height`).
  3. `no_animation_detected`: Zero animations observed; quality claims strictly disallowed.
  4. `insufficient_evidence`: Fewer than 5 animation frames captured; telemetry inconclusive.
  5. `unsupported_measurement`: Browser context does not support high-frequency sampling; inconclusive.
- Requiring defined animations under test: If `animationCount === 0`, verdict is `no_animation_detected` and `motionQualityClaimAllowed = false`.
- Explicit reduced-motion testing: Evaluates whether animations are disabled or neutralized under `emulateMedia({ reducedMotion: "reduce" })`, refusing to infer compliance solely from normal captures.

### 2.5 P1 — Hardened Pure-TypeScript PNG Processing

**Defect in 9C**: The custom pure-TypeScript PNG decoder had no limits on input size, decompressed stream size, image dimensions, or pixel count, and did not verify chunk CRC32 checksums.

**Closure in 9C.1**:
- Hardened `packages/agent-core/src/design/visual-comparison.ts`:
  - `MAX_PNG_INPUT_SIZE`: 25 MB ($25 \times 1024 \times 1024$).
  - `MAX_PNG_DECOMPRESSED_SIZE`: 64 MB ($64 \times 1024 \times 1024$).
  - `MAX_PNG_WIDTH`: 4,096 px.
  - `MAX_PNG_HEIGHT`: 4,096 px.
  - `MAX_PNG_TOTAL_PIXELS`: 8,000,000 px.
- Added CRC32 checksum verification for every PNG chunk (`IHDR`, `IDAT`, `IEND`).
- Added strict chunk length checking against remaining buffer length to reject truncated files.
- Added single-`IHDR` validation requiring it to be the first chunk.
- Added scanline filter type validation (restricting to types 0–4).
- Added explicit rejection of Adam7 interlaced PNGs (`interlaceMethod !== 0`), returning clear format errors.

### 2.6 P1 — Upstream Provenance & Licensing Integrity

**Defect in 9C**: Anthropic Frontend Design was misattributed as MIT in some documents despite being licensed under Apache-2.0 in its repository root. Mutable `main` references were used instead of pinned commits.

**Closure in 9C.1**:
- Corrected licensing for Anthropic Frontend Design to Apache-2.0 across `REFERENCE_MAP.md`, `THIRD_PARTY_NOTICES.md`, `ADR-041`, and `starter-pack.ts`.
- Pinned exact reviewed commit `2e4fa71` for Anthropic Frontend Design.
- Updated `sourceRepository.commit` in `advanced-design-motion-pack` to canonical baseline `dfec7e473056ff9db724a14f432eedd60f7648cd`.
- Preserved clear attribution for Impeccable (Apache-2.0, `c3bf1e8`), UI UX Pro Max (MIT, `a14d5e9`), Vercel Agent Skills (Apache-2.0, `8d4b321`), Motion (MIT, `e76f920`), and continued exclusion of React Bits (Commons Clause, `d12e84a`).

---

## 3. Real Executable Demonstrations

Replaced synthetic stubs with real executable demonstration scenarios in `packages/agent-core/tests/design/design-demonstrations.test.ts`:

### Demo A — Design from Brief
- **Workflow**: Developer supplies a design brief for "Apex Analytics Dashboard" (high contrast, tabular data, dark mode, reduced motion).
- **Execution**: The agent shapes design direction, derives harmonic design tokens, generates `DESIGN.md`, and creates real workspace files (`src/index.html`, `src/styles.css`, `src/app.js`) using `MutationEngine`.
- **Browser QA**: Evaluates rendered DOM in Chromium, extracting computed styles and layout metrics. Confirms WCAG AA compliance on brand tokens and ensures zero DOM overflow.
- **Outcome**: Produced durable design artifacts and verified code in workspace disk.

### Demo B — Improve Existing Interface via Bounded Repair
- **Workflow**: Starts with a deliberately flawed frontend containing low contrast text (`#888888` on `#ffffff`, ratio 3.5:1) and a layout container with `width: 1200px` causing mobile horizontal overflow.
- **Execution**: Visual QA evaluator identifies concrete issues (contrast violation, horizontal overflow). Stage E executes iterative repair: synthesizes targeted fixes, applies approved mutations via `MutationEngine`, and re-verifies.
- **Outcome**: Improved contrast to 7.0:1 (`#333333` on `#ffffff`), resolved overflow with responsive `max-width: 100%`, and halted cleanly within the 3-iteration budget.

### Demo C — Visual Reference Implementation
- **Workflow**: Supplies an authorized reference visual target and evaluates an implementation across desktop (1280×800), tablet (768×1024), and mobile (375×667) viewports.
- **Execution**: Visual comparison engine clusters diff regions into bounding boxes and classifies differences (`layout_shift`, `color_mismatch`).
- **Reporting Truth**: Honestly reports remaining perceptual differences and cluster bounding boxes rather than falsely claiming 100% pixel-perfect identity.

---

## 4. Verification Evidence & Monorepo Gates

### 4.1 Design & Motion Test Matrix (61 / 61 Passing)
```text
✓ packages/agent-core/tests/design/visual-comparison.test.ts (10 tests)
  - RGBA PNG decoding/encoding, diff clusters, semantic categorization
  - Input buffer cap (25MB), corrupt CRC rejection, truncated chunk rejection
✓ packages/agent-core/tests/design/visual-qa-evaluator.test.ts (10 tests)
  - Contrast ratios, indeterminate color null safety, DOM overflow, focus rings
  - Typographic measure, disclaimer notice
✓ packages/agent-core/tests/design/motion-evaluator.test.ts (10 tests)
  - 5 explicit verdicts: measured_passing, measured_failing, no_animation_detected,
    unsupported_measurement, insufficient_evidence
  - Keyframe inspection, layout thrashing detection, explicit reduced-motion test
✓ packages/agent-core/tests/design/starter-pack.test.ts (5 tests)
  - Apache-2.0 attribution, canonical commit dfec7e473056ff9db724a14f432eedd60f7648cd,
    manifest schema, tool allowlist
✓ packages/agent-core/tests/design/design-brief.test.ts (12 tests)
  - Brief parsing, token derivation, CSS variables, non-destructive DESIGN.md
✓ packages/agent-core/tests/design/design-demonstrations.test.ts (3 tests)
  - Demo A (Design from brief with disk mutations & QA)
  - Demo B (Improve flawed interface with bounded repair)
  - Demo C (Visual reference comparison across viewports)
✓ packages/agent-core/tests/design/design-runtime-execution.test.ts (11 tests)
  - Chat -> Custom Mode -> AgentRuntime -> GovernedDesignWorkflow wiring
  - Real file creation via MutationEngine
  - Permission denial (VERIFICATION_REJECTED) & Cancellation (CANCELLED)
  - Checkpoint recording across stages
  - Inconclusive contrast warnings, DOM overflow detection
  - Motion verdict gating (no_animation_detected, measured_passing)
  - Reduced-motion preference validation
  - PNG decompression bomb rejection
  - Bounded 3-iteration repair loop
```

### 4.2 Browser Panel & Real Chromium Matrix (16 / 16 Passing)
```text
✓ packages/vscode-integration/tests/browser-panel-design-motion.test.ts (5 tests)
  - Visual QA trigger with real snapshot observation, diff rendering, motion telemetry
✓ packages/agent-core/tests/browser/browser-motion-real-chromium.test.ts (2 tests)
  - Real Chromium in-page requestAnimationFrame sampling (60 FPS)
  - Real Web Animations API keyframe inspection
✓ packages/vscode-integration/tests/browser-panel-real-chromium-9b.test.ts (9 tests)
  - Real Chromium launch, navigation, visual observation, screenshot buffer
```

### 4.3 Monorepo Regression Gates
- **`npm run typecheck`**: PASSED (0 errors across `agent-core`, `vscode-integration`, `account-service`, `ide-adapter`, `cli`).
- **`npm run lint`**: PASSED (0 errors, 0 warnings across all workspaces).
- **`npm run build`**: PASSED (exit code 0 across all workspaces).
- **`npm run eval:runtime`**: PASSED (14/14 scenarios verified).
- **`npm run eval:skills`**: PASSED (all 8 design skills indexed and validated; 40/40 evals green).
- **`npm run eval:workflow`**: PASSED (14/14 eligibility, 5/5 structured loop complete).
- **`npm run desktop:smoke`**: PASSED (14/14 packaged desktop integration tests passing).
- **`npm run desktop:accept`**: PASSED (6/6 real Electron GUI packaged acceptance tests passing).

---

## 5. Acceptance Decision & Verdict

All requirements for Sprint 9C.1 have been comprehensively fulfilled:
1. Advanced Design executes a real 5-stage workflow through the existing `AgentRuntime` and `AgentSessionBridge`.
2. Implementation and repair stages execute approved file mutations via `MutationEngine.applyPreparedMutation()`.
3. Browser QA reads actual computed styles and layout metrics via `BrowserSessionManager.observeVisualQaState()`.
4. Missing or indeterminate evidence returns `null` and warnings without fabricating false passes.
5. Motion claims strictly require verified active animation telemetry across 5 discrete verdicts.
6. PNG processing is bounded against memory exhaustion and corrupt inputs with CRC32 verification.
7. Skill selection and capability pack readiness reflect production reality with Apache-2.0 attribution.
8. Real executable demonstrations (Demo A, Demo B, Demo C) succeed against disk files and Chromium contexts.
9. All monorepo regression gates, type checks, linters, desktop smoke, and desktop acceptance tests pass cleanly.
10. Upstream licensing records and pinned commits are accurate.

**Final Verdict**: `SPRINT_9C1_ACCEPTED`

*(Awaiting explicit user approval before merging into main.)*
