import type {
  IntegrationManagerState,
  IntegrationTab,
  CustomModeSummaryDto,
} from "./integrations/integration-manager-controller.js";

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
  status?: "pending" | "completed" | "failed" | "cancelled" | "rejected";
  attachments?: ChatContextChip[];
  /** Copied from an earlier conversation as background context; never re-run. */
  inherited?: boolean;
}

export interface ChatActivity {
  id: string;
  kind: "task" | "context" | "model" | "tool" | "approval" | "mutation" | "verification" | string;
  label: string;
  status: "pending" | "completed" | "failed" | "cancelled" | "interrupted";
  toolName?: string;
  summary?: string;
  /** Agent run that produced this row. Presentation only. */
  runId?: string;
  /** True only when this turn's task mode is PLAN. */
  planning?: boolean;
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
  /** Models the local endpoint actually returned. Absent until a probe succeeds. */
  installedModels?: string[];
  /** Served model name on the chat route, when configuration names one. */
  selectedModel?: string;
  /** Local inference base URL. Never a cloud endpoint. */
  endpoint?: string;
  routingSource?: "workspace-override" | "global" | "discovered" | "none";
  workspaceOverrideActive?: boolean;
  autocompleteModel?: string;
  workspaceTrusted?: boolean;
}

export interface ModelManagerSnapshot {
  source: "workspace-override" | "global" | "discovered" | "none";
  endpoint: string;
  endpointReachable: boolean;
  endpointError?: string;
  installedModels: readonly string[];
  chatModel?: string;
  autocompleteModel?: string;
  globalChatModel?: string;
  globalAutocompleteModel?: string;
  globalEndpoint?: string;
  workspaceOverridePresent: boolean;
  workspaceOverrideActive: boolean;
  workspaceOverrideIgnored: boolean;
  workspaceConfigInvalid: boolean;
  workspaceTrusted: boolean;
  credentialConfigured: boolean;
  advancedActive: boolean;
  notice: string;
  trustNotice?: string;
  open?: boolean;
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
  executable?: string;
  args?: string[];
  scriptName?: string;
  scriptBody?: string;
  startedAt?: number | null;
  outputLimitBytes?: number;
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

export interface MutationSummaryDto {
  operation: "patch" | "create" | string;
  linesAdded?: number;
  linesRemoved?: number;
  beforeHash?: string;
  afterHash?: string;
}

export interface ConfirmationRequestPayload {
  id: string;
  type: string;
  summary: string;
  riskLabel: string;
  mutationId?: string;
  path?: string;
  mutation?: MutationSummaryDto;
  preparedCommand?: TerminalReviewDto;
  responding?: boolean;
  blockedReason?: string;
}

export type ReviewRecordStatus =
  | "pending"
  | "approved"
  | "applied"
  | "verified"
  | "rejected"
  | "cancelled"
  | "stale"
  | "failed"
  | "running"
  | "succeeded"
  | "timed-out"
  /** Restored from history: the editor closed before an outcome was recorded. */
  | "interrupted";

/**
 * One row of the per-conversation "Changes & commands" ledger. A view-model only:
 * diff content and status live in DiffReviewController, command output in
 * TerminalReviewController. Nothing here can approve or apply anything.
 */
export interface ReviewRecordDto {
  id: string;
  kind: "mutation" | "command";
  status: ReviewRecordStatus;
  path?: string;
  mutation?: MutationSummaryDto;
  command?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  detail?: string;
  /** Mutation ids applied before this command ran (command rows only). */
  verifies?: string[];
  /** Latest command that ran after this change was applied (mutation rows only). */
  verifiedBy?: { id: string; command: string; status: ReviewRecordStatus };
  /** False when no retained output exists in this window (e.g. a restored command row). */
  outputAvailable?: boolean;
  /** Agent task id that created this row. Absent on records saved before run correlation. */
  runId?: string;
  /** package.json script name when this command came from a known script. */
  scriptName?: string;
}

/** Stable conversation id; the only form accepted from the webview or used as a file name. */
export const CONVERSATION_ID_PATTERN = /^c-[0-9a-f]{16}$/;

export type ConversationExecutionStatus = "idle" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "rejected";

/** Safe, local metadata for the conversation picker. No message bodies beyond a short redacted preview. */
export interface ConversationSummaryDto {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: ChatMode;
  customModeId?: string;
  messageCount: number;
  lastStatus: ConversationExecutionStatus;
  archived?: boolean;
  preview?: string;
}

export type RecoveryViewState =
  | "NO_RUN"
  | "NO_RECORD"
  | "COMPLETED"
  | "STOPPED"
  | "INTERRUPTED"
  | "REVERIFY"
  | "RECONFIRM"
  | "MANUAL_INSPECTION"
  | "UNREADABLE";

/**
 * Read-only recovery view for one conversation. Built from Agent Core's
 * checkpoint, journal and recovery planner; it carries no authority.
 */
export interface RecoveryStatusDto {
  conversationId: string;
  lastStatus: ConversationExecutionStatus;
  runId?: string;
  state: RecoveryViewState;
  reasons: string[];
  manualInspectionRequired: boolean;
  /** Always false: resuming an interrupted run is not offered from the editor. */
  resumeAvailable: false;
  checkpoint?: { reason: string; phase: string; status: string; createdAt: string; fromEarlierProcess: boolean; awaitingApproval: boolean };
  operations: Array<{ kind: string; journalStatus: string; observedStatus: string; blocked: boolean; path?: string }>;
  files: string[];
}

export interface WebviewState {
  conversationId: string;
  conversationTitle?: string;
  lastStatus?: ConversationExecutionStatus;
  conversations?: ConversationSummaryDto[];
  history?: { enabled: boolean; notice?: string };
  recovery?: RecoveryStatusDto;
  mode: ChatMode;
  customModeId?: string;
  activeCustomProfile?: CustomModeSummaryDto;
  customModes?: CustomModeSummaryDto[];
  messages: ChatMessage[];
  activities: ChatActivity[];
  context: ChatContextChip[];
  attachments: ChatContextChip[];
  /** In-memory composer text shared by sidebar and wide chat. Never persisted. */
  composerDraft?: string;
  activeTurn: boolean;
  pendingConfirmation?: ConfirmationRequestPayload;
  activeTerminal?: TerminalReviewDto;
  reviews?: ReviewRecordDto[];
  error?: string;
  connection?: ConnectionStatus;
  modelManager?: ModelManagerSnapshot;
  workspaceTrusted?: boolean;
  integrations?: IntegrationManagerState;
  integrationsOpen?: boolean;
}

// Webview -> Host
export type WebviewToHostMessage =
  | { type: "chat.ready" }
  | { type: "chat.send"; text: string; mode: ChatMode; customModeId?: string }
  | { type: "chat.draft"; text: string }
  | { type: "chat.cancel" }
  | { type: "chat.setMode"; mode: ChatMode; customModeId?: string }
  | { type: "chat.newConversation" }
  | { type: "chat.checkConnection" }
  | { type: "confirmation.respond"; confirmationId: string; action: "APPROVE" | "REJECT" }
  | { type: "ui.openDiff"; mutationId: string; path: string; isCreate: boolean }
  | { type: "ui.copyCode"; text: string }
  | { type: "ui.openFile"; path: string }
  | { type: "ui.openModelConfig" }
  | { type: "modelManager.open" }
  | { type: "modelManager.close" }
  | { type: "modelManager.refresh" }
  | { type: "modelManager.setChat"; name: string }
  | { type: "modelManager.setAutocomplete"; name: string }
  | { type: "modelManager.setEndpoint"; endpoint: string }
  | { type: "modelManager.test" }
  | { type: "modelManager.suspendOverride" }
  | { type: "modelManager.useOverride" }
  | { type: "modelManager.setAdvanced"; text: string }
  | { type: "modelManager.clearAdvanced" }
  | { type: "modelManager.setCredential"; token: string }
  | { type: "ui.manageTrust" }
  | { type: "ui.openWideChat" }
  | { type: "ui.selectModel" }
  | { type: "ui.applyModel"; name: string }
  | { type: "context.attach"; target: "current-file" | "selection" }
  | { type: "context.attachFile"; path: string }
  | { type: "context.remove"; id: string }
  | { type: "context.search"; query: string }
  | { type: "context.pickFile" }
  | { type: "terminal.respond"; confirmationId: string; action: "APPROVE" | "REJECT" }
  | { type: "terminal.cancel"; executionId: string }
  | { type: "terminal.toggleOutput"; executionId: string }
  | { type: "terminal.copyCommand"; executionId: string }
  | { type: "terminal.copyOutput"; executionId: string }
  | { type: "terminal.openOutput"; executionId: string }
  | { type: "review.openChange"; mutationId: string }
  | { type: "ui.openSourceControl" }
  | { type: "conversation.open"; conversationId: string }
  | { type: "conversation.rename"; conversationId: string; title: string }
  | { type: "conversation.delete"; conversationId: string }
  | { type: "conversation.archive"; conversationId: string; archived: boolean }
  | { type: "conversation.continueFrom"; conversationId: string }
  | { type: "conversation.inspectRecovery"; conversationId: string }
  | { type: "conversation.closeRecovery" }
  | { type: "integration.openHub" }
  | { type: "integration.closeHub" }
  | { type: "integration.setTab"; tab: IntegrationTab }
  | { type: "integration.connectMcp"; serverId: string }
  | { type: "integration.disconnectMcp"; serverId: string }
  | { type: "integration.toggleMcp"; serverId: string; enabled: boolean }
  | { type: "integration.toggleWorkspacePolicy"; serverId: string; enabled: boolean }
  | { type: "integration.inspectTools"; serverId?: string }
  | { type: "integration.promptRemoveServer"; serverId: string; serverName: string }
  | { type: "integration.executeRemoveServer"; serverId: string }
  | { type: "integration.cancelConfirmation" }
  | { type: "integration.refreshDiscovery" }
  | { type: "integration.syncAccount" }
  | { type: "integration.startWizard" }
  | { type: "integration.cancelWizard" }
  | { type: "integration.wizardTransport"; transport: "stdio" | "streamable_http" | "sse" }
  | { type: "integration.wizardDraft"; draft: Record<string, unknown> }
  | { type: "integration.wizardValidate" }
  | { type: "integration.wizardStep"; step: number }
  | { type: "integration.wizardSave"; connectNow: boolean }
  | { type: "integration.inspectSkill"; skillId?: string }
  | { type: "integration.openSkillFile"; skillId: string }
  | { type: "integration.accountLogin"; username: string; password: string; serverUrl?: string }
  | { type: "integration.accountLogout" }
  | { type: "integration.inspectMode"; modeId?: string }
  | { type: "integration.startModeWizard"; modeId?: string }
  | { type: "integration.cancelModeWizard" }
  | { type: "integration.modeWizardDraft"; draft: Record<string, unknown> }
  | { type: "integration.modeWizardStep"; step: number }
  | { type: "integration.modeWizardSave"; activateNow?: boolean }
  | { type: "integration.deleteMode"; modeId: string }
  | { type: "integration.duplicateMode"; modeId: string; targetScope?: "workspace" | "account" }
  | { type: "integration.toggleMode"; modeId: string; enabled: boolean }
  | { type: "integration.setActiveMode"; modeId?: string }
  | { type: "integration.inspectPack"; packId?: string }
  | { type: "integration.importPackPrompt" }
  | { type: "integration.importPack"; manifest: Record<string, unknown> }
  | { type: "integration.installPack"; manifest: Record<string, unknown>; scope?: "workspace" | "account" }
  | { type: "integration.enablePack"; packId: string }
  | { type: "integration.disablePack"; packId: string }
  | { type: "integration.activatePack"; packId: string }
  | { type: "integration.updatePack"; packId: string; manifest: Record<string, unknown> }
  | { type: "integration.rollbackPack"; packId: string }
  | { type: "integration.removePack"; packId: string }
  | { type: "ui.openBrowserPanel" };

// Host -> Webview
export type HostToWebviewMessage =
  | { type: "chat.state"; state: WebviewState; wideOpen?: boolean }
  /** Sprint 7D: the transcript is unchanged since the last post, so it is omitted; the webview keeps its own. */
  | { type: "chat.state"; state: Omit<WebviewState, "messages">; transcript: "unchanged"; wideOpen?: boolean }
  | { type: "integration.state"; state: IntegrationManagerState; open: boolean }
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

    case "chat.draft": {
      if (typeof raw.text !== "string" || raw.text.length > 50000) return null;
      return { type: "chat.draft", text: raw.text };
    }
      
    case "chat.send": {
      if (typeof raw.text !== 'string') return null;
      const text = raw.text.trim();
      if (!text || text.length > 50000) return null;
      if (!validModes.includes(raw.mode)) return null;
      const customModeId = typeof raw.customModeId === 'string' && raw.customModeId.length <= 100 ? raw.customModeId : undefined;
      return { type: "chat.send", text, mode: raw.mode as ChatMode, customModeId };
    }
      
    case "chat.cancel":
      return { type: "chat.cancel" };
      
    case "chat.setMode": {
      if (!validModes.includes(raw.mode)) return null;
      const customModeId = typeof raw.customModeId === 'string' && raw.customModeId.length <= 100 ? raw.customModeId : undefined;
      return { type: "chat.setMode", mode: raw.mode as ChatMode, customModeId };
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

    case "terminal.copyOutput":
    case "terminal.openOutput": {
      if (typeof raw.executionId !== 'string' || !raw.executionId || raw.executionId.length > 100) return null;
      return { type: raw.type, executionId: raw.executionId };
    }

    case "review.openChange": {
      if (typeof raw.mutationId !== 'string' || !raw.mutationId || raw.mutationId.length > 100) return null;
      return { type: "review.openChange", mutationId: raw.mutationId };
    }

    case "ui.openSourceControl":
      return { type: "ui.openSourceControl" };

    case "conversation.open":
    case "conversation.delete":
    case "conversation.continueFrom":
    case "conversation.inspectRecovery": {
      if (typeof raw.conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(raw.conversationId)) return null;
      return { type: raw.type, conversationId: raw.conversationId };
    }

    case "conversation.rename": {
      if (typeof raw.conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(raw.conversationId)) return null;
      if (typeof raw.title !== 'string' || raw.title.length > 500) return null;
      return { type: "conversation.rename", conversationId: raw.conversationId, title: raw.title };
    }

    case "conversation.archive": {
      if (typeof raw.conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(raw.conversationId)) return null;
      if (typeof raw.archived !== 'boolean') return null;
      return { type: "conversation.archive", conversationId: raw.conversationId, archived: raw.archived };
    }

    case "conversation.closeRecovery":
      return { type: "conversation.closeRecovery" };
      
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

    case "modelManager.open":
      return { type: "modelManager.open" };

    case "modelManager.close":
      return { type: "modelManager.close" };

    case "modelManager.refresh":
      return { type: "modelManager.refresh" };

    case "modelManager.test":
      return { type: "modelManager.test" };

    case "modelManager.suspendOverride":
      return { type: "modelManager.suspendOverride" };

    case "modelManager.useOverride":
      return { type: "modelManager.useOverride" };

    case "modelManager.clearAdvanced":
      return { type: "modelManager.clearAdvanced" };

    case "modelManager.setChat":
    case "modelManager.setAutocomplete": {
      if (typeof raw.name !== "string") return null;
      const name = raw.name.trim();
      if (!/^[A-Za-z0-9_.:@+-]{1,128}$/.test(name)) return null;
      return raw.type === "modelManager.setChat"
        ? { type: "modelManager.setChat", name }
        : { type: "modelManager.setAutocomplete", name };
    }

    case "modelManager.setEndpoint": {
      if (typeof raw.endpoint !== "string") return null;
      const endpoint = raw.endpoint.trim();
      if (!endpoint || endpoint.length > 200) return null;
      return { type: "modelManager.setEndpoint", endpoint };
    }

    case "modelManager.setAdvanced": {
      if (typeof raw.text !== "string" || raw.text.length > 64000) return null;
      return { type: "modelManager.setAdvanced", text: raw.text };
    }

    case "modelManager.setCredential": {
      if (typeof raw.token !== "string" || raw.token.length > 4096) return null;
      return { type: "modelManager.setCredential", token: raw.token };
    }

    case "ui.manageTrust":
      return { type: "ui.manageTrust" };

    case "ui.openWideChat":
      return { type: "ui.openWideChat" };

    case "ui.selectModel":
      return { type: "ui.selectModel" };

    case "ui.applyModel": {
      if (typeof raw.name !== "string") return null;
      const name = raw.name.trim();
      if (!/^[A-Za-z0-9_.:@+-]{1,128}$/.test(name)) return null;
      return { type: "ui.applyModel", name };
    }

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

    case "integration.openHub":
      return { type: "integration.openHub" };

    case "integration.closeHub":
      return { type: "integration.closeHub" };

    case "integration.setTab": {
      const validTabs = ["profile", "mcp", "skills", "modes", "diagnostics"];
      if (typeof raw.tab !== "string" || !validTabs.includes(raw.tab)) return null;
      return { type: "integration.setTab", tab: raw.tab as IntegrationTab };
    }

    case "integration.connectMcp": {
      if (typeof raw.serverId !== "string" || !raw.serverId || raw.serverId.length > 200) return null;
      return { type: "integration.connectMcp", serverId: raw.serverId };
    }

    case "integration.disconnectMcp": {
      if (typeof raw.serverId !== "string" || !raw.serverId || raw.serverId.length > 200) return null;
      return { type: "integration.disconnectMcp", serverId: raw.serverId };
    }

    case "integration.toggleMcp": {
      if (typeof raw.serverId !== "string" || typeof raw.enabled !== "boolean") return null;
      return { type: "integration.toggleMcp", serverId: raw.serverId, enabled: raw.enabled };
    }

    case "integration.toggleWorkspacePolicy": {
      if (typeof raw.serverId !== "string" || typeof raw.enabled !== "boolean") return null;
      return { type: "integration.toggleWorkspacePolicy", serverId: raw.serverId, enabled: raw.enabled };
    }

    case "integration.inspectTools": {
      const serverId = typeof raw.serverId === "string" ? raw.serverId : undefined;
      return { type: "integration.inspectTools", serverId };
    }

    case "integration.promptRemoveServer": {
      if (typeof raw.serverId !== "string" || typeof raw.serverName !== "string") return null;
      return { type: "integration.promptRemoveServer", serverId: raw.serverId, serverName: raw.serverName };
    }

    case "integration.executeRemoveServer": {
      if (typeof raw.serverId !== "string") return null;
      return { type: "integration.executeRemoveServer", serverId: raw.serverId };
    }

    case "integration.cancelConfirmation":
      return { type: "integration.cancelConfirmation" };

    case "integration.refreshDiscovery":
      return { type: "integration.refreshDiscovery" };

    case "integration.syncAccount":
      return { type: "integration.syncAccount" };

    case "integration.startWizard":
      return { type: "integration.startWizard" };

    case "integration.cancelWizard":
      return { type: "integration.cancelWizard" };

    case "integration.wizardTransport": {
      const validTransports = ["stdio", "streamable_http", "sse"];
      if (typeof raw.transport !== "string" || !validTransports.includes(raw.transport)) return null;
      return { type: "integration.wizardTransport", transport: raw.transport as any };
    }

    case "integration.wizardDraft": {
      if (!raw.draft || typeof raw.draft !== "object") return null;
      return { type: "integration.wizardDraft", draft: raw.draft };
    }

    case "integration.wizardValidate":
      return { type: "integration.wizardValidate" };

    case "integration.wizardStep": {
      if (typeof raw.step !== "number" || raw.step < 1 || raw.step > 5) return null;
      return { type: "integration.wizardStep", step: raw.step };
    }

    case "integration.wizardSave": {
      return { type: "integration.wizardSave", connectNow: Boolean(raw.connectNow) };
    }

    case "integration.inspectSkill": {
      const skillId = typeof raw.skillId === "string" ? raw.skillId : undefined;
      return { type: "integration.inspectSkill", skillId };
    }

    case "integration.openSkillFile": {
      if (typeof raw.skillId !== "string" || !raw.skillId) return null;
      return { type: "integration.openSkillFile", skillId: raw.skillId };
    }

    case "integration.accountLogin": {
      if (typeof raw.username !== "string" || typeof raw.password !== "string") return null;
      const serverUrl = typeof raw.serverUrl === "string" ? raw.serverUrl : undefined;
      return {
        type: "integration.accountLogin",
        username: raw.username,
        password: raw.password,
        serverUrl,
      };
    }

    case "integration.accountLogout":
      return { type: "integration.accountLogout" };

    case "integration.inspectMode": {
      const modeId = typeof raw.modeId === "string" ? raw.modeId : undefined;
      return { type: "integration.inspectMode", modeId };
    }

    case "integration.startModeWizard": {
      const modeId = typeof raw.modeId === "string" ? raw.modeId : undefined;
      return { type: "integration.startModeWizard", modeId };
    }

    case "integration.cancelModeWizard":
      return { type: "integration.cancelModeWizard" };

    case "integration.modeWizardDraft": {
      if (!raw.draft || typeof raw.draft !== "object") return null;
      return { type: "integration.modeWizardDraft", draft: raw.draft };
    }

    case "integration.modeWizardStep": {
      if (typeof raw.step !== "number" || raw.step < 1 || raw.step > 9) return null;
      return { type: "integration.modeWizardStep", step: raw.step };
    }

    case "integration.modeWizardSave": {
      return { type: "integration.modeWizardSave", activateNow: Boolean(raw.activateNow) };
    }

    case "integration.deleteMode": {
      if (typeof raw.modeId !== "string" || !raw.modeId) return null;
      return { type: "integration.deleteMode", modeId: raw.modeId };
    }

    case "integration.duplicateMode": {
      if (typeof raw.modeId !== "string" || !raw.modeId) return null;
      const targetScope = raw.targetScope === "workspace" || raw.targetScope === "account" ? raw.targetScope : undefined;
      return { type: "integration.duplicateMode", modeId: raw.modeId, targetScope };
    }

    case "integration.toggleMode": {
      if (typeof raw.modeId !== "string" || typeof raw.enabled !== "boolean") return null;
      return { type: "integration.toggleMode", modeId: raw.modeId, enabled: raw.enabled };
    }

    case "integration.setActiveMode": {
      const modeId = typeof raw.modeId === "string" && raw.modeId ? raw.modeId : undefined;
      return { type: "integration.setActiveMode", modeId };
    }

    case "integration.inspectPack": {
      const packId = typeof raw.packId === "string" && raw.packId ? raw.packId : undefined;
      return { type: "integration.inspectPack", packId };
    }

    case "integration.importPackPrompt": {
      return { type: "integration.importPackPrompt" };
    }

    case "integration.importPack": {
      if (!raw.manifest || typeof raw.manifest !== "object") return null;
      return { type: "integration.importPack", manifest: raw.manifest as Record<string, unknown> };
    }

    case "integration.installPack": {
      if (!raw.manifest || typeof raw.manifest !== "object") return null;
      const scope = raw.scope === "account" ? "account" : "workspace";
      return { type: "integration.installPack", manifest: raw.manifest as Record<string, unknown>, scope };
    }

    case "integration.enablePack": {
      if (typeof raw.packId !== "string" || !raw.packId) return null;
      return { type: "integration.enablePack", packId: raw.packId };
    }

    case "integration.disablePack": {
      if (typeof raw.packId !== "string" || !raw.packId) return null;
      return { type: "integration.disablePack", packId: raw.packId };
    }

    case "integration.activatePack": {
      if (typeof raw.packId !== "string" || !raw.packId) return null;
      return { type: "integration.activatePack", packId: raw.packId };
    }

    case "integration.updatePack": {
      if (typeof raw.packId !== "string" || !raw.packId || !raw.manifest || typeof raw.manifest !== "object") return null;
      return { type: "integration.updatePack", packId: raw.packId, manifest: raw.manifest as Record<string, unknown> };
    }

    case "integration.rollbackPack": {
      if (typeof raw.packId !== "string" || !raw.packId) return null;
      return { type: "integration.rollbackPack", packId: raw.packId };
    }

    case "integration.removePack": {
      if (typeof raw.packId !== "string" || !raw.packId) return null;
      return { type: "integration.removePack", packId: raw.packId };
    }

    case "ui.openBrowserPanel": {
      return { type: "ui.openBrowserPanel" };
    }
      
    default:
      return null;
  }
}
