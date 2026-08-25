# Upstream Reference Map

Revisions and paths below reflect the 2026-08-18 Sprint 1 audit. Reinspect before copying code.

| Repository | Primary purpose for us | License | Status | Relevant paths | Reuse classification | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| [Kilo Code](https://github.com/Kilo-Org/kilocode) | Primary reusable AI coding-agent baseline | MIT; Apache-2.0 notice for Continue extraction | Active; audited `91a337e` (2026-08-17) | `packages/kilo-vscode/`; `packages/opencode/`; `packages/core/`; `packages/llm/`; `script/upstream/` | ADAPT | Recommended controlled fork; isolate cloud/telemetry/remote/marketplace/multi-agent surfaces. |
| [Cline](https://github.com/cline/cline) | Agent loop, approvals, checkpoints, tool architecture | Apache-2.0 | Active; audited `b9efa96` (2026-08-17) | `sdk/packages/{agents,llms,core}/`; `apps/vscode/` | ADAPT | Best comparison for a publishable editor-independent core; avoid a second runtime now. |
| [VS Code Copilot Chat](https://github.com/microsoft/vscode-copilot-chat) | VS Code AI UX and agent integration | MIT | Archived 2026-05; moved to `microsoft/vscode` | `src/extension/{agents,inlineEdits,tools,chatSessions}/`; `chat-lib/` | REFERENCE_ONLY | Follow active source in Code-OSS for future native UX work. |
| [Void](https://github.com/voideditor/void) | Streaming edits, diff UX, standalone editor patterns | Apache-2.0; product metadata needs reconciliation | Active snapshot `b3166e7` (2026-06-02) | `src/vs/workbench/contrib/void/`; `product.json` | REFERENCE_ONLY | Valuable diff/workbench patterns; deeply Code-OSS-coupled. |
| [Continue](https://github.com/continuedev/continue) | Context, retrieval, and provider patterns | Apache-2.0 | Active snapshot `5522c6f` (2026-07-20) | `core/context/`; `core/indexing/`; `core/llm/llms/`; `extensions/vscode/` | EXTRACT / REFERENCE_ONLY | Kilo already embeds a focused Continue autocomplete extraction. |
| [Tabby](https://github.com/TabbyML/tabby) | Local autocomplete | Apache-2.0 outside separately licensed `ee/` | Active snapshot `21b2904` (2026-06-30) | `crates/tabby-inference/`; `crates/tabby/src/services/completion/`; `clients/tabby-agent/`; `clients/vscode/` | REFERENCE_ONLY | Later FIM/local-serving reference; inference runtime is an early non-goal. |
| [VSCodium](https://github.com/VSCodium/vscodium) | Eventual Code-OSS distribution | To verify | Deferred | Not inspected | UNKNOWN | Distribution reference, not an early baseline. |
| [Code-OSS](https://github.com/microsoft/vscode) | Eventual standalone editor foundation | To verify | Deferred | Not inspected | UNKNOWN | Deep editor work is an early non-goal. |
| [awesome-vibe-coding](https://github.com/filipecalegario/awesome-vibe-coding) | Standing ecosystem discovery source | CC0-1.0 | Active snapshot `59d5028` (2026-04-15) | `README.md` | REFERENCE_ONLY | Consult during every major reuse investigation; entries still require independent audit. |

Detailed evidence: `docs/research/kilo-audit.md` and `docs/research/secondary-audit.md`.

## Sprint 1D component decision

| Component | Classification | Evidence | Rationale | License impact |
| --- | --- | --- | --- | --- |
| Kilo/OpenCode tool definition, registry, validation, and truncation boundaries | REFERENCE_ONLY | Imported revision `91a337e`; `packages/opencode/src/tool/tool.ts`, `packages/opencode/src/tool/registry.ts` | The boundary pattern is useful, but the implementation is coupled to Effect, agents, plugins, MCP, network tools, shell/write tools, instance state, and host flags. A dependency-free registry over the existing four safe tools is smaller and preserves `agent-core` invariants. | No code copied; no additional attribution or dependency obligation. |
