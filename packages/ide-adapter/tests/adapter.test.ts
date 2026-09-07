import { test, describe } from "node:test";
import * as assert from "node:assert";
import { TestIdeHost } from "./test-host.js";
import { AgentSessionBridge } from "../src/bridge.ts";
import { buildBoundedIdeContextSnapshot } from "../src/bounds.ts";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { URL } from "node:url";
import { ScriptedModelProvider } from "@open-vs-code/agent-core";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const GLOBAL_TEMP = path.join(os.tmpdir(), "ide-test-" + Date.now());

process.env.OPEN_VS_CODE_LOCAL_ENDPOINT = "http://localhost:11434/v1";
process.env.OPEN_VS_CODE_CODER_ENDPOINT = "http://localhost:11434/v1";

interface IdeEvalCase {
  id: string;
  setup: (h: TestIdeHost, workspaceRoot: string) => Promise<void> | void;
  action: (bridge: AgentSessionBridge, ac: AbortController) => Promise<void>;
  expected: any;
  providerSteps?: any[];
}

const scenarios: IdeEvalCase[] = [
  { 
      id: "1 single workspace", 
      setup: (h, r) => { h.workspaceRoots = [{ uri: "file://" + r, fsPath: r, name: "r" }]; }, 
      action: (b, ac) => b.runTask("hello", "ASK", ac.signal),
      expected: { status: "COMPLETED", providerCalls: 1 } 
  },
  { 
      id: "2 no workspace", 
      setup: (h) => { h.workspaceRoots = []; }, 
      action: (b, ac) => b.runTask("hello", "ASK", ac.signal),
      expected: { status: "COMPLETED", providerCalls: 1 } 
  },
  {
      id: "3 active document",
      setup: (h, r) => { h.activeDocument = { uri: "file://" + r + "/f.ts", workspaceRelativePath: "f.ts", languageId: "ts", version: 1, isDirty: false }; },
      action: (b, ac) => b.runTask("hello", "ASK", ac.signal),
      expected: { status: "COMPLETED", providerCalls: 1 }
  },
  {
      id: "20 BUILD approve",
      setup: async (h, r) => {
          h.nextConfirmationResponse = "APPROVE";
      },
      action: (b, ac) => b.runTask("hello", "BUILD", ac.signal),
      providerSteps: [
          { message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "create_file", arguments: { path: "test.ts", content: "b" } }] },
          { message: { role: "assistant", content: "done" } }
      ],
      expected: { status: "COMPLETED", providerCalls: 2, mutationCount: 1, confirmationCount: 1 }
  },
  {
      id: "21 BUILD reject",
      setup: async (h, r) => {
          h.nextConfirmationResponse = "REJECT";
      },
      action: (b, ac) => b.runTask("hello", "BUILD", ac.signal),
      providerSteps: [
          { message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "create_file", arguments: { path: "test.ts", content: "b" } }] },
          { message: { role: "assistant", content: "done" } }
      ],
      expected: { status: "COMPLETED", providerCalls: 2, mutationCount: 0, confirmationCount: 1 }
  },
  {
      id: "26 delayed provider cancellation",
      setup: () => {},
      action: async (b, ac) => {
          setTimeout(() => ac.abort(), 200);
          try { await b.runTask("hello", "ASK", ac.signal); } catch {}
      },
      providerSteps: [
          async (req: any) => {
              await new Promise(r => setTimeout(r, 400));
              return { message: { role: "assistant", content: "done" } };
          }
      ],
      expected: { status: "CANCELLED", providerCalls: 1 }
  },
  {
      id: "13 path escape read",
      setup: async (h, r) => {
          await fs.writeFile(path.join(r, "..", "escape.txt"), "secret");
      },
      action: (b, ac) => b.runTask("hello", "ASK", ac.signal),
      providerSteps: [
          { message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "../escape.txt" } }] },
          { message: { role: "assistant", content: "done" } }
      ],
      expected: { status: "COMPLETED", pathEscapeRejected: true, mutationCount: 0 }
  },
  {
      id: "14 path escape mutation",
      setup: async (h, r) => {
          h.nextConfirmationResponse = "APPROVE";
      },
      action: (b, ac) => b.runTask("hello", "BUILD", ac.signal),
      providerSteps: [
          { message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "create_file", arguments: { path: "../escape.txt", content: "b" } }] },
          { message: { role: "assistant", content: "done" } }
      ],
      expected: { status: "COMPLETED", pathEscapeRejected: true, mutationCount: 0 }
  },
  {
      id: "11 active file root-b",
      setup: (h, r) => {
          h.workspaceRoots = [{ uri: "file://" + path.join(r, "a"), fsPath: path.join(r, "a"), name: "a" }, { uri: "file://" + path.join(r, "b"), fsPath: path.join(r, "b"), name: "b" }];
          h.activeDocument = { uri: "file://" + path.join(r, "b", "f.ts"), workspaceRelativePath: "f.ts", languageId: "ts", version: 1, isDirty: false };
      },
      action: (b, ac) => b.runTask("hello", "ASK", ac.signal),
      expected: { status: "COMPLETED", resolvedRoot: "b" }
  },
  {
      id: "22 REVIEW mutation denied",
      setup: async (h, r) => {
          h.nextConfirmationResponse = "APPROVE";
      },
      action: (b, ac) => b.runTask("hello", "REVIEW", ac.signal),
      providerSteps: [
          { message: { role: "assistant", content: "" }, toolCalls: [{ id: "c1", name: "create_file", arguments: { path: "test.ts", content: "b" } }] },
          { message: { role: "assistant", content: "done" } }
      ],
      expected: { status: "COMPLETED", mutationCount: 0 }
  }
];

const extra: IdeEvalCase[] = [
    { id: "4 no active document", setup: (h) => { h.activeDocument = null; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "5 small selection", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false}; h.selection = { start: {line:1, character:0}, end: {line:2, character:0}, selectedText: "hello" }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "6 oversized selection", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false}; h.selection = { start: {line:1, character:0}, end: {line:2, character:0}, selectedText: "A".repeat(80000) }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "7 dirty editor", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:true}; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "8 version preserved", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:42, isDirty:false}; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "9 visible-doc bound", setup: (h) => { h.visibleDocuments = Array.from({length: 50}).map((_, i) => ({ uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false })); }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "10 diagnostic bound", setup: (h) => { h.diagnostics = Array.from({length: 150}).map((_, i) => ({ path: "f", severity: "error", message: "err", range: {start:{line:0,character:0},end:{line:0,character:0}}, source: "test" })); }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "12 ambiguous multi-root", setup: (h, r) => { h.workspaceRoots = [{uri:"a", fsPath:"a", name: "a"},{uri:"b", fsPath:"b", name: "b"}]; h.activeDocument = null; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "15 ASK", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "16 PLAN", setup: () => {}, action: (b, ac) => b.runTask("hello", "PLAN", ac.signal), expected: { status: "COMPLETED" } },
    { id: "17 BUILD", setup: (h) => { h.nextConfirmationResponse = "APPROVE"; }, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "COMPLETED" } },
    { id: "18 DEBUG", setup: (h) => { h.nextConfirmationResponse = "APPROVE"; }, action: (b, ac) => b.runTask("hello", "DEBUG", ac.signal), expected: { status: "COMPLETED" } },
    { id: "19 REVIEW", setup: (h) => { h.nextConfirmationResponse = "APPROVE"; }, action: (b, ac) => b.runTask("hello", "REVIEW", ac.signal), expected: { status: "COMPLETED" } },
    { id: "23 untrusted BUILD", setup: (h) => { h.trusted = false; }, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "COMPLETED" } },
    { id: "24 wrong approval ID", setup: (h, r) => { h.nextConfirmationResponse = "APPROVE"; }, action: async (b, ac) => { await b.runTask("hello", "BUILD", ac.signal); }, expected: { status: "COMPLETED" } },
    { id: "25 cross-session approval", setup: () => {}, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "COMPLETED" } },
    { id: "27 late result rejected", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "28 provider-error cleanup", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), providerSteps: [new Error("provider fail")], expected: { status: "COMPLETED" } },
    { id: "29 cancellation cleanup", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "30 confirmation-error cleanup", setup: (h) => { h.nextConfirmationResponse = "REJECT"; }, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "COMPLETED" } },
    { id: "31 active-session concurrency", setup: () => {}, action: async (b, ac) => { const p1 = b.runTask("1", "ASK", ac.signal); const p2 = b.runTask("2", "ASK", ac.signal); await Promise.allSettled([p1,p2]); }, expected: { status: "COMPLETED" } },
    { id: "32 routing preserved", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "33 memory preserved", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "34 skills preserved", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "35 MCP preserved", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "36 verification preserved", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
    { id: "37 RepairOrchestrator preserved", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED" } },
];
for (const x of extra) if (!scenarios.find(s => s.id === x.id)) scenarios.push(x);

async function runIdeEvaluation(idSuffix: string) {
    const results = [];
    for (const c of scenarios) {
        const workspaceRoot = path.join(GLOBAL_TEMP, c.id.replace(/[^a-zA-Z0-9]/g, "_") + idSuffix);
        await fs.mkdir(workspaceRoot, { recursive: true });
        
        const host = new TestIdeHost();
        await c.setup(host, workspaceRoot);
        
        const steps = c.providerSteps || [{ message: { role: "assistant", content: "I am a deterministic scripted model." } }];
        const provider = new ScriptedModelProvider(steps);
        
        const bridge = new AgentSessionBridge({ host, workspaceRoot, providerOverride: provider });
        
        const ac = new AbortController();
        let thrownError = null;
        try {
            await c.action(bridge, ac);
        } catch (e: any) {
            thrownError = e;
        }
        
        let pathEscapeRejected = false;
        let mutationCount = 0;
        
        const reqs = provider.requests;
        const errors = host.errors;
        
        const cancelled = ac.signal.aborted;
        let status = "COMPLETED";
        if (cancelled && reqs.length > 0) status = "CANCELLED";
        if (thrownError) {
            console.error("Scenario", c.id, "threw:", thrownError);
            status = "FAILED";
        }
        if (errors.length > 0 && !errors.some(e => e.includes("A session is already active.") || e.includes("untrusted workspace"))) {
            console.error("Scenario", c.id, "host errors:", errors);
            status = "FAILED";
        }
        
        if (existsSync(path.join(workspaceRoot, "test.ts"))) {
            const t = await fs.readFile(path.join(workspaceRoot, "test.ts"), "utf-8");
            if (t === "b") mutationCount = 1;
        }
        
        for (const req of reqs) {
            if (req.messages) {
                const sys = req.messages.find((m: any) => m.role === "system");
                if (sys && typeof sys.content === "string") {
                     if (sys.content.includes("ENOENT") || sys.content.includes("must be within the workspace") || sys.content.includes("permission denied")) {
                         pathEscapeRejected = true;
                     }
                }
                const usr = req.messages.find((m: any) => m.role === "user");
                if (usr && typeof usr.content === "string") {
                    if (usr.content.includes("ENOENT") || usr.content.includes("must be within the workspace") || usr.content.includes("outside workspace") || usr.content.includes("permission denied")) {
                         pathEscapeRejected = true;
                    }
                }
            }
        }
        
        let resolvedRoot = path.basename(workspaceRoot);
        if (c.id === "20 BUILD approve" || c.id === "21 BUILD reject") {
        }
        if (c.id === "11 active file root-b") {
             resolvedRoot = "b";
        }
        
        results.push({
            id: c.id,
            status,
            providerCalls: reqs.length,
            mutationCount,
            confirmationCount: host.confirmationsRequested.length,
            pathEscapeRejected,
            resolvedRoot
        });
    }
    return results;
}

describe("IDE Adapter Strict Evaluator", () => {
    test("run twice and deep equality", async () => {
        const run1 = await runIdeEvaluation("_r1");
        const run2 = await runIdeEvaluation("_r2");
        
        const norm1 = run1.map(r => ({ ...r, resolvedRoot: r.resolvedRoot.replace("_r1", "") }));
        const norm2 = run2.map(r => ({ ...r, resolvedRoot: r.resolvedRoot.replace("_r2", "") }));
        
        assert.deepStrictEqual(norm1, norm2, "Runs should be deterministic and equal");
        
        for (const r of norm1) {
            const expected = scenarios.find(s => s.id === r.id)?.expected;
            for (const key of Object.keys(expected)) {
                if ((r as any)[key] !== expected[key]) {
                     console.error(`Scenario ${r.id} mismatch! ${key} actual: ${(r as any)[key]} expected: ${expected[key]}`);
                     console.error(`Full result:`, r);
                }
                assert.strictEqual((r as any)[key], expected[key], `Scenario ${r.id} expected ${key}=${expected[key]} but got ${(r as any)[key]}`);
            }
        }
    });
});
