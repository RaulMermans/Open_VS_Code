# ADR-014: Metadata-First Skills & Prompt Primitives

## Status
Accepted

## Context
We needed to provide the existing agent with reusable procedural guidance ("Skills" / "Prompt Primitives") for common tasks (e.g., Bug Triage, Refactoring, Security Hardening) without bloating the context window or diluting project-specific facts in `Project Memory`.

## Decision
1. **Procedural Guidance:** Skills are reusable procedural guidance, stored as Markdown files.
2. **Project Memory Distinction:** Project Memory remains project-specific truth; skills are purely procedural.
3. **Metadata-First Discovery:** Discovery reads only the file frontmatter (`id`, `title`, `summary`, `modes`, `tags`, etc.) and estimates size. Full bodies are NOT loaded during discovery.
4. **Selective Loading:** `SkillSelector` selects at most 1 primary and up to 2 supporting skills based on mode and task text overlap.
5. **Token Budgeting:** A dedicated portion (15%) of the available context budget is allocated to skills. `SkillSelector` progressively scales down selected skills or omits them if they exceed the budget.
6. **No Capabilities:** Skills do not grant runtime capabilities (e.g., write access). The runtime permission system remains the sole authority.
7. **No Embeddings/Judge:** Selection is entirely deterministic. No embeddings, vector DB, or LLM judge is required.
