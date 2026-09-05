---
id: ARCH_REVIEW_PASS
title: Architecture Review Pass
summary: Inspect codebase for structural integrity, boundary violations, and maintainability.
modes:
  - REVIEW
  - PLAN
tags:
  - restructuring
  - architecture
  - review
  - structure
tools:
  - read_file
  - search_text
---

# Intent
Evaluate the architectural health of a module or project to ensure maintainability and correct boundaries, without speculative redesign by default.

# When
Use when asked to review the architecture, find tech debt, or assess the structure of a system.

# Inputs
- Target directory or module
- Architectural guidelines or ADRs

# Procedure
Inspect the following areas:
1. **Source-of-truth duplication:** Are facts or state duplicated across modules?
2. **Boundary violations:** Do modules bypass intended public APIs?
3. **Dependency direction:** Are high-level modules depending on low-level details?
4. **State ownership:** Is it clear who owns and mutates state?
5. **Unsafe coupling:** Are distinct components too tightly linked?
6. **Parallel implementations:** Are there multiple ways to do the same thing?
7. **Stale paths:** Is there dead code or unused files?
8. **Testability:** Can the components be tested in isolation?
9. **Maintainability:** Is the code easy to read and update?
10. **Failure containment:** Do errors crash the whole system or are they contained?

# Expected Output
- findings
- severity
- evidence
- smallest recommended correction

# Failure Modes
- Speculative redesign (proposing massive changes without need).
- Ignoring existing ADRs or project rules.

# Recovery Prompts
Speculative redesign: focus on documenting current state and small corrections.
