---
id: accessibility-review
name: Accessibility & WCAG Conformance Review
description: Audit contrast ratios, keyboard navigation paths, ARIA roles, focus visibility, and assistive technology readiness.
version: 1
category: security
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
context_budget: 850
risk_level: low
triggers:
  - accessibility review
  - wcag review
  - a11y audit
  - contrast ratio
  - screen reader
  - keyboard navigation
composes_with:
  - visual-qa
  - design-polish
---

# Intent

Audit rendered web interfaces for WCAG 2.1 AA/AAA accessibility compliance, ensuring keyboard accessibility, sufficient contrast, correct semantic roles, and inclusive usability for all developers.

# When to Use

- Performing a pre-release accessibility review on new or updated frontend components.
- Investigating reported keyboard trap bugs, missing focus outlines, or illegible color contrast.
- Verifying forms, modals, accordions, and custom interactive widgets meet accessibility standards.

Do not use for general database schema reviews or backend network security audits.

# Inputs

- Rendered DOM tree, accessibility tree snapshot, and computed CSS styles.
- Interactive element states: default, hover, focus, disabled, expanded, checked.
- Color palette values for text, background, and UI border surfaces.

# Workflow

1. Audit semantic landmarks: verify page contains single `<main>`, appropriate `<nav>`, `<header>`, and headings (`<h1>` through `<h6>`) in logical descending order.
2. Verify keyboard navigation:
   - Ensure all interactive elements can receive focus via Tab.
   - Verify focus indicator is clearly visible (minimum 2px solid contrast outline).
   - Ensure modals trap focus when open and return focus to trigger upon dismissal.
   - Verify Escape key closes dialogs, popovers, and menus.
3. Calculate color contrast:
   - Verify normal text (< 18pt or < 14pt bold) achieves >= 4.5:1 against background.
   - Verify large text achieves >= 3.0:1.
   - Verify interactive component boundaries and icons achieve >= 3.0:1.
4. Verify ARIA attributes: check valid roles, aria-expanded, aria-controls, and accessible names on icon buttons.
5. Inspect target size: ensure touch targets meet minimum 24x24px (preferably 44x44px).

# Verification

- Validate contrast ratios with mathematical luminance calculation formulas.
- Verify screen reader accessibility tree displays meaningful name, role, and state for every control.
- Confirm full navigation workflow can be operated solely using keyboard (Tab, Shift+Tab, Enter, Space, Arrows).

# Failure Modes

- Relying on `outline: none` without providing an alternative high-contrast `:focus-visible` ring.
- Using color alone as the sole indicator of status or error states.
- Adding redundant or misleading ARIA attributes that conflict with native HTML semantics.

# Exit Criteria

- Accessibility audit findings are documented with WCAG criterion citations, severity, and remediation code.
- Zero blocker or critical accessibility violations remain unresolved.
