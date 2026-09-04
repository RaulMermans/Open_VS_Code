---
id: BUG_TRIAGE_LOOP
title: Bug Triage Loop
summary: Diagnose a defect using evidence before attempting the smallest repair.
modes:
  - DEBUG
tags:
  - debugging
  - regression
  - diagnosis
tools:
  - read_file
  - search_text
  - find_files
---

# Intent
Diagnose and repair defects systematically by gathering evidence first, forming bounded hypotheses, and applying the smallest viable mutation, rather than guessing broadly.

# When
Use this procedure whenever an unexpected failure, crash, regression, or bug is reported.

# Inputs
- Task description or error report
- Relevant files (if known)
- System logs or test outputs

# Procedure
1. **Reproduce / establish failing evidence:** Search for the exact error message or locate the failing test.
2. **Form bounded hypotheses:** Identify what components could cause the error based on the evidence.
3. **Inspect discriminating evidence:** Read relevant file sections or use `search_text` to verify hypotheses before making changes.
4. **Identify smallest root cause:** Pinpoint the exact line(s) causing the issue.
5. **Prepare minimal repair:** Use search/replace patching to change only the broken logic. Do not rewrite large blocks or clean up unrelated code.
6. **Human approval:** Wait for human authorization before applying the mutation.
7. **Verification:** Verify the fix using established commands (e.g. `npm test`).
8. **Regression check:** Ensure the repair does not break unrelated behavior.
9. **Stop or bounded second attempt:** If the first repair fails, analyze new evidence before attempting one more bounded fix. Stop if the budget is exhausted.

# Expected Output
A verified, minimal code patch that resolves the issue without regressions.

# Failure Modes
- The bug cannot be reproduced.
- The repair breaks other tests (regression).
- Hypotheses exhausted without a root cause.

# Recovery Prompts
No reproduction: gather failing evidence before mutation.
Hypotheses exhausted: stop with evidence rather than broad guessing.
Repair regresses unrelated behavior: rollback/reject mutation and narrow scope.
