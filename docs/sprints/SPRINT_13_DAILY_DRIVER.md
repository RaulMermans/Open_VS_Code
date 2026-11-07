# Sprint 13 — Daily driver MVP

Status: `0.1.0-rc.6` is the package under verification. Installed GUI acceptance stays open until the journeys below are recorded against that package.

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
