---
id: ux-information-architecture
name: UX Information Architecture & Flow
description: Structure user flows, content hierarchy, layout rhythm, and responsive navigation models for complex interfaces.
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
context_budget: 850
risk_level: low
triggers:
  - information architecture
  - user flow
  - layout hierarchy
  - navigation structure
  - content hierarchy
  - page hierarchy
composes_with:
  - design-direction
  - frontend-composition
---

# Intent

Design clear information hierarchies, logical user navigation flows, and structured content layouts that reduce cognitive load and support primary user tasks.

# When to Use

- Structuring multi-step workflows, forms, dashboards, or navigation bars.
- Reorganizing cluttered pages where key actions or critical data are difficult to discover.
- Defining responsive content stacking and breakpoint progression for multi-column interfaces.

Do not use for styling micro-interactions or fine-tuning CSS transition curves.

# Inputs

- User goals, primary workflows, and edge scenarios from the product brief.
- Data structures and entities requiring display or user modification.
- Existing page layouts, routes, and navigation patterns in the repository.

# Workflow

1. Map primary user tasks and critical completion paths (happy path, error recovery, empty states).
2. Group content into logical hierarchy tiers:
   - Primary: critical status, main call-to-action, key content object.
   - Secondary: contextual actions, supporting metadata, filters.
   - Tertiary: metadata details, history, auxiliary links.
3. Establish layout zones (global navigation, header/context bar, main content area, contextual drawer/rail).
4. Define responsive behavior: determine how multi-column sections collapse or prioritize on mobile (390px).
5. Document affordances, form field sequencing, and empty/loading state patterns.

# Verification

- Verify that the primary user goal can be completed in the minimal number of intuitive interactions.
- Confirm critical actions remain visible above the fold or in persistent sticky headers/footers where appropriate.
- Verify content flows logically when navigated strictly via keyboard Tab ordering.

# Failure Modes

- Hidden critical actions buried behind multiple nested dropdowns or menus.
- Equal visual weight given to all elements, leading to cognitive fatigue.
- Disconnected mobile layouts where secondary content displaces primary actions.

# Exit Criteria

- Information architecture layout, content hierarchy, and navigation flow are defined and validated.
- Screen structure is ready for implementation by `frontend-composition`.
