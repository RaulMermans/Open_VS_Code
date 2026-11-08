# Sprint 15 — Product acceptance lab

STATUS: IN_VERIFICATION

## Goal

A permanent live acceptance lab for the installed desktop, plus a closed loop on failures that the lab can actually reproduce. This is not a new agent framework.

## Architecture

Unchanged: one `AgentRuntime`, `Model Gateway`, IDE adapter, `PermissionGate`, review controllers, VSCodium shell.

The lab lives in `apps/desktop/acceptance/`. It launches `/usr/lib/open-vs-code/open-vs-code` with Playwright Electron, Chromium sandbox left on, `OPEN_VS_CODE_REAL_INFERENCE=1`, an isolated temp profile, and a disposable Git fixture. Approvals are refused unless the workspace is under the system temp directory and outside this repository.

## Protocol correction (source, not installed)

`normalizeWireResponse` now splits an unparsed `<tool_call>` / `<function=` envelope from assistant prose at the parse boundary. Prose such as `pong` is kept. An envelope with no remaining answer is `MALFORMED_RESPONSE`. Tests are in `packages/agent-core/tests/model/protocol.test.ts` (20 pass).

The installed package is still `0.1.0-rc.12` from `6417724105`. That binary still showed a stray `<tool_call>` in the 14C.1A pong screenshot. This correction is not in that package. It was not installed.

## Lab inventory

- 46 versioned scenarios in `apps/desktop/acceptance/catalog/v1/scenarios.json`
- Fixtures: `explain`, `bug`, `multifile`, `refactor`, `failing-test`, `injection`, `traversal`
- Commands: `npm run accept:lab` (unit + artifacts), `npm run accept:lab -- --live smoke`, `npm run accept:lab -- --live CONV-PING`

## Executed this session

| Id | Verdict | Notes |
| --- | --- | --- |
| SAFE-NO-SILENT | PASS | Approval helper rejects the product repository |
| SAFE-PROFILE | PASS | Live profiles and the product tree are refused |
| LIFE-UPGRADE | PASS | `dpkg` stayed `0.1.0-rc.12`; this session did not install |
| LIFE-ROLLBACK | PASS | `open-vs-code_0.1.0-rc.11_amd64.deb` is on disk |
| LIFE-SANDBOX | PASS | argv has no `--no-sandbox`; `chrome-sandbox` is `4755`; isolated `--user-data-dir` |
| LIFE-FIRST | PASS | Restricted Mode empty-state; composer; `qwen3-coder:30b` Ready |
| CONV-PING | FAIL | Tooling. Playwright Electron closes the workbench `Page` when the `vscode-webview://` OOPIF attaches. Send was not acknowledged. Ten consecutive cycles were not started. |

`NOT_RUN` for the other 39 scenarios is not a pass.

## CONV-PING classification

Cause: **tooling** (Playwright Electron vs VS Code webview OOPIF), not a model refusal.

Instrumented lifecycle (`webview-lifecycle.jsonl`): the guest loads `index.html`, then `fake.html` as `pending-frame`. About 20ms after the harness observes that guest, both frames detach and Playwright emits `window-closed` for `workbench.html`. Screenshots still show Restricted Mode, Ask, and `Ready · qwen3-coder:30b`. A detached frame is not a model failure.

The installed process is not treated as crashed. `app.windows()` later reports a window with the same webview UUID. Holding Playwright `Frame` objects and calling `contentFrame()` / inner locators is what loses the driver.

Harness fixes landed: send ack states, turn-correlated assistant text, explicit `.open-vs-code/` allowlist, shared-profile persistence path, approval waits for `#btn-approve`, required-screenshot errors, `--live` arg forwarding. Deterministic lab tests: 10 pass. Live Send is still blocked. Protocol `normalizeWireResponse` unit tests: 20 pass; that fix is not in rc.12. No package was installed.

## Release

No new Debian package. Daily driver remains `0.1.0-rc.12`. Rollback remains the rc.11 deb. See `docs/releases/V1_LIVE_ACCEPTANCE.md`.
