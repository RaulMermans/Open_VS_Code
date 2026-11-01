import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BROWSER_VIEWPORT_PRESETS,
  BoundedObservationJournal,
  BrowserSessionError,
  BrowserSessionManager,
  createBrowserToolRegistrations,
  resolveViewportPresetId,
  type BrowserEvent,
} from "../../src/browser/index.ts";
import { AgentRunner } from "../../src/agent/runner.ts";
import { calculateBudget } from "../../src/context/budget.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { classifyPermission } from "../../src/tools/permissions.ts";
import { ScriptedModelProvider } from "../../src/testing/scripted-model.ts";

describe("Sprint 9B — Agent-Core Browser Observation, Correlation & Runner Governance Contracts", () => {
  test("1. Viewport presets resolve canonical desktop, tablet, mobile, and custom dimensions", () => {
    assert.equal(resolveViewportPresetId(BROWSER_VIEWPORT_PRESETS.desktop), "desktop");
    assert.equal(resolveViewportPresetId(BROWSER_VIEWPORT_PRESETS.tablet), "tablet");
    assert.equal(resolveViewportPresetId(BROWSER_VIEWPORT_PRESETS.mobile), "mobile");
    assert.equal(resolveViewportPresetId({ width: 1440, height: 900 }), "custom");
  });

  test("2. BrowserSessionManager.setViewport validates dimension bounds and updates passive state without launching Chromium", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9b-vp-"));
    const mgr = new BrowserSessionManager({
      workspaceRoot: tmp,
      networkPolicy: { allowedOrigins: ["http://127.0.0.1:3000"] },
    });
    const events: BrowserEvent[] = [];
    mgr.onEvent((e) => events.push(e));

    try {
      await assert.rejects(
        () => mgr.setViewport({ width: 100, height: 800 }),
        (err: any) => err instanceof BrowserSessionError && err.code === "INVALID_VIEWPORT",
        "Must reject undersized width < 240"
      );
      await assert.rejects(
        () => mgr.setViewport({ width: 1280, height: 5000 }),
        (err: any) => err instanceof BrowserSessionError && err.code === "INVALID_VIEWPORT",
        "Must reject oversized height > 2160"
      );

      const updated = await mgr.setViewport(BROWSER_VIEWPORT_PRESETS.tablet);
      assert.deepEqual(updated, { width: 768, height: 1024 });
      assert.equal(mgr.getStatus(), "UNINITIALIZED", "setViewport must NOT launch Chromium");
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "viewport_changed");
      assert.equal(events[0]!.details.presetId, "tablet");
    } finally {
      await mgr.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("3. BrowserSessionManager.withCorrelation propagates nested origin/taskId/confirmationId and cleans up on error", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9b-corr-"));
    const mgr = new BrowserSessionManager({
      workspaceRoot: tmp,
      networkPolicy: { allowedOrigins: ["http://127.0.0.1:3000"] },
    });
    const events: BrowserEvent[] = [];
    mgr.onEvent((e) => events.push(e));

    try {
      await assert.rejects(async () => {
        await mgr.withCorrelation({ origin: "agent", taskId: "task_outer" }, async () => {
          await mgr.setViewport({ width: 1024, height: 768 });
          await mgr.withCorrelation(
            { origin: "user", taskId: "task_inner", confirmationId: "conf_1" },
            async () => {
              await mgr.setViewport({ width: 390, height: 844 });
              throw new Error("boom");
            }
          );
        });
      }, /boom/);

      // After unwinding error, correlation stack must be empty
      await mgr.setViewport({ width: 1280, height: 800 });

      assert.equal(events.length, 3);
      assert.deepEqual(events[0]!.correlation, { origin: "agent", taskId: "task_outer" });
      assert.deepEqual(events[1]!.correlation, {
        origin: "user",
        taskId: "task_inner",
        confirmationId: "conf_1",
      });
      assert.equal(events[2]!.correlation, undefined, "Correlation stack must unwind cleanly after error");
    } finally {
      await mgr.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("4. AgentRunner emits correlated approval_requested, approval_resolved, and action_denied on browser tool confirmation & rejection", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovsc-9b-runner-"));
    const mgr = new BrowserSessionManager({
      workspaceRoot: tmp,
      networkPolicy: { allowedOrigins: ["http://127.0.0.1:3000"] },
    });
    let navigatedUrl = "";
    mgr.navigate = async (url: string) => {
      navigatedUrl = url;
      return { url, title: "Navigated" };
    };

    const browserEvents: BrowserEvent[] = [];
    mgr.onEvent((e) => browserEvents.push(e));

    try {
      // 4a: BUILD mode browser_navigate pauses for confirmation, then APPROVE executes without MutationEngine file preimages
      const providerApprove = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "Navigating." },
          toolCalls: [
            { id: "c1", name: "browser_navigate", arguments: { url: "http://127.0.0.1:3000/next" } },
          ],
        },
        {
          model: "scripted",
          message: { role: "assistant", content: "Navigation done." },
          toolCalls: [],
        },
      ]);

      const registry = new ToolRegistry(createBrowserToolRegistrations(mgr));
      const budget = calculateBudget({ contextWindow: 4000, reservedOutput: 500, reservedToolHistory: 500 });
      let eventSeq = 0;
      const eventFactory = {
        createId: () => `ev-${++eventSeq}`,
        now: () => new Date().toISOString(),
      };

      const runner1 = new AgentRunner({
        provider: providerApprove,
        registry,
        permissionEvaluator: classifyPermission,
        eventFactory,
      });
      const paused1 = await runner1.run({
        task: { id: "task-nav-1", mode: "BUILD", instruction: "Go to /next" },
        workspaceRoot: tmp,
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      });
      assert.equal(paused1.status, "PAUSED");
      assert.equal(paused1.confirmation?.action, "browser_interaction");

      const done1 = await runner1.resume("APPROVE");
      assert.equal(done1.status, "COMPLETED");
      assert.equal(navigatedUrl, "http://127.0.0.1:3000/next");

      assert.ok(
        browserEvents.some(
          (e) => e.type === "approval_requested" && e.correlation?.origin === "agent" && e.correlation.taskId === "task-nav-1"
        ),
        "approval_requested emitted with agent taskId"
      );
      assert.ok(
        browserEvents.some((e) => e.type === "approval_resolved" && e.details.approved === true),
        "approval_resolved (approved=true) emitted"
      );

      // 4b: PLAN mode browser_navigate is DENIED immediately and emits correlated action_denied
      browserEvents.length = 0;
      const providerDeny = new ScriptedModelProvider([
        {
          model: "scripted",
          message: { role: "assistant", content: "Attempting navigate in PLAN." },
          toolCalls: [
            { id: "c2", name: "browser_navigate", arguments: { url: "http://127.0.0.1:3000/blocked" } },
          ],
        },
        {
          model: "scripted",
          message: { role: "assistant", content: "Blocked as expected." },
          toolCalls: [],
        },
      ]);
      const runner2 = new AgentRunner({
        provider: providerDeny,
        registry,
        permissionEvaluator: classifyPermission,
        eventFactory,
      });
      const res2 = await runner2.run({
        task: { id: "task-nav-2", mode: "PLAN", instruction: "Try navigate" },
        workspaceRoot: tmp,
        maxTurns: 5,
        contextBudget: budget,
        projectInstructions: [],
      });
      assert.equal(res2.status, "COMPLETED");
      assert.ok(
        browserEvents.some((e) => e.type === "action_denied" && e.details.tool === "browser_navigate"),
        "Denied browser tool in PLAN mode emits action_denied"
      );
    } finally {
      await mgr.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("5. BoundedObservationJournal enforces opt-in recording, retention bounds, and structural non-capture flags", () => {
    const journal = new BoundedObservationJournal({ maxFacts: 5, maxInferences: 5, maxUnknowns: 5 });
    assert.equal(journal.isRecordingEnabled(), false);
    assert.equal(
      journal.recordInference({ hypothesis: "Ignored while off", confidence: "low", supportingFactIds: [] }),
      null
    );
    assert.equal(
      journal.recordUnknown({
        area: "backend_handler",
        description: "Ignored while off",
        reasonUnobservable: "Off",
      }),
      null
    );

    journal.setRecordingEnabled(true);
    for (let i = 0; i < 7; i++) {
      journal.recordFact({
        kind: "route_visited",
        sessionId: "sess_j",
        url: `http://127.0.0.1:3000/page-${i}?secret=LeakMeNot${i}`,
        summary: `Visited route ${i}`,
      });
    }

    const snap = journal.snapshot();
    assert.equal(snap.retention.retainedFacts, 5);
    assert.equal(snap.retention.droppedFacts, 2);
    for (const f of snap.observedFacts) {
      assert.equal(f.responseBodyRecorded, false);
      assert.equal(f.credentialsRecorded, false);
      assert.equal(f.browserStorageRecorded, false);
      assert.equal(f.sanitizedUrl?.includes("LeakMeNot"), false, "Query secret redacted in journal URL");
    }
  });
});
