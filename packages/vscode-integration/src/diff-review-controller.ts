import * as vscode from 'vscode';

export type ReviewStatus = 'PREPARED' | 'REVIEWING' | 'APPROVED' | 'APPLIED' | 'REJECTED' | 'STALE' | 'FAILED' | 'CANCELLED';

/** Opening a diff is a preview. These statuses never grant write permission. */
export function isDiffPreviewStatus(status: ReviewStatus | undefined): boolean {
  return status === 'PREPARED' || status === 'REVIEWING' || status === 'APPROVED';
}

export class DiffReviewController implements vscode.TextDocumentContentProvider {
  private registry = new Map<string, { before: string; after: string; size: number }>();
  private statuses = new Map<string, ReviewStatus>();
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
    if (!mutationId || !side || (side !== 'before' && side !== 'after')) return "Invalid diff review URI.";

    const entry = this.registry.get(mutationId);
    if (!entry) return "Review content no longer available or was disposed.";

    return side === 'before' ? entry.before : entry.after;
  }

  registerReview(mutationId: string, beforeContent: string, afterContent: string) {
    if (this.registry.has(mutationId)) {
      this.statuses.set(mutationId, 'PREPARED');
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

    this.registry.set(mutationId, { before: beforeContent, after: afterContent, size });
    this.statuses.set(mutationId, 'PREPARED');
    this.currentBytes += size;
  }

  setStatus(mutationId: string, status: ReviewStatus) {
    this.statuses.set(mutationId, status);
  }

  getStatus(mutationId: string): ReviewStatus | undefined {
    return this.statuses.get(mutationId);
  }

  clearReview(mutationId: string) {
    const entry = this.registry.get(mutationId);
    if (entry) {
      this.currentBytes -= entry.size;
      this.registry.delete(mutationId);
    }
  }

  /** Close preview tabs for a mutation that is no longer pending. Does not change permission state. */
  closeDiffEditors(mutationId: string): void {
    const needle = "id=" + mutationId;
    const groups = vscode.window?.tabGroups;
    if (!groups || !Array.isArray(groups.all) || typeof groups.close !== "function") return;
    const tabs: vscode.Tab[] = [];
    for (const group of groups.all) {
      for (const tab of group.tabs || []) {
        const input = tab.input as { original?: vscode.Uri; modified?: vscode.Uri; uri?: vscode.Uri } | undefined;
        const texts = [input?.original, input?.modified, input?.uri].map((uri) =>
          uri && typeof uri.toString === "function" ? uri.toString() : "",
        );
        if (texts.some((text) => text.includes("open-vs-code-diff:") && text.includes(needle))) {
          tabs.push(tab);
        }
      }
    }
    if (tabs.length) void groups.close(tabs, true);
  }

  clearAll() {
    this.registry.clear();
    this.statuses.clear();
    this.currentBytes = 0;
  }

  async openDiff(mutationId: string, targetPath: string, isCreate: boolean) {
    if (this.registry.has(mutationId)) {
      this.statuses.set(mutationId, 'REVIEWING');
    }
    const beforeUri = vscode.Uri.parse(`open-vs-code-diff:preview?id=${mutationId}&side=before`);
    const afterUri = vscode.Uri.parse(`open-vs-code-diff:preview?id=${mutationId}&side=after`);
    const title = isCreate ? `Open VS Code: Review NEW FILE ${targetPath}` : `Open VS Code: Review ${targetPath}`;

    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
  }
}
