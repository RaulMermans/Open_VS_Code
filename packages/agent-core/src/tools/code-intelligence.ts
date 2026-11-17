/**
 * Language-aware agent tools (Sprint 24, ADR-047).
 *
 * The model decides WHAT to change; a language service (VS Code's execute*Provider commands in the IDE,
 * the TypeScript LanguageService headless) decides WHERE; the MutationEngine decides HOW. A rename
 * proposal is never applied by the language service: it becomes a group of prepared mutations that go
 * through the normal approval card, are re-checked against disk before any write, and roll back as a
 * group if one write fails.
 */
import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { MutationFailure, type MutationFailureCode, type MutationResult, type PreparedMutation } from "./mutation-contracts.ts"
import { sha256, type MutationEngine } from "./mutation-engine.ts"
import { resolveRepositoryPath } from "./path-safety.ts"
import type { ToolRegistration } from "./registry.ts"
import { searchText } from "./search-text.ts"

/** 0-based, UTF-16 code units (VS Code and TypeScript agree on both). */
export interface CodePosition { readonly line: number; readonly character: number }
export interface CodeRange { readonly start: CodePosition; readonly end: CodePosition }
/** `file` is an absolute filesystem path. */
export interface CodeLocation { readonly file: string; readonly range: CodeRange }
export interface CodeTextEdit { readonly range: CodeRange; readonly newText: string }
/** Edits for one file, with the exact text the provider computed them against. */
export interface FileEdits { readonly file: string; readonly baseText: string; readonly edits: readonly CodeTextEdit[] }
export type RenameOutcome =
  | { readonly ok: true; readonly files: readonly FileEdits[]; readonly resourceOperations: readonly string[] }
  | { readonly ok: false; readonly error: string }

export interface CodeIntelligenceProvider {
  readonly name: string
  /** Current text as the language service sees it (an editor buffer may differ from disk). */
  readText(file: string): Promise<string>
  definitions(file: string, position: CodePosition): Promise<readonly CodeLocation[]>
  /** Includes the declaration. */
  references(file: string, position: CodePosition): Promise<readonly CodeLocation[]>
  /** Must only PROPOSE edits; never write. */
  rename(file: string, position: CodePosition, newName: string): Promise<RenameOutcome>
  symbolKind?(file: string, position: CodePosition): Promise<string | undefined>
}

export const REFERENCE_PAGE_SIZE = 25
export const MAX_RENAME_FILES = 25
const COVERAGE_RETRIES = 4
const COVERAGE_RETRY_MS = 1500
const MAX_PROBED_OCCURRENCES = 40
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1)
  return starts
}

export function offsetAt(starts: readonly number[], position: CodePosition): number {
  const start = starts[position.line]
  if (start === undefined) throw new RangeError(`line ${position.line + 1} is past the end of the file`)
  return start + position.character
}

function identifierOccurrences(text: string, symbol: string): CodePosition[] {
  const starts = lineStarts(text)
  const pattern = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, "\\$")}(?![\\w$])`, "g")
  const found: CodePosition[] = []
  for (const match of text.matchAll(pattern)) {
    let line = 0
    while (line + 1 < starts.length && starts[line + 1]! <= match.index) line += 1
    found.push({ line, character: match.index - starts[line]! })
  }
  return found
}

/** Apply non-overlapping edits; overlapping edits are a conflict, never guessed. */
export function applyTextEdits(baseText: string, edits: readonly CodeTextEdit[]): string {
  const starts = lineStarts(baseText)
  const spans = edits
    .map((edit) => ({ start: offsetAt(starts, edit.range.start), end: offsetAt(starts, edit.range.end), newText: edit.newText }))
    .toSorted((left, right) => left.start - right.start || left.end - right.end)
  let output = ""
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor || span.end < span.start || span.end > baseText.length) {
      throw new MutationFailure("INVALID_PATCH", "The language service proposed overlapping or out-of-range edits; nothing was changed.")
    }
    output += baseText.slice(cursor, span.start) + span.newText
    cursor = span.end
  }
  return output + baseText.slice(cursor)
}

const locationKey = (location: CodeLocation) => `${location.file}:${location.range.start.line}:${location.range.start.character}`

async function workspaceRelative(root: string, file: string): Promise<string | undefined> {
  const real = await realpath(file).catch(() => file)
  const path = relative(root, real)
  return path === "" || path.startsWith("..") || isAbsolute(path) ? undefined : path.replaceAll("\\", "/")
}

interface ResolvedSymbol {
  readonly file: string
  /** Where the symbol was found in the requested file. */
  readonly occurrence: CodePosition
  readonly definition: CodeLocation
  /** Rename/reference anchor: the definition when it is the same name inside the workspace, else the occurrence. */
  readonly anchor: { readonly file: string; readonly position: CodePosition }
}

class SymbolLookupError extends Error {}

async function resolveSymbol(
  provider: CodeIntelligenceProvider,
  root: string,
  path: string,
  symbol: string,
  line: number | undefined,
): Promise<ResolvedSymbol> {
  if (!IDENTIFIER.test(symbol)) throw new SymbolLookupError(`${symbol} is not an identifier. Pass the bare symbol name, e.g. formatDate.`)
  const file = await resolveRepositoryPath(root, path, "file")
  const text = await provider.readText(file)
  const occurrences = identifierOccurrences(text, symbol).filter((position) => line === undefined || position.line === line - 1)
  if (occurrences.length === 0) throw new SymbolLookupError(`${symbol} does not appear ${line ? `on line ${line} of` : "in"} ${path}.`)
  const groups = new Map<string, { definition: CodeLocation; occurrence: CodePosition; lines: number[] }>()
  for (const occurrence of occurrences.slice(0, MAX_PROBED_OCCURRENCES)) {
    const definitions = [...await provider.definitions(file, occurrence)].toSorted((a, b) => locationKey(a).localeCompare(locationKey(b)))
    const definition = definitions[0]
    if (!definition) continue // comments, strings, or no provider for this language
    const key = locationKey(definition)
    const group = groups.get(key) ?? { definition, occurrence, lines: [] }
    group.lines.push(occurrence.line + 1)
    groups.set(key, group)
  }
  if (groups.size === 0) {
    throw new SymbolLookupError(`The ${provider.name} language service found no definition for ${symbol} in ${path} (no provider for this language, or ${symbol} only appears in comments or strings). Use search_text and apply_patch instead.`)
  }
  if (groups.size > 1) {
    const options = await Promise.all([...groups.values()].map(async (group) =>
      `line ${group.lines[0]} -> ${(await workspaceRelative(root, group.definition.file)) ?? group.definition.file}:${group.definition.range.start.line + 1}`))
    throw new SymbolLookupError(`${path} has ${groups.size} different symbols named ${symbol} (${options.join("; ")}). Call again with line set to the one you mean.`)
  }
  const { definition, occurrence } = [...groups.values()][0]!
  let anchor = { file, position: occurrence }
  if (await workspaceRelative(root, definition.file)) {
    const definitionText = await provider.readText(definition.file)
    const starts = lineStarts(definitionText)
    const start = offsetAt(starts, definition.range.start)
    // An alias (import { a as b }) resolves to a; renaming b must not rename a.
    if (definitionText.slice(start, start + symbol.length) === symbol) anchor = { file: definition.file, position: definition.range.start }
  }
  return { file, occurrence, definition, anchor }
}

function objectArguments(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("arguments must be an object")
  const record = input as Record<string, unknown>
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key))
  if (unexpected) throw new TypeError(`unexpected argument: ${unexpected}`)
  return record
}

function stringArgument(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

function positiveInteger(record: Record<string, unknown>, name: string): number | undefined {
  const value = record[name]
  if (value === undefined || value === null) return undefined
  const number = typeof value === "string" ? Number(value) : value
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return number
}

function symbolArguments(input: unknown, extra: readonly string[]) {
  const record = objectArguments(input, ["path", "symbol", "line", ...extra])
  const line = positiveInteger(record, "line")
  return { path: stringArgument(record, "path"), symbol: stringArgument(record, "symbol"), ...(line ? { line } : {}), record }
}

const SYMBOL_PROPERTIES = {
  path: { type: "string", description: "Workspace-relative file where the symbol is defined or used" },
  symbol: { type: "string", description: "The identifier, e.g. formatDate" },
  line: { type: "integer", minimum: 1, description: "Optional 1-based line, only needed when the file has two different symbols with this name" },
}

async function findSymbol(provider: CodeIntelligenceProvider, workspaceRoot: string, input: Readonly<Record<string, unknown>>) {
  const root = await realpath(workspaceRoot)
  const symbol = input.symbol as string
  const resolved = await resolveSymbol(provider, root, input.path as string, symbol, input.line as number | undefined)
  const definitionPath = await workspaceRelative(root, resolved.definition.file)
  const kind = await provider.symbolKind?.(resolved.anchor.file, resolved.anchor.position).catch(() => undefined)
  const all = await provider.references(resolved.anchor.file, resolved.anchor.position)
  const unique = new Map<string, CodeLocation>()
  for (const location of all) unique.set(locationKey(location), location)
  const definitionKey = locationKey(resolved.definition)
  const texts = new Map<string, string[]>()
  const rows: Array<{ path: string; line: number; character: number; isDefinition: boolean; file: string }> = []
  let outside = 0
  for (const location of unique.values()) {
    const path = await workspaceRelative(root, location.file)
    if (!path) { outside += 1; continue }
    rows.push({ path, line: location.range.start.line, character: location.range.start.character, isDefinition: locationKey(location) === definitionKey, file: location.file })
  }
  rows.sort((a, b) => Number(b.isDefinition) - Number(a.isDefinition) || a.path.localeCompare(b.path) || a.line - b.line || a.character - b.character)
  const offset = (input.offset as number | undefined) ?? 0
  const page = rows.slice(offset, offset + REFERENCE_PAGE_SIZE)
  const references: string[] = []
  for (const row of page) {
    if (!texts.has(row.file)) texts.set(row.file, (await provider.readText(row.file)).split("\n"))
    const snippet = (texts.get(row.file)![row.line] ?? "").trim().slice(0, 140)
    references.push(`${row.path}:${row.line + 1}:${row.character + 1}${row.isDefinition ? " [definition]" : ""}  ${snippet}`)
  }
  const files = new Set(rows.map((row) => row.path))
  return {
    symbol,
    ...(kind ? { kind } : {}),
    languageService: provider.name,
    definition: definitionPath
      ? `${definitionPath}:${resolved.definition.range.start.line + 1}:${resolved.definition.range.start.character + 1}`
      : `${resolved.definition.file} (outside the workspace, read-only)`,
    totalReferences: rows.length,
    files: [...files].toSorted(),
    ...(outside ? { referencesOutsideWorkspace: outside } : {}),
    shown: `${page.length === 0 ? 0 : offset + 1}-${offset + page.length} of ${rows.length}`,
    references,
    ...(offset + page.length < rows.length ? { next: `call find_symbol again with offset ${offset + page.length}` } : {}),
  }
}

const fileHeader = (path: string) => `===== ${path} =====\n`

function groupFailure(id: string, path: string, code: MutationFailureCode, message: string): MutationResult {
  return { id, status: code === "STALE_BASE" ? "STALE_BASE" : "FAILED", path, operation: "patch", error: new MutationFailure(code, message), observation: message }
}

export function createCodeIntelligenceToolRegistrations(provider: CodeIntelligenceProvider, engine?: MutationEngine): readonly ToolRegistration[] {
  const lookupFailure = (error: unknown): never => {
    if (error instanceof SymbolLookupError) throw new MutationFailure("INVALID_PATCH", error.message)
    throw error
  }
  const findTool: ToolRegistration = {
    definition: {
      name: "find_symbol",
      description: "Ask the language service where a symbol is defined and every place that references it (imports, calls, re-exports), across files. Same-named but unrelated symbols are not included. Use it before changing a function, type or constant that other files use.",
      action: "read_repository",
      inputSchema: {
        type: "object",
        properties: { ...SYMBOL_PROPERTIES, offset: { type: "integer", minimum: 0, description: "Skip this many references (for long lists)" } },
        required: ["path", "symbol"],
        additionalProperties: false,
      },
    },
    validate: (input) => {
      const { record, ...base } = symbolArguments(input, ["offset"])
      const offset = positiveInteger(record, "offset")
      return { ...base, ...(offset ? { offset } : {}) }
    },
    execute: async (input, context) => findSymbol(provider, context.workspaceRoot, input).catch(lookupFailure),
  }
  if (!engine) return [findTool]

  const renameTool: ToolRegistration = {
    definition: {
      name: "rename_symbol",
      description: "Rename a function, variable, type, class or constant everywhere it is used, using the language service: the definition, imports, re-exports and every call site in every file, in one reviewed change. Unrelated symbols with the same name are left alone. Prefer this over apply_patch for renames.",
      action: "write_file",
      inputSchema: {
        type: "object",
        properties: { ...SYMBOL_PROPERTIES, newName: { type: "string", description: "The new identifier" } },
        required: ["path", "symbol", "newName"],
        additionalProperties: false,
      },
    },
    validate: (input) => {
      const { record, ...base } = symbolArguments(input, ["newName"])
      const newName = stringArgument(record, "newName")
      if (!IDENTIFIER.test(newName)) throw new TypeError(`newName ${newName} is not a valid identifier`)
      if (newName === base.symbol) throw new TypeError("newName must differ from symbol")
      return { ...base, newName }
    },
    execute: async () => {
      throw new MutationFailure("INVALID_PATCH", "Mutation tools require two-phase preparation and review")
    },
    prepareForReview: async (input, context) => {
      const root = await realpath(context.workspaceRoot)
      const symbol = input.symbol as string
      const newName = input.newName as string
      const resolved = await resolveSymbol(provider, root, input.path as string, symbol, input.line as number | undefined).catch(lookupFailure)
      let outcome = await provider.rename(resolved.anchor.file, resolved.anchor.position, newName)
      if (!outcome.ok) throw new MutationFailure("INVALID_PATCH", `The ${provider.name} language service refused to rename ${symbol}: ${outcome.error}. Nothing was changed.`)
      // A language server that is still loading the project (or has no project for some files) can propose a
      // partial rename. Every other file whose use of the name resolves to this definition must be covered.
      let missing = await uncoveredUses(provider, root, symbol, resolved.definition, outcome.files)
      // Reading those files opened them in the language service; give a loading project a few seconds.
      for (let attempt = 0; missing.length > 0 && attempt < COVERAGE_RETRIES; attempt += 1) {
        await new Promise((done) => setTimeout(done, COVERAGE_RETRY_MS))
        outcome = await provider.rename(resolved.anchor.file, resolved.anchor.position, newName)
        if (!outcome.ok) throw new MutationFailure("INVALID_PATCH", `The ${provider.name} language service refused to rename ${symbol}: ${outcome.error}. Nothing was changed.`)
        missing = await uncoveredUses(provider, root, symbol, resolved.definition, outcome.files)
      }
      if (missing.length > 0) {
        throw new MutationFailure("INVALID_PATCH", `The ${provider.name} language service's rename of ${symbol} does not cover ${missing.slice(0, 5).join(", ")}, which use${missing.length === 1 ? "s" : ""} or import${missing.length === 1 ? "s" : ""} the same name and could not be confirmed as covered (the language server may still be loading the project). Nothing was changed. Call rename_symbol again in a moment.`)
      }
      if (outcome.resourceOperations.length > 0) {
        throw new MutationFailure("INVALID_PATCH", `The rename of ${symbol} also needs file operations (${outcome.resourceOperations.slice(0, 3).join("; ")}), which are not supported. Nothing was changed.`)
      }
      const fileEdits = outcome.files.filter((file) => file.edits.length > 0)
      if (fileEdits.length === 0) throw new MutationFailure("INVALID_PATCH", `The language service proposed no edits for renaming ${symbol}. Nothing was changed.`)
      if (fileEdits.length > MAX_RENAME_FILES) throw new MutationFailure("BUDGET_EXCEEDED", `Renaming ${symbol} touches ${fileEdits.length} files (limit ${MAX_RENAME_FILES}). Nothing was changed.`)
      const prepared: PreparedMutation[] = []
      let editCount = 0
      let aliased = 0
      for (const file of fileEdits) {
        const path = await workspaceRelative(root, file.file)
        if (!path) throw new MutationFailure("OUTSIDE_WORKSPACE", `Renaming ${symbol} would edit ${file.file}, which is outside the workspace. Nothing was changed.`)
        editCount += file.edits.length
        aliased += file.edits.filter((edit) => edit.newText !== newName).length
        prepared.push(await engine.prepareRewrite(path, file.baseText, applyTextEdits(file.baseText, file.edits)))
      }
      prepared.sort((a, b) => a.path.localeCompare(b.path))
      const id = `rename-${prepared[0]!.id}`
      const paths = prepared.map((item) => item.path)
      let consumed = false
      return {
        id,
        reviewPayload: {
          id,
          operation: "patch",
          path: paths[0]!,
          summary: `rename ${symbol} to ${newName}: ${editCount} edits in ${paths.length} file${paths.length === 1 ? "" : "s"}`,
          files: prepared.map((item) => ({
            path: item.path,
            beforeHash: item.baseHash,
            afterHash: item.resultHash,
            linesAdded: item.diff.linesAdded,
            linesRemoved: item.diff.linesRemoved,
            beforeContent: item.beforeContent ?? "",
            proposedContent: item.proposedContent,
          })),
          beforeHash: prepared[0]!.baseHash,
          afterHash: prepared[0]!.resultHash,
          linesAdded: prepared.reduce((sum, item) => sum + item.diff.linesAdded, 0),
          linesRemoved: prepared.reduce((sum, item) => sum + item.diff.linesRemoved, 0),
          bytesChanged: prepared.reduce((sum, item) => sum + item.diff.bytesChanged, 0),
          diff: prepared.map((item) => item.diff.unified).join("\n"),
          truncated: prepared.some((item) => item.diff.truncated),
          // One reviewable document per side so the diff editor shows every affected file.
          beforeContent: prepared.map((item) => fileHeader(item.path) + (item.beforeContent ?? "")).join("\n"),
          proposedContent: prepared.map((item) => fileHeader(item.path) + item.proposedContent).join("\n"),
        },
        apply: async (): Promise<MutationResult> => {
          if (consumed) throw new MutationFailure("INVALID_PATCH", "already consumed")
          consumed = true
          // Preflight every file first: one stale file means nothing is written.
          for (const item of prepared) {
            const current = await readFile(item.resolvedPath, "utf8").catch(() => undefined)
            if (current === undefined || sha256(current) !== item.baseHash) {
              return groupFailure(id, item.path, "STALE_BASE", `${item.path} changed after the rename was prepared. Nothing was written; find_symbol and rename again.`)
            }
          }
          const applied: PreparedMutation[] = []
          for (const item of prepared) {
            const result = await engine.applyPreparedMutation(item)
            if (result.status === "APPLIED") { applied.push(item); continue }
            const restored: string[] = []
            const notRestored: string[] = []
            for (const done of applied.toReversed()) {
              const rollback = await engine.rollback(done.id).catch((error: unknown) => ({ status: "FAILED", error }))
              ;(rollback.status === "APPLIED" ? restored : notRestored).push(done.path)
            }
            const detail = notRestored.length > 0
              ? `Could NOT restore ${notRestored.join(", ")}; inspect them.`
              : restored.length > 0 ? `Restored ${restored.join(", ")}; no file is changed.` : "No file is changed."
            return groupFailure(id, item.path, result.error?.code ?? "ATOMIC_WRITE_FAILED", `Renaming ${symbol} failed while writing ${item.path} (${result.error?.message ?? result.status}). ${detail}`)
          }
          const leftovers = await otherOccurrences(root, symbol)
          const observation = [
            `Renamed ${symbol} to ${newName} with the ${provider.name} language service: ${editCount} edits in ${paths.join(", ")}.`,
            aliased > 0 ? `${aliased} import${aliased === 1 ? "" : "s"} kept the old local name through an alias.` : "",
            leftovers ? `${symbol} still appears in ${leftovers}; the language service does not link those to this symbol (comments, strings, unrelated same-named symbols, or files outside the TypeScript project), so they were left unchanged.` : "",
            "Run the typecheck and tests to verify.",
          ].filter(Boolean).join(" ")
          return { id, status: "APPLIED", path: paths[0]!, operation: "patch", observation }
        },
      }
    },
  }
  return [findTool, renameTool]
}

/** Workspace files outside a rename proposal that use `symbol` resolving to `definition` (bounded). */
async function uncoveredUses(provider: CodeIntelligenceProvider, root: string, symbol: string, definition: CodeLocation, proposal: readonly FileEdits[]): Promise<string[]> {
  const covered = new Set(await Promise.all(proposal.filter((file) => file.edits.length > 0).map((file) => workspaceRelative(root, file.file))))
  const pattern = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, "\\$")}(?![\\w$])`)
  const { results } = await searchText(root, symbol, { maxResults: 300 }).catch(() => ({ results: [] as const }))
  const candidates = [...new Set(results.filter((result) => pattern.test(result.text) && /\.[cm]?[jt]sx?$/.test(result.path)).map((result) => result.path))]
    .filter((path) => !covered.has(path))
    .slice(0, 30)
  const target = locationKey(definition)
  const missing: string[] = []
  for (const path of candidates) {
    const file = await resolveRepositoryPath(root, path, "file").catch(() => undefined)
    if (!file) continue
    const text = await provider.readText(file).catch(() => undefined)
    if (text === undefined) continue
    const lines = text.split("\n")
    for (const occurrence of identifierOccurrences(text, symbol).slice(0, 5)) {
      const definitions = await provider.definitions(file, occurrence).catch(() => [])
      if (definitions.some((item) => locationKey(item) === target)) { missing.push(path); break }
      // An import the service cannot resolve past itself (project still loading) cannot be confirmed as unrelated.
      const importLine = /^\s*(?:import|export)\b|\bfrom\s+["'][^"']+["']/.test(lines[occurrence.line] ?? "")
      const unresolved = definitions.every((item) => item.file === file && /^\s*(?:import|export)\b|\bfrom\s+["']/.test(lines[item.range.start.line] ?? ""))
      if (importLine && unresolved) { missing.push(path); break }
    }
  }
  return missing
}

/** Source files still containing the old name as a word, for a truthful (lower-confidence) coverage note. */
async function otherOccurrences(root: string, symbol: string): Promise<string> {
  const pattern = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, "\\$")}(?![\\w$])`)
  const { results } = await searchText(root, symbol, { maxResults: 200 }).catch(() => ({ results: [] as const }))
  const files = [...new Set(results.filter((result) => pattern.test(result.text) && /\.[cm]?[jt]sx?$/.test(result.path)).map((result) => result.path))]
  if (files.length === 0) return ""
  return `${files.length} file${files.length === 1 ? "" : "s"} (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""})`
}
