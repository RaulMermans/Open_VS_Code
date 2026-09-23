import * as vscode from 'vscode';
import { ChatController } from './chat-controller.js';
import {
  renderChatMessage,
  renderTerminalOutput,
  renderConfirmationSummary,
} from './webview-render-helpers.js';

export {
  renderChatMessage,
  renderTerminalOutput,
  renderConfirmationSummary,
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'open-vs-code.chat';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _controller: ChatController
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    
    this._controller.setWebviewView(webviewView);
  }
  
  public get view() {
    return this._view;
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Open VS Code Chat</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 10px;
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
        }
        #header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        #mode-selector {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px;
        }
        #transcript {
            flex-grow: 1;
            overflow-y: auto;
            margin-bottom: 10px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .message {
            padding: 8px;
            border-radius: 4px;
        }
        .message.user {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
        }
        .message.assistant {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
        }
        .message.system {
            color: var(--vscode-errorForeground);
            font-style: italic;
        }
        .confirmation-card, .terminal-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            padding: 10px;
            margin: 10px 0;
            border-radius: 4px;
        }
        .terminal-command-box {
            background: var(--vscode-terminal-background, #1e1e1e);
            color: var(--vscode-terminal-foreground, #cccccc);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
            padding: 8px;
            border-radius: 3px;
            margin: 8px 0;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .terminal-meta {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }
        .terminal-output-box {
            background: var(--vscode-terminal-background, #1e1e1e);
            color: var(--vscode-terminal-foreground, #cccccc);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.85em;
            padding: 8px;
            border-radius: 3px;
            max-height: 200px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-all;
            margin-top: 8px;
        }
        .truncation-warning {
            color: var(--vscode-editorWarning-foreground, #e5a50a);
            font-size: 0.8em;
            margin-top: 4px;
        }
        .confirmation-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
        }
        .confirmation-actions button {
            flex-grow: 1;
        }
        .btn-approve {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-reject {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        #composer-container {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        #composer {
            resize: vertical;
            min-height: 60px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: inherit;
        }
        #controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #context-chips {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            display: flex;
            gap: 5px;
            flex-wrap: wrap;
        }
        .chip {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
        }
        #activities {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
    </style>
</head>
<body>
    <div id="header">
        <select id="mode-selector">
            <option value="ASK">ASK</option>
            <option value="PLAN">PLAN</option>
            <option value="BUILD">BUILD</option>
            <option value="DEBUG">DEBUG</option>
            <option value="REVIEW">REVIEW</option>
        </select>
        <button id="new-chat-btn">New Chat</button>
    </div>
    
    <div id="transcript"></div>
    
    <div id="activities"></div>
    <div id="terminal-container"></div>
    <div id="confirmation-container"></div>
    
    <div id="composer-container">
        <div id="context-chips"></div>
        <textarea id="composer" placeholder="Type a message (Shift+Enter for newline)"></textarea>
        <div id="controls">
            <button id="cancel-btn" style="display: none;">Cancel</button>
            <button id="send-btn">Send</button>
        </div>
    </div>

    <script nonce="${nonce}">
        ${renderChatMessage.toString()}
        ${renderTerminalOutput.toString()}
        ${renderConfirmationSummary.toString()}

        const vscode = acquireVsCodeApi();
        
        const modeSelector = document.getElementById('mode-selector');
        const newChatBtn = document.getElementById('new-chat-btn');
        const transcript = document.getElementById('transcript');
        const activities = document.getElementById('activities');
        const terminalContainer = document.getElementById('terminal-container');
        const confirmationContainer = document.getElementById('confirmation-container');
        const contextChips = document.getElementById('context-chips');
        const composer = document.getElementById('composer');
        const sendBtn = document.getElementById('send-btn');
        const cancelBtn = document.getElementById('cancel-btn');
        
        let currentState = { activeTurn: false };
        
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'chat.state':
                    updateState(message.state);
                    break;
                case 'terminal.updated':
                    const updatedTerm = message.terminal || message.review;
                    if (updatedTerm) {
                        if (currentState) currentState.activeTerminal = updatedTerm;
                        renderTerminal(updatedTerm);
                    }
                    break;
                case 'conversation.reset':
                    transcript.innerHTML = '';
                    activities.innerHTML = '';
                    terminalContainer.innerHTML = '';
                    confirmationContainer.innerHTML = '';
                    break;
            }
        });
        
        function updateState(state) {
            currentState = state;
            modeSelector.value = state.mode;
            
            // Render messages (simple re-render)
            transcript.innerHTML = '';
            state.messages.forEach(msg => {
                renderChatMessage(transcript, msg);
            });
            
            // Render terminal review card if present
            renderTerminal(state.activeTerminal);

            // Render confirmation
            renderConfirmationSummary(confirmationContainer, state.pendingConfirmation, document, vscode.postMessage);
            
            transcript.scrollTop = transcript.scrollHeight;
            
            // Render activities
            activities.innerHTML = '';
            state.activities.filter(a => a.status === 'pending').forEach(act => {
                const div = document.createElement('div');
                div.textContent = act.label;
                activities.appendChild(div);
            });
            
            // Render chips
            contextChips.innerHTML = '';
            state.context.forEach(chip => {
                const span = document.createElement('span');
                span.className = 'chip';
                span.textContent = chip.label;
                contextChips.appendChild(span);
            });
            
            // Toggle buttons
            if (state.activeTurn) {
                sendBtn.style.display = 'none';
                cancelBtn.style.display = 'block';
                composer.disabled = true;
            } else {
                sendBtn.style.display = 'block';
                cancelBtn.style.display = 'none';
                composer.disabled = false;
            }
        }

        function renderTerminal(term) {
            renderTerminalOutput(terminalContainer, term, document, vscode.postMessage);
        }
        
        sendBtn.addEventListener('click', () => {
            const text = composer.value.trim();
            if (text && !currentState.activeTurn) {
                vscode.postMessage({ type: 'chat.send', text, mode: modeSelector.value });
                composer.value = '';
            }
        });
        
        cancelBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'chat.cancel' });
        });
        
        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'chat.newConversation' });
        });
        
        modeSelector.addEventListener('change', () => {
            vscode.postMessage({ type: 'chat.setMode', mode: modeSelector.value });
        });
        
        composer.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendBtn.click();
            }
        });
        
        vscode.postMessage({ type: 'chat.ready' });
    </script>
</body>
</html>`;
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
