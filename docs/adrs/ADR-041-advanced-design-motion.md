# ADR-041: Advanced Design & Motion — Specialized Skills, Visual Engineering & Quality Evaluation

- **Status**: Accepted
- **Date**: 2026-11-01
- **Sprint**: 9C (Advanced Design & Motion — Specialized Skills, Visual Engineering & Quality Evaluation)
- **Preceded by**: ADR-029 (Skills Runtime), ADR-034 (MCP Modern Transports & Governance), ADR-037 (Custom Modes Engine & Execution Profiles), ADR-038 (Capability Packs Architecture), ADR-039 (Governed Playwright Browser Runtime), ADR-040 (Browser Panel Observation UX)

---

## 1. Context

Open VS Code's core agent runtime and governed browser capabilities (Sprints 9A through 9B) allow agents to inspect, manipulate, and observe web applications in real time. However, building world-class frontend interfaces requires far more than generic code generation:
1. **Aesthetic Drift and Generic Output**: Without structured design direction and typography/color systems, LLM-generated UIs converge toward generic, unstyled, or template-like presentations.
2. **Monolithic Prompt Bloat**: Stacking extensive design guidelines, component templates, and QA checklists into a single system prompt exceeds context token budgets and dilutes instruction adherence.
3. **Motion Fragility and Lack of Objective Measurement**: Subjective animation claims ("smooth transitions", "fluid microinteractions") frequently mask severe layout thrashing, frame drops, and accessibility violations (such as ignoring `prefers-reduced-motion`).
4. **Subjective vs. Deterministic Visual Evaluation**: Assessing UI quality purely through LLM vision without deterministic bounding checks misses WCAG contrast failures, CSS layout overflow, missing accessible names, and visual regressions.
5. **Heavy Native Dependencies**: Image comparison libraries in the Node ecosystem (such as `sharp`, `canvas`, or `pixelmatch`) depend on compiled C/C++ bindings that create cross-platform packaging, installation, and supply-chain vulnerabilities.

Sprint 9C addresses these challenges by transforming Open VS Code into an advanced visual engineering and motion design system through governed capability packs, progressive disclosure skills, deterministic image diffing, and browser-measured motion analysis.

---

## 2. Architectural Decisions

### 2.1 Single Authoritative Runtime with Declarative Capability Pack

Rather than introducing autonomous parallel agent swarms or secondary planning loops, design and visual engineering responsibilities are modeled through a declarative **Capability Pack** (`advanced-design-motion-pack`) and an authoritative **Custom Mode Profile** (`advanced-design-motion`):

```text
User / Task Request
       │
       ▼
ModeResolver ("advanced-design-motion" in BUILD mode)
       │
       ▼
CapabilityPackResolver ("advanced-design-motion-pack@1.0.0")
       │
       ├── Progressive Disclosure Skills (Stage-gated token budget)
       ├── Governed Browser Tools (browser_open, browser_navigate, browser_click, etc.)
       └── Single Authoritative AgentRuntime (PermissionGate, MutationEngine, CheckpointTracker)
```

- **Mode Profile**: `advanced-design-motion` operates in `BUILD` mode with strict confirmation requirements for state mutations, file changes, and browser operations.
- **Pack Manifest**: Versioned under `open-vs-code/capability-pack@v1`, declaring dependencies on browser tools, workspace file editing, and 8 specialized built-in skills.

---

### 2.2 Progressive Disclosure: Eight Specialized Built-in Skills

To adhere to context token budgets (<1,000 tokens per skill) and avoid prompt bloat, design intelligence is partitioned across eight focused skills loaded dynamically according to the active workflow stage:

1. `design-direction`: Visual strategy, brand personality, aesthetic anchor selection, anti-patterns.
2. `ux-information-architecture`: Mental models, progressive disclosure, page hierarchy, cognitive load.
3. `design-system-engineering`: Design tokens, mathematical scales, CSS variables, dark/light/system theming.
4. `frontend-composition`: Semantic HTML5, accessible component structures, responsive layouts, defensive CSS.
5. `motion-engineering`: Timing, spring physics, hardware-accelerated transforms, layout thrashing prevention, `prefers-reduced-motion`.
6. `visual-qa`: Visual regression detection, viewport audits, alignment and rhythm verification.
7. `accessibility-review`: WCAG 2.1 AA conformance, contrast ratios, focus rings, keyboard navigability, ARIA attributes.
8. `design-polish`: Optical alignment, micro-spacing, typography measure (45–85 characters), state transitions.

---

### 2.3 Structured DesignBrief Contract & Durable Token Generation

All design workflows are anchored to a formal `DesignBrief` contract capturing product type, audience, goals, aesthetic direction, typography, colors, motion preferences, technical constraints, and accessibility requirements.

From this brief, Open VS Code derives cohesive `DesignTokens` and outputs:
- **`DESIGN.md` / `PRODUCT.md`**: Human-readable design direction and architecture guidelines (safely non-destructive, never overwriting existing files without user review).
- **CSS Variables**: Production-ready, theme-aware stylesheet definitions with automatic `@media (prefers-reduced-motion: reduce)` zero-duration transitions.

---

### 2.4 Bounded 5-Stage Sequential Design Workflow

Workflows progress sequentially through five bounded stages managed by `DesignWorkflowEngine`:

```text
[Stage A: Discover & Shape]
       │  (Brief analysis, project convention inspection, token generation)
       ▼
[Stage B: Design System]
       │  (Token derivation, CSS variables export, component hierarchy)
       ▼
[Stage C: Frontend Implementation]
       │  (Governed mutation via AgentRuntime, semantic HTML, layout)
       ▼
[Stage D: Motion Engineering]
       │  (Purposeful animation, hardware-accelerated properties, reduced-motion)
       ▼
[Stage E: Visual QA & Refinement]
       │  ◄────────────────────────────────┐
       ▼                                   │ (Bounded loop: max 3 iterations)
[Independent Evaluation]                   │
  - VisualComparison (Diff clustering)     │
  - MotionEvaluation (rAF & Jank audit)    │
  - VisualQA (WCAG & deterministic checks) ─┘
       │
       ▼ (PASS or Iteration Cap Reached)
[Verified Artifact & Report]
```

Stage E enforces a hard maximum of 3 automated improvement iterations. If critical issues remain after 3 iterations, execution halts and surfaces specific, evidence-backed findings to the developer.

---

### 2.5 Zero-Dependency Pure TypeScript Visual Comparison Engine

To eliminate security risks and installation failures associated with native C/C++ image bindings (`sharp`, `canvas`), Open VS Code implements a pure TypeScript PNG parser, encoder, and diffing engine using only Node.js native `node:zlib`:
- **Format Support**: Standard 8-bit RGBA and RGB PNG chunks (`IHDR`, `IDAT`, `IEND`).
- **Scanline Decompression**: Reconstruction of standard PNG filter types (None, Sub, Up, Average, Paeth).
- **Pixel-by-Pixel Diffing**: Normalized Euclidean color-distance metric with configurable perceptual thresholds.
- **Bounding Box Clustering**: Automatic spatial grouping of adjacent mismatched pixels into discrete bounding boxes (`minX`, `minY`, `maxX`, `maxY`).
- **Semantic Classification**: Automated categorisation into `layout_shift`, `color_mismatch`, `element_missing`, `text_change`, or `minor_anti_aliasing`.

---

### 2.6 Real In-Browser Measured Motion Evaluation

Subjective claims of animation quality are explicitly prohibited. An agent or system cannot advertise high motion quality unless backed by real empirical telemetry via `BrowserSessionManager.measureMotion()`:
1. **High-Frequency Temporal Sampling**: In-page `requestAnimationFrame` sampling measuring instantaneous frame intervals, average FPS, minimum FPS, and frame time jitter.
2. **Jank & Pause Detection**: Automated identification of frames exceeding 50ms (jank threshold) or 100ms (stutter threshold).
3. **Web Animations API Keyframe Audit**: Dynamic inspection of all active `document.getAnimations()` examining target elements, easing curves, and animated CSS properties.
4. **Layout Thrashing Detection**: Immediate detection of geometry-triggering properties (`top`, `left`, `right`, `bottom`, `width`, `height`, `margin`, `padding`). Animations are flagged unless restricted to compositor-friendly properties (`transform`, `opacity`, `filter`).
5. **Quality Gate Rule**: `motionQualityClaimAllowed` evaluates to `true` **only if** `averageFps >= 50`, `jankCount === 0`, `layoutThrashingDetected === false`, and `durationMs >= 100`.

---

### 2.7 Independent Hybrid Visual QA Evaluator

Visual and quality assessment combines deterministic rule-based checks with judgment-based heuristics:
- **WCAG 2.1 AA Contrast**: Luminance calculations for normal text (minimum 4.5:1) and large text / graphical UI components (minimum 3.0:1).
- **DOM Overflow Verification**: Bounding client rect inspection verifying `scrollWidth <= clientWidth` and `scrollHeight <= clientHeight`.
- **Keyboard Focus Rings**: Verification that interactive elements do not disable focus outlines (`outline: none` or `outline-width: 0px`) without explicit replacements.
- **Accessibility Attributes**: Validation of image `alt` attributes and button/link accessible names (`aria-label`, text content).
- **Typographic Measure**: Audit of text reading lengths against optimal ergonomics (45 to 85 characters per line).
- **Console Health**: Zero uncaught JavaScript errors or unhandled promise rejections.

---

## 3. Upstream Assessment and Licensing

The design intelligence and motion engineering patterns in Open VS Code synthesize proven best practices from key upstream projects while strictly observing licensing boundaries:
1. **Impeccable (`pbakaus/impeccable`) — Apache-2.0**:
   - *Adapted*: Shape-before-build stage progression, design critique checklists, persistent design token structures.
   - *Excluded*: Direct binary installation, non-interactive CLI workflows.
2. **Anthropic Frontend Design (`anthropics/skills`) — Apache-2.0**:
   - *Adapted*: Art direction guidelines, typographic scales, responsive composition principles.
   - *Provenance*: Pinned commit `2e4fa71`; licensed under Apache-2.0 per repository root license file.
3. **UI UX Pro Max (`nextlevelbuilder/ui-ux-pro-max-skill`) — MIT**:
   - *Adapted*: Design system structure, color harmonic pairing, industry-specific aesthetic archetypes.
4. **Vercel Agent Skills (`vercel-labs/agent-skills`) — Apache-2.0**:
   - *Adapted*: Web design guidelines, semantic structure rules, layout stability heuristics.
5. **Motion (`motiondivision/motion`) — MIT**:
   - *Adapted*: Spring physics principles, transition interruption rules, reduced-motion patterns.
6. **React Bits (`DavidHDev/react-bits`) — Commons Clause Restricted**:
   - *Excluded*: No code or components from React Bits are bundled, distributed, or integrated.

---

## 4. Consequences and Invariants

### Positive
- **Predictable Visual Quality**: Systematic progression from brief to tokens to code eliminates generic AI aesthetics.
- **Hardware-Verified Motion**: Animation claims must be proven through frame-rate and layout-thrashing telemetry.
- **Zero Supply-Chain Risk**: Pure TypeScript image diffing eliminates binary compilation issues and native vulnerabilities.
- **Context Efficiency**: Progressive disclosure maintains skill prompt budgets under 1,000 tokens each.
- **Deterministic Verification**: Visual regressions, contrast violations, and layout overflows are caught automatically before merging.

### Invariants Maintained
- **Single Authoritative Runtime**: All mutations flow through `AgentRuntime`, `PermissionGate`, and `MutationEngine`.
- **Governed Browser**: All browser measurements and screenshot captures run through the established, sandboxed `BrowserSessionManager`.
- **Non-Destructive**: User documentation (`DESIGN.md`, `PRODUCT.md`) is preserved and never overwritten without explicit confirmation.
- **Strict Reduced-Motion**: Every design token export automatically guarantees zero-duration transitions for users with vestibular sensitivities.

---

## 5. Sprint 9C.1 Addendum: Runtime Integration & Evidence Integrity

Sprint 9C.1 closes critical production gaps identified during the verification of Sprint 9C, transitioning the Advanced Design & Motion architecture from declarative prototypes to an executable, evidence-backed workflow:

### 5.1 Governed Runtime Integration (`GovernedDesignWorkflow`)
- **Single Runtime Invariant**: `GovernedDesignWorkflow` implements the existing `WorkflowRunner` / `WorkflowResult` interface (`status`, `state`, `confirmation`), directly wired into `createAgentRuntime` and executed by `AgentSessionBridge._runWorkflow()`. No secondary runtime or parallel agent loop is created.
- **Genuine Mutation & Gates**: Eliminated synthetic echo returns in Stages C and D. The workflow generates concrete files (`src/index.html`, `src/styles.css`, `src/app.js`) and prepares file updates through `MutationEngine`. Stage mutations require explicit developer approval through `IdeHost.requestConfirmation`.
- **Durable Checkpoints**: State checkpoints are recorded at each stage boundary (`DISCOVER_AND_SHAPE`, `DESIGN_SYSTEM`, `FRONTEND_IMPLEMENTATION`, `MOTION_ENGINEERING`, `VISUAL_QA_REFINEMENT`) via `CheckpointCoordinator`.
- **Bounded Iterative Repair**: Stage E executes automated review iterations (max 3), producing structured findings, issuing targeted repair instructions, applying approved mutations, and re-verifying until clean or budget exhausted.

### 5.2 Evidence-Backed Browser Observation & Contrast Integrity
- **Elimination of Fabricated QA Inputs**: `BrowserPanelController.#handleRunVisualQa()` previously substituted static text colors and button backgrounds. All synthetic defaults are eliminated in favor of real runtime telemetry extracted via `BrowserSessionManager.observeVisualQaState()`.
- **Bounded Safe Observation**: Telemetry captures computed styles, recursive composited background colors with alpha blending, element bounding client rects, client/scroll metrics, focus ring styles, and accessible names without exposing arbitrary `page.evaluate` execution to model prompts.
- **Indeterminate Contrast Safety**: `calculateContrastRatio()` was modified so unparseable or fully transparent colors return `null` instead of fabricating a 21:1 pass. Unresolved contrast produces `inconclusive_contrast` warning findings.
- **Realistic Compliance Scope**: Automated checks explicitly report that passing automated visual heuristics does not constitute exhaustive WCAG 2.1 AA certification, preventing false compliance claims.

### 5.3 Objective 5-Verdict Motion Evaluation
- **Active Animation Requirement**: The motion evaluator strictly disallows claims of animation quality when no animations executed during the observation window.
- **Five Deterministic Verdicts**:
  1. `measured_passing`: Active animations detected, average FPS ≥ 50, zero jank frames, and zero layout thrashing properties.
  2. `measured_failing`: Active animations detected but violated frame-rate, jank, or compositor-friendly property constraints.
  3. `no_animation_detected`: Zero animations observed; quality claims rejected.
  4. `insufficient_evidence`: Fewer than 5 animation frames captured; inconclusive.
  5. `unsupported_measurement`: Browser context does not support high-frequency sampling; inconclusive.
- **Explicit Reduced-Motion Verification**: Reduced-motion compliance requires testing under an explicit browser context configured with `emulateMedia({ reducedMotion: "reduce" })`, confirming that animations are removed or neutralized.

### 5.4 Hardened Zero-Dependency PNG Decoder
- **Decompression Bomb Protection**: Input PNG buffers are capped at 25 MB (`MAX_PNG_INPUT_SIZE`), decompressed streams are capped at 64 MB (`MAX_PNG_DECOMPRESSED_SIZE`), image dimensions are restricted to 4096×4096 (`MAX_PNG_WIDTH`, `MAX_PNG_HEIGHT`), and total pixel count is bounded to 8,000,000 (`MAX_PNG_TOTAL_PIXELS`).
- **Integrity Validation**: Added chunk length bounds checking, per-chunk CRC32 verification, duplicate/misplaced `IHDR` rejection, filter type enforcement (0–4), and rejection of interlaced formats (Adam7) to prevent unbounded memory allocation and buffer overruns from untrusted image assets.

