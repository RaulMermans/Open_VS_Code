---
id: design-polish
name: Design Polish & Visual Critique
description: Perform high-fidelity visual refinement, subtle border contrast tuning, elevation depth, and alignment perfection.
version: 1
category: design
allowed_modes:
  - BUILD
  - REVIEW
capabilities:
  - read
  - search
  - write
required_tools:
  - read_file
  - search_text
  - apply_patch
context_budget: 850
risk_level: low
triggers:
  - design polish
  - visual polish
  - ui polish
  - micro-interaction polish
  - finishing review
  - design critique
composes_with:
  - visual-qa
  - frontend-composition
---

# Intent

Execute fine-grained visual refinement, edge alignment, subtle surface depth tuning, typographic measure adjustments, and interactive polish to elevate interfaces from functional to distinctive.

# When to Use

- A feature is functionally complete and accessible, but feels unpolished, unrefined, or visually plain.
- Conducting a finishing review before launching or sharing a customer-facing interface.
- Resolving minor visual defects discovered during `visual-qa` evaluations.

Do not use for implementing core business logic, complex data migrations, or net-new feature architectures.

# Inputs

- Rendered interface screenshots, element hierarchy, and computed styles.
- Active design tokens and theme variables.
- Feedback from `visual-qa` and accessibility audits.

# Workflow

1. Evaluate typographic measure and rhythm:
   - Ensure body copy line length stays between 45 and 75 characters per line (`max-w-prose` or `max-width: 65ch`).
   - Tune heading letter-spacing (negative tracking on large display headings, positive tracking on small uppercase labels).
   - Adjust line-heights to eliminate cramped multi-line text.
2. Refine surface borders and elevation:
   - Replace heavy solid borders with subtle semi-transparent borders (e.g. `rgba(255,255,255,0.08)` in dark mode).
   - Layer subtle ambient shadows under key elevated surfaces to create depth without blur artifacts.
3. Align spacing cadence:
   - Eliminate mismatched margins and padding by strictly adhering to the 4px/8px grid scale.
   - Balance whitespace around headers, cards, and section dividers.
4. Tune interactive transitions:
   - Add subtle hover scale or background shifts (150ms ease-out) to interactive cards and list items.
   - Refine active/pressed feedback states for tactile responsiveness.

# Verification

- Compare before and after screenshots to ensure changes increase visual clarity and distinction.
- Confirm subtle border and shadow adjustments maintain WCAG AA contrast against adjacent surfaces.
- Verify polish edits introduce zero layout shifts or regressions in responsiveness.

# Failure Modes

- Adding excessive decorative visual elements (gradients, glows, shadows) that distract from core tasks.
- Inconsistent spacing where one side of a container has padding that breaks the visual grid.
- Over-polishing without verifying that underlying functional interactions remain fully operational.

# Exit Criteria

- Visual polish refinements are committed with verified improvements in aesthetics and hierarchy.
- The interface achieves a polished, coherent, and premium finish ready for production release.
