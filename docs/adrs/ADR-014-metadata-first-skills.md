# ADR-014: Metadata-First Skills & Prompt Primitives

## Status
Accepted. Frozen by [ADR-029](ADR-029-portable-skills-runtime.md) (Sprint 5A): this path is the `skills.enabled = false` behaviour and receives no new features; the Portable Skills Runtime replaces it when enabled.

## Context
We needed to provide the existing agent with reusable procedural guidance ("Skills" / "Prompt Primitives") for common tasks (e.g., Bug Triage, Refactoring, Security Hardening) without bloating the context window or diluting project-specific facts in `Project Memory`.

## Decision
1. **Canonical Root:** `.agents/skills/` is the authoritative, canonical root for all production skills.
2. **Procedural Guidance:** Skills are reusable procedural guidance, stored as Markdown files. Project Memory and runtime safety outrank Skills.
3. **Metadata-First Discovery:** Discovery reads only the file frontmatter and estimates size. Full bodies are NOT loaded during discovery.
4. **Selective Loading & Task Relevance:** `SkillSelector` selects at most 1 primary and up to 2 supporting skills based on task text overlap. A mode match alone is insufficient; explicit task relevance is required. If no skill matches, the system functions seamlessly without any skill loaded (no-skill runtime behavior).
5. **Token Budgeting:** A dedicated portion of the context budget is allocated. Selected skills load targeted sections (Intent, Procedure, etc.), and actual compiled sizes enforce the strict budget, progressively scaling down (S3 -> S2 -> S1) or omitting if exceeded. We assert actual compiled token-budget enforcement, not just the selector's estimate.
6. **Legacy Skill Policy:** Legacy skills (`repo-intake`, `upstream-audit`, `change-with-tests`) are discoverable only by explicit request (e.g. naming them in the task) and are excluded from automatic selection.
7. **No Capabilities:** Skills do not grant runtime capabilities (e.g., write access). The runtime permission system remains the sole authority. The `tools` frontmatter field is diagnostic only and does not escalate capabilities.
8. **No Embeddings/Judge:** Selection is deterministic (local-first only). No embeddings, vector DB, or LLM judge is required.
9. **Provenance:** Loaded skill provenance is fully retained through CLI diagnostics and context compiler items, preserving the selected IDs, the loaded sections, deterministic reason codes (e.g. `tag_overlap`, `text_overlap`), and actual compiled token counts.
10. **Evaluation Strategy:** We maintain both a *Deterministic Skill Selector Unit Corpus* (synthetic fixtures covering exactly 28 cases) and a *Real On-Disk Skill Catalog* integration test that asserts real loading, CLI output, missing-metadata handling, and budget degradation on the physical `.agents/skills` repository path.
