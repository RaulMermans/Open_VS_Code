import * as vscode from 'vscode';
import { AgentSessionBridge, IdeContextSnapshot } from '@open-vs-code/ide-adapter';
import { AgentEvent, AgentResult, calculateBudget, estimateTokens } from '@open-vs-code/agent-core';
import { WebviewState, ChatMode, ChatMessage, ChatActivity, WebviewToHostMessage, HostToWebviewMessage, ChatContextChip, ConfirmationRequestPayload } from './chat-protocol.js';

export class ChatController {
  private state: WebviewState;
  private bridgeFactory: (options: { host: any, workspaceRoot: string }) => AgentSessionBridge;
  private host: any; // VSCodeIdeHost
  private _webviewView?: vscode.WebviewView;
  private _activeAbortController?: AbortController;
  private _activeSessionBridge?: AgentSessionBridge;
  private _confirmationResolver?: (value: "APPROVE" | "REJECT") => void;
  
  constructor(host: any, bridgeFactory: (options: { host: any, workspaceRoot: string }) => AgentSessionBridge) {
    this.host = host;
    this.bridgeFactory = bridgeFactory;
    
    this.state = {
      conversationId: this.generateId(),
      mode: 'ASK',
      messages: [],
      activities: [],
      context: [],
      activeTurn: false
    };
  }

  public async requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT"> {
    if (!this.state.activeTurn) {
      return "REJECT";
    }
    
    // Clear old activities to keep UI clean
    this.state.activities = [];

    this.state.pendingConfirmation = {
      id: this.generateId(),
      type: payload?.action || 'unknown',
      summary: prompt,
      riskLabel: payload?.action === 'write_file' ? 'High Risk Mutation' : 'Verification/External'
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
  
  private async handleWebviewMessage(message: WebviewToHostMessage) {
    switch (message.type) {
      case 'chat.ready':
        this.sendState();
        break;
      case 'chat.send':
        if (this.state.activeTurn) return;
        if (!message.text || typeof message.text !== 'string' || message.text.length > 50000) {
          vscode.window.showErrorMessage("Message is empty or too large.");
          return;
        }
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
        if (this.state.pendingConfirmation && this._confirmationResolver) {
          const action = (message as any).action;
          this.state.pendingConfirmation = undefined;
          this.sendState();
          this._confirmationResolver(action);
          this._confirmationResolver = undefined;
        }
        break;
      case 'ui.copyCode':
        vscode.env.clipboard.writeText(message.text);
        break;
      case 'ui.openFile':
        // validate and open
        break;
    }
  }
  
  private async startTurn(text: string, mode: ChatMode) {
    const userMsg: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    this.state.messages.push(userMsg);
    
    // Bounds conversation token limit: budget is 8000, maybe reserve 1600 (20%) for continuity
    const maxContinuityTokens = 1600;
    let continuityText = '';
    let currentTokens = 0;
    
    for (let i = this.state.messages.length - 2; i >= 0; i--) {
      const msg = this.state.messages[i];
      const msgTokens = estimateTokens(msg.content);
      if (currentTokens + msgTokens < maxContinuityTokens) {
        continuityText = `[Turn ${msg.role}]: ${msg.content}\n\n` + continuityText;
        currentTokens += msgTokens;
      } else {
        break;
      }
    }
    
    let fullInstruction = text;
    if (continuityText) {
      fullInstruction = `[Recent Conversation Context]\n${continuityText}\n[Current Task]\n${text}`;
    }
    
    this.state.activeTurn = true;
    this.state.activities = [];
    this.state.pendingConfirmation = undefined;
    this.sendState();
    
    const snapshot = await this.host.getSnapshot();
    const resolvedRoot = snapshot.workspaceRoots[0]?.fsPath || process.cwd(); // simplified
    
    this._activeAbortController = new AbortController();
    this._activeSessionBridge = this.bridgeFactory({ host: this.host, workspaceRoot: resolvedRoot });
    
    try {
      const result = await this._activeSessionBridge.runTask(fullInstruction, mode, this._activeAbortController.signal, (ev) => this.handleAgentEvent(ev));
      
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
      this._activeAbortController = undefined;
      this._activeSessionBridge = undefined;
    }
  }
  
  public cancelTurn() {
    if (this._activeAbortController) {
      this._activeAbortController.abort();
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
    }
  }
  
  private sendState() {
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
