import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { realpath, access } from "node:fs/promises";
import { runCLI, runLearningCLI } from "./app.ts";

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
  --skills           Enable the Portable Skills Runtime (off by default; ADR-029)
  --workflow         Run eligible build/debug tasks through the Structured Engineering Loop
                     (PLAN → IMPLEMENT → TEST → REVIEW → VERIFY; off by default; ADR-030)
  --progress-monitor Detect non-progress (repeated failures/actions) and run one bounded
                     diagnostic recovery before stopping as BLOCKED (off by default; ADR-031)
  --learning         Record evidence-backed lessons after each task and use only APPROVED
                     learning in prompts (off by default; ADR-032)

Learning review (explicit human gate; ADR-032):
  open-vscode-agent learning list
  open-vscode-agent learning show <id>
  open-vscode-agent learning approve <id>
  open-vscode-agent learning reject <id> [--reason "<why>"]
  open-vscode-agent learning decide --title "<decision>" --summary "<reason>"
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
      skills: { type: "boolean" },
      workflow: { type: "boolean" },
      "progress-monitor": { type: "boolean" },
      learning: { type: "boolean" },
      reason: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
    },
    allowPositionals: true,
  });

  const modeRaw = positionals[0];
  const instruction = positionals.slice(1).join(" ");

  if (!modeRaw) {
    console.error("Error: Mode is required. Use --help for usage.");
    process.exit(3);
  }

  if (modeRaw === "learning") {
    const learning = await runLearningCLI({
      workspaceRoot: await resolveWorkspace(values.workspace),
      action: positionals[1] ?? "list",
      ...(positionals[2] ? { id: positionals[2] } : {}),
      ...(values.reason ? { reason: values.reason } : {}),
      ...(values.title ? { title: values.title } : {}),
      ...(values.summary ? { summary: values.summary } : {}),
      ...(values.json ? { json: true } : {}),
    });
    process.exit(learning.exitCode);
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

  const workspaceRoot = await resolveWorkspace(values.workspace);

  const result = await runCLI({
    mode: mode as any,
    instruction,
    workspaceRoot,
    json: values.json,
    ...(values.skills ? { skills: true } : {}),
    ...(values.workflow ? { workflow: true } : {}),
    ...(values["progress-monitor"] ? { progressMonitor: true } : {}),
    ...(values.learning ? { learning: true } : {}),
  });

  process.exit(result.exitCode);
}

async function resolveWorkspace(requested: string | undefined): Promise<string> {
  const workspaceRoot = requested ? resolve(requested) : process.cwd();
  try {
    const real = await realpath(workspaceRoot);
    await access(real);
    return real;
  } catch {
    console.error(`Error: Workspace path '${workspaceRoot}' does not exist or is inaccessible.`);
    process.exit(3);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(3);
});
