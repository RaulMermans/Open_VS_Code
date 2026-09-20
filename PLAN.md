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

Next:
Sprint 3E — Autocomplete → NEXT
