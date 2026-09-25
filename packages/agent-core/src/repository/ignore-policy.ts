/**
 * Ignore Policy
 * Sprint 4D — Large Repository Performance Hardening
 */

export const CANONICAL_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".output",
  ".venv",
  "__pycache__",
  "vendor",
  ".checkpoints",
]

export const BINARY_EXTENSIONS = new Set<string>([
  ".bin",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".pyc",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wasm",
  ".iso",
  ".dmg",
])

export const LARGE_FILE_THRESHOLD_BYTES = 128 * 1024 // 128 KB

export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase())
}

export function isBinaryBuffer(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192))
  return sample.includes(0)
}
