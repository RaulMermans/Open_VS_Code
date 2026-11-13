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
  renderConversationBar,
  renderHistoryPanel,
  renderRecoveryPanel,
  filterConversations,
  renderProfileSection,
  renderMcpDashboard,
  renderAddMcpWizard,
  renderToolInspector,
  renderSkillsSection,
  renderModesSection,
  renderDiagnosticsSection,
  renderIntegrationsHub,
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
  renderConversationBar,
  renderHistoryPanel,
  renderRecoveryPanel,
  filterConversations,
  renderProfileSection,
  renderMcpDashboard,
  renderAddMcpWizard,
  renderToolInspector,
  renderSkillsSection,
  renderModesSection,
  renderDiagnosticsSection,
  renderIntegrationsHub,
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

    webviewView.webview.html = this.htmlFor(webviewView.webview);
    
    this._controller.setWebviewView(webviewView);
  }
  
  public get view() {
    return this._view;
  }

  public htmlFor(webview: vscode.Webview, options?: { wide?: boolean }): string {
    return this._getHtmlForWebview(webview, options);
  }

  private _getHtmlForWebview(webview: vscode.Webview, options?: { wide?: boolean }) {
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
        .header-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }
        #header #conversation-bar { padding: 0; flex: 1; min-width: 0; }
        #overflow-menu { position: relative; }
        #overflow-menu > summary {
            list-style: none;
            cursor: pointer;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 2px;
            padding: 4px 8px;
        }
        #overflow-menu > summary::-webkit-details-marker { display: none; }
        .overflow-panel {
            position: absolute;
            right: 0;
            top: calc(100% + 4px);
            z-index: 5;
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 180px;
            padding: 6px;
            background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
            color: var(--vscode-menu-foreground, var(--vscode-foreground));
            border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
            border-radius: 4px;
        }
        #overflow-menu:not([open]) .overflow-panel { display: none; }
        .overflow-panel button { width: 100%; text-align: left; }
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
            max-width: 72ch;
        }
        body.wide-chat {
            background: var(--vscode-editor-background);
        }
        body.wide-chat .message { max-width: 100%; }
        body.wide-chat #header,
        body.wide-chat #transcript,
        body.wide-chat #activities,
        body.wide-chat #reviews,
        body.wide-chat #terminal-container,
        body.wide-chat #confirmation-container,
        body.wide-chat #composer-container,
        body.wide-chat #empty-state,
        body.wide-chat #recovery-container,
        body.wide-chat #trust-banner,
        body.wide-chat #model-manager {
            width: 100%;
            max-width: 920px;
            margin-left: auto;
            margin-right: auto;
            box-sizing: border-box;
        }
        body.wide-chat #header { padding: 8px 24px; }
        body.wide-chat #transcript { padding: 16px 24px 12px; }
        body.wide-chat #composer-container { padding: 12px 24px 16px; }
        body.wide-chat #composer {
            min-height: 44px;
            max-height: 280px;
        }
        body.wide-chat #wide-chat-btn { display: none; }
        body.wide-chat #reviews { max-height: 240px; }
        body.companion #transcript,
        body.companion #empty-state,
        body.companion #reviews,
        body.companion #terminal-container,
        body.companion #recovery-container,
        body.companion #model-manager,
        body.companion #trust-banner {
            flex: 0 0 0;
            flex-grow: 0;
            max-height: 0 !important;
            min-height: 0 !important;
            overflow: hidden;
            padding: 0 !important;
            margin: 0 !important;
            border: 0;
            visibility: hidden;
            pointer-events: none;
        }
        body.companion #activities {
            max-height: 28vh;
            overflow: auto;
        }
        body.companion #wide-chat-btn { display: none; }
        .outcome-card {
            margin-top: 8px;
            padding: 8px 10px;
            border-left: 3px solid var(--vscode-testing-iconPassed, #89d185);
            background: var(--vscode-editorWidget-background);
            border-radius: 4px;
        }
        .outcome-card.is-rejected {
            border-left-color: var(--vscode-editorWarning-foreground, #cca700);
        }
        .outcome-title { font-weight: 600; }
        .outcome-line, .outcome-file { margin-top: 4px; }
        .message.is-rejected {
            border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
        }
        .message.is-failed {
            border-left: 3px solid var(--vscode-errorForeground, #f14c4c);
        }
        .review-item.is-rejected .review-status { color: var(--vscode-editorWarning-foreground, #cca700); }
        .review-item.is-failed .review-status { color: var(--vscode-errorForeground, #f14c4c); }
        .review-item.is-verified .review-status,
        .review-item.is-applied .review-status { color: var(--vscode-testing-iconPassed, #89d185); }
        .trust-banner, .model-manager {
            margin: 8px 10px 0;
            padding: 8px;
            border: 1px solid var(--vscode-widget-border, transparent);
            border-radius: 6px;
            background: var(--vscode-editorWidget-background);
        }
        .model-manager h2 { margin: 0 0 6px; font-size: 0.95em; }
        .model-manager p, .trust-banner p { margin: 0 0 6px; font-size: 0.85em; }
        .model-manager label, .model-manager select, .model-manager input, .model-manager textarea {
            display: block;
            width: 100%;
            margin-bottom: 6px;
        }
        .model-manager textarea { min-height: 72px; }
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
            line-height: 1.45;
        }
        #empty-state {
            padding: 28px 16px 4px;
            color: var(--vscode-descriptionForeground);
        }
        #empty-state[hidden] { display: none; }
        .empty-title {
            margin: 0 0 6px;
            color: var(--vscode-foreground);
            font-size: 1.05em;
            font-weight: 600;
        }
        .empty-detail {
            margin: 0;
            line-height: 1.45;
            font-size: 0.92em;
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
            overflow: auto;
            max-height: 240px;
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
        .review-item.is-approved .activity-mark { background: var(--vscode-charts-orange, #cca700); }
        .review-item.is-applied .activity-mark, .review-item.is-verified .activity-mark, .review-item.is-succeeded .activity-mark { background: var(--vscode-testing-iconPassed, #89d185); }
        .review-item.is-failed .activity-mark, .review-item.is-stale .activity-mark, .review-item.is-timed-out .activity-mark { background: var(--vscode-errorForeground); }
        .review-item.is-rejected .activity-mark, .review-item.is-cancelled .activity-mark, .review-item.is-interrupted .activity-mark { background: var(--vscode-disabledForeground, #888); }
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
        .activity-item.is-cancelled .activity-mark, .activity-item.is-interrupted .activity-mark { background: var(--vscode-disabledForeground, #888); }
        .activity-summary { list-style: none; margin: 0; padding: 0; }
        .activity-trace { margin-top: 4px; }
        .activity-trace summary {
            cursor: pointer;
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
        }
        .activity-panel { padding-top: 2px; }
        @media (max-width: 420px) {
            #controls { flex-direction: column; align-items: stretch; }
            #composer-actions { justify-content: flex-end; }
            #model-selector, #mode-selector { min-width: 0; width: 100%; flex-basis: auto; }
            .message { padding: 6px 8px; }
        }
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
            min-height: 40px;
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
        #composer-meta {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            min-width: 0;
            flex: 1;
        }
        #model-selector {
            min-width: 140px;
            flex: 1 1 160px;
            max-width: 100%;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 6px;
            border-radius: 2px;
        }
        #connection-status { flex: 0 1 auto; min-width: 0; }
        #context-menu > summary {
            list-style: none;
            cursor: pointer;
            background: transparent;
            color: var(--vscode-textLink-foreground);
            padding: 2px 0;
        }
        #context-menu > summary::-webkit-details-marker { display: none; }
        .activity-fold { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
        .activity-fold summary { cursor: pointer; padding: 2px 0; }
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
        #conversation-bar { padding: 4px 10px 0; flex-shrink: 0; }
        .conversation-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }
        .conversation-title {
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
            flex: 1;
        }
        .conversation-status {
            font-size: 0.8em;
            padding: 1px 8px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            flex-shrink: 1;
            min-width: 0;
            max-width: 12em;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .conversation-status.is-interrupted, .conversation-status.is-failed {
            background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background));
            color: var(--vscode-inputValidation-warningForeground, var(--vscode-badge-foreground));
            border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
        }
        .conversation-action { padding: 2px 8px; flex-shrink: 0; }
        #history-panel {
            margin: 6px 10px 0;
            padding: 8px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            flex-shrink: 0;
            max-height: 45vh;
            overflow-y: auto;
        }
        #history-panel[hidden] { display: none; }
        .history-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
        #history-filter, .history-rename {
            flex: 1;
            min-width: 120px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 4px 6px;
            font-family: inherit;
            font-size: inherit;
        }
        #history-filter:focus-visible, .history-rename:focus-visible, .history-open:focus-visible, input[type=checkbox]:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }
        .history-archived-toggle { font-size: 0.85em; color: var(--vscode-descriptionForeground); display: inline-flex; gap: 4px; align-items: center; }
        .history-list { list-style: none; margin: 0; padding: 0; }
        .history-item { padding: 4px 0; border-top: 1px solid var(--vscode-widget-border, transparent); }
        .history-item:first-child { border-top: none; }
        .history-open {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            width: 100%;
            text-align: left;
            background: transparent;
            color: var(--vscode-foreground);
            padding: 4px 6px;
        }
        .history-open:hover { background: var(--vscode-list-hoverBackground); }
        .history-item.is-active .history-open {
            background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
            border-left: 2px solid var(--vscode-focusBorder);
        }
        .history-title { font-weight: 600; overflow-wrap: anywhere; }
        .history-meta { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
        .history-item.is-archived .history-title { font-style: italic; }
        .history-actions { display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 6px 0; }
        .history-actions button { padding: 1px 6px; font-size: 0.85em; }
        .history-empty, .history-notice { font-size: 0.85em; color: var(--vscode-descriptionForeground); padding: 4px 2px; }
        .history-notice { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
        .recovery-panel {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            padding: 10px;
            margin: 6px 10px;
            border-radius: 4px;
            flex-shrink: 0;
            max-height: 40vh;
            overflow-y: auto;
        }
        .recovery-panel.needs-inspection { border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground, #cca700)); }
        .recovery-state { margin: 6px 0; }
        .recovery-files { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; margin: 4px 0; }
        .recovery-options { margin: 6px 0 0; padding-left: 18px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
        .message.is-inherited {
            opacity: 0.8;
            border-style: dashed;
        }
        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip: rect(0,0,0,0);
        }

        /* Integration Manager UI Styles */
        body.integrations-mode #transcript,
        body.integrations-mode #activities,
        body.integrations-mode #reviews,
        body.integrations-mode #terminal-container,
        body.integrations-mode #confirmation-container,
        body.integrations-mode #composer-container,
        body.integrations-mode #conversation-bar,
        body.integrations-mode #history-panel,
        body.integrations-mode #recovery-container {
            display: none !important;
        }
        #integrations-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
            overflow-y: auto;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }
        #integrations-panel[hidden] {
            display: none !important;
        }
        .integrations-hub {
            display: flex;
            flex-direction: column;
            flex: 1;
            padding: 10px;
            gap: 10px;
            min-height: 0;
        }
        .hub-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.3)));
        }
        .hub-title {
            font-size: 1.05em;
            font-weight: 600;
            margin: 0;
        }
        .hub-close-btn {
            padding: 2px 8px;
            font-size: 0.8em;
        }
        .hub-nav {
            display: flex;
            gap: 4px;
            border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.3)));
            padding-bottom: 2px;
            overflow-x: auto;
        }
        .hub-tab-btn {
            background: transparent;
            color: var(--vscode-foreground);
            border: none;
            border-bottom: 2px solid transparent;
            padding: 4px 8px;
            font-size: 0.85em;
            cursor: pointer;
            border-radius: 0;
            white-space: nowrap;
        }
        .hub-tab-btn.is-active {
            color: var(--vscode-textLink-foreground);
            border-bottom-color: var(--vscode-focusBorder);
            font-weight: 600;
        }
        .hub-tab-btn.is-placeholder {
            opacity: 0.6;
            font-style: italic;
        }
        .hub-status-bar {
            font-size: 0.8em;
            color: var(--vscode-descriptionForeground);
            padding: 4px 6px;
            background: var(--vscode-editorWidget-background);
            border-radius: 3px;
        }
        .hub-confirmation-card {
            background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
            border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground, #cca700));
            padding: 8px 10px;
            border-radius: 4px;
            font-size: 0.85em;
        }
        .hub-tab-content {
            flex: 1;
            overflow-y: auto;
            min-height: 0;
        }
        .hub-card, .hub-wizard-panel, .hub-inspector-panel, .hub-skills-panel, .hub-diagnostics-panel, .hub-modes-placeholder {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            padding: 10px;
            margin-bottom: 10px;
        }
        .hub-card-header, .hub-wizard-header, .hub-inspector-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .hub-card-title {
            font-size: 0.95em;
            font-weight: 600;
            margin: 0;
        }
        .hub-toolbar {
            display: flex;
            gap: 6px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }
        .hub-btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 0.85em;
        }
        .hub-btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
        }
        .hub-btn-sm {
            padding: 2px 6px;
            font-size: 0.8em;
        }
        .hub-server-list, .hub-skills-list, .hub-tool-inspector-list, .hub-diagnostic-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .hub-server-card, .hub-skill-card, .hub-tool-card {
            border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
            border-radius: 4px;
            padding: 8px;
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        }
        .hub-server-header, .hub-skill-header, .hub-tool-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 8px;
        }
        .hub-server-name, .hub-tool-name {
            font-weight: 600;
            font-size: 0.9em;
        }
        .hub-server-id {
            font-size: 0.75em;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .hub-badge-group {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }
        .hub-transport-badge {
            font-size: 0.75em;
            padding: 1px 6px;
            border-radius: 8px;
        }
        .hub-provenance-badge.is-account {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .hub-provenance-badge.is-workspace {
            background: var(--vscode-charts-orange, #e5a50a);
            color: #000;
        }
        .hub-provenance-badge.is-local {
            background: var(--vscode-charts-green, #89d185);
            color: #000;
        }
        .hub-card-actions {
            display: flex;
            gap: 6px;
            margin-top: 8px;
            flex-wrap: wrap;
        }
        .hub-form-row {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 8px;
        }
        .hub-form-row.is-checkbox {
            flex-direction: row;
            align-items: center;
            gap: 8px;
        }
        .hub-input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 4px 6px;
            font-family: inherit;
            font-size: inherit;
            border-radius: 2px;
        }
        .hub-input:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .hub-transport-picker {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin: 8px 0;
        }
        .hub-transport-card {
            border: 1px solid var(--vscode-widget-border, #444);
            padding: 8px;
            border-radius: 4px;
            cursor: pointer;
        }
        .hub-transport-card.is-selected {
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-list-activeSelectionBackground, rgba(128, 128, 128, 0.2));
        }
        .hub-wizard-stepper {
            display: flex;
            gap: 6px;
            margin: 8px 0;
        }
        .hub-step-dot {
            font-size: 0.75em;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            opacity: 0.6;
        }
        .hub-step-dot.is-current {
            opacity: 1;
            font-weight: 600;
            outline: 1px solid var(--vscode-focusBorder);
        }
        .hub-step-dot.is-done {
            opacity: 0.9;
            background: var(--vscode-testing-iconPassed, #89d185);
            color: #000;
        }
        .hub-empty-state {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            padding: 12px 6px;
            text-align: center;
            font-style: italic;
        }
        .hub-warning-banner {
            font-size: 0.8em;
            padding: 4px 6px;
            border-radius: 3px;
            margin-top: 4px;
        }
        .hub-warning-banner.is-destructive {
            background: var(--vscode-errorForeground);
            color: #fff;
        }
        .hub-warning-banner.is-sensitive {
            background: var(--vscode-editorWarning-foreground, #cca700);
            color: #000;
        }
        .hub-schema-pre {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.75em;
            background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
            padding: 6px;
            border-radius: 3px;
            overflow-x: auto;
            max-height: 120px;
        }
        .hub-error-row {
            color: var(--vscode-errorForeground);
            font-size: 0.8em;
            margin-top: 4px;
        }
        .hub-error-banner {
            background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
            border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
            color: var(--vscode-errorForeground);
            padding: 6px 8px;
            border-radius: 4px;
            font-size: 0.85em;
            margin-bottom: 8px;
        }
    </style>
</head>
<body class="${options?.wide ? "wide-chat" : ""}">
    <div id="header">
        <div id="conversation-bar"></div>
        <div class="header-actions">
            <button id="models-btn" class="secondary" type="button" aria-label="Open model manager" aria-expanded="false" aria-controls="model-manager">Models</button>
            <button id="wide-chat-btn" class="secondary" type="button" aria-label="Open a wider chat beside the editor">Wider chat</button>
            <button id="new-chat-btn" class="secondary" type="button" aria-label="Start a new conversation">New</button>
            <button id="history-btn" class="secondary" type="button" aria-expanded="false" aria-controls="history-panel" aria-label="Show conversation history">History</button>
            <details id="overflow-menu">
                <summary aria-label="Agent settings">More</summary>
                <div class="overflow-panel">
                    <button id="browser-panel-btn" class="secondary" type="button" aria-label="Open visual browser panel">Visual browser</button>
                    <button id="integrations-btn" class="secondary" type="button" aria-expanded="false" aria-controls="integrations-panel" aria-label="Open integrations manager">Tools</button>
                    <button id="model-btn" class="secondary" type="button" aria-label="Select local model">Model list</button>
                </div>
            </details>
        </div>
    </div>
    <div id="integrations-panel" role="region" aria-label="Visual integration manager" hidden></div>
    <div id="history-panel" role="region" aria-label="Conversation history" hidden>
        <div class="history-controls">
            <label class="sr-only" for="history-filter">Filter conversations</label>
            <input id="history-filter" type="search" placeholder="Filter by title or first message" aria-label="Filter conversations by title or first message" autocomplete="off">
            <label class="history-archived-toggle"><input id="history-archived" type="checkbox"> Show archived</label>
        </div>
        <div id="history-list"></div>
    </div>
    <div id="trust-banner"></div>
    <div id="model-manager"></div>
    <div id="recovery-container"></div>

    <div id="empty-state">
        <p class="empty-title">Ask about this workspace</p>
        <p class="empty-detail">Ask is read-only. Plan does not edit until you approve. Agent waits for approval before writing.</p>
        <button id="empty-setup" class="secondary" type="button" hidden>Choose a model</button>
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
        <textarea id="composer" placeholder="Ask anything. Enter to send, Shift+Enter for a newline, @ to attach a file." aria-label="Message composer"></textarea>
        <div id="controls">
            <div id="composer-meta">
                <label class="sr-only" for="mode-selector">Agent mode</label>
                <select id="mode-selector" aria-label="Agent mode">
                    <optgroup label="Mode">
                        <option value="ASK">Ask</option>
                        <option value="PLAN">Plan</option>
                        <option value="BUILD">Agent</option>
                    </optgroup>
                    <optgroup label="More">
                        <option value="DEBUG">Debug</option>
                        <option value="REVIEW">Review</option>
                    </optgroup>
                </select>
                <span id="mode-badge" class="status-badge" style="display:none;"></span>
                <label class="sr-only" for="model-selector">Local model</label>
                <select id="model-selector" aria-label="Local model"></select>
                <div id="connection-status"></div>
            </div>
            <div id="composer-actions">
                <details id="context-menu">
                    <summary>Context</summary>
                    <div id="context-actions">
                        <button id="attach-file-btn" class="secondary" type="button" aria-label="Attach current file">File</button>
                        <button id="attach-selection-btn" class="secondary" type="button" aria-label="Attach selected code">Selection</button>
                        <button id="pick-file-btn" class="secondary" type="button" aria-label="Search workspace files">@ File</button>
                    </div>
                </details>
                <button id="cancel-btn" class="secondary" type="button" style="display: none;" aria-label="Cancel running task">Stop</button>
                <button id="send-btn" type="button" aria-label="Send message">Send</button>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        ${webviewRenderRuntime()}

        const vscode = acquireVsCodeApi();
        
        const modeSelector = document.getElementById('mode-selector');
        const modelSelector = document.getElementById('model-selector');
        const modeBadge = document.getElementById('mode-badge');
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
        
        const browserPanelBtn = document.getElementById('browser-panel-btn');
        const integrationsBtn = document.getElementById('integrations-btn');
        const integrationsPanel = document.getElementById('integrations-panel');
        let integrationsOpen = false;
        let lastIntegrationsState = null;

        const modelBtn = document.getElementById('model-btn');
        const historyBtn = document.getElementById('history-btn');
        const historyPanel = document.getElementById('history-panel');
        const historyList = document.getElementById('history-list');
        const historyFilter = document.getElementById('history-filter');
        const historyArchived = document.getElementById('history-archived');
        const conversationBar = document.getElementById('conversation-bar');
        const recoveryContainer = document.getElementById('recovery-container');
        let historyOpen = false;
        let showArchived = false;
        let renamingId = null;
        let historyResult = null;

        let currentState = { activeTurn: false, attachments: [], context: [], messages: [], activities: [], conversations: [] };
        let sendInFlight = false;
        // Follow new output only when the reader is at the bottom, or after they send.
        // "At the bottom" is tracked from scroll events, so state pushes never read layout.
        let scrollOnNextChange = true;
        let pinnedToBottom = true;
        let lastAtQuery = '';
        const persisted = vscode.getState && vscode.getState();
        if (persisted && typeof persisted.draft === 'string') composer.value = persisted.draft;
        
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'chat.state':
                    if (message.state) message.state.wideOpen = !!message.wideOpen;
                    updateState(message.state, message.transcript === 'unchanged');
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
                case 'integration.state':
                    handleIntegrationState(message.state, message.open);
                    break;
                case 'conversation.reset':
                    renamingId = null;
                    renderRecoveryPanel(recoveryContainer, null, '', document);
                    transcript.innerHTML = '';
                    currentState = Object.assign({}, currentState, { messages: [] });
                    scrollOnNextChange = true;
                    renderActivityTimeline(activities, [], document);
                    renderTerminalOutput(terminalContainer, null, document);
                    renderReviewLedger(reviewsContainer, [], document);
                    renderConfirmationSummary(confirmationContainer, null, document);
                    filePicker.innerHTML = '';
                    filePicker.className = '';
                    composer.value = '';
                    sendInFlight = false;
                    if (vscode.setState) vscode.setState({ draft: '' });
                    composer.focus();
                    break;
            }
        });
        
        function atBottom(el) {
            return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }

        var lastModesSig = '__initial__';
        function syncModeSelector(state) {
            var currentVal = state.customModeId ? 'custom:' + state.customModeId : state.mode;
            var customModes = state.customModes || [];
            var trusted = state.workspaceTrusted !== false;
            var modesSig = (trusted ? 'trusted' : 'restricted') + '|' + customModes.map(function(m) { return m.id + ':' + m.name + ':' + m.isReady; }).join('|');
            if (modesSig !== lastModesSig) {
                lastModesSig = modesSig;
                modeSelector.innerHTML = '';
                var primary = document.createElement('optgroup');
                primary.label = 'Mode';
                [{ value: 'ASK', label: 'Ask' }, { value: 'PLAN', label: 'Plan' }, { value: 'BUILD', label: 'Agent' }].forEach(function(m) {
                    var opt = document.createElement('option');
                    opt.value = m.value;
                    var restricted = !trusted && (m.value === 'BUILD');
                    opt.textContent = restricted ? m.label + ' (needs trust)' : m.label;
                    opt.disabled = restricted;
                    primary.appendChild(opt);
                });
                modeSelector.appendChild(primary);
                var more = document.createElement('optgroup');
                more.label = 'More';
                [{ value: 'DEBUG', label: 'Debug' }, { value: 'REVIEW', label: 'Review' }].forEach(function(m) {
                    var opt = document.createElement('option');
                    opt.value = m.value;
                    var restricted = !trusted && m.value === 'DEBUG';
                    opt.textContent = restricted ? m.label + ' (needs trust)' : m.label;
                    opt.disabled = restricted;
                    more.appendChild(opt);
                });
                modeSelector.appendChild(more);

                if (customModes.length) {
                    var cGroup = document.createElement('optgroup');
                    cGroup.label = 'Custom';
                    customModes.forEach(function(cm) {
                        var opt = document.createElement('option');
                        opt.value = 'custom:' + cm.id;
                        opt.textContent = cm.name + ' (' + cm.baseMode + ')' + (cm.isReady ? '' : ' ⚠️');
                        cGroup.appendChild(opt);
                    });
                    modeSelector.appendChild(cGroup);
                }
            }
            if (modeSelector.value !== currentVal) {
                modeSelector.value = currentVal;
                if (modeSelector.value !== currentVal && state.mode) {
                    modeSelector.value = state.mode;
                }
            }
        }

        var lastBadgeSig = '__initial__';
        function syncModeBadge(state) {
            if (!modeBadge) return;
            var p = state.activeCustomProfile;
            var badgeSig = p ? (p.id + ':' + p.isReady) : '';
            if (badgeSig === lastBadgeSig) return;
            lastBadgeSig = badgeSig;
            if (p) {
                modeBadge.style.display = 'inline-block';
                modeBadge.textContent = (p.isReady ? '✓ ' : '⚠️ ') + p.name + ' [' + p.baseMode + ']';
                modeBadge.title = p.description + (p.isReady ? ' (Ready)' : ' (Missing dependencies)');
                modeBadge.className = 'status-badge ' + (p.isReady ? 'is-running' : 'is-disabled');
            } else {
                modeBadge.style.display = 'none';
            }
        }

        function syncEmptyState(state) {
            var empty = document.getElementById('empty-state');
            if (!empty) return;
            var hasMessages = !!(state.messages && state.messages.length);
            empty.hidden = hasMessages;
            if (hasMessages) return;
            var title = empty.querySelector('.empty-title');
            var detail = empty.querySelector('.empty-detail');
            var conn = state.connection || {};
            var offline = conn.state === 'disconnected' || conn.state === 'unavailable' || conn.state === 'missing-config' || conn.state === 'timeout' || conn.state === 'model-unavailable' || conn.state === 'invalid-credentials';
            var setup = document.getElementById('empty-setup');
            var needsModel = conn.state === 'missing-config';
            if (title) title.textContent = needsModel ? 'Choose a local model' : (offline ? 'Local model unavailable' : 'Ask about this workspace');
            if (detail) detail.textContent = needsModel
                ? 'Use Models to pick a chat model and an autocomplete model. That choice is kept for every folder. No project file is required.'
                : offline
                ? (conn.detail || 'Start the local model endpoint, then test the connection.')
                : (state.workspaceTrusted === false
                    ? 'This folder is not trusted. Ask can read it. Agent and Debug stay unavailable until you trust the folder.'
                    : 'Ask is read-only. Plan does not edit until you approve. Agent waits for approval before writing.');
            if (setup) setup.hidden = !needsModel;
        }

        function updateState(state, transcriptUnchanged) {
            var wasRunning = currentState && currentState.activeTurn;
            // The host omits an unchanged transcript; keep the one already rendered.
            if (transcriptUnchanged) state.messages = (currentState && currentState.messages) || [];
            currentState = state;
            if (document.body && document.body.classList) {
                document.body.classList.toggle('companion', !!state.wideOpen && !document.body.classList.contains('wide-chat'));
            }
            syncModeSelector(state);
            syncModeBadge(state);
            syncModelSelector(state.connection);
            sendInFlight = !!state.activeTurn;
            if (typeof state.composerDraft === 'string' && document.activeElement !== composer) {
                if (composer.value !== state.composerDraft) composer.value = state.composerDraft;
            }
            var follow = false;
            if (!transcriptUnchanged) {
                follow = scrollOnNextChange || pinnedToBottom;
                var changes = syncTranscript(transcript, state.messages || [], document, vscode.postMessage);
                if (!(changes.created || changes.updated || changes.removed)) follow = false;
            }
            renderTerminal(state.activeTerminal);
            renderConfirmationSummary(confirmationContainer, state.pendingConfirmation, document, vscode.postMessage);
            renderActivityTimeline(activities, state.activities || [], document);
            syncEmptyState(state);
            renderReviewLedger(reviewsContainer, state.reviews || [], document, vscode.postMessage);
            renderContextChips(implicitChips, state.context || [], document, vscode.postMessage, false);
            renderContextChips(contextChips, state.attachments || [], document, vscode.postMessage, true);
            renderConnectionStatus(connectionStatus, state.connection, document, vscode.postMessage);
            var trustBanner = document.getElementById('trust-banner');
            var modelManager = document.getElementById('model-manager');
            if (trustBanner) renderTrustNotice(trustBanner, state, document, vscode.postMessage);
            if (modelManager) renderModelManager(modelManager, state.modelManager, document, vscode.postMessage);
            var modelsBtn = document.getElementById('models-btn');
            if (modelsBtn) modelsBtn.setAttribute('aria-expanded', state.modelManager && state.modelManager.open ? 'true' : 'false');
            renderConversationBar(conversationBar, state, document, vscode.postMessage);
            renderRecoveryPanel(recoveryContainer, state.recovery, state.conversationTitle, document, vscode.postMessage);
            renderHistory();
            if (follow) {
                transcript.scrollTop = transcript.scrollHeight;
                scrollOnNextChange = false;
            }
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

        transcript.addEventListener('scroll', function () { pinnedToBottom = atBottom(transcript); });

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

        function renderHistory() {
            if (!historyOpen) return;
            historyResult = renderHistoryPanel(historyList, currentState.conversations || [], {
                activeId: currentState.conversationId,
                filter: historyFilter.value,
                showArchived: showArchived,
                renamingId: renamingId,
                history: currentState.history,
                now: Date.now(),
            }, document, vscode.postMessage, {
                onRenameStart: function (id) { renamingId = id; renderHistory(); },
                onRenameDone: function (id) { renamingId = null; renderHistory(); focusHistoryItem(id); },
                onOpen: function () { setHistoryOpen(false, false); },
            });
        }

        function focusHistoryItem(id) {
            if (!historyResult || !historyResult.openButtons.length) return;
            var list = filterConversations(currentState.conversations || [], historyFilter.value, showArchived);
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === id && historyResult.openButtons[i]) { historyResult.openButtons[i].focus(); return; }
            }
            historyResult.openButtons[0].focus();
        }

        function setHistoryOpen(open, restoreFocus) {
            historyOpen = open;
            historyPanel.hidden = !open;
            historyBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) {
                renderHistory();
                historyFilter.focus();
            } else {
                renamingId = null;
                if (restoreFocus) historyBtn.focus(); else composer.focus();
            }
        }

        modelBtn.addEventListener('click', function () { vscode.postMessage({ type: 'ui.selectModel' }); });
        var modelsBtn = document.getElementById('models-btn');
        if (modelsBtn) modelsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'modelManager.open' }); });
        var emptySetup = document.getElementById('empty-setup');
        if (emptySetup) emptySetup.addEventListener('click', function () { vscode.postMessage({ type: 'modelManager.open' }); });
        var wideChatBtn = document.getElementById('wide-chat-btn');
        if (wideChatBtn) wideChatBtn.addEventListener('click', function () { vscode.postMessage({ type: 'ui.openWideChat' }); });
        historyBtn.addEventListener('click', function () { setHistoryOpen(!historyOpen, true); });
        historyFilter.addEventListener('input', function () { renderHistory(); });
        historyFilter.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' && historyResult && historyResult.openButtons.length) {
                e.preventDefault();
                historyResult.openButtons[0].focus();
            }
        });
        historyArchived.addEventListener('change', function () { showArchived = !!historyArchived.checked; renderHistory(); });
        historyPanel.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !renamingId) { e.preventDefault(); setHistoryOpen(false, true); }
        });

        function handleIntegrationState(state, open) {
            integrationsOpen = !!open;
            integrationsPanel.hidden = !open;
            integrationsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            document.body.classList.toggle('integrations-mode', open);
            if (open) setHistoryOpen(false, false);
            if (state) lastIntegrationsState = state;
            if (open && lastIntegrationsState) {
                renderIntegrationsHub(integrationsPanel, lastIntegrationsState, document, vscode.postMessage);
            }
        }

        if (browserPanelBtn) {
            browserPanelBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'ui.openBrowserPanel' });
            });
        }

        integrationsBtn.addEventListener('click', function () {
            if (integrationsOpen) {
                vscode.postMessage({ type: 'integration.closeHub' });
            } else {
                vscode.postMessage({ type: 'integration.openHub' });
            }
        });

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
            scrollOnNextChange = true;
            var val = modeSelector.value;
            var sendMode = val;
            var sendCustomId = undefined;
            if (val.startsWith('custom:')) {
                sendCustomId = val.slice(7);
                var cMode = (currentState && currentState.customModes || []).find(m => m.id === sendCustomId);
                sendMode = cMode ? cMode.baseMode : (currentState && currentState.mode) || 'ASK';
            }
            vscode.postMessage({ type: 'chat.send', text: text, mode: sendMode, customModeId: sendCustomId });
            composer.value = '';
            if (vscode.setState) vscode.setState({ draft: '' });
            vscode.postMessage({ type: 'chat.draft', text: '' });
        }
        
        sendBtn.addEventListener('click', trySend);
        
        cancelBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'chat.cancel' });
        });
        
        newChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'chat.newConversation' });
        });
        
        var lastModelSig = '__initial__';
        var syncingModels = false;
        function preferredModelRank(name) {
            if (name.indexOf('qwen3-coder') === 0) return 0;
            if (name.indexOf('qwen2.5-coder') === 0) return 1;
            return 2;
        }
        function syncModelSelector(connection) {
            if (!modelSelector) return;
            var models = (connection && connection.installedModels) ? connection.installedModels.slice() : [];
            models.sort(function(a, b) {
                var rank = preferredModelRank(a) - preferredModelRank(b);
                return rank !== 0 ? rank : a.localeCompare(b);
            });
            var selected = (connection && (connection.selectedModel || connection.modelLabel)) || '';
            var sig = models.join('|') + '#' + selected + '#' + (connection && connection.state || '');
            if (sig === lastModelSig) return;
            lastModelSig = sig;
            syncingModels = true;
            modelSelector.innerHTML = '';
            if (!models.length) {
                var empty = document.createElement('option');
                empty.value = '';
                empty.textContent = connection && connection.state === 'disconnected' ? 'Ollama offline' : (connection && connection.state === 'missing-config' ? 'No model config' : 'No models');
                modelSelector.appendChild(empty);
                modelSelector.disabled = true;
                syncingModels = false;
                return;
            }
            models.forEach(function(name) {
                var opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                modelSelector.appendChild(opt);
            });
            modelSelector.disabled = !!(currentState && currentState.activeTurn);
            if (selected && models.indexOf(selected) >= 0) modelSelector.value = selected;
            syncingModels = false;
        }
        if (modelSelector) {
            modelSelector.addEventListener('change', function() {
                if (syncingModels) return;
                var name = modelSelector.value;
                if (!name) return;
                vscode.postMessage({ type: 'ui.applyModel', name: name });
            });
        }

        modeSelector.addEventListener('change', () => {
            var val = modeSelector.value;
            if (val.startsWith('custom:')) {
                var cId = val.slice(7);
                var cMode = (currentState && currentState.customModes || []).find(m => m.id === cId);
                vscode.postMessage({ type: 'chat.setMode', mode: cMode ? cMode.baseMode : 'ASK', customModeId: cId });
            } else {
                vscode.postMessage({ type: 'chat.setMode', mode: val });
            }
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
            vscode.postMessage({ type: 'chat.draft', text: composer.value });
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
