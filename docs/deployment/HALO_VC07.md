# VC-07 HALO optional provider (isolated)

Default remains `open-vs-code.inferenceBackend = standalone-local`.

Enable HALO only after Gate B approval:

1. `Open VS Code: Set HALO Application Token` (SecretStorage).
2. Set `open-vs-code.inferenceBackend` to `halo`.
3. Optional: `open-vs-code.halo.modelId` to a HALO registry ID.
4. `Open VS Code: Check HALO Connection` — health is not model readiness.

Rollback: set the backend back to `standalone-local`. Do not change HALO services.

Streaming: unsupported. Tools: unsupported. BUILD/DEBUG through HALO is blocked until HALO grows a tool protocol.

Physical coding evals: not authorized in this sprint.
