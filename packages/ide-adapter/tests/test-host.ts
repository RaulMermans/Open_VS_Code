import { IdeHost, IdeContextSnapshot, WorkspaceRoot, EditorDocument, EditorSelection, EditorDiagnostic } from "../src/contracts.js";

export class TestIdeHost implements IdeHost {
  public workspaceRoots: WorkspaceRoot[] = [];
  public activeDocument: EditorDocument | null = null;
  public selection: EditorSelection | null = null;
  public visibleDocuments: EditorDocument[] = [];
  public diagnostics: EditorDiagnostic[] = [];
  public trusted: boolean = true;
  
  public outputs: string[] = [];
  public errors: string[] = [];
  
  public nextConfirmationResponse: "APPROVE" | "REJECT" = "APPROVE";
  public confirmationsRequested: { prompt: string, payload: any }[] = [];
  
  async getWorkspaceRoots(): Promise<WorkspaceRoot[]> {
    return this.workspaceRoots;
  }
  async getActiveDocument(): Promise<EditorDocument | null> {
    return this.activeDocument;
  }
  async getSelection(): Promise<EditorSelection | null> {
    return this.selection;
  }
  async getVisibleDocuments(): Promise<EditorDocument[]> {
    return this.visibleDocuments;
  }
  async getDiagnostics(): Promise<EditorDiagnostic[]> {
    return this.diagnostics;
  }
  async isWorkspaceTrusted(): Promise<boolean> {
    return this.trusted;
  }
  async showOutput(message: string): Promise<void> {
    this.outputs.push(message);
  }
  async showError(message: string): Promise<void> {
    this.errors.push(message);
  }
  async requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT"> {
    this.confirmationsRequested.push({ prompt, payload });
    return this.nextConfirmationResponse;
  }
  onWorkspaceChange(listener: () => void): { dispose: () => void; } {
    return { dispose: () => {} };
  }
  async getSnapshot(): Promise<IdeContextSnapshot> {
    return {
      workspaceRoots: this.workspaceRoots,
      activeDocument: this.activeDocument,
      selection: this.selection,
      visibleDocuments: this.visibleDocuments,
      diagnostics: this.diagnostics,
      isTrusted: this.trusted
    };
  }
}
