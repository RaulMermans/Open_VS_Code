---
id: evidence-reconciliation
name: Evidence Reconciliation & Unknown Auditing
description: Reconcile static, runtime, and model-derived evidence, detect contradictions, enforce epistemic separation, and audit residual unknowns.
version: 1
category: reverse-engineering
allowed_modes:
  - PLAN
  - REVIEW
capabilities:
  - read
  - search
required_tools:
  - read_file
  - search_text
context_budget: 750
risk_level: low
triggers:
  - reconcile evidence
  - audit residual unknowns
  - detect evidence contradictions
  - epistemic evidence separation
  - rea unknown audit
composes_with:
  - feature-specification
  - reconstruction-planning
---

# Intent

Audit the evidence ledger for contradictions between static and runtime observations, enforce strict separation between observed facts and inferences, and track residual unknowns.

# When to Use

- Reconciling static code analysis with dynamic browser observations.
- Validating that no model inference is treated as an authoritative observation.
- Auditing active unknowns before authorizing a reconstruction workflow.

Do not use to overwrite or discard contradictory evidence without investigating root causes.

# Inputs

- Complete evidence ledger with `OBSERVED`, `INFERRED`, and `UNKNOWN` records.
- Optional REA guided prompt `audit_residual_unknowns` or tool `reconcile_javascript_runtime`.
- Known exploration boundaries and limitations.

# Workflow

1. Cross-reference static and runtime facts: compare static route lists with visited browser URLs.
2. Flag contradictions: identify discrepancies (e.g. static route that returned 404 in browser).
3. Validate epistemic tagging: verify that all inferred records cite valid observed evidence IDs.
4. Block ungrounded promotion: ensure no hypothesis has been converted to an observation without proof.
5. Audit residual unknowns: evaluate remaining gaps and assess whether any block reconstruction.
6. Trigger bounded probes: if a critical unknown blocks planning, formulate a focused follow-up check.

# Verification

- Contradictions are documented rather than silently smoothed over.
- All inferences have clear evidence provenance.
- Residual unknowns are explicitly evaluated against reconstruction goals.

# Failure Modes

- Silent deletion: removing contradictory observations to create a cleaner specification.
- Inferred certainty: accepting plausible model guesses as observed facts.
- Ignoring blockers: proceeding to implementation with critical unknown data contracts.

# Exit Criteria

- Reconciled evidence report completed with contradiction status.
- Inferences and unknowns are validated and properly categorized.
- Investigation readiness verdict is established.
