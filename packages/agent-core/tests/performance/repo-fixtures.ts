/**
 * Deterministic Repository Fixture Generator with Real 25,000+ Scale
 * Sprint 4D.1 — Tasks T-6102, T-6103, T-6104
 */

import { mkdir, writeFile, symlink } from "node:fs/promises"
import { join } from "node:path"

export type FixtureScale = "SMALL" | "MEDIUM" | "LARGE"

export interface FixtureSummary {
  readonly scale: FixtureScale
  readonly rootDir: string
  readonly fileCount: number
  readonly dirCount: number
  readonly indexableFileCount: number
  readonly ignoredFileCount: number
  readonly binaryFileCount: number
  readonly largeFileCount: number
}

/**
 * Generate synthetic repository fixture with exact deterministic structure:
 * - SMALL: ~100 indexable files
 * - MEDIUM: ~5,000 indexable files
 * - LARGE: >= 25,000 indexable files (strictly source/docs, excluding ignored trees)
 * - Separate ignored trees (node_modules, .git, dist, build, coverage)
 * - Large file (>128KB)
 * - Binary assets
 * - Symlinks where supported
 */
export async function createRepositoryFixture(
  baseDir: string,
  scale: FixtureScale,
): Promise<FixtureSummary> {
  const rootDir = join(baseDir, `repo_${scale.toLowerCase()}`)
  await mkdir(rootDir, { recursive: true })

  let totalFiles = 0
  let indexableFiles = 0
  let ignoredFiles = 0
  let binaryFiles = 0
  let largeFiles = 0
  let dirCount = 0

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
  indexableFiles += 2

  // 2. Standard base directories
  const baseDirs = [
    "src/core",
    "src/api",
    "src/utils",
    "docs/architecture",
  ]
  for (const d of baseDirs) {
    await mkdir(join(rootDir, d), { recursive: true })
    dirCount++
  }

  // Determine file generation parameters by scale
  // SMALL: 48 TS + 48 Py + 4 MD = 100 files
  // MEDIUM: 10 directories * 500 TS = 5,000 files
  // LARGE: 50 directories * 500 TS = 25,000 files
  if (scale === "SMALL") {
    const promises: Promise<void>[] = []
    for (let i = 0; i < 48; i++) {
      promises.push(
        writeFile(
          join(rootDir, "src/core", `module_${i}.ts`),
          `export function computeValue_${i}(x: number): number {\n  // target_needle_symbol_${i % 10}\n  return x * ${i};\n}\n`,
          "utf8",
        ),
      )
      promises.push(
        writeFile(
          join(rootDir, "src/api", `service_${i}.py`),
          `def run_service_${i}(payload):\n    # api_endpoint_handler\n    return {"id": ${i}}\n`,
          "utf8",
        ),
      )
    }
    for (let i = 0; i < 4; i++) {
      promises.push(
        writeFile(
          join(rootDir, "docs/architecture", `rfc_${i}.md`),
          `# RFC ${i}\n\nDetails for system subsystem ${i}.\nKey architectural invariant.\n`,
          "utf8",
        ),
      )
    }
    await Promise.all(promises)
    totalFiles += 48 * 2 + 4
    indexableFiles += 48 * 2 + 4
  } else {
    const numDirs = scale === "MEDIUM" ? 10 : 50
    const filesPerDir = 500

    for (let d = 0; d < numDirs; d++) {
      const dirRel = `src/modules/mod_${String(d).padStart(2, "0")}`
      const dirAbs = join(rootDir, dirRel)
      await mkdir(dirAbs, { recursive: true })
      dirCount++

      const batchPromises: Promise<void>[] = []
      for (let f = 0; f < filesPerDir; f++) {
        const needleTag = (d === 0 && f < 20) ? `// target_needle_symbol_${f}\n` : ""
        batchPromises.push(
          writeFile(
            join(dirAbs, `item_${String(f).padStart(3, "0")}.ts`),
            `export function runModItem_${d}_${f}(): number {\n  ${needleTag}  return ${d} * 1000 + ${f};\n}\n`,
            "utf8",
          ),
        )
      }
      await Promise.all(batchPromises)
      totalFiles += filesPerDir
      indexableFiles += filesPerDir
    }
  }

  // 3. Large text file (>128KB, ~250KB)
  const largeContent = "line " + "x".repeat(100) + "\n"
  const largePayload = largeContent.repeat(2500) // ~250KB
  await writeFile(join(rootDir, "src/utils", "huge_dataset.txt"), largePayload, "utf8")
  totalFiles++
  indexableFiles++
  largeFiles++

  // 4. Binary assets
  const binBuffer = Buffer.alloc(1024)
  binBuffer.fill(0) // Null bytes
  await writeFile(join(rootDir, "src/utils", "binary_asset.bin"), binBuffer)
  await writeFile(join(rootDir, "src/utils", "icon.png"), binBuffer)
  totalFiles += 2
  indexableFiles += 2
  binaryFiles += 2

  // 5. Safe symlink where platform allows
  try {
    await symlink(
      join(rootDir, "PROJECT.md"),
      join(rootDir, "src/utils/PROJECT_alias.md"),
    )
  } catch {
    // Ignore symlink failure
  }

  // 6. Ignored directory contents (distinct from indexable source files)
  // Ignored files MUST NOT count towards indexable file count
  const ignoredDirs = [
    "node_modules/fake-lib",
    ".git/objects",
    "dist/bundle",
    "build/temp",
    "coverage/lcov-report",
  ]
  const ignoredMultiplier = scale === "SMALL" ? 10 : scale === "MEDIUM" ? 100 : 300
  for (const ignDir of ignoredDirs) {
    const dirAbs = join(rootDir, ignDir)
    await mkdir(dirAbs, { recursive: true })
    dirCount++

    const ignPromises: Promise<void>[] = []
    for (let i = 0; i < ignoredMultiplier; i++) {
      ignPromises.push(
        writeFile(
          join(dirAbs, `ignored_${i}.js`),
          `/* ignored artifact */ module.exports = ${i};\n`,
          "utf8",
        ),
      )
    }
    await Promise.all(ignPromises)
    totalFiles += ignoredMultiplier
    ignoredFiles += ignoredMultiplier
  }

  return {
    scale,
    rootDir,
    fileCount: totalFiles,
    dirCount,
    indexableFileCount: indexableFiles,
    ignoredFileCount: ignoredFiles,
    binaryFileCount: binaryFiles,
    largeFileCount: largeFiles,
  }
}
