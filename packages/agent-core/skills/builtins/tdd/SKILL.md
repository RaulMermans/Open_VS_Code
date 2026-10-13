---
id: tdd
name: Test-Driven Development
description: Implement new behavior test-first with a red, green, refactor cycle.
version: 1
category: testing
allowed_modes:
  - BUILD
  - DEBUG
capabilities:
  - read
  - search
  - write
  - verify
required_tools:
  - read_file
  - search_text
  - apply_patch
  - run_verification
context_budget: 900
risk_level: low
triggers:
  - tdd
  - test first
  - tests first
  - test driven
  - red green
  - write a failing test
  - failing test first
  - with tests first
---

# Intent

Drive a behavior change through a failing test: RED, then GREEN, then REFACTOR.

# When to Use

- The task asks for test-first or test-driven work.
- The desired behavior can be expressed as an observable input and output.

Do not apply to tasks that did not ask for it, and do not use it to diagnose an existing failure.

# Inputs

- The behavior to add or change, stated as expected input and output.
- The existing test file and test conventions closest to the code under change.

# Workflow

1. Find the nearest existing tests with `search_text` or `find_files` and follow their style and runner.
2. RED: add the smallest test that checks the new behavior through the public interface, not framework internals.
3. Run it with `run_verification` (`TEST`) and confirm it fails for the expected reason. A test that passes immediately proves nothing.
4. GREEN: make the minimal code change with `apply_patch` that makes this test pass.
5. Rerun the relevant tests and confirm they pass.
6. REFACTOR: remove duplication or clarify names only while the tests stay green.
7. Run the broader suite, then `TYPECHECK` and `LINT` when the project defines them.

# Verification

- The new test failed before the implementation and passes after it.
- The surrounding suite passes.
- Typecheck and lint pass when the project defines them.

# Failure Modes

- Writing implementation before the test.
- Testing private details or mocks instead of behavior.
- A large test that covers several behaviors at once.

# Exit Criteria

- One or more behavior tests added, each observed failing first.
- Minimal implementation passes them and the broader suite stays green.
