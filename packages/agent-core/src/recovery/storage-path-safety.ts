/**
 * Storage Path Safety
 * Sprint 4C — Enforce safe workspace root containment and symlink escape prevention
 */

import { realpath, lstat } from "node:fs/promises"
import { resolve, relative, isAbsolute, join, basename } from "node:path"

export class StoragePathSafetyError extends Error {
  readonly code: "OUTSIDE_ROOT" | "SYMLINK_ESCAPE" | "INVALID_PATH"

  constructor(code: "OUTSIDE_ROOT" | "SYMLINK_ESCAPE" | "INVALID_PATH", message: string) {
    super(message)
    this.name = "StoragePathSafetyError"
    this.code = code
  }
}

export function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export async function canonicalizeExistingPath(p: string): Promise<string> {
  const abs = resolve(p)
  let existing = abs
  const suffixParts: string[] = []
  while (true) {
    try {
      const real = await realpath(existing)
      return suffixParts.length > 0 ? join(real, ...suffixParts) : real
    } catch {
      const parent = resolve(existing, "..")
      if (parent === existing) {
        return abs
      }
      suffixParts.unshift(basename(existing))
      existing = parent
    }
  }
}

export async function assertSafeStoragePath(allowedRoot: string, targetPath: string): Promise<string> {
  const realRoot = await canonicalizeExistingPath(allowedRoot)

  // targetPath can be relative to allowedRoot, or already absolute
  const candidateAbs = isAbsolute(targetPath)
    ? targetPath
    : resolve(realRoot, targetPath)

  const candidateForCheck = await canonicalizeExistingPath(candidateAbs)

  if (!isContained(realRoot, candidateForCheck)) {
    throw new StoragePathSafetyError("OUTSIDE_ROOT", `Target path escapes allowed storage root: ${targetPath}`)
  }

  // Check if candidate or any existing component is a symlink pointing outside
  try {
    const stats = await lstat(candidateAbs)
    if (stats.isSymbolicLink()) {
      const realTarget = await realpath(candidateAbs)
      if (!isContained(realRoot, realTarget)) {
        throw new StoragePathSafetyError("SYMLINK_ESCAPE", `Symlink escapes allowed root: ${candidateAbs} -> ${realTarget}`)
      }
    }
  } catch {
    // If target doesn't exist yet, check its existing parent
    let curr = candidateAbs
    while (curr !== realRoot && curr !== "/" && curr !== ".") {
      curr = resolve(curr, "..")
      try {
        const stats = await lstat(curr)
        if (stats.isSymbolicLink()) {
          const realParent = await realpath(curr)
          if (!isContained(realRoot, realParent)) {
            throw new StoragePathSafetyError("SYMLINK_ESCAPE", `Parent directory symlink escapes allowed root: ${curr} -> ${realParent}`)
          }
        }
      } catch {
        // continue checking upwards
      }
    }
  }

  return candidateAbs
}
