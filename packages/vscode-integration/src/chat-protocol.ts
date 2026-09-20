export type ChatMode = "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  status?: "pending" | "completed" | "failed" | "cancelled";
}

export interface ChatActivity {
  id: string;
  kind: string;
  label: string;
  status: "pending" | "completed" | "failed";
}

export interface ChatContextChip {
  label: string;
}

export interface TerminalReviewDto {
  executionId: string;
  command: string;
  cwd: string;
  provenance: string;
  timeoutMs: number;
  status: 'PREPARED' | 'WAITING_APPROVAL' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'REJECTED';
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
}

export interface WebviewState {
  conversationId: string;
  mode: ChatMode;
  messages: ChatMessage[];
  activities: ChatActivity[];
  context: ChatContextChip[];
  activeTurn: boolean;
  pendingConfirmation?: ConfirmationRequestPayload;
  activeTerminal?: TerminalReviewDto;
  error?: string;
}

// Webview -> Host
export type WebviewToHostMessage =
  | { type: "chat.ready" }
  | { type: "chat.send"; text: string; mode: ChatMode }
  | { type: "chat.cancel" }
  | { type: "chat.setMode"; mode: ChatMode }
  | { type: "chat.newConversation" }
  | { type: "confirmation.respond"; confirmationId: string; action: "APPROVE" | "REJECT" }
  | { type: "ui.openDiff"; mutationId: string; path: string; isCreate: boolean }
  | { type: "ui.copyCode"; text: string }
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
  | { type: "conversation.reset" }
  | { type: "terminal.updated"; review: TerminalReviewDto };

export function parseWebviewMessage(raw: any): WebviewToHostMessage | null {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;

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
      
    default:
      return null;
  }
}
