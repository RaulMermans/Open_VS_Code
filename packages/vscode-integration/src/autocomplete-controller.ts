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
  MIN_PREFIX_NON_WS_CHARS,
  PREFIX_CHAR_CEILING,
  SUFFIX_CHAR_CEILING,
  type AutocompleteGateway,
  type AutocompleteScheduler,
} from '@open-vs-code/agent-core';

export const AUTOCOMPLETE_ACCEPTED_COMMAND = 'open-vs-code.autocompleteAccepted';
export const AUTOCOMPLETE_TOGGLE_COMMAND = 'open-vs-code.toggleAutocomplete';

/** Extra characters past each ceiling, so the context builder's surrogate-safe cut matches cutting the full text. */
const WINDOW_MARGIN = 16;

/**
 * Editor text around the cursor (Sprint 7D). Only the last PREFIX_CHAR_CEILING and the
 * first SUFFIX_CHAR_CEILING characters can reach the model, so this copies a bounded
 * window instead of the whole document on every keystroke. The context built from it
 * is identical to the one built from the full text.
 */
export function editorTextAround(document: vscode.TextDocument, position: vscode.Position): { rawPrefix: string; rawSuffix: string } {
  const offset = document.offsetAt(position);
  const prefixStart = Math.max(0, offset - PREFIX_CHAR_CEILING - WINDOW_MARGIN);
  let rawPrefix = document.getText(new vscode.Range(document.positionAt(prefixStart), position));
  // The empty-prefix check looks at the whole prefix; when the window alone could fail it,
  // decide on the full prefix as before.
  if (prefixStart > 0 && rawPrefix.replace(/\s+/g, '').length < MIN_PREFIX_NON_WS_CHARS) {
    rawPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
  }
  const rawSuffix = document.getText(
    new vscode.Range(position, document.positionAt(offset + SUFFIX_CHAR_CEILING + WINDOW_MARGIN)),
  );
  return { rawPrefix, rawSuffix };
}

export interface AutocompleteControllerOptions {
  readonly gateway: AutocompleteGateway;
  readonly debounceMs?: number;
  readonly timeoutMs?: number;
  readonly scheduler?: AutocompleteScheduler;
}

export class AutocompleteController implements vscode.InlineCompletionItemProvider {
  readonly service: AutocompleteService;
  readonly #disposables: vscode.Disposable[] = [];
  #registered = false;

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
   * Idempotent: repeated calls do not register duplicate providers.
   */
  register(context: vscode.ExtensionContext): vscode.Disposable[] {
    if (this.#registered) {
      return this.#disposables;
    }
    this.#registered = true;

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
    const { rawPrefix, rawSuffix } = editorTextAround(document, position);

    const snapshot = {
      rawPrefix,
      rawSuffix,
      languageId: document.languageId,
      relativePath: vscode.workspace.asRelativePath(document.uri, false),
      documentVersion: document.version,
      cursorLine: position.line,
      cursorCharacter: position.character,
    };

    // Live editor state supplier that inspects the active editor upon completion
    const liveEditorSupplier = () => {
      const active = vscode.window.activeTextEditor;
      if (!active) return null;
      return {
        documentUri: active.document.uri.toString(),
        documentVersion: active.document.version,
        cursorLine: active.selection.active.line,
        cursorCharacter: active.selection.active.character,
      };
    };

    // Map VS Code CancellationToken to AbortSignal
    const abortController = new AbortController();
    let cancellation: { dispose(): void } | undefined;
    if (token.isCancellationRequested) {
      abortController.abort();
    } else {
      cancellation = token.onCancellationRequested(() => abortController.abort());
    }

    let result;
    try {
      result = await this.service.trigger(
        snapshot,
        document.uri.toString(),
        abortController.signal,
        liveEditorSupplier,
      );
    } finally {
      cancellation?.dispose?.();
    }

    if (!result || !result.text) {
      return null;
    }

    // Final live editor check before returning completion item
    const live = liveEditorSupplier();
    if (
      !live ||
      live.documentUri !== document.uri.toString() ||
      live.documentVersion !== document.version ||
      live.cursorLine !== position.line ||
      live.cursorCharacter !== position.character
    ) {
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
  async dispose(): Promise<void> {
    try {
      await this.service.dispose();
    } catch {
      // Safe error containment
    }
    for (const d of this.#disposables) {
      d.dispose();
    }
    this.#disposables.length = 0;
    this.#registered = false;
  }
}
