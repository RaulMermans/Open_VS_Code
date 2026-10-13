---
id: bug-triage
name: Bug Triage
description: Diagnose a reproducible failure with evidence before modifying any code.
version: 1
category: debugging
allowed_modes:
  - DEBUG
  - BUILD
capabilities:
  - read
  - search
  - write
  - verify
required_tools:
  - read_file
  - search_text
context_budget: 900
risk_level: low
triggers:
  - bug
  - crash
  - fail
  - failure
  - broken
  - regression
  - error
  - exception
  - stack trace
  - not working
  - root cause
  - reproduce
---

# Intent

Find the cause of a failure before changing code. Diagnose first, edit second, verify last.

# When to Use

- A test, build, command, or feature produces a wrong result, error, or crash.
- The failure can be observed or reproduced.

Do not use for new features or for refactoring working code.

# Inputs

- The failure report: error text, failing test name, or observed wrong output.
- The files named in the report or stack trace, if any.

# Workflow

1. Reproduce: run the failing check with `run_verification` (usually `TEST`), or locate the failing assertion or error message with `search_text`.
2. Capture the exact failure: copy the precise error message, file, and line from the observation. Do not paraphrase it.
3. Inspect the relevant state: read only the code on the failing path with `read_file`. Follow the call chain from the failure point outward.
4. Form one minimal hypothesis that explains every observed symptom.
5. Run one discriminating check that would come out differently if the hypothesis were wrong (read a value, search a caller, run one narrow test).
6. Only after the check confirms the hypothesis, prepare the smallest fix with `apply_patch`. Change only the faulty logic.
7. Verify: rerun the originally failing check, then the surrounding suite.

If the check refutes the hypothesis, return to step 3 with the new evidence instead of editing.

# Verification

- The originally failing check now passes.
- The related test suite still passes.
- The diff touches only the code on the failing path.

# Failure Modes

- Editing before reproducing: the "fix" may not address the real failure.
- Several speculative edits at once: impossible to tell which one mattered.
- Fixing the symptom (for example catching and hiding an error) instead of the cause.

# Exit Criteria

- Root cause stated in one sentence with the file and line.
- Minimal fix applied and verified, or a clear report of what evidence is still missing.
