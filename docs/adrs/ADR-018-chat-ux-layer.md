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
