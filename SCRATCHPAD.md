# Scratchpad

- Current state: Sprint 4F COMPLETE — OPEN VS CODE V1 DESKTOP CANDIDATE (HALO Acceptance Gate Pending)
- Accomplishments (Sprint 4F):
  - Selected and pinned upstream desktop host: Audited Code-OSS vs VSCodium across 10 dimensions; selected pinned VSCodium distribution (`1.135.06055`, VS Code `1.135.0`, commit `5a73682ca091082675b10c9dc3f348c1d824d94f`, MIT license). Documented in `ADR-028` and `DECISIONS.md`.
  - Preserved extension-first boundary: Maintained strict decoupling: Desktop shell -> bundled extension -> IDE adapter -> agent core -> local/external inference. Editor internals remain un-forked.
  - Created packaging workspace (`apps/desktop`): Implemented `@open-vs-code/desktop` package with `upstream.json` (SHA-256 verified), `scripts/prepare.ts`, and `scripts/package.ts`.
  - Configured identity & branding: Product name "Open VS Code", bundle identifier `com.openvscode.desktop`, isolated config directory `.open-vs-code-desktop`, telemetry permanently hard-disabled (`enableTelemetry: false`).
  - Pre-installed bundled extension: Integrated `@open-vs-code/vscode-integration` directly into `Contents/Resources/app/extensions/open-vs-code` for zero-marketplace discovery on first launch.
  - Hardened first-run & offline grace: Added `open-vs-code.createStarterConfig` and `open-vs-code.openModelConfig` commands and exported `STARTER_MODELS_JSON` template. Missing config or offline endpoint does not crash or break editor.
  - Implemented macOS packaging pipeline: Built temp-directory assembly, macOS extended attribute stripping (`xattr -cr`), ad-hoc codesigning (`codesign --force --deep --sign -`), CLI launcher symlink `bin/open-vs-code`, and gzip tarball packaging.
  - Evaluated automated smoke tests: 11/11 tests pass deterministically in `apps/desktop/smoke/desktop-smoke.test.ts`. Full monorepo regressions 100% clean.
  - Documented cross-platform roadmap & HALO runbook: Created `apps/desktop/PORTABILITY.md` and `docs/deployment/HALO_ACCEPTANCE.md`.

Next:
Sprint 4F complete. Ready for operator-managed HALO target inference host acceptance run (`OPEN_VS_CODE_REAL_INFERENCE=1 npm run eval:models`) on authorized hardware with installed model weights.
