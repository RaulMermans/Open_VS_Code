import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".open-vs-code", "coverage", ".next", ".venv"])
const REFERENCE_KEY = /^[a-z][A-Za-z]*(?:Id|Ref)$|^[a-z]+_id$/
const IDENTIFIER = /^[A-Za-z0-9][\w.:/-]{2,79}$/
const MAX_FILES = 300
const MAX_BYTES = 200_000

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); return }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { visit(key, child); walk(child, visit) }
}

function referencesIn(content: string): Map<string, string> {
  const found = new Map<string, string>()
  try {
    walk(JSON.parse(content), (key, value) => { if (typeof value === "string" && REFERENCE_KEY.test(key) && IDENTIFIER.test(value)) found.set(value, key) })
  } catch { /* not JSON: nothing to check */ }
  return found
}

async function definedIds(root: string): Promise<Map<string, string[]>> {
  const ids = new Map<string, string[]>()
  let scanned = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (scanned >= MAX_FILES) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await visit(path); continue }
      if (!entry.name.endsWith(".json") || /package(?:-lock)?\.json$|tsconfig/.test(entry.name)) continue
      const info = await stat(path).catch(() => undefined)
      if (!info || info.size > MAX_BYTES) continue
      scanned += 1
      try {
        walk(JSON.parse(await readFile(path, "utf8")), (key, value) => {
          if (key === "id" && typeof value === "string") ids.set(value, [...(ids.get(value) ?? []), relative(root, path)])
        })
      } catch { /* skip unparsable files */ }
    }
  }
  await visit(root)
  return ids
}

/**
 * References (`modelId`, `providerId`, `foo_id`, `fooRef`) that an edit to a JSON file adds or changes and that
 * no JSON file in the workspace defines as an `id`. Pre-existing dangling references are not reported, and ids
 * the edit itself defines count as defined.
 */
export async function danglingReferences(root: string, path: string, before: string, after: string): Promise<{ key: string; value: string; known: string[] }[]> {
  if (!path.toLowerCase().endsWith(".json")) return []
  const added = referencesIn(after)
  const previous = referencesIn(before)
  const candidates = [...added].filter(([value]) => !previous.has(value))
  if (candidates.length === 0) return []
  const defined = await definedIds(root)
  const own = new Set<string>()
  try { walk(JSON.parse(after), (key, value) => { if (key === "id" && typeof value === "string") own.add(value) }) } catch { return [] }
  return candidates.filter(([value]) => !defined.has(value) && !own.has(value)).map(([value, key]) => ({ key, value, known: [...defined.keys()].slice(0, 8) }))
}
