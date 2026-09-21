Sprint 2A — Project Memory & Session Continuity
STATUS: COMPLETE

Sprint 2B — Skills & Prompt Primitives
STATUS: COMPLETE (Sprint 2B.2 Final Closure Patch Verified)

Sprint 2C — MCP Runtime Integration
STATUS: COMPLETE

Sprint 2D — Model / Provider Routing Architecture
STATUS: COMPLETE

Sprint 3A — IDE Adapter / Code-OSS Integration
STATUS: COMPLETE

Sprint 3B — Chat UX
STATUS: COMPLETE

Sprint 3C — Diff / Edit UX ✅ CLOSED
STATUS: COMPLETE

Sprint 3D — Controlled Terminal UX ✅ CLOSED PERMANENTLY
STATUS: COMPLETE
  Sprint 3D.1 — Terminal Runtime Truth ✅ CLOSED
    - verification.output live streaming: VerificationEngine → AgentRunner → ChatController → Webview
    - UTF-8 chunk boundary safety: StringDecoder in VerificationEngine and TerminalReviewController
    - Bounded prefix buffer (first 16 KB, not ring): truncateUtf8Buffer, stdoutTruncated/stderrTruncated flags
    - PREPARED state removed (dead state); 7 active states remain
    - Fail-closed validation: malformed prepared commands → immediate REJECT, no fallbacks
    - Bounded registry: maxReviews=50, maxTotalRetainedBytes=1MB, evict oldest completed only
    - Deterministic process group cleanup: cancellation and timeout proven by real E2E scenarios 53–55
    - Extension deactivation cleans up active subprocess: scenario 55
    - 59 terminal scenarios pass deterministically on Run 1 and Run 2
    - Full workspace: 318 tests pass, 0 TypeScript errors, build clean
  Sprint 3D.2 — Execution Identity & Deactivation Closure ✅ CLOSED
    - Canonical execution identity: PreparedVerification.verificationId passed directly end-to-end
    - No ID regeneration in production prepared verification workflow
    - Exact ID routing for verification.output without activeTerminal fallback
    - ConfirmationId remains distinct approval identity
    - Real extension deactivation kills active parent+child process tree without prior manual cancellation
    - Deactivation flushes terminal review registry to 0 reviews and 0 retained bytes
    - 79 terminal scenarios pass deterministically on Run 1 and Run 2
    - Full workspace: 318 tests pass, 0 TypeScript errors, build clean

  Sprint 3D.3 — Exact Lifecycle Event Routing & Review Isolation ✅ CLOSED PERMANENTLY
    - Canonical execution identity verificationId emitted across all verification lifecycle events: started, output, completed, failed, rejected
    - AgentRunner.#emit explicitly carries executionId: reviewable.id on all verification lifecycle events
    - Verification lifecycle payload interfaces in agent-core enforce required executionId: string
    - ChatController.requestConfirmation fails closed with REJECT when pc.verificationId is absent or empty whitespace (0 reviews, 0 spawns)
    - TerminalReviewController.registerPreparedCommand enforces required executionId: string (throws on missing/empty; zero fallback generation)
    - ChatController.handleAgentEvent routes verification.started, output, completed, failed, rejected strictly by executionId via registry lookup
    - Presentation state activeTerminal is never used as an event routing authority or fallback
    - Multi-review isolation: events for Review A cannot mutate Review B; background reviews cannot mutate or broadcast over activeTerminal
    - Safe lifecycle edge transitions: late completion after new chat turn does not resurrect activeTerminal; events after deactivation are safe no-ops
    - Reconciled Scenario 65 with live streaming and observable RUNNING status before subprocess completion
    - 97 terminal scenarios pass deterministically on Run 1 and Run 2
    - Full workspace: all tests pass, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice
    - Sprint 3D is PERMANENTLY CLOSED.

Sprint 3E & 3E.1 — Editor-Native Autocomplete & Production Wiring ✅ PERMANENTLY CLOSED
  - Autonomous separate execution path: zero dependency on AgentRunner, ToolRuntime, MutationEngine, VerificationEngine, MCP, or ProjectMemory
  - Production extension activation: registered on onStartupFinished, contributed toggle command, native registerInlineCompletionItemProvider for all documents ("*")
  - Safe zero-deployment behavior: defaults to safe empty routing configuration; unconfigured deployments yield quiet null without errors, popups, or cloud fallback
  - Dedicated AutocompleteService orchestrating context assembly, debounce, cancellation, stale safety, sanitization, and bounded telemetry
  - Real live editor stale guards: document version change alone, cursor movement alone, active document URI change alone, and newer request supersession each trigger stale discarded
  - In-flight request deduplication: deterministic editor and context hash key shares active promise without invoking provider a second time
  - Single-use acceptance telemetry: registry entries consumed upon first accept; double-accept and unknown IDs produce zero delta
  - Strict UTF-16 surrogate safety: prefix, suffix, total budget, output cap, and overlap sanitizer never produce orphaned surrogates
  - Editor-local context only: unsaved live editor buffer captured; zero Markdown brain or RAG disk reads; bounded budgets (prefix ~2,000 tokens, suffix ~1,000 tokens, total ceiling 3,500 tokens)
  - Sensitive file suppression: .env, *.pem, *.key skipped immediately with 0 provider calls
  - ModelRouter reused with dedicated taskClass: "autocomplete" and requiredCapabilities: ["autocomplete"]; chat-only models strictly rejected; zero cloud fallback
  - Full deactivation cleanup: disposes native provider, cancels in-flight tasks, and discards late results
  - 90 deterministic evaluation scenarios pass Run 1 and Run 2 with deep strict equality (zero failures)
  - Full workspace clean: all unit and E2E tests pass, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice

Sprint 4A — Security Hardening ✅ CLOSED PERMANENTLY
  - Adversarial threat model, authority map, and security model documented in docs/SECURITY_MODEL.md and ADR-023 (docs/adrs/ADR-023-system-security-boundaries.md)
  - Architecture updated with dedicated Security Boundary View in ARCHITECTURE.md
  - Symlink escape and path containment hardened: realpath-based containment across reads, writes, and non-existent create targets
  - Mutation TOCTOU hardening: applyPreparedMutation re-verifies path containment and rejects symlink targets at apply time
  - Webview protocol hardening: prototype pollution guard rejecting __proto__, constructor, and prototype own keys
  - Sensitive file matrix expanded: SSH private keys (id_rsa, id_ed25519) and credentials files added to suppression patterns
  - MCP runtime bounded: 64 KB maximum schema bytes and 16-level maximum nesting depth enforced
  - Subprocess isolation: shell:false enforced, minimal environment (PATH, NODE_ENV, npm_config_*), secrets isolated
  - Future Runtime Evals non-authority invariant established: evaluators are advisory only and cannot gain direct execution, mutation, or permission authority

Sprint 4A.1 — Security Evaluation Truth & Permanent Closure ✅ CLOSED
  - Strict runtime evidence contract: SecurityScenarioResult { id, category, description, actual, expected }
  - Elimination of all boolean proxy passes: zero `|| true`, zero `passed: true`, zero `safe: true`, zero synthetic assert.ok(true)
  - Assertions evaluate concrete runtime state via assert.deepStrictEqual(actual, expected) directly against live boundaries
  - Live production boundaries evaluated:
    * McpCatalog.discover() schema bounds and validation with in-memory transport injection
    * VerificationEngine.execute() subprocess environment isolation, secret redaction, and hash-mismatch stale base detection
    * Subprocess cancellation and process tree termination cleanup
    * AutocompleteController.provideInlineCompletionItems() malicious script/JSON completion handling and sensitive file skipping
    * resolveRepositoryPath / resolveWritePath path traversal, symlink escapes, and multi-root prefix containment
    * parseWebviewMessage prototype pollution rejection (__proto__, constructor, prototype) and message validation
    * SessionSummaryStorage corrupt JSONL fail-closed detection
  - Non-destructive normalization: strictly isolates OS temp paths ($TMP) and symbolic identifiers (durationMs, pid)
  - Absolute preservation of security decisions: allowed, error codes, spawnCount, orphanCount, secretExposed, and mutation isolation markers are NEVER discarded or normalized
  - Strict negative comparator tests: verified that assert.deepStrictEqual fails on mismatched allowed, spawnCount, orphanCount, secretExposed, or crossIdMutation
  - 91 comprehensive security evaluation scenarios pass deterministically on Run 1 and Run 2 (deep strict equality between runs)
  - Full workspace regressions: 18 test suites across all packages, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice

Sprint 4A.2 — Final Security Evidence Closure ✅ CLOSED PERMANENTLY
  - Webview DOM Rendering Execution Safety: Chat transcript, Controlled Terminal outputs, and Confirmation/Diff summaries verified to render untrusted input exclusively via textContent (container clearance using innerHTML = ''), with concrete runtime proof of 0 script executions, 0 event handler executions, and 0 unsafe navigations (javascript: links)
  - Canonical Extension Deactivation Lifecycle Cleanup: Real extension deactivate() lifecycle verified. VerificationEngine running process tree (tree-runner.cjs with child) and review registries are terminated and flushed cleanly on deactivate(), leaving 0 orphan processes, 0 review leaks, and safe no-op handling of late events
  - Real MCP Result Path & Tool Impersonation Non-Authority: Real TestMcpTransport and executeMcpCall path verified. Prompt injection and built-in tool impersonation payloads are strictly treated as inert string data with 0 permission classification mutations, 0 mutation engine invocations, and 0 tool escalations
  - Autocomplete Structural Isolation & Acceptance Safety: Structural isolation proven on AutocompleteController and AutocompleteService prototypes (0 execution/mutation authorities). Native acceptance triggers single-use telemetry consumption only, with zero process spawn or tool execution
  - Strict Negative Comparator Completeness: 10 distinct failure dimensions tested (allowed, spawnCount, orphanCount, secretExposed, crossIdMutation, scriptExecutionCount, eventHandlerExecutionCount, unsafeNavigationCount, permission, mutationsCount)
  - 97 comprehensive security evaluation scenarios pass deterministically on Run 1 and Run 2 (deep strict equality between runs)
  - Full workspace regressions: 357 tests pass across all packages, 0 failures, 0 TypeScript errors, 0 linter errors, clean build, clean git fsck, zero weight downloads
  - Sprint 4A / 4A.1 / 4A.2 is PERMANENTLY CLOSED.

Next:
Sprint 4B — Runtime Evals & Adaptive Control → NEXT
