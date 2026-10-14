# Upstream Reference Map

Revisions and paths below reflect the 2026-08-18 Sprint 1 audit and 2026-08-26 Sprint 1F separation. Reinspect before copying code.

| Repository | Primary purpose for us | License | Status | Relevant paths | Reuse classification | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| [Kilo Code](https://github.com/Kilo-Org/kilocode) | External audited upstream / future IDE reference | MIT; Apache-2.0 notice for Continue extraction | Active; audited `91a337e` (2026-08-17) | Historical checkpoint `baseline/pre-kilo-separation`; `packages/kilo-vscode/` | REFERENCE_ONLY / ADAPT | Canonical repository is independent (ADR-009). Upstream Kilo source removed from working tree; history preserved in Git. |
| [Cline](https://github.com/cline/cline) | Agent loop, approvals, checkpoints, tool architecture | Apache-2.0 | Active; audited `b9efa96` (2026-08-17) | `sdk/packages/{agents,llms,core}/`; `apps/vscode/` | ADAPT | Best comparison for a publishable editor-independent core. |
| [VS Code Copilot Chat](https://github.com/microsoft/vscode-copilot-chat) | VS Code AI UX and agent integration | MIT | Archived 2026-05; moved to `microsoft/vscode` | `src/extension/{agents,inlineEdits,tools,chatSessions}/`; `chat-lib/` | REFERENCE_ONLY | Follow active source in Code-OSS for future native UX work. |
| [Void](https://github.com/voideditor/void) | Streaming edits, diff UX, standalone editor patterns | Apache-2.0; product metadata needs reconciliation | Active snapshot `b3166e7` (2026-06-02) | `src/vs/workbench/contrib/void/`; `product.json` | REFERENCE_ONLY | Valuable diff/workbench patterns; deeply Code-OSS-coupled. |
| [Continue](https://github.com/continuedev/continue) | Context, retrieval, and provider patterns | Apache-2.0 | Active snapshot `5522c6f` (2026-07-20) | `core/context/`; `core/indexing/`; `core/llm/llms/`; `extensions/vscode/` | EXTRACT / REFERENCE_ONLY | Retrieval, context formatting, and provider pattern reference. |
| [Tabby](https://github.com/TabbyML/tabby) | Local autocomplete | Apache-2.0 outside separately licensed `ee/` | Active snapshot `21b2904` (2026-06-30) | `crates/tabby-inference/`; `crates/tabby/src/services/completion/`; `clients/tabby-agent/`; `clients/vscode/` | REFERENCE_ONLY | Later FIM/local-serving reference; inference runtime is an early non-goal. |
| [VSCodium](https://github.com/VSCodium/vscodium) | Eventual Code-OSS distribution | To verify | Deferred | Not inspected | UNKNOWN | Distribution reference, not an early baseline. |
| [Code-OSS](https://github.com/microsoft/vscode) | Eventual standalone editor foundation | To verify | Deferred | Not inspected | UNKNOWN | Deep editor work is an early non-goal. |
| [ECC](https://github.com/affaan-m/ECC) | Agent review and introspection/recovery patterns | MIT | Active; inspected `b92f181` (2026-10-11), read-only shallow clone | `skills/agent-introspection-debugging/SKILL.md`; `.opencode/prompts/agents/loop-operator.txt` | REFERENCE_ONLY | Capture → classify → one discriminating check → retry (ADR-031); evidence-cited review findings (ADR-030). No code or text copied; fleet/orchestration scale not adopted. |
| [awesome-vibe-coding](https://github.com/filipecalegario/awesome-vibe-coding) | Standing ecosystem discovery source | CC0-1.0 | Active snapshot `59d5028` (2026-04-15) | `README.md` | REFERENCE_ONLY | Consult during every major reuse investigation; entries still require independent audit. |

Detailed evidence: `docs/research/kilo-audit.md`, `docs/research/secondary-audit.md`, and `docs/research/repository-ownership-audit.md`.

## Historical component decisions

| Component | Classification | Evidence | Rationale | License impact |
| --- | --- | --- | --- | --- |
| Kilo/OpenCode tool definition, registry, validation, and truncation boundaries | REFERENCE_ONLY | Imported revision `91a337e`; `packages/opencode/src/tool/tool.ts`, `packages/opencode/src/tool/registry.ts` | The boundary pattern is useful, but the implementation is coupled to Effect, agents, plugins, MCP, network tools, shell/write tools, instance state, and host flags. A dependency-free registry over the safe tools is smaller and preserves `agent-core` invariants. | No code copied; no additional attribution or dependency obligation. |
| Kilo Monorepo & Product Codebase Separation (Sprint 1F) | REFERENCE_ONLY | Sprint 1F separation; ADR-009 | Canonical repository retains only `@open-vs-code/agent-core` and project memory. Upstream Kilo code separated from active working tree; historical checkpoint preserved via `baseline/pre-kilo-separation`. | MIT license notice preserved in `THIRD_PARTY_NOTICES.md`. |
