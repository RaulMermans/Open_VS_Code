---
id: visual-qa
name: Visual Quality Assurance & Comparison
description: Detect visual regressions, pixel and region discrepancies, layout shifts, and typography/spacing defects.
version: 1
category: verification
allowed_modes:
  - REVIEW
  - PLAN
  - BUILD
capabilities:
  - read
  - search
  - verify
required_tools:
  - read_file
  - search_text
  - run_verification
context_budget: 950
risk_level: low
triggers:
  - visual qa
  - visual regression
  - visual comparison
  - screenshot comparison
  - ui diff
composes_with:
  - design-polish
  - accessibility-review
---

# Intent

Detect, classify, and report visual discrepancies, layout shifts, pixel regressions, and styling bugs through deterministic browser observations, screenshot comparisons, and evidence-backed evaluations.

# When to Use

- Verifying frontend component or page implementations against visual baselines or reference designs.
- Auditing responsive layouts across mobile (390px), tablet (768px), and desktop (1280px) viewports.
- Conducting automated before/after regression checks following component refactorings.

Do not use for testing non-visual backend API endpoints or CLI argument parsers.

# Inputs

- Rendered webpage or component running in a local development server or test fixture.
- Visual baseline screenshot or reference design specification.
- Inspected element typography, spacing, layout metadata, and frame timing metrics.

# Workflow

1. Navigate to target URL in governed browser session and wait for network idle and font readiness.
2. Capture full-viewport screenshot at defined dimensions (1280x800, 768x1024, 390x844).
3. If baseline exists, execute deterministic pixel comparison:
   - Identify mismatched pixel count and overall mismatch percentage.
   - Cluster differences into bounding box regions.
   - Classify each region into category: layout regression, typography mismatch, spacing mismatch, color mismatch, or expected dynamic content.
4. Inspect computed box-model metrics: padding, margin, font-size, line-height, alignment.
5. Record structured findings citing exact element selectors, bounding boxes, and observed evidence.

# Verification

- Ensure comparison occurs under identical viewport, device scale factor, and animation-paused conditions.
- Confirm difference classification distinguishes intentional content updates from layout bugs.
- Verify every reported finding includes reproduction steps, exact element references, and suggested fixes.

# Failure Modes

- Treating minor subpixel antialiasing differences as critical layout failures.
- Claiming visual perfection without testing mobile or tablet viewports.
- Failing to wait for fonts or web assets to load before capturing comparison screenshots.

# Exit Criteria

- A structured visual QA report is generated with categorized findings, severity ratings, and evidence citations.
- Deficiencies are forwarded to `design-polish` or `frontend-composition` for bounded repair.
