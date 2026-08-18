# Targeted secondary-reference audit

This audit only investigated gaps relevant to the Sprint 1 baseline decision. Revisions are shallow, pinned inspections; no source was imported.

## Findings

| Repository | Revision / license | Targeted paths | Classification | Finding |
| --- | --- | --- | --- | --- |
| Cline | `b9efa968265b09c481696b5c4f6c1d921cd05009` (2026-08-17), Apache-2.0 | `sdk/packages/agents/src/agent-runtime.ts`; `sdk/packages/core/src/runtime/orchestration/session-runtime.ts`; `sdk/packages/core/src/runtime/tools/tool-approval.ts`; `sdk/packages/core/src/session/checkpoint-{diff,restore}.ts`; `apps/vscode/src/extension.ts` | ADAPT | The publishable `@cline/agents`, `@cline/llms`, and `@cline/core` layering is the clearest secondary model for an editor-independent agent core. Approvals are injected through runtime callbacks and checkpoint logic is host-neutral. It is a credible fallback or later extraction target, but combining it with Kilo now would duplicate runtime, provider, and session abstractions. |
| VS Code Copilot Chat | `5863f5a7088958050792b5dccbe8b46c6e13eccc` (2026-05-20), MIT | `src/extension/agents/vscode-node/`; `src/extension/inlineEdits/`; `src/extension/tools/`; `src/extension/chatSessions/`; `chat-lib/` | REFERENCE_ONLY | The repository is archived and active development moved into `microsoft/vscode`. It remains useful for VS Code-native agent registration, inline-edit rebasing, terminal/tool rendering, and chat patterns, but relies on proposed/internal VS Code APIs and a paid service. Future UX research must follow the corresponding paths in Code-OSS. |
| Void | `b3166e7ef2aefbdfeb139445fdf248a561b85d4d` (2026-06-02), Apache-2.0 in `LICENSE.txt` | `src/vs/workbench/contrib/void/browser/editCodeService.ts`; `.../editCodeServiceInterface.ts`; `.../helpers/findDiffs.ts`; `.../react/src/diff/`; `.../terminalToolService.ts`; `product.json` | REFERENCE_ONLY | Strong evidence for streaming diff zones and direct workbench integration. The implementation is deeply coupled to Code-OSS internal services, so selective copying would be brittle. `product.json` reports `licenseName: MIT` while the repository implementation license is Apache-2.0; reconcile notices before any future reuse. |
| Continue | `5522c6f44ca0ac3528b37244818fbfa39b5af470` (2026-07-20), Apache-2.0 | `core/context/providers/`; `core/context/retrieval/`; `core/indexing/`; `core/llm/llms/{Ollama,LMStudio,LlamaCpp,Vllm}.ts`; `extensions/vscode/src/VsCodeIde.ts` | EXTRACT / REFERENCE_ONLY | Best reference for explicit context-provider and local-model adapter catalogs. Kilo already contains a focused Continue-derived autocomplete extraction, so import no second copy. Use targeted patterns when designing context/compiler interfaces. |
| Tabby | `21b29048d7bcf6b94f9f482f2d0fd05efadfd19f` (2026-06-30), Apache-2.0 outside separately licensed `ee/` | `MODEL_SPEC.md`; `crates/tabby-inference/src/completion.rs`; `crates/tabby/src/services/completion/`; `clients/tabby-agent/src/codeCompletion/`; `clients/vscode/src/InlineCompletionProvider.ts` | REFERENCE_ONLY | Strong later-stage reference for local GGUF/llama.cpp serving, FIM templates, prompt construction, context snippets, caching, debouncing, and post-processing. It is a separate Rust inference/server stack and building an inference runtime is an early non-goal. |
| awesome-vibe-coding | `59d50281e40651d574ea0ead592a08019d74730d` (2026-04-15), CC0-1.0 | `README.md` sections for IDEs, extensions, local apps, CLI tools, task management, and documentation | REFERENCE_ONLY | Standing discovery index. Consult it for each major reuse investigation; do not treat its entries as vetted implementation evidence. |

## Implications for the baseline

- Cline now offers a cleaner published SDK boundary than Kilo's active `packages/opencode` composition. Preserve it as the comparison point for every future agent-core extraction decision.
- Kilo remains the better whole-product baseline because its VS Code adapter, backend, chat UI, diff UX, modes, MCP, checkpoints, skills, and autocomplete already operate together.
- Copilot Chat and Void should guide UX and Code-OSS integration decisions, not become copied runtime dependencies.
- Continue and Tabby should inform later context and autocomplete work after the baseline is known-good.

