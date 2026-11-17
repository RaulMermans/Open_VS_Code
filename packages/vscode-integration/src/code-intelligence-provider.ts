/**
 * CodeIntelligenceProvider over VS Code's own language features (Sprint 24, ADR-047):
 * vscode.executeDefinitionProvider, vscode.executeReferenceProvider and vscode.executeDocumentRenameProvider.
 * The rename command only returns a WorkspaceEdit; this provider never calls workspace.applyEdit. Edits are
 * returned with the document text they were computed against, and agent-core turns them into reviewed,
 * hash-checked mutations.
 */
import type * as vscode from 'vscode';
import type { CodeIntelligenceProvider, CodeLocation, CodePosition, CodeRange, FileEdits } from '@open-vs-code/agent-core';

export type VsCodeLanguageApi = {
  readonly commands: Pick<typeof vscode.commands, 'executeCommand'>;
  readonly workspace: Pick<typeof vscode.workspace, 'openTextDocument'>;
  readonly Uri: Pick<typeof vscode.Uri, 'file'>;
  readonly Position: typeof vscode.Position;
};

const TEXT_EDIT = 2; // FileEditType.Text in the extension host's WorkspaceEdit entries

function range(value: { start: { line: number; character: number }; end: { line: number; character: number } }): CodeRange {
  return { start: { line: value.start.line, character: value.start.character }, end: { line: value.end.line, character: value.end.character } };
}

/** Location | Location[] | LocationLink[] -> file locations (non-file schemes dropped). */
export function toLocations(result: unknown): CodeLocation[] {
  const items = Array.isArray(result) ? result : result ? [result] : [];
  return items.flatMap((item: any) => {
    const uri = item?.targetUri ?? item?.uri;
    const span = item?.targetSelectionRange ?? item?.targetRange ?? item?.range;
    return uri?.scheme === 'file' && span ? [{ file: uri.fsPath as string, range: range(span) }] : [];
  });
}

function describeEntry(entry: any): string {
  if (entry?._type === 1) {
    const from = entry.from?.fsPath, to = entry.to?.fsPath;
    return from && to ? `move ${from} -> ${to}` : from ? `delete ${from}` : to ? `create ${to}` : 'file operation';
  }
  return `unsupported edit kind ${String(entry?._type)}`;
}

export function createVsCodeCodeIntelligence(api: VsCodeLanguageApi): CodeIntelligenceProvider {
  const open = (file: string) => api.workspace.openTextDocument(api.Uri.file(file));
  const position = (value: CodePosition) => new api.Position(value.line, value.character);
  return {
    name: 'vscode',
    readText: async (file) => (await open(file)).getText(),
    definitions: async (file, at) => toLocations(await api.commands.executeCommand('vscode.executeDefinitionProvider', (await open(file)).uri, position(at))),
    references: async (file, at) => toLocations(await api.commands.executeCommand('vscode.executeReferenceProvider', (await open(file)).uri, position(at))),
    rename: async (file, at, newName) => {
      let edit: any;
      try {
        edit = await api.commands.executeCommand('vscode.executeDocumentRenameProvider', (await open(file)).uri, position(at), newName);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!edit || typeof edit.entries !== 'function') return { ok: false, error: 'no rename provider is available for this file' };
      // entries() lists text edits only; file creates/deletes/moves are visible only in the full entry list.
      // Fail closed if that list cannot be inspected rather than silently dropping operations.
      const all = typeof edit._allEntries === 'function' ? edit._allEntries() : undefined;
      if (!Array.isArray(all)) return { ok: false, error: 'the proposed WorkspaceEdit cannot be inspected for file operations' };
      const resourceOperations: string[] = all.filter((entry: any) => entry?._type !== TEXT_EDIT).map(describeEntry);
      const files: FileEdits[] = [];
      for (const [uri, edits] of edit.entries() as Array<[vscode.Uri, vscode.TextEdit[]]>) {
        if (uri.scheme !== 'file') { resourceOperations.push(`edit of non-file resource ${uri.toString()}`); continue; }
        files.push({ file: uri.fsPath, baseText: (await open(uri.fsPath)).getText(), edits: edits.map((item) => ({ range: range(item.range), newText: item.newText })) });
      }
      return { ok: true, files, resourceOperations };
    },
  };
}
