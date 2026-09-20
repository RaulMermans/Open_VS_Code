# ADR-021: Controlled Terminal UX and Presentation Boundary

## Context
In Sprint 3D, we introduce a controlled terminal review and execution experience within the IDE chat interface. The system needs to allow users to review, approve, monitor, and cancel command executions requested by the agent (such as verification, testing, linting, building, and typechecking) without introducing arbitrary code execution vulnerabilities, shell injection, dangling daemon processes, or UI-driven privilege escalation.

Note: `ADR-020` was previously allocated to `ADR-020-halo-capability-provider.md` (Sprint 9 / HALO capability provider).

## Decision

1. **Sole Execution Authority**:
   - `VerificationEngine` in `agent-core` remains the exclusive execution authority for subprocesses.
   - The IDE host, `ChatController`, `TerminalReviewController`, and Webview are strictly **presentation and user review layers**. They possess zero authority to spawn processes directly.

2. **Strict `shell: false` & No Shell Interpolation**:
   - All executions are performed with `spawn(prepared.executable, prepared.args, { shell: false, detached: true, cwd })`.
   - Shell strings, shell wrappers (`bash -c`, `sh -c`, `zsh -c`), eval constructs, pipes (`|`), redirections (`>`, `<`), and command chaining (`&&`, `;`, `||`) are strictly rejected.

3. **Conservative Default (Explicit Human Approval)**:
   - Command execution pauses at the `CONFIRM` permission gate.
   - Execution only proceeds when the user explicitly clicks `[Run]` in the UI or approves via confirmation bridge. No auto-approval exists.
   - Rejection cancels execution cleanly without running any process.

4. **Process Tree Containment and Cancellation**:
   - Subprocesses are spawned detached (`detached: true`) so that termination targets the process group (`-child.pid` on POSIX systems).
   - Cancellation by user or timeout guarantees that the child and any spawned descendant processes are cleanly terminated with zero orphaned background tasks.

5. **Bounded Ring Buffering and Streaming Presentation**:
   - Terminal outputs are captured in separate stdout and stderr bounded ring buffers (capped at 16 KB per stream).
   - Chunk boundaries preserve valid UTF-8 sequences.
   - When output exceeds the stream budget, earlier bytes are discarded and an explicit truncation notice (`[... output truncated ...]`) is displayed.

6. **Stale Script Protection**:
   - Commands are bound to the `package.json` script content and hash at preparation time.
   - If the script name or script definition changes in `package.json` between preparation and approval, execution is rejected as stale.

7. **Prohibited Command Classes**:
   - Package manager installations (`npm install`, `yarn add`, `pnpm add`, etc.).
   - Git mutations (`git commit`, `git push`, `git rebase`, `git reset`, etc.).
   - Long-running daemons or file watchers (`npm start`, `next dev`, `vite`, `nodemon`, etc.).
   - Interactive REPLs or stdin requirements.
   - Privilege escalations (`sudo`, `doas`, `su`).

8. **Zero Model Overhead**:
   - UI actions on terminal review cards (viewing, toggling output, copying commands, approving, rejecting, or cancelling) trigger zero LLM calls.

## Consequences
- Guaranteed protection against prompt injection resulting in arbitrary command execution.
- Deterministic and auditable command review lifecycle (`PREPARED`, `WAITING_APPROVAL`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `REJECTED`).
- Complete alignment with editor-independent architecture: `agent-core` contracts drive the execution while `vscode-integration` handles rendering.
