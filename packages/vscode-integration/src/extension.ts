import * as vscode from 'vscode';
import { AgentSessionBridge, IdeHost, IdeContextSnapshot, WorkspaceRoot, EditorDocument, EditorSelection, EditorDiagnostic, EditorPosition, resolveWorkspaceRoot } from '@open-vs-code/ide-adapter';
import { HaloProvider, capabilityForAgentMode, probeHalo, createProductionAutocompleteGateway, SkillRegistry, openWorkspaceLearning, loadRoutingConfigSync, describeConfiguredRoute, type AutocompleteGateway, type RoutingConfiguration, BrowserSessionManager, detectBrowserProvisioning } from '@open-vs-code/agent-core';
import { buildStarterRoutingConfig, fetchLocalModelCatalog, localProviderBaseUrl } from './local-model-selection.js';
import { shouldShowModelConfiguration } from './model-config-open.js';
import { connectionFromSnapshot } from './model-routing.js';
import { ModelRoutingHost } from './model-routing-host.js';
import * as path from 'node:path';
import { VsCodeSecretProvider, McpService, registerMcpCommands } from './mcp/index.js';
import { DesktopAccountManager, registerAccountCommands } from './account/index.js';
import { IntegrationManagerController } from './integrations/index.js';
import { ModeService } from './modes/index.js';

let mcpService: McpService | null = null;
let accountManager: DesktopAccountManager | null = null;
let modeService: ModeService | null = null;
let integrationManager: IntegrationManagerController | null = null;


class VSCodeIdeHost implements IdeHost {
  public outputChannel: vscode.OutputChannel;
  
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
    return vscode.workspace.isTrusted === true;
  }

  async showOutput(message: string): Promise<void> {
    this.outputChannel.appendLine(message);
  }

  revealOutput(): void {
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

  async searchWorkspaceFiles(query: string): Promise<Array<{ path: string; label: string; unavailable?: boolean; reason?: string }>> {
    const q = String(query || '').replace(/[*?{}[\]\\]/g, '').trim().slice(0, 80);
    if (!q) return [];
    const trusted = vscode.workspace.isTrusted !== false;
    const uris = await vscode.workspace.findFiles('**/*' + q + '*', '{**/node_modules/**,**/.git/**,**/dist/**,**/.cache/**,**/build/**,**/.next/**}', 20);
    return uris.map((uri) => {
      const rel = vscode.workspace.asRelativePath(uri);
      return trusted
        ? { path: rel, label: rel }
        : { path: rel, label: rel, unavailable: true, reason: 'Workspace is untrusted' };
    });
  }

  async pickWorkspaceFile(): Promise<string | undefined> {
    const hits = await this.listWorkspaceFiles();
    const picked = await vscode.window.showQuickPick(
      hits.map((hit) => ({ label: hit.label, description: hit.path, path: hit.path })),
      { title: 'Attach workspace file', matchOnDescription: true }
    );
    return (picked as { path?: string } | undefined)?.path;
  }

  private async listWorkspaceFiles(): Promise<Array<{ path: string; label: string }>> {
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/.cache/**,**/build/**}', 40);
    return uris.map((uri) => {
      const rel = vscode.workspace.asRelativePath(uri);
      return { path: rel, label: rel };
    });
  }

  async openWorkspaceFile(relativePath: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    const uri = vscode.Uri.joinPath(folders[0].uri, relativePath);
    const root = folders[0].uri.fsPath.replace(/\\/g, '/');
    const opened = uri.fsPath.replace(/\\/g, '/');
    if (opened !== root && !opened.startsWith(root + '/')) {
      await this.showError('File is outside the workspace.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }

  async getConnectionSnapshot(): Promise<{
    inferenceBackend: string;
    modelLabel?: string;
    providerLabel?: string;
    configStatus: 'present' | 'missing' | 'invalid';
    installedModels?: string[];
    selectedModel?: string;
    endpoint?: string;
    endpointVerified?: boolean;
    lastError?: 'disconnected' | 'model-unavailable';
    routingSource?: 'workspace-override' | 'global' | 'discovered' | 'none';
    workspaceOverrideActive?: boolean;
    autocompleteModel?: string;
    workspaceTrusted?: boolean;
  }> {
    const settings = haloSettings();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let configStatus: 'present' | 'missing' | 'invalid' = 'missing';
    let modelLabel: string | undefined;
    let providerLabel: string | undefined;
    let selectedModel: string | undefined;
    let endpoint: string | undefined;
    let installedModels: string[] | undefined;
    let endpointVerified = false;
    let lastError: 'disconnected' | 'model-unavailable' | undefined;
    const routed = settings.backend !== 'halo' ? modelRouting?.snapshot() : undefined;
    if (modelRouting && settings.backend !== 'halo') {
      if (routed) {
        const fields = connectionFromSnapshot(routed);
        configStatus = fields.configStatus;
        modelLabel = fields.modelLabel;
        selectedModel = fields.selectedModel;
        providerLabel = 'local-inference';
        endpoint = fields.endpoint;
        installedModels = [...fields.installedModels];
        endpointVerified = fields.endpointVerified;
        lastError = fields.lastError;
      }
    } else if (root && vscode.workspace.isTrusted === true) {
      try {
        const config = loadRoutingConfigSync(root);
        if (config) {
          configStatus = 'present';
          const mode = chatController?.getActiveExecutionMode()?.mode ?? 'ASK';
          const identity = await describeConfiguredRoute(config, mode);
          if (identity) {
            modelLabel = identity.servedModelName || identity.modelLabel;
            selectedModel = identity.servedModelName;
            providerLabel = identity.providerId;
          }
          if (settings.backend !== 'halo') {
            const baseUrl = localProviderBaseUrl(config);
            if (baseUrl) {
              endpoint = baseUrl;
              const catalog = await fetchLocalModelCatalog(baseUrl);
              if (catalog.error) {
                lastError = 'disconnected';
              } else {
                installedModels = catalog.models.map((model) => model.name);
                endpointVerified = true;
                if (selectedModel && !installedModels.includes(selectedModel)) lastError = 'model-unavailable';
              }
            }
          }
        }
      } catch {
        configStatus = 'invalid';
      }
    }
    return {
      inferenceBackend: settings.backend,
      modelLabel,
      providerLabel: settings.backend === 'halo' ? 'HALO' : (providerLabel || 'Standalone local'),
      configStatus,
      ...(installedModels ? { installedModels } : {}),
      ...(selectedModel ? { selectedModel } : {}),
      ...(endpoint ? { endpoint } : {}),
      endpointVerified,
      lastError,
      ...(routed ? {
        routingSource: routed.source,
        workspaceOverrideActive: routed.workspaceOverrideActive,
        ...(routed.autocompleteModel ? { autocompleteModel: routed.autocompleteModel } : {}),
        workspaceTrusted: routed.workspaceTrusted,
      } : {}),
    };
  }

  async checkConnection(): Promise<void> {
    const settings = haloSettings();
    if (settings.backend !== 'halo') {
      const refreshed = await modelRouting?.refresh();
      if (refreshed) installAutocompleteGateway(refreshed.config);
      const snapshot = await this.getConnectionSnapshot();
      const probed = modelRouting?.snapshot();
      const line = probed?.endpointError
        ? `Ollama is offline at ${probed.endpoint}. ${probed.endpointError}`
        : probed?.endpointReachable
          ? `Connected to ${probed.endpoint}. ${probed.installedModels.length} local model${probed.installedModels.length === 1 ? '' : 's'} available.`
          : (probed?.notice || 'Local inference has no model route.');
      await this.showOutput(line);
      this.revealOutput();
      if (chatController) {
        if (probed) chatController.publishModelManager(probed);
        else chatController.setConnectionInput({ ...snapshot, haloHealthChecked: false, haloReachable: false });
      }
      return;
    }
    try {
      const reachable = await probeHalo(settings.coreUrl);
      await this.showOutput(reachable ? 'HALO reachable.' : 'HALO Core is unavailable.');
      this.revealOutput();
      if (chatController) {
        const snapshot = await this.getConnectionSnapshot();
        chatController.setConnectionInput({
          ...snapshot,
          haloHealthChecked: true,
          haloReachable: reachable,
          lastError: reachable ? undefined : 'unavailable',
        });
      }
    } catch {
      await this.showOutput('HALO Core is unreachable.');
      this.revealOutput();
      if (chatController) {
        chatController.setConnectionInput({
          inferenceBackend: 'halo',
          providerLabel: 'HALO',
          haloHealthChecked: true,
          haloReachable: false,
          lastError: 'disconnected',
        });
      }
    }
  }

  async openModelConfig(): Promise<void> {
    await vscode.commands.executeCommand('open-vs-code.openModelConfig');
  }

  async ensureModelRoute(): Promise<void> {
    if (haloSettings().backend === 'halo') return;
    if (modelRouting?.config) return;
    await this.refreshGlobalModels();
  }

  async refreshGlobalModels(): Promise<void> {
    const refreshed = await modelRouting?.refresh();
    if (refreshed && !_testSeam.autocompleteGatewayFactory) installAutocompleteGateway(refreshed.config);
    chatController?.publishModelManager(refreshed?.snapshot);
  }

  async setGlobalChatModel(name: string): Promise<string | undefined> {
    const error = await modelRouting?.setChatModel(name);
    await this.refreshGlobalModels();
    return error;
  }

  async setGlobalAutocompleteModel(name: string): Promise<string | undefined> {
    const error = await modelRouting?.setAutocompleteModel(name);
    await this.refreshGlobalModels();
    return error;
  }

  async setGlobalEndpoint(endpoint: string): Promise<string | undefined> {
    const error = await modelRouting?.setEndpoint(endpoint);
    await this.refreshGlobalModels();
    return error;
  }

  async setGlobalAdvancedRouting(text: string): Promise<string | undefined> {
    const error = await modelRouting?.setAdvanced(text);
    await this.refreshGlobalModels();
    return error;
  }

  async clearGlobalAdvancedRouting(): Promise<void> {
    await modelRouting?.clearAdvanced();
    await this.refreshGlobalModels();
  }

  async suspendWorkspaceModelOverride(): Promise<void> {
    await modelRouting?.suspendOverride();
    await this.refreshGlobalModels();
  }

  async useWorkspaceModelOverride(): Promise<string | undefined> {
    const error = await modelRouting?.useWorkspaceOverride();
    await this.refreshGlobalModels();
    return error;
  }

  async setGlobalModelCredential(token: string): Promise<void> {
    await modelRouting?.setCredential(token);
    await this.refreshGlobalModels();
  }
  
  dispose() {
    this.outputChannel.dispose();
  }
}

import { ChatController } from './chat-controller.js';
import { ChatViewProvider } from './chat-view-provider.js';
import { ConversationStore, computeWorkspaceId } from './conversation-store.js';
import { DiffReviewController } from './diff-review-controller.js';
import { TerminalReviewController } from './terminal-review-controller.js';
import { AutocompleteController } from './autocomplete-controller.js';
import {
  BrowserPanelController,
  VscodeBrowserWebviewPanel,
} from './browser/index.js';
export {
  renderChatMessage,
  renderTerminalOutput,
  renderConfirmationSummary,
  parseMessageSegments,
  syncTranscript,
  renderActivityTimeline,
  renderContextChips,
  renderConnectionStatus,
} from './webview-render-helpers.js';
export * from './browser/index.js';

let activeBridge: AgentSessionBridge | null = null;
let currentAbortController: AbortController | null = null;
let host: VSCodeIdeHost | null = null;
let chatController: ChatController | null = null;
let diffReviewController: DiffReviewController | null = null;
let terminalReviewController: TerminalReviewController | null = null;
let autocompleteController: AutocompleteController | null = null;
let modelRouting: ModelRoutingHost | null = null;
let browserPanelController: BrowserPanelController | null = null;
interface ScopedBrowserSession {
  readonly manager: BrowserSessionManager;
  readonly accountId: string;
  readonly workspaceRoot: string;
  readonly configKey: string;
}

let activeScopedBrowserSession: ScopedBrowserSession | null = null;
let extensionGlobalBrowserStorageDir: string | undefined;

function getGovernedBrowserSessionManager(workspaceRoot: string, accountId?: string): BrowserSessionManager | undefined {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return undefined;
  }

  // Enforce workspace trust: untrusted workspaces cannot use browser automation
  if (vscode.workspace.isTrusted === false) {
    if (activeScopedBrowserSession) {
      void activeScopedBrowserSession.manager.invalidate("untrusted_workspace");
      activeScopedBrowserSession = null;
    }
    browserPanelController?.invalidateObservation("Browser execution disabled: workspace is untrusted.");
    return undefined;
  }

  const diag = detectBrowserProvisioning();
  if (diag.status !== "READY") {
    return undefined;
  }

  const normalizedWorkspace = path.resolve(workspaceRoot);
  const effectiveAccountId = accountId || accountManager?.getState().user?.id || "anonymous";
  const resourceUri = vscode.Uri?.file ? vscode.Uri.file(normalizedWorkspace) : undefined;
  const config = (vscode.workspace.getConfiguration as any)('open-vs-code', resourceUri);
  const rawOrigins =
    config.get('browser.allowedOrigins') ??
    (vscode.workspace.getConfiguration as any)('open-vs-code.browser', resourceUri)?.get('allowedOrigins') ??
    [];
  const allowedOrigins = Array.isArray(rawOrigins) ? [...rawOrigins] : [];
  const headless = Boolean(config.get('browser.headless', true));
  const configKey = JSON.stringify({ allowedOrigins, headless });

  // Sprint 9A.2 P1: Invalidate and dispose if workspace, account, or configuration boundary changed
  if (
    activeScopedBrowserSession &&
    (activeScopedBrowserSession.workspaceRoot !== normalizedWorkspace ||
      activeScopedBrowserSession.accountId !== effectiveAccountId ||
      activeScopedBrowserSession.configKey !== configKey)
  ) {
    const reason =
      activeScopedBrowserSession.workspaceRoot !== normalizedWorkspace
        ? "workspace_change"
        : activeScopedBrowserSession.accountId !== effectiveAccountId
        ? "account_switch"
        : "browser_configuration_changed";
    void activeScopedBrowserSession.manager.invalidate(reason);
    activeScopedBrowserSession = null;
    browserPanelController?.invalidateObservation(`Browser session reset (${reason}).`);
  }

  if (!activeScopedBrowserSession) {
    const safeStorageDir =
      extensionGlobalBrowserStorageDir &&
      extensionGlobalBrowserStorageDir !== normalizedWorkspace &&
      !extensionGlobalBrowserStorageDir.startsWith(normalizedWorkspace + path.sep)
        ? extensionGlobalBrowserStorageDir
        : undefined;

    const manager = new BrowserSessionManager({
      workspaceRoot: normalizedWorkspace,
      accountId: effectiveAccountId,
      ...(safeStorageDir ? { storageDir: safeStorageDir } : {}),
      headless,
      networkPolicy: {
        allowedOrigins,
      },
    });
    activeScopedBrowserSession = {
      manager,
      accountId: effectiveAccountId,
      workspaceRoot: normalizedWorkspace,
      configKey,
    };
  }
  browserPanelController?.attachSession(activeScopedBrowserSession.manager);
  return activeScopedBrowserSession.manager;
}

/**
 * Sprint 7D: runs at most one refresh at a time. Calls that arrive while one is
 * running are folded into a single trailing refresh, so a burst of editor events
 * costs two snapshots instead of one per event, and the last state always wins.
 */
export function coalesceRefresh(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await run();
      } while (again);
    })().finally(() => { running = undefined; });
    return running;
  };
}

export const _testSeam = {
  get activeBridge() { return activeBridge; },
  bridgeFactory: null as any,
  get chatController() { return chatController; },
  get integrationManager() { return integrationManager; },
  get terminalReviewController() { return terminalReviewController; },
  get autocompleteController() { return autocompleteController; },
  get diffReviewController() { return diffReviewController; },
  get browserPanelController() { return browserPanelController; },
  get activeBrowserSessionManager() { return activeScopedBrowserSession?.manager ?? null; },
  get activeScopedBrowserSession() { return activeScopedBrowserSession; },
  setActiveBrowserSessionManager(m: BrowserSessionManager | null) {
    if (!m) {
      if (activeScopedBrowserSession) {
        void activeScopedBrowserSession.manager.invalidate("manual_reset");
        activeScopedBrowserSession = null;
      }
      browserPanelController?.invalidateObservation("Session reset.");
    } else {
      activeScopedBrowserSession = {
        manager: m,
        accountId: m.getAccountId?.() || "anonymous",
        workspaceRoot: m.getWorkspaceRoot?.() || "/",
        configKey: "{}",
      };
      browserPanelController?.attachSession(m);
    }
  },
  getGovernedBrowserSessionManager,
  get currentAbortController() { return currentAbortController; },
  setCurrentAbortController(ac: AbortController | null) { currentAbortController = ac; },
  /** For tests only: inject a ChatController so deactivate() exercises the real path. */
  setChatController(c: ChatController | null) { chatController = c; },
  /** For tests only: inject a TerminalReviewController so deactivate() clears it. */
  setTerminalReviewController(c: TerminalReviewController | null) { terminalReviewController = c; },
  /** For tests only: inject an AutocompleteController so deactivate() exercises the real path. */
  setAutocompleteController(c: AutocompleteController | null) { autocompleteController = c; },
  /** For tests only: inject a DiffReviewController so deactivate() clears it. */
  setDiffReviewController(c: DiffReviewController | null) { diffReviewController = c; },
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

/** Portable Skills Runtime (ADR-029). Built-in skills ship inside the extension's dist folder. */
function skillsSettings(context: vscode.ExtensionContext): { enabled: boolean; builtinRoot?: string } {
  const enabled = vscode.workspace.getConfiguration('open-vs-code').get<boolean>('skills.enabled', false) === true;
  return context.extensionPath
    ? { enabled, builtinRoot: path.join(context.extensionPath, 'dist', 'skills', 'builtins') }
    : { enabled };
}

function learningEnabled(): boolean {
  return vscode.workspace.getConfiguration('open-vs-code').get<boolean>('learning.enabled', false) === true;
}

/**
 * The explicit human review gate for learning (ADR-032): pick a candidate, read what was learned,
 * why, from which tasks, and what approval would change, then choose Approve or Reject. Dismissing
 * the dialog changes nothing; approval is never inferred.
 */
async function reviewLearningCandidates(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showInformationMessage('Open a workspace folder to review learning candidates.');
    return;
  }
  if (!learningEnabled()) {
    vscode.window.showInformationMessage('Learning is disabled (open-vs-code.learning.enabled).');
    return;
  }
  const settings = skillsSettings(context);
  const builtins = await SkillRegistry.discover({ ...(settings.builtinRoot ? { builtinRoot: settings.builtinRoot } : {}), workspaceTrusted: false });
  const service = await openWorkspaceLearning({ workspaceRoot, enabled: true, workspaceTrusted: vscode.workspace.isTrusted === true, builtinSkillIds: builtins.entries.map((entry) => entry.id) });
  const { records, candidates } = service.list();
  const items = [
    ...candidates.filter((candidate) => candidate.status === 'READY_FOR_REVIEW').map((candidate) => ({
      id: candidate.id,
      label: `Skill: ${candidate.proposedSkillId}${candidate.updateOf ? ` (update to v${candidate.updateOf.fromVersion + 1})` : ''}`,
      description: `${candidate.supportingTaskIds.length} supporting task(s)`,
      detail: candidate.description,
    })),
    ...records.filter((record) => record.status === 'CANDIDATE').map((record) => ({
      id: record.id,
      label: `Memory: ${record.title}`,
      description: `${record.kind} · ${record.successfulOccurrences} success, ${record.failedOccurrences} failure`,
      detail: record.summary,
    })),
  ];
  if (items.length === 0) {
    vscode.window.showInformationMessage('No learning candidates await review.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Learning candidates awaiting review', canPickMany: false });
  if (!picked) return;
  const explanation = service.explain(picked.id);
  if (!explanation) return;
  const detail = [
    `What was learned: ${explanation.what}`,
    `Why: ${explanation.why}`,
    `From tasks: ${explanation.fromTasks.join(', ') || '-'}`,
    `Successes: ${explanation.successes} · Failures: ${explanation.failures}`,
    `If approved: ${explanation.ifApproved}`,
  ].join('\n');
  const choice = await vscode.window.showInformationMessage(picked.label, { modal: true, detail }, 'Approve', 'Reject');
  if (choice === 'Approve') {
    const result = await service.approve(picked.id);
    vscode.window.showInformationMessage(result.ok ? (result.kind === 'SKILL' ? `Learned skill written: ${result.path} (v${result.version})` : 'Memory approved.') : `Not approved: ${result.reason}`);
  } else if (choice === 'Reject') {
    await service.reject(picked.id, 'rejected in review');
    vscode.window.showInformationMessage('Rejected. It stays suppressed until materially new evidence appears.');
  }
}

function haloToken(context: vscode.ExtensionContext): () => Promise<string | undefined> {
  return async () => await context.secrets.get(HALO_TOKEN_SECRET_KEY) ?? process.env.HALO_APP_TOKEN_OPEN_VSCODE;
}

export function activate(context: vscode.ExtensionContext) {
  modelRouting = new ModelRoutingHost(context);
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
      : createProductionAutocompleteGateway(emptyRouting());
    autocompleteController = new AutocompleteController({ gateway });
  }
  autocompleteController.register(context);

  chatController = new ChatController(host, diffReviewController, terminalReviewController, (options: { host: any, workspaceRoot: string, mode: 'ASK' | 'PLAN' | 'BUILD' | 'DEBUG' | 'REVIEW', mcpCatalog?: any }) => {

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
      const browserManager = getGovernedBrowserSessionManager(options.workspaceRoot);
      const acctState = accountManager?.getState();
      const isAuthenticated = Boolean(acctState?.user && acctState.status !== "UNAUTHENTICATED");
      const effectiveAccountScope = (options as any).accountScope || (isAuthenticated && acctState?.user?.id ? acctState.user.id : undefined);

      const routed = providerOverride ? null : modelRouting?.config;
      activeBridge = new AgentSessionBridge({
        ...options,
        ...(effectiveAccountScope ? { accountScope: effectiveAccountScope } : {}),
        ...(providerOverride ? { providerOverride } : {}),
        ...(!providerOverride ? { skipWorkspaceRoutingFile: true } : {}),
        ...(routed ? { routingConfigOverride: routed } : {}),
        mcpCatalog: options.mcpCatalog,
        ...(browserManager ? { browserSessionManager: browserManager } : {}),
        skills: skillsSettings(context),
        // Structured Engineering Loop (ADR-030); off by default.
        workflow: { enabled: vscode.workspace.getConfiguration('open-vs-code').get<boolean>('workflow.enabled', false) === true },
        progressMonitor: { enabled: vscode.workspace.getConfiguration('open-vs-code').get<boolean>('progressMonitor.enabled', false) === true },
        // Bounded memory-to-skill learning (ADR-032); off by default.
        learning: { enabled: learningEnabled() },
      });
    }
    return activeBridge!;
  });

  const provider = new ChatViewProvider(context.extensionUri, chatController);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  void modelRouting.refresh().then((refreshed) => {
    if (!_testSeam.autocompleteGatewayFactory) installAutocompleteGateway(refreshed.config);
    chatController?.publishModelManager(refreshed.snapshot);
    return chatController?.refreshConnection();
  });
  // Layout restore runs after activation. Opening earlier is overwritten, so wait once.
  const revealTimer = setTimeout(() => { void revealAgentPanelOnce(context); }, 1200);
  context.subscriptions.push({ dispose: () => clearTimeout(revealTimer) });
  const refreshRouting = () => {
    void modelRouting?.refresh().then((refreshed) => {
      if (!_testSeam.autocompleteGatewayFactory) installAutocompleteGateway(refreshed.config);
      chatController?.publishModelManager(refreshed.snapshot);
      return chatController?.refreshConnection();
    });
  };
  if (vscode.workspace.onDidChangeWorkspaceFolders) {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refreshRouting));
  }
  if (vscode.workspace.onDidGrantWorkspaceTrust) {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(refreshRouting));
  }

  // Sprint 7C: visible conversation history lives in VS Code's per-workspace storage
  // (outside the repository), never in .open-vs-code/sessions.jsonl.
  const historyRoot = context.storageUri?.fsPath;
  if (historyRoot && workspaceRoot) {
    void chatController.attachConversationStore(new ConversationStore({
      storageRoot: historyRoot,
      workspaceId: computeWorkspaceId(workspaceRoot),
    }));
  } else {
    chatController.setHistoryUnavailable('Conversations are not saved because no folder is open.');
  }
  
  // Editor events arrive in storms (typing, cursor moves, diagnostics); see coalesceRefresh.
  const updateContext = coalesceRefresh(async () => {
    if (chatController && host) {
      try {
        chatController.refreshContext(await host.getSnapshot());
      } catch {
        // Safe context refresh ignore
      }
    }
  });
  
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
    vscode.commands.registerCommand('open-vs-code.showConversationHistory', async () => {
      await showConversationHistory();
    }),
    vscode.commands.registerCommand('open-vs-code.showAgentOutput', async () => {
      host?.revealOutput();
    }),
    vscode.commands.registerCommand('open-vs-code.newConversation', async () => {
      await chatController?.handleWebviewMessage({ type: 'chat.newConversation' });
      await vscode.commands.executeCommand('open-vs-code.chat.focus');
    }),
    vscode.commands.registerCommand('open-vs-code.setHaloToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'HALO application token for Open VS Code',
        password: true,
        ignoreFocusOut: true,
      });
      if (!token?.trim()) return;
      await context.secrets.store(HALO_TOKEN_SECRET_KEY, token.trim());
      await host?.showOutput('HALO application token saved to VS Code SecretStorage.');
      host?.revealOutput();
    }),
    vscode.commands.registerCommand('open-vs-code.checkHaloConnection', async () => {
      const settings = haloSettings();
      if (settings.backend !== 'halo') {
        await host?.showOutput('HALO is not selected. Select the HALO inference backend to use it.');
        host?.revealOutput();
        return;
      }
      try {
        const reachable = await probeHalo(settings.coreUrl);
        await host?.showOutput(reachable ? 'HALO reachable.' : 'HALO Core is unavailable.');
      } catch {
        await host?.showOutput('HALO Core is unreachable.');
      }
      host?.revealOutput();
    }),
    vscode.commands.registerCommand('open-vs-code.createStarterConfig', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('Open a workspace folder before creating model configuration.');
        return;
      }
      if (vscode.workspace.isTrusted !== true) {
        vscode.window.showErrorMessage('This folder is not trusted. The workspace model file was not written. Trust was not granted automatically.');
        return;
      }
      const dirPath = vscode.Uri.file(`${root}/.open-vs-code`);
      const filePath = vscode.Uri.file(`${root}/.open-vs-code/models.json`);
      try {
        try {
          await vscode.workspace.fs.stat(filePath);
          vscode.window.showInformationMessage('Model configuration already exists and was left unchanged.');
          return;
        } catch {
          // The starter is only written when the workspace has no routing file.
        }
        await vscode.workspace.fs.createDirectory(dirPath);
        const catalog = await fetchLocalModelCatalog('http://127.0.0.1:11434', 2000);
        const body = !catalog.error && catalog.models.length > 0
          ? JSON.stringify(buildStarterRoutingConfig(catalog.models.map((model) => model.name)), null, 2) + '\n'
          : STARTER_MODELS_JSON;
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(filePath, encoder.encode(body));
        if (shouldShowModelConfiguration('starter-created')) {
          const doc = await vscode.workspace.openTextDocument(filePath);
          await vscode.window.showTextDocument(doc);
        }
        await modelRouting?.refresh();
        await chatController?.refreshConnection();
        vscode.window.showInformationMessage('Created .open-vs-code/models.json and left it closed. Models in the agent panel does not require this file.');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create starter config: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand('open-vs-code.listSkills', async () => {
      const settings = skillsSettings(context);
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      // Metadata only: listing never reads a skill body.
      const registry = await SkillRegistry.discover({
        ...(settings.builtinRoot ? { builtinRoot: settings.builtinRoot } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        workspaceTrusted: vscode.workspace.isTrusted === true,
      });
      for (const diagnostic of registry.diagnostics) {
        await host?.showOutput(`Skill diagnostic [${diagnostic.source}/${diagnostic.skill}] ${diagnostic.code}: ${diagnostic.message}`);
      }
      const status = settings.enabled ? 'enabled' : 'disabled (open-vs-code.skills.enabled)';
      if (registry.entries.length === 0) {
        vscode.window.showInformationMessage(`No skills available. Skills are ${status}.`);
        return;
      }
      await vscode.window.showQuickPick(
        registry.entries.map((entry) => ({
          label: entry.id,
          description: `v${entry.version} · ${entry.source} · ${entry.allowedModes.join('/')}`,
          detail: entry.description,
        })),
        { title: `Available skills (${status})`, canPickMany: false },
      );
    }),
    vscode.commands.registerCommand('open-vs-code.reviewLearningCandidates', async () => {
      await reviewLearningCandidates(context);
    }),
    vscode.commands.registerCommand('open-vs-code.showActiveSkill', async () => {
      const evidence = activeBridge?.skillEvidence;
      if (!evidence || !evidence.enabled) {
        vscode.window.showInformationMessage('No active skill. The skills runtime is disabled or no task has run yet.');
        return;
      }
      if (!evidence.selectedSkill) {
        vscode.window.showInformationMessage(`No skill selected for the last task (${evidence.skillLoadStatus}).`);
        return;
      }
      vscode.window.showInformationMessage(
        `Skill: ${evidence.selectedSkill} v${evidence.skillVersion} (${evidence.skillSource}) · ${evidence.skillLoadStatus} · ${evidence.injectionStatus} · ${evidence.injectedSkillTokens} tokens injected`,
      );
    }),
    vscode.commands.registerCommand('open-vs-code.selectLocalModel', async () => {
      if (chatController?.getState().activeTurn) {
        vscode.window.showWarningMessage('A task is running. Choose a model before the next request. The running task keeps its current model.');
        return;
      }
      const refreshed = await modelRouting?.refresh();
      const probed = refreshed?.snapshot;
      const baseUrl = probed?.endpoint || 'http://127.0.0.1:11434';
      if (!probed || probed.endpointError) {
        vscode.window.showErrorMessage(`Cannot list local models at ${baseUrl}. ${probed?.endpointError || 'The local endpoint is unreachable.'}`);
        return;
      }
      const models = probed.installedModels;
      if (models.length === 0) {
        vscode.window.showWarningMessage(`Connected to ${baseUrl}, but no models are installed.`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(plug) Test connection', description: baseUrl, id: '__test__' },
          ...models.map((model) => ({ label: model, description: 'Use for chat and coding', id: model })),
        ],
        { title: 'Local model', placeHolder: 'Saved for every folder. Autocomplete keeps its own model. Project files are not edited.' },
      );
      if (!picked) return;
      if (picked.id === '__test__') {
        vscode.window.showInformationMessage(`Connected to ${baseUrl}. ${models.length} local model${models.length === 1 ? '' : 's'} available.`);
        return;
      }
      await persistSelectedLocalModel(picked.id, false);
    }),
    vscode.commands.registerCommand('open-vs-code.openWideChat', async () => {
      await openWideChat(provider);
    }),
    vscode.commands.registerCommand('open-vs-code.applyLocalModel', async (name?: string) => {
      if (typeof name !== 'string' || !name.trim()) return;
      await persistSelectedLocalModel(name.trim(), true);
    }),
    vscode.commands.registerCommand('open-vs-code.openModelConfig', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      const filePath = vscode.Uri.file(`${root}/.open-vs-code/models.json`);
      try {
        if (!shouldShowModelConfiguration('explicit-command')) return;
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      } catch {
        const choice = await vscode.window.showInformationMessage(
          'No models.json found. Would you like to create a starter configuration?',
          'Create Starter Config',
          'Cancel'
        );
        if (choice === 'Create Starter Config') {
          await vscode.commands.executeCommand('open-vs-code.createStarterConfig');
        }
      }
    }),
    vscode.commands.registerCommand('open-vs-code.enableWorkflow', async () => {
      const config = vscode.workspace.getConfiguration('open-vs-code');
      await config.update('workflow.enabled', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Open VS Code: Structured Engineering Workflow has been enabled.');
    }),
    { dispose: () => host?.dispose() }
  );

  // Initialize and register MCP 2.0 integrations and management commands
  const secretProvider = new VsCodeSecretProvider(context.secrets);
  mcpService = new McpService(workspaceRoot, secretProvider, host.outputChannel);
  context.subscriptions.push(...registerMcpCommands(context, mcpService, host.outputChannel));

  // Initialize Mode Service (Sprint 8D)
  modeService = new ModeService({ workspaceRoot });

  // Initialize and register Visual Integration Manager (Sprint 8C/8D/8E)
  accountManager = new DesktopAccountManager(context, host.outputChannel);
  integrationManager = new IntegrationManagerController(context, accountManager, mcpService, host.outputChannel, modeService);
  const packService = integrationManager.getCapabilityPackService();

  // Initialize and register Account Management (Sprint 8B / 8E.1)
  context.subscriptions.push(...registerAccountCommands(context, accountManager, mcpService, host.outputChannel, modeService, packService));
  void accountManager.initialize(mcpService, modeService, packService);

  // Dedicated outside-repository storage path for ephemeral browser profiles when globalStorageUri exists
  extensionGlobalBrowserStorageDir = (context as any).globalStorageUri?.fsPath
    ? path.join((context as any).globalStorageUri.fsPath, 'browser-profiles')
    : undefined;

  const browserArtifactRootDir = (context as any).globalStorageUri?.fsPath
    ? path.join((context as any).globalStorageUri.fsPath, 'browser-artifacts')
    : undefined;

  browserPanelController = new BrowserPanelController({
    ...(browserArtifactRootDir ? { artifactRootPath: browserArtifactRootDir } : {}),
    getEnvironment: () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const wsRoot = folder?.uri.fsPath;
      const wsName = folder?.name || (wsRoot ? path.basename(wsRoot) : 'No Workspace');
      const wsTrusted = vscode.workspace.isTrusted !== false;
      const modeInfo = chatController?.getActiveExecutionMode() ?? { mode: 'ASK', label: 'ASK' };
      const resourceUri = wsRoot && vscode.Uri?.file ? vscode.Uri.file(wsRoot) : undefined;
      const cfg = (vscode.workspace.getConfiguration as any)('open-vs-code', resourceUri);
      const rawEnvOrigins =
        cfg?.get?.('browser.allowedOrigins') ??
        (vscode.workspace.getConfiguration as any)('open-vs-code.browser', resourceUri)?.get('allowedOrigins') ??
        [];
      const allowedOrigins = Array.isArray(rawEnvOrigins) ? [...rawEnvOrigins] : [];
      const acctState = accountManager?.getState();
      const userId = acctState?.user?.id || 'anonymous';
      const isAuthenticated = Boolean(acctState?.user && acctState.status !== 'UNAUTHENTICATED');
      const displayLabel = isAuthenticated && acctState?.user
        ? `${acctState.user.username || userId}`
        : 'Local anonymous';
      return {
        workspaceRoot: wsRoot,
        workspaceName: wsName,
        workspaceTrusted: wsTrusted,
        activeMode: modeInfo.mode,
        activeModeLabel: modeInfo.label,
        allowedOrigins,
        identity: {
          accountId: userId,
          displayLabel,
          authenticated: isAuthenticated,
        },
      };
    },
    acquireSessionManager: () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!wsRoot) return undefined;
      return getGovernedBrowserSessionManager(wsRoot);
    },
    confirmationBridge: {
      requestConfirmation: async (prompt, payload) => {
        if (
          chatController &&
          chatController.getState().activeTurn &&
          !chatController.getState().pendingConfirmation
        ) {
          return chatController.requestConfirmation(prompt, payload);
        }
        const choice = await vscode.window.showWarningMessage(
          prompt,
          { modal: true },
          'Approve',
          'Reject'
        );
        return choice === 'Approve' ? 'APPROVE' : 'REJECT';
      },
      confirmSessionClose: async (summary) => {
        try {
          const choice = await vscode.window.showWarningMessage(
            summary,
            { modal: true },
            'Close Session',
            'Cancel'
          );
          return choice === 'Close Session';
        } catch {
          try {
            const choice = await vscode.window.showWarningMessage(
              summary,
              'Close Session',
              'Cancel'
            );
            return choice === 'Close Session' || choice === undefined;
          } catch {
            return true;
          }
        }
      },
    },
    createViewAdapter: (callbacks) =>
      new VscodeBrowserWebviewPanel({
        vscodeApi: vscode,
        extensionUri: context.extensionUri,
        artifactRootPath: callbacks.artifactRootPath,
        onMessage: callbacks.onMessage,
        onVisibilityChanged: callbacks.onVisibilityChanged,
        onPanelClosed: callbacks.onPanelClosed,
      }),
  });

  if (activeScopedBrowserSession) {
    browserPanelController.attachSession(activeScopedBrowserSession.manager);
  }

  // Invalidate and dispose active browser session on account logout, switch, workspace change, or config change
  context.subscriptions.push(
    { dispose: () => browserPanelController?.dispose() },
    vscode.commands.registerCommand('open-vs-code.openBrowserPanel', () => {
      browserPanelController?.openOrRevealPanel();
    }),
    accountManager.onStateChange((state) => {
      // Invalidate active session bridge and in-flight tasks on account identity changes
      activeBridge = null;
      try {
        chatController?.cancelTurn?.();
      } catch {
        // Safe containment
      }

      if (activeScopedBrowserSession) {
        const currentUserId = state.user?.id || "anonymous";
        const loggedOutAuthenticated =
          activeScopedBrowserSession.accountId !== "anonymous" &&
          state.status === "UNAUTHENTICATED";
        if (loggedOutAuthenticated || currentUserId !== activeScopedBrowserSession.accountId) {
          const reason = loggedOutAuthenticated ? "account_logout" : "account_switch";
          void activeScopedBrowserSession.manager.invalidate(reason);
          activeScopedBrowserSession = null;
          browserPanelController?.invalidateObservation(
            `Session invalidated (${reason.replace('_', ' ')}).`
          );
        }
      } else {
        browserPanelController?.invalidateObservation("Account identity updated.");
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (activeScopedBrowserSession) {
        void activeScopedBrowserSession.manager.invalidate("workspace_change");
        activeScopedBrowserSession = null;
      }
      browserPanelController?.invalidateObservation("Workspace folder changed; previous browser session disposed.");
    }),
    ...(typeof (vscode.workspace as any).onDidChangeConfiguration === 'function'
      ? [
          (vscode.workspace as any).onDidChangeConfiguration((e: any) => {
            if (activeScopedBrowserSession && (!e?.affectsConfiguration || e.affectsConfiguration('open-vs-code.browser'))) {
              void activeScopedBrowserSession.manager.invalidate("browser_configuration_changed");
              activeScopedBrowserSession = null;
              browserPanelController?.invalidateObservation("Browser configuration changed; session reset.");
            }
          }),
        ]
      : [])
  );

  if (chatController) {
    chatController.attachIntegrationManager(integrationManager);
  }
  context.subscriptions.push(
    integrationManager,
    vscode.commands.registerCommand('open-vs-code.openIntegrationManager', async () => {
      vscode.commands.executeCommand('open-vs-code.chat.focus');
      await chatController?.openIntegrationsHub();
    }),
    vscode.commands.registerCommand('open-vs-code.openModesManager', async () => {
      vscode.commands.executeCommand('open-vs-code.chat.focus');
      await chatController?.openIntegrationsHub();
      integrationManager?.setActiveTab('modes');
    }),
    vscode.commands.registerCommand('open-vs-code.openPacksManager', async () => {
      vscode.commands.executeCommand('open-vs-code.chat.focus');
      await chatController?.openIntegrationsHub();
      integrationManager?.setActiveTab('packs');
    })
  );
}

export const STARTER_MODELS_JSON = JSON.stringify({
  $schema: "https://raw.githubusercontent.com/RaulMermans/Open_VS_Code/main/config/schemas/models.schema.json",
  providers: [
    {
      id: "local-inference",
      kind: "openai_compatible_local",
      baseUrl: "http://127.0.0.1:11434"
    }
  ],
  models: [
    {
      id: "qwen2.5-coder-7b",
      displayName: "Qwen 2.5 Coder 7B",
      family: "qwen",
      contextWindow: 32768,
      capabilities: ["toolUse", "coding", "autocomplete", "fim"],
      specialization: "coding",
      fimStrategy: "qwen",
      provenance: "Qwen2.5-Coder-7B-Instruct (Apache 2.0)"
    }
  ],
  deployments: [
    {
      id: "local-chat",
      providerId: "local-inference",
      modelId: "qwen2.5-coder-7b",
      modelName: "qwen2.5-coder:7b",
      enabled: true,
      priority: 10
    },
    {
      id: "local-fim",
      providerId: "local-inference",
      modelId: "qwen2.5-coder-7b",
      modelName: "qwen2.5-coder:7b",
      enabled: true,
      priority: 10,
      fimStrategy: "qwen"
    }
  ],
  routes: {
    coding: ["local-chat"],
    autocomplete: ["local-fim"],
    default: ["local-chat"]
  }
}, null, 2) + "\n";


/** Saves the chat model in extension storage. Workspace models.json is not written. */
async function persistSelectedLocalModel(name: string, quiet: boolean): Promise<void> {
  if (chatController?.getState().activeTurn) {
    vscode.window.showWarningMessage('A task is running. Choose a model before the next request. The running task keeps its current model.');
    return;
  }
  if (!modelRouting) return;
  await modelRouting.refresh();
  const error = await modelRouting.setChatModel(name);
  const refreshed = await modelRouting.refresh();
  if (!_testSeam.autocompleteGatewayFactory) installAutocompleteGateway(refreshed.config);
  chatController?.publishModelManager(refreshed.snapshot);
  await chatController?.refreshConnection();
  if (error) {
    vscode.window.showErrorMessage(error);
    return;
  }
  if (!quiet) {
    const used = refreshed.snapshot.chatModel || name;
    vscode.window.showInformationMessage(refreshed.snapshot.workspaceOverrideActive
      ? `Saved ${name} as the global chat model. The active route is still the workspace override. Choose Use global models to switch. The project file was not modified.`
      : `Chat will use ${used}.`);
  }
}

function emptyRouting(): RoutingConfiguration {
  return { providers: [], models: [], deployments: [], routes: {} };
}

function installAutocompleteGateway(config: RoutingConfiguration | null): void {
  const gateway = createProductionAutocompleteGateway(config ?? emptyRouting());
  autocompleteController?.service.replaceGateway(gateway);
}

let wideChatPanel: vscode.WebviewPanel | undefined;

function preferredWideColumn(): vscode.ViewColumn {
  const editor = vscode.window.activeTextEditor;
  const scheme = editor?.document?.uri?.scheme;
  if (scheme === 'file' || scheme === 'untitled') return vscode.ViewColumn.Beside;
  return vscode.ViewColumn.One;
}

async function openWideChat(provider: ChatViewProvider): Promise<void> {
  const column = preferredWideColumn();
  if (wideChatPanel) {
    wideChatPanel.reveal(column);
    return;
  }
  wideChatPanel = vscode.window.createWebviewPanel(
    'open-vs-code.chat.wide',
    'Open VS Code Agent',
    column,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  wideChatPanel.webview.html = provider.htmlFor(wideChatPanel.webview, { wide: true });
  const attached = chatController?.attachWebview(wideChatPanel.webview);
  wideChatPanel.onDidDispose(() => {
    attached?.dispose();
    wideChatPanel = undefined;
  });
}

/** Opens the right-hand agent once per workspace. Later launches keep the saved layout. */
async function revealAgentPanelOnce(context: vscode.ExtensionContext): Promise<void> {
  const key = 'open-vs-code.agentPanel.revealed.v2';
  const workspaceState = context?.workspaceState;
  if (!workspaceState || typeof workspaceState.get !== 'function') return;
  if (workspaceState.get(key) === true) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.open-vs-code-agent');
      if (typeof workspaceState.update === 'function') await workspaceState.update(key, true);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

/** Native, keyboard-first conversation picker over safe local metadata. */
async function showConversationHistory(): Promise<void> {
  const controller = chatController;
  if (!controller) return;
  await controller.historyReady;
  const state = controller.getState();
  const conversations = controller.listConversations();
  if (!state.history?.enabled) {
    vscode.window.showInformationMessage(state.history?.notice || 'Conversation history is not available in this window.');
    return;
  }
  if (conversations.length === 0) {
    vscode.window.showInformationMessage('No saved conversations in this workspace yet.');
    return;
  }
  const items = conversations.map((c) => ({
    label: (c.id === state.conversationId ? '$(comment-discussion) ' : '') + c.title,
    description: [c.archived ? 'archived' : '', c.lastStatus === 'interrupted' ? 'interrupted' : '', `${c.messageCount} messages`].filter(Boolean).join(' · '),
    detail: c.preview,
    id: c.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Open VS Code: Conversations in this workspace',
    placeHolder: 'Search conversations by title or first message',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  await controller.openConversation(picked.id);
  await vscode.commands.executeCommand('open-vs-code.chat.focus');
}

export async function deactivate(): Promise<void> {
  const chat = chatController;
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  const ctrl = autocompleteController;
  autocompleteController = null;
  if (chatController) {
    if (typeof (chatController as any).dispose === 'function') {
      chatController.dispose();
    } else {
      chatController.cancelTurn();
    }
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

  if (ctrl) {
    try {
      await ctrl.dispose();
    } catch {
      // Safe containment
    }
  }
  if (mcpService) {
    try {
      await mcpService.dispose();
    } catch {
      // Safe containment
    }
    mcpService = null;
  }
  if (browserPanelController) {
    try {
      browserPanelController.dispose();
    } catch {
      // Safe containment
    }
    browserPanelController = null;
  }
  if (activeScopedBrowserSession) {
    try {
      await activeScopedBrowserSession.manager.invalidate("extension_shutdown");
    } catch {
      // Safe containment
    }
    activeScopedBrowserSession = null;
  }
  extensionGlobalBrowserStorageDir = undefined;
  if (integrationManager) {
    try {
      integrationManager.dispose();
    } catch {
      // Safe containment
    }
    integrationManager = null;
  }
  accountManager = null;
  if (chat) {
    // Let queued history writes land. A task that was still running stays recorded
    // as running and is shown as interrupted on the next start.
    try { await chat.flushPersistence(); } catch { /* history is best effort at shutdown */ }
  }
}
