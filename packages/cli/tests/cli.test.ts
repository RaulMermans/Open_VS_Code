import { runCLI } from "../src/app.ts";
import { ScriptedModelProvider } from "@open-vs-code/agent-core/src/testing/scripted-model.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, cp, rm } from "node:fs/promises";
import assert from "node:assert";

async function runTests() {
  const tempBase = join(tmpdir(), "cli-eval-");
  const ws = await mkdtemp(tempBase);

  try {
    const fixturePath = join(process.cwd(), "..", "agent-core", "tests", "fixtures", "eval-repos", "mini-express-app");
    await cp(fixturePath, ws, { recursive: true, force: true });

    // 1. ASK
    let provider = new ScriptedModelProvider([
      { model: "scripted", message: { role: "assistant", content: "The config is in src/config.ts" } }
    ]);
    
    let res = await runCLI({
      mode: "ASK",
      instruction: "Where is the config?",
      workspaceRoot: ws,
      provider,
      json: true
    });
    assert.strictEqual(res.exitCode, 0);

    // 2. PLAN
    provider = new ScriptedModelProvider([
      { model: "scripted", message: { role: "assistant", content: "Plan: add feature flag." } }
    ]);
    res = await runCLI({
      mode: "PLAN",
      instruction: "Plan a feature",
      workspaceRoot: ws,
      provider,
      json: true
    });
    assert.strictEqual(res.exitCode, 0);

    // 3. BUILD successful
    provider = new ScriptedModelProvider([
      { 
        model: "scripted", 
        message: { role: "assistant", content: "" }, 
        toolCalls: [
          { id: "c1", name: "apply_patch", arguments: { path: "src/config.ts", search: "development", replace: "prod" } }
        ] 
      },
      { 
        model: "scripted", 
        message: { role: "assistant", content: "" }, 
        toolCalls: [
          { id: "c2", name: "run_verification", arguments: { action: "TEST" } }
        ] 
      },
      { model: "scripted", message: { role: "assistant", content: "Done" } }
    ]);
    res = await runCLI({
      mode: "BUILD",
      instruction: "Change to prod",
      workspaceRoot: ws,
      provider,
      json: true,
      mockApproval: "APPROVE"
    });
    assert.strictEqual(res.exitCode, 0);

    // 4. BUILD rejected
    provider = new ScriptedModelProvider([
      { 
        model: "scripted", 
        message: { role: "assistant", content: "" }, 
        toolCalls: [
          { id: "c1", name: "apply_patch", arguments: { path: "src/config.ts", search: "prod", replace: "development" } }
        ] 
      },
      { model: "scripted", message: { role: "assistant", content: "Okay" } }
    ]);
    res = await runCLI({
      mode: "BUILD",
      instruction: "Change back",
      workspaceRoot: ws,
      provider,
      json: true,
      mockApproval: "REJECT"
    });
    // It should complete the turn, but with rejected outcome.
    assert.strictEqual(res.exitCode, 0); 
    
    console.log("All CLI E2E tests passed.");
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
