# Sprint 14C.1 — Global model management

STATUS: IMPLEMENTED_NOT_INSTALLED

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
