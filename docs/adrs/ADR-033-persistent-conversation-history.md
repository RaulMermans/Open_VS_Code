# ADR-033: Persistent Conversation History & Read-only Recovery View

## Status
Accepted (Sprint 7C, 2026-10-24)

## Context

Before Sprint 7C, the chat lived only in the extension host's memory. A window reload lost it, and there was only one conversation at a time. Users need several conversations per workspace, to reopen them after a restart, and to understand what happened to a task that was interrupted.

The repository already had three persistent systems with narrow jobs:

| System | Job | Location |
| :--- | :--- | :--- |
| `SessionSummaryStorage` (ADR-013) | Bounded agent memory: one structured summary per finished task, injected into later prompts | `<workspace>/.open-vs-code/sessions.jsonl` |
| `CheckpointStore` + `OperationJournal` (ADR-025) | Durable execution state and write-ahead journal for crash reconciliation | `<workspace>/.open-vs-code/recovery/runs/<runId>/` |
| `RecoveryController` (ADR-025) | Truthful classification of an interrupted run into a `RecoveryPlan`. Never a write authority | — |

None of these fits visible chat history. Overloading any of them would mix responsibilities. For example, reusing `sessions.jsonl` would feed raw transcripts into agent memory, and storing transcripts in checkpoints would tie display history to execution retention.

## Decision

### 1. A fourth, display-only store

`ConversationStore` (`packages/vscode-integration/src/conversation-store.ts`) holds **only what the chat shows**:

- id, workspace identity, title, timestamps, mode
- bounded visible messages
- attachment references
- the "Changes & commands" ledger rows
- last execution status and the last run ids

It holds no approval state, tool output, hidden reasoning, file contents or runtime objects. It does not feed agent memory. Continuing a conversation passes its messages to the runtime as ordinary `recentTurns`, as the in-memory chat already did. Agent Core still decides what fits into context.

### 2. Location: VS Code's per-workspace storage, not the repository

Records live under `ExtensionContext.storageUri/conversations/`. That directory is editor-owned, outside the repository, never committed, and already distinct per workspace. With no folder open, history is off and the UI says so.

Workspace identity is `w-` plus 24 hex characters of the SHA-256 of the canonical (realpath'd) workspace root. Every record and the index carry it, and a record with a different identity is never listed, read or modified. This holds even if two workspaces were ever pointed at one directory.

### 3. Storage contract

- **Ids:** `c-<16 hex>`, enforced by the store and by `parseWebviewMessage`. File names derive only from validated ids.
- **Writes:** per-store serialized queue. Each write goes to an exclusive (`wx`) temp file with a unique name, then is atomically renamed over the target.
- **Index:** `index.json` is a checksummed cache. On load it is reconciled with the record files and rebuilt if missing, corrupt or stale.
- **Integrity:** a SHA-256 over the canonical serialization detects torn or edited files. Damaged files are quarantined: renamed aside, at most 5 kept, never trusted and never silently deleted. A newer `schemaVersion` is left untouched.
- **Sanitization:** every record crosses one boundary on save and on load (`sanitizeConversation`): known fields only, bounded, secrets redacted with Agent Core's `redactRuntimeEvalSecrets`, workspace-relative paths only.
- **Bounds:** 50 conversations (least recent evicted, active one protected), 100 messages, 200,000 characters, 50,000 characters per message, 512 KiB per record, 20 ledger rows, 10 run ids.
- **Symlinks:** the storage directory must be a plain directory directly under the storage root. Records are read only if they are regular files, opened with `O_NOFOLLOW`.

### 4. Lifecycle and isolation

- A conversation is saved once it has a message of its own, then:
  - at turn start (`lastStatus: running`)
  - when the runtime reports `task.started` (its run id)
  - when an approval is requested (the ledger row, never the decision)
  - on each change or command outcome
  - at turn end
- **Restore is display only.** A record still marked `running` is shown as **interrupted**, and so are undecided or running ledger rows. No pending confirmation, resolver, terminal entry or diff content is restored. An old confirmation id resolves nothing.
- **Switching** to, deleting, or continuing from another conversation is **refused** while a task or decision is active. The user sees why, and the running task is not cancelled, moved or detached.
- **New conversation** keeps the existing explicit "Cancel" prompt. The cancelled conversation is recorded as `cancelled`.
- **Delete** needs a native modal confirmation. **Archive** is reversible and hides the conversation from the default list.
- **Continue in new conversation** copies at most 6 earlier user and assistant turns (≤ 8,000 characters), marked `inherited`. They reach the runtime only as prior conversation turns, never as the instruction or a system message. Every change and command still needs a new approval.

### 5. Read-only recovery view

`inspectRunRecovery` (`packages/agent-core/src/recovery/recovery-inspection.ts`) composes `CheckpointStore`, `OperationJournal` and `RecoveryController.buildRecoveryPlan(runId, { persistReconciliation: false })`. The disposition therefore still comes from the one authoritative planner, and the journal and checkpoint files stay byte-identical. It refuses unsafe run ids before touching disk, creates nothing for unknown runs, and reports only:

- states and codes
- the latest checkpoint's reason, phase, status and epoch
- bounded operation summaries (kind, journal status, observed status)
- workspace-relative paths

`executableResume` is always `false`.

The UI separates three things a user might mean by "recover":

1. **Restored display.** Already done. It runs nothing.
2. **New task with this context.** Starts a fresh conversation with the inherited turns.
3. **Resume the interrupted run.** Not offered.

`AgentRunner.resumeFromRecovery` exists, but no runtime surface reaches it from the editor. Exposing it would need a new UI-driven authority path: re-establishing the run's tool registry, re-authorizing every `RECONFIRM`/`NEW_EPOCH_AUTHORITY_REQUIRED` approval, and proving no completed side effect replays. That is deferred, and the view states it plainly.

## Consequences

- One more persistent store, with strict separation: display history (ADR-033), agent memory (ADR-013), execution durability and recovery classification (ADR-025).
- The editor can show an interrupted task honestly after a crash or restart without inventing outcomes or authority.
- `RecoveryController.buildRecoveryPlan` gained an opt-out of reconciliation write-back. Its default behaviour is unchanged.
- Secrets typed into the chat are redacted in the saved copy, so a restored conversation shows `[REDACTED]` where the live one showed the value.
- Deferred: executable resume from the editor; cross-window live sync (the last writer wins on the index, and records are self-healing); cloud sync (never by default).
