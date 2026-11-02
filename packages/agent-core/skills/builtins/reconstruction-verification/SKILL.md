---
id: reconstruction-verification
name: Reconstruction Verification & Obligation Closure
description: Verify reconstructed implementations against reference evidence, execute independent tests, and close obligations with cryptographic proof.
version: 1
category: reverse-engineering
allowed_modes:
  - BUILD
  - REVIEW
capabilities:
  - read
  - search
  - verify
required_tools:
  - read_file
  - search_text
  - run_verification
context_budget: 800
risk_level: low
triggers:
  - verify reconstruction
  - close reconstruction obligations
  - test reconstruction parity
  - compare reconstructed behavior
  - rea verification prompt
composes_with:
  - reconstruction-planning
  - evidence-reconciliation
---

# Intent

Compare the reconstructed software implementation against the original reference observations, run independent verification suites, and close reconstruction obligations with concrete test evidence.

# When to Use

- Verifying reconstructed web applications or codebases against original evidence.
- Evaluating obligation test results and updating the obligation ledger.
- Executing comparative browser checks or unit test assertions to prove behavioral parity.

Do not use to claim obligation closure without passing test execution evidence.

# Inputs

- Reconstructed code in the workspace.
- Active `ReconstructionObligationLedger` with open obligations.
- Original evidence ledger and reference observations.
- Test runner and verification engine.

# Workflow

1. Execute test suite: run unit and integration tests covering the reconstructed modules.
2. Verify test evidence: confirm that tests executed and passed without synthetic mock shortcuts.
3. Perform comparative check:
   - For web apps: launch reconstructed local server and verify DOM state transitions via Playwright.
   - Assert navigation parity, form validations, and error messages match reference observations.
4. Update obligation statuses: transition satisfied obligations from `implemented` to `verified`.
5. Re-evaluate ledger closure: compute updated ledger summary, checking for remaining open or blocked claims.
6. Generate final report: detail verified obligations, test evidence digests, and residual unknowns.

# Verification

- No obligation is marked `verified` without a passing test execution record.
- Comparative assertions directly mirror the original `OBSERVED` state transitions.
- Ledger closure digest reflects all verified test results.

# Failure Modes

- Paper verification: marking obligations closed because files exist without running tests.
- Claiming backend parity: asserting internal database equivalence from browser tests.
- Silent regression: ignoring failing edge-case assertions.

# Exit Criteria

- All required obligations verified by passing test evidence.
- Final parity report produced with coverage statistics and known limitations.
- Updated obligation ledger recorded.
