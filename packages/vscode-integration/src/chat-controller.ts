import * as vscode from 'vscode';
import { AgentSessionBridge, IdeContextSnapshot, resolveWorkspaceRoot } from '@open-vs-code/ide-adapter';
import { AgentEvent, AgentResult, calculateBudget, estimateTokens, ConversationTurn } from '@open-vs-code/agent-core';
import { WebviewState, ChatMode, ChatMessage, ChatActivity, WebviewToHostMessage, HostToWebviewMessage, ChatContextChip, ConfirmationRequestPayload, parseWebviewMessage, TerminalReviewDto } from './chat-protocol.js';
import { DiffReviewController } from './diff-review-controller.js';
import { TerminalReviewController } from './terminal-review-controller.js';

export class ChatController {
  private state: WebviewState;
  private bridgeFactory: (options: { host: any, workspaceRoot: string, mode: ChatMode }) => AgentSessionBridge;
  private host: any; // VSCodeIdeHost
  private diffReviewController: DiffReviewController;
  private terminalReviewController: TerminalReviewController;
  private _webviewView?: vscode.WebviewView;
  private _activeAbortController?: AbortController;
  private _activeSessionBridge?: AgentSessionBridge;
  private _confirmationResolver?: (value: "APPROVE" | "REJECT") => void;
  
  constructor(host: any, arg2: any, arg3?: any, arg4?: any) {
    this.host = host;
    if (typeof arg2 === 'function') {
      this.bridgeFactory = arg2;
      this.diffReviewController = { openDiff: async () => {}, registerReview: () => {}, clearReview: () => {}, clearAll: () => {} } as any;
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
      conversationId: this.generateId(),
      mode: 'ASK',
      messages: [],
      activities: [],
      context: [],
      activeTurn: false
    };
  }

  public getTerminalReviewController(): TerminalReviewController {
    return this.terminalReviewController;
  }

  public async requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT"> {
    if (!this.state.activeTurn) {
      return "REJECT";
    }
    
    // Clear old activities to keep UI clean
    this.state.activities = [];

    const isWriteFile = payload?.action === 'write_file' || payload?.operation === 'patch' || payload?.operation === 'create';
    const isVerification = payload?.action === 'run_known_test' || payload?.action === 'run_verification' || Boolean(payload?.preparedCommand);
    const confirmationId = this.generateId();
    const mutationId = payload?.id || confirmationId;
    const reviewData = payload?.reviewPayload || payload;

    if (isWriteFile && reviewData) {
      this.diffReviewController?.registerReview?.(
        mutationId,
        reviewData.beforeContent || '',
        reviewData.proposedContent || ''
      );
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

      preparedCommandDto = {
        executionId: entry.executionId,
        command: entry.command,
        cwd: entry.cwd,
        provenance: entry.provenance,
        timeoutMs: entry.timeoutMs,
        status: entry.status,
      };
      this.state.activeTerminal = preparedCommandDto;
    }

    this.state.pendingConfirmation = {
      id: confirmationId,
      type: payload?.action || payload?.operation || (isVerification ? 'run_known_test' : 'unknown'),
      summary: prompt,
      riskLabel: isWriteFile ? 'High Risk Mutation' : isVerification ? 'Controlled Verification Terminal' : 'Verification/External',
      mutationId: isWriteFile ? mutationId : undefined,
      path: payload?.path || payload?.reviewPayload?.path,
      preparedCommand: preparedCommandDto,
    };
    
    this.sendState();
    
    return new Promise<"APPROVE" | "REJECT">((resolve) => {
      this._confirmationResolver = resolve;
    });
  }

  public setWebviewView(webviewView: vscode.WebviewView) {
    this._webviewView = webviewView;
    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      this.handleWebviewMessage(message);
    });
    this.sendState();
  }
  
  public async handleCommand(mode: ChatMode, instruction?: string) {
    this.state.mode = mode;
    this.sendState();
    // Reveal webview
    vscode.commands.executeCommand('open-vs-code.chat.focus');
  }
  
  public refreshContext(snapshot: IdeContextSnapshot) {
    const chips: ChatContextChip[] = [];
    if (snapshot.activeDocument) {
      chips.push({ label: snapshot.activeDocument.workspaceRelativePath || snapshot.activeDocument.uri });
    }
    if (snapshot.selection && snapshot.selection.selectedText) {
      chips.push({ label: 'Selection' });
    }
    if (snapshot.diagnostics && snapshot.diagnostics.length > 0) {
      chips.push({ label: `${snapshot.diagnostics.length} diagnostics` });
    }
    if (snapshot.workspaceRoots && snapshot.workspaceRoots.length > 0) {
      chips.push({ label: `${snapshot.workspaceRoots.length} workspace roots` });
    }
    
    this.state.context = chips;
    this.sendState();
  }
  
  private async handleWebviewMessage(rawMessage: any) {
    const message = parseWebviewMessage(rawMessage);
    if (!message) return;
    
    switch (message.type) {
      case 'chat.ready':
        this.sendState();
        break;
      case 'chat.send':
        if (this.state.activeTurn) return;
        await this.startTurn(message.text, message.mode);
        break;
      case 'chat.cancel':
        this.cancelTurn();
        break;
      case 'chat.setMode':
        this.state.mode = message.mode;
        this.sendState();
        break;
      case 'chat.newConversation':
        if (this.state.activeTurn) {
          const res = await vscode.window.showWarningMessage("A session is already running. Cancel it to start a new chat?", "Cancel", "Ignore");
          if (res === "Cancel") {
            this.cancelTurn();
          } else {
            return;
          }
        }
        if (this.state.pendingConfirmation?.mutationId) {
          this.diffReviewController.setStatus(this.state.pendingConfirmation.mutationId, 'CANCELLED');
          this.diffReviewController.clearReview(this.state.pendingConfirmation.mutationId);
        }
        if (this.state.pendingConfirmation?.preparedCommand?.executionId) {
          this.terminalReviewController.setStatus(this.state.pendingConfirmation.preparedCommand.executionId, 'CANCELLED');
        }
        this.state = {
          conversationId: this.generateId(),
          mode: this.state.mode,
          messages: [],
          activities: [],
          context: this.state.context,
          activeTurn: false
        };
        this.sendMessage({ type: "conversation.reset" });
        this.sendState();
        break;
      case 'confirmation.respond':
      case 'terminal.respond':
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
                return;
              }
            }

            this.state.pendingConfirmation = undefined;
            if (termId) {
              if (message.action === 'APPROVE') {
                this.terminalReviewController.setStatus(termId, 'RUNNING');
                const tEntry = this.terminalReviewController.getByExecutionId(termId);
                if (tEntry) {
                  this.state.activeTerminal = {
                    executionId: tEntry.executionId,
                    command: tEntry.command,
                    cwd: tEntry.cwd,
                    provenance: tEntry.provenance,
                    timeoutMs: tEntry.timeoutMs,
                    status: tEntry.status,
                    isOutputVisible: tEntry.isOutputVisible,
                  };
                }
              } else {
                this.terminalReviewController.setStatus(termId, 'REJECTED');
                const tEntry = this.terminalReviewController.getByExecutionId(termId);
                if (tEntry) {
                  this.state.activeTerminal = {
                    executionId: tEntry.executionId,
                    command: tEntry.command,
                    cwd: tEntry.cwd,
                    provenance: tEntry.provenance,
                    timeoutMs: tEntry.timeoutMs,
                    status: tEntry.status,
                    isOutputVisible: tEntry.isOutputVisible,
                  };
                }
              }
            }
            this.sendState();
            const resolver = this._confirmationResolver;
            this._confirmationResolver = undefined;
            if (message.action === 'REJECT' && mutId) {
              this.diffReviewController.setStatus(mutId, 'REJECTED');
              this.diffReviewController.clearReview(mutId);
            }
            resolver(message.action);
          }
        }
        break;
      case 'terminal.cancel':
        if (message.executionId) {
          this.cancelTurn();
          this.terminalReviewController.setStatus(message.executionId, 'CANCELLED');
          const tEntry = this.terminalReviewController.getByExecutionId(message.executionId);
          if (tEntry) {
            this.state.activeTerminal = {
              executionId: tEntry.executionId,
              command: tEntry.command,
              cwd: tEntry.cwd,
              provenance: tEntry.provenance,
              timeoutMs: tEntry.timeoutMs,
              status: tEntry.status,
              isOutputVisible: tEntry.isOutputVisible,
            };
            this.sendState();
          }
        }
        break;
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
      case 'ui.openDiff':
        if (this.state.pendingConfirmation?.mutationId === message.mutationId) {
          this.diffReviewController.openDiff(message.mutationId, message.path, message.isCreate);
        }
        break;
      case 'ui.copyCode':
        vscode.env.clipboard.writeText(message.text);
        break;
    }
  }

  private syncTerminalState(tEntry: import('./terminal-review-controller.js').TerminalReviewEntry) {
    this.state.activeTerminal = {
      executionId: tEntry.executionId,
      command: tEntry.command,
      cwd: tEntry.cwd,
      provenance: tEntry.provenance,
      timeoutMs: tEntry.timeoutMs,
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
  
  private async startTurn(text: string, mode: ChatMode) {
    const userMsg: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    this.state.messages.push(userMsg);
    
    const recentTurns: ConversationTurn[] = [];
    
    // We collect them backwards to get the most recent, then reverse them
    for (let i = this.state.messages.length - 2; i >= 0; i--) {
      const msg = this.state.messages[i];
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      recentTurns.unshift({ role: msg.role as "user" | "assistant", content: msg.content });
    }
    
    const fullInstruction = text;
    
    this.state.activeTurn = true;
    this.state.activities = [];
    this.state.pendingConfirmation = undefined;
    this.state.activeTerminal = undefined;
    this.sendState();
    
    const snapshot = await this.host.getSnapshot();
    const resolvedRoot = resolveWorkspaceRoot(snapshot);
    if (!resolvedRoot) {
      this.state.activeTurn = false;
      this.state.activities = [];
      const errorMsg: ChatMessage = {
        id: this.generateId(),
        role: 'system',
        content: `Error: NO_WORKSPACE. A workspace must be open to perform this task.`,
        timestamp: Date.now(),
        status: 'failed'
      };
      this.state.messages.push(errorMsg);
      this.sendState();
      return;
    }
    
    this._activeAbortController = new AbortController();
    this._activeSessionBridge = this.bridgeFactory({ host: this.host, workspaceRoot: resolvedRoot, mode });
    
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
      }, recentTurns);
      
      if (this.state.conversationId !== currentConversationId || !this.state.activeTurn) return;
      
      this.state.activeTurn = false;
      this.state.activities = [];
      this.state.pendingConfirmation = undefined;
      
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
      this.sendState();
    } catch (e: any) {
      if (this.state.conversationId !== currentConversationId || !this.state.activeTurn) return;
      
      this.state.activeTurn = false;
      this.state.activities = [];
      this.state.pendingConfirmation = undefined;
      
      const errorMsg: ChatMessage = {
        id: this.generateId(),
        role: 'system',
        content: `Agent Error: ${e.message}`,
        timestamp: Date.now(),
        status: 'failed'
      };
      this.state.messages.push(errorMsg);
      this.sendState();
    } finally {
      if (this._activeAbortController === currentAbortController) {
        this._activeAbortController = undefined;
      }
      if (this._activeSessionBridge === currentBridge) {
        this._activeSessionBridge = undefined;
      }
    }
  }
  
  public cancelTurn() {
    if (this._activeAbortController) {
      this._activeAbortController.abort();
    }
    if (this._confirmationResolver) {
      const resolver = this._confirmationResolver;
      const mutationId = this.state.pendingConfirmation?.mutationId;
      const termId = this.state.pendingConfirmation?.preparedCommand?.executionId;
      this._confirmationResolver = undefined;
      this.state.pendingConfirmation = undefined;
      this.sendState();
      
      if (mutationId) {
        this.diffReviewController.setStatus(mutationId, 'CANCELLED');
        this.diffReviewController.clearReview(mutationId);
      }
      if (termId) {
        this.terminalReviewController.setStatus(termId, 'CANCELLED');
      }
      resolver("REJECT");
    }
  }
  
  private handleAgentEvent(ev: AgentEvent) {
    if (ev.type === 'tool.requested') {
      const toolName = (ev.payload as any)?.name || 'tool';
      this.state.activities.push({
        id: this.generateId(),
        kind: 'tool',
        label: `Running ${toolName}...`,
        status: 'pending'
      });
      this.sendState();
    } else if (ev.type === 'tool.completed') {
      if (this.state.activities.length > 0) {
         this.state.activities[this.state.activities.length - 1].status = 'completed';
      }
      this.sendState();
    } else if (ev.type === 'mutation.applied') {
      const payload = ev.payload as any;
      if (payload?.mutationId) {
        this.diffReviewController.setStatus(payload.mutationId, 'APPLIED');
        this.diffReviewController.clearReview(payload.mutationId);
      }
    } else if (ev.type === 'mutation.failed') {
      const payload = ev.payload as any;
      if (payload?.mutationId) {
        const error = payload.error;
        const isStale = error && (error.code === 'STALE_BASE' || error.message?.includes('STALE_BASE') || error.code === 'FILE_EXISTS' || error.message?.includes('FILE_EXISTS'));
        this.diffReviewController.setStatus(payload.mutationId, isStale ? 'STALE' : 'FAILED');
        this.diffReviewController.clearReview(payload.mutationId);
      }
    } else if (ev.type === 'mutation.rejected') {
      const payload = ev.payload as any;
      if (payload?.mutationId) {
        if (this.diffReviewController.getStatus(payload.mutationId) !== 'CANCELLED') {
          this.diffReviewController.setStatus(payload.mutationId, 'REJECTED');
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
    // Bound messages: max 100 messages, max 200k chars
    while (this.state.messages.length > 100) {
      this.state.messages.shift();
    }
    let chars = this.state.messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
    while (chars > 200000 && this.state.messages.length > 1) {
      const removed = this.state.messages.shift();
      chars -= (removed?.content?.length || 0);
    }
    
    // Bound activities: max 50 entries, keeping pending ones
    if (this.state.activities.length > 50) {
      const pending = this.state.activities.filter(a => a.status === 'pending');
      const others = this.state.activities.filter(a => a.status !== 'pending');
      this.state.activities = [...others.slice(-(50 - pending.length)), ...pending];
    }

    this.sendMessage({ type: 'chat.state', state: this.state });
  }
  
  private sendMessage(msg: HostToWebviewMessage) {
    if (this._webviewView) {
      this._webviewView.webview.postMessage(msg);
    }
  }
  
  private generateId() {
    return Math.random().toString(36).substring(2, 9);
  }
}
