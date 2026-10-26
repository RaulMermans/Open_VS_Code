import * as vscode from 'vscode';
import { AgentSessionBridge, IdeContextSnapshot, resolveWorkspaceRoot } from '@open-vs-code/ide-adapter';
import { AgentEvent, ConversationTurn, inspectRunRecovery, type RunRecoveryInspection, type ResolvedExecutionProfile } from '@open-vs-code/agent-core';
import { WebviewState, ChatMode, ChatMessage, ChatActivity, WebviewToHostMessage, HostToWebviewMessage, parseWebviewMessage, TerminalReviewDto, FileSearchHit, ReviewRecordDto, MutationSummaryDto, ConversationExecutionStatus, ConversationSummaryDto, RecoveryStatusDto } from './chat-protocol.js';
import { IntegrationManagerController } from './integrations/integration-manager-controller.js';
import { ModeService } from './modes/mode-service.js';
import {
  ConversationStore,
  MAX_RUN_IDS,
  deriveTitle,
  newConversationId,
  normalizeTitle,
  prepareForRestore,
  type PersistedConversation,
  type StoreIssue,
} from './conversation-store.js';
import { DiffReviewController, ReviewStatus } from './diff-review-controller.js';
import { TerminalReviewController, TerminalReviewEntry, formatTerminalTranscript } from './terminal-review-controller.js';
import {
  activityFromAgentEvent,
  classifyTurnError,
  deriveConnectionStatus,
  describeAttachment,
  formatAttachmentInstruction,
  implicitContextChips,
  removeAttachment,
  sanitizeRelativePath,
  sanitizeSearchQuery,
  upsertAttachment,
  MAX_FILE_SEARCH_RESULTS,
  type ConnectionSnapshotInput,
} from './chat-ux-model.js';
import {
  MAX_REVIEW_RECORDS,
  describeMutationFailure,
  reviewStatusFromMutation,
  reviewStatusFromTerminal,
  terminalOutputSignature,
} from './review-model.js';

/** Activity rows kept for the timeline (the webview shows the last 20). */
const MAX_ACTIVITIES = 50;

/** Sprint 7D responsiveness counters: numbers only, no prompts, paths or output. */
export interface ChatUiMetrics {
  /** chat.state messages produced (posted when a view is attached). */
  statePosts: number;
  /** Of those, posts that carried the transcript. */
  transcriptPosts: number;
  /** Editor context refreshes that changed nothing and posted nothing. */
  contextRefreshesSkipped: number;
  peakMessages: number;
  peakActivities: number;
  turns: number;
  lastTurnMs: number;
  maxTurnMs: number;
  /** From the cancel request to the turn settling; -1 until a turn is cancelled. */
  lastCancelLatencyMs: number;
  saves: number;
  saveFailures: number;
  lastSaveMs: number;
  maxSaveMs: number;
}

function emptyUiMetrics(): ChatUiMetrics {
  return {
    statePosts: 0, transcriptPosts: 0, contextRefreshesSkipped: 0, peakMessages: 0, peakActivities: 0,
    turns: 0, lastTurnMs: 0, maxTurnMs: 0, lastCancelLatencyMs: -1, saves: 0, saveFailures: 0, lastSaveMs: 0, maxSaveMs: 0,
  };
}

export class ChatController {
  private state: WebviewState;
  private bridgeFactory: (options: { host: any, workspaceRoot: string, mode: ChatMode }) => AgentSessionBridge;
  private host: any; // VSCodeIdeHost
  private diffReviewController: DiffReviewController;
  private terminalReviewController: TerminalReviewController;
  private _webviewView?: vscode.WebviewView;
  private _webviewMessageDisposable?: { dispose: () => void };
  private _webviewDisposeDisposable?: { dispose: () => void };
  private _activeAbortController?: AbortController;
  private _activeSessionBridge?: AgentSessionBridge;
  private _confirmationResolver?: (value: "APPROVE" | "REJECT") => void;
  private _confirmationInFlight = false;
  private _connectionInput: ConnectionSnapshotInput = {};
  /** Mutations applied since the last approved verification, for the review ledger. */
  private _appliedSinceVerification: string[] = [];
  private _approvedMutations = new Set<string>();
  private _lastTerminalSignature = '';
  private _outputChannel?: { appendLine: (s: string) => void; show: (preserveFocus?: boolean) => void; dispose: () => void };
  /** Sprint 7C: visible history for this workspace. Undefined means history is not saved. */
  private _store?: ConversationStore;
  private _meta: { createdAt: number; title?: string; titleSource: 'auto' | 'user'; runIds: string[] } = { createdAt: Date.now(), titleSource: 'auto', runIds: [] };
  private _persistChain: Promise<void> = Promise.resolve();
  private _historyReady: Promise<void> = Promise.resolve();
  /** Strictly increasing save time, so "most recent first" never ties within a millisecond. */
  private _lastStamp = 0;
  /** What the webview last received of the transcript (shallow copies), so unchanged transcripts are not re-sent. */
  private _sentTranscript?: ChatMessage[];
  private _metrics: ChatUiMetrics = emptyUiMetrics();
  private _turnStartedAt = 0;
  private _cancelRequestedAt = 0;
  /** Seam for tests; production uses Agent Core's read-only recovery inspection. */
  public recoveryInspector: (options: { workspaceRoot: string; runId: string }) => Promise<RunRecoveryInspection> = inspectRunRecovery;
  
  constructor(host: any, arg2: any, arg3?: any, arg4?: any) {
    this.host = host;
    if (typeof arg2 === 'function') {
      this.bridgeFactory = arg2;
      this.diffReviewController = { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {}, setStatus: () => {}, getStatus: () => undefined } as any;
      this.terminalReviewController = new TerminalReviewController();
    } else {
      this.diffReviewController = arg2;
      if (typeof arg3 === 'function') {
        this.bridgeFactory = arg3;
        this.terminalReviewController = arg4 || new TerminalReviewController();
      } else {
        this.terminalReviewController = arg3 || new TerminalReviewController();
        this.bridgeFactory = arg4;
      }
    }
    
    this.state = {
      conversationId: newConversationId(),
      conversationTitle: 'New conversation',
      lastStatus: 'idle',
      conversations: [],
      history: { enabled: false, notice: 'History is not saved in this window.' },
      mode: 'ASK',
      messages: [],
      activities: [],
      context: [],
      attachments: [],
      activeTurn: false,
      connection: deriveConnectionStatus(this._connectionInput),
      reviews: [],
    };
  }

  /** Resolves once stored history has been loaded (or immediately when there is none). */
  public get historyReady(): Promise<void> {
    return this._historyReady;
  }

  public getState(): Readonly<WebviewState> {
    return this.state;
  }

  private _integrationManager?: IntegrationManagerController;
  private _modeService?: ModeService;
  private _integrationsOpen = false;

  public attachModeService(service: ModeService): void {
    this._modeService = service;
    this.syncActiveModeFromManager();
  }

  public attachIntegrationManager(manager: IntegrationManagerController): void {
    this._integrationManager = manager;
    if (!this._modeService) {
      this._modeService = manager.getModeService();
    }
    manager.onStateChange((state) => {
      this.state.integrations = state;
      this.state.integrationsOpen = this._integrationsOpen;
      this.state.customModes = state.modes;
      this.syncActiveModeFromManager();
      this.sendMessage({
        type: "integration.state",
        state,
        open: this._integrationsOpen,
      });
    });
    manager.onAccountStateChange(() => {
      if (this.state.activeTurn) {
        this.cancelTurn();
      }
    });
  }

  public syncActiveModeFromManager(): void {
    const service = this._modeService || this._integrationManager?.getModeService();
    const modeId = this.state.customModeId || this._integrationManager?.getActiveModeId();
    if (service && modeId) {
      const existing = (this.state.customModes || []).find((m) => m.id === modeId);
      if (existing) {
        this.state.customModeId = existing.id;
        this.state.mode = existing.baseMode;
        this.state.activeCustomProfile = { ...existing, isActive: true };
        return;
      }
      const profile = service.getMode(modeId);
      if (profile && profile.enabled) {
        this.state.customModeId = profile.id;
        this.state.mode = profile.baseMode;
        this.state.activeCustomProfile = {
          id: profile.id,
          name: profile.name,
          description: profile.description,
          icon: profile.icon,
          version: profile.version,
          source: profile.source,
          baseMode: profile.baseMode,
          scope: profile.scope,
          enabled: profile.enabled,
          isReady: true,
          isActive: true,
          requiredSkillCount: profile.requiredSkills?.length || 0,
          requiredMcpCount: profile.requiredMcpServers?.length || 0,
          missingRequiredCount: 0,
          diagnostics: [],
        };
        return;
      }
    }
    if (!this.state.customModeId) {
      this.state.activeCustomProfile = undefined;
    }
  }

  public getIntegrationManager(): IntegrationManagerController | undefined {
    return this._integrationManager;
  }

  public async openIntegrationsHub(): Promise<void> {
    this._integrationsOpen = true;
    this.state.integrationsOpen = true;
    if (this._integrationManager) {
      this.state.integrations = await this._integrationManager.getState();
      this.sendMessage({
        type: "integration.state",
        state: this.state.integrations,
        open: true,
      });
    } else {
      this.sendState();
    }
  }

  public async closeIntegrationsHub(): Promise<void> {
    this._integrationsOpen = false;
    this.state.integrationsOpen = false;
    if (this._integrationManager) {
      this.state.integrations = await this._integrationManager.getState();
      this.sendMessage({
        type: "integration.state",
        state: this.state.integrations,
        open: false,
      });
    } else {
      this.sendState();
    }
  }

  public listConversations(): ConversationSummaryDto[] {
    return this._store ? this._store.list() : [];
  }

  public setHistoryUnavailable(notice: string): void {
    this._store = undefined;
    this.state.history = { enabled: false, notice };
    this.sendState();
  }

  /**
   * Binds this window's conversation store and reopens the most recent
   * conversation as display history. Nothing is resumed or re-approved.
   */
  public attachConversationStore(store: ConversationStore): Promise<void> {
    this._store = store;
    this._historyReady = (async () => {
      try {
        const { conversations, issues } = await store.load();
        this.state.history = { enabled: true, notice: describeStoreIssues(issues) };
        this.state.conversations = conversations;
        const latest = conversations.find((c) => !c.archived);
        // Only restore into an untouched window.
        if (latest && !this.state.activeTurn && this.state.messages.length === 0) {
          const record = await store.read(latest.id);
          if (record && !this.state.activeTurn && this.state.messages.length === 0) this.loadConversation(record);
        }
      } catch (e: any) {
        this.state.history = { enabled: false, notice: 'Conversation history could not be loaded (' + storeErrorCode(e) + '). New conversations are not saved.' };
        this._store = undefined;
      }
      this.sendState();
    })();
    return this._historyReady;
  }

  /** Waits for every queued history write. */
  public async flushPersistence(): Promise<void> {
    await this._persistChain;
    await this._store?.flush();
  }

  public dispose(): void {
    this._outputChannel?.dispose();
    this._outputChannel = undefined;
    this._webviewMessageDisposable?.dispose();
    this._webviewDisposeDisposable?.dispose();
    this._webviewMessageDisposable = undefined;
    this._webviewDisposeDisposable = undefined;
    this._webviewView = undefined;
    this.cancelTurn();
  }

  public getTerminalReviewController(): TerminalReviewController {
    return this.terminalReviewController;
  }

  public async requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT"> {
    if (!this.state.activeTurn) {
      return "REJECT";
    }
    // The runner asks for one decision at a time. A second request while one is
    // pending is anomalous: refuse it rather than orphan the first decision.
    if (this._confirmationResolver || this.state.pendingConfirmation) {
      return "REJECT";
    }

    const isWriteFile = payload?.action === 'write_file' || payload?.operation === 'patch' || payload?.operation === 'create';
    const isVerification = payload?.action === 'run_known_test' || payload?.action === 'run_verification' || Boolean(payload?.preparedCommand);
    this.pushActivity({
      type: 'permission.requested',
      payload: { name: isVerification ? 'verification' : isWriteFile ? 'write_file' : 'confirmation' },
    });
    const confirmationId = this.generateId();
    const mutationId = payload?.id || confirmationId;
    const reviewData = payload?.reviewPayload || payload;

    let mutationSummary: MutationSummaryDto | undefined;
    if (isWriteFile && reviewData) {
      this.diffReviewController?.registerReview?.(
        mutationId,
        reviewData.beforeContent || '',
        reviewData.proposedContent || ''
      );
      mutationSummary = {
        operation: reviewData.operation || payload?.operation || (payload?.action === 'write_file' ? 'patch' : 'unknown'),
        linesAdded: typeof reviewData.linesAdded === 'number' ? reviewData.linesAdded : undefined,
        linesRemoved: typeof reviewData.linesRemoved === 'number' ? reviewData.linesRemoved : undefined,
        beforeHash: typeof reviewData.beforeHash === 'string' ? reviewData.beforeHash : undefined,
        afterHash: typeof reviewData.afterHash === 'string' ? reviewData.afterHash : undefined,
      };
      this.upsertReview({
        id: mutationId,
        kind: 'mutation',
        status: 'pending',
        path: payload?.path || payload?.reviewPayload?.path,
        mutation: mutationSummary,
      });
    }

    let preparedCommandDto: TerminalReviewDto | undefined;
    if (isVerification) {
      const pc = payload?.preparedCommand || payload;
      if (
        !pc ||
        typeof pc.verificationId !== 'string' ||
        !pc.verificationId.trim() ||
        typeof pc.executable !== 'string' ||
        !pc.executable.trim() ||
        !Array.isArray(pc.args) ||
        typeof pc.cwd !== 'string' ||
        !pc.cwd.trim()
      ) {
        return "REJECT";
      }

      const cmdExecutable = pc.executable.trim();
      const cmdArgs = pc.args.map(String);
      const commandPreview = pc.commandPreview || `${cmdExecutable} ${cmdArgs.join(' ')}`.trim();
      const timeoutMs = typeof pc.timeoutMs === 'number' && pc.timeoutMs > 0 ? pc.timeoutMs : 60000;
      const cwd = pc.cwd.trim();
      const provenance = pc.scriptName ? `package.json [${pc.scriptName}]` : (pc.provenance || 'Verification Runner');

      const entry = this.terminalReviewController.registerPreparedCommand({
        confirmationId,
        // Preserve canonical verificationId as executionId so identity survives
        // PreparedVerification → TerminalReview → verification.output → verification.completed
        executionId: pc.verificationId.trim(),
        command: commandPreview,
        cwd,
        provenance,
        timeoutMs,
        executable: cmdExecutable,
        args: cmdArgs,
        packageJsonPath: pc.packageJsonPath,
        packageJsonHash: pc.packageJsonHash,
        scriptName: pc.scriptName,
        scriptBody: pc.scriptBody,
      });

      preparedCommandDto = this.terminalDto(entry);
      this.state.activeTerminal = preparedCommandDto;
      this.upsertReview({
        id: entry.executionId,
        kind: 'command',
        status: 'pending',
        command: entry.command,
        verifies: this._appliedSinceVerification.length ? this._appliedSinceVerification.slice() : undefined,
      });
    }

    this._confirmationInFlight = false;
    this.state.pendingConfirmation = {
      id: confirmationId,
      type: payload?.action || payload?.operation || (isVerification ? 'run_known_test' : 'unknown'),
      summary: prompt,
      riskLabel: isWriteFile ? 'High Risk Mutation' : isVerification ? 'Controlled Verification Terminal' : 'Verification/External',
      mutationId: isWriteFile ? mutationId : undefined,
      path: payload?.path || payload?.reviewPayload?.path,
      mutation: mutationSummary,
      preparedCommand: preparedCommandDto,
      responding: false,
    };

    // The ledger row (never the decision itself) is saved so a restart can show it as interrupted.
    this.persistConversation();
    this.sendState();
    
    return new Promise<"APPROVE" | "REJECT">((resolve) => {
      this._confirmationResolver = resolve;
    });
  }

  public setWebviewView(webviewView: vscode.WebviewView) {
    this._webviewMessageDisposable?.dispose();
    this._webviewDisposeDisposable?.dispose();
    this._webviewView = webviewView;
    this.forgetSentTranscript();
    const listener = webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      void this.handleWebviewMessage(message);
    });
    this._webviewMessageDisposable = listener && typeof (listener as any).dispose === 'function'
      ? listener
      : { dispose: () => {} };
    if (typeof (webviewView as any).onDidDispose === 'function') {
      this._webviewDisposeDisposable = (webviewView as any).onDidDispose(() => {
        if (this._webviewView === webviewView) {
          this._webviewView = undefined;
          this._webviewMessageDisposable?.dispose();
          this._webviewMessageDisposable = undefined;
        }
      });
    }
    this.sendState();
  }
  
  public async handleCommand(mode: ChatMode, instruction?: string) {
    this.state.mode = mode;
    this.sendState();
    // Reveal webview
    vscode.commands.executeCommand('open-vs-code.chat.focus');
  }
  
  /** Editor activity (cursor, selection, diagnostics) calls this often; identical chips post nothing (Sprint 7D). */
  public refreshContext(snapshot: IdeContextSnapshot) {
    const chips = implicitContextChips(snapshot);
    if (JSON.stringify(chips) === JSON.stringify(this.state.context)) {
      this._metrics.contextRefreshesSkipped++;
      return;
    }
    this.state.context = chips;
    this.sendState();
  }

  public setConnectionInput(input: Partial<ConnectionSnapshotInput>): void {
    this._connectionInput = { ...this._connectionInput, ...input };
    this.state.connection = deriveConnectionStatus({
      ...this._connectionInput,
      activeTurn: this.state.activeTurn,
    });
    this.sendState();
  }

  public async refreshConnection(): Promise<void> {
    if (typeof this.host.getConnectionSnapshot === 'function') {
      const snapshot = await this.host.getConnectionSnapshot();
      if (snapshot) {
        this._connectionInput = { ...this._connectionInput, ...snapshot };
      }
    }
    this.state.connection = deriveConnectionStatus({
      ...this._connectionInput,
      activeTurn: this.state.activeTurn,
    });
    this.sendState();
  }
  
  public async handleWebviewMessage(rawMessage: any) {
    const message = parseWebviewMessage(rawMessage);
    if (!message) return;
    
    switch (message.type) {
      case 'chat.ready':
        this.forgetSentTranscript();
        this.sendState();
        break;
      case 'chat.send':
        if (this.state.activeTurn) return;
        if (message.customModeId !== undefined) {
          this.state.customModeId = message.customModeId;
          this.syncActiveModeFromManager();
        }
        await this.startTurn(message.text, message.mode || this.state.mode);
        break;
      case 'chat.cancel':
        this.cancelTurn();
        break;
      case 'chat.setMode':
        if (this.state.activeTurn) {
          vscode.window?.showWarningMessage?.("Cannot change execution mode while a task is running.");
          break;
        }
        this.state.mode = message.mode;
        this.state.customModeId = message.customModeId;
        this.syncActiveModeFromManager();
        this.persistConversation();
        this.sendState();
        break;
      case 'chat.newConversation':
        if (this.state.activeTurn) {
          const res = await vscode.window.showWarningMessage("A session is already running. Cancel it to start a new chat?", "Cancel", "Ignore");
          if (res === "Cancel") {
            this.cancelTurn();
            // The cancelled turn will not report back to a replaced conversation; record it here.
            this.state.lastStatus = 'cancelled';
            this.persistConversation();
          } else {
            return;
          }
        }
        if (this.state.pendingConfirmation?.mutationId) {
          this.setMutationStatus(this.state.pendingConfirmation.mutationId, 'CANCELLED');
          this.diffReviewController.clearReview(this.state.pendingConfirmation.mutationId);
        }
        if (this.state.pendingConfirmation?.preparedCommand?.executionId) {
          this.terminalReviewController.setStatus(this.state.pendingConfirmation.preparedCommand.executionId, 'CANCELLED');
        }
        this._confirmationInFlight = false;
        this._confirmationResolver = undefined;
        this.startFreshConversation();
        break;
      case 'conversation.open':
        await this.openConversation(message.conversationId);
        break;
      case 'conversation.rename':
        await this.renameConversation(message.conversationId, message.title);
        break;
      case 'conversation.delete':
        await this.deleteConversation(message.conversationId);
        break;
      case 'conversation.archive':
        await this.archiveConversation(message.conversationId, message.archived);
        break;
      case 'conversation.continueFrom':
        await this.continueFromConversation(message.conversationId);
        break;
      case 'conversation.inspectRecovery':
        await this.inspectRecovery(message.conversationId);
        break;
      case 'conversation.closeRecovery':
        this.state.recovery = undefined;
        this.sendState();
        break;
      case 'chat.checkConnection':
        if (typeof this.host.checkConnection === 'function') {
          await this.host.checkConnection();
        } else if (vscode.commands?.executeCommand) {
          await vscode.commands.executeCommand('open-vs-code.checkHaloConnection');
        }
        await this.refreshConnection();
        break;
      case 'context.attach':
        await this.attachFromEditor(message.target);
        break;
      case 'context.attachFile':
        await this.attachPath(message.path);
        break;
      case 'context.remove':
        this.state.attachments = removeAttachment(this.state.attachments, message.id);
        this.sendState();
        break;
      case 'context.search':
        await this.searchWorkspaceFiles(message.query);
        break;
      case 'context.pickFile':
        await this.pickWorkspaceFile();
        break;
      case 'confirmation.respond':
      case 'terminal.respond':
        if (this._confirmationInFlight) return;
        if (this.state.pendingConfirmation && this._confirmationResolver) {
          if (message.confirmationId === this.state.pendingConfirmation.id) {
            const mutId = this.state.pendingConfirmation.mutationId;
            const termId = this.state.pendingConfirmation.preparedCommand?.executionId;
            
            if (message.action === 'APPROVE' && this.state.pendingConfirmation.path) {
              const pendingPath = this.state.pendingConfirmation.path.replace(/\\/g, '/');
              const isDirty = vscode.workspace?.textDocuments?.some(doc => 
                doc.isDirty && doc.uri.path.replace(/\\/g, '/').endsWith(pendingPath)
              );
              if (isDirty) {
                vscode.window.showErrorMessage("Save or discard unsaved changes before applying this proposal.");
                this.state.pendingConfirmation.blockedReason = 'Unsaved editor changes in ' + this.state.pendingConfirmation.path + '. Save or discard them, then approve again.';
                this.sendState();
                return;
              }
            }

            this._confirmationInFlight = true;
            if (message.action === 'APPROVE' && mutId) this._approvedMutations.add(mutId);
            this.state.pendingConfirmation.responding = true;
            this.sendState();
            this.state.pendingConfirmation = undefined;
            if (termId) {
              if (message.action === 'APPROVE') {
                this.terminalReviewController.setStatus(termId, 'RUNNING');
                this._appliedSinceVerification = [];
              } else {
                this.terminalReviewController.setStatus(termId, 'REJECTED');
                this.clearVerifies(termId);
              }
              const tEntry = this.terminalReviewController.getByExecutionId(termId);
              if (tEntry) this.syncTerminalState(tEntry);
            }
            this.sendState();
            const resolver = this._confirmationResolver;
            this._confirmationResolver = undefined;
            if (message.action === 'REJECT' && mutId) {
              this.setMutationStatus(mutId, 'REJECTED');
              this.diffReviewController.clearReview(mutId);
            }
            this._confirmationInFlight = false;
            resolver(message.action);
          }
        }
        break;
      case 'terminal.cancel': {
        // Only a command that is actually running can be cancelled from its card;
        // an unknown or finished id is ignored rather than aborting the turn.
        const tEntry = this.terminalReviewController.getByExecutionId(message.executionId);
        if (!tEntry || tEntry.status !== 'RUNNING') break;
        this.cancelTurn();
        this.terminalReviewController.setStatus(message.executionId, 'CANCELLED');
        this.syncTerminalState(tEntry);
        this.sendState();
        break;
      }
      case 'terminal.toggleOutput':
        if (message.executionId) {
          this.terminalReviewController.toggleOutput(message.executionId);
          const tEntry = this.terminalReviewController.getByExecutionId(message.executionId);
          if (tEntry) {
            this.syncTerminalState(tEntry);
            this.sendState();
          }
        }
        break;
      case 'terminal.copyCommand':
        if (message.executionId) {
          await this.terminalReviewController.copyCommand(message.executionId);
        }
        break;
      case 'terminal.copyOutput':
        await this.terminalReviewController.copyOutput(message.executionId);
        break;
      case 'terminal.openOutput':
        this.showTerminalTranscript(message.executionId);
        break;
      case 'review.openChange':
        await this.openReviewedChange(message.mutationId);
        break;
      case 'ui.openSourceControl':
        if (vscode.commands?.executeCommand) {
          try { await vscode.commands.executeCommand('workbench.view.scm'); } catch { /* SCM view unavailable */ }
        }
        break;
      case 'ui.openDiff':
        if (this.state.pendingConfirmation?.mutationId === message.mutationId) {
          this.diffReviewController.openDiff(message.mutationId, message.path, message.isCreate);
        }
        break;
      case 'ui.copyCode':
        vscode.env.clipboard.writeText(message.text);
        break;
      case 'ui.openFile':
        await this.openWorkspaceFile(message.path);
        break;
      case 'ui.openModelConfig':
        if (typeof this.host.openModelConfig === 'function') {
          await this.host.openModelConfig();
        } else if (vscode.commands?.executeCommand) {
          await vscode.commands.executeCommand('open-vs-code.openModelConfig');
        }
        break;
      case 'integration.openHub':
        await this.openIntegrationsHub();
        break;
      case 'integration.closeHub':
        await this.closeIntegrationsHub();
        break;
      case 'integration.setTab':
        this._integrationManager?.setTab(message.tab);
        break;
      case 'integration.connectMcp':
        await this._integrationManager?.connectServer(message.serverId);
        break;
      case 'integration.disconnectMcp':
        await this._integrationManager?.disconnectServer(message.serverId);
        break;
      case 'integration.toggleMcp':
        await this._integrationManager?.toggleServerEnabled(message.serverId, message.enabled);
        break;
      case 'integration.toggleWorkspacePolicy':
        await this._integrationManager?.toggleWorkspacePolicy(message.serverId, message.enabled);
        break;
      case 'integration.inspectTools':
        this._integrationManager?.inspectTools(message.serverId);
        break;
      case 'integration.promptRemoveServer':
        this._integrationManager?.promptRemoveServer(message.serverId, message.serverName);
        break;
      case 'integration.executeRemoveServer':
        await this._integrationManager?.executeRemoveServer(message.serverId);
        break;
      case 'integration.cancelConfirmation':
        this._integrationManager?.cancelConfirmation();
        break;
      case 'integration.refreshDiscovery':
        await this._integrationManager?.refreshDiscovery();
        break;
      case 'integration.syncAccount':
        if (vscode.commands?.executeCommand) {
          await vscode.commands.executeCommand('open-vs-code.syncAccountIntegrations');
        }
        await this._integrationManager?.refreshDiscovery();
        break;
      case 'integration.startWizard':
        this._integrationManager?.startAddWizard();
        break;
      case 'integration.cancelWizard':
        this._integrationManager?.cancelWizard();
        break;
      case 'integration.wizardTransport':
        this._integrationManager?.wizardSetStep1Transport(message.transport);
        break;
      case 'integration.wizardDraft':
        this._integrationManager?.wizardUpdateDraft(message.draft as any);
        break;
      case 'integration.wizardValidate':
        await this._integrationManager?.wizardValidateAndAdvance();
        break;
      case 'integration.wizardStep':
        this._integrationManager?.wizardGoToStep(message.step as any);
        break;
      case 'integration.wizardSave':
        await this._integrationManager?.wizardSave(message.connectNow);
        break;
      case 'integration.inspectSkill':
        this._integrationManager?.inspectSkill(message.skillId);
        break;
      case 'integration.openSkillFile':
        await this._integrationManager?.openSkillFile(message.skillId);
        break;
      case 'integration.accountLogin':
        if (vscode.commands?.executeCommand) {
          await vscode.commands.executeCommand('open-vs-code.accountLogin');
        }
        break;
      case 'integration.accountLogout':
        if (vscode.commands?.executeCommand) {
          await vscode.commands.executeCommand('open-vs-code.accountLogout');
        }
        break;
      case 'integration.inspectMode':
        await this._integrationManager?.inspectMode(message.modeId);
        break;
      case 'integration.startModeWizard':
        await this._integrationManager?.startModeWizard(message.modeId);
        break;
      case 'integration.cancelModeWizard':
        this._integrationManager?.cancelModeWizard();
        break;
      case 'integration.modeWizardDraft':
        this._integrationManager?.updateModeWizardDraft(message.draft as any);
        break;
      case 'integration.modeWizardStep':
        this._integrationManager?.setModeWizardStep(message.step as any);
        break;
      case 'integration.modeWizardSave':
        await this._integrationManager?.saveModeWizard(message.activateNow);
        break;
      case 'integration.deleteMode':
        await this._integrationManager?.deleteMode(message.modeId);
        break;
      case 'integration.duplicateMode':
        this._integrationManager?.duplicateMode(message.modeId, message.targetScope);
        break;
      case 'integration.toggleMode':
        this._integrationManager?.toggleModeEnabled(message.modeId, message.enabled);
        break;
      case 'integration.setActiveMode':
        this._integrationManager?.setActiveMode(message.modeId);
        this.syncActiveModeFromManager();
        this.persistConversation();
        this.sendState();
        break;
      case 'integration.inspectPack':
        this._integrationManager?.inspectPack(message.packId);
        break;
      case 'integration.importPackPrompt':
        try {
          const jsonInput = await vscode.window.showInputBox({
            prompt: 'Paste Capability Pack Manifest JSON',
            placeHolder: '{"schemaVersion": 1, "id": "my-pack", ...}',
            ignoreFocusOut: true,
          });
          if (jsonInput) {
            const manifest = this._integrationManager?.importPack(jsonInput);
            if (manifest) {
              await this._integrationManager?.installPack(manifest, 'workspace');
              vscode.window.showInformationMessage(`Capability Pack "${manifest.name}" installed.`);
            }
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to import pack: ${err.message}`);
        }
        break;
      case 'integration.importPack':
        try {
          const manifest = this._integrationManager?.importPack(message.manifest);
          if (manifest) {
            const preview = this._integrationManager?.previewPack(manifest);
            this._integrationManager?.setPackPreview(preview);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to validate pack: ${err.message}`);
        }
        break;
      case 'integration.installPack':
        try {
          await this._integrationManager?.installPack(message.manifest as any, message.scope || 'workspace');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to install pack: ${err.message}`);
        }
        break;
      case 'integration.enablePack':
        await this._integrationManager?.enablePack(message.packId);
        break;
      case 'integration.disablePack':
        await this._integrationManager?.disablePack(message.packId);
        break;
      case 'integration.activatePack':
        try {
          await this._integrationManager?.activatePack(message.packId);
          this.syncActiveModeFromManager();
          this.persistConversation();
          this.sendState();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to activate pack: ${err.message}`);
        }
        break;
      case 'integration.updatePack':
        try {
          await this._integrationManager?.updatePack(message.packId, message.manifest as any);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to update pack: ${err.message}`);
        }
        break;
      case 'integration.rollbackPack':
        try {
          await this._integrationManager?.rollbackPack(message.packId);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to roll back pack: ${err.message}`);
        }
        break;
      case 'integration.removePack':
        try {
          await this._integrationManager?.removePack(message.packId);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to remove pack: ${err.message}`);
        }
        break;
    }
  }

  private terminalDto(tEntry: TerminalReviewEntry): TerminalReviewDto {
    return {
      executionId: tEntry.executionId,
      command: tEntry.command,
      cwd: tEntry.cwd,
      provenance: tEntry.provenance,
      timeoutMs: tEntry.timeoutMs,
      executable: tEntry.executable,
      args: [...tEntry.args],
      scriptName: tEntry.scriptName,
      scriptBody: tEntry.scriptBody,
      startedAt: tEntry.startedAt,
      outputLimitBytes: this.terminalReviewController.outputLimitBytes,
      status: tEntry.status,
      exitCode: tEntry.exitCode,
      exitSignal: tEntry.exitSignal,
      durationMs: tEntry.durationMs,
      stdout: tEntry.stdout,
      stderr: tEntry.stderr,
      stdoutTruncated: tEntry.stdoutTruncated,
      stderrTruncated: tEntry.stderrTruncated,
      isOutputVisible: tEntry.isOutputVisible,
    };
  }

  private syncTerminalState(tEntry: TerminalReviewEntry) {
    this.state.activeTerminal = this.terminalDto(tEntry);
  }

  private upsertReview(record: ReviewRecordDto): void {
    const reviews = this.state.reviews || (this.state.reviews = []);
    const index = reviews.findIndex((r) => r.id === record.id && r.kind === record.kind);
    if (index >= 0) reviews[index] = { ...reviews[index], ...record };
    else reviews.push(record);
    while (reviews.length > MAX_REVIEW_RECORDS) {
      const evictable = reviews.findIndex((r) => r.status !== 'pending' && r.status !== 'running');
      reviews.splice(evictable >= 0 ? evictable : 0, 1);
    }
  }

  private findReview(id: string, kind: ReviewRecordDto['kind']): ReviewRecordDto | undefined {
    return this.state.reviews?.find((r) => r.id === id && r.kind === kind);
  }

  /** The one place a mutation's review status changes, so the diff registry and ledger agree. */
  private setMutationStatus(mutationId: string, status: ReviewStatus, detail?: string): void {
    this.diffReviewController?.setStatus?.(mutationId, status);
    const record = this.findReview(mutationId, 'mutation');
    if (!record) return;
    record.status = reviewStatusFromMutation(status);
    if (detail) record.detail = detail;
    this.persistConversation();
  }

  private clearVerifies(executionId: string): void {
    const record = this.findReview(executionId, 'command');
    if (record) record.verifies = undefined;
  }

  /** Command rows mirror TerminalReviewController; mutation rows link to the latest command that checked them. */
  private refreshReviews(): void {
    const reviews = this.state.reviews;
    if (!reviews?.length) return;
    for (const record of reviews) {
      if (record.kind !== 'command') continue;
      const entry = this.terminalReviewController.getByExecutionId(record.id);
      // Restored rows have no live entry, so there is no retained output to open.
      record.outputAvailable = Boolean(entry);
      if (!entry) continue;
      record.status = reviewStatusFromTerminal(entry.status);
      record.exitCode = entry.exitCode;
      record.durationMs = entry.durationMs;
      for (const mutationId of record.verifies || []) {
        const change = this.findReview(mutationId, 'mutation');
        if (change) change.verifiedBy = { id: record.id, command: record.command || '', status: record.status };
      }
    }
  }

  private showTerminalTranscript(executionId: string): void {
    const entry = this.terminalReviewController.getByExecutionId(executionId);
    if (!entry) return;
    if (!this._outputChannel) {
      if (typeof vscode.window?.createOutputChannel !== 'function') return;
      this._outputChannel = vscode.window.createOutputChannel('Open VS Code: Commands');
    }
    this._outputChannel.appendLine(formatTerminalTranscript(entry));
    this._outputChannel.appendLine('');
    this._outputChannel.show(true);
  }

  private async openReviewedChange(mutationId: string): Promise<void> {
    const record = this.findReview(mutationId, 'mutation');
    if (!record?.path) return;
    if (record.status === 'pending' && this.state.pendingConfirmation?.mutationId === mutationId) {
      await this.diffReviewController.openDiff(mutationId, record.path, record.mutation?.operation === 'create');
      return;
    }
    if (record.status === 'applied') {
      const uri = this.containedWorkspaceUri(record.path);
      if (uri && vscode.commands?.executeCommand) {
        try {
          await vscode.commands.executeCommand('git.openChange', uri);
          return;
        } catch { /* No Git change view; fall back to the file. */ }
      }
    }
    await this.openWorkspaceFile(record.path);
  }

  private containedWorkspaceUri(rawPath: string): any {
    const relative = sanitizeRelativePath(rawPath);
    const folders = vscode.workspace?.workspaceFolders;
    if (!relative || !folders || folders.length === 0 || !vscode.Uri?.joinPath) return undefined;
    const uri = vscode.Uri.joinPath(folders[0].uri, relative);
    const root = folders[0].uri.fsPath.replace(/\\/g, '/');
    const opened = uri.fsPath.replace(/\\/g, '/');
    if (opened !== root && !opened.startsWith(root + '/')) return undefined;
    return uri;
  }
  
  private async startTurn(text: string, mode: ChatMode) {
    const attached = this.state.attachments.slice();
    const userMsg: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: attached.length ? attached : undefined,
    };
    this.state.messages.push(userMsg);
    
    const recentTurns: ConversationTurn[] = [];
    
    // We collect them backwards to get the most recent, then reverse them
    for (let i = this.state.messages.length - 2; i >= 0; i--) {
      const msg = this.state.messages[i];
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      recentTurns.unshift({ role: msg.role as "user" | "assistant", content: msg.content });
    }
    
    const attachmentNote = formatAttachmentInstruction(attached);
    const fullInstruction = attachmentNote ? text + '\n\n' + attachmentNote : text;
    
    this.state.activeTurn = true;
    this._turnStartedAt = performance.now();
    this._cancelRequestedAt = 0;
    this.state.activities = [];
    this.state.pendingConfirmation = undefined;
    this.state.activeTerminal = undefined;
    this.state.recovery = undefined;
    this.state.connection = deriveConnectionStatus({ ...this._connectionInput, activeTurn: true });
    // Durable "running" marker: if the editor closes mid-turn, the restored record shows it as interrupted.
    this.state.lastStatus = 'running';
    this.persistConversation();
    this.sendState();
    
    const snapshot = await this.host.getSnapshot();
    const resolvedRoot = resolveWorkspaceRoot(snapshot);
    if (!resolvedRoot) {
      this.state.activeTurn = false;
      this.state.activities = [];
      this.state.connection = deriveConnectionStatus(this._connectionInput);
      const errorMsg: ChatMessage = {
        id: this.generateId(),
        role: 'system',
        content: `Error: NO_WORKSPACE. A workspace must be open to perform this task.`,
        timestamp: Date.now(),
        status: 'failed'
      };
      this.state.messages.push(errorMsg);
      this.state.lastStatus = 'failed';
      this.persistConversation();
      this.sendState();
      return;
    }

    let resolvedProfile: ResolvedExecutionProfile | undefined;
    const modeService = this._modeService || this._integrationManager?.getModeService();
    if (this.state.customModeId) {
      if (!modeService) {
        this.state.activeTurn = false;
        this.state.activities = [];
        this.state.connection = deriveConnectionStatus(this._connectionInput);
        const errorMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `ModeService is unavailable; cannot resolve custom mode "${this.state.customModeId}".`,
          timestamp: Date.now(),
          status: 'failed',
        };
        this.state.messages.push(errorMsg);
        this.state.lastStatus = 'failed';
        this.persistConversation();
        this.sendState();
        return;
      }

      const profile = modeService.getMode(this.state.customModeId);
      if (!profile) {
        this.state.activeTurn = false;
        this.state.activities = [];
        this.state.connection = deriveConnectionStatus(this._connectionInput);
        const errorMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `Selected custom profile "${this.state.customModeId}" no longer exists.`,
          timestamp: Date.now(),
          status: 'failed',
        };
        this.state.messages.push(errorMsg);
        this.state.lastStatus = 'failed';
        this.persistConversation();
        this.sendState();
        return;
      }

      if (!profile.enabled) {
        this.state.activeTurn = false;
        this.state.activities = [];
        this.state.connection = deriveConnectionStatus(this._connectionInput);
        const errorMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `Custom mode "${profile.name}" is disabled and cannot execute.`,
          timestamp: Date.now(),
          status: 'failed',
        };
        this.state.messages.push(errorMsg);
        this.state.lastStatus = 'failed';
        this.persistConversation();
        this.sendState();
        return;
      }

      if (profile.baseMode !== mode) {
        this.state.activeTurn = false;
        this.state.activities = [];
        this.state.connection = deriveConnectionStatus(this._connectionInput);
        const errorMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `Execution mode mismatch: requested mode "${mode}" does not match profile base mode "${profile.baseMode}".`,
          timestamp: Date.now(),
          status: 'failed',
        };
        this.state.messages.push(errorMsg);
        this.state.lastStatus = 'failed';
        this.persistConversation();
        this.sendState();
        return;
      }

      const accountState = this._integrationManager?.getAccountManager()?.getState();
      if (profile.source === 'account' && (!accountState?.user || accountState?.status === 'UNAUTHENTICATED')) {
        this.state.activeTurn = false;
        this.state.activities = [];
        this.state.connection = deriveConnectionStatus(this._connectionInput);
        const errorMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `Custom mode "${profile.name}" belongs to an account profile but the user is unauthenticated.`,
          timestamp: Date.now(),
          status: 'failed',
        };
        this.state.messages.push(errorMsg);
        this.state.lastStatus = 'failed';
        this.persistConversation();
        this.sendState();
        return;
      }

      const capabilitySnapshot = this._integrationManager
        ? await this._integrationManager.getProductionCapabilitySnapshot()
        : await this.buildLocalCapabilitySnapshot(resolvedRoot, mode);

      resolvedProfile = modeService.resolveMode(profile.id, capabilitySnapshot);
      if (!resolvedProfile.isReady) {
        this.state.activeTurn = false;
        this.state.activities = [];
        this.state.connection = deriveConnectionStatus(this._connectionInput);
        const diagLines = resolvedProfile.diagnostics.map((d) => `- ${d}`).join('\n');
        const errorMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `Mode "${resolvedProfile.profileName}" cannot execute: required dependencies are missing or unready.\n${diagLines}`,
          timestamp: Date.now(),
          status: 'failed',
        };
        this.state.messages.push(errorMsg);
        this.state.lastStatus = 'failed';
        this.persistConversation();
        this.sendState();
        return;
      }
    }

    let mcpCatalog: any;
    const mcpService = this._integrationManager?.getMcpService();
    if (mcpService) {
      try {
        mcpCatalog = await mcpService.getCatalog();
      } catch {
        // Safe fallback
      }
    }
    
    this._activeAbortController = new AbortController();
    this._activeSessionBridge = this.bridgeFactory({ host: this.host, workspaceRoot: resolvedRoot, mode, mcpCatalog } as any);
    
    // Bind current turn for isolation
    const currentConversationId = this.state.conversationId;
    const currentTurnMsgId = userMsg.id;
    const currentAbortController = this._activeAbortController;
    const currentBridge = this._activeSessionBridge;
    
    try {
      const result = await currentBridge.runTask(fullInstruction, mode, currentAbortController.signal, (ev) => {
        if (this.state.conversationId === currentConversationId && this.state.activeTurn) {
          this.handleAgentEvent(ev);
        }
      }, recentTurns, resolvedProfile);
      
      if (this.state.conversationId !== currentConversationId || !this.state.activeTurn) return;
      
      this.state.activeTurn = false;
      this.completePendingActivities(result.status === 'FAILED' ? 'failed' : result.status === 'CANCELLED' ? 'cancelled' : 'completed');
      this.closeUndecided();
      this.state.pendingConfirmation = undefined;
      if (result.status === 'COMPLETED' && this._connectionInput.inferenceBackend !== 'halo') {
        const { lastError: _ignored, ...rest } = this._connectionInput;
        this._connectionInput = { ...rest, endpointVerified: true };
      }
      this.state.connection = deriveConnectionStatus(this._connectionInput);
      
      if (result.status === 'CANCELLED') {
        const cancelMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: 'Task cancelled.',
          timestamp: Date.now(),
          status: 'cancelled'
        };
        this.state.messages.push(cancelMsg);
      } else if (result.status === 'FAILED') {
        const failMsg: ChatMessage = {
          id: this.generateId(),
          role: 'system',
          content: `Task failed: ${result.failureReason}`,
          timestamp: Date.now(),
          status: 'failed'
        };
        this.state.messages.push(failMsg);
      } else {
        const assistantMsg: ChatMessage = {
          id: this.generateId(),
          role: 'assistant',
          content: result.finalAnswer || (result.status === 'COMPLETED' ? 'Task completed successfully.' : `Task finished with status: ${result.status}`),
          timestamp: Date.now(),
          status: 'completed'
        };
        this.state.messages.push(assistantMsg);
      }
      this.state.lastStatus = result.status === 'CANCELLED' ? 'cancelled' : result.status === 'FAILED' ? 'failed' : 'completed';
      this.persistConversation();
      this.sendState();
    } catch (e: any) {
      if (this.state.conversationId !== currentConversationId || !this.state.activeTurn) return;
      
      this.state.activeTurn = false;
      this.completePendingActivities('failed');
      this.closeUndecided();
      this.state.pendingConfirmation = undefined;
      const classified = typeof e.message === 'string' ? classifyTurnError(e.message) : undefined;
      if (classified) {
        this._connectionInput = {
          ...this._connectionInput,
          lastError: classified,
          endpointVerified: classified === 'disconnected' || classified === 'invalid-credentials' || classified === 'model-unavailable'
            ? false
            : this._connectionInput.endpointVerified,
        };
      }
      this.state.connection = deriveConnectionStatus({ ...this._connectionInput, lastError: classified });
      
      let errorMessage = `Agent Error: ${e.message}`;
      if (classified === 'missing-config' || (typeof e.message === 'string' && e.message.includes('No model routing configuration found'))) {
        errorMessage = 'No model configuration found (`.open-vs-code/models.json`). Open VS Code requires a local or self-hosted OpenAI-compatible inference endpoint (e.g. Ollama, vLLM, or HALO). Run the command "Open VS Code: Create Starter Model Configuration" to initialize.';
      } else if (classified === 'disconnected' || (typeof e.message === 'string' && (e.message.includes('ECONNREFUSED') || e.message.includes('fetch failed')))) {
        errorMessage = 'Inference endpoint unreachable. Ensure your local or self-hosted model server (e.g. Ollama or HALO) is running at the configured endpoint.';
      } else if (classified === 'invalid-credentials') {
        errorMessage = 'Configured credentials are missing or invalid. Set the provider apiKeyEnv or HALO application token, then retry.';
      } else if (classified === 'model-unavailable') {
        errorMessage = 'The configured model is not available on the inference endpoint. Open Model Configuration to correct the served model id.';
      } else if (classified === 'timeout') {
        errorMessage = 'The model request timed out or was cancelled.';
      }

      const errorMsg: ChatMessage = {
        id: this.generateId(),
        role: 'system',
        content: errorMessage,
        timestamp: Date.now(),
        status: 'failed'
      };
      this.state.messages.push(errorMsg);
      this.state.lastStatus = 'failed';
      this.persistConversation();
      this.sendState();
    } finally {
      if (this._activeAbortController === currentAbortController) {
        this._activeAbortController = undefined;
        this.recordTurnEnd();
      }
      if (this._activeSessionBridge === currentBridge) {
        this._activeSessionBridge = undefined;
      }
    }
  }
  
  public cancelTurn() {
    if (this._activeAbortController) {
      if (!this._cancelRequestedAt) this._cancelRequestedAt = performance.now();
      this._activeAbortController.abort();
    }
    this.completePendingActivities('cancelled');
    this._confirmationInFlight = false;
    if (this._confirmationResolver) {
      const resolver = this._confirmationResolver;
      const mutationId = this.state.pendingConfirmation?.mutationId;
      const termId = this.state.pendingConfirmation?.preparedCommand?.executionId;
      this._confirmationResolver = undefined;
      this.state.pendingConfirmation = undefined;
      this.state.connection = deriveConnectionStatus(this._connectionInput);
      this.sendState();
      
      if (mutationId) {
        this.setMutationStatus(mutationId, 'CANCELLED', 'Interrupted before a decision — nothing was written.');
        this.diffReviewController?.clearReview?.(mutationId);
      }
      if (termId) {
        this.terminalReviewController.setStatus(termId, 'CANCELLED');
        this.clearVerifies(termId);
      }
      resolver("REJECT");
    } else {
      this.state.connection = deriveConnectionStatus(this._connectionInput);
      this.sendState();
    }
  }
  
  private handleAgentEvent(ev: AgentEvent) {
    this.pushActivity(ev);
    if (ev.type === 'task.started') this.recordRunId((ev.payload as any)?.task?.id);
    if (ev.type === 'tool.requested') {
      this.sendState();
    } else if (ev.type === 'tool.completed' || ev.type === 'tool.failed' || ev.type === 'tool.rejected') {
      this.sendState();
    } else if (ev.type === 'model.requested' || ev.type === 'model.completed' || ev.type === 'model.failed' || ev.type === 'task.started' || ev.type === 'context.compiled' || ev.type === 'permission.requested' || ev.type === 'mutation.prepared' || ev.type === 'mutation.confirmation_requested' || ev.type === 'verification.requested' || ev.type === 'verification.confirmation_requested') {
      this.sendState();
    } else if (ev.type === 'mutation.applied') {
      const payload = ev.payload as any;
      if (payload?.mutationId) {
        this.setMutationStatus(payload.mutationId, 'APPLIED');
        this.diffReviewController.clearReview(payload.mutationId);
        if (this.findReview(payload.mutationId, 'mutation') && !this._appliedSinceVerification.includes(payload.mutationId)) {
          this._appliedSinceVerification.push(payload.mutationId);
        }
        this.sendState();
      }
    } else if (ev.type === 'mutation.failed') {
      const payload = ev.payload as any;
      if (payload?.mutationId) {
        const failure = describeMutationFailure(payload.error);
        this.setMutationStatus(payload.mutationId, failure.stale ? 'STALE' : 'FAILED', failure.detail);
        this.diffReviewController.clearReview(payload.mutationId);
        this.sendState();
      }
    } else if (ev.type === 'mutation.rejected') {
      const payload = ev.payload as any;
      if (payload?.mutationId) {
        if (this.diffReviewController.getStatus(payload.mutationId) !== 'CANCELLED') {
          this.setMutationStatus(payload.mutationId, 'REJECTED');
        }
        this.diffReviewController.clearReview(payload.mutationId);
      }
    } else if (ev.type === 'verification.started') {
      const payload = ev.payload as any;
      const executionId = payload?.executionId;
      if (typeof executionId === 'string' && executionId.trim()) {
        const cleanExecId = executionId.trim();
        const tEntry = this.terminalReviewController.getByExecutionId(cleanExecId);
        if (tEntry) {
          this.terminalReviewController.setStatus(cleanExecId, 'RUNNING');
          if (this.state.activeTerminal?.executionId === cleanExecId) {
            this.syncTerminalState(tEntry);
          }
          this.sendState();
        }
      }
    } else if (ev.type === 'verification.output') {
      const payload = ev.payload as any;
      if (
        payload &&
        (payload.stream === 'stdout' || payload.stream === 'stderr') &&
        typeof payload.chunk === 'string' &&
        payload.chunk.length > 0
      ) {
        // Route output by exact executionId from event — no fallback to activeTerminal.
        // A forged/wrong executionId will find no entry and appendOutput is a no-op.
        // terminal.updated is only sent when the entry exists under the exact ID and matches activeTerminal.
        const executionId = payload.executionId as string | undefined;
        if (typeof executionId === 'string' && executionId.trim()) {
          const cleanExecId = executionId.trim();
          this.terminalReviewController.appendOutput(cleanExecId, payload.stream, payload.chunk);
          const tEntry = this.terminalReviewController.getByExecutionId(cleanExecId);
          if (tEntry && this.state.activeTerminal?.executionId === cleanExecId) {
            // Once a stream hits its bound, further chunks change nothing; skip the post.
            const signature = terminalOutputSignature(tEntry);
            if (signature === this._lastTerminalSignature) return;
            this._lastTerminalSignature = signature;
            this.syncTerminalState(tEntry);
            this.sendMessage({
              type: 'terminal.updated',
              terminal: this.state.activeTerminal,
              review: this.state.activeTerminal,
            });
          }
        }
      }
    } else if (ev.type === 'verification.completed') {
      const payload = ev.payload as any;
      const executionId = payload?.executionId;
      if (typeof executionId === 'string' && executionId.trim()) {
        const cleanExecId = executionId.trim();
        const tEntry = this.terminalReviewController.getByExecutionId(cleanExecId);
        if (tEntry) {
          const res = payload?.result;
          const status = res?.status === 'PASS' ? 'SUCCEEDED' :
                         res?.status === 'TIMEOUT' ? 'TIMED_OUT' :
                         res?.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
          this.terminalReviewController.recordCompletion(cleanExecId, {
            status,
            exitCode: res?.exitCode,
            durationMs: res?.durationMs,
            stdout: res?.stdout,
            stderr: res?.stderr,
          });
          const record = this.findReview(cleanExecId, 'command');
          if (record && res?.status === 'STALE_VERIFICATION') {
            record.detail = 'package.json or the script changed after approval was requested, so the command was not run.';
          } else if (record && res?.status === 'EXECUTION_ERROR') {
            record.detail = 'The command could not be started. See its output for the reason.';
          }
          this.refreshReviews();
          this.persistConversation();
          if (this.state.activeTerminal?.executionId === cleanExecId) {
            this.syncTerminalState(tEntry);
          }
          this.sendState();
        }
      }
    } else if (ev.type === 'verification.failed') {
      const payload = ev.payload as any;
      const executionId = payload?.executionId;
      if (typeof executionId === 'string' && executionId.trim()) {
        const cleanExecId = executionId.trim();
        const tEntry = this.terminalReviewController.getByExecutionId(cleanExecId);
        if (tEntry) {
          this.terminalReviewController.recordCompletion(cleanExecId, {
            status: 'FAILED',
            stderr: payload?.message || 'Verification failed',
          });
          if (this.state.activeTerminal?.executionId === cleanExecId) {
            this.syncTerminalState(tEntry);
          }
          this.sendState();
        }
      }
    } else if (ev.type === 'verification.rejected') {
      const payload = ev.payload as any;
      const executionId = payload?.executionId;
      if (typeof executionId === 'string' && executionId.trim()) {
        const cleanExecId = executionId.trim();
        const tEntry = this.terminalReviewController.getByExecutionId(cleanExecId);
        if (tEntry) {
          this.terminalReviewController.setStatus(cleanExecId, 'REJECTED');
          if (this.state.activeTerminal?.executionId === cleanExecId) {
            this.syncTerminalState(tEntry);
          }
          this.sendState();
        }
      }
    }
  }
  
  private sendState() {
    this.refreshReviews();
    this.state.conversationTitle = this._meta.titleSource === 'user' && this._meta.title
      ? this._meta.title
      : deriveTitle(this.state.messages);
    // Bound messages: max 100 messages, max 200k chars
    while (this.state.messages.length > 100) {
      this.state.messages.shift();
    }
    let chars = this.state.messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
    while (chars > 200000 && this.state.messages.length > 1) {
      const removed = this.state.messages.shift();
      chars -= (removed?.content?.length || 0);
    }
    
    // Bound activities: max 50 entries, pending ones first; never more than 50 in total.
    if (this.state.activities.length > MAX_ACTIVITIES) {
      const pending = this.state.activities.filter(a => a.status === 'pending').slice(-MAX_ACTIVITIES);
      const others = this.state.activities.filter(a => a.status !== 'pending');
      const room = MAX_ACTIVITIES - pending.length;
      this.state.activities = [...(room > 0 ? others.slice(-room) : []), ...pending];
    }

    const m = this._metrics;
    m.statePosts++;
    m.peakMessages = Math.max(m.peakMessages, this.state.messages.length);
    m.peakActivities = Math.max(m.peakActivities, this.state.activities.length);
    if (!this._webviewView) return;
    // The transcript is most of each post (up to 200k characters). Agent events and
    // context changes rarely touch it, so an unchanged transcript is not re-sent.
    if (this.transcriptUnchanged()) {
      const { messages: _omitted, ...rest } = this.state;
      this.sendMessage({ type: 'chat.state', state: rest, transcript: 'unchanged' });
      return;
    }
    this._sentTranscript = this.state.messages.map((msg) => ({ ...msg }));
    m.transcriptPosts++;
    this.sendMessage({ type: 'chat.state', state: this.state });
  }

  private transcriptUnchanged(): boolean {
    const sent = this._sentTranscript;
    const now = this.state.messages;
    if (!sent || sent.length !== now.length) return false;
    for (let i = 0; i < now.length; i++) {
      const a = sent[i];
      const b = now[i];
      if (a.id !== b.id || a.role !== b.role || a.status !== b.status || a.content !== b.content ||
          a.inherited !== b.inherited || a.attachments !== b.attachments) return false;
    }
    return true;
  }

  /** The webview's transcript is unknown (new view, page reload, reset): the next post carries it. */
  private forgetSentTranscript(): void {
    this._sentTranscript = undefined;
  }

  /** Bounded, content-free counters (Sprint 7D). In memory only: never persisted, logged or used to decide anything. */
  public get uiMetrics(): Readonly<ChatUiMetrics> {
    return { ...this._metrics };
  }
  
  private sendMessage(msg: HostToWebviewMessage) {
    if (this._webviewView) {
      this._webviewView.webview.postMessage(msg);
    }
  }

  private recordTurnEnd(): void {
    const m = this._metrics;
    const now = performance.now();
    m.turns++;
    m.lastTurnMs = Math.round(now - this._turnStartedAt);
    m.maxTurnMs = Math.max(m.maxTurnMs, m.lastTurnMs);
    if (this._cancelRequestedAt) m.lastCancelLatencyMs = Math.round((now - this._cancelRequestedAt) * 10) / 10;
    this._cancelRequestedAt = 0;
  }

  /**
   * A tool or model outcome resolves the row that announced it, so the timeline
   * shows one row per call and no request stays "pending" after it finished.
   */
  private pushActivity(ev: { type?: string; payload?: any }): void {
    const activity = activityFromAgentEvent(ev, this.generateId());
    if (!activity) return;
    if (activity.status !== 'pending' && (activity.kind === 'tool' || activity.kind === 'model')) {
      for (let i = this.state.activities.length - 1; i >= 0; i--) {
        const prior = this.state.activities[i];
        if (prior.kind !== activity.kind || prior.status !== 'pending') continue;
        prior.status = activity.status;
        prior.label = activity.label;
        prior.toolName = activity.toolName || prior.toolName;
        return;
      }
    }
    this.state.activities.push(activity);
  }

  /**
   * A turn that ends with an undecided request never acted on it. Release the
   * orphaned decision as REJECT so it cannot block or be answered in a later turn.
   */
  private closeUndecided(): void {
    const termId = this.state.pendingConfirmation?.preparedCommand?.executionId;
    if (termId) {
      this.terminalReviewController.setStatus(termId, 'CANCELLED');
      this.clearVerifies(termId);
    }
    if (this._confirmationResolver) {
      const resolver = this._confirmationResolver;
      this._confirmationResolver = undefined;
      this._confirmationInFlight = false;
      resolver('REJECT');
    }
    for (const record of this.state.reviews || []) {
      if (record.kind !== 'mutation' || record.status !== 'pending') continue;
      if (this._approvedMutations.has(record.id)) {
        this.setMutationStatus(record.id, 'FAILED', 'Approved, but the engine reported no applied result. Check the file before retrying.');
      } else {
        this.setMutationStatus(record.id, 'CANCELLED', 'Turn ended before a decision — nothing was written.');
      }
    }
  }

  private completePendingActivities(status: ChatActivity['status']): void {
    for (const activity of this.state.activities) {
      if (activity.status === 'pending') activity.status = status;
    }
  }

  private trustedSnapshot(snapshot: IdeContextSnapshot): boolean {
    return snapshot.isTrusted !== false;
  }

  private async attachFromEditor(target: 'current-file' | 'selection'): Promise<void> {
    const snapshot = await this.host.getSnapshot();
    const trusted = this.trustedSnapshot(snapshot);
    if (target === 'current-file') {
      const doc = snapshot.activeDocument;
      if (!doc) {
        this.host.showError?.('No active editor file to attach.');
        return;
      }
      const path = doc.workspaceRelativePath || sanitizeRelativePath(String(doc.uri || '')) || undefined;
      const chip = describeAttachment(
        { kind: 'active-file', path, label: doc.workspaceRelativePath || doc.uri },
        { trusted, nextId: () => this.generateId() },
      );
      this.state.attachments = upsertAttachment(this.state.attachments, chip);
      this.sendState();
      return;
    }
    const selection = snapshot.selection;
    if (!selection || !selection.selectedText) {
      this.host.showError?.('No selected code to attach.');
      return;
    }
    const activePath = snapshot.activeDocument?.workspaceRelativePath;
    const chip = describeAttachment(
      {
        kind: 'selection',
        path: activePath,
        label: activePath ? activePath + ' selection' : 'Selection',
        startLine: selection.start?.line,
        endLine: selection.end?.line,
      },
      { trusted, nextId: () => this.generateId() },
    );
    this.state.attachments = upsertAttachment(this.state.attachments, chip);
    this.sendState();
  }

  private async attachPath(rawPath: string): Promise<void> {
    let trusted = true;
    if (typeof this.host.isWorkspaceTrusted === 'function') {
      trusted = (await this.host.isWorkspaceTrusted()) !== false;
    }
    const chip = describeAttachment(
      { kind: 'file', path: rawPath, label: sanitizeRelativePath(rawPath) || rawPath },
      { trusted, nextId: () => this.generateId() },
    );
    this.state.attachments = upsertAttachment(this.state.attachments, chip);
    this.sendState();
  }

  private async searchWorkspaceFiles(query: string): Promise<void> {
    const cleaned = sanitizeSearchQuery(query);
    let files: FileSearchHit[] = [];
    if (typeof this.host.searchWorkspaceFiles === 'function') {
      files = await this.host.searchWorkspaceFiles(cleaned);
    }
    this.sendMessage({
      type: 'context.searchResults',
      query: cleaned,
      files: (files || []).slice(0, MAX_FILE_SEARCH_RESULTS),
    });
  }

  private async pickWorkspaceFile(): Promise<void> {
    if (typeof this.host.pickWorkspaceFile === 'function') {
      const picked = await this.host.pickWorkspaceFile();
      if (picked) await this.attachPath(picked);
      return;
    }
    if (vscode.window?.showQuickPick && vscode.workspace?.findFiles) {
      const cleaned = '';
      const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/.cache/**,**/build/**}';
      const uris = await vscode.workspace.findFiles('**/*', exclude, MAX_FILE_SEARCH_RESULTS);
      const items = uris.map((uri) => {
        const label = vscode.workspace.asRelativePath(uri);
        return { label, description: label, path: label };
      });
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Attach workspace file',
        placeHolder: cleaned || 'Select a file to attach',
        matchOnDescription: true,
      });
      if (picked?.path) await this.attachPath(picked.path);
    }
  }

  private async openWorkspaceFile(rawPath: string): Promise<void> {
    const relative = sanitizeRelativePath(rawPath);
    if (!relative) return;
    if (typeof this.host.openWorkspaceFile === 'function') {
      await this.host.openWorkspaceFile(relative);
      return;
    }
    const uri = this.containedWorkspaceUri(relative);
    if (!uri) return;
    await vscode.window.showTextDocument(uri);
  }
  
  private async buildLocalCapabilitySnapshot(workspaceRoot: string, mode: ChatMode): Promise<any> {
    const isTrusted = this.host?.isWorkspaceTrusted ? await this.host.isWorkspaceTrusted() : true;
    const availableTools: any[] = [
      { name: "read_file", action: "read_repository" },
      { name: "list_directory", action: "read_repository" },
      { name: "search_text", action: "search_repository" },
      { name: "find_files", action: "search_repository" },
    ];
    if (isTrusted) {
      availableTools.push(
        { name: "apply_patch", action: "write_file" },
        { name: "create_file", action: "write_file" },
        { name: "run_verification", action: "run_known_test" }
      );
    }
    return {
      workspaceTrusted: isTrusted,
      availableSkills: [],
      availableMcpServers: [],
      availableTools,
      globalWorkflowEnabled: false,
      globalSkillsEnabled: false,
    };
  }

  private generateId() {
    return Math.random().toString(36).substring(2, 9);
  }

  // ---- Sprint 7C: conversation history -------------------------------------

  private recordRunId(raw: unknown): void {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(raw)) return;
    if (this._meta.runIds.includes(raw)) return;
    this._meta.runIds = [...this._meta.runIds, raw].slice(-MAX_RUN_IDS);
    this.persistConversation();
  }

  /** Queues a save of the visible conversation. A conversation with no message of its own is not saved. */
  private persistConversation(): void {
    const store = this._store;
    if (!store || !this.state.messages.some((m) => m.role === 'user' && !m.inherited)) return;
    const snapshot = {
      id: this.state.conversationId,
      title: this._meta.title,
      titleSource: this._meta.titleSource,
      createdAt: this._meta.createdAt,
      updatedAt: this._lastStamp = Math.max(Date.now(), this._lastStamp + 1),
      mode: this.state.mode,
      customModeId: this.state.customModeId,
      messages: this.state.messages.map((m) => ({ ...m })),
      attachments: this.state.attachments.slice(),
      reviews: (this.state.reviews || []).map((r) => ({ ...r })),
      lastStatus: this.state.lastStatus || 'idle',
      runIds: this._meta.runIds.slice(),
    };
    let started = 0;
    this._persistChain = this._persistChain
      .then(() => { started = performance.now(); return store.save(snapshot, { protect: [this.state.conversationId] }); })
      .then(() => { this.recordSave(performance.now() - started); this.refreshConversationList(); })
      .catch((e: any) => {
        this._metrics.saveFailures++;
        this.state.history = { enabled: true, notice: 'The latest changes to this conversation could not be saved (' + storeErrorCode(e) + ').' };
        this.sendState();
      });
  }

  private recordSave(ms: number): void {
    const m = this._metrics;
    m.saves++;
    m.lastSaveMs = Math.round(ms * 10) / 10;
    m.maxSaveMs = Math.max(m.maxSaveMs, m.lastSaveMs);
  }

  private refreshConversationList(): void {
    if (!this._store) return;
    const next = this._store.list();
    if (JSON.stringify(next) === JSON.stringify(this.state.conversations || [])) return;
    this.state.conversations = next;
    this.sendState();
  }

  /** Drops everything that belongs to a live turn: decisions and links to applied changes. Pending diff content is cleared per mutation where it is decided. */
  private resetTransientState(): void {
    this._confirmationInFlight = false;
    this._confirmationResolver = undefined;
    this._appliedSinceVerification = [];
    this._approvedMutations.clear();
    this._lastTerminalSignature = '';
  }

  private startFreshConversation(seed: ChatMessage[] = []): void {
    this.resetTransientState();
    this._meta = { createdAt: Date.now(), titleSource: 'auto', runIds: [] };
    this.state = {
      conversationId: newConversationId(),
      conversationTitle: 'New conversation',
      lastStatus: 'idle',
      conversations: this._store ? this._store.list() : [],
      history: this.state.history,
      mode: this.state.mode,
      customModeId: this.state.customModeId,
      messages: seed,
      activities: [],
      context: this.state.context,
      attachments: [],
      activeTurn: false,
      connection: deriveConnectionStatus(this._connectionInput),
      reviews: [],
    };
    this.syncActiveModeFromManager();
    this.forgetSentTranscript();
    this.sendMessage({ type: "conversation.reset" });
    this.sendState();
  }

  private loadConversation(stored: PersistedConversation): void {
    const record = prepareForRestore(stored);
    this.resetTransientState();
    this._meta = {
      createdAt: record.createdAt,
      title: record.titleSource === 'user' ? record.title : undefined,
      titleSource: record.titleSource,
      runIds: record.runIds.slice(),
    };
    this.state = {
      conversationId: record.id,
      conversationTitle: record.title,
      lastStatus: record.lastStatus,
      conversations: this._store ? this._store.list() : [],
      history: this.state.history,
      mode: record.mode,
      customModeId: record.customModeId,
      messages: record.messages,
      activities: [],
      context: this.state.context,
      attachments: record.attachments,
      activeTurn: false,
      connection: deriveConnectionStatus(this._connectionInput),
      reviews: record.reviews,
    };
    this.syncActiveModeFromManager();
    this.forgetSentTranscript();
    this.sendMessage({ type: "conversation.reset" });
    this.sendState();
  }

  /** Switching never stops, detaches or moves a running task: it is refused until the task ends. */
  private refuseWhileBusy(action: string): boolean {
    if (!this.state.activeTurn && !this._confirmationResolver && !this.state.pendingConfirmation) return false;
    void vscode.window.showWarningMessage?.(
      `A task is still running in this conversation. Wait for it to finish or cancel it before you ${action}. Running tasks are never stopped or moved by switching.`
    );
    return true;
  }

  public async openConversation(id: string): Promise<void> {
    if (id === this.state.conversationId) {
      this.sendState();
      return;
    }
    if (this.refuseWhileBusy('switch conversations')) return;
    if (!this._store) return;
    await this.flushPersistence();
    const record = await this._store.read(id).catch(() => null);
    if (this.state.activeTurn) return;
    if (!record) {
      this.state.history = { enabled: true, notice: 'That conversation could not be opened. If its file was damaged, it was set aside and the rest of your history is unaffected.' };
      this.state.conversations = this._store.list();
      this.sendState();
      return;
    }
    this.loadConversation(record);
  }

  public async renameConversation(id: string, rawTitle: string): Promise<void> {
    const title = normalizeTitle(rawTitle);
    if (id === this.state.conversationId) {
      this._meta = { ...this._meta, title: title || undefined, titleSource: title ? 'user' : 'auto' };
      this.persistConversation();
      this.sendState();
      return;
    }
    if (!this._store) return;
    await this.flushPersistence();
    await this._store.rename(id, rawTitle).catch(() => null);
    this.refreshConversationList();
    this.sendState();
  }

  public async archiveConversation(id: string, archived: boolean): Promise<void> {
    if (!this._store) return;
    await this.flushPersistence();
    await this._store.setArchived(id, archived).catch(() => null);
    this.refreshConversationList();
    this.sendState();
  }

  public async deleteConversation(id: string): Promise<void> {
    if (!this._store) return;
    const isCurrent = id === this.state.conversationId;
    if (isCurrent && this.refuseWhileBusy('delete it')) return;
    const summary = this._store.get(id);
    if (!summary && !isCurrent) return;
    const title = summary?.title || this.state.conversationTitle || 'this conversation';
    const choice = await vscode.window.showWarningMessage(
      `Delete "${title}"? Its visible history is removed from this workspace. Files, checkpoints and agent memory are not changed.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') return;
    if (isCurrent && this.refuseWhileBusy('delete it')) return;
    await this.flushPersistence();
    await this._store.delete(id).catch(() => false);
    if (isCurrent) this.startFreshConversation();
    else {
      this.refreshConversationList();
      this.sendState();
    }
  }

  /**
   * Starts a new conversation that carries a bounded, read-only copy of the
   * earlier conversation's last turns as background context. Nothing is re-run.
   */
  public async continueFromConversation(id: string): Promise<void> {
    if (this.refuseWhileBusy('start a new conversation')) return;
    let source: ChatMessage[] = [];
    if (id === this.state.conversationId) source = this.state.messages;
    else if (this._store) source = (await this._store.read(id).catch(() => null))?.messages || [];
    const seed: ChatMessage[] = [];
    let chars = 0;
    for (let i = source.length - 1; i >= 0 && seed.length < MAX_SEED_MESSAGES; i--) {
      const m = source[i];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (chars + m.content.length > MAX_SEED_CHARS) break;
      chars += m.content.length;
      seed.unshift({ id: this.generateId(), role: m.role, content: m.content, timestamp: m.timestamp, inherited: true });
    }
    this.startFreshConversation(seed);
  }

  public async inspectRecovery(id: string): Promise<void> {
    if (id === this.state.conversationId && this.state.activeTurn) {
      this.state.history = { ...(this.state.history || { enabled: false }), notice: 'Recovery status is available once the current task stops.' };
      this.sendState();
      return;
    }
    let runIds: string[] = [];
    let lastStatus: ConversationExecutionStatus = 'idle';
    if (id === this.state.conversationId) {
      runIds = this._meta.runIds;
      lastStatus = this.state.lastStatus || 'idle';
    } else if (this._store) {
      const record = await this._store.read(id).catch(() => null);
      if (!record) return;
      const restored = prepareForRestore(record);
      runIds = restored.runIds;
      lastStatus = restored.lastStatus;
    }
    const runId = runIds[runIds.length - 1];
    const view: RecoveryStatusDto = {
      conversationId: id,
      lastStatus,
      state: 'NO_RUN',
      reasons: [],
      manualInspectionRequired: false,
      resumeAvailable: false,
      operations: [],
      files: [],
    };
    if (runId) {
      view.runId = runId;
      const snapshot = await this.host.getSnapshot();
      const root = resolveWorkspaceRoot(snapshot);
      if (!root) {
        view.state = 'UNREADABLE';
        view.reasons = ['NO_WORKSPACE'];
      } else {
        const inspection = await this.recoveryInspector({ workspaceRoot: root, runId });
        view.state = inspection.state;
        view.reasons = inspection.reasons.slice();
        view.manualInspectionRequired = inspection.manualInspectionRequired;
        view.operations = inspection.operations.map((o) => ({ ...o }));
        view.files = inspection.files.slice();
        if (inspection.checkpoint) {
          const { reason, phase, status, createdAt, fromEarlierProcess, awaitingApproval } = inspection.checkpoint;
          view.checkpoint = { reason, phase, status, createdAt, fromEarlierProcess, awaitingApproval };
        }
      }
    }
    if (this.state.conversationId === id || !this.state.activeTurn) {
      this.state.recovery = view;
      this.sendState();
    }
  }
}

const MAX_SEED_MESSAGES = 6;
const MAX_SEED_CHARS = 8000;

function storeErrorCode(e: any): string {
  const code = typeof e?.code === 'string' ? e.code : '';
  return /^[A-Z_]{2,40}$/.test(code) ? code : 'STORAGE_ERROR';
}

function describeStoreIssues(issues: StoreIssue[]): string | undefined {
  const setAside = issues.filter((i) => i.code === 'CORRUPT' || i.code === 'OVERSIZED').length;
  const newer = issues.filter((i) => i.code === 'UNSUPPORTED_VERSION').length;
  const parts: string[] = [];
  if (setAside) parts.push(`${setAside} damaged conversation file${setAside === 1 ? ' was' : 's were'} set aside`);
  if (newer) parts.push(`${newer} conversation${newer === 1 ? ' was' : 's were'} saved by a newer version and left untouched`);
  return parts.length ? parts.join('; ') + '.' : undefined;
}
