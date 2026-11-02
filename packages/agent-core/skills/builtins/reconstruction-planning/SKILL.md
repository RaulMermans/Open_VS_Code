---
id: reconstruction-planning
name: Reconstruction Planning & Obligation Derivation
description: Formulate clean-room implementation plans and derive deterministic reconstruction obligations with positive, negative, and edge test cases.
version: 1
category: reverse-engineering
allowed_modes:
  - PLAN
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
  - plan reconstruction
  - derive reconstruction obligations
  - clean room implementation plan
  - build reconstruction ledger
composes_with:
  - feature-specification
  - reconstruction-verification
---

# Intent

Translate an approved functional specification into a clean-room implementation plan and a deterministic Reconstruction Obligation Ledger with explicit test verification contracts.

# When to Use

- Planning the independent reconstruction of an investigated software system.
- Generating formal obligations covering positive cases, negative validations, edge cases, and failure modes.
- Integrating with REA's `build_reconstruction_obligation_ledger` tool or generating a local ledger.

Do not use for copying proprietary source code or implementing features without human authorization.

# Inputs

- Approved `ReconstructionSpecification` and reconciled evidence ledger.
- Target project architecture and coding standards.
- REA MCP server or local ledger compiler.

# Workflow

1. Derive obligations: decompose each specified feature into discrete testable obligations.
2. Define case requirements:
   - Positive cases: expected successful flows.
   - Negative cases: validation errors and rejected inputs.
   - Edge cases: boundary values, empty lists, and long inputs.
   - Failure cases: recovery from network errors or malformed data.
3. Map evidence: bind each obligation to supporting evidence IDs from the original investigation.
4. Assign ownership: map obligations to planned file modules in the target project.
5. Compile obligation ledger: invoke REA's `build_reconstruction_obligation_ledger` tool or format compatible local ledger.
6. Await human confirmation: hold implementation until the user explicitly approves the reconstruction plan.

# Verification

- Every obligation has explicit positive, negative, and edge criteria.
- Target modules do not copy proprietary code or third-party proprietary assets.
- Ledger closure digest is computed and initial status is `unknown` or `partial`.

# Failure Modes

- Missing negative cases: defining only "happy path" requirements.
- Premature implementation: generating code before the plan is approved by the human operator.
- Unowned obligations: creating claims without assigning target file responsibility.

# Exit Criteria

- Clean-room implementation plan authored.
- Complete `ReconstructionObligationLedger` generated with unique obligation IDs.
- User authorization requested before mutation execution.
