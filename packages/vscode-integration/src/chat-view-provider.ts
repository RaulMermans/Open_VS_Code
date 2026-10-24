import * as vscode from 'vscode';
import { ChatController } from './chat-controller.js';
import {
  parseMessageSegments,
  renderChatMessage,
  renderTerminalOutput,
  renderConfirmationSummary,
  syncTranscript,
  renderActivityTimeline,
  renderContextChips,
  renderConnectionStatus,
  renderReviewLedger,
  updateTerminalElapsed,
  handleComposerKeydown,
  webviewRenderRuntime,
} from './webview-render-helpers.js';

export {
  renderChatMessage,
  renderTerminalOutput,
  renderConfirmationSummary,
  parseMessageSegments,
  syncTranscript,
  renderActivityTimeline,
  renderContextChips,
  renderConnectionStatus,
  renderReviewLedger,
  updateTerminalElapsed,
  handleComposerKeydown,
  webviewRenderRuntime,
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
        :root {
            color-scheme: light dark;
        }
        html, body {
            height: 100%;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
        }
        button, select, textarea {
            font-family: inherit;
            font-size: inherit;
        }
        button:focus-visible, select:focus-visible, textarea:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }
        #header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border, transparent));
            flex-shrink: 0;
        }
        #header-main {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1;
        }
        #mode-selector {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 6px;
            border-radius: 2px;
            min-width: 88px;
        }
        #connection-status {
            min-width: 0;
            flex: 1;
        }
        .connection-status {
            display: block;
            width: 100%;
            text-align: left;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: none;
            padding: 2px 0;
            cursor: pointer;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .connection-status.is-ready { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #89d185)); }
        .connection-status.is-running { color: var(--vscode-charts-blue, #75beff); }
        .connection-status.is-missing-config,
        .connection-status.is-invalid-credentials,
        .connection-status.is-model-unavailable { color: var(--vscode-errorForeground); }
        .connection-status.is-disconnected,
        .connection-status.is-timeout,
        .connection-status.is-unavailable { color: var(--vscode-editorWarning-foreground, #cca700); }
        #transcript {
            flex-grow: 1;
            overflow-y: auto;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-height: 0;
        }
        .message {
            padding: 8px 10px;
            border-radius: 6px;
        }
        .message-meta {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
        .message.user {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground, var(--vscode-textBlockQuote-border));
        }
        .message.assistant {
            background-color: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
        }
        .message.system,
        .message.is-failed {
            color: var(--vscode-errorForeground);
            border-left: 3px solid var(--vscode-errorForeground);
            background: transparent;
        }
        .message.is-cancelled {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .message-body {
            white-space: pre-wrap;
            word-break: break-word;
        }
        .md-text { white-space: pre-wrap; }
        .file-ref, .chip-label {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            border: none;
            padding: 0;
            cursor: pointer;
            text-decoration: underline;
        }
        .code-block {
            margin: 8px 0;
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            overflow: hidden;
            background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
        }
        .code-toolbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 2px 8px;
            background: var(--vscode-editorGroupHeader-tabsBackground, transparent);
            color: var(--vscode-descriptionForeground);
            font-size: 0.8em;
        }
        .code-block pre {
            margin: 0;
            padding: 8px;
            overflow-x: auto;
            white-space: pre;
        }
        .code-block code {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 12px);
        }
        .btn-copy {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            border: none;
            padding: 2px 6px;
            cursor: pointer;
        }
        .message-attachments, #implicit-chips, #context-chips {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            margin-top: 6px;
        }
        .chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 0.8em;
        }
        .chip-unavailable { opacity: 0.7; text-decoration: line-through; }
        .chip-remove {
            background: transparent;
            color: inherit;
            border: none;
            padding: 0 2px;
            cursor: pointer;
            line-height: 1;
        }
        .confirmation-card, .terminal-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            padding: 10px;
            margin: 0 10px 10px;
            border-radius: 4px;
            flex-shrink: 0;
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
        .terminal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }
        .terminal-title { font-weight: 600; }
        .status-badge {
            font-size: 0.8em;
            padding: 1px 8px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .status-succeeded .status-badge { background: var(--vscode-testing-iconPassed, #89d185); color: var(--vscode-editor-background); }
        .status-failed .status-badge, .status-timed_out .status-badge { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
        .status-running .status-badge { background: var(--vscode-charts-blue, #75beff); color: var(--vscode-editor-background); }
        .terminal-row {
            display: grid;
            grid-template-columns: 6.5em 1fr;
            gap: 6px;
            padding: 1px 0;
        }
        .terminal-row-label { color: var(--vscode-descriptionForeground); }
        .terminal-row-value { color: var(--vscode-foreground); overflow-wrap: anywhere; }
        .mono { font-family: var(--vscode-editor-font-family, monospace); }
        .terminal-elapsed, .terminal-result {
            font-size: 0.85em;
            margin-top: 4px;
        }
        .confirmation-blocked {
            color: var(--vscode-errorForeground);
            font-size: 0.85em;
            margin-top: 6px;
        }
        #reviews {
            padding: 0 10px 6px;
            flex-shrink: 0;
            max-height: 180px;
            overflow-y: auto;
        }
        .review-ledger summary {
            cursor: pointer;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            padding: 2px 0;
        }
        .review-list { list-style: none; margin: 0; padding: 0; }
        .review-item {
            display: flex;
            gap: 8px;
            align-items: flex-start;
            font-size: 0.85em;
            padding: 3px 0;
        }
        .review-item .activity-mark { margin-top: 5px; }
        .review-item.is-pending .activity-mark, .review-item.is-running .activity-mark { background: var(--vscode-charts-blue, #75beff); }
        .review-item.is-applied .activity-mark, .review-item.is-succeeded .activity-mark { background: var(--vscode-testing-iconPassed, #89d185); }
        .review-item.is-failed .activity-mark, .review-item.is-stale .activity-mark, .review-item.is-timed-out .activity-mark { background: var(--vscode-errorForeground); }
        .review-item.is-rejected .activity-mark, .review-item.is-cancelled .activity-mark { background: var(--vscode-disabledForeground, #888); }
        .review-body { flex: 1; min-width: 0; }
        .review-line { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
        .review-subject { overflow-wrap: anywhere; }
        .review-delta { color: var(--vscode-descriptionForeground); }
        .review-status { color: var(--vscode-descriptionForeground); margin-left: auto; }
        .review-detail { color: var(--vscode-descriptionForeground); }
        .review-action { padding: 2px 8px; flex-shrink: 0; }
        .review-footer { margin-top: 4px; }
        button:focus-visible, summary:focus-visible, .terminal-output-box:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
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
            margin-bottom: 0;
        }
        .truncation-warning {
            color: var(--vscode-editorWarning-foreground, #e5a50a);
            font-size: 0.8em;
            margin-top: 4px;
        }
        .confirmation-actions {
            display: flex;
            flex-wrap: wrap;
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
        #activities {
            padding: 0 10px 6px;
            flex-shrink: 0;
            max-height: 140px;
            overflow-y: auto;
        }
        .activity-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }
        .activity-item {
            display: flex;
            gap: 8px;
            align-items: center;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            padding: 2px 0;
        }
        .activity-mark {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .activity-item.is-pending .activity-mark { background: var(--vscode-charts-blue, #75beff); }
        .activity-item.is-completed .activity-mark { background: var(--vscode-testing-iconPassed, #89d185); }
        .activity-item.is-failed .activity-mark { background: var(--vscode-errorForeground); }
        .activity-item.is-cancelled .activity-mark { background: var(--vscode-disabledForeground, #888); }
        #composer-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 8px 10px 10px;
            border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border, transparent));
            flex-shrink: 0;
        }
        #composer {
            resize: vertical;
            min-height: 64px;
            max-height: 200px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: inherit;
        }
        #composer:disabled {
            opacity: 0.65;
        }
        #controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }
        #composer-actions, #context-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            align-items: center;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 2px;
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #file-picker {
            display: none;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            max-height: 160px;
            overflow-y: auto;
        }
        #file-picker.open { display: block; }
        .file-hit {
            display: block;
            width: 100%;
            text-align: left;
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            padding: 6px 8px;
            cursor: pointer;
        }
        .file-hit:hover, .file-hit:focus {
            background: var(--vscode-list-hoverBackground);
        }
        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip: rect(0,0,0,0);
        }
    </style>
</head>
<body>
    <div id="header">
        <div id="header-main">
            <label class="sr-only" for="mode-selector">Agent mode</label>
            <select id="mode-selector" aria-label="Agent mode">
                <option value="ASK">ASK</option>
                <option value="PLAN">PLAN</option>
                <option value="BUILD">BUILD</option>
                <option value="DEBUG">DEBUG</option>
                <option value="REVIEW">REVIEW</option>
            </select>
            <div id="connection-status"></div>
        </div>
        <button id="new-chat-btn" class="secondary" aria-label="Start a new conversation">New</button>
    </div>
    
    <div id="transcript" role="log" aria-live="polite" aria-relevant="additions"></div>
    
    <div id="activities"></div>
    <div id="reviews"></div>
    <div id="terminal-container"></div>
    <div id="confirmation-container"></div>
    
    <div id="composer-container">
        <div id="implicit-chips" aria-label="Workspace context"></div>
        <div id="context-chips" aria-label="Attached context"></div>
        <div id="file-picker" role="listbox" aria-label="Workspace file matches"></div>
        <label class="sr-only" for="composer">Message</label>
        <textarea id="composer" placeholder="Ask the agent. Enter to send, Shift+Enter for a newline, @ to attach a file." aria-label="Message composer"></textarea>
        <div id="controls">
            <div id="context-actions">
                <button id="attach-file-btn" class="secondary" type="button" aria-label="Attach current file">File</button>
                <button id="attach-selection-btn" class="secondary" type="button" aria-label="Attach selected code">Selection</button>
                <button id="pick-file-btn" class="secondary" type="button" aria-label="Search workspace files">@ File</button>
            </div>
            <div id="composer-actions">
                <button id="cancel-btn" class="secondary" type="button" style="display: none;" aria-label="Cancel running task">Cancel</button>
                <button id="send-btn" type="button" aria-label="Send message">Send</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        ${webviewRenderRuntime()}

        const vscode = acquireVsCodeApi();
        
        const modeSelector = document.getElementById('mode-selector');
        const newChatBtn = document.getElementById('new-chat-btn');
        const transcript = document.getElementById('transcript');
        const activities = document.getElementById('activities');
        const terminalContainer = document.getElementById('terminal-container');
        const reviewsContainer = document.getElementById('reviews');
        const confirmationContainer = document.getElementById('confirmation-container');
        const implicitChips = document.getElementById('implicit-chips');
        const contextChips = document.getElementById('context-chips');
        const connectionStatus = document.getElementById('connection-status');
        const composer = document.getElementById('composer');
        const sendBtn = document.getElementById('send-btn');
        const cancelBtn = document.getElementById('cancel-btn');
        const attachFileBtn = document.getElementById('attach-file-btn');
        const attachSelectionBtn = document.getElementById('attach-selection-btn');
        const pickFileBtn = document.getElementById('pick-file-btn');
        const filePicker = document.getElementById('file-picker');
        
        let currentState = { activeTurn: false, attachments: [], context: [], messages: [], activities: [] };
        let sendInFlight = false;
        let lastAtQuery = '';
        const persisted = vscode.getState && vscode.getState();
        if (persisted && typeof persisted.draft === 'string') composer.value = persisted.draft;
        
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
                case 'context.searchResults':
                    renderFileHits(message.files || []);
                    break;
                case 'conversation.reset':
                    transcript.innerHTML = '';
                    activities.innerHTML = '';
                    renderTerminalOutput(terminalContainer, null, document);
                    renderReviewLedger(reviewsContainer, [], document);
                    confirmationContainer.innerHTML = '';
                    filePicker.innerHTML = '';
                    filePicker.className = '';
                    composer.value = '';
                    sendInFlight = false;
                    if (vscode.setState) vscode.setState({ draft: '' });
                    composer.focus();
                    break;
            }
        });
        
        function updateState(state) {
            var wasRunning = currentState && currentState.activeTurn;
            currentState = state;
            modeSelector.value = state.mode;
            sendInFlight = !!state.activeTurn;
            syncTranscript(transcript, state.messages || [], document, vscode.postMessage);
            renderTerminal(state.activeTerminal);
            renderConfirmationSummary(confirmationContainer, state.pendingConfirmation, document, vscode.postMessage);
            renderActivityTimeline(activities, state.activities || [], document);
            renderReviewLedger(reviewsContainer, state.reviews || [], document, vscode.postMessage);
            renderContextChips(implicitChips, state.context || [], document, vscode.postMessage, false);
            renderContextChips(contextChips, state.attachments || [], document, vscode.postMessage, true);
            renderConnectionStatus(connectionStatus, state.connection, document, vscode.postMessage);
            transcript.scrollTop = transcript.scrollHeight;
            if (state.activeTurn) {
                sendBtn.style.display = 'none';
                cancelBtn.style.display = 'inline-block';
                composer.disabled = true;
                sendBtn.disabled = true;
            } else {
                sendBtn.style.display = 'inline-block';
                cancelBtn.style.display = 'none';
                composer.disabled = false;
                sendBtn.disabled = false;
                if (wasRunning) composer.focus();
            }
        }

        let elapsedTimer = null;
        function renderTerminal(term) {
            renderTerminalOutput(terminalContainer, term, document, vscode.postMessage, draftRetry);
            const running = !!(term && term.status === 'RUNNING');
            if (running && !elapsedTimer) {
                elapsedTimer = setInterval(function () {
                    if (!updateTerminalElapsed(terminalContainer, Date.now())) {
                        clearInterval(elapsedTimer);
                        elapsedTimer = null;
                    }
                }, 1000);
            } else if (!running && elapsedTimer) {
                clearInterval(elapsedTimer);
                elapsedTimer = null;
            }
        }

        // Drafts a follow-up for the user to edit and send; nothing runs until a new turn is approved.
        function draftRetry(term) {
            if (currentState && currentState.activeTurn) return;
            composer.value = 'The command "' + term.command + '" ended as ' + String(term.status).toLowerCase() + '. Please investigate and run the check again.';
            if (vscode.setState) vscode.setState({ draft: composer.value });
            composer.focus();
        }

        function renderFileHits(files) {
            filePicker.innerHTML = '';
            if (!files.length) {
                filePicker.className = '';
                return;
            }
            filePicker.className = 'open';
            files.forEach(function (hit) {
                var btn = document.createElement('button');
                btn.className = 'file-hit';
                btn.type = 'button';
                btn.setAttribute('role', 'option');
                btn.textContent = hit.label || hit.path;
                btn.addEventListener('click', function () {
                    vscode.postMessage({ type: 'context.attachFile', path: hit.path });
                    var at = composer.value.lastIndexOf('@');
                    if (at >= 0) composer.value = composer.value.slice(0, at).replace(/\\s+$/, '');
                    filePicker.innerHTML = '';
                    filePicker.className = '';
                    composer.focus();
                });
                filePicker.appendChild(btn);
            });
        }

        function trySend() {
            if (sendInFlight || (currentState && currentState.activeTurn)) return;
            const text = composer.value.trim();
            if (!text) return;
            sendInFlight = true;
            sendBtn.disabled = true;
            vscode.postMessage({ type: 'chat.send', text: text, mode: modeSelector.value });
            composer.value = '';
            if (vscode.setState) vscode.setState({ draft: '' });
        }
        
        sendBtn.addEventListener('click', trySend);
        
        cancelBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'chat.cancel' });
        });
        
        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'chat.newConversation' });
        });
        
        modeSelector.addEventListener('change', () => {
            vscode.postMessage({ type: 'chat.setMode', mode: modeSelector.value });
        });

        attachFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'context.attach', target: 'current-file' });
        });
        attachSelectionBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'context.attach', target: 'selection' });
        });
        pickFileBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'context.pickFile' });
        });
        
        composer.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (currentState && currentState.activeTurn) {
                    vscode.postMessage({ type: 'chat.cancel' });
                }
                filePicker.innerHTML = '';
                filePicker.className = '';
                return;
            }
            handleComposerKeydown(e, trySend);
        });
        composer.addEventListener('input', () => {
            if (vscode.setState) vscode.setState({ draft: composer.value });
            var value = composer.value;
            var at = value.lastIndexOf('@');
            if (at >= 0) {
                var query = value.slice(at + 1).split(/\\s/)[0];
                if (query && query !== lastAtQuery && query.length <= 80) {
                    lastAtQuery = query;
                    vscode.postMessage({ type: 'context.search', query: query });
                }
            } else if (filePicker.className === 'open') {
                filePicker.innerHTML = '';
                filePicker.className = '';
                lastAtQuery = '';
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
