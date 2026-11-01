---
id: design-system-engineering
name: Design System Engineering & Tokens
description: Define, extend, and implement coherent design tokens, color scales, type scales, and component state patterns.
version: 1
category: design
allowed_modes:
  - PLAN
  - BUILD
capabilities:
  - read
  - search
  - write
required_tools:
  - read_file
  - search_text
  - apply_patch
context_budget: 950
risk_level: medium
triggers:
  - design system
  - design tokens
  - color tokens
  - type scale
  - spacing tokens
  - theme tokens
composes_with:
  - frontend-composition
  - motion-engineering
---

# Intent

Synthesize, extend, and formalize design tokens (colors, typography, spacing, radii, shadows, and motion tokens) into clean code definitions (CSS variables or theme config) avoiding ad-hoc hardcoded values.

# When to Use

- Establishing a consistent design token foundation for a project or component library.
- Extending an existing design system with missing semantic colors, dark mode tokens, or spacing steps.
- Refactoring hardcoded pixel, hex, or margin values into reusable system tokens.

Do not use for implementing standalone business logic or backend API endpoints.

# Inputs

- The approved visual direction and brand guidelines.
- Existing token files (e.g. `globals.css`, `tailwind.config.js`, `tokens.json`, or CSS module files).
- Target component states and theme modes (light, dark, high contrast).

# Workflow

1. Audit existing token definitions to avoid introducing duplicate or conflicting token names.
2. Formalize core token categories:
   - Color tokens: background, surface, border, text (primary, secondary, muted), semantic (success, warning, error, info), and primary action.
   - Typography tokens: font families (sans, serif, mono), type scale (xs to 4xl), line heights (1.2 to 1.6), and font weights.
   - Spacing & layout: 4px/8px modular scale (4, 8, 12, 16, 24, 32, 48, 64px), container max-widths, and standard grid columns.
   - Surface elevation: border-radius scale (none, sm, md, lg, full) and subtle shadow definitions.
   - Motion tokens: duration (instant, fast, normal, slow) and standard cubic-bezier curves.
3. Write or update token declarations using CSS custom properties (`:root { ... }`) or framework config.
4. Verify dark mode overrides and high-contrast fallbacks preserve semantic meaning.

# Verification

- Ensure all token values are valid CSS values and adhere to mathematical scale intervals.
- Verify color contrast between corresponding text and background tokens passes WCAG AA (>= 4.5:1).
- Confirm zero naming collisions or circular variable references (`var(--a)` referencing `var(--a)`).

# Failure Modes

- Introducing hardcoded magic numbers or rogue hex values instead of referencing tokens.
- Defining conflicting duplicate systems that clash with existing project CSS.
- Omitting dark mode contrast verification, producing unreadable inverted text.

# Exit Criteria

- Validated design tokens are written to the project's canonical token or styling file.
- Tokens are documented, consumable by components, and ready for `frontend-composition`.
