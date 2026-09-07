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
