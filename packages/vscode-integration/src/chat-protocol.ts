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

export interface ConfirmationRequestPayload {
  id: string;
  type: string;
  summary: string;
  riskLabel: string;
}

export interface WebviewState {
  conversationId: string;
  mode: ChatMode;
  messages: ChatMessage[];
  activities: ChatActivity[];
  context: ChatContextChip[];
  activeTurn: boolean;
  pendingConfirmation?: ConfirmationRequestPayload;
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
  | { type: "ui.copyCode"; text: string };

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
  | { type: "conversation.reset" };
