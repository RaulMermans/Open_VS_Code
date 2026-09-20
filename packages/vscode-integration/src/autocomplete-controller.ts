/**
 * AutocompleteController — Sprint 3E.
 *
 * VS Code integration layer for editor-native autocomplete.
 *
 * This controller:
 *   - Registers a native VS Code InlineCompletionItemProvider
 *   - Bridges VS Code editor state into EditorSnapshot values
 *   - Delegates all logic to AutocompleteService (no VS Code APIs in service)
 *   - Attaches an acceptance command to InlineCompletionItem
 *   - Provides a toggle command
 *
 * Key invariants:
 *   - Does NOT call AgentRunner
 *   - Does NOT call ChatController
 *   - Does NOT read Project Memory at runtime
 *   - Does NOT invoke tools, MCP, or mutation
 *   - User's native editor acceptance is the ONLY insertion authority
 */

import * as vscode from 'vscode';
import {
  AutocompleteService,
  type AutocompleteGateway,
  type AutocompleteScheduler,
} from '@open-vs-code/agent-core';

export const AUTOCOMPLETE_ACCEPTED_COMMAND = 'open-vs-code.autocompleteAccepted';
export const AUTOCOMPLETE_TOGGLE_COMMAND = 'open-vs-code.toggleAutocomplete';

export interface AutocompleteControllerOptions {
  readonly gateway: AutocompleteGateway;
  readonly debounceMs?: number;
  readonly timeoutMs?: number;
  readonly scheduler?: AutocompleteScheduler;
}

export class AutocompleteController implements vscode.InlineCompletionItemProvider {
  readonly service: AutocompleteService;
  readonly #disposables: vscode.Disposable[] = [];

  constructor(options: AutocompleteControllerOptions) {
    this.service = new AutocompleteService({
      gateway: options.gateway,
      debounceMs: options.debounceMs,
      timeoutMs: options.timeoutMs,
      scheduler: options.scheduler,
    });
  }

  /**
   * Register this provider and commands with VS Code.
   * Call from extension activate().
   * The returned disposables should be pushed to context.subscriptions.
   */
  register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const providerDisposable = vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      this,
    );

    const acceptedCommand = vscode.commands.registerCommand(
      AUTOCOMPLETE_ACCEPTED_COMMAND,
      (requestId: string) => {
        if (typeof requestId === 'string') {
          this.service.recordAccepted(requestId);
        }
      },
    );

    const toggleCommand = vscode.commands.registerCommand(
      AUTOCOMPLETE_TOGGLE_COMMAND,
      () => {
        this.service.enabled = !this.service.enabled;
        const state = this.service.enabled ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`Open VS Code Autocomplete ${state}`);
      },
    );

    this.#disposables.push(providerDisposable, acceptedCommand, toggleCommand);
    context.subscriptions.push(providerDisposable, acceptedCommand, toggleCommand);

    return [providerDisposable, acceptedCommand, toggleCommand];
  }

  /**
   * VS Code InlineCompletionItemProvider implementation.
   * Called by VS Code on every trigger (keystroke, explicit invoke, etc.).
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | null> {
    if (!this.service.enabled || this.service.disposed) {
      return null;
    }

    // Build EditorSnapshot from live document (unsaved buffer)
    const rawPrefix = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position),
    );
    const rawSuffix = document.getText(
      new vscode.Range(position, document.positionAt(document.getText().length)),
    );

    const snapshot = {
      rawPrefix,
      rawSuffix,
      languageId: document.languageId,
      relativePath: vscode.workspace.asRelativePath(document.uri, false),
      documentVersion: document.version,
      cursorLine: position.line,
      cursorCharacter: position.character,
    };

    // Map VS Code CancellationToken to AbortSignal
    const abortController = new AbortController();
    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      token.onCancellationRequested(() => abortController.abort());
    }

    const result = await this.service.trigger(
      snapshot,
      document.uri.toString(),
      abortController.signal,
    );

    if (!result || !result.text) {
      return null;
    }

    // Build native InlineCompletionItem
    const item = new vscode.InlineCompletionItem(
      result.text,
      // Default range: start at cursor, replaces nothing
      new vscode.Range(position, position),
    );

    // Attach acceptance command for telemetry
    item.command = {
      title: 'Autocomplete Accepted',
      command: AUTOCOMPLETE_ACCEPTED_COMMAND,
      arguments: [result.requestId],
    };

    return new vscode.InlineCompletionList([item]);
  }

  /**
   * Dispose on extension deactivation.
   */
  dispose(): void {
    this.service.dispose();
    for (const d of this.#disposables) {
      d.dispose();
    }
    this.#disposables.length = 0;
  }
}
