---
name: repo-intake
description: Map an unfamiliar software repository before changing it. Use for first contact with a codebase, upstream source inspection, inherited projects, or any task where entry points, package boundaries, commands, generated areas, and architectural risks are not yet known.
---

# Repository Intake

Build a concise, evidence-backed repository map before proposing changes.

## Workflow

1. Confirm the repository root, revision, working-tree state, and license.
2. Inspect top-level metadata and tree depth before source files.
3. Read the README, contributor guidance, package/workspace manifests, and build configuration selectively.
4. Identify runtime and UI entry points, package boundaries, and dependency direction.
5. Extract documented build, test, lint, type-check, and development commands.
6. Locate tests near the relevant components and note their scope.
7. Search for architectural invariants in documentation and enforcement configuration.
8. Mark generated, vendored, build-output, secret-bearing, migration, and destructive-operation areas.
9. List candidate reusable components only when exact paths support the claim.

## Token discipline

- Start with metadata, workspace manifests, and a shallow tree.
- Search for names and symbols before opening files.
- Read only relevant headings and line ranges in large files.
- Never recursively dump the repository or load every Markdown file.
- Record findings once and use the map instead of repeatedly rereading sources.

## Output

Report:

- revision and license;
- architecture and package boundaries;
- relevant paths and entry points;
- build, test, lint, and development commands;
- important dependencies and external services;
- invariants, dangerous/generated areas, and risks;
- candidate reusable components and unresolved questions.

Separate observed facts from inferences and cite repository-relative paths for both.

