import * as vscode from 'vscode';
import { AgentSessionBridge, IdeHost, IdeContextSnapshot, WorkspaceRoot, EditorDocument, EditorSelection, EditorDiagnostic, EditorPosition, resolveWorkspaceRoot } from '@open-vs-code/ide-adapter';
import { HaloProvider, capabilityForAgentMode, probeHalo, createProductionAutocompleteGateway, type AutocompleteGateway } from '@open-vs-code/agent-core';


class VSCodeIdeHost implements IdeHost {
  private outputChannel: vscode.OutputChannel;
  
  constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Open VS Code Agent");
  }

  async getWorkspaceRoots(): Promise<WorkspaceRoot[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];
    return folders.map(f => ({
      uri: f.uri.toString(),
      fsPath: f.uri.fsPath,
      name: f.name
    }));
  }

  async getActiveDocument(): Promise<EditorDocument | null> {
    const active = vscode.window.activeTextEditor;
    if (!active) return null;
    const doc = active.document;
    return {
      uri: doc.uri.toString(),
      workspaceRelativePath: vscode.workspace.asRelativePath(doc.uri),
      languageId: doc.languageId,
      version: doc.version,
      isDirty: doc.isDirty
    };
  }

  async getSelection(): Promise<EditorSelection | null> {
    const active = vscode.window.activeTextEditor;
    if (!active) return null;
    const selection = active.selection;
    if (!selection || selection.isEmpty || !selection.start || !selection.end) return null;
    
    // Bound the selected text if it's too large
    let text = active.document.getText(selection);
    if (text.length > 50000) {
      text = text.substring(0, 50000) + "\n\n...[Truncated]";
    }
    
    return {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
      selectedText: text
    };
  }

  async getVisibleDocuments(): Promise<EditorDocument[]> {
    const visible = vscode.window.visibleTextEditors;
    return visible.slice(0, 20).map(e => ({
      uri: e.document.uri.toString(),
      workspaceRelativePath: vscode.workspace.asRelativePath(e.document.uri),
      languageId: e.document.languageId,
      version: e.document.version,
      isDirty: e.document.isDirty
    }));
  }

  async getDiagnostics(): Promise<EditorDiagnostic[]> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    const allDiagnostics = vscode.languages.getDiagnostics();
    let result: EditorDiagnostic[] = [];
    
    // Prioritize active file
    if (activeDoc) {
      const activeDiags = vscode.languages.getDiagnostics(activeDoc.uri);
      result.push(...this.mapDiagnostics(activeDoc.uri, activeDiags));
    }
    
    for (const [uri, diags] of allDiagnostics) {
      if (activeDoc && uri.toString() === activeDoc.uri.toString()) continue;
      result.push(...this.mapDiagnostics(uri, diags));
      if (result.length >= 100) break; // Bounded diagnostics
    }
    
    return result.slice(0, 100);
  }
  
  private mapDiagnostics(uri: vscode.Uri, diags: readonly vscode.Diagnostic[]): EditorDiagnostic[] {
    return diags.map(d => ({
      path: uri.fsPath,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" :
                d.severity === vscode.DiagnosticSeverity.Warning ? "warning" :
                d.severity === vscode.DiagnosticSeverity.Information ? "information" : "hint",
      message: d.message,
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character }
      },
      source: d.source,
      code: typeof d.code === 'object' ? d.code.value : d.code
    }));
  }

  async isWorkspaceTrusted(): Promise<boolean> {
    return vscode.workspace.isTrusted;
  }

  async showOutput(message: string): Promise<void> {
    this.outputChannel.appendLine(message);
    this.outputChannel.show(true);
  }

  async showError(message: string): Promise<void> {
    vscode.window.showErrorMessage(message);
    this.outputChannel.appendLine(`ERROR: ${message}`);
  }

  async requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT"> {
    if (chatController) {
      return chatController.requestConfirmation(prompt, payload);
    }
    const res = await vscode.window.showWarningMessage(prompt, { modal: true }, "Approve", "Reject");
    return res === "Approve" ? "APPROVE" : "REJECT";
  }

  onWorkspaceChange(listener: () => void): { dispose: () => void; } {
    const d1 = vscode.workspace.onDidChangeWorkspaceFolders(listener);
    const d2 = vscode.window.onDidChangeActiveTextEditor(listener);
    const d3 = vscode.window.onDidChangeTextEditorSelection(listener);
    const d4 = vscode.languages.onDidChangeDiagnostics(listener);
    return {
      dispose: () => {
        d1.dispose();
        d2.dispose();
        d3.dispose();
        d4.dispose();
      }
    };
  }

  async getSnapshot(): Promise<IdeContextSnapshot> {
    return {
      workspaceRoots: await this.getWorkspaceRoots(),
      activeDocument: await this.getActiveDocument(),
      selection: await this.getSelection(),
      visibleDocuments: await this.getVisibleDocuments(),
      diagnostics: await this.getDiagnostics(),
      isTrusted: await this.isWorkspaceTrusted()
    };
  }
  
  dispose() {
    this.outputChannel.dispose();
  }
}

import { ChatController } from './chat-controller.js';
import { ChatViewProvider } from './chat-view-provider.js';
import { DiffReviewController } from './diff-review-controller.js';
import { TerminalReviewController } from './terminal-review-controller.js';
import { AutocompleteController } from './autocomplete-controller.js';

let activeBridge: AgentSessionBridge | null = null;
let currentAbortController: AbortController | null = null;
let host: VSCodeIdeHost | null = null;
let chatController: ChatController | null = null;
let diffReviewController: DiffReviewController | null = null;
let terminalReviewController: TerminalReviewController | null = null;
let autocompleteController: AutocompleteController | null = null;

export const _testSeam = {
  get activeBridge() { return activeBridge; },
  bridgeFactory: null as any,
  get chatController() { return chatController; },
  get terminalReviewController() { return terminalReviewController; },
  get autocompleteController() { return autocompleteController; },
  /** For tests only: inject a ChatController so deactivate() exercises the real path. */
  setChatController(c: ChatController | null) { chatController = c; },
  /** For tests only: inject a TerminalReviewController so deactivate() clears it. */
  setTerminalReviewController(c: TerminalReviewController | null) { terminalReviewController = c; },
  /** For tests only: inject an AutocompleteController so deactivate() exercises the real path. */
  setAutocompleteController(c: AutocompleteController | null) { autocompleteController = c; },
  autocompleteGatewayFactory: null as ((workspaceRoot?: string) => AutocompleteGateway) | null,
};

const HALO_TOKEN_SECRET_KEY = 'halo.appToken';
const HALO_DEFAULT_URL = 'http://127.0.0.1:4310';

function haloSettings() {
  const settings = vscode.workspace.getConfiguration('open-vs-code');
  return {
    backend: settings.get<'halo' | 'standalone-local'>('inferenceBackend', 'standalone-local'),
    coreUrl: settings.get<string>('halo.coreUrl', HALO_DEFAULT_URL),
    timeoutMs: settings.get<number>('halo.timeoutMs', 30_000),
  };
}

function haloToken(context: vscode.ExtensionContext): () => Promise<string | undefined> {
  return async () => await context.secrets.get(HALO_TOKEN_SECRET_KEY) ?? process.env.HALO_APP_TOKEN_OPEN_VSCODE;
}

export function activate(context: vscode.ExtensionContext) {
  host = new VSCodeIdeHost();
  diffReviewController = new DiffReviewController();
  terminalReviewController = new TerminalReviewController();
  
  if (vscode.workspace.registerTextDocumentContentProvider) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('open-vs-code-diff', diffReviewController)
    );
  }

  // Wire production AutocompleteController into extension activation
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!autocompleteController) {
    const gateway = _testSeam.autocompleteGatewayFactory
      ? _testSeam.autocompleteGatewayFactory(workspaceRoot)
      : createProductionAutocompleteGateway(workspaceRoot);
    autocompleteController = new AutocompleteController({ gateway });
  }
  autocompleteController.register(context);

  chatController = new ChatController(host, diffReviewController, terminalReviewController, (options: { host: any, workspaceRoot: string, mode: 'ASK' | 'PLAN' | 'BUILD' | 'DEBUG' | 'REVIEW' }) => {

    if (_testSeam.bridgeFactory) {
      activeBridge = _testSeam.bridgeFactory(options);
    } else {
      const settings = haloSettings();
      const providerOverride = settings.backend === 'halo'
        ? new HaloProvider({
          coreUrl: settings.coreUrl,
          timeoutMs: settings.timeoutMs,
          capability: capabilityForAgentMode(options.mode),
          token: haloToken(context),
        })
        : undefined;
      activeBridge = new AgentSessionBridge({ ...options, ...(providerOverride ? { providerOverride } : {}) });
    }
    return activeBridge!;
  });

  const provider = new ChatViewProvider(context.extensionUri, chatController);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
  );
  
  const updateContext = async () => {
    if (chatController && host) {
      try {
        chatController.refreshContext(await host.getSnapshot());
      } catch {
        // Safe context refresh ignore
      }
    }
  };
  
  context.subscriptions.push(host.onWorkspaceChange(updateContext));
  updateContext(); // Initial context
  
  const registerAgentCommand = (commandId: string, mode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW") => {
    return vscode.commands.registerCommand(commandId, async () => {
      await chatController?.handleCommand(mode);
    });
  };

  context.subscriptions.push(
    registerAgentCommand('open-vs-code.ask', 'ASK'),
    registerAgentCommand('open-vs-code.plan', 'PLAN'),
    registerAgentCommand('open-vs-code.build', 'BUILD'),
    registerAgentCommand('open-vs-code.debug', 'DEBUG'),
    registerAgentCommand('open-vs-code.review', 'REVIEW'),
    vscode.commands.registerCommand('open-vs-code.setHaloToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'HALO application token for Open VS Code',
        password: true,
        ignoreFocusOut: true,
      });
      if (!token?.trim()) return;
      await context.secrets.store(HALO_TOKEN_SECRET_KEY, token.trim());
      await host?.showOutput('HALO application token saved to VS Code SecretStorage.');
    }),
    vscode.commands.registerCommand('open-vs-code.checkHaloConnection', async () => {
      const settings = haloSettings();
      if (settings.backend !== 'halo') {
        await host?.showOutput('HALO is not selected. Select the HALO inference backend to use it.');
        return;
      }
      try {
        const reachable = await probeHalo(settings.coreUrl);
        await host?.showOutput(reachable ? 'HALO reachable.' : 'HALO Core is unavailable.');
      } catch {
        await host?.showOutput('HALO Core is unreachable.');
      }
    }),
    { dispose: () => host?.dispose() }
  );
}

export function deactivate() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (autocompleteController) {
    autocompleteController.dispose();
    autocompleteController = null;
  }
  if (chatController) {
    chatController.cancelTurn();
    chatController = null;
  }
  if (diffReviewController) {
    diffReviewController.clearAll();
    diffReviewController = null;
  }
  if (terminalReviewController) {
    terminalReviewController.clearAll();
    terminalReviewController = null;
  }
  if (host) {
    host.dispose();
  }
  activeBridge = null;
}
