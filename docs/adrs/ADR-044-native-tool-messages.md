# ADR-044: Native tool-message conversation encoding (opt-in)

## Status
Accepted (Milestone 3). Default remains `compiled-user`.

## Context
Agent Core historically recompiled task text, guidelines, recent turns, and tool observations into a single user message (`messages: [{ role: "user", content: promptContent }]`). OpenCode (`f2156d79c9`, MIT) keeps a structured session of user, assistant, and tool-result messages. Aider (`5dc9490bb3`, Apache-2.0) treats edit/test feedback as distinct turns rather than one blob.

The OpenAI-compatible provider already serializes `role: "tool"` and `tool_call_id`. The runner did not emit that shape.

## Decision
1. Keep `compiled-user` as the production default.
2. Add isolated encoding `native-tool-messages`: compile static context without observations, then append assistant `tool_calls` plus `tool` results for the recent observations.
3. Enable only via `AgentRunnerInput.conversationEncoding` or `OPEN_VS_CODE_NATIVE_TOOL_MESSAGES=1`.
4. Do not change temperature, turn budget, or tools in the same switch.
5. Do not make it the default until a same-model A/B against OpenCode and the compiled-user baseline exists. 2026-11-13: compiled-user vs OpenCode on 12 disposable tasks with `qwen3-coder:30b` digest `sha256-1194192cf2a187eb02722edcc3f77b11d21f537048ce04b67ccf8ba78863006a` scored 11/12 vs 3/12. Native encoding scored 4/4 on a compiled-passing subset. Default remains `compiled-user`.

## Consequences
- Tool-result attribution is possible without replacing AgentRuntime.
- Tool arguments are stored on `AgentToolCallRecord` and `ToolObservation` when available; native messages send those arguments instead of `{}`.
- PermissionGate, MutationEngine, and confirmation ids are unchanged.

## References
- `/tmp/ovsc-refs/opencode` commit `f2156d79c9` — `packages/core` session runner tool-result messages.
- `/tmp/ovsc-refs/aider` commit `5dc9490bb3` — search/replace plus lint/test feedback loop.
