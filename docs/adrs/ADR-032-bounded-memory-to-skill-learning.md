# ADR-032: Bounded Memory-to-Skill Learning

## Status
Accepted (Sprint 5D, 2026-10-15). Feature-flagged **off** by default (`learning.enabled`) until the HALO same-model benchmark is recorded. Guide: [`docs/learning/LEARNING_SYSTEM.md`](../learning/LEARNING_SYSTEM.md).

Amends ADR-031 with **progress epochs** (Sprint 5C closure, recorded in ADR-031).

## Context
Sprints 5A–5C produce compact, verified evidence for every task: VERIFY verdicts, test-repair and review-repair counts, review findings, and settled non-progress recoveries. None of it outlives the task. Each new run starts with only the hand-written Markdown memory (ADR-005) and the curated skills (ADR-029).

Continuous-learning systems such as ECC's `continuous-learning-v2` (`affaan-m/ECC`, MIT) close that gap with hook-captured observations, a background observer, confidence-scored "instincts", and an `/evolve` step that turns instincts into skills. We adopt four of its ideas:

- atomic learning records;
- project scope by default;
- an explicit evidence section per record;
- an explicit promotion step.

We reject the rest:

- prompt and tool-call capture (it would be a transcript);
- the background observer daemon;
- decimal confidence scores (opaque);
- model-written instincts that are trusted on arrival.

Classification: **REFERENCE_ONLY**. No code or text was copied.

## Decision
1. **A bounded pipeline, not a loop.** The pipeline runs observe → classify → dedupe/accumulate → candidate → **human review** → approved memory, or a learned `SKILL.md`. The system may propose. It never promotes, and it never edits its own prompts or capabilities.
2. **Evidence first.** A `LearningObservation` exists only when a deterministic extractor sees a pattern in a terminal task's artifacts:
   - workflow `retryCounts` with VERIFY READY or a recorded blocker;
   - settled 5C recovery outcomes;
   - `BLOCKED_NON_PROGRESS` reports;
   - passing verification commands;
   - lockfiles.

   Every observation carries evidence references such as `workflow:<id>#VERIFY` or `file:pnpm-lock.yaml`. A model statement is not evidence: a `MODEL_PROPOSAL` without evidence is rejected, and a model-drafted skill must point at a promotable record.
3. **Trust by source.**
   - `USER_DECISION` (an explicit command) is APPROVED on arrival and supersedes an earlier decision on the same subject.
   - `OBSERVED_OUTCOME` earns trust only through repeated, independent evidence.
   - `REPOSITORY_TEXT` is stored as an untrusted observation at most. It is never a candidate and never approvable.
   - Text that claims authority is rejected from any source. This uses the 5A unsafe-directive patterns plus learning-specific grant patterns ("may always run shell commands", "no approval needed").
4. **Thresholds (the "one lucky task" invariant).** Independence means distinct task ids; the same task never counts twice.
   - 1 occurrence → OBSERVED.
   - 2 independent successes (more successes than failures) → CANDIDATE.
   - A skill proposal needs ≥ 3 independent successes, ≥ 3 distinct tasks, and a support ratio ≥ 0.75.
   - At least 2 failures, with failures ≥ successes, makes the record STALE (contradicted).
5. **Scope.** Facts, decisions and project patterns are PROJECT. A pattern is REUSABLE only if it names no path, file, version, toolchain or "this repo" and depends on no workspace path; otherwise it is demoted to PROJECT_PATTERN. Only REUSABLE records with a recognised pattern template can be proposed as skills. Project records carry the project id, and retrieval never crosses projects.
6. **Dedupe and bounds.**
   - Dedupe uses the pattern key, then a normalised token key (stopwords, a small synonym map, light stemming), then Jaccard ≥ 0.6 within the kind group. No embeddings.
   - Caps: 100 project records, 50 reusable records, 20 candidates and 200 rejection fingerprints. Eviction removes STALE, then REJECTED, then the weakest OBSERVED. APPROVED and CANDIDATE records are never evicted to make room; a new record is dropped instead.
7. **Skill candidates are an intermediate representation** (`LearnedSkillCandidate`), validated fail-closed before review and again at approval:
   - capabilities ⊆ the 5A vocabulary ∩ the learned ceiling (`read`, `search`, `write`, `verify`; never `terminal`);
   - tools ⊆ `KNOWN_SKILL_TOOLS`;
   - modes ⊆ the known modes;
   - the id must not collide with a built-in or overwrite a user-authored workspace skill;
   - the rendered `SKILL.md` must pass the exact 5A `validateSkillMetadata` + `validateSkillBody` (unsafe directives, secrets, executable markup, required sections).

   Any violation sets the candidate to REJECTED with a reason.
8. **Human approval gate.** Only an explicit `approve` writes a learned skill: CLI `learning approve <id>`, or the VS Code command *Open VS Code: Review Learning Candidates* (a modal; dismissal does nothing). It is written to `.open-vs-code/skills/<id>/SKILL.md` in a trusted workspace. The skill is then an ordinary workspace skill: lazily loaded, `skills.enabled`-gated, PermissionGate-checked. An update needs its own candidate and approval. Before the update, the generated file must match its recorded hash (no silent overwrite of hand edits), the previous version is archived under `.open-vs-code/learning/history/<id>/v<N>.md`, and the version is incremented. Built-ins are never on a writable path.
9. **Provenance outside the canonical format.** The 5A schema rejects unknown fields, so `source: learned` is not added to the frontmatter. `LearnedSkillProvenance` in the learning store records the skill id, version, candidate, record, supporting task ids, evidence, approval time, content hash and history.
10. **Rejection memory.** A rejected record or candidate is stored as a compact fingerprint with its success count at rejection. The same proposal is suppressed until at least 3 more independent successes arrive.
11. **Staleness.** A record goes STALE when:
    - a file in `relevantPaths` is missing (e.g. a lockfile after a toolchain change);
    - evidence repeatedly contradicts it;
    - the user supersedes the decision;
    - `markStale` is called.

    STALE records are kept as history and never retrieved.
12. **Retrieval is approved-only and budgeted.**
    - `retrieve` considers APPROVED, non-stale records of this project. Decisions and toolchain facts are always eligible; other records need task-token or path overlap.
    - Records are ranked by overlap, path, mode, kind, confidence and recency, then filled to **10% of the available context**.
    - The compiler adds them as the optional `learned-memory` source. It ranks after the selected skill and before retrieved code, observations and background, so it can never displace the task, instructions, acceptance criteria or active code.
    - Workflow stages receive the same items appended to the memory digest.
13. **Learning never blocks a task.** `runLearningStep` runs after the task's result is final, catches every error and returns it as data. A store that fails to parse is never overwritten. Direct-path learning is conservative: ASK/PLAN/REVIEW and ordinary successful runs teach nothing; only settled recoveries and non-progress blockers count.
14. **Privacy.** Every persisted string passes `sanitizePersistedText`, the 5B/5C boundary: the canonical redactor plus reasoning-block stripping. Strings are then field-bounded. The store holds no transcript, prompt, source code or raw log. Writes are atomic and contained to `.open-vs-code/learning/` and `.open-vs-code/skills/`, using the existing realpath/symlink containment.
15. **Feature flag.** `learning.enabled` defaults to `false`: CLI `--learning` / `OPEN_VS_CODE_LEARNING=1`, VS Code `open-vs-code.learning.enabled`. When off, nothing is extracted, stored, proposed or retrieved, and prompts are byte-for-byte unchanged. Previously approved learned skills remain ordinary workspace skills under the existing skills settings.

## Consequences
- Deterministic evaluation (`npm run eval:learning`):
  - 10/10 contract fixtures and project-vs-reusable classification 16/18; the two misses are unmarked project lessons, kept as measured;
  - dedupe 45/45 pair decisions; candidate precision 100% (2/2); 0/3 false promotions;
  - 0/6 malicious repository texts trusted; 9/9 escalation candidates rejected.
- Token impact: 12 tasks store 2,615 tokens of structured records, against an estimated ≥ 20,374 tokens of transcript (−87.2%). An average of 143 tokens per prompt is retrieved, against a 650-token budget.
- The pattern library is small and curated: repair against the failing assertion, resolve a grounded review finding, and 5C recovery patterns. Lessons outside it can become approved memory, not skills. This is deliberate: low volume beats low-quality learning.
- Whether approved learning makes a real model better is unmeasured: **DEFERRED_TO_HALO** (arm E of the V1.1 benchmark contract, `docs/evals/V1_1_BENCHMARK.md`).
- Discovered, not changed: the direct `AgentRunner` never forwarded the ADR-005 Markdown `memory` selection to its compiler; only the workflow's memory digest used it. Learned memory therefore has its own explicit runner field. Changing the legacy memory path is out of scope.
- Out of scope: autonomous skill rewriting, global-memory promotion, built-in skill modification, prompt mutation, background daemons, fine-tuning/LoRA/embeddings, cloud escalation, model downloads, executable learned plugins, marketplaces or dashboards.
