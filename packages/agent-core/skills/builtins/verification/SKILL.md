---
id: verification
name: Verification
description: Decide whether a change is ready by running the project's own build, typecheck, lint and test checks.
version: 1
category: verification
allowed_modes:
  - REVIEW
  - BUILD
  - DEBUG
capabilities:
  - read
  - search
  - verify
required_tools:
  - read_file
  - run_verification
context_budget: 900
risk_level: low
triggers:
  - ready
  - verify
  - verification
  - validate
  - run the checks
  - run checks
  - typecheck
  - lint
  - before merge
  - before merging
  - ship
  - sanity check
---

# Intent

Give an evidence-based verdict on whether a change is ready, using the project's existing checks.

# When to Use

- The task asks whether a change is done, ready, safe to merge, or passing.

Do not use it to implement or fix code; report what fails instead.

# Inputs

- The change under review (the files touched or the described diff).
- The project's own scripts. `run_verification` discovers `BUILD`, `TYPECHECK`, `LINT`, and `TEST` from the project's package scripts; use those instead of inventing commands.

# Workflow

1. Identify which checks the project defines. Skip actions the project does not define and say so.
2. Run them in this order with `run_verification`, stopping at the first hard failure: `BUILD`, `TYPECHECK`, `LINT`, `TEST`.
3. For each failure, capture the exact error and the file it points to.
4. Review the diff itself with `read_file`: unintended edits, leftover debug output, secrets, or files outside the task scope.
5. If the change touches security-sensitive code, note that a security review is advisable.

# Verification

- Each verdict line is backed by a check that actually ran, with its result.
- Checks that were not run are listed with the reason.

# Failure Modes

- Declaring success from reading code alone, with no check run.
- Hardcoding a package manager or command the project does not use.
- Hiding a failing check behind a partial pass.

# Exit Criteria

- A verdict of READY, NOT READY, or UNKNOWN, with the list of checks run, their results, and any blocking failure.
