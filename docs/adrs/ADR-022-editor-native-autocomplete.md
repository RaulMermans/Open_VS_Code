# ADR-022: Editor-Native Autocomplete

**Status:** Accepted  
**Sprint:** 3E  
**Date:** 2026-09-20

## Context

After completing Sprint 3D (Controlled Terminal UX), the next product capability is low-latency inline autocomplete powered by the existing model-routing and provider architecture. The editor-native autocomplete feature must feel instant and unobtrusive — triggered by keystrokes, debounced, and abandoned silently on stale results or provider unavailability.

The fundamental tension is that the existing `AgentRunner` carries substantial overhead: tools, permissions, MCP, memory, skills, mutation, verification, and multi-turn reasoning. These are correct for agentic chat but antithetical to inline autocomplete which needs:

- Sub-second latency
- Aggressive request cancellation
- Single bounded inference
- Zero side effects
- No conversational state

## Decision

### Separate Autocomplete Path

Autocomplete is implemented as an **entirely separate path** from the conversational agent. The new path is:

```
VS Code InlineCompletionItemProvider
         ↓
AutocompleteController (vscode-integration)
         ↓
AutocompleteService (agent-core)
         ↓
AutocompleteContextBuilder
         ↓
AutocompleteGateway
         ↓
ModelRouter (reused)
         ↓
AutocompleteProvider (FIM-capable local model)
         ↓
sanitizeCompletion()
         ↓
VS Code InlineCompletionItem
```

The conversational path remains:

```
Chat → AgentRunner → tools / memory / skills / MCP / mutation / verification
```

These paths **never intersect**.

### Why AgentRunner Is Bypassed

`AgentRunner` owns:
- `ToolRuntime` (tool registration, permission gates, observations)
- `MutationEngine` (write-path safety, base-hash verification, atomic writes)
- `VerificationEngine` (subprocess execution, bounded STDOUT/STDERR)
- `ProjectMemorySnapshot` (Markdown retrieval, session history)
- Skills loading and selection
- MCP client invocation
- Multi-turn state machine and confirmation flows

None of these are appropriate for autocomplete. Wiring autocomplete through `AgentRunner` would add hundreds of milliseconds of overhead per keystroke, introduce forbidden side effects, and make cancellation semantics fragile.

### Editor-Local Context Only

Autocomplete V1 uses exclusively editor-local context — the unsaved buffer text immediately surrounding the cursor. It does NOT read:
- `PROJECT.md`, `AGENTS.md`, `ARCHITECTURE.md`
- Project Memory (Markdown brain)
- Session or conversation history
- Other open files
- Git history or embeddings
- Repository chunk retrieval (RAG)

This ensures autocomplete overhead is bounded per keystroke regardless of repository size.

### Context Budgets

All constants are documented in `packages/agent-core/src/autocomplete/budget.ts`.

| Parameter | Token budget | Character ceiling |
|-----------|-------------|------------------|
| Prefix (text left of cursor) | ~2,000 tokens | 8,000 chars |
| Suffix (text right of cursor) | ~1,000 tokens | 4,000 chars |
| Total combined | ~3,500 tokens | 14,000 chars |
| Generated output | 256 tokens | 1,024 chars |

Token estimation uses the existing 4-chars-per-token convention from `ContextBudget`.

**Truncation rules:**
- Prefix: keep the **newest** (right-most) portion — cursor-nearest context is most relevant
- Suffix: keep the **earliest** (left-most) portion
- No AST-aware slicing in V1 (deferred to future work)
- Surrogate-pair boundary check prevents corrupted UTF-16

### FIM / Autocomplete Capability Routing

The `ModelRouter` is **reused unchanged** for autocomplete routing. Two small extensions were made:

1. `TaskClass` extended with `"autocomplete"` so routing configuration can have a dedicated `autocomplete` route
2. `RoutingModelCapability` extended with `"fim"` and `"autocomplete"` so model descriptors can advertise FIM support
3. `ModelRouteRequirements.requiredCapabilities` added so the router enforces that only FIM/autocomplete-capable models are selected

The gateway (`AutocompleteGateway`) uses `taskClass: "autocomplete"` and `requiredCapabilities: ["autocomplete"]`. A chat-only model without this capability is **rejected** by the router — the sprint requirement that "chat-only route rejected" is enforced at the routing layer, not via name heuristics.

**No cloud fallback:** If no local autocomplete-capable route exists, `RouteUnavailableError` is caught and the service returns `null` silently. No external network requests are made.

### Provider-Specific FIM Formatting Boundary

The autocomplete contract separates **what** from **how**:
- `AutocompleteRequest.prefix` and `.suffix` are structured fields (plain text)
- Any FIM-specific token formatting (e.g. `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`) belongs in the **provider adapter**, not in `AutocompleteService` or `AutocompleteContextBuilder`

This ensures new FIM token conventions can be supported by adding/adapting a provider without touching the core.

### Debounce

A short debounce (`DEBOUNCE_MS = 100ms`) prevents provider invocation on every individual keystroke. The scheduler is **injectable** for deterministic testing — tests use `FakeScheduler` that stores pending callbacks and flushes them synchronously without real sleeps.

### Request Lifecycle and Cancellation

Every trigger creates a unique `requestId`. The service maintains:
- **Pending handle:** cancelled when a new trigger arrives before the debounce fires
- **In-flight abort controller:** cancelled when a new trigger arrives after debounce fires
- **Latest request ID:** used to reject results that arrive for superseded requests

VS Code's `CancellationToken` is mapped to an `AbortSignal` and merged into the request's signal.

**Inference timeout:** `INFERENCE_TIMEOUT_MS = 3,000ms` — far shorter than agent operations. Timeout fires via `AbortController`, stopping the provider.

### Stale-Result Rejection

A result is discarded if:
1. A newer `requestId` has been registered since the request started (**superseded**)
2. The document URI has changed (**active document changed**)

These checks happen synchronously before the `InlineCompletionItem` is returned.

### Output Sanitization

Applied deterministically in order:
1. Hard character ceiling (`MAX_OUTPUT_CHARS = 1,024`)
2. Code-fence stripping (single ```` ``` ```` pair wrapping the entire output)
3. Exact prefix-echo removal (provider repeated the tail of the prefix)
4. Exact suffix-overlap removal (provider repeated the head of the suffix)
5. Trailing blank-line trim
6. Whitespace-only guard → empty string

No fuzzy rewriting. No Markdown parser. No AST manipulation.

### Native VS Code Inline Completion API

The controller uses `vscode.languages.registerInlineCompletionItemProvider` and returns `vscode.InlineCompletionItem`. There is no custom ghost-text renderer and no confirmation modal. The **user's editor acceptance action is the sole insertion authority.**

### Telemetry

Session-local only. The `AutocompleteTelemetry` object tracks:
- `requests`, `providerInvocations`, `shown`, `accepted`, `cancelled`, `staleDiscarded`, `empty`, `failed`
- `generatedChars`, `acceptedChars` (aggregate counts, not source text)

The bounded acceptance registry maps `requestId → generatedChars` (max `MAX_ACCEPTANCE_REGISTRY_SIZE = 50` entries). Source code text is never stored in telemetry.

No external telemetry endpoints are called.

### Sensitive File Policy

Autocomplete is skipped for files matching sensitive patterns (`.env`, `.env.*`, `*.pem`, `*.key`, etc.). The check is applied in `AutocompleteContextBuilder` before any provider is invoked. The full security hardening pass is deferred to Sprint 4A.

### Real Model Benchmarking Deferred

Sprint 3E validates architecture, contracts, routing, IDE lifecycle, cancellation, stale guards, sanitization, and telemetry. **No real FIM model is downloaded or run on the development machine.** Real model quality benchmarking is deferred to Sprint 4D on the target inference machine.

### Sprint 3E.1 — Production Wiring & Stale-Safety Closure

1. **Native Extension Activation:**
   - `packages/vscode-integration/package.json` activates on `onStartupFinished`.
   - `activate()` initializes `AutocompleteController` and registers native `vscode.languages.registerInlineCompletionItemProvider` for all documents (`*`).
   - `open-vs-code.toggleAutocomplete` command is contributed and registered to dynamically enable/disable the provider.

2. **Safe Zero-Deployment Default:**
   - When no routes or deployments are configured (`.open-vs-code/models.json` absent or empty), `createProductionAutocompleteGateway` defaults to a safe zero-deployment configuration.
   - Provider requests catch `RouteUnavailableError` quietly and return `null` (`telemetry.empty++`, `telemetry.failed == 0`).
   - Zero error dialogs, zero crashes, zero cloud/network/download fallback.

3. **Live Editor Stale-Result Guards:**
   - Completion results are validated against live editor state via `LiveEditorState` supplier (`documentUri`, `documentVersion`, `cursorLine`, `cursorCharacter`).
   - Each state change alone triggers immediate stale discard (`staleDiscarded++`, returns `null`).
   - Newer request supersession is tracked via `#latestRequestId`; superseded older results increment `staleDiscarded++`.

4. **In-Flight Request Deduplication:**
   - Deterministic duplicate key computed from `documentUri`, `documentVersion`, `cursorLine`, `cursorCharacter`, and bounded `prefix`/`suffix` hash (no random IDs).
   - Identical in-flight or pending requests share the active promise; provider invocations remain strictly 1.
   - Distinct requests (e.g. cursor moved or text changed) bypass deduplication and execute independently.

5. **Single-Use Acceptance Telemetry:**
   - Acceptance registry entries are consumed and removed upon first acceptance invocation.
   - Subsequent double-accept calls, unknown IDs, or evicted entries produce a delta of 0 (`telemetry.accepted` unchanged).

6. **UTF-16 Surrogate Safety:**
   - Comprehensive unicode surrogate-pair boundaries handled via `truncateStartSafe`, `truncateEndSafe`, and `cleanIsolatedSurrogates`.
   - Prefix, suffix, total char ceiling, output token caps, and overlap sanitization never slice between high and low surrogate pairs.


## Consequences

### Positive

- Autocomplete latency is bounded by a single inference call with bounded context — no repository scans, no memory retrieval, no tool dispatch
- The `ModelRouter` reuse preserves Sprint 2D routing semantics unchanged (existing tests continue to pass)
- Cancellation is clean: `AbortSignal` flows from VS Code CancellationToken through the service into the provider
- The architecture is portable unchanged into the future Code-OSS/VSCodium distribution
- Provider-specific FIM formatting is fully isolated from core logic

### Negative / Limitations

- V1 autocomplete uses only editor-local context — no cross-file awareness
- No AST-aware context selection (deferred)
- No semantic multi-candidate reranking (deferred)
- No real FIM model validation until Sprint 4D

## Alternatives Considered

1. **Route through AgentRunner**: Rejected. AgentRunner overhead (tools, memory, MCP, mutation) is incompatible with keystroke latency requirements, and autocomplete must have zero side effects.

2. **Chat completion fallback**: Rejected. Chat models without FIM capability should not receive autocomplete requests. The router enforces `requiredCapabilities: ["autocomplete"]`.

3. **Tree-sitter AST context**: Deferred to a future sprint. V1 uses simple text with surrogate-pair boundary safety.

## Related

- ADR-016: Model / Provider Routing
- ADR-018: Chat UX Layer
- ADR-021: Controlled Terminal Execution
- Sprint 3E implementation: `packages/agent-core/src/autocomplete/`

## Sprint 7D amendment

- **Bounded editor extraction.** `AutocompleteController` reads only the text that can reach the context builder: the last `PREFIX_CHAR_CEILING` + 16 characters before the cursor and the first `SUFFIX_CHAR_CEILING` + 16 after it, through `offsetAt`/`positionAt` ranges (`editorTextAround`). Previously each keystroke copied the whole document twice before the debounce. The built context is identical (property test over CRLF, surrogate pairs and whitespace-heavy files). When the window holds fewer than 3 non-whitespace characters, the full prefix is read so the empty-prefix decision is unchanged.
- **Cancellation scoping.** The debounce-phase cancellation listener now acts only on its own request and detaches when the debounce fires. Before, a cancellation of an older token that arrived after a newer request was scheduled cancelled the newer one, and an in-flight cancellation was counted twice. VS Code 1.135 cancels the previous token before starting the next request, so there the visible effect was the double count. An already-cancelled request no longer reaches the provider. The controller disposes its token subscription after each request.
- Unchanged: native editor acceptance is the only insertion path; no AgentRunner, tools or mutation; no routing change.

Record: `docs/sprints/SPRINT_7D_IDE_PERFORMANCE.md`.
