import { IdeContextSnapshot } from "./contracts.js";
import { estimateTokens } from "@open-vs-code/agent-core";

export function buildBoundedIdeContextSnapshot(snapshot: IdeContextSnapshot, contextBudgetTokens: number): IdeContextSnapshot {
  const maxSelectionTokens = Math.floor(contextBudgetTokens * 0.25);
  
  let selection = snapshot.selection;
  if (selection && selection.selectedText) {
    const est = estimateTokens(selection.selectedText);
    if (est > maxSelectionTokens) {
      const allowedChars = Math.floor(maxSelectionTokens * 3.5);
      const truncated = selection.selectedText.substring(0, allowedChars) + "\n\n...[Truncated]";
      selection = { ...selection, selectedText: truncated };
    }
  }

  const visibleDocuments = snapshot.visibleDocuments.slice(0, 20);
  const diagnostics = snapshot.diagnostics.slice(0, 100);

  return {
    workspaceRoots: snapshot.workspaceRoots,
    activeDocument: snapshot.activeDocument,
    selection,
    visibleDocuments,
    diagnostics,
    isTrusted: snapshot.isTrusted
  };
}

export function resolveWorkspaceRoot(snapshot: IdeContextSnapshot): string | null {
  if (!snapshot.workspaceRoots || snapshot.workspaceRoots.length === 0) {
    return null;
  }
  
  // Explicitly check for no file multi-root ambiguity
  if (snapshot.workspaceRoots.length > 1 && !snapshot.activeDocument) {
      return null;
  }
  
  if (snapshot.activeDocument) {
    const activeUri = snapshot.activeDocument.uri;
    for (const root of snapshot.workspaceRoots) {
      if (activeUri.startsWith(root.uri)) {
        return root.fsPath;
      }
    }
  }
  
  return snapshot.workspaceRoots[0].fsPath;
}
