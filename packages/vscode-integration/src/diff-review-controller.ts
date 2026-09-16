import * as vscode from 'vscode';

export type ReviewStatus = 'PREPARED' | 'REVIEWING' | 'APPLIED' | 'REJECTED' | 'STALE' | 'FAILED' | 'CANCELLED';

export class DiffReviewController implements vscode.TextDocumentContentProvider {
  private registry = new Map<string, { before: string; after: string; size: number; status: ReviewStatus }>();
  private onDidChangeEmitter = vscode.EventEmitter ? new vscode.EventEmitter<vscode.Uri>() : null;
  onDidChange = this.onDidChangeEmitter?.event;
  
  private maxCount = 20;
  private maxBytes = 5 * 1024 * 1024; // 5 MB
  private currentBytes = 0;

  get registrySize() {
    return this.registry.size;
  }
  
  get registryBytes() {
    return this.currentBytes;
  }

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
    if (this.registry.has(mutationId)) {
        this.registry.get(mutationId)!.status = 'PREPARED';
        return; // Don't duplicate
    }

    const size = Buffer.byteLength(beforeContent) + Buffer.byteLength(afterContent);
    
    // Oversize preview policy
    if (size > this.maxBytes) {
      throw new Error("LARGE_CHANGE: review content exceeds max bytes.");
    }

    // Evict until we have space
    while (this.registry.size > 0 && (this.registry.size >= this.maxCount || this.currentBytes + size > this.maxBytes)) {
      const firstKey = this.registry.keys().next().value;
      if (firstKey) {
        const entry = this.registry.get(firstKey)!;
        this.currentBytes -= entry.size;
        this.registry.delete(firstKey);
      }
    }

    this.registry.set(mutationId, { before: beforeContent, after: afterContent, size, status: 'PREPARED' });
    this.currentBytes += size;
  }

  setStatus(mutationId: string, status: ReviewStatus) {
    const entry = this.registry.get(mutationId);
    if (entry) {
        entry.status = status;
    }
  }

  getStatus(mutationId: string): ReviewStatus | undefined {
    return this.registry.get(mutationId)?.status;
  }

  clearReview(mutationId: string) {
    const entry = this.registry.get(mutationId);
    if (entry) {
      this.currentBytes -= entry.size;
      this.registry.delete(mutationId);
    }
  }

  clearAll() {
    this.registry.clear();
    this.currentBytes = 0;
  }

  async openDiff(mutationId: string, targetPath: string, isCreate: boolean) {
    const entry = this.registry.get(mutationId);
    if (entry && entry.status === 'PREPARED') {
        entry.status = 'REVIEWING';
    }
    const beforeUri = vscode.Uri.parse(`open-vs-code-diff:preview?id=${mutationId}&side=before`);
    const afterUri = vscode.Uri.parse(`open-vs-code-diff:preview?id=${mutationId}&side=after`);
    const title = isCreate ? `Open VS Code: Review NEW FILE ${targetPath}` : `Open VS Code: Review ${targetPath}`;

    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
  }
}
