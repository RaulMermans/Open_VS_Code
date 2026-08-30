import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { realpath, access } from "node:fs/promises";
import { runCLI } from "./app.ts";

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Open VS Code Agent CLI

Usage:
  open-vscode-agent <mode> "<instruction>" [options]

Modes:
  ask      Ask a question (read-only)
  plan     Create a plan (read-only)
  build    Implement a change (mutates with approval)
  debug    Investigate and fix an issue (mutates with approval)
  review   Review the workspace (read-only)

Options:
  --workspace <dir>  Target workspace directory (default: current directory)
  --json             Output result as JSON
  --help, -h         Show this help message

Model Configuration:
  Live open-weight inference is configured on the target inference machine.
    `);
    process.exit(0);
  }

  const { positionals, values } = parseArgs({
    args,
    options: {
      workspace: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const modeRaw = positionals[0];
  const instruction = positionals.slice(1).join(" ");

  if (!modeRaw) {
    console.error("Error: Mode is required. Use --help for usage.");
    process.exit(3);
  }

  const mode = modeRaw.toUpperCase();
  const validModes = ["ASK", "PLAN", "BUILD", "DEBUG", "REVIEW"];
  if (!validModes.includes(mode)) {
    console.error(`Error: Invalid mode '${modeRaw}'. Valid modes are: ask, plan, build, debug, review.`);
    process.exit(3);
  }

  if (mode !== "REVIEW" && !instruction) {
    console.error("Error: Instruction is required for this mode.");
    process.exit(3);
  }

  let workspaceRoot = process.cwd();
  if (values.workspace) {
    workspaceRoot = resolve(values.workspace);
  }

  try {
    workspaceRoot = await realpath(workspaceRoot);
    await access(workspaceRoot);
  } catch {
    console.error(`Error: Workspace path '${workspaceRoot}' does not exist or is inaccessible.`);
    process.exit(3);
  }

  const result = await runCLI({
    mode: mode as any,
    instruction,
    workspaceRoot,
    json: values.json,
  });

  process.exit(result.exitCode);
}

main().catch(err => {
  console.error(err);
  process.exit(3);
});
