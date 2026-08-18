export interface EditorPosition {
  readonly line: number
  readonly character: number
}

export interface EditorSelection {
  readonly path: string
  readonly start: EditorPosition
  readonly end: EditorPosition
  readonly text: string
}

export interface EditorDiagnostic {
  readonly path: string
  readonly message: string
  readonly severity: "error" | "warning" | "information" | "hint"
  readonly line?: number
}

export interface EditorAdapter {
  getActiveFile(): Promise<string | undefined>
  getSelection?(): Promise<EditorSelection | undefined>
  getDiagnostics?(): Promise<readonly EditorDiagnostic[]>
  showDiff?(path: string, before: string, after: string): Promise<void>
}
