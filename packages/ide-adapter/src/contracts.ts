export interface WorkspaceRoot {
  uri: string;
  fsPath: string;
  name?: string;
}

export interface EditorPosition {
  line: number;
  character: number;
}

export interface EditorSelection {
  start: EditorPosition;
  end: EditorPosition;
  selectedText?: string;
}

export interface EditorDocument {
  uri: string;
  workspaceRelativePath?: string;
  languageId: string;
  version: number;
  isDirty: boolean;
}

export interface EditorDiagnostic {
  path: string;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  range?: {
    start: EditorPosition;
    end: EditorPosition;
  };
  source?: string;
  code?: string | number;
}

export interface IdeContextSnapshot {
  workspaceRoots: WorkspaceRoot[];
  activeDocument: EditorDocument | null;
  selection: EditorSelection | null;
  visibleDocuments: EditorDocument[];
  diagnostics: EditorDiagnostic[];
  isTrusted: boolean;
}

export interface IdeHost {
  getWorkspaceRoots(): Promise<WorkspaceRoot[]>;
  getActiveDocument(): Promise<EditorDocument | null>;
  getSelection(): Promise<EditorSelection | null>;
  getVisibleDocuments(): Promise<EditorDocument[]>;
  getDiagnostics(): Promise<EditorDiagnostic[]>;
  isWorkspaceTrusted(): Promise<boolean>;

  showOutput(message: string): Promise<void>;
  showError(message: string): Promise<void>;
  requestConfirmation(prompt: string, payload: any): Promise<"APPROVE" | "REJECT">;
  
  onWorkspaceChange(listener: () => void): { dispose: () => void };
  
  getSnapshot(): Promise<IdeContextSnapshot>;
}
