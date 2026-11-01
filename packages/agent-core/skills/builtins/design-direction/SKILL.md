---
id: design-direction
name: Design Direction & Visual Strategy
description: Establish visual strategy, aesthetic tone, and distinct design decisions from briefs, avoiding generic AI tropes.
version: 1
category: design
allowed_modes:
  - PLAN
  - BUILD
  - ASK
capabilities:
  - read
  - search
required_tools:
  - read_file
  - search_text
context_budget: 900
risk_level: low
triggers:
  - design direction
  - visual strategy
  - aesthetic direction
  - creative brief
  - design brief
  - art direction
composes_with:
  - ux-information-architecture
  - design-system-engineering
---

# Intent

Establish an intentional visual strategy and distinct aesthetic direction for the product before building code, avoiding generic AI aesthetic conventions (such as purple-gradient cards and unstyled pill badges).

# When to Use

- A new interface or major feature requires clear visual direction, hierarchy, and styling decisions.
- The user provides a product brief, mood board, or reference screenshot and requests design execution.
- Existing screens appear cluttered, generic, or lacking visual personality.

Do not use for routine bug fixes or isolated unit test additions that do not alter the interface.

# Inputs

- The `DesignBrief` or product description detailing product archetype, audience, and goals.
- Existing project documentation (`DESIGN.md`, `PRODUCT.md`, `README.md`) and brand assets.
- Reference applications or screenshots provided or authorized in the workspace.

# Workflow

1. Extract core product personality, archetype, audience, and functional requirements from the brief.
2. Inspect existing workspace conventions, design guidelines, and color variables to preserve continuity.
3. Establish visual direction choices:
   - Primary aesthetic: minimal, editorial, technical, playful, luxury, or utility.
   - Distinctive visual signatures: custom border treatments, specific elevation levels, purposeful accents.
   - Typography strategy: pairing display/heading fonts with readable body type.
   - Color strategy: dominant surface tones, high-contrast text, restrained single-accent callouts.
4. Define responsive layouts and spacing rhythm across mobile (390px), tablet (768px), and desktop (1280px).
5. Record design decisions in a structured design direction artifact before frontend implementation begins.

# Verification

- Verify visual decisions directly address user goals and product constraints from the brief.
- Ensure chosen color combinations achieve minimum 4.5:1 contrast against surface backgrounds.
- Confirm typography pairings are legible at 12px through 32px scales across all target viewports.

# Failure Modes

- Reverting to generic AI aesthetics: overused purple glows, floating frosted cards, or low-contrast gray text.
- Overwriting existing design systems or brand colors without user confirmation.
- Selecting layout patterns that break on mobile screens or in high-contrast mode.

# Exit Criteria

- A validated design direction is documented with concrete typography, color, spacing, and layout specifications.
- Direction is ready for token translation in `design-system-engineering` or implementation in `frontend-composition`.
