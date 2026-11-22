# Sprint 14C.1 — Global model management

STATUS: PARTIALLY_VERIFIED

## 14C.1A corrections

`ModelRoutingHost.refresh()` used to call `loadRoutingConfigSync` before the trust check, so an untrusted `models.json` was parsed and then ignored. The host now stats the file and parses it only when `workspace.isTrusted === true`. `createAgentRuntime` does the same: an untrusted workspace does not load the file unless the caller already passed `routingConfigOverride`. A mode `000` file is the read probe. The untrusted path returns "No model routing configuration found" instead of `EACCES`, which is what a read would throw.

Selecting a chat model, an autocomplete model, an endpoint, or advanced routing writes extension storage only. It does not set the suspend flag. The Models panel keeps showing the workspace model, endpoint, and "Source: workspace override (active)" until the user chooses "Use global models". That button sets the suspend flag and does not change the file.

The Model Manager lists the active chat model, the active autocomplete model, the active endpoint, and the source. While an override is active, the dropdowns are labeled as global preferences.

Starter creation returns before any write when the folder is untrusted. Saving workspace modes or packs throws the same refusal.

The failing runner test was not a leaked tool body. A 10,000-character tool result was already cut to 32 bytes, `"truncated":true` was in the recompiled context, and the event trace did not contain 100 `x` characters. The whole user message was 1,331 bytes because the evidence-ready guidelines repeated the same stop instruction and included the conversational guidance. The scripted provider's assertion then threw, and the runner recorded that as `FAILED`. The duplicate evidence-ready banner is gone and the phase line is one sentence. Conversational guidance stays in that same user message. The 1,000-byte assertion, the 32-byte cap, and the trace check are unchanged. A recovery prompt is still one message.

Scripted results before packaging:

- `packages/agent-core` `npm test`: pass, exit 0
- `packages/vscode-integration` `npm test`: 313 pass, 0 fail
- `tsc --noEmit` for agent-core, ide-adapter, and vscode-integration: pass
- `oxlint --deny-warnings` for agent-core: pass

A chat send now waits for `ensureModelRoute()` when no route is loaded yet, so the first turn does not start against an empty configuration.

## Package

Built with `npm run package` from a clean tree. `OPEN_VS_CODE_ALLOW_DIRTY_PACKAGE` was unset.

- Product version: `0.1.0-rc.12`
- Source SHA: `6417724105e42da4be6df2daf21b46008c05c42a`
- `gitDirty`: false
- Debian: `apps/desktop/dist/open-vs-code_0.1.0-rc.12_amd64.deb`
- Debian SHA-256: `ad5dbe9c8d40bfcef15e5217575f352adc385b9d2d1e9f4fdb4ee37fea8a1958`
- Payload archive SHA-256: `b0e425b83a1f089b83cdcf5125f9e3fb6cc6188e92b6a759dd0db97d3692c026`
- Bundled extension: `open-vs-code.vscode-integration` `0.1.0-rc.12`
- Upstream shell: VSCodium `1.135.06055`, commit `5a73682ca091082675b10c9dc3f348c1d824d94f`
- Desktop smoke: 12 pass, 3 skipped (macOS-only), 0 fail
- Linux package smoke: 6 pass
- Linux runtime acceptance: the unpackaged payload fails closed, and the installed binary launches with sandbox helpers and without `--no-sandbox`

## Installation

Installed with `pkexec dpkg -i` after the owner authorized the prompt. `--no-sandbox` was not used. `dpkg` reports `open-vs-code 0.1.0-rc.12`. `chrome-sandbox` remains `4755 root:root`. The rc.11 deb is still on disk for rollback.

## Installed GUI

Playwright launched `/usr/lib/open-vs-code/open-vs-code` with `chromiumSandbox: true`. The process argv did not contain `--no-sandbox`. The profile was a copy of `~/.config/Open VS Code`, so the live profile was not the one under test. The folder was left untrusted.

The window showed Restricted Mode, the trust notice, Ask available, and Agent and Debug marked as needing trust. Models showed active chat `qwen3-coder:30b`, autocomplete `qwen2.5-coder:7b`, endpoint `http://127.0.0.1:11434`, and source global because the folder is untrusted. No `models.json` was created. A performance ledger file was written under `.open-vs-code/`.

The first Ask failed in a few milliseconds because Playwright starts the Electron binary directly, and that skips the shell launcher which exports `OPEN_VS_CODE_REAL_INFERENCE=1`. Repeating the launch with that same variable set, which is what `/usr/bin/open-vs-code` does, produced an assistant reply of `pong` from `qwen3-coder:30b`. The output channel recorded `Task Finished: COMPLETED`. The reply also contained a stray `<tool_call>` fragment. Screenshots are in `~/open-vs-code-backups/rc12-gui-2026-11-08/`.

Not exercised in this window: two repositories, wider chat, and a restart of the live profile.

Profile copies taken before the install:

- `~/open-vs-code-backups/pre-0.1.0-rc.12-2026-11-08/Open VS Code`
- `~/open-vs-code-backups/pre-0.1.0-rc.12-2026-11-08/open-vs-code-desktop`

Rollback:

```text
sudo dpkg -i "apps/desktop/dist/open-vs-code_0.1.0-rc.11_amd64.deb"
```

## 14C.1 baseline

## Root cause

`.open-vs-code/models.json` was the only production route.

| Call site | What it did |
| --- | --- |
| `loadRoutingConfig` / `loadRoutingConfigSync` | Read the workspace file. |
| `createAgentRuntime` | Used that file when no override was passed. |
| `createProductionAutocompleteGateway` | Used that file when given a workspace path. |
| `persistSelectedLocalModel` | Rewrote the file for the chat model. |
| `createStarterConfig` | Wrote the file and opened it in the editor. |
| `openModelConfig` | Opened the file on an explicit command. |
| Integration capability snapshot | Listed deployments from the file, including in an untrusted folder. |

The editor tab appeared because starter creation called `showTextDocument`. VS Code session restore reopened that tab later. That restore path is the editor's own state. The extension does not close tabs the user, or a previous session, left open. Starter creation no longer opens the file. Only the explicit Open Model Configuration command does.

## Precedence

1. Trusted workspace `models.json`, unless the user chooses global models. The file bytes stay as they were.
2. Global preferences in extension storage.
3. Models discovered from the global endpoint. The first successful discovery is saved as the global default when no valid preference exists.
4. No route.

An untrusted `models.json` cannot change the endpoint. A stored preference that contains a credential field, or that cannot be validated, is left unchanged until the user saves a new choice. Tokens go to Secret Storage under `open-vs-code.model.localToken` and are applied as `OPEN_VS_CODE_LOCAL_INFERENCE_TOKEN`.

## Product surface

The agent panel has a Models view: connection status, discovered models, separate Chat/Agent and Autocomplete choices, a connection test, and an optional advanced routing document. Agent and Debug are disabled until the user trusts the folder. Ask, Plan, and Review stay available. Wider chat opens the same panel in an editor column beside the code.

## Verification

- `packages/vscode-integration/tests/model-routing.test.ts`
- `packages/agent-core/tests/model/skip-workspace-routing.test.ts`
- `npm test` in `@open-vs-code/vscode-integration`: 311 passed
- Typecheck for agent-core, ide-adapter, and vscode-integration passed
- Agent-core `tests/agent/runner.test.ts` still has one failing test, `bounds large tool output in the recompiled model context and event trace`. That runner path was not part of this change.

## Not done in this session

No new Debian package was built or installed. The installed desktop was not walked through, and there are no new GUI screenshots. Rollback remains the previously installed package.

## Remaining limits

- HALO, when selected as the inference backend, still replaces the local provider.
- Advanced routing is a JSON document, validated by the existing schema, not a separate provider.
- A `models.json` tab restored by VS Code from an older session stays open.
- Autocomplete uses the resolved route on the next completion. A completion already in flight keeps its own request.
