---
id: feature-specification
name: Feature & Behavior Specification
description: Synthesize grounded functional specifications from reverse-engineering evidence, mapping routes, business rules, and UI components.
version: 1
category: reverse-engineering
allowed_modes:
  - PLAN
  - REVIEW
  - BUILD
capabilities:
  - read
  - search
required_tools:
  - read_file
  - search_text
context_budget: 800
risk_level: low
triggers:
  - build feature specification
  - reverse engineering specification
  - functional specification from evidence
  - synthesize behavior spec
composes_with:
  - evidence-reconciliation
  - reconstruction-planning
---

# Intent

Transform raw runtime observations, DOM snapshots, and static analysis records into a structured, reconstruction-oriented functional specification grounded in verifiable evidence.

# When to Use

- Synthesizing an implementation blueprint after completing web or application exploration.
- Defining functional requirements, route topologies, and UI component hierarchies.
- Documenting observable business rules, input validations, and error handling policies.

Do not use for inventing hypothetical features not supported by recorded evidence.

# Inputs

- Structured evidence ledger containing observed facts and state transitions.
- Epistemic status classifications (`OBSERVED`, `INFERRED`, `UNKNOWN`).
- Target identity and exploration summary.

# Workflow

1. Compile feature inventory: extract discrete capabilities and bind each to supporting evidence IDs.
2. Construct route map: list observed URLs/paths, layout structures, and accessibility landmarks.
3. Model state transitions: assemble the interaction graph from observed action/response records.
4. Document business rules: record input constraints, validation logic, and visible state reactions.
5. Catalog components: document UI elements, visual styles, and responsive layout behavior.
6. Isolate unknowns: gather all unobservable backend details and clearly flag inferred architecture.

# Verification

- Every documented feature cites at least one valid evidence ID.
- Observed behaviors are strictly separated from speculative inferences.
- Inferred architecture sections are explicitly labeled as hypotheses.

# Failure Modes

- Hallucinating backend logic: asserting database schemas or server code as facts without proof.
- Orphaned claims: specifying features that have no corresponding evidence record.
- Ambiguous validation: describing validation rules without citing actual error messages observed.

# Exit Criteria

- Complete `ReconstructionSpecification` document generated.
- All functional paths and UI components are grounded in evidence.
- Residual unknowns are cataloged with risk assessments.
