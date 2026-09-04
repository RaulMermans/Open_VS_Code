# ADR-014: Metadata-First Skills & Prompt Primitives

## Status
Accepted

## Context
We needed to provide the existing agent with reusable procedural guidance ("Skills" / "Prompt Primitives") for common tasks (e.g., Bug Triage, Refactoring, Security Hardening) without bloating the context window or diluting project-specific facts in `Project Memory`.

## Decision
1. **Canonical Root:** `.agents/skills/` is the authoritative, canonical root for all production skills.
2. **Procedural Guidance:** Skills are reusable procedural guidance, stored as Markdown files. Project Memory and runtime safety outrank Skills.
3. **Metadata-First Discovery:** Discovery reads only the file frontmatter and estimates size. Full bodies are NOT loaded during discovery.
4. **Selective Loading & Task Relevance:** `SkillSelector` selects at most 1 primary and up to 2 supporting skills based on task text overlap. A mode match alone is insufficient; explicit task relevance is required.
5. **Token Budgeting:** A dedicated portion of the context budget is allocated. Selected skills load targeted sections (Intent, Procedure, etc.), and actual compiled sizes enforce the strict budget, progressively scaling down (S3 -> S2 -> S1) or omitting if exceeded.
6. **Legacy Skill Policy:** Legacy skills are discoverable only by explicit request and are excluded from automatic selection.
7. **No Capabilities:** Skills do not grant runtime capabilities (e.g., write access). The runtime permission system remains the sole authority.
8. **No Embeddings/Judge:** Selection is deterministic (local-first only). No embeddings, vector DB, or LLM judge is required.
