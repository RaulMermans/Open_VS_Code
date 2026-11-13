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
  private inflightOpens = new Map<string, Promise<void>>();
  private previewTitles = new Map<string, string>();
  
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

  /** Close preview tabs for a mutation that is no longer pending. Awaits any in-flight open. */
  async closeDiffEditors(mutationId: string): Promise<boolean> {
    const opening = this.inflightOpens.get(mutationId);
    if (opening) await opening.catch(() => undefined);
    const groups = vscode.window?.tabGroups;
    if (!groups || !Array.isArray(groups.all) || typeof groups.close !== "function") return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const tabs = this.matchingPreviewTabs(mutationId);
      if (tabs.length === 0) {
        this.previewTitles.delete(mutationId);
        return true;
      }
      try {
        await groups.close(tabs, true);
      } catch {
        // A tab may have already closed between the scan and the close call.
      }
    }
    const remaining = this.matchingPreviewTabs(mutationId);
    if (remaining.length === 0) this.previewTitles.delete(mutationId);
    return remaining.length === 0;
  }

  private matchingPreviewTabs(mutationId: string): vscode.Tab[] {
    const groups = vscode.window?.tabGroups;
    if (!groups || !Array.isArray(groups.all)) return [];
    const title = this.previewTitles.get(mutationId);
    const tabs: vscode.Tab[] = [];
    for (const group of groups.all) {
      for (const tab of group.tabs || []) {
        if (previewTabMatches(tab, mutationId, title)) tabs.push(tab);
      }
    }
    return tabs;
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
    this.previewTitles.set(mutationId, title);
    const work = this.showPreview(mutationId, beforeUri, afterUri, title);
    this.inflightOpens.set(mutationId, work);
    try {
      await work;
    } finally {
      if (this.inflightOpens.get(mutationId) === work) this.inflightOpens.delete(mutationId);
    }
  }

  private async showPreview(mutationId: string, beforeUri: vscode.Uri, afterUri: vscode.Uri, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, { preview: true });
    const started = Date.now();
    while (Date.now() - started < 250 && this.matchingPreviewTabs(mutationId).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function previewTabMatches(tab: { label?: string; input?: unknown }, mutationId: string, title?: string): boolean {
  const label = typeof tab.label === "string" ? tab.label : "";
  if (title && label === title) return true;
  if (label.startsWith("Open VS Code: Review") && mutationId && label.includes(mutationId)) return true;
  const texts = collectInputTexts(tab.input);
  const needle = "id=" + mutationId;
  return texts.some((text) => text.includes("open-vs-code-diff") && (text.includes(needle) || text.includes(mutationId)));
}

function collectInputTexts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as { original?: unknown; modified?: unknown; uri?: unknown };
  return [record.original, record.modified, record.uri].map(uriText).filter((text) => text.length > 0);
}

function uriText(value: unknown): string {
  if (!value) return "";
  const raw = typeof value === "string"
    ? value
    : typeof (value as { toString?: () => string }).toString === "function"
      ? String((value as { toString: () => string }).toString())
      : "";
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
