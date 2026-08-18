import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

export type RepositoryPathErrorCode = "OUTSIDE_WORKSPACE" | "NOT_FOUND" | "NOT_A_FILE" | "NOT_A_DIRECTORY"

export class RepositoryPathError extends Error {
  readonly code: RepositoryPathErrorCode

  constructor(code: RepositoryPathErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "RepositoryPathError"
    this.code = code
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
}

export async function resolveRepositoryPath(
  workspaceRoot: string,
  requestedPath: string,
  expectedType?: "file" | "directory",
): Promise<string> {
  const root = await realpath(workspaceRoot)
  const candidate = resolve(root, requestedPath)
  if (!isContained(root, candidate)) throw new RepositoryPathError("OUTSIDE_WORKSPACE", `Path is outside workspace: ${requestedPath}`)

  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch (error) {
    throw new RepositoryPathError("NOT_FOUND", `Repository path does not exist: ${requestedPath}`, { cause: error })
  }
  if (!isContained(root, resolved)) throw new RepositoryPathError("OUTSIDE_WORKSPACE", `Resolved path is outside workspace: ${requestedPath}`)

  if (expectedType) {
    const details = await stat(resolved)
    if (expectedType === "file" && !details.isFile()) throw new RepositoryPathError("NOT_A_FILE", `Repository path is not a file: ${requestedPath}`)
    if (expectedType === "directory" && !details.isDirectory()) throw new RepositoryPathError("NOT_A_DIRECTORY", `Repository path is not a directory: ${requestedPath}`)
  }
  return resolved
}
