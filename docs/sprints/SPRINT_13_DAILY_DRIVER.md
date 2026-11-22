# Sprint 13 — Daily driver MVP

Status: `0.1.0-rc.6` from `50e79ce46324ff8a8d2bee6d1b5a0cc4916d424d` is installed. Local GUI journeys below passed. GitHub CI on this branch is the remaining acceptance gate.

## Product

- The agent view is contributed to the secondary sidebar (`open-vs-code-agent`), not the Explorer.
- The first open of a workspace reveals that sidebar once. Later launches keep the saved workbench layout.
- The composer shows Ask, Plan, and Agent. Debug, Review, and custom profiles stay in the same selector.
- Ask, Plan, and Agent still send `ASK`, `PLAN`, and `BUILD`.
- Installed local models come from the configured Ollama `/api/tags` probe. The dropdown writes the existing chat route and leaves autocomplete routing unchanged.
- A disconnected probe is shown as offline. The UI does not claim a connection that the probe did not make.
- The Linux package uses an original ink, bracket, and teal-diamond icon for the launcher and the window icon.

## Baseline fix

`requiredEditPaths` no longer reads a possibly missing regular-expression capture. A match without a capture keeps the explicit path list. A path the user names after "do not edit" is dropped from the required set when at least one other required path remains.

## Installed evidence

Disposable repository: `/tmp/ovsc-sprint13-repo`. Chat route `open-vs-code-chat` is `qwen3-coder:30b`. Autocomplete route `local-fim` stayed `qwen2.5-coder:7b`.

- Ask on the installed `0.1.0-rc.6` window quoted `farewell` as `"Goodbye, " + name` while the status read `Ready · qwen3-coder:30b`.
- Plan on the previous sprint package described `farewell` and left `src/greet.mjs` unchanged.
- Agent applied one `farewell`, then a follow-up duplicated it. Debug mode proposed `src/greet.mjs` `+0 −4` against base `6be0e725091a`. After approval, `npm test` in that repository passed both `greets by name` and `says goodbye by name`. The same turn still reported `MAX_TURNS_EXCEEDED` because the test path was treated as required. `0.1.0-rc.6` contains the contract fix; that false failure was not re-run against the model.
- Reject of a `wave` patch (`+4 −0`, base `6d2e68c786c0`) left `src/greet.mjs` at SHA-256 `6d2e68c786c05c02af88736aa6fe8c0336f3654ec6722f724d5c663faa3aa92a`.
- Restart kept Explorer at x=48, the editor at x=348, the agent at x=1140, the selected model, and the rejection transcript.
- A configured endpoint of `http://127.0.0.1:9` showed `Disconnected` and `Ollama is offline or unreachable at http://127.0.0.1:9`. Restoring `http://127.0.0.1:11434` returned `Ready · qwen3-coder:30b`. The Ollama process was not stopped.
- Conversation `c-a4001628a0539fdd.json` kept SHA-256 `c2c9c7e1222b95dfc00609ec5eede630eed6e5a3f8e27466df07b3a941450473` across the upgrade to `0.1.0-rc.6`, the downgrade to `0.1.0-rc.4`, and the return to `0.1.0-rc.6`. `chrome-sandbox` was `4755 root:root` after each install.

Screenshot of the installed `0.1.0-rc.6` window after that rollback: `/tmp/ovsc-rc6.png`.
