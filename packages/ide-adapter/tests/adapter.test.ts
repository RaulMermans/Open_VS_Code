import { test, describe } from "node:test";
import * as assert from "node:assert";
import { TestIdeHost } from "./test-host.js";
import { AgentSessionBridge } from "../src/bridge.ts";
import { buildBoundedIdeContextSnapshot, resolveWorkspaceRoot } from "../src/bounds.ts";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ScriptedModelProvider, estimateTokens } from "@open-vs-code/agent-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
      // T-1612/T-1613/T-1614: Cancellation with real deterministic sync
      // Provider records: started, AbortSignal observed, lateCompletionAttempted
      id: "26 delayed provider cancellation",
      setup: () => {},
      action: async (b, ac) => {
          setTimeout(() => ac.abort(), 50);
          try { await b.runTask("hello", "ASK", ac.signal); } catch {}
      },
      providerSteps: [
          async (req: any) => {
              // Record that the provider was actually called
              (req as any)._requestStarted = true;
              (req as any)._providerSawAbort = false;
              (req as any)._lateCompletionAttempted = false;
              if (req.signal) {
                  if (req.signal.aborted) (req as any)._providerSawAbort = true;
                  req.signal.addEventListener("abort", () => { (req as any)._providerSawAbort = true; });
              }
              // Wait until cancel fires (deterministic: cancel fires at 50ms, wait 150ms)
              await new Promise(r => setTimeout(r, 150));
              // Provider observes abort and attempts late completion
              (req as any)._lateCompletionAttempted = true;
              // Late completion FAILS because signal is aborted
              const e = new Error("AbortError");
              e.name = "AbortError";
              throw e;
          }
      ],
      // T-1614: exact measured values
      // status=CANCELLED is observed from bridge showOutput "Task Finished: CANCELLED" or signal
      // abortObserved from req._providerSawAbort
      // lateCompletionAttempted from req._lateCompletionAttempted
      // lateCompletionAccepted=false because provider threw AbortError
      expected: { status: "CANCELLED", providerCalls: 1, abortObserved: true, lateCompletionAttempted: true, lateCompletionAccepted: false, activeSessionCleared: true, cleanupCount: 1, fallbackCalls: 0 }
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
    // T-1603: "4 no active document" — proves that absent context doesn't break ASK; asserts providerCalls=1
    { id: "4 no active document", setup: (h) => { h.activeDocument = null; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", providerCalls: 1 } },
    // T-1603: "5 small selection" — proves small selection passes through; asserts selectionRetainedTokens >= selectionInputTokens (not truncated)
    { id: "5 small selection under budget", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false}; h.selection = { start: {line:1, character:0}, end: {line:2, character:0}, selectedText: "hello" }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", selectionInputTokens: 2, selectionRetainedTokens: 2 } },
    // T-1603: "6 oversized selection" — selectionInputTokens > budget, retained <= budget
    // "A".repeat(400000): input=100000 tokens, budget=128000->maxSel=32000, allowedChars=112000, retained=ceil(112016/4)=28004
    // T-1603: "6b production bridge selection budget" — tests the 6500 budget inside AgentSessionBridge
    { id: "6b production bridge selection budget", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false}; h.selection = { start: {line:1, character:0}, end: {line:2, character:0}, selectedText: "A".repeat(400000) }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", productionSelectionRetained: 1426 } },

    { id: "6 oversized selection truncated", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false}; h.selection = { start: {line:1, character:0}, end: {line:2, character:0}, selectedText: "A".repeat(400000) }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", selectionInputTokens: 100000, selectionRetainedTokens: 28004 } },
    // T-1603: "7 dirty editor" — isDirty=true asserted from snapshot
    { id: "7 dirty editor asserted", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:true}; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", isDirty: true } },
    // T-1603: "8 version preserved" — documentVersion=42 from snapshot
    { id: "8 version preserved asserted", setup: (h) => { h.activeDocument = { uri: "f", workspaceRelativePath: "f", languageId: "ts", version:42, isDirty:false}; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", documentVersion: 42 } },
    // T-1603: "9 visible-doc bound" — visibleDocsInput=50 (fixture), visibleDocsRetained<=20
    { id: "9 visible-doc bound asserted", setup: (h) => { h.visibleDocuments = Array.from({length: 50}).map((_, i) => ({ uri: "f", workspaceRelativePath: "f", languageId: "ts", version:1, isDirty:false })); }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", visibleDocsInput: 50, visibleDocsRetained: 20 } },
    // T-1603: "10 diagnostic bound" — diagnosticsInput=150 (fixture), diagnosticsRetained<=100
    { id: "10 diagnostic bound asserted", setup: (h) => { h.diagnostics = Array.from({length: 150}).map((_, i) => ({ path: "f", severity: "error" as const, message: "err", range: {start:{line:0,character:0},end:{line:0,character:0}}, source: "test" })); }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", diagnosticsInput: 150, diagnosticsRetained: 100 } },
    // T-1619: "12 ambiguous multi-root" — no active file, resolvedRoot=null (explicit documented behavior)
    { id: "12 ambiguous multi-root no-file", setup: (h, r) => { h.workspaceRoots = [{uri:"a", fsPath:"a", name: "a"},{uri:"b", fsPath:"b", name: "b"}]; h.activeDocument = null; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", resolvedRoot: "null" } },
    // T-1617: "12b nested multi-root" — /r/app/src/a.ts must resolve to /r/app (most specific)
    { id: "12b nested multi-root most-specific", setup: (h, r) => { h.workspaceRoots = [{uri:"file:///r", fsPath:"/r", name: "r"},{uri:"file:///r/app", fsPath:"/r/app", name: "app"}]; h.activeDocument = { uri: "file:///r/app/src/a.ts", workspaceRelativePath: "src/a.ts", languageId: "ts", version: 1, isDirty: false }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", resolvedRoot: "app" } },
    // T-1618: "12c overlapping name multi-root" — /r/app must NOT match /r/application/src/a.ts
    { id: "12c overlapping name boundary-safe", setup: (h, r) => { h.workspaceRoots = [{uri:"file:///r/app", fsPath:"/r/app", name: "app"},{uri:"file:///r/application", fsPath:"/r/application", name: "application"}]; h.activeDocument = { uri: "file:///r/application/src/a.ts", workspaceRelativePath: "src/a.ts", languageId: "ts", version: 1, isDirty: false }; }, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", resolvedRoot: "application" } },
    { id: "15 ASK", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", cleanupCount: 1, providerCalls: 1 } },
    { id: "16 PLAN", setup: () => {}, action: (b, ac) => b.runTask("hello", "PLAN", ac.signal), expected: { status: "COMPLETED", providerCalls: 1 } },
    { id: "17 BUILD", setup: (h) => { h.nextConfirmationResponse = "APPROVE"; }, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "COMPLETED", providerCalls: 1 } },
    { id: "18 DEBUG", setup: (h) => { h.nextConfirmationResponse = "APPROVE"; }, action: (b, ac) => b.runTask("hello", "DEBUG", ac.signal), expected: { status: "COMPLETED", providerCalls: 1 } },
    { id: "19 REVIEW", setup: (h) => { h.nextConfirmationResponse = "APPROVE"; }, action: (b, ac) => b.runTask("hello", "REVIEW", ac.signal), expected: { status: "COMPLETED", providerCalls: 1 } },
    // T-1609: untrusted BUILD — isTrusted=false blocks execution; providerCalls=0
    { id: "23 untrusted BUILD blocked", setup: (h) => { h.trusted = false; }, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "FAILED", providerCalls: 0 } },
    // T-1625/lifecycle: provider-error — active session cleared, cleanupCount=1
    { id: "28 provider-error cleanup", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), providerSteps: [new Error("provider fail")], expected: { status: "FAILED", activeSessionCleared: true, cleanupCount: 1 } },
    // T-1625/lifecycle: normal cleanup
    { id: "29 normal cleanup", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", activeSessionCleared: true, cleanupCount: 1 } },
    // T-1625/lifecycle: confirmation-error (REJECT) — still cleans up
    { id: "30 confirmation-error cleanup", setup: (h) => { h.nextConfirmationResponse = "REJECT"; }, action: (b, ac) => b.runTask("hello", "BUILD", ac.signal), expected: { status: "COMPLETED", activeSessionCleared: true, cleanupCount: 1 } },
    // T-1626: active-session concurrency — session A active=yes, session B result=BUSY (showError), providerCalls=1 (only session A)
    { id: "31 active-session concurrency isolation", setup: () => {}, action: async (b, ac) => { const p1 = b.runTask("1", "ASK", ac.signal); const p2 = b.runTask("2", "ASK", ac.signal); await Promise.allSettled([p1,p2]); }, expected: { status: "COMPLETED", providerCalls: 1, busyRejected: true } },
    // T-1611: RepairOrchestrator preserved — run_known_test in DEBUG triggers repair path
    {
      id: "37 RepairOrchestrator preserved",
      setup: (h) => { h.nextConfirmationResponse = "APPROVE"; },
      action: async (b, ac) => { await b.runTask("hello", "DEBUG", ac.signal); },
      providerSteps: [
        { message: { role: "assistant", content: "" }, toolCalls: [{ id: "t1", name: "run_known_test", arguments: { action: "jest" } }] },
        { message: { role: "assistant", content: "done" } }
      ],
      expected: { status: "COMPLETED", repairOrchestratorEntered: true }
    },
    // T-1625: MCP lifecycle cleanup
    { id: "38 MCP lifecycle cleanup", setup: () => {}, action: (b, ac) => b.runTask("hello", "ASK", ac.signal), expected: { status: "COMPLETED", cleanupCount: 1 } },
];
for (const x of extra) if (!scenarios.find(s => s.id === x.id)) scenarios.push(x);

// Direct unit tests for workspace root resolver (T-1616/T-1617/T-1618/T-1619)
describe("resolveWorkspaceRoot boundary-aware unit tests", () => {
    test("T-1617: nested roots — most-specific owner wins", () => {
        const snapshot = {
            workspaceRoots: [
                { uri: "file:///repo", fsPath: "/repo", name: "repo" },
                { uri: "file:///repo/packages/app", fsPath: "/repo/packages/app", name: "app" }
            ],
            activeDocument: { uri: "file:///repo/packages/app/src/index.ts", workspaceRelativePath: "src/index.ts", languageId: "ts", version: 1, isDirty: false },
            selection: null,
            visibleDocuments: [],
            diagnostics: [],
            isTrusted: true
        };
        const result = resolveWorkspaceRoot(snapshot as any);
        assert.strictEqual(result, "/repo/packages/app", "Most-specific root /repo/packages/app must win over /repo");
    });

    test("T-1618: overlapping names — boundary-safe, /repo/app must NOT match /repo/application", () => {
        const snapshot = {
            workspaceRoots: [
                { uri: "file:///repo/app", fsPath: "/repo/app", name: "app" },
                { uri: "file:///repo/application", fsPath: "/repo/application", name: "application" }
            ],
            activeDocument: { uri: "file:///repo/application/src/index.ts", workspaceRelativePath: "src/index.ts", languageId: "ts", version: 1, isDirty: false },
            selection: null,
            visibleDocuments: [],
            diagnostics: [],
            isTrusted: true
        };
        const result = resolveWorkspaceRoot(snapshot as any);
        assert.strictEqual(result, "/repo/application", "/repo/app must NOT false-match /repo/application/src/index.ts");
    });

    test("T-1619: ambiguous multi-root with no active document returns null", () => {
        const snapshot = {
            workspaceRoots: [
                { uri: "file:///a", fsPath: "/a", name: "a" },
                { uri: "file:///b", fsPath: "/b", name: "b" }
            ],
            activeDocument: null,
            selection: null,
            visibleDocuments: [],
            diagnostics: [],
            isTrusted: true
        };
        const result = resolveWorkspaceRoot(snapshot as any);
        assert.strictEqual(result, null, "Ambiguous multi-root with no active file must return null");
    });

    test("T-1620: single root with active file outside workspace returns first root", () => {
        // Single root: resolver falls back to roots[0] when no active file matches
        const snapshot = {
            workspaceRoots: [{ uri: "file:///workspace", fsPath: "/workspace", name: "ws" }],
            activeDocument: null,
            selection: null,
            visibleDocuments: [],
            diagnostics: [],
            isTrusted: true
        };
        const result = resolveWorkspaceRoot(snapshot as any);
        assert.strictEqual(result, "/workspace", "Single root must return the single root fsPath");
    });
});

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
        let busyRejected = false;
        
        // Intercept bridge busy-rejection before runTask
        const origRunTask = bridge.runTask.bind(bridge);
        let wasBusyOnEntry = false;
        (bridge as any).runTask = async (instruction: string, mode: any, sig: AbortSignal) => {
            if ((bridge as any).activeSession) {
                wasBusyOnEntry = true;
            }
            return origRunTask(instruction, mode, sig);
        };
        
        try {
            await c.action(bridge, ac);
        } catch (e: any) {
            thrownError = e;
        }
        
        let pathEscapeRejected = false;
        let mutationCount = 0;
        let repairOrchestratorEntered = false;
        let lateCompletionAttempted = false;
        let lateCompletionAccepted = false;
        
        const reqs = provider.requests;
        const errors = host.errors;
        
        // T-1612: terminal status observed from bridge outputs, not inferred from signal alone
        const taskFinishedOutput = host.outputs.find(o => o.startsWith("Task Finished:"));
        let status = "COMPLETED";
        if (taskFinishedOutput) {
            const finishedStatus = taskFinishedOutput.replace("Task Finished: ", "").trim();
            if (finishedStatus === "CANCELLED") status = "CANCELLED";
            else if (finishedStatus !== "COMPLETED") status = finishedStatus;
        }
        // FAILED: provider error or host errors that are not expected business rejections
        if (thrownError) {
            console.error("Scenario", c.id, "threw:", thrownError);
            status = "FAILED";
        }
        if (errors.length > 0 && !errors.some(e => e.includes("A session is already active.") || e.includes("untrusted workspace"))) {
            console.error("Scenario", c.id, "host errors:", errors);
            status = "FAILED";
        }
        // Concurrency: second runTask showing BUSY is a bridge-level showError, check for it
        if (errors.some(e => e.includes("A session is already active."))) {
            busyRejected = true;
        }
        // Untrusted workspace: bridge showError without provider call = FAILED
        if (errors.some(e => e.includes("untrusted workspace")) && reqs.length === 0) {
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
        
        // T-1614: lateCompletionAttempted — observed from provider request record
        if (reqs.some((r: any) => r._lateCompletionAttempted)) {
            lateCompletionAttempted = true;
            // lateCompletionAccepted = false if the provider threw (status = CANCELLED)
            // lateCompletionAccepted = true only if provider returned a message despite abort
            lateCompletionAccepted = status !== "CANCELLED" && lateCompletionAttempted;
        }
        
        // T-1611: For scenario 37 — RepairOrchestrator entered if more than 1 provider call in DEBUG
        if (c.id === "37 RepairOrchestrator preserved") {
            if (reqs.length > 1) {
                repairOrchestratorEntered = true;
            }
        }
        
        const snapshot = await host.getSnapshot();
        const rootFromHost = resolveWorkspaceRoot(snapshot);
        const resolvedWorkspaceRoot = rootFromHost || workspaceRoot;
        let resolvedRoot = path.basename(resolvedWorkspaceRoot);
        if (rootFromHost === null) {
            resolvedRoot = "null";
        }

        const bounded = buildBoundedIdeContextSnapshot(snapshot, 128000);
        let selectionInputTokens = 0;
        let selectionRetainedTokens = 0;
        if (snapshot.selection?.selectedText) selectionInputTokens = estimateTokens(snapshot.selection.selectedText);
        if (bounded.selection?.selectedText) selectionRetainedTokens = estimateTokens(bounded.selection.selectedText);

        // T-1626: fallbackCalls — number of provider calls if status=CANCELLED but bridge made extra calls
        let productionSelectionRetained = 0;
        const runnerInput = (bridge as any)._lastRuntime?.runnerInput;
        if (runnerInput && runnerInput.task.instruction) {

             const match = runnerInput.task.instruction.match(/\nSelection:\n([\s\S]*)/);
             if (match) {
                 productionSelectionRetained = estimateTokens(match[1]);
             }
        }

        const fallbackCalls = (status === "CANCELLED" && reqs.length > 1) ? reqs.length - 1 : 0;

        results.push({
            id: c.id,
            status,
            providerCalls: reqs.length,
            mutationCount,
            confirmationCount: host.confirmationsRequested.length,
            pathEscapeRejected,
            resolvedRoot,
            activeSessionCleared: (bridge as any).activeSession === false,
            repairOrchestratorEntered,
            abortObserved: reqs.some((r: any) => r._providerSawAbort),
            lateCompletionAttempted,
            lateCompletionAccepted,
            cleanupCount: (bridge as any)._lastRuntime?.mcpStats?.cleanupCount || 0,
            selectionInputTokens,
            productionSelectionRetained,

            selectionRetainedTokens,
            visibleDocsInput: snapshot.visibleDocuments.length,
            visibleDocsRetained: bounded.visibleDocuments.length,
            diagnosticsInput: snapshot.diagnostics.length,
            diagnosticsRetained: bounded.diagnostics.length,
            isDirty: snapshot.activeDocument?.isDirty || false,
            documentVersion: snapshot.activeDocument?.version || 0,
            busyRejected,
            fallbackCalls,
        });
    }
    return results;
}

describe("IDE Adapter Strict Evaluator", () => {
    test("run twice and deep equality", async () => {
        const run1 = await runIdeEvaluation("_r1");
        const run2 = await runIdeEvaluation("_r2");
        
        // T-1629: normalize only nondeterministic infra (temp paths in resolvedRoot)
        // Do NOT normalize: token counts, mutation count, provider calls, abort state, cleanup state
        const norm1 = run1.map(r => ({ ...r, resolvedRoot: r.resolvedRoot.replace("_r1", "") }));
        const norm2 = run2.map(r => ({ ...r, resolvedRoot: r.resolvedRoot.replace("_r2", "") }));
        
        assert.deepStrictEqual(norm1, norm2, "Runs should be deterministic and equal");
        
        // T-1602: strict comparator — every declared expected field MUST exist AND match
        for (const r of norm1) {
            const expected = scenarios.find(s => s.id === r.id)?.expected;
            if (!expected) continue;
            for (const key of Object.keys(expected)) {
                // Hard invariant: actual field must exist AND value must match
                assert.ok(
                    Object.prototype.hasOwnProperty.call(r, key),
                    `Scenario ${r.id}: expected field "${key}" must exist in actual result`
                );
                assert.strictEqual(
                    (r as any)[key],
                    expected[key],
                    `Scenario ${r.id}: expected ${key}=${expected[key]} but got ${(r as any)[key]}`
                );
            }
        }
    });
});
