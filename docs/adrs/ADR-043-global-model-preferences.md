# ADR-043: Global Model Preferences

- **Status**: Accepted
- **Date**: 2026-11-08
- **Sprint**: 14C.1

## Context

Chat, Agent, and Autocomplete all reached a model through `.open-vs-code/models.json` in the open folder. A repository without that file had no route. Selecting a model rewrote the file. Creating a starter configuration also opened it, and VS Code session restore then showed that tab on the next launch. An untrusted folder could still supply the inference endpoint for a read-only turn.

## Decision

Extension storage holds the global model choice. The existing router, provider, and autocomplete gateway stay the only inference path.

Precedence:

1. A trusted workspace `.open-vs-code/models.json`, unless the user suspends that override. The file is not rewritten.
2. Global preferences in extension `globalState` (`open-vs-code.modelPreferences.v1`).
3. Models discovered from the global endpoint, then saved as the global default when no valid preference exists.
4. No route.

An untrusted workspace file is ignored for inference and for advertised deployments. Trust is never granted automatically. Endpoint tokens are stored in VS Code Secret Storage and applied through the existing `apiKeyEnv` mechanism. They are not written into preferences or project files.

The extension passes the resolved configuration as `routingConfigOverride` and sets `skipWorkspaceRoutingFile`, so a missing override does not fall back to the workspace file.

## Consequences

- Opening another folder keeps the same chat and autocomplete models without a project file.
- A checked-in `models.json` remains an explicit, visible override on a trusted folder.
- Changing a global preference while that override is active does not change the effective route. The user suspends the override with "Use global models". The file is not rewritten.
- An untrusted folder is not parsed. The host records that the file exists and leaves its bytes unread.
- Invalid stored preferences are left in place until the user saves a new choice.
- HALO, when selected, still replaces the provider and does not use this local route.
