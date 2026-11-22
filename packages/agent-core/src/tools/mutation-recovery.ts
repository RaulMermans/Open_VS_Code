import { dirname, extname, join, relative } from "node:path"
import { readFile, realpath } from "node:fs/promises"
import { MutationFailure } from "./mutation-contracts.ts"
import { resolveWritePath } from "./mutation-engine.ts"
import { pathsReferToSameFile } from "../agent/tool-contract.ts"

export type MutationTargetState =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "existing"; readonly path: string; readonly resolvedPath: string; readonly content: string }
  | { readonly kind: "blocked"; readonly path: string; readonly code: string; readonly message: string }

export async function inspectMutationTarget(workspaceRoot: string, requestedPath: string): Promise<MutationTargetState> {
  let root: string
  try {
    root = await realpath(workspaceRoot)
  } catch (error) {
    return {
      kind: "blocked",
      path: requestedPath,
      code: "OUTSIDE_WORKSPACE",
      message: error instanceof Error ? error.message : "workspace unreadable",
    }
  }
  try {
    const resolvedPath = await resolveWritePath(root, requestedPath, { mustExist: true })
    const content = await readFile(resolvedPath, "utf8")
    return {
      kind: "existing",
      path: relative(root, resolvedPath).replaceAll("\\", "/"),
      resolvedPath,
      content,
    }
  } catch (error) {
    if (error instanceof MutationFailure) {
      if (error.code === "FILE_NOT_FOUND") return { kind: "missing", path: requestedPath }
      return { kind: "blocked", path: requestedPath, code: error.code, message: error.message }
    }
    return {
      kind: "blocked",
      path: requestedPath,
      code: "PATH_ESCAPE",
      message: error instanceof Error ? error.message : "path could not be resolved",
    }
  }
}

export async function classifyNamedEditTargets(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<{ existing: string[]; missing: string[] }> {
  const existing: string[] = []
  const missing: string[] = []
  for (const path of paths) {
    const state = await inspectMutationTarget(workspaceRoot, path)
    if (state.kind === "existing") existing.push(state.path)
    else if (state.kind === "missing") missing.push(path)
  }
  return { existing, missing }
}

const EXPORT_FUNCTION = /^export (?:async )?function ([A-Za-z_$][\w$]*)/gm
const PYTHON_DEF = /^def ([A-Za-z_][\w]*)\s*\(/gm

export function declaredTopLevelFunctions(source: string): readonly string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(EXPORT_FUNCTION)) {
    if (match[1]) names.add(match[1])
  }
  for (const match of source.matchAll(PYTHON_DEF)) {
    if (match[1]) names.add(match[1])
  }
  return [...names]
}

function fileStem(path: string): string {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path
  return base.replace(/\.[^.]+$/, "")
}

function firstToken(name: string): string {
  const snake = name.split("_")[0] ?? name
  const camel = snake.match(/^([a-z]+|[A-Z][a-z]+|[A-Z]+)/)
  return (camel?.[1] ?? snake).toLowerCase()
}

function functionBelongsToFile(fn: string, path: string): boolean {
  const stem = fileStem(path)
  const stemKey = stem.replace(/[-_]/g, "").toLowerCase()
  const exported = fn.replace(/[-_]/g, "").toLowerCase()
  if (exported === stemKey) return true
  return firstToken(fn) === firstToken(stem)
}

function siblingForFunction(targetPath: string, fn: string): string {
  const normalized = targetPath.replaceAll("\\", "/")
  const directory = dirname(normalized)
  const extension = extname(normalized)
  const sibling = `${firstToken(fn)}${extension}`
  return directory === "." ? sibling : join(directory, sibling).replaceAll("\\", "/")
}

export function candidateOwnerPaths(targetPath: string, before: string, after: string): string[] {
  const previous = new Set(declaredTopLevelFunctions(before))
  const added = declaredTopLevelFunctions(after).filter((name) => !previous.has(name))
  return added.map((name) => siblingForFunction(targetPath, name))
}

export function misplacedExportPath(
  targetPath: string,
  before: string,
  after: string,
  knownExistingPaths: readonly string[],
): string | undefined {
  const previous = new Set(declaredTopLevelFunctions(before))
  const added = declaredTopLevelFunctions(after).filter((name) => !previous.has(name))
  for (const name of added) {
    const sibling = siblingForFunction(targetPath, name)
    for (const candidate of knownExistingPaths) {
      if (pathsReferToSameFile(candidate, targetPath)) continue
      if (functionBelongsToFile(name, candidate) || pathsReferToSameFile(candidate, sibling)) {
        return candidate.replaceAll("\\", "/")
      }
    }
  }
  return undefined
}

export function editingStrategyGuidance(input: {
  readonly existingNamed: readonly string[]
  readonly missingNamed: readonly string[]
  readonly observedExisting: readonly string[]
  readonly completed: readonly string[]
  readonly pending: readonly string[]
}): string {
  const lines: string[] = []
  const existing = uniquePaths([...input.existingNamed, ...input.observedExisting])
  if (existing.length > 0) {
    lines.push(`Existing files must be edited with apply_patch only, never create_file: ${existing.join(", ")}.`)
  }
  if (input.missingNamed.length > 0) {
    lines.push(`Missing files may use create_file: ${input.missingNamed.join(", ")}.`)
  }
  if (input.completed.length > 0) {
    lines.push(`Completed file operations: ${input.completed.join(", ")}.`)
  }
  if (input.pending.length > 0) {
    lines.push(`Pending file operations: ${input.pending.join(", ")}. Patch only the intended path.`)
  }
  return lines.join(" ")
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "")
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    ordered.push(normalized)
  }
  return ordered
}
