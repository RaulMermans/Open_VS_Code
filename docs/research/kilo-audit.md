# Kilo Code upstream audit

## Audit identity and method

- Source: `https://github.com/Kilo-Org/kilocode.git`
- Revision: `91a337e31cd7675d680aeb13c92870b8f81bdf36`
- Commit date: 2026-08-17
- Version in root manifest: `7.4.22`
- License: MIT at `LICENSE`; the embedded Continue autocomplete extraction retains Apache-2.0 attribution at `packages/kilo-vscode/THIRD_PARTY_LICENSES/continue.txt`.
- Method: shallow clone in an isolated session research directory; tree/manifests first, then targeted source reads. No Kilo code was copied into this repository.

The source has 9,346 tracked files and 35 top-level workspace packages at this revision. The checkout hit Windows long-path/index problems after download, so commit-object reads (`git show HEAD:<path>` and `git ls-tree`) were treated as authoritative.

## Repository map

Kilo is a Bun/TypeScript monorepo, not merely a VS Code extension. The root `package.json` pins Bun 1.3.14, uses workspaces under `packages/*`, and deliberately rejects `bun test` at the root in favor of package-scoped tests.

| Boundary | Evidence | Finding |
| --- | --- | --- |
| VS Code host | `packages/kilo-vscode/src/extension.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/src/services/cli-backend/` | VS Code APIs and webview lifecycle remain in the extension. `KiloConnectionService` launches/connects to a separate CLI backend. |
| Chat UI | `packages/kilo-vscode/webview-ui/src/App.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/`, `packages/kilo-vscode/webview-ui/src/types/messages/` | Webview UI is separated from backend execution by messages/SDK transport. |
| CLI/backend entry | `packages/opencode/src/index.ts`, `packages/opencode/src/cli/cmd/serve.ts`, `packages/opencode/src/server/` | The agent runtime can run as CLI or local server without VS Code. |
| Agent loop | `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/session/processor.ts`, `packages/opencode/src/session/llm/` | Prompt orchestration, streaming model events, tool calls, retries, and permission checks are editor-independent. |
| Core services | `packages/core/src/`, `packages/core/src/effect/`, `packages/core/src/session/runner/` | Lower-level Effect services and a newer session runner are outside the editor, although the active Kilo CLI still composes substantial logic from `packages/opencode`. |
| Provider layers | `packages/llm/src/`, `packages/opencode/src/provider/provider.ts`, `packages/core/src/plugin/provider/` | Protocol adapters, provider discovery/configuration, and AI-SDK-backed provider loading are separated but span three layers. |
| Shared UI | `packages/ui/`, `packages/session-ui/`, `packages/kilo-ui/` | Reusable session/diff presentation exists, with additional Kilo-specific UI packages. |
| Upstream strategy | `script/upstream/README.md`, `script/upstream/` | Kilo automates merges from `anomalyco/opencode` using transforms and `kilocode_change` markers. This lowers merge cost but creates a second upstream relationship to maintain. |

The root build surface includes `bun turbo typecheck`, `bun run check:architecture`, `bun extension:isolated`, and package-scoped test commands. At the audited revision there are 669 `packages/opencode` test/spec files, 165 `packages/core` test/spec files, and 369 under `packages/kilo-vscode`.

## Major-area reuse map

| Area | Classification | Exact evidence | Rationale and boundary |
| --- | --- | --- | --- |
| VS Code integration | ADAPT | `packages/kilo-vscode/src/extension.ts`; `packages/kilo-vscode/src/services/cli-backend/`; `packages/kilo-vscode/tests/unit/extension-arch.test.ts` | Strong host/backend split. Retain the adapter pattern and narrow product surface; remove Kilo branding and cloud-only activation paths. |
| Chat UI | ADAPT | `packages/kilo-vscode/webview-ui/src/components/chat/`; `packages/kilo-vscode/webview-ui/src/context/`; `packages/kilo-vscode/tests/visual-regression.spec.ts` | Mature streaming/tool/permission UI, but mixed with account, remote, marketplace, worktree, and Kilo-specific state. |
| Model/provider abstraction | ADAPT | `packages/llm/src/provider.ts`; `packages/llm/src/providers/`; `packages/opencode/src/provider/provider.ts`; `packages/core/src/plugin/provider/openai-compatible.ts` | Provider-neutral contracts and generic OpenAI-compatible routing exist. Consolidation is required before treating any one layer as authoritative. |
| Local provider support | KEEP | `packages/kilo-docs/pages/ai-providers/ollama.md`; `packages/kilo-docs/pages/ai-providers/lmstudio.md`; `packages/kilo-docs/pages/ai-providers/openai-compatible.md`; `packages/kilo-docs/pages/automate/extending/local-models.md` | Ollama, LM Studio, and arbitrary localhost-compatible endpoints are documented. llama.cpp/vLLM can use compatible endpoints. Verify fully offline startup during T-007. |
| Agent/task loop | KEEP | `packages/opencode/src/session/prompt.ts`; `packages/opencode/src/session/processor.ts`; `packages/opencode/src/session/tools.ts`; `packages/opencode/test/session/`; `packages/opencode/test/kilocode/session-*` | Mature streaming/tool loop with extensive regression tests. Keep initially in a fork; isolate Kilo-specific remote/export hooks behind ports rather than rewriting the loop. |
| Modes | ADAPT | `packages/opencode/src/agent/agent.ts`; `packages/opencode/src/kilocode/agent/index.ts`; `packages/opencode/src/agent/prompt/{ask,debug,explore}.txt`; `packages/opencode/src/command/template/review.txt` | Code/build, plan, ask, and debug exist; review is a command rather than a first-class primary mode. Normalize names and permissions after baseline verification. |
| Tool execution and approvals | KEEP | `packages/opencode/src/tool/registry.ts`; `packages/opencode/src/tool/tool.ts`; `packages/opencode/src/permission/`; `packages/opencode/test/permission/`; `packages/opencode/test/kilocode/permission/` | Central registry plus per-agent permission rules is the right reusable seam and is well tested. |
| File reads | KEEP | `packages/opencode/src/tool/read.ts`; `packages/opencode/src/tool/grep.ts`; `packages/opencode/src/tool/glob.ts`; matching tests under `packages/opencode/test/tool/` | Editor-independent, bounded tools with permission integration. |
| File writes/patches | KEEP | `packages/opencode/src/tool/write.ts`; `packages/opencode/src/tool/edit.ts`; `packages/opencode/src/tool/apply_patch.ts`; `packages/opencode/src/patch/index.ts` | Covers direct writes, edits, and structured patches with focused tests. |
| Streaming diff UX | ADAPT | `packages/kilo-vscode/src/diff/`; `packages/kilo-vscode/src/DiffVirtualProvider.ts`; `packages/kilo-vscode/webview-ui/src/components/chat/PermissionDiff.tsx`; `packages/ui/src/components/session-diff.ts` | Strong presentation patterns, but VS Code/UI coupling is expected. Keep backend patch truth separate from rendering. |
| Terminal execution | ADAPT | `packages/opencode/src/tool/shell.ts`; `packages/core/src/pty/`; `packages/kilo-vscode/src/agent-manager/terminal-*`; tests under `packages/opencode/test/kilocode/shell/` and `packages/core/test/pty/` | Backend shell/PTY is reusable; Agent Manager terminal routing belongs to the deferred multi-agent surface. |
| Tests/build checks | KEEP | `packages/opencode/package.json`; `packages/core/package.json`; `packages/kilo-vscode/package.json`; `script/check-architecture.ts`; `.github/workflows/test*.yml` | Large test inventory and an explicit architecture check are valuable. Preserve upstream commands first; migrate tooling only with measured benefit. |
| MCP | KEEP | `packages/opencode/src/mcp/`; `packages/opencode/src/cli/cmd/mcp.ts`; `packages/opencode/test/mcp/`; `packages/kilo-vscode/src/kilo-provider/mcp-oauth.ts` | Local/remote transports, OAuth, lifecycle recovery, and tests exist outside VS Code. Keep backend; adapt editor configuration UI. |
| Skills | KEEP | `packages/opencode/src/skill/`; `packages/opencode/src/tool/skill.ts`; `packages/core/src/skill/`; associated tests | On-demand skill discovery aligns with progressive disclosure. Confirm accepted skill roots and token behavior after import. |
| Autocomplete | KEEP | `packages/kilo-vscode/src/services/autocomplete/`; `packages/kilo-vscode/src/services/autocomplete/continuedev/`; `packages/kilo-vscode/THIRD_PARTY_LICENSES/continue.txt` | Kilo already performed a selective Continue extraction with tree-sitter context, FIM, filtering, and tests. Preserve Apache notice; verify docs that still mention the older pnpm/Vitest setup. |
| Checkpoints | KEEP | `packages/opencode/src/snapshot/index.ts`; `packages/opencode/src/session/revert.ts`; `packages/opencode/test/snapshot/`; `packages/opencode/test/kilocode/session/revert.test.ts` | Git-backed snapshots, turn patches, revert/unrevert, and race tests meet the early checkpoint need. |
| Project memory | EXTRACT | `packages/kilo-memory/package.json`; `packages/kilo-memory/src/`; `packages/opencode/src/kilocode/memory/` | `@kilocode/kilo-memory` is a small MIT package with only Effect and Zod runtime dependencies. Its storage semantics still need comparison with ADR-005 before adoption. |
| Repository indexing | REFERENCE_ONLY | `packages/kilo-indexing/`; `packages/opencode/src/kilocode/indexing-*` | Includes useful tree-sitter/search patterns but brings LanceDB, Qdrant, cloud gateway, embeddings, and more scope than the early product permits. |
| Cloud/account/gateway | DELETE/IGNORE | `packages/kilo-gateway/src/auth/`; `packages/kilo-gateway/src/cloud-sessions.ts`; `packages/opencode/src/kilocode/cloud/`; `packages/opencode/src/account/` | Not required for local-only operation and conflicts with the no-mandatory-cloud constraint. Remove from the reachable dependency graph, not with an unreviewed bulk deletion. |
| Telemetry/session export | DELETE/IGNORE | `packages/kilo-telemetry/`; `packages/kilo-vscode/src/services/telemetry/`; `packages/opencode/src/kilocode/session-export/` | PostHog and remote session export are outside the product goal. Default-disable immediately, then prove no network calls in an offline smoke test. |
| Marketplace/billing surfaces | DELETE/IGNORE | `packages/kilo-vscode/src/services/marketplace/`; `packages/kilo-vscode/webview-ui/src/components/marketplace/`; gateway/profile UI paths | Cloud discovery and commercial surfaces are unnecessary. Preserve only generic local skill/plugin loading when the boundary is clear. |
| Agent Manager/worktrees | DELETE/IGNORE | `packages/kilo-vscode/src/agent-manager/`; related webview and tests | Technically rich but explicitly outside early scope. Keep out of the first canonical product surface to avoid accidental multi-agent architecture. |

## Coupling and extraction risk

- `packages/opencode` is the active product runtime and depends on `packages/core`, `packages/llm`, Kilo gateway/indexing/memory/telemetry packages, the AI SDK ecosystem, Effect, SQLite, PTY implementations, and multiple UI/runtime packages. Extracting it cleanly before a smoke baseline would be high risk.
- `packages/core` is editor-independent but is not yet the whole shipped agent core. Treating it alone as the baseline would omit MCP, the mature tool registry, Kilo modes, and much of session orchestration.
- Kilo keeps an automated OpenCode merge system. A fork inherits both Kilo upstream changes and Kilo's OpenCode synchronization mechanics.
- The root uses Bun for reproducible upstream builds. The project preference for pnpm should not force a package-manager migration before T-007 proves the upstream baseline.
- Some embedded Continue documentation references pnpm/Vitest paths that no longer match the root Bun manifest; source manifests and current tests take precedence.

## Intake risks and generated areas

- Generated or derived code includes `packages/client/src/generated*`, database `*.gen.ts`/migration outputs, SDK outputs, screenshots, translations, docs assets, and lockfiles. Do not hand-edit without locating the owning generator.
- `artifacts/`, `packages/kilo-docs/`, translations, container images, release automation, JetBrains packages, TUI/console surfaces, and cloud products add unrelated baggage for the first local IDE milestone.
- Project/provider configuration can contain credentials. Kilo has tests and documentation for trusted config boundaries, but the canonical fork still needs a secret scan and offline network test.
- The audit did not execute upstream tests; dependency installation and smoke verification belong to T-007 after the canonical import.

## Conclusion

Kilo is suitable as a controlled fork baseline. Its strongest asset is not individual source snippets but the already-working composition of an editor adapter, local server/CLI, agent loop, tools, permissions, providers, snapshots, MCP, skills, autocomplete, and extensive tests. The main cost is removing reachable cloud/product baggage without breaking the upstream merge path.
