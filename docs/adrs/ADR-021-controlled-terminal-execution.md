# ADR-021: Controlled Terminal UX and Presentation Boundary

**Status:** Accepted — Sprint 3D ✅ CLOSED (updated Sprint 3D.1)

## Context

In Sprint 3D, we introduced a controlled terminal review and execution experience within the IDE chat interface. In Sprint 3D.1 we completed the runtime truth requirements: live subprocess output streaming, UTF-8 chunk boundary safety, bounded prefix buffers, dead-state removal, fail-closed presentation validation, bounded registry, and deterministic process group cleanup proofs.

Note: `ADR-020` was previously allocated to `ADR-020-halo-capability-provider.md` (Sprint 9 / HALO capability provider).

## Decision

### 1. Sole Execution Authority

- `VerificationEngine` in `agent-core` remains the exclusive execution authority for subprocesses.
- The IDE host, `ChatController`, `TerminalReviewController`, and Webview are strictly **presentation and user review layers** with zero subprocess spawn authority.

### 2. Strict `shell: false` & No Shell Interpolation

- All executions: `spawn(prepared.executable, prepared.args, { shell: false, detached: true, cwd })`.
- Shell wrappers, eval constructs, pipes, redirections, and command chaining are strictly rejected at the preparation layer.

### 3. Conservative Default (Explicit Human Approval)

- Command execution pauses at the `CONFIRM` permission gate.
- Execution only proceeds on explicit `[Run]` click or confirmation bridge approval.
- Rejection cancels execution cleanly without running any process.

### 4. Fail-Closed Presentation Validation (Sprint 3D.1)

- `ChatController.requestConfirmation` validates every prepared command before showing it to the user:
  - `executable` must be a non-empty string.
  - `args` must be an array (not a string or other type).
  - `cwd` must be a non-empty string.
- If any field is missing or malformed, the confirmation resolves immediately to `"REJECT"` with no fallback substitution (`"npm"`, `["test"]`, `"."` fallbacks are prohibited).

### 5. Live Subprocess Output Streaming (Sprint 3D.1)

- `VerificationEngine.execute()` accepts an optional `onOutput` callback `(chunk: { stream: "stdout" | "stderr"; chunk: string }) => void`.
- Stdout and stderr are decoded with `StringDecoder("utf-8")` to prevent split multi-byte character sequences at chunk boundaries.
- Each decoded chunk is delivered to `onOutput` as it arrives; the decoder is flushed on stream close or settle.
- `AgentRunner` wires `onOutput` to emit `"verification.output"` events via `eventSink`.
- `ChatController` handles `"verification.output"` events, validates the payload (executionId string, stream `"stdout"|"stderr"`, chunk string), calls `terminalReviewController.appendOutput`, updates `activeTerminal`, and pushes `terminal.updated` messages to the Webview.
- The Webview renders output using `textContent` (XSS-immune; no `innerHTML`).

### 6. Bounded Prefix Buffer Policy (Sprint 3D.1)

- Each stream (stdout, stderr) retains the **first `maxOutputBytes` bytes** (default 16 KB) received — a bounded **prefix** buffer, not a ring buffer.
- When a chunk would exceed the per-stream budget, it is sliced to the remaining capacity using `truncateUtf8Buffer`, which walks back from the byte limit to exclude trailing multi-byte sequence continuations, avoiding `\uFFFD` replacement characters.
- Once the per-stream budget is full, further chunks are silently discarded; `stdoutTruncated` / `stderrTruncated` flags are set to `true`.
- Documentation and comments describe this accurately as a "bounded prefix buffer" — not a circular buffer.

### 7. Removed `PREPARED` State (Sprint 3D.1)

- `PREPARED` was a dead lifecycle state never reachable in any valid execution path.
- It has been removed from `TerminalReviewStatus`, `TerminalReviewDto`, and all tests.
- The 7 remaining active states are: `WAITING_APPROVAL`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `REJECTED`.

### 8. Bounded Registry (Sprint 3D.1)

- `TerminalReviewController` enforces two budgets:
  - **`maxReviews`** (default 50): before registering a new entry, evict the oldest completed entry (`SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `REJECTED`) if at the limit.
  - **`maxTotalRetainedBytes`** (default 1 MB): after each `appendOutput` or `recordCompletion`, evict the oldest completed entry if the cumulative stdout+stderr bytes of all retained entries exceed the limit.
- Active entries (`WAITING_APPROVAL`, `RUNNING`) are **never evicted**.

### 9. Process Tree Containment and Deterministic Cleanup (Sprint 3D.1)

- Subprocesses are spawned with `detached: true` so termination targets the process group (`process.kill(-child.pid, "SIGTERM")` then `SIGKILL` after grace period on POSIX).
- Cancellation via `AbortSignal` and timeout both deterministically terminate the parent and all descendant processes.
- E2E proof: `terminal-core-e2e.test.ts` scenarios 53 and 54 spawn a real parent that forks a real child, observe both PIDs are alive, then trigger cancellation/timeout and poll until both PIDs are dead.
- Extension deactivation (`deactivate()`) aborts the active `AbortController` (scenario 55), terminating the subprocess tree.

### 10. Stale Script Protection

- Commands are bound to `package.json` script content and hash at preparation time.
- If the script name or body changes between preparation and approval, execution is rejected as stale.

### 11. Prohibited Command Classes

- Package manager installations (`npm install`, `yarn add`, etc.).
- Git mutations (`git commit`, `git push`, etc.).
- Long-running daemons or file watchers.
- Interactive REPLs or stdin requirements.
- Privilege escalations (`sudo`, `doas`, `su`).

### 12. Zero Model Overhead

- UI actions on terminal review cards (view, toggle, copy, approve, reject, cancel) trigger zero LLM calls.

### 13. Canonical Execution Identity (Sprint 3D.2)

- One canonical process execution identifier survives end-to-end:
  `PreparedVerification.verificationId` == `confirmation.preparedCommand.executionId` == `TerminalReviewEntry.executionId` == `verification.output.executionId` == `verification.completed.executionId` == `terminal.updated.terminal.executionId`.
- No ID regeneration occurs in production when registering an existing prepared command.
- Output events (`verification.output`) route strictly by exact `executionId`. Events with unknown or forged IDs never fall back to `activeTerminal` or mutate other reviews.
- Approval identity (`confirmationId`) remains semantically separate from `executionId`. `confirmationId` represents the interaction token, whereas `executionId` represents the process/review lifecycle identity.

### 14. Real Extension Deactivation Closure (Sprint 3D.2)

- `deactivate()` is the sole entry point that triggers cancellation during shutdown without manual pre-cancellation.
- `deactivate()` invokes `chatController.cancelTurn()`, propagating the `AbortSignal` to `VerificationEngine`.
- `VerificationEngine` kills the process group (`-child.pid`), cleanly destroying both parent and child processes.
- Deactivation clears the terminal registry (`clearAll()`), reducing retained bytes to 0 and preventing late events from resurrecting review state or emitting UI updates.

## Consequences

- Guaranteed protection against prompt injection resulting in arbitrary command execution.
- Deterministic and auditable command review lifecycle (7 active states; `PREPARED` eliminated).
- Live output visible to the user as execution progresses, without race conditions or XSS risk.
- Complete alignment with editor-independent architecture: `agent-core` contracts drive execution; `vscode-integration` handles rendering.
- Memory bounded: no registry growth without limit regardless of session length.
- Strict execution identity preservation end-to-end with verified isolation.
- Complete process group termination on extension deactivation with zero orphaned processes.
