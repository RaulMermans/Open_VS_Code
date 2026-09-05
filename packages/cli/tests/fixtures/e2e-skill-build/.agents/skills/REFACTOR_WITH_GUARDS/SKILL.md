---
id: REFACTOR_WITH_GUARDS
title: Refactor With Guards
summary: Improve code structure without altering observable behavior, guarded by tests.
modes:
  - BUILD
  - DEBUG
tags:
  - refactor
  - structural
  - cleanup
tools:
  - read_file
  - search_text
---

# Intent
Modify the internal structure of code without changing its observable external behavior, backed by verification.

# When
Use when asked to clean up, restructure, or optimize existing code.

# Inputs
- Target code to refactor
- Reason for refactor

# Procedure
1. **Define preserved behavior:** Explicitly note what the code currently does and must continue to do.
2. **Identify tests/contracts:** Locate the tests that guard this behavior.
3. **Bound refactor scope:** Limit changes to the specific module or function.
4. **Avoid feature creep:** Do not add new features or fix unrelated bugs during the refactor. Explicit anti-pattern: "rewrite because cleaner" without preserved-behavior evidence.
5. **Prepare mutation:** Draft the structural improvements.
6. **Verify unchanged behavior:** Run the tests to prove nothing broke.
7. **Report structural improvement:** Summarize what was improved and how it was verified.

# Expected Output
Cleaner, more maintainable code that passes all previous tests.

# Failure Modes
- Observable behavior changes (regression).
- Rewriting too much at once.
- Missing test coverage for the refactored code.

# Recovery Prompts
Behavior changed: rollback the refactor and try a smaller step.
Too broad: narrow the scope to a single function or file.
