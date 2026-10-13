---
id: refactor-with-guards
name: Refactor With Guards
description: Restructure code in small verified steps without changing externally observable behavior.
version: 1
category: refactoring
allowed_modes:
  - BUILD
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
risk_level: medium
triggers:
  - refactor
  - clean up
  - cleanup
  - restructure
  - simplify
  - extract
  - deduplicate
  - reorganize
  - tidy
  - without changing behavior
  - preserve behavior
  - same behavior
---

# Intent

Improve structure while keeping externally observable behavior identical.

# When to Use

- The task asks to clean up, simplify, extract, or restructure working code.
- Behavior must stay the same.

Do not use when the task also asks for new features or bug fixes; split those into separate changes.

# Inputs

- The code to restructure and its public interface (exports, signatures, outputs).
- The tests that exercise that interface.

# Workflow

1. Establish a baseline: run `run_verification` (`TEST`) before any edit and record the result. If it is already failing, stop and report.
2. Identify invariants: the public signatures, return values, side effects, and error behavior that must not change. Use `search_text` to find every caller.
3. If the interface has no test coverage, add a characterization test first.
4. Make one small structural change with `apply_patch` (one extraction, one rename, one move).
5. Rerun the baseline tests after each change. They must give the same result as the baseline.
6. Repeat steps 4 and 5. Keep each diff small enough to review at a glance.
7. Finish with `TYPECHECK` and `LINT` when the project defines them.

# Verification

- Test results match the baseline exactly.
- Every caller found in step 2 still compiles and behaves the same.
- No new features, options, or behavior changes appear in the diff.

# Failure Modes

- Mixing a behavior change into the refactor.
- One large rewrite instead of small verified steps.
- Changing a public signature that has callers outside the edited file.

# Exit Criteria

- The structure is improved as requested.
- Tests match the baseline and the diff contains only structural changes.
