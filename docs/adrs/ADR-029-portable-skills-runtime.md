# ADR-029: Portable Skills Runtime

## Status
Accepted (Sprint 5A). Feature-flagged **off** by default until the HALO same-model A/B benchmark is recorded. Partially supersedes ADR-014: the ADR-014 path is frozen as the flag-off behaviour.

## Context
ADR-014 introduced metadata-first skills under `.agents/skills/`. It works, but for V1.1 reliability on small local models it has gaps:

- loose frontmatter: unknown keys and malformed values are accepted silently, and `tools` is diagnostic only;
- no distinction between curated skills shipped with the product and untrusted skills living in a workspace;
- skill bodies are injected as **required** context, so an oversized skill fails compilation (`REQUIRED_CONTEXT_OVERFLOW`) and is ranked as if it outranked active code;
- up to three skills (one primary, two supporting) can be injected, chosen by text overlap with no ambiguity handling;
- no feature flag, so its effect cannot be A/B-measured.

ECC (`affaan-m/ECC`) and the wider "agent skills" pattern informed the design: a short `name`/`description` index used for selection, with the Markdown body read only on demand. We took the principles, not the content; ECC's skills are broad and long, which suits frontier models but not 7B-class local models.

## Decision

1. **One canonical format.** `SKILL.md` = strict YAML-subset frontmatter + Markdown body with seven required level-1 sections: Intent, When to Use, Inputs, Workflow, Verification, Failure Modes, Exit Criteria. Schema: `config/schemas/skill.schema.json`, enforced by `packages/agent-core/src/skills/schema.ts` (tests keep the two in sync).
2. **Two sources, explicit precedence.** Built-in (curated, `packages/agent-core/skills/builtins/<id>/SKILL.md`, shipped inside the extension) and workspace (`.open-vs-code/skills/<id>/SKILL.md`, untrusted). Directory name must equal the id. A workspace skill with a built-in's id replaces it **only if** it validates **and** narrows: capabilities, allowed modes and required tools must be subsets, and risk level and context budget must not increase. Otherwise the built-in stays and a diagnostic is recorded.
3. **Workspace trust.** Workspace skills are indexed only for trusted workspaces. Paths are resolved via `resolveRepositoryPath` (realpath containment) at index time **and** again at load time.
4. **Metadata first, body lazily.** `SkillRegistry.discover` reads each file's size and frontmatter prefix only. `loadBody(id)` reads, re-validates (metadata must equal the indexed metadata; body safety and sections) and caches. Unselected bodies never leave disk.
5. **Deterministic selection; no skill is valid.** `selectSkill` filters by mode, by tools actually registered, and by asking the existing `classifyPermission` whether each declared capability is denied in the active mode. It then scores trigger phrases (weight 3) plus bounded description overlap, with a threshold of 3. Exact ties between unrelated skills select nothing. `skill:<id>` in the task is an explicit request. Default maximum is 1 skill, hard cap 2, and the second skill is only allowed through the primary's `composes_with`. No model call, embeddings or learned ranking.
6. **Budget integration.** Guidance is **optional** context (`required: false`), ranked after `active-code` and before retrieved code, observations and background. Required items (instructions, task, memory facts, acceptance criteria) are always admitted first, so a skill can never displace them. Per-skill cap = `min(context_budget, 15% of available context, headroom after required context)`. Oversized bodies shrink by dropping whole sections in reverse priority (Inputs → Failure Modes → When to Use); if the core (Intent, Workflow, Verification, Exit Criteria) does not fit, the skill is not injected (`FAILED_BUDGET`). Frontmatter is never injected.
7. **Guidance, not authority.** Skill text is wrapped in a runtime-authored frame stating it cannot grant tools or permissions, alter approvals or verification, change routing, or replace the task. Bodies containing authority-override directives, secret-like values or executable markup are rejected at load. Skills never touch the tool registry, PermissionGate, routing configuration or HALO provider.
8. **Bounded evidence.** `SkillEvidence` records candidate ids, selected id/version/source, reason code, load status, token counts, section names, rejection reasons and diagnostic codes. It never stores task text, prompts, code or bodies.
9. **Feature flag.** `CreateAgentRuntimeOptions.skills.enabled` (CLI `--skills` / `OPEN_VS_CODE_SKILLS=1`, VS Code `open-vs-code.skills.enabled`), default `false`. Off: the ADR-014 path runs exactly as in V1. On: the portable runtime replaces it. The two are never active together.
10. **Seed set.** Five curated built-ins: `bug-triage`, `tdd`, `refactor-with-guards`, `security-review`, `verification`. No automatic skill creation.

## Consequences
- Small models see at most one compact (~450–560 token) skill instead of several; a deterministic benchmark measures an 86.9% average reduction against eager injection of all seed bodies.
- Malformed or hostile skills degrade to "no skill" with diagnostics; they cannot crash the agent or widen its authority.
- `.agents/skills` remains readable only through the frozen ADR-014 path. Migrating a legacy skill means rewriting it to the strict contract under `.open-vs-code/skills/`.
- The unsafe-directive scanner is defense in depth with known false-negative risk (paraphrase). The structural guarantees (tool registry, PermissionGate, confirmation flow, routing) are the actual boundary.
- Real-model impact is unmeasured until HALO is provisioned (`DEFERRED_TO_HALO`).

## Out of scope (later V1.1 sprints)
Automatic skill generation, learned ranking, multi-skill chains or composition graphs, a remote registry or marketplace, a skill editor, model-assisted selection.
