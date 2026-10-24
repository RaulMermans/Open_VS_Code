export type ChatMode = "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";

export type InferenceBackend = "standalone-local" | "halo" | "unknown";

export type ConnectionAvailability =
  | "ready"
  | "running"
  | "disconnected"
  | "unavailable"
  | "missing-config"
  | "invalid-credentials"
  | "model-unavailable"
  | "timeout";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  status?: "pending" | "completed" | "failed" | "cancelled";
  attachments?: ChatContextChip[];
}

export interface ChatActivity {
  id: string;
  kind: "task" | "context" | "model" | "tool" | "approval" | "mutation" | "verification" | string;
  label: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  toolName?: string;
  summary?: string;
}

export interface ChatContextChip {
  id?: string;
  kind?: "workspace" | "active-file" | "selection" | "file" | "diagnostics" | "implicit";
  label: string;
  path?: string;
  removable?: boolean;
  truncated?: boolean;
  unavailable?: boolean;
  reason?: string;
}

export interface ConnectionStatus {
  state: ConnectionAvailability;
  backend: InferenceBackend;
  modelLabel?: string;
  providerLabel?: string;
  detail?: string;
  healthChecked: boolean;
  actionable: "none" | "open-config" | "create-config" | "check-connection";
}

export interface FileSearchHit {
  path: string;
  label: string;
  unavailable?: boolean;
  reason?: string;
}

export interface TerminalReviewDto {
  executionId: string;
  command: string;
  cwd: string;
  provenance: string;
  timeoutMs: number;
  status: 'WAITING_APPROVAL' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'REJECTED';
  exitCode?: number | null;
  exitSignal?: string | null;
  durationMs?: number | null;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  isOutputVisible?: boolean;
}

export interface ConfirmationRequestPayload {
  id: string;
  type: string;
  summary: string;
  riskLabel: string;
  mutationId?: string;
  path?: string;
  preparedCommand?: TerminalReviewDto;
  responding?: boolean;
}

export interface WebviewState {
  conversationId: string;
  mode: ChatMode;
  messages: ChatMessage[];
  activities: ChatActivity[];
  context: ChatContextChip[];
  attachments: ChatContextChip[];
  activeTurn: boolean;
  pendingConfirmation?: ConfirmationRequestPayload;
  activeTerminal?: TerminalReviewDto;
  error?: string;
  connection?: ConnectionStatus;
}

// Webview -> Host
export type WebviewToHostMessage =
  | { type: "chat.ready" }
  | { type: "chat.send"; text: string; mode: ChatMode }
  | { type: "chat.cancel" }
  | { type: "chat.setMode"; mode: ChatMode }
  | { type: "chat.newConversation" }
  | { type: "chat.checkConnection" }
  | { type: "confirmation.respond"; confirmationId: string; action: "APPROVE" | "REJECT" }
  | { type: "ui.openDiff"; mutationId: string; path: string; isCreate: boolean }
  | { type: "ui.copyCode"; text: string }
  | { type: "ui.openFile"; path: string }
  | { type: "ui.openModelConfig" }
  | { type: "context.attach"; target: "current-file" | "selection" }
  | { type: "context.attachFile"; path: string }
  | { type: "context.remove"; id: string }
  | { type: "context.search"; query: string }
  | { type: "context.pickFile" }
  | { type: "terminal.respond"; confirmationId: string; action: "APPROVE" | "REJECT" }
  | { type: "terminal.cancel"; executionId: string }
  | { type: "terminal.toggleOutput"; executionId: string }
  | { type: "terminal.copyCommand"; executionId: string };

// Host -> Webview
export type HostToWebviewMessage =
  | { type: "chat.state"; state: WebviewState }
  | { type: "turn.started" }
  | { type: "turn.status"; activity: ChatActivity }
  | { type: "turn.completed"; message: ChatMessage }
  | { type: "turn.failed"; error: string }
  | { type: "turn.cancelled" }
  | { type: "confirmation.requested"; request: ConfirmationRequestPayload }
  | { type: "confirmation.resolved"; action: "APPROVE" | "REJECT" }
  | { type: "context.updated"; context: ChatContextChip[] }
  | { type: "context.searchResults"; query: string; files: FileSearchHit[] }
  | { type: "conversation.reset" }
  | { type: "terminal.updated"; review?: TerminalReviewDto; terminal?: TerminalReviewDto };

export function parseWebviewMessage(raw: any): WebviewToHostMessage | null {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;

  // Prototype pollution guard: reject payloads that carry dangerous prototype-mutation keys.
  // We check own-property names because JSON.parse never sets non-own properties, but a
  // crafted Uint8Array or structuredClone result could include these as own keys.
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
  for (const key of dangerousKeys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return null;
  }

  const validModes = ["ASK", "PLAN", "BUILD", "DEBUG", "REVIEW"];

  switch (raw.type) {
    case "chat.ready":
      return { type: "chat.ready" };
      
    case "chat.send": {
      if (typeof raw.text !== 'string') return null;
      const text = raw.text.trim();
      if (!text || text.length > 50000) return null;
      if (!validModes.includes(raw.mode)) return null;
      return { type: "chat.send", text, mode: raw.mode as ChatMode };
    }
      
    case "chat.cancel":
      return { type: "chat.cancel" };
      
    case "chat.setMode": {
      if (!validModes.includes(raw.mode)) return null;
      return { type: "chat.setMode", mode: raw.mode as ChatMode };
    }
      
    case "chat.newConversation":
      return { type: "chat.newConversation" };

    case "chat.checkConnection":
      return { type: "chat.checkConnection" };
      
    case "confirmation.respond": {
      if (typeof raw.confirmationId !== 'string' || !raw.confirmationId || raw.confirmationId.length > 100) return null;
      if (raw.action !== "APPROVE" && raw.action !== "REJECT") return null;
      return { type: "confirmation.respond", confirmationId: raw.confirmationId, action: raw.action };
    }

    case "terminal.respond": {
      if (typeof raw.confirmationId !== 'string' || !raw.confirmationId || raw.confirmationId.length > 100) return null;
      if (raw.action !== "APPROVE" && raw.action !== "REJECT") return null;
      return { type: "terminal.respond", confirmationId: raw.confirmationId, action: raw.action };
    }

    case "terminal.cancel": {
      if (typeof raw.executionId !== 'string' || !raw.executionId || raw.executionId.length > 100) return null;
      return { type: "terminal.cancel", executionId: raw.executionId };
    }

    case "terminal.toggleOutput": {
      if (typeof raw.executionId !== 'string' || !raw.executionId || raw.executionId.length > 100) return null;
      return { type: "terminal.toggleOutput", executionId: raw.executionId };
    }

    case "terminal.copyCommand": {
      if (typeof raw.executionId !== 'string' || !raw.executionId || raw.executionId.length > 100) return null;
      return { type: "terminal.copyCommand", executionId: raw.executionId };
    }
      
    case "ui.openDiff": {
      if (typeof raw.mutationId !== 'string' || !raw.mutationId) return null;
      if (typeof raw.path !== 'string' || !raw.path) return null;
      if (typeof raw.isCreate !== 'boolean') return null;
      return { type: "ui.openDiff", mutationId: raw.mutationId, path: raw.path, isCreate: raw.isCreate };
    }

    case "ui.copyCode": {
      if (typeof raw.text !== 'string' || raw.text.length > 200000) return null;
      return { type: "ui.copyCode", text: raw.text };
    }

    case "ui.openFile": {
      if (typeof raw.path !== 'string' || !raw.path || raw.path.length > 500) return null;
      if (raw.path.includes('\0') || raw.path.includes('://')) return null;
      return { type: "ui.openFile", path: raw.path };
    }

    case "ui.openModelConfig":
      return { type: "ui.openModelConfig" };

    case "context.attach": {
      if (raw.target !== "current-file" && raw.target !== "selection") return null;
      return { type: "context.attach", target: raw.target };
    }

    case "context.attachFile": {
      if (typeof raw.path !== 'string' || !raw.path || raw.path.length > 500) return null;
      if (raw.path.includes('\0') || raw.path.includes('://')) return null;
      return { type: "context.attachFile", path: raw.path };
    }

    case "context.remove": {
      if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 100) return null;
      return { type: "context.remove", id: raw.id };
    }

    case "context.search": {
      if (typeof raw.query !== 'string') return null;
      const query = raw.query.trim();
      if (!query || query.length > 80) return null;
      return { type: "context.search", query };
    }

    case "context.pickFile":
      return { type: "context.pickFile" };
      
    default:
      return null;
  }
}
