/**
 * Deterministic Repository Fixture Generator
 * Sprint 4D — Tasks T-6000 & T-6001
 */

import { mkdir, writeFile, symlink } from "node:fs/promises"
import { join } from "node:path"

export type FixtureScale = "SMALL" | "MEDIUM" | "LARGE"

export interface FixtureSummary {
  readonly scale: FixtureScale
  readonly rootDir: string
  readonly fileCount: number
  readonly dirCount: number
  readonly ignoredFileCount: number
  readonly binaryFileCount: number
  readonly largeFileCount: number
}

/**
 * Generate synthetic repository fixture with exact deterministic structure:
 * - src/ (TypeScript/JavaScript/Python/JSON)
 * - packages/ (monorepo subpackages)
 * - tests/
 * - docs/ (Markdown)
 * - node_modules/ (.git/dist/build/coverage) -> ignored trees
 * - large files (>128KB)
 * - binary files (.png, .bin, null bytes)
 * - symlinks (if platform allows)
 */
export async function createRepositoryFixture(
  baseDir: string,
  scale: FixtureScale,
): Promise<FixtureSummary> {
  const rootDir = join(baseDir, `repo_${scale.toLowerCase()}`)
  await mkdir(rootDir, { recursive: true })

  // Core folders
  const dirs = [
    "src/core",
    "src/utils",
    "src/api",
    "packages/pkg-a/src",
    "packages/pkg-b/src",
    "tests/unit",
    "tests/integration",
    "docs/architecture",
    "node_modules/fake-lib",
    ".git/objects",
    "dist/bundle",
    "build/temp",
    "coverage/lcov-report",
  ]

  for (const d of dirs) {
    await mkdir(join(rootDir, d), { recursive: true })
  }

  let totalFiles = 0
  let ignoredFiles = 0
  let binaryFiles = 0
  let largeFiles = 0

  // 1. Canonical Project Markdown
  await writeFile(
    join(rootDir, "PROJECT.md"),
    "# Project Definition\n\nScale: " + scale + "\nInvariant: Bounded context.\n",
    "utf8",
  )
  await writeFile(
    join(rootDir, "AGENTS.md"),
    "# Agent Rules\n\nTargeted reads only.\nNever ingest entire repo.\n",
    "utf8",
  )
  totalFiles += 2

  // 2. Standard source files
  const fileMultiplier = scale === "SMALL" ? 10 : scale === "MEDIUM" ? 500 : 2500

  for (let i = 0; i < fileMultiplier; i++) {
    // TypeScript files in src/core
    await writeFile(
      join(rootDir, "src/core", `module_${i}.ts`),
      `export function computeValue_${i}(x: number): number {\n  // target_needle_symbol_${i % 10}\n  return x * ${i};\n}\n`,
      "utf8",
    )
    totalFiles++

    // Python files in src/api
    await writeFile(
      join(rootDir, "src/api", `service_${i}.py`),
      `def run_service_${i}(payload):\n    # api_endpoint_handler\n    return {"id": ${i}}\n`,
      "utf8",
    )
    totalFiles++

    // Documentation in docs
    if (i < 50) {
      await writeFile(
        join(rootDir, "docs/architecture", `rfc_${i}.md`),
        `# RFC ${i}\n\nDetails for system subsystem ${i}.\nKey architectural invariant.\n`,
        "utf8",
      )
      totalFiles++
    }
  }

  // 3. Ignored directory contents
  for (let i = 0; i < 20; i++) {
    await writeFile(
      join(rootDir, "node_modules/fake-lib", `index_${i}.js`),
      `module.exports = { id: ${i} };\n`,
      "utf8",
    )
    await writeFile(
      join(rootDir, ".git/objects", `pack_${i}.idx`),
      `git object dummy ${i}\n`,
      "utf8",
    )
    await writeFile(
      join(rootDir, "dist/bundle", `bundle_${i}.min.js`),
      `/* minified dist */ var x = ${i};\n`,
      "utf8",
    )
    ignoredFiles += 3
  }

  // 4. Large file (>128KB, e.g. 250KB)
  const largeContent = "line " + "x".repeat(100) + "\n"
  const largePayload = largeContent.repeat(2500) // ~250KB
  await writeFile(join(rootDir, "src/utils", "huge_dataset.txt"), largePayload, "utf8")
  totalFiles++
  largeFiles++

  // 5. Binary file
  const binBuffer = Buffer.alloc(1024)
  binBuffer.fill(0) // Null bytes
  await writeFile(join(rootDir, "src/utils", "binary_asset.bin"), binBuffer)
  await writeFile(join(rootDir, "src/utils", "icon.png"), binBuffer)
  totalFiles += 2
  binaryFiles += 2

  // 6. Safe symlink where platform allows
  try {
    await symlink(
      join(rootDir, "src/core/module_0.ts"),
      join(rootDir, "src/utils/module_0_alias.ts"),
    )
  } catch {
    // Ignore symlink creation failure on non-supported platforms
  }

  return {
    scale,
    rootDir,
    fileCount: totalFiles,
    dirCount: dirs.length,
    ignoredFileCount: ignoredFiles,
    binaryFileCount: binaryFiles,
    largeFileCount: largeFiles,
  }
}
