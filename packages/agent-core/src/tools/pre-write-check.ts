import ts from "typescript"

/** Errors that make a file invalid on its own (no module resolution needed): duplicate declarations and await outside async. */
const SELF_CONTAINED = new Set([2300, 2393, 2451, 2528, 2440, 1308]) // 1308: await inside a function that is not async

/**
 * Problems in proposed JS/TS content that can be seen from the file alone: syntax errors and duplicate
 * declarations. Checked before approval so a broken edit is never offered to the user or left unnoticed when
 * the project's tests cannot run. Imports and types are not resolved, so this never reports environment gaps.
 */
export function proposedContentProblems(path: string, content: string): string[] {
  if (!/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(path)) return []
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, allowJs: true, checkJs: true, noEmit: true, types: [], skipLibCheck: true }
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

const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:__tests__|tests?)\/[^/]+\.[cm]?[jt]sx?$)/i
const TEST_FRAMEWORK_OR_BUILTIN = /^(?:vitest|jest|@jest\/.*|@vitest\/.*|chai|mocha|sinon|@testing-library\/.*|node:.*|fs|path|url|os|assert|crypto|child_process|util|events|stream|buffer)$/

/**
 * A JS/TS test file that asserts but imports nothing from the project (only a test framework and Node built-ins)
 * checks values it defines itself, so it cannot fail when the project is wrong. Black-box tests that start a
 * process or call over the network are left alone.
 */
export function testExercisesNoProjectCode(path: string, content: string): string | undefined {
  if (!TEST_FILE.test(path)) return undefined
  if (!/\b(?:expect|assert)\b/.test(content)) return undefined
  if (/\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|fork|fetch)\s*\(|supertest|playwright/i.test(content)) return undefined
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]!) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifiers.push((node.arguments[0] as ts.StringLiteralLike).text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers.some((specifier) => !TEST_FRAMEWORK_OR_BUILTIN.test(specifier)) ? undefined
    : "this test file imports nothing from the project, so its assertions only check values defined in the test and it cannot fail when the project is wrong"
}
