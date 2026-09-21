# ADR-023 — System Security Boundaries

**Status:** ACCEPTED  
**Sprint:** 4A — Security Hardening  
**Date:** 2026-09-21

---

## Context

Sprint 4A performs a full adversarial security hardening pass across the complete implemented system:
Chat, Diff/Edit, Controlled Terminal, Autocomplete, MCP, Model routing/providers, Project Memory,
Skills, permissions, confirmations, workspace/path containment, webview protocols, subprocess
execution, environment/secrets, extension lifecycle, persisted state, and runtime event contracts.

Sprint 4B will introduce a runtime evaluation loop (ACT → OBSERVE → EVALUATE → DECIDE → ADAPT →
ACT AGAIN). Sprint 4A must therefore harden the system **and** preserve structured security
evidence that future runtime evals can consume — **without** granting any direct authority to
those evaluators.

---

## Decision

### 1. Trust Boundaries

All of the following are treated as **untrusted input** regardless of origin:

- Model (chat / autocomplete) responses
- MCP server tool names, schemas, and call results
- Workspace files (including AGENTS.md, PROJECT.md, README, package.json scripts)
- Webview messages (WebviewToHostMessage)
- Persisted project/session state (sessions.jsonl)
- Relative paths supplied by tools or models
- File names and URIs
- Provider HTTP payloads
- Old / stale runtime events

Core principle: **DATA ≠ AUTHORITY**. A string that says `"apply_patch"` or `"APPROVE"` creates
no authority by itself.

### 2. Authority Map

| Authority Domain | Canonical Owner | Notes |
|---|---|---|
| **Read authority** | Read-only tool registry (`read-only-registry.ts`) | Path-contained via `resolveRepositoryPath` with realpath |
| **Write authority** | `MutationEngine` only | Single canonical owner; realpath-based containment; hash-gated TOCTOU protection |
| **Process authority** | `VerificationEngine` only | `shell:false`; allowlisted executables; CWD contained; minimal env |
| **Approval authority** | Confirmation/permission mechanism (`permissions.ts`, `chat-controller.ts`) | Hard-denied categories are non-overridable; confirmationId is single-use |
| **MCP execution authority** | `McpCatalog` + `createMcpToolRegistration` | Tool results are text/evidence only; `classifyPermission` governs action authority |
| **Model routing authority** | `ModelRouter` / `RoutedModelGateway` | No cloud fallback; capability escalation denied |
| **UI authority** | Presentation and input only | `parseWebviewMessage` validates every inbound message; no direct write/process authority |
| **Future Runtime Evals** | Recommendation only — **NEVER authority** | See §10 |

### 3. Path Containment

All file access uses one of two canonical containment functions:

**`resolveRepositoryPath(root, path, type?)`** (`path-safety.ts`):
1. `realpath(workspaceRoot)` → canonical root
2. `resolve(root, requestedPath)` → candidate
3. Lexical containment check via `relative(root, candidate)` — no `..` prefix, not absolute
4. `realpath(candidate)` → real resolved path
5. Second containment check on real resolved path
6. Optional `stat` for file/directory type

This handles: traversal, absolute paths, symlink escape, encoded paths, duplicate separators, `"."` segments, multi-root prefix confusion (uses `relative()` not string prefix).

**`resolveWritePath(root, path, { mustExist })`** (`mutation-engine.ts`):
- When `mustExist: true`: same as `resolveRepositoryPath`
- When `mustExist: false` (create): resolves and realpath-checks the **parent directory**, then recomputes the final candidate under the realpath'd parent

This handles: symlink-parent race, non-existent target paths.

**Multi-root containment**: The `relative()` function is used, not string-prefix comparison. `/project` and `/project-old` are unambiguously distinct.

### 4. Symlink Handling

- **Read access**: `resolveRepositoryPath` calls `realpath` on the resolved path and re-checks containment → symlink escapes denied
- **Write access (existing file)**: same realpath + re-check
- **Write access (new file)**: realpath of **parent directory** + recompute candidate path → symlink-parent swap denied
- **`MutationEngine.#applyPatch`**: runs at-apply-time; uses `resolvedPath` from preparation time — if the filesystem changes between prepare and apply, the hash check (stale base detection) provides a second line of defense

### 5. Write Authority (Mutation)

All file writes flow through `MutationEngine`:

```
prepare(request)          → PreparedMutation (ID, resolved path, baseHash, resultHash)
                             ↓ human approval ↓
apply(prepared)           → checks #consumed set → checks currentHash == baseHash → atomic write
```

Invariants:
- `#consumed` set: each mutation ID is applied at most once
- `rejectMutation(id)` adds to `#consumed` — cannot be re-approved
- Hash verification at apply time → TOCTOU protection
- Atomic write via temp file + rename → no partial writes
- `resolveWritePath` called at **prepare time** with workspace root → containment baked into `PreparedMutation.resolvedPath`

### 6. Process Authority (Verification)

All subprocess execution flows through `VerificationEngine`:

- `shell: false` — arguments are literal, not interpreted by shell
- `detached: true` on non-Windows (for process-tree cleanup via `killProcessTree`)
- CWD validated via `resolveRepositoryPath` at execution time
- Minimal environment: `{ PATH, NODE_ENV, npm_config_* }` — host secrets not propagated
- Script hash validation: `packageJsonHash` checked at execution time → stale detection
- Script body validation: individual script body checked if present
- `#consumed` set: each `verificationId` executes at most once
- Timeout: configurable, default in `PreparedVerification`
- Process tree killed on timeout, cancellation, and deactivation

### 7. Confirmation Replay Resistance

- `VerificationEngine.#consumed` prevents re-execution of the same `verificationId`
- `MutationEngine.#consumed` prevents re-application of the same mutation ID
- `rejectMutation` and approval both add to `#consumed`
- After `chat.newConversation`, the ChatController discards stale confirmation IDs — no old approval restores authority in a new turn

### 8. Webview Validation

Every inbound webview message passes through `parseWebviewMessage`:
- Rejects non-object or non-string `type`
- **Prototype pollution guard**: rejects objects with own properties `__proto__`, `constructor`, `prototype`
- Validates all fields (length limits, enum membership, required types)
- Unknown `type` values → `null` (default case)
- ID length limits (100 chars max) prevent oversized ID replay

CSP: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{nonce}'`
- No `unsafe-eval`
- No arbitrary remote origins
- Scripts require nonce (generated fresh per webview resolve)
- `unsafe-inline` for styles only (acceptable for VS Code webview theming with CSS variables)

### 9. MCP Distrust Model

The MCP server is treated as a potentially malicious external process:

- **Tool naming**: canonical names use `mcp_{serverId}_{toolName}` with alphanumeric normalization — core tool names (`apply_patch`, `run_verification`) cannot be impersonated
- **Schema bounds**: serialized schema > 64 KB → skipped. Schema depth > 16 levels → skipped. Prevents schema-bomb DoS and stack overflow.
- **Result bounds**: `MAX_MCP_RESULT_BYTES = 50 KB` — oversized results are truncated to a single descriptive text item
- **Prompt injection**: MCP tool results are text evidence, not authority. They cannot change `classifyPermission` results or trigger tool calls.
- **Environment**: only `safeBaseEnvNames` + explicitly allowlisted `envFrom` keys — no blind env dump
- **Transport**: `shell: false`, `detached: true`, `killProcessTree` on close/timeout/deactivation
- **Same-server duplicates**: throw immediately on discovery
- **Cross-server collision**: throw immediately on discovery
- **Timeout**: listTools 10s, callTool 30s (configurable)

### 10. Model-Output Distrust

Provider responses are untrusted:

- `normalizeWireResponse` validates response structure; missing/malformed fields → `ModelProviderError`
- Autocomplete output is literal editor text — not executed, not parsed as tool calls
- Chat provider tool calls validated against registered tool schemas
- Route configuration is validated by `loadRoutingConfig` — malformed config → null (fail closed)
- No cloud fallback: `RouteUnavailableError` when no healthy route matches
- Capability escalation denied: autocomplete-only deployment cannot serve chat

### 11. Secret Handling

- **Environment**: `VerificationEngine` exposes only `{ PATH, NODE_ENV, npm_config_* }` to subprocesses
- **MCP env**: `McpCatalog` exposes only `safeBaseEnvNames` + explicit `envFrom` — no full `process.env` dump
- **Session storage**: `redactSecrets()` applied before persist — keys matching `[password, secret, token, key, authorization, bearer, api_key, aws_access_key, credential]` are redacted
- **Provider credentials**: stored in headers, never logged by the provider adapter
- **Route diagnostics**: `RouteProvenance` contains no secrets — only IDs, task class, reason codes
- **Halo errors**: `SAFE_MESSAGES` map — raw upstream errors never surfaced to UI

### 12. Runtime Retention Bounds

| Structure | Bound | Eviction |
|---|---|---|
| Chat transcript | 50 messages (ChatController) | Oldest message evicted |
| Diff registry | 20 reviews, 5 MB total | Oldest evicted on overflow |
| Terminal registry | 50 reviews, 1 MB total retained bytes | Oldest completed evicted |
| Autocomplete acceptance registry | `MAX_ACCEPTANCE_REGISTRY_SIZE` | No eviction needed (entries consumed on first use) |
| Session storage | 50 sessions, 16 KB/session, 512 KB total | Oldest evicted |
| MCP result | 50 KB per call | Truncated to single text item |
| MCP pending requests | Map cleared on cleanup | Cleared on close/timeout/error |

### 13. Lifecycle Cleanup

On extension deactivation, the following are cleaned up:
- Active `AgentRunner` abort controller aborted
- `McpCatalog.close()`: all MCP server transports closed, child processes killed via `killProcessTree`
- `VerificationEngine` processes killed via `killProcessTree` (via terminal registry deactivation)
- `AutocompleteController` disposed: in-flight tasks cancelled, native provider disposed
- Chat webview listeners removed
- Diff review registry cleared
- Terminal review registry deactivated (flushes to 0, kills active processes)
- Late events after deactivation are safe no-ops (guards in ChatController and TerminalReviewController)

### 14. Future Runtime Eval Non-Authority Rule

Sprint 4B will add a runtime evaluation loop. This ADR establishes the invariant:

> **A `RuntimeEvalResult` MUST NOT be able to:**
> - Directly approve a mutation
> - Directly approve terminal execution
> - Change permission classifications
> - Invoke MCP tools
> - Write files
> - Disable or weaken security rules

A `RuntimeEvalResult` may only **recommend** one of:
`CONTINUE | REVISE | REPLAN | VERIFY | CHANGE_MODEL | REQUEST_MORE_CONTEXT | STOP | ASK_HUMAN`

The runtime evaluator is advisory. All authority remains in the canonical security layers established in this ADR.

---

## Consequences

### Positive

- Single canonical write authority (MutationEngine) — no accidental duplicate writes
- Single canonical process authority (VerificationEngine) — no shell injection possible
- Symlink escapes denied at both read and write surfaces
- TOCTOU window narrowed via at-apply hash verification
- Confirmation replay prevented via consumed-set tracking
- Webview message validation prevents forged IDs and prototype pollution
- MCP schema bounds prevent DoS and stack overflow
- Secret redaction in session persistence
- Minimal subprocess environment (no host secret exposure)
- Future runtime evals cannot gain authority

### Negative / Accepted Limitations

- No OS-level MAC sandbox (e.g., seccomp, AppArmor) around subprocess execution
- No signed extension distribution yet (planned Sprint 4F)
- No enterprise secret vault integration
- SSH key sensitivity (id_rsa etc.) added to autocomplete sensitive list — may skip legitimate SSH config editing in rare cases
- `unsafe-inline` for CSS in webview (acceptable for VS Code theming; no script-unsafe-inline)
- Real OSS model attack surface testing deferred to Sprint 4E

---

## Related ADRs

- ADR-011: Safe Mutation Layer
- ADR-015: Bounded MCP Integration
- ADR-016: Deterministic Model Provider Routing
- ADR-019: Diff/Edit Review Boundary
- ADR-021: Controlled Terminal Execution
- ADR-022: Editor-Native Autocomplete
