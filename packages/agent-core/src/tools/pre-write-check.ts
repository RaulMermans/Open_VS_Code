import ts from "typescript"

/** Binder errors that make a file invalid on its own (no module resolution needed): duplicate declarations. */
const SELF_CONTAINED = new Set([2300, 2393, 2451, 2528, 2440])

/**
 * Problems in proposed JS/TS content that can be seen from the file alone: syntax errors and duplicate
 * declarations. Checked before approval so a broken edit is never offered to the user or left unnoticed when
 * the project's tests cannot run. Imports and types are not resolved, so this never reports environment gaps.
 */
export function proposedContentProblems(path: string, content: string): string[] {
  if (!/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(path)) return []
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true, checkJs: false, noEmit: true, types: [], skipLibCheck: true }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, ...rest) => name === "/proposed/" + path.split("/").pop()
    ? ts.createSourceFile(name, content, languageVersion, true)
    : original(name, languageVersion, ...rest)
  const fileName = "/proposed/" + path.split("/").pop()
  const program = ts.createProgram([fileName], options, host)
  const file = program.getSourceFile(fileName)
  if (!file) return []
  const found = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file).filter((d) => SELF_CONTAINED.has(d.code))]
  return found.slice(0, 3).map((d) => {
    const line = d.start === undefined ? 0 : file.getLineAndCharacterOfPosition(d.start).line + 1
    return `line ${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`
  })
}

/**
 * True when an exported type alias, interface or enum was added or changed. Such an edit can break files that
 * use the type (a missing member of a `Record<Union, …>`, a switch that no longer covers every case), which only
 * a project typecheck reveals, so the runner checks early instead of at completion.
 */
export function exportedTypeShapeChanged(path: string, before: string, after: string): boolean {
  if (!/\.(?:tsx?|mts|cts)$/i.test(path)) return false
  const shapes = (text: string): Map<string, string> => {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false)
    const found = new Map<string, string>()
    for (const node of file.statements) {
      if (!(ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node))) continue
      if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      found.set(node.name.text, node.getText(file))
    }
    return found
  }
  const next = shapes(after)
  const previous = shapes(before)
  return [...next].some(([name, text]) => previous.get(name) !== text)
}
