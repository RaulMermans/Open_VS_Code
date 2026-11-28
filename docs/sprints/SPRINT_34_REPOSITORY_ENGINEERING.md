# Sprint 34 — Repository-aware software engineering

Date: 2026-11-28. Status: **INSTALLED `0.1.0-rc.35`.** Live lab on the installed binary passed smoke, stale-Continue 5/5, cancellation 3/3 + 3/3, and AUTO-CODE. Daily-driver and Personal V1 remain **NO-GO**. Fictional Workbench and Logsmith/Stockroom/Taskflow campaigns were not run on this package.

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

## 4. Not done (explicit)

- Workbench WB-01/02/03 frozen assignments under `~/ovsc-benchmarks`.
- Definitive Logsmith / Stockroom / Taskflow runs on installed production.
- Model Auto policy change (S35 still does not qualify either model).
- HALO Agent path (unchanged, BLOCKED).
- Historical REEPROV cleanup (proposal only; no deletes).
- Daily-driver / Personal V1 GO.

## 5. Production

```yaml
production:
  installed_version: 0.1.0-rc.35
  source_commit: d401aae5a98604700db45d5408b4d4f187287e0d
  git_dirty: false
  packaged_at: 2026-11-28T11:11:14.111Z
  package_sha256: 54bbff793dcb2495d4a6e001a2cf835273e304286970a3b78ca63cb9e46adda2
  installed_extension_sha256: 21e558d5dd4a10e8baa3f2dc3b654f4dd17d24c8fd02c64baabe3659f1ce68d6
  executable_path: /usr/bin/open-vs-code
  binary: /usr/lib/open-vs-code/open-vs-code
  chrome_sandbox: "4755 setuid root"
  provider: Direct Ollama
  resolved_model: qwen3-coder:30b
  auto_status_line: "Ready · Auto · qwen3-coder:30b · qwen3-coder:30b"
  rollback_deb: ~/.cache/ovsc-sprint34/open-vs-code_0.1.0-rc.34_amd64.deb
  rollback_command: sudo apt install --allow-downgrades ~/.cache/ovsc-sprint34/open-vs-code_0.1.0-rc.34_amd64.deb
live_lab:
  smoke: PASS (CONV-PING, LIFE-SANDBOX, LIFE-FIRST, LIFE-UPGRADE; LIFE-ROLLBACK PASS with OPEN_VS_CODE_ROLLBACK_DEB)
  CODE-CONTINUE-STALE: 5/5 PASS (run 2026-11-28T11-18-00-232Z)
  SAFE-CANCEL: 3/3 PASS (ack 6–113 ms)
  SAFE-CANCEL-APPROVAL: 3/3 PASS (ack 114–127 ms)
  AUTO-CODE: PASS (independent tests passed; Auto used qwen3-coder:30b)
```

LIFE-ROLLBACK's "Daily driver is 0.1.0-rc.35" is the lab's installed-version string, not a product GO.

## 6. Verdicts

| Gate | Verdict |
|---|---|
| Runtime safety | **GO** for installed stale-Continue 5/5 and Stop 3/3 + 3/3 on rc.35 |
| Repository-aware execution | **GO** deterministic; **BLOCKED** for installed Workbench / monorepo campaign |
| Atomic coding | Unchanged S35 **NO-GO** (AUTO-CODE is the small add.js fixture, not S35) |
| Greenfield application development | **BLOCKED** |
| Brownfield sprint engineering | **BLOCKED** |
| Monorepo engineering | **GO** deterministic; **BLOCKED** installed Workbench |
| Multi-sprint continuity | **BLOCKED** |
| Sustained autonomous execution | **BLOCKED** — no 90–120 minute installed run |
| Supervised engineering | **NO-GO** |
| Daily-driver readiness | **NO-GO** |
| HALO-managed inference | **BLOCKED** |
