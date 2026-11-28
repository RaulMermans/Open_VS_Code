# Sprint 34 — Repository-aware software engineering

Date: 2026-11-28. Status: **PACKAGING rc.35.** Source implements repository-aware verification and stale-Continue conflict protection. Installed production at the start of this packaging was `0.1.0-rc.34`. The unused version is **0.1.0-rc.35**. Installed-production live gates run after `sudo apt install` of that package.

## 1. Starting state (reconciled)

| Item | Observed 2026-11-28 |
|---|---|
| Checkout | `main` `96b951eb` (PR #124), CI green |
| Installed | `0.1.0-rc.34` (`dpkg` ok). Bundled `extension.js` SHA-256 `9c79d2be3faeb1c523ea34fb4f69d6aeaf3406f9a03cea9e0185d9e0d7190137` matches the Sprint 33B candidate. Payload SHA-256 `d1867ac2…` |
| Candidate `.deb` | `~/.cache/ovsc-sprint33b/open-vs-code_0.1.0-rc.34_amd64.deb` SHA-256 `754efcc4…` |
| Sprint 33B report | Said installed was still rc.30 and installation was blocked. The machine now has rc.34; historical evidence is preserved. |
| Ollama | `qwen3-coder:30b` `06c1097efce0`, `qwen3.6:35b` `a7eb95c53bcf` |
| S35 | Unchanged: coder 5/10×2, 3.6 8/10 and 7/10. Neither qualified. ADR-051 Auto order unchanged. |
| Frozen fictional | Logsmith, Stockroom SR-14, Taskflow Sprint 1. Logsmith candidate harness 2/26. |

## 2. Demonstrated root causes

1. **Package manager mismatch.** `discoverVerificationCommand` discovered pnpm/Corepack then always ran `npm run <script>`. A pnpm/Turborepo workspace can fail in tens of milliseconds. Discovery now selects `pnpm` / `yarn` / `npm` from `packageManager`, lockfiles, and workspace files, and uses that executable. Conflicts are `ENVIRONMENT_SETUP_REQUIRED`, not a silent npm fallback.
2. **Stale-Continue A2.** Continue aborted the whole run, or applied a model patch that deleted a user edit because the write preimage already matched the user-edited file. Continue now proceeds for unrelated files, protects overlapping files, and requires conflict-specific approval (`USER_EDIT_CONFLICT`). Deleted files still block. Restart recovery remains `BLOCKED_DIVERGENCE`.
3. **Completion integrity.** An exported-type change with no `typecheck` script could complete as applied. That is now `VERIFICATION_UNAVAILABLE`. The chat outcome line no longer pairs “Tests passed” with “Verification was not executed.”
4. **Sandbox oracle.** Chromium on this host may use the namespace sandbox. Linux acceptance now accepts namespace **or** setuid helper, still forbids `--no-sandbox`.
5. **Autocomplete.** Unqualified (median 733 ms). Default is now off (`open-vs-code.autocomplete.enabled`). During an Agent run, FIM is suspended.

## 3. What shipped in source

- Package-manager and monorepo cwd selection (`verification-discovery.ts`).
- Canonical verification failure classes on `VerificationResult.failureClass`.
- Compact repository engineering profile (manifests only) injected for substantial BUILD/DEBUG briefs.
- Execution profiles: small 15 / application 30 / engineering 60 / sprint 90 / extended 120 minutes (`open-vs-code.agent.executionProfile`, default engineering). Ceilings, not targets. Existing turn, repair, and non-progress limits remain.
- Benchmark workspace gate: harness-controlled `.ovsc-benchmark-registry.json`, `taskId`, origin match, symlink refusal.

Deterministic tests: 74 targeted tests pass, including package-manager fixtures, continue-stale conflict, lab benchmark registry, and conversation integrity.

## 4. Not done in this change (explicit)

- Packaged **rc.35** and installed-production acceptance.
- Stale-Continue 5/5 on the installed IDE.
- Cancellation 3/3 + 3/3 on the installed IDE.
- AUTO-CODE on the installed IDE.
- Workbench WB-01/02/03 frozen assignments under `~/ovsc-benchmarks` (fixtures in tests only).
- Definitive Logsmith / Stockroom / Taskflow runs on installed production.
- Model Auto policy change (S35 still does not qualify either model).
- HALO Agent path (unchanged, BLOCKED).
- Historical REEPROV cleanup (proposal only; no deletes).

## 5. Production

```yaml
production:
  installed_version: 0.1.0-rc.34
  source_commit: 7c8c205e990d9db0e87b485ac96d458d637aedd2
  current_source: 96b951eb plus Sprint 34 (unreleased)
  package_sha256: 754efcc4f69d24759e0af8c887d3eecd1d820a1bdb368d7ea7dd40609a2d2deb
  installed_extension_sha256: 9c79d2be3faeb1c523ea34fb4f69d6aeaf3406f9a03cea9e0185d9e0d7190137
  executable_path: /usr/bin/open-vs-code
  provider: Direct Ollama
  resolved_model: not re-measured this change
  next_package: 0.1.0-rc.35
  install_command: sudo apt install <path-to-rc.35.deb>
  rollback_command: sudo apt install --allow-downgrades ~/.cache/ovsc-sprint33b/open-vs-code_0.1.0-rc.34_amd64.deb
```

Interactive sudo is still required. Do not classify uninstalled rc.35 as production.

## 6. Verdicts

| Gate | Verdict |
|---|---|
| Runtime safety | **BLOCKED** — deterministic conflict protection is in source; installed 5/5 not run on rc.35 |
| Repository-aware execution | **GO** for deterministic selection; **BLOCKED** for installed-production proof |
| Atomic coding | Unchanged S35 **NO-GO** |
| Greenfield application development | **BLOCKED** — no installed fictional app run this sprint |
| Brownfield sprint engineering | **BLOCKED** |
| Monorepo engineering | **GO** deterministic; **BLOCKED** installed Workbench |
| Multi-sprint continuity | **BLOCKED** |
| Sustained autonomous execution | **BLOCKED** — profiles exist; no 90–120 minute installed run |
| Supervised engineering | **NO-GO** |
| Daily-driver readiness | **NO-GO** |
| HALO-managed inference | **BLOCKED** |
