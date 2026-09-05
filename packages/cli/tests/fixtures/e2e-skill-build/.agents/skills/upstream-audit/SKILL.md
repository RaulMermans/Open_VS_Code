---
name: upstream-audit
description: Evaluate an open-source repository or component before reuse. Use whenever considering a fork, dependency, code extraction, pattern adoption, or upstream baseline so licensing, coupling, maintenance, portability, baggage, and exact source evidence are assessed first.
---

# Upstream Audit

Evaluate the smallest useful component, not merely the repository as a whole.

## Prerequisite

Run `repo-intake` first or obtain an equivalent repository map. Pin the inspected revision and record the source URL.

## Classification

Assign one outcome per component:

- `KEEP`: retain substantially as provided and track upstream.
- `ADAPT`: retain structure but make bounded changes behind maintained seams.
- `EXTRACT`: copy or split the smallest coherent component with provenance.
- `REFERENCE_ONLY`: learn the pattern without copying implementation.
- `REJECT`: do not reuse; state the disqualifying reason.

Use `UNKNOWN` only when evidence is unavailable, and list the exact evidence needed.

## Evaluation

For each candidate:

1. Verify the repository and relevant file licenses; note attribution or distribution duties.
2. Identify exact functionality and source paths.
3. Trace entry points, dependencies, package boundaries, and host/framework coupling.
4. Find relevant tests and estimate behavioral coverage from evidence, without inventing a percentage.
5. Check maintenance signals at the pinned revision: release/commit recency, active branches or issues when available.
6. Identify cloud, account, telemetry, billing, marketplace, or unrelated product baggage.
7. Estimate extraction difficulty and portability to the target architecture.
8. Compare a fork, dependency, selective extraction, and clean reimplementation.

Prefer a smaller clean extraction when a whole subsystem would import unrelated baggage. Preserve notices, commit identifiers, and license requirements for any copied or adapted code.

## Report

Include a decision table with component, classification, exact paths, rationale, dependencies, license implications, risks, and next verification step. Distinguish facts from recommendations.

