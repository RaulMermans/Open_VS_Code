# ADR-018: Chat UX Layer & Agent Bridging

## Status
Accepted (Sprint 3B.3)

## Context
Sprint 3B aims to provide a conversational IDE interface while maintaining strict architectural boundaries. The existing agent runner (`agent-core`) and VS Code `ide-adapter` provided a minimal command-based trigger. We needed to introduce a persistent `WebviewView` for chat interaction without corrupting the core loop or duplicating state management.

## Decisions

### 1. Presentation Layer Only
The Chat UI (`ChatController` and webview) is strictly a presentation and orchestration layer. It does not evaluate tool schemas, determine if a task is "safe", or inspect LLM outputs. It listens to event streams (`model.requested`, `task.started`, `mutation.requested`) and renders state accordingly.

### 2. ContextCompiler Authority
The `ContextCompiler` is the absolute authority on agent context. The Chat UI never builds or summarizes context. It passes raw conversation turns to `agent-core` via `recentTurns` and `ContextCompiler` owns context fitting, treating grouped recent turns as optional, budgetable context items (priority 749 downwards). This ensures chat continuity is correctly balanced against Project Memory (which remains the durable authority) without hardcoded estimates in the UI layer.

### 3. Structured recentTurns
Chat history sent back to the Agent core is passed using a strict `ConversationTurn[]` structure (defined in `contracts/context.ts`). This prevents parsing desync and guarantees the model provider gets exactly the turns the user sees.

### 4. AgentSessionBridge as Execution Boundary
The `AgentSessionBridge` acts as the strict execution boundary. No autonomous execution happens directly in the UI.

### 5. Exact Confirmation ID Matching & Stale-Result Protection
Mutations requests emit a `mutation.requested` event containing the tool invocation. The Chat UI tracks this with a generated Confirmation ID. When the user clicks "Approve" or "Reject", this exact Confirmation ID must be sent back to `AgentSessionBridge` via `requestConfirmation` to ensure the correct pause lock is resolved. `conversationId` and `turnId` checks provide stale-result protection.

### 6. Cancel-During-Confirmation Semantics
If the user cancels the chat turn while the system is blocking on a pending confirmation, the `AgentSessionBridge` immediately aborts the active runner lock, rejects the pending mutation automatically, and prevents the tool execution.

### 7. Runtime Webview Validation & Strict Security
We explicitly define typed Webview-to-Host messages (`chat-protocol.ts`). A strict `parseWebviewMessage` runtime validator ensures payloads match exactly. The HTML is constructed entirely offline with safe DOM rendering via a strict Content Security Policy (CSP). No `innerHTML` is used for user input.

### 8. Transcript/Activity Bounds
The transcript and activity are bounded. There is no chain-of-thought exposure to the user, only explicit model outputs and activities are displayed.

### 9. Diff UX Deferred
Diff UX is explicitly deferred to Sprint 3C.

## Consequences
- The core loop is isolated and unaware of VS Code view complexities.
- Conversation history is naturally bounded and gracefully integrated.
- All Chat UX integration tests pass synchronously without real model inference dependencies.
- File writes are fully blocked until the precise confirmation ID clears the await lock.

## Sprint 7A refinements (presentation only)

Sprint 7A did not change this ADR's authority map. It added Webview chrome and host-side descriptors:

- Explicit attachments are path/range descriptors. They are never file contents. `ContextCompiler` still decides what enters the prompt.
- Connection status may display HALO as Ready only after a successful health check.
- Activity rows are mapped from emitted `AgentEvent`s. Unknown events are omitted; progress percentages are not fabricated.
- Transcript DOM updates skip unchanged messages (`syncTranscript` + content signature).
- Token-by-token streaming remains out of scope until the provider/bridge emit incremental text events.
- Persistent multi-session storage remains Sprint 7C.

Record: `docs/sprints/SPRINT_7A_AGENT_EXPERIENCE.md`.

## Sprint 7B refinements (review surface)

Sprint 7B did not change the authority map either. The webview gained more to display and four read-only actions:

- The "Changes & commands" ledger is a host view-model. Mutation status changes in one place (`ChatController.setMutationStatus`, which also updates `DiffReviewController`). Command rows are re-derived from `TerminalReviewController`, so neither registry is duplicated.
- New Webview → Host messages: `terminal.copyOutput`, `terminal.openOutput` (by executionId), `review.openChange` (by mutationId only; the host resolves and contains the path), and `ui.openSourceControl`. None of them decides, applies or executes anything.
- Terminal status is monotonic once finished. `terminal.cancel` acts only on a RUNNING execution.
- The host refuses a second confirmation request while one is pending. When a turn ends, any orphaned decision is released as REJECT.
- Per-hunk approval is not offered: one `MutationEngine` mutation is one hashed hunk.

Record: `docs/sprints/SPRINT_7B_TERMINAL_DIFF_EXPERIENCE.md`.

## Sprint 7C refinements (conversation history)

The authority map is unchanged. New Webview → Host messages, all carrying only a `c-<16 hex>` conversation id (and a bounded title or boolean):

- `conversation.open`, `conversation.rename`, `conversation.archive`
- `conversation.delete` (the host asks for native modal confirmation)
- `conversation.continueFrom`, `conversation.inspectRecovery`, `conversation.closeRecovery`

None of them approves, applies or executes anything. Switching is refused while a turn or decision is active. Restored history carries no pending confirmation. See ADR-033 and `docs/sprints/SPRINT_7C_SESSIONS_WORKSPACE_CONTINUITY.md`.

## Sprint 7D refinements (responsiveness)

The authority map is unchanged; no new Webview → Host message.

- Host → Webview `chat.state` may carry `transcript: "unchanged"` and omit `messages`. The webview then keeps the transcript it already rendered. The host compares id, role, status, content, attachments and the inherited flag with what it last posted, and re-sends the full transcript after a new view, a page reload (`chat.ready`) and every `conversation.reset`.
- Editor context refreshes with identical chips post nothing. Editor events are coalesced to one snapshot in flight plus one trailing refresh.
- The page re-renders the activity timeline, context chips, connection status and approval card only when their input changed. An unchanged approval keeps its card, so focus and the click lock survive unrelated pushes. New messages scroll into view only when the reader is at the bottom or has just sent.
- A model response resolves the row that announced it, and the timeline holds at most 50 rows in total.
- `ChatController.uiMetrics`: in-memory counters (numbers only), never persisted, logged or used to decide anything.

Record: `docs/sprints/SPRINT_7D_IDE_PERFORMANCE.md`; ADR-026 (Sprint 7D amendment).

## Sprint 14B refinements (conversation presentation)

The authority map is unchanged. No new agent, permission, or provider method.

- The runner appends `CONVERSATIONAL_RESPONSE_GUIDANCE` to the existing operating guidelines. It does not add a second model call.
- `formatTerminalTaskMessage` may append a verified-outcome block built from `appliedMutations` and review rows for the current run id. It does not infer files or tests from the model's prose. A command is a test, lint, typecheck, or other check from its script name or command text. A successful command with no test identity is not reported as a passing test.
- The webview shows grouped activity titles and keeps the raw event labels in a collapsed technical-details list. "Planning changes" is used only when the turn's task mode is PLAN.
- Token streaming stays deferred. `ModelProvider.complete` still returns one `ModelResponse`.

Record: `docs/sprints/SPRINT_14B_CONVERSATIONAL_EXPERIENCE.md`.
