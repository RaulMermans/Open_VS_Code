# Scratchpad

- Current state: SPRINT 5A COMPLETE — PORTABLE SKILLS RUNTIME VERIFIED (deterministic). V1 Desktop Candidate still gated only on HALO target-host acceptance.
- Sprint 5A summary:
  - New `packages/agent-core/src/skills/` (contracts, schema, registry, selector, runtime), five built-ins in `packages/agent-core/skills/builtins`, ADR-029, guide `docs/skills/SKILLS.md`.
  - Flag `skills.enabled` defaults off; off = frozen ADR-014 `.agents/skills` path, unchanged.
  - Selection eval 38/40. The misses are kept untuned on purpose (S03 "TypeError thrown" has no trigger word; S34 "refactor; tests currently fail" picks refactor-with-guards in BUILD).
  - Context: eager 2530 vs lazy 332.1 average tokens (−86.9%).
- Defects found and fixed during 5A:
  - Frozen ADR-014 `discoverSkills` made skill paths relative to the non-realpath workspace root, so workspaces reached through a symlink (e.g. macOS `/var` → `/private/var`) crashed `loadSkill` with OUTSIDE_WORKSPACE. It now relativizes against the realpath root (covered by `skill-runtime-integration.test.ts`).
  - `desktop:accept` launched the packaged app with the inherited environment; `ELECTRON_RUN_AS_NODE` from an editor terminal made the binary start as Node. The harness now strips `ELECTRON_*`/`VSCODE_*`.
  - The committed `package-lock.json` lacked the `apps/desktop` workspace, so `npm ci` failed; it is now resynced.
- Next: HALO acceptance, then the same-model skills A/B (off vs `--skills`); then Sprint 5B.
