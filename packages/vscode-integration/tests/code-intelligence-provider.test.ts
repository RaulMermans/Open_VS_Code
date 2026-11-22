// WorkspaceEdit -> proposal conversion. Language-service correctness itself is covered against the real
// TypeScript service in agent-core and in the packaged GUI run; this checks the VS Code adapter contract.
import assert from "node:assert/strict";
import test from "node:test";
import { createVsCodeCodeIntelligence, toLocations } from "../src/code-intelligence-provider.ts";

const uri = (fsPath: string, scheme = "file") => ({ fsPath, scheme, toString: () => `${scheme}://${fsPath}` });
const span = (line: number, a: number, b: number) => ({ start: { line, character: a }, end: { line, character: b } });

function api(renameResult: unknown, calls: string[] = []) {
  return {
    commands: {
      executeCommand: async (command: string) => {
        calls.push(command);
        if (command === "vscode.executeDocumentRenameProvider") {
          if (renameResult instanceof Error) throw renameResult;
          return renameResult;
        }
        return [{ targetUri: uri("/ws/a.ts"), targetSelectionRange: span(0, 16, 19), targetRange: span(0, 0, 30) }];
      },
    },
    workspace: { openTextDocument: async (u: any) => ({ uri: u, getText: () => `text of ${u.fsPath}` }) },
    Uri: { file: (p: string) => uri(p) },
    Position: class { constructor(public line: number, public character: number) {} },
  } as any;
}

function workspaceEdit(entries: Array<[any, any[]]>, extra: any[] = []) {
  return {
    entries: () => entries,
    _allEntries: () => [...entries.flatMap(([u, edits]) => edits.map((edit) => ({ _type: 2, uri: u, edit }))), ...extra],
  };
}

test("locations accept Location and LocationLink shapes and drop non-file schemes", () => {
  assert.deepEqual(toLocations({ uri: uri("/ws/b.ts"), range: span(2, 1, 4) }), [{ file: "/ws/b.ts", range: span(2, 1, 4) }]);
  assert.deepEqual(toLocations([{ targetUri: uri("/ws/a.ts"), targetSelectionRange: span(0, 16, 19), targetRange: span(0, 0, 30) }]), [{ file: "/ws/a.ts", range: span(0, 16, 19) }]);
  assert.deepEqual(toLocations([{ uri: uri("x", "untitled"), range: span(0, 0, 1) }]), []);
  assert.deepEqual(toLocations(undefined), []);
});

test("a rename returns per-file edits with the analyzed text, and never applies anything", async () => {
  const calls: string[] = [];
  const provider = createVsCodeCodeIntelligence(api(workspaceEdit([[uri("/ws/a.ts"), [{ range: span(0, 16, 19), newText: "sum" }]]]), calls));
  const outcome = await provider.rename("/ws/a.ts", { line: 0, character: 16 }, "sum");
  assert.deepEqual(outcome, { ok: true, files: [{ file: "/ws/a.ts", baseText: "text of /ws/a.ts", edits: [{ range: span(0, 16, 19), newText: "sum" }] }], resourceOperations: [] });
  assert.ok(!calls.some((call) => /applyEdit/i.test(call)));
});

test("file operations and non-file resources are reported, not dropped", async () => {
  const move = { _type: 1, from: uri("/ws/a.ts"), to: uri("/ws/b.ts") };
  const outcome = await createVsCodeCodeIntelligence(api(workspaceEdit([[uri("x", "vscode-notebook-cell"), [{ range: span(0, 0, 1), newText: "y" }]]], [move]))).rename("/ws/a.ts", { line: 0, character: 0 }, "y");
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.ok && outcome.resourceOperations, ["move /ws/a.ts -> /ws/b.ts", "edit of non-file resource vscode-notebook-cell://x"]);
});

test("an uninspectable edit, a missing provider and a provider error fail closed", async () => {
  const at = { line: 0, character: 0 };
  assert.deepEqual(await createVsCodeCodeIntelligence(api({ entries: () => [] })).rename("/ws/a.ts", at, "y"), { ok: false, error: "the proposed WorkspaceEdit cannot be inspected for file operations" });
  assert.deepEqual(await createVsCodeCodeIntelligence(api(undefined)).rename("/ws/a.ts", at, "y"), { ok: false, error: "no rename provider is available for this file" });
  assert.deepEqual(await createVsCodeCodeIntelligence(api(new Error("You cannot rename this element."))).rename("/ws/a.ts", at, "y"), { ok: false, error: "You cannot rename this element." });
});
