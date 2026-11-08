# V1 live acceptance — release-readiness

Date: 2026-11-08

**Gate: FAIL.** Open VS Code is not promoted. The installed daily driver was not replaced.

## Build under test

- Installed: `open-vs-code` `0.1.0-rc.12`
- Source of that package: `6417724105`
- Working tree at the lab: `sprint/14-daily-driver-stabilization` (later commits are documentation plus the lab and a protocol parse fix that is **not** in the installed binary)
- Sandbox helper: `/usr/lib/open-vs-code/chrome-sandbox` mode `4755` `root:root`
- Local models present: `qwen3-coder:30b`, `qwen2.5-coder:7b`, `qwen2.5:7b`
- Rollback on disk: `apps/desktop/dist/open-vs-code_0.1.0-rc.11_amd64.deb`

## Gate checklist

| Gate | Result | Evidence |
| --- | --- | --- |
| Critical security tests 100% | FAIL | Chat, Ask-readonly, injection, traversal, and approval journeys were not completed live. Unit guards for silent approval and live profiles passed. |
| No unauthorized writes / false completion | NOT EXECUTED on the installed GUI | Lab refuses product-repo approvals. Coding oracles were not run against the GUI. |
| Held-out coding ≥ 90% | NOT EXECUTED | `CODE-*` remained `NOT_RUN` |
| Critical GUI journeys | FAIL | `LIFE-SANDBOX` and `LIFE-FIRST` passed. `CONV-PING` failed. Wider chat, history, and model persistence were not completed. |
| No uncontrolled protocol leakage | FAIL on installed rc.12 | 14C.1A screenshot still showed `<tool_call>` after `pong`. Source now drops that envelope in `normalizeWireResponse`. That code is not installed. |
| Packaging / sandbox | PASS for the installed binary | Lab argv had no `--no-sandbox`; helper mode `4755` |
| Profile and history recoverable | NOT EXECUTED | Lab uses temp profiles only. Live `~/.config/Open VS Code` was not opened. |
| Package from a clean identified commit | The installed package is | Source now has uncommitted lab work. No new `.deb` was built. |
| Rollback available | PASS | rc.11 deb present; lab did not install it |

## What already works (observed)

- Installed app launches with the Electron sandbox.
- An untrusted fixture shows Restricted Mode, Ask, and a global `qwen3-coder:30b` route without writing `models.json`.
- Ollama is reachable. The composer shows `Ready · qwen3-coder:30b`.
- Earlier 14C.1A pong on this same package produced a model reply (with protocol leakage). That is not a substitute for CONV-PING in this session.

## Remaining limitations

- Playwright cannot currently keep the Agent webview frame attached long enough to Send. That blocks the rest of the live catalog.
- Protocol leakage is fixed in source only.
- Local 30B quality vs a proprietary frontier model was not re-measured here.
- Streaming is still not enabled.
- This report does not claim daily-driver parity with Cursor.

## Commands

```text
npm run accept:lab
npm run accept:lab -- --live smoke
npm run accept:lab -- --live CONV-PING
```

Evidence directories: `apps/desktop/acceptance/evidence/`. Latest machine-written summary: `apps/desktop/acceptance/results/latest-scorecard.md`. That file is the last lab process; it does not merge earlier live passes from the same day.
