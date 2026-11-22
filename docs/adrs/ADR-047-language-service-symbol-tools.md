# ADR-047: Language-service symbol tools (find_symbol, rename_symbol)

Status: Accepted (Sprint 24, 2026-11-17)

## Context

Cross-file renames were the weakest coding category (Sprint 21 d07/h08; Sprint 23 R1 failed on every
candidate): the model edits one side, leaves an importer stale, or touches an unrelated helper with the same
name. The editor already ships a language service that answers "where is this symbol used" exactly.

## Decision

1. A `CodeIntelligenceProvider` contract in agent-core (`tools/code-intelligence.ts`): `definitions`,
   `references`, `rename` (proposal only) and `readText`, with 0-based UTF-16 positions.
   - IDE: `vscode-integration/src/code-intelligence-provider.ts` over `vscode.executeDefinitionProvider`,
     `vscode.executeReferenceProvider`, `vscode.executeDocumentRenameProvider`. It never calls
     `workspace.applyEdit`. File operations and non-file resources in the WorkspaceEdit are reported (via
     the extension host's `_allEntries()`); if that list cannot be inspected the rename fails closed.
   - Headless (tests, live evaluation): `tools/typescript-code-intelligence.ts` over the TypeScript
     LanguageService. Not exported from the package index, so TypeScript is never bundled in the extension.
2. Two agent tools, registered only in trusted workspaces (untrusted sessions are unchanged):
   - `find_symbol(path, symbol, line?, offset?)` (read): definition, kind, references with snippets,
     25 per page, sorted, de-duplicated; outside-workspace references counted, not listed.
   - `rename_symbol(path, symbol, newName, line?)` (write_file): resolves the symbol by asking the
     provider for the definition of each occurrence in the file; two different symbols with that name is an
     explicit ambiguity error until `line` is given. The rename is anchored at the definition (so it is
     global), except for an alias (`import { a as b }`), which is renamed locally.
3. A proposal becomes one review: each file goes through `MutationEngine.prepareRewrite` (containment,
   symlink and policy checks, binary check, budgets, and the disk text must equal the text the provider
   analyzed). Out-of-workspace files, overlapping edits, resource operations and more than 25 files are
   refused with nothing written. Apply re-checks every base hash before the first write; if a later write
   fails, files already written are rolled back and the result says what was restored.
4. The runner treats a payload with `files` as a group: one preimage, precondition and postcondition per
   file in the checkpoint journal, exclusion rules ("do not edit X") applied to every file, and one mutation
   outcome per file so typecheck selection, requirement checks and completion see all of them.
5. TypeScript/JavaScript renames default to `useAliasesForRenames: false` (product configuration default,
   user-overridable) so a rename updates importers instead of keeping the old name behind an alias.
   The tool result still reports any alias-preserving edits.
6. After a rename, the observation lists source files that still contain the old name as a word but are not
   linked to the symbol by the language service (lower confidence; they are not edited).
7. Coverage check before review (added after packaged-GUI runs). VS Code's TypeScript server can answer from a
   partial project while it loads, or per file without a tsconfig, and then proposes a rename of the open file
   only. Every other workspace file that mentions the name is checked through `definitions`: a use resolving
   to the definition but missing from the proposal, or an import the service cannot resolve past its own
   binding, counts as uncovered. The rename is re-requested up to 4 times 1.5 s apart (those files are open by
   then), and otherwise refused with nothing written.
8. Hand-rename redirect (added after the first live A/B). With `rename_symbol` registered, any single-file
   `write_file` review (`apply_patch`, or `create_file` over an existing file) that removes an exported or
   imported name and adds the target the request states after "to/into/as" is refused unwritten, naming the
   exact `rename_symbol` call. Without it the model renamed the declaration by hand first, which broke every
   importer and left `rename_symbol` nothing to anchor on.
9. `create_file` over an existing file (prepared as a patch) now carries its real `beforeContent`; it was `""`,
   which hid it from the redirect, skipped its checkpoint preimage, and showed an empty "before" in review.

## Alternatives

- ts-morph: its rename is the same `LanguageService.findRenameLocations` call; no gap it would close.
- Regex or model-driven multi-file patches (OpenCode `replaceAll`, Gemini CLI LLM edit correction): no
  scope information, so they cannot tell an importer from an unrelated same-named helper.
- `workspace.applyEdit` after approval: bypasses MutationEngine hashing, preimages and rollback.

## Consequences

- One approval covers a whole rename; the review card names every file and the diff view shows all of them.
- Coverage is the language project's: files outside the TypeScript project (or another tsconfig in a
  multi-project monorepo, headless) are not renamed; the leftover-occurrence note says so.
- Languages without a rename provider in VSCodium (e.g. Python without an extension) report "no definition"
  and the agent falls back to search_text/apply_patch.
