import { readdir, readFile, stat } from "node:fs/promises"
import * as path from "node:path"

/**
 * Deterministic diagnosis for unresolved-symbol test failures (cross-file renames, moves, missing exports).
 *
 * When a verification run fails because a name cannot be imported or resolved, the model otherwise has to
 * guess which other files still use the old name. This scans the workspace once and reports, for each
 * unresolved name: every remaining reference (file:line and text), where the name is defined or exported,
 * and what the named module actually exports. Read-only; bounded in files, bytes and output.
 */

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", "__pycache__", ".venv", "venv", ".open-vs-code", ".next"])
const MAX_FILES = 2_000
const MAX_FILE_BYTES = 200_000
const MAX_SYMBOLS = 3
const MAX_REFERENCES = 10
const MAX_REPORT_CHARS = 2_400

interface UnresolvedSymbol {
  readonly name: string
  /** Module specifier or path the failure names, when it names one. */
  readonly module?: string
}

const PATTERNS: ReadonlyArray<{ readonly regex: RegExp; readonly name: number; readonly module?: number }> = [
  // Node ESM: The requested module './totals.ts' does not provide an export named 'calcTotal'
  { regex: /requested module '([^']+)' does not provide an export named '([\w$]+)'/g, module: 1, name: 2 },
  { regex: /ReferenceError: ([\w$]+) is not defined/g, name: 1 },
  { regex: /'([\w$]+) is not defined'/g, name: 1 },
  { regex: /Cannot find name '([\w$]+)'/g, name: 1 },
  { regex: /Module '"([^"]+)"' has no exported member '([\w$]+)'/g, module: 1, name: 2 },
  { regex: /TypeError: (?:\(0 , [\w$.]+\.)?([\w$]+)\)? is not a function/g, name: 1 },
  // Python
  { regex: /cannot import name '(\w+)' from '([\w.]+)'/g, name: 1, module: 2 },
  { regex: /NameError: name '(\w+)' is not defined/g, name: 1 },
  { regex: /AttributeError: module '([\w.]+)' has no attribute '(\w+)'/g, module: 1, name: 2 },
]

export function unresolvedSymbols(output: string): UnresolvedSymbol[] {
  const found = new Map<string, UnresolvedSymbol>()
  for (const pattern of PATTERNS) {
    for (const match of output.matchAll(pattern.regex)) {
      const name = match[pattern.name]
      if (!name || found.has(name) || found.size >= MAX_SYMBOLS) continue
      const module = pattern.module !== undefined ? match[pattern.module] : undefined
      found.set(name, module ? { name, module } : { name })
    }
  }
  return [...found.values()]
}

export async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || files.length >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(full, depth + 1)
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        files.push(full)
      }
    }
  }
  await walk(root, 0)
  return files.toSorted()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const DEFINITION = (name: string) => new RegExp(
  `(?:^|\\s)(?:export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${escapeRegExp(name)}\\b`
  + `|^\\s*(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${escapeRegExp(name)}\\b`
  + `|^\\s*(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(|^\\s*class\\s+${escapeRegExp(name)}\\b|^${escapeRegExp(name)}\\s*=)`,
)

/** Names a JS/TS or Python module exports at top level, best effort. */
function exportedNames(content: string, python: boolean): string[] {
  const names = new Set<string>()
  if (python) {
    for (const match of content.matchAll(/^(?:async\s+)?def\s+(\w+)|^class\s+(\w+)|^(\w+)\s*=/gm)) {
      const name = match[1] ?? match[2] ?? match[3]
      if (name && !name.startsWith("_")) names.add(name)
    }
  } else {
    for (const match of content.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([\w$]+)/g)) {
      if (match[1]) names.add(match[1])
    }
    for (const match of content.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of (match[1] ?? "").split(",")) {
        const alias = part.trim().split(/\s+as\s+/).at(-1)?.trim()
        if (alias) names.add(alias)
      }
    }
  }
  return [...names].slice(0, 12)
}

function moduleMatches(relativeFile: string, module: string): boolean {
  const file = relativeFile.replace(/\\/g, "/")
  const withoutExt = file.replace(/\.[^.]+$/, "")
  if (module.includes("/") || module.startsWith(".")) {
    const target = module.replace(/^(?:\.\.?\/)+/, "").replace(/\.[^./]+$/, "")
    return withoutExt.endsWith(target)
  }
  // Python dotted module: src.models -> src/models.py
  return withoutExt === module.replace(/\./g, "/") || withoutExt.endsWith(`/${module.replace(/\./g, "/")}`)
}

export async function diagnoseUnresolvedSymbols(workspaceRoot: string, output: string): Promise<string | undefined> {
  const symbols = unresolvedSymbols(output)
  if (symbols.length === 0) return undefined
  const files = await collectSourceFiles(workspaceRoot)
  const contents = new Map<string, string>()
  for (const file of files) {
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) continue
      contents.set(file, await readFile(file, "utf8"))
    } catch {
      // unreadable files are skipped
    }
  }
  const sections: string[] = []
  for (const symbol of symbols) {
    const word = new RegExp(`(?<![\\w$])${escapeRegExp(symbol.name)}(?![\\w$])`)
    const definition = DEFINITION(symbol.name)
    const references: string[] = []
    const definitions: string[] = []
    let moduleExports: string | undefined
    for (const [file, content] of contents) {
      const rel = path.relative(workspaceRoot, file).replace(/\\/g, "/")
      if (symbol.module && !moduleExports && moduleMatches(rel, symbol.module)) {
        const names = exportedNames(content, file.endsWith(".py"))
        moduleExports = `${rel} exports: ${names.length > 0 ? names.join(", ") : "(nothing recognizable)"}`
      }
      const lines = content.split("\n")
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!
        if (!word.test(line)) continue
        const entry = `${rel}:${index + 1}: ${line.trim().slice(0, 140)}`
        if (definition.test(line)) definitions.push(entry)
        else if (references.length < MAX_REFERENCES) references.push(entry)
      }
    }
    const parts = [`\`${symbol.name}\`${symbol.module ? ` (from ${symbol.module})` : ""}:`]
    if (moduleExports) parts.push(`- ${moduleExports}`)
    parts.push(definitions.length > 0 ? `- defined at: ${definitions.slice(0, 4).join(" | ")}` : "- not defined or exported anywhere in the workspace")
    parts.push(references.length > 0 ? `- still referenced at:\n${references.map((entry) => `    ${entry}`).join("\n")}` : "- no other references")
    sections.push(parts.join("\n"))
  }
  const report = `Unresolved names in the failing run. Update every listed reference (or restore the definition) so all files agree, then run the tests again.\n${sections.join("\n")}`
  return report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n[diagnosis truncated]` : report
}
