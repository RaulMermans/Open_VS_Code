/**
 * Headless CodeIntelligenceProvider over the TypeScript LanguageService (the engine behind VS Code's
 * TypeScript features). Used by integration tests and the live evaluation harness. Node-only and
 * deliberately not exported from the package index, so the extension bundle never includes TypeScript;
 * the IDE uses VS Code's own providers instead (vscode-integration/src/code-intelligence-provider.ts).
 *
 * Project selection: the nearest tsconfig.json between the file and the workspace root; without one,
 * every JS/TS file in the workspace (node_modules and build output excluded).
 * shortcut: one project per tsconfig, so references in a sibling project with its own tsconfig are not
 * seen; upgrade to tsserver-style multi-project search if multi-project monorepos need it.
 */
import { existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import type { CodeIntelligenceProvider, CodeLocation, CodePosition, FileEdits, RenameOutcome } from "./code-intelligence.ts"

interface Project { readonly service: ts.LanguageService; readonly fileNames: string[] }

export class TypeScriptCodeIntelligence implements CodeIntelligenceProvider {
  readonly name = "typescript"
  readonly #root: string
  readonly #projects = new Map<string, Project>()
  readonly #registry = ts.createDocumentRegistry()

  constructor(workspaceRoot: string) {
    this.#root = resolve(workspaceRoot)
  }

  #project(file: string): Project {
    let configPath: string | undefined
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (existsSync(join(dir, "tsconfig.json"))) { configPath = join(dir, "tsconfig.json"); break }
      if (dir === this.#root || dirname(dir) === dir || !dir.startsWith(this.#root)) break
    }
    const key = configPath ?? this.#root
    let project = this.#projects.get(key)
    if (!project) {
      let options: ts.CompilerOptions
      let fileNames: string[]
      if (configPath) {
        const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
        options = parsed?.options ?? {}
        fileNames = parsed?.fileNames ?? []
      } else {
        options = {
          allowJs: true, noEmit: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.Preserve,
          module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
        }
        fileNames = ts.sys.readDirectory(this.#root, [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], ["**/node_modules", "**/dist", "**/build", "**/.git"])
      }
      const currentDirectory = configPath ? dirname(configPath) : this.#root
      const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => fileNames,
        getScriptVersion: (name) => {
          try { return String(statSync(name, { bigint: true }).mtimeNs) } catch { return "0" }
        },
        getScriptSnapshot: (name) => {
          const text = ts.sys.readFile(name)
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
        },
        getCurrentDirectory: () => currentDirectory,
        getCompilationSettings: () => options,
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
      }
      project = { service: ts.createLanguageService(host, this.#registry), fileNames }
      this.#projects.set(key, project)
    }
    if (!project.fileNames.includes(file)) project.fileNames.push(file)
    return project
  }

  /** undefined when TypeScript cannot load the file (not JS/TS): the caller reports "no result". */
  #offset(service: ts.LanguageService, file: string, position: CodePosition): number | undefined {
    return service.getProgram()?.getSourceFile(file)?.getPositionOfLineAndCharacter(position.line, position.character)
  }

  #location(service: ts.LanguageService, fileName: string, span: ts.TextSpan): CodeLocation | undefined {
    const source = service.getProgram()?.getSourceFile(fileName)
    if (!source) return undefined
    const start = source.getLineAndCharacterOfPosition(span.start)
    const end = source.getLineAndCharacterOfPosition(span.start + span.length)
    return { file: fileName, range: { start, end } }
  }

  async readText(file: string): Promise<string> {
    const text = ts.sys.readFile(file)
    if (text === undefined) throw new Error(`Cannot read ${file}`)
    return text
  }

  async definitions(file: string, position: CodePosition): Promise<readonly CodeLocation[]> {
    const { service } = this.#project(file)
    const offset = this.#offset(service, file, position)
    const found = offset === undefined ? [] : service.getDefinitionAtPosition(file, offset) ?? []
    return found.map((item) => this.#location(service, item.fileName, item.textSpan)).filter((item): item is CodeLocation => item !== undefined)
  }

  async references(file: string, position: CodePosition): Promise<readonly CodeLocation[]> {
    const { service } = this.#project(file)
    const offset = this.#offset(service, file, position)
    const found = offset === undefined ? [] : service.getReferencesAtPosition(file, offset) ?? []
    return found.map((item) => this.#location(service, item.fileName, item.textSpan)).filter((item): item is CodeLocation => item !== undefined)
  }

  async symbolKind(file: string, position: CodePosition): Promise<string | undefined> {
    const { service } = this.#project(file)
    const offset = this.#offset(service, file, position)
    return offset === undefined ? undefined : service.getQuickInfoAtPosition(file, offset)?.kind
  }

  async rename(file: string, position: CodePosition, newName: string): Promise<RenameOutcome> {
    const { service } = this.#project(file)
    const offset = this.#offset(service, file, position)
    if (offset === undefined) return { ok: false, error: "TypeScript cannot analyze this file" }
    const info = service.getRenameInfo(file, offset, { allowRenameOfImportPath: false })
    if (!info.canRename) return { ok: false, error: info.localizedErrorMessage }
    const locations = service.findRenameLocations(file, offset, false, false, { providePrefixAndSuffixTextForRename: false }) ?? []
    const byFile = new Map<string, FileEdits>()
    for (const location of locations) {
      const range = this.#location(service, location.fileName, location.textSpan)
      if (!range) return { ok: false, error: `no source for ${location.fileName}` }
      const entry = byFile.get(location.fileName) ?? { file: location.fileName, baseText: await this.readText(location.fileName), edits: [] }
      byFile.set(location.fileName, { ...entry, edits: [...entry.edits, { range: range.range, newText: `${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}` }] })
    }
    return { ok: true, files: [...byFile.values()], resourceOperations: [] }
  }
}
