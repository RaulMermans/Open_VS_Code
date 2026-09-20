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

Sprint 3E — Editor-Native Autocomplete ✅ CLOSED
  - Autonomous separate execution path: zero dependency on AgentRunner, ToolRuntime, MutationEngine, VerificationEngine, MCP, or ProjectMemory
  - Dedicated AutocompleteService orchestrating context assembly, debounce, cancellation, stale safety, sanitization, and bounded telemetry
  - Editor-local context only: unsaved live editor buffer captured; zero Markdown brain or RAG disk reads; bounded budgets (prefix ~2,000 tokens, suffix ~1,000 tokens, total ceiling 3,500 tokens)
  - Sensitive file suppression: .env, *.pem, *.key skipped immediately with 0 provider calls
  - ModelRouter reused with dedicated taskClass: "autocomplete" and requiredCapabilities: ["autocomplete"]; chat-only models strictly rejected; zero cloud fallback
  - Injectable debounce scheduler (100ms default), in-flight cancellation via AbortSignal, and inference timeout (3,000ms cap)
  - Stale-result guards rejecting outdated document versions, moved cursors, changed document URIs, and superseded request IDs
  - Output sanitization removing code fences, exact prefix echo, and exact suffix overlap
  - Native VS Code InlineCompletionItem integration with insertion text beginning at cursor and internal acceptance command telemetry hook
  - 70 deterministic evaluation scenarios pass Run 1 and Run 2 with deep equality (zero failures)
  - Full workspace clean: 0 TypeScript errors, 0 linter errors, clean build, 30/30 deterministic coding evals twice

Next:
Sprint 4A — Security Hardening → NEXT
