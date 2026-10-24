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
  let candidate = resolve(root, requestedPath)
  // An absolute path spelled through the workspace's own symlinked location
  // (e.g. macOS /var -> /private/var, or a symlinked project folder) is re-rooted
  // onto the canonical root. The realpath containment check below stays the authority.
  const lexicalRoot = resolve(workspaceRoot)
  if (!isContained(root, candidate) && isAbsolute(requestedPath) && lexicalRoot !== root && isContained(lexicalRoot, candidate)) {
    candidate = resolve(root, relative(lexicalRoot, candidate))
  }
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
