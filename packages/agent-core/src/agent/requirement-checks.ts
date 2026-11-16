import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { collectSourceFiles } from "../tools/symbol-diagnosis.ts"

/**
 * Deterministic checks that explicit, general request language was carried out before a coding task may
 * complete. Dogfooding showed the model declaring success after doing half of a request: a rename never
 * performed, a helper imported but never called, requested tests never written. Tests and typecheck cannot
 * see an instruction that was ignored, so these checks look at the workspace directly:
 *
 * - "rename X to Y": no exported definition or import of X remains, and Y exists.
 * - "add/write (unit) tests": some applied edit touched a test file.
 * - an identifier the request names that an edited file imports but never uses.
 *
 * Only exported definitions and imports count for renames, so unrelated local helpers that share a name are
 * never flagged. Returns at most four short, actionable lines.
 */
export async function requirementGaps(input: {
  readonly workspaceRoot: string
  readonly instruction: string
  readonly appliedPaths: readonly string[]
  readonly isTestPath: (path: string) => boolean
}): Promise<string[]> {
  const gaps: string[] = []
  const instruction = input.instruction
  const renames = [...instruction.matchAll(/\brename\s+`?([A-Za-z_$][\w$]*)`?\s+(?:to|as|into)\s+`?([A-Za-z_$][\w$]*)`?/gi)]
    .map((match) => ({ from: match[1]!, to: match[2]! }))
    .filter((pair) => pair.from !== pair.to)
  if (renames.length > 0) {
    const contents = await readSources(input.workspaceRoot)
    for (const { from, to } of renames.slice(0, 2)) {
      const exported = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${escape(from)}\\b|\\bexport\\s*\\{[^}]*\\b${escape(from)}\\b[^}]*\\}|^\\s*(?:async\\s+)?def\\s+${escape(from)}\\s*\\(`, "m")
      const imported = new RegExp(`\\bimport\\s*(?:type\\s*)?\\{[^}]*\\b${escape(from)}\\b[^}]*\\}\\s*from|^\\s*from\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${escape(from)}\\b`, "m")
      const leftovers: string[] = []
      let newExists = false
      for (const [rel, content] of contents) {
        if (new RegExp(`(?<![\\w$])${escape(to)}(?![\\w$])`).test(content)) newExists = true
        if (exported.test(content) || imported.test(content)) {
          const line = content.split("\n").findIndex((text) => exported.test(text) || imported.test(text))
          leftovers.push(`${rel}:${line + 1}`)
        }
      }
      if (leftovers.length > 0) gaps.push(`The rename of ${from} to ${to} is not done: ${from} is still exported or imported at ${leftovers.slice(0, 4).join(", ")}. Rename it there too.`)
      else if (!newExists) gaps.push(`The rename of ${from} to ${to} is not done: ${to} does not exist anywhere in the workspace.`)
    }
  }
  if (/\b(?:add|write|create|include)\s+(?:(?:a|an|some|new|the|more)\s+)?(?:unit\s+|regression\s+)?tests?\b/i.test(instruction)
    && !input.appliedPaths.some((applied) => input.isTestPath(applied))) {
    gaps.push("The request asks for tests, but no test file was added or changed. Add the tests.")
  }
  const named = new Set([...instruction.matchAll(/\b([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((match) => match[1]!))
  for (const applied of [...new Set(input.appliedPaths)].slice(0, 8)) {
    const content = await safeRead(path.join(input.workspaceRoot, applied))
    if (!content) continue
    for (const name of named) {
      const importLine = new RegExp(`\\bimport\\s*(?:type\\s*)?\\{[^}]*\\b${escape(name)}\\b[^}]*\\}|^\\s*from\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${escape(name)}\\b`, "m")
      if (!importLine.test(content)) continue
      const uses = content.match(new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`, "g"))?.length ?? 0
      if (uses <= 1) gaps.push(`${name} is imported in ${applied} but never used there. Use it where the request asks.`)
    }
  }
  return gaps.slice(0, 4)
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function safeRead(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > 200_000) return undefined
    return await readFile(file, "utf8")
  } catch {
    return undefined
  }
}

async function readSources(root: string): Promise<Map<string, string>> {
  const contents = new Map<string, string>()
  for (const file of await collectSourceFiles(root)) {
    const content = await safeRead(file)
    if (content !== undefined) contents.set(path.relative(root, file).replace(/\\/g, "/"), content)
  }
  return contents
}
