import * as vscode from 'vscode';

export class DiffReviewController implements vscode.TextDocumentContentProvider {
  private registry = new Map<string, { before: string; after: string }>();
  private onDidChangeEmitter = vscode.EventEmitter ? new vscode.EventEmitter<vscode.Uri>() : null;
  onDidChange = this.onDidChangeEmitter?.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const mutationId = params.get('id');
    const side = params.get('side');
    if (!mutationId || !side) return "Invalid diff review URI.";

    const entry = this.registry.get(mutationId);
    if (!entry) return "Review content no longer available or was disposed.";

    return side === 'before' ? entry.before : entry.after;
  }

  registerReview(mutationId: string, beforeContent: string, afterContent: string) {
    if (this.registry.size > 20) {
      const firstKey = this.registry.keys().next().value;
      if (firstKey) this.registry.delete(firstKey);
    }
    this.registry.set(mutationId, { before: beforeContent, after: afterContent });
  }

  clearReview(mutationId: string) {
    this.registry.delete(mutationId);
  }

  clearAll() {
    this.registry.clear();
  }

  async openDiff(mutationId: string, targetPath: string, isCreate: boolean) {
    const beforeUri = vscode.Uri.parse(`open-vs-code-diff:preview?id=${mutationId}&side=before`);
    const afterUri = vscode.Uri.parse(`open-vs-code-diff:preview?id=${mutationId}&side=after`);
    const title = `Open VS Code: Review ${targetPath}`;

    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
  }
}
