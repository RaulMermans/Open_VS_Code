# ADR-048: Observation registry (ALREADY_OBSERVED), objective-first routing, completed renames

Status: Accepted (Sprint 25, 2026-11-17)

## Context

A real engineering request (HALO VC-02) stopped with `NON_PROGRESS: list_directory was refused 4 times`,
no files changed and no tests run. Reproduced on rc.24 (`453c3a2a0c`) with the exact instruction:
Qwen3-Coder 30B failed 3/3 the same way; Qwen3.6 35B failed 2/3 the same way. Causes, in order:

1. Routing. Any mention of `AGENTS.md`, "rules" or "conventions" made the task `RULES_QUERY`, whose only
   strategy is "read AGENTS.md". Every `.md` the brief named (including files it said to *read*) became a
   required edit target, so the runtime told the model to "create or update AGENTS.md, CLAUDE.md".
2. Duplicate lookups were refused (`DENIED`, `EDIT_REQUIRED`) without returning the earlier result, and each
   refusal counted toward the 4-refusal stop.
3. The context compiler keeps the 6 most recent distinct observations. Repeated reads and refusals pushed the
   directory listing out, so the model could not see what it had listed and was refused when it asked again.
4. Listings, searches and file finds dropped their `truncated` flag before reaching the model.

## Decision

1. **Observation registry** (runner, task-scoped). Successful `list_directory`, `find_files`, `search_text`,
   `find_symbol` results are kept by signature (tool + normalized arguments). A repeat returns the earlier
   result marked `ALREADY_OBSERVED` (outcome `COMPLETED`, `alreadyObserved: true`): not a refusal or failure,
   no filesystem call. `read_file` is re-read and compared, so a file changed outside the agent is always
   read fresh. The registry is cleared on any applied write or command. Failed, refused and denied lookups
   are never stored. Bound: one full replay, then brief answers that count toward the existing
   repeated-refusal limit (stop message: "repeated N times ... returned no new information"). When the
   opt-in direct progress guard is enabled it keeps owning repeated reads.
2. **Observed index** (context compiler). Successful lookups that fall out of the recent window stay listed,
   one line each (call, first line of the result, size), with "repeat the exact call to get one back".
   Required, at most 30 lines. Failures and replays are excluded.
3. **Incomplete results are stated**: `[Incomplete: only the first N entries of M are shown. ...]`, with how
   to narrow (adapted from SWE-agent's ACI search feedback).
4. **Objective-first routing**. `RULES_QUERY` only when no code change is requested. A multi-part brief
   (3+ headed sections, or >1,500 characters with 5+ listed items) that asks for changes is
   `IMPLEMENTATION`: explore, read rules once, change, verify, report blocked parts. Paths in a clause that
   starts with read/inspect/review/consult/study/see are context, not required edits, unless an edit verb
   names them.
5. **Completed renames** (P1). An applied `rename_symbol` is recorded for the task. A later `rename_symbol`
   or `find_symbol` on the old name in a renamed file answers `ALREADY_SATISFIED` (no mutation, no approval)
   only while the file shows the rename (old identifier absent, new present); otherwise it runs normally.

## Not done

- Aider RepoMap (tree-sitter + personalized PageRank, Python with networkx/grep_ast/diskcache): not ported.
  Evaluation did not show file discovery as the limiting factor once the loop was fixed.
- Gemini CLI loop detection: no code copied. Its design (hash of tool name + arguments; a repeat threshold;
  a recorded loop type) matches what the runner already had; per-signature replay counts with a reset on
  workspace change cover its k-cycle case here, because each signature in a cycle accumulates its own count.
- Listings and searches are not re-validated against edits made outside the agent mid-task (reads are).

## Provenance

SWE-agent `3ea751c087f3` (MIT): `tools/search/bin/search_dir`, `search_file`, `find_file` feedback. Gemini
CLI `4fa64e71b9b4` (Apache-2.0): `packages/core/src/services/loopDetectionService.ts`. Aider
`5dc9490bb35f` (Apache-2.0): `aider/repomap.py`. Anthropic, "Writing effective tools for agents" and
"Effective context engineering for AI agents". Ideas adapted; no upstream source copied.
