---
id: motion-engineering
name: Motion Engineering & Choreography
description: Implement purposeful, hardware-accelerated animations, spring transitions, layout effects, and reduced-motion fallbacks.
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
context_budget: 950
risk_level: medium
triggers:
  - motion engineering
  - animation
  - spring transition
  - layout animation
  - motion choreography
  - microinteraction
composes_with:
  - frontend-composition
  - visual-qa
---

# Intent

Implement purposeful, responsive, and hardware-accelerated animations and micro-interactions that guide user focus, indicate state changes, and respect user accessibility preferences.

# When to Use

- Adding entrance/exit transitions for modals, drawers, toasts, accordions, and dropdown menus.
- Refining interactive state feedback: button hovers, card selections, tab switching, and loading spinners.
- Orchestrating multi-element sequenced reveals and layout transitions without layout thrashing.

Do not use for gratuitous decorative motion, constant looping animations, or intensive 3D scene rendering.

# Inputs

- The components or screens requiring motion enhancement.
- Established motion tokens (durations, easing curves, spring physics parameters).
- Accessibility requirement for `@media (prefers-reduced-motion: reduce)`.

# Workflow

1. Identify functional animation goals: orient user, connect spatial relationships, or confirm actions.
2. Select hardware-accelerated properties: restrict animations to `transform` and `opacity`. Strictly avoid animating layout triggers (`top`, `left`, `width`, `height`, `margin`, `padding`).
3. Set calibrated timing:
   - Micro-interactions (hover, press, toggle): 150ms to 250ms with snappy ease-out.
   - Component transitions (modals, drawers, panels): 250ms to 400ms with smooth deceleration curves.
   - Staggered lists: 30ms to 50ms stagger delays between items, capped at 300ms total.
4. Implement graceful interruption: ensure animations can be cancelled or retargeted without jumping or visual snapping.
5. Provide complete reduced-motion alternatives via `@media (prefers-reduced-motion: reduce)`: replace spatial movement with instantaneous cuts or gentle opacity fades.

# Verification

- Verify animated elements maintain 60 FPS without jank or frame drops.
- Inspect computed styles during animation to confirm zero layout thrashing or unwanted layout shifts (CLS < 0.05).
- Test with `prefers-reduced-motion: reduce` enabled to ensure motion is disabled or adapted.

# Failure Modes

- Animating geometry properties (`height`, `width`, `top`, `left`) triggering expensive layout recalculations.
- Overshooting spring physics that make interfaces feel sluggish or unstable.
- Forgetting `prefers-reduced-motion`, causing vestibular discomfort for motion-sensitive users.

# Exit Criteria

- Animations are implemented using composited transforms and opacity with reduced-motion support.
- Code is ready for real motion evaluation via `visual-qa`.
