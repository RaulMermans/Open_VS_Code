# Product Acceptance Lab

This lab drives the installed Open VS Code Electron binary. It is the repeatable check for a daily-driver build. It does not replace the unit tests.

The scenario list is `catalog/v1/scenarios.json`. Each scenario names its input, the behavior that must happen, the behavior that must not happen, the independent oracle, the timeout, and where evidence is written.

## What a run is allowed to touch

- A new directory under the system temp directory, used as the VS Code profile and as the fixture repository.
- Evidence files under `apps/desktop/acceptance/evidence/`.
- The local Ollama endpoint, only when a scenario asks for a model reply. The lab sets `OPEN_VS_CODE_REAL_INFERENCE=1` for the child process, which is the same authorization the `/usr/bin/open-vs-code` launcher sets.

The lab refuses to start if the profile path is the live `~/.config/Open VS Code` directory or the product repository. It does not click Approve unless the scenario says so, and only after the workspace path has been checked again. It does not pass `--no-sandbox`. Playwright's Electron launcher adds `--no-sandbox` only when the process is root. The sandbox helper must be mode `4755`.

A run does not install or replace the Debian package.

## Commands

From the repository root:

```text
npm run accept:lab
npm run accept:lab -- --live smoke
npm run accept:lab -- --live CONV-PING
npm run accept:lab -- --live all
```

Without `--live`, the command runs the unit and package-artifact scenarios and records every other scenario as `NOT_RUN`. `NOT_RUN` is not a pass.

Each scenario names a harness. Agent Webview work (`cdp-webview`) opens the installed binary with a loopback debug port and drives `#active-frame` through Chrome DevTools, including Wider Chat, activity, proposed diffs, and History restore. Playwright stays on workbench-only checks that do not need that webview. A missing or detached Agent webview is recorded as `BLOCKED` tooling, not as a product failure. A turn counts only when the transcript has the submitted user message and the assistant reply for that task id. An empty composer is not Send acknowledgement, and an ambiguous send is not retried. `--repeat=10` reruns one selected scenario on a fresh profile each time.

If `/tmp/ovsc-m2` contains the isolated Milestone 2 overlay, the lab loads that built-in extension directory. Override with `OPEN_VS_CODE_ACCEPTANCE_EXTENSIONS_DIR`. Full-workbench screenshots are required evidence; a failed capture fails the scenario.

`--live smoke` also opens the installed app for the sandbox check, the fresh-profile check, and one real `qwen3-coder:30b` reply.

Set `OPEN_VS_CODE_ACCEPTANCE_BINARY` to point at another production-equivalent binary. The default is `/usr/lib/open-vs-code/open-vs-code`.

## Oracles

Chat assertions read `.message.assistant .message-body` for the current user turn, so an earlier assistant message does not satisfy the expected text. Filesystem assertions allow only `.open-vs-code/model-performance-ledger.json` and `.open-vs-code/recovery/**`. `models.json` and other runtime files still fail a clean-git oracle. Coding scenarios run `node --test` in the fixture after the turn. That command is the lab's check, not the model's claim. Lab-budget Continue and Continue-restart (`maxTurns=2`) record that command as evidence and pass or fail on pause, explicit Continue, and an unchanged test file. `CODE-CONTINUE-COMPLETE` still requires the independent tests to pass on the production starting budget of 15.

Scenarios marked `review` stay `NEEDS_REVIEW` after a screenshot. A person decides the visual result.

## Evidence

Each live scenario writes under `apps/desktop/acceptance/evidence/<run-id>/<scenario-id>/`. The latest summary is `results/latest-scorecard.md`. Evidence screenshots are local and are not committed.
