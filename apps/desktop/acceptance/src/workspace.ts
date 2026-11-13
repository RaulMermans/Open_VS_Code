import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fixturesRoot } from "./catalog.ts"

export function materializeFixture(fixture: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  if (fixture !== "none") {
    const source = join(fixturesRoot(), fixture)
    if (!existsSync(source)) throw new Error(`Unknown acceptance fixture: ${fixture}`)
    cpSync(source, destination, { recursive: true })
  } else {
    mkdirSync(destination, { recursive: true })
  }
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: destination,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Acceptance Lab",
        GIT_AUTHOR_EMAIL: "lab@example.invalid",
        GIT_COMMITTER_NAME: "Acceptance Lab",
        GIT_COMMITTER_EMAIL: "lab@example.invalid",
      },
    })
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`)
  }
  git(["init"])
  git(["add", "."])
  git(["commit", "--allow-empty", "-m", "fixture"])
}

export function fileDigest(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function workspaceDigest(root: string): Record<string, string> {
  const digests: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue
      const path = join(dir, entry)
      const info = statSync(path)
      if (info.isDirectory()) walk(path)
      else digests[relative(root, path)] = fileDigest(path) ?? ""
    }
  }
  if (existsSync(root)) walk(root)
  return digests
}

export function gitPorcelain(root: string): string {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || "git status failed")
  return result.stdout.trim()
}

export function runOracleCommand(root: string, cmd: string, args: readonly string[]): number {
  if (cmd !== "node" && cmd !== "python3") {
    throw new Error(`Acceptance oracle command is limited to node or python3, got ${cmd}`)
  }
  const result = spawnSync(cmd, [...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PYTHONPATH: root },
  })
  return result.status === null ? 1 : result.status
}

export function resolvedAbsent(root: string, relativePath: string): string {
  const target = resolve(root, relativePath)
  return target
}
