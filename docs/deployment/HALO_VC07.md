# VC-07 HALO optional provider (isolated)

Default remains `open-vs-code.inferenceBackend = standalone-local`.

Enable HALO only after Gate B approval:

1. `Open VS Code: Set HALO Application Token` (SecretStorage).
2. Set `open-vs-code.inferenceBackend` to `halo`.
3. Optional: `open-vs-code.halo.modelId` to a HALO registry ID.
4. `Open VS Code: Check HALO Connection` — health is not model readiness.

Rollback: set the backend back to `standalone-local`. Do not change HALO services.

Streaming: unsupported. Capability-path BUILD/DEBUG can round-trip HALO native `output.toolCalls`; explicit `modelId` chat still does not send tools. OpenAI-style `tool_calls` remain refused.

Physical Gate C (2026-11-22): three ASK completions through `HaloProvider` to resident `x3-qwen3-14b-vulkan` (pid 3841757, reuse). Capability `coding` to 4B is admission-rejected while that runtime is `model_advertised`. Package default remains Direct Ollama.
