import * as vscode from 'vscode';
import { AgentSessionBridge, IdeHost, IdeContextSnapshot, WorkspaceRoot, EditorDocument, EditorSelection, EditorDiagnostic, EditorPosition, resolveWorkspaceRoot } from '@open-vs-code/ide-adapter';

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
    if (selection.isEmpty) return null;
    
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
    const res = await vscode.window.showWarningMessage(prompt, { modal: true }, "Approve", "Reject");
    return res === "Approve" ? "APPROVE" : "REJECT";
  }

  onWorkspaceChange(listener: () => void): { dispose: () => void; } {
    const d1 = vscode.workspace.onDidChangeWorkspaceFolders(listener);
    const d2 = vscode.window.onDidChangeActiveTextEditor(listener);
    return {
      dispose: () => {
        d1.dispose();
        d2.dispose();
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

let activeBridge: AgentSessionBridge | null = null;
let currentAbortController: AbortController | null = null;
let host: VSCodeIdeHost | null = null;

export const _testSeam = {
  get activeBridge() { return activeBridge; },
  bridgeFactory: null as any
};

export function activate(context: vscode.ExtensionContext) {
  host = new VSCodeIdeHost();
  
  const registerAgentCommand = (commandId: string, mode: "ASK" | "PLAN" | "BUILD" | "DEBUG" | "REVIEW") => {
    return vscode.commands.registerCommand(commandId, async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("Open VS Code Agent requires an open workspace.");
        return;
      }
      
      const activeEditor = vscode.window.activeTextEditor;
      
      const snapshot: IdeContextSnapshot = {
        workspaceRoots: folders.map(f => ({ uri: f.uri.toString(), fsPath: f.uri.fsPath, name: f.name })),
        activeDocument: activeEditor ? {
          uri: activeEditor.document.uri.toString(),
          workspaceRelativePath: vscode.workspace.asRelativePath(activeEditor.document.uri),
          languageId: activeEditor.document.languageId,
          version: activeEditor.document.version,
          isDirty: activeEditor.document.isDirty
        } : null,
        selection: null,
        visibleDocuments: [],
        diagnostics: [],
        isTrusted: vscode.workspace.isTrusted
      };
      
      const resolvedRoot = resolveWorkspaceRoot(snapshot);
      if (!resolvedRoot) {
          vscode.window.showErrorMessage("Could not resolve a workspace root.");
          return;
      }
      
      const instruction = await vscode.window.showInputBox({ prompt: `Enter instruction for ${mode}` });
      if (!instruction) return;
      
      if (currentAbortController) {
        const res = await vscode.window.showWarningMessage("A session is already running.", "Cancel Current", "Ignore");
        if (res === "Cancel Current") {
          currentAbortController.abort();
        } else {
          return;
        }
      }
      
      currentAbortController = new AbortController();
      const signal = currentAbortController.signal;
      
      if (_testSeam.bridgeFactory) {
        activeBridge = _testSeam.bridgeFactory({ host: host!, workspaceRoot: resolvedRoot });
      } else {
        activeBridge = new AgentSessionBridge({
          host: host!,
          workspaceRoot: resolvedRoot
        });
      }
      
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Agent (${mode}) running...`,
        cancellable: true
      }, async (progress, token) => {
        token.onCancellationRequested(() => {
          if (currentAbortController) currentAbortController.abort();
        });
        
        try {
          await activeBridge!.runTask(instruction, mode, signal);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Agent Error: ${e.message}`);
        } finally {
          currentAbortController = null;
          activeBridge = null;
        }
      });
    });
  };

  context.subscriptions.push(
    registerAgentCommand('open-vs-code.ask', 'ASK'),
    registerAgentCommand('open-vs-code.plan', 'PLAN'),
    registerAgentCommand('open-vs-code.build', 'BUILD'),
    registerAgentCommand('open-vs-code.debug', 'DEBUG'),
    registerAgentCommand('open-vs-code.review', 'REVIEW'),
    { dispose: () => host?.dispose() }
  );
}

export function deactivate() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  if (host) {
    host.dispose();
  }
  activeBridge = null;
}
