# Canonical starting-code strategy

## Recommendation

Choose **Option A: a controlled fork of Kilo Code**, pinned first to audited commit `91a337e31cd7675d680aeb13c92870b8f81bdf36`.

“Controlled” means the first import preserves provenance, licenses, history, upstream build tooling, and tests, while a local-first product profile prevents cloud, telemetry, remote-session, marketplace, and multi-agent surfaces from entering the early reachable product. Do not start by rewriting or physically pruning intertwined packages; establish a known-good upstream build first, then isolate dependencies through small tested changes.

## Option comparison

| Criterion | A: controlled Kilo fork | B: extract Kilo packages | C: thin shell around Kilo/Cline | D: new architecture |
| --- | --- | --- | --- | --- |
| Shortest path to working IDE | Best: integrated extension, backend, UI, tools, diffs, autocomplete | Poor initially: package graph must be reconstructed | Medium/poor: two runtimes and protocols must be reconciled | Poor: reimplements integration work |
| Future maintainability | Medium: large repo, but Kilo has explicit OpenCode merge automation and tests | Potentially high after a costly, risky extraction | Low: duplicated provider/session/tool concepts and cross-upstream breakage | Unknown and evidence-light |
| Remove cloud dependencies | Medium: seams are visible but currently reachable from manifests/startup | Best eventual shape, highest initial breakage risk | Medium: shell can omit services, dependencies still transitively present | High in theory, with large implementation cost |
| Local-model-first fit | Good: Ollama, LM Studio, and OpenAI-compatible local endpoints are documented | Good if provider layers are extracted correctly | Good, but configuration semantics diverge | Unknown until built |
| Editor-independent core | Good: VS Code connects to a separate CLI/server; core runtime has no `vscode.*` dependency | Excellent target shape, but active logic spans packages | Good in Cline SDK; integration with Kilo UI is unproven | Must be designed and built |
| Future Code-OSS path | Good: extension-first now; adapter can later host inside a distribution | Good | Medium | Unknown |
| License | Root MIT; preserve MIT plus Apache-2.0 Continue attribution | Same obligations, with harder provenance tracking | Apache-2.0 Cline plus Kilo obligations | New code only, but loses mature reuse |
| Upstream burden | High but explicit and tooled | High: selective ports become manual | Highest: track Kilo and Cline simultaneously | No upstream merges, but maximum owned code |

## Why not extract immediately

The shipped loop is centered in `packages/opencode`, not solely in the smaller `packages/core`. It composes Kilo-specific memory, gateway, indexing, telemetry, MCP, session, provider, and UI/runtime services. Extracting before an upstream smoke checkpoint would make failures hard to attribute and discard Kilo's own merge/test machinery.

## Why Cline is not the initial core

Cline's current SDK is an excellent architectural comparator: its published `@cline/agents` stateless loop, `@cline/llms` provider layer, and `@cline/core` stateful runtime align closely with ADR-003/004. Replacing Kilo's backend with it now would nevertheless require a new transport, event, tool, permission, checkpoint, configuration, and UI integration layer. Re-evaluate Cline after the Kilo baseline is running offline and cloud coupling is measured.

## Guardrails for T-006 through T-008

1. Import/fork with history and pin the audited revision; preserve `LICENSE` and `packages/kilo-vscode/THIRD_PARTY_LICENSES/`.
2. Keep Bun for the first upstream smoke. A pnpm migration needs a separate evidence-backed decision.
3. Establish the exact upstream install, type-check, unit-test, and isolated-extension smoke before removals.
4. Add an offline/local-only configuration and a network-observation smoke test.
5. Disable telemetry, session export, account/gateway defaults, cloud sessions, and marketplace entry points before deleting implementation.
6. Keep Agent Manager/worktree orchestration out of the early product surface.
7. Carve a stable host adapter around the backend protocol; do not let new code import `vscode.*` outside the IDE package.
8. Reassess package extraction only after tests reveal the actual minimal dependency closure.

## Revisit triggers

Switch from Option A to a Cline-based or extracted core only if the known-good Kilo fork cannot run fully offline without invasive changes, upstream merge machinery dominates ongoing work, or the backend protocol cannot support the editor-independent invariants without Kilo cloud services.

