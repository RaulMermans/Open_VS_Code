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
