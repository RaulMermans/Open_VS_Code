---
id: frontend-composition
name: Frontend Composition & Architecture
description: Construct accessible, semantic, and modular frontend components adhering to established design systems.
version: 1
category: design
allowed_modes:
  - BUILD
capabilities:
  - read
  - search
  - write
required_tools:
  - read_file
  - search_text
  - apply_patch
context_budget: 900
risk_level: medium
triggers:
  - frontend composition
  - component architecture
  - ui implementation
  - semantic layout
  - responsive ui
composes_with:
  - motion-engineering
  - accessibility-review
---

# Intent

Implement robust, accessible, responsive, and maintainable frontend user interfaces and components using semantic HTML, clean state handling, and established project design tokens.

# When to Use

- Building new screens, layouts, cards, modals, tables, or interactive UI widgets.
- Refactoring legacy templates to adopt modern component patterns and responsive grids.
- Implementing UI changes specified in design direction or information architecture artifacts.

Do not use for authoring backend database schemas or server deployment configurations.

# Inputs

- Approved design direction, information architecture, and design tokens.
- Target framework and conventions (React, Vue, Svelte, or native Web Components/HTML).
- Component interface contracts: props, callbacks, state management, and error/empty states.

# Workflow

1. Inspect existing component hierarchy to maximize reuse and adhere to codebase conventions.
2. Structure semantic markup: use native `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<button>`, and `<dialog>` tags.
3. Wire design tokens for spacing, colors, typography, and borders via utility classes or CSS modules.
4. Implement component states: default, hover, active, focus-visible, disabled, loading, and error.
5. Ensure responsive responsiveness using CSS Grid/Flexbox with mobile-first breakpoints.
6. Verify keyboard accessibility: logical tab index, Enter/Space activation, and Escape to dismiss overlays.

# Verification

- Verify component renders correctly without runtime JavaScript console warnings or errors.
- Confirm keyboard navigation reaches all interactive controls with visible `:focus-visible` styling.
- Verify component adapts cleanly at 390px (mobile), 768px (tablet), and 1280px (desktop) without overflow.

# Failure Modes

- Rebuilding existing UI primitives from scratch instead of reusing project components.
- Using non-interactive `<div>` or `<span>` elements for clickable actions without ARIA or keyboard support.
- Hardcoding absolute dimensions that cause horizontal clipping or text overflow on small viewports.

# Exit Criteria

- Frontend components are written, integrated with application state, and verified responsive.
- Ready for animation enhancement via `motion-engineering` and verification via `visual-qa`.
