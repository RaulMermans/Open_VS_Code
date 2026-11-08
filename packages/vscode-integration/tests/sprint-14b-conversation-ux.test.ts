import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  renderActivityTimeline,
  renderChatMessage,
  summarizeActivities,
  webviewRenderRuntime,
} from "../src/webview-render-helpers.ts";
import { activityFromAgentEvent, formatTerminalTaskMessage } from "../src/chat-ux-model.ts";

class MockElement {
  public textContent = "";
  public className = "";
  public children: MockElement[] = [];
  public attrs: Record<string, string> = {};
  public open = false;
  constructor(public tagName = "div") {}
  set innerHTML(val: string) { if (val === "") this.children = []; }
  get innerHTML() { return ""; }
  appendChild(child: MockElement) {
    child && this.children.push(child);
    return child;
  }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name]; }
  querySelector(selector: string): MockElement | null {
    const want = selector.replace(/^\./, "");
    const walk = (node: MockElement): MockElement | null => {
      if (node.className.split(" ").includes(want) || node.tagName === want) return node;
      for (const child of node.children) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
}

function mockDoc() {
  return { createElement: (tag: string) => new MockElement(tag) };
}

function labels(root: MockElement, className: string): string[] {
  const found: string[] = [];
  const walk = (node: MockElement) => {
    if (node.className.split(" ").includes(className)) found.push(node.textContent);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

test("a conversational answer stays prose and does not invent files or tests", () => {
  const answer = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "Hola. Puedo revisar el archivo si me dices cuál.",
  });
  assert.equal(answer.lastStatus, "completed");
  assert.equal(answer.content, "Hola. Puedo revisar el archivo si me dices cuál.");
  assert.doesNotMatch(answer.content, /```/);
  assert.doesNotMatch(answer.content, /Verified outcome|Tests passed|Changed:/);
});

test("verified files and tests come only from runtime facts", () => {
  const passed = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "I updated the adder.",
    appliedMutations: [{ path: "src/add.ts", status: "APPLIED" }],
    reviews: [{ kind: "command", status: "succeeded", path: "npm test" }],
  });
  assert.match(passed.content, /I updated the adder\./);
  assert.match(passed.content, /Changed:\n- src\/add\.ts/);
  assert.match(passed.content, /Tests passed\./);
  assert.doesNotMatch(passed.content, /npm test/);

  const notRun = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "The edit is applied.",
    appliedMutations: [{ path: "src/add.ts", status: "APPLIED" }],
  });
  assert.match(notRun.content, /Tests were not run\./);
  assert.doesNotMatch(notRun.content, /Tests passed/);

  const failed = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "VERIFICATION_FAILED",
    finalAnswer: "The edit is applied and tests passed.",
    appliedMutations: [{ path: "src/add.ts", status: "APPLIED" }],
    reviews: [{ kind: "command", status: "failed" }],
  });
  assert.match(failed.content, /Task failed \(VERIFICATION_FAILED\)/);
  assert.equal(failed.lastStatus, "failed");
  assert.match(failed.content, /Tests failed\./);
  assert.doesNotMatch(failed.content, /Task completed/);
});

test("rejection names only the proposed file and cancellation is not success", () => {
  const rejected = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "REJECTED",
    finalAnswer: "The requested edit was applied.",
    reviews: [{ kind: "mutation", status: "rejected", path: "src/add.ts" }],
  });
  assert.equal(rejected.lastStatus, "rejected");
  assert.match(rejected.content, /Change rejected — no files modified\./);
  assert.match(rejected.content, /Not applied: src\/add\.ts/);
  assert.doesNotMatch(rejected.content, /The requested edit was applied/);

  const cancelled = formatTerminalTaskMessage({
    status: "CANCELLED",
    finalAnswer: "Task completed successfully. Tests passed.",
  });
  assert.equal(cancelled.content, "Task cancelled.");
  assert.equal(cancelled.lastStatus, "cancelled");
});

test("activity groups real events and keeps the raw trace collapsed", () => {
  const activities = [
    activityFromAgentEvent({ type: "task.started", payload: { task: { id: "task-14b" } } }, "a1"),
    activityFromAgentEvent({ type: "tool.completed", payload: { name: "read_file", path: "src/a.ts" } }, "a3"),
    activityFromAgentEvent({ type: "tool.failed", payload: { name: "read_file", path: "src/b.ts" } }, "a5"),
    activityFromAgentEvent({ type: "model.requested" }, "a6"),
  ].filter((item) => item !== null);

  const groups = summarizeActivities(activities);
  assert.equal(groups[0]?.title, "Understanding the request");
  const reading = groups.find((group) => group.category === "read");
  assert.equal(reading?.status, "failed");
  assert.match(reading?.detail || "", /src\/a\.ts/);
  assert.match(reading?.detail || "", /src\/b\.ts/);
  assert.equal(groups.find((group) => group.category === "review")?.title, "Planning changes");

  const root = new MockElement("div");
  renderActivityTimeline(root, activities, mockDoc());
  const summaryText = labels(root, "activity-label").join("\n");
  assert.match(summaryText, /Reading relevant files failed/);
  assert.match(summaryText, /read_file failed — src\/b\.ts/);
  const trace = root.querySelector("details");
  assert.equal(trace?.className, "activity-trace");
  assert.equal(trace?.open, false);
  assert.match(summaryText, /task-14b/);
});

test("hostile model text is rendered as text", () => {
  const root = new MockElement("div");
  const hostile = "See <img src=x onerror=alert(1)> and <script>alert(1)</script>";
  renderChatMessage(root, { id: "m1", role: "assistant", content: hostile }, mockDoc());
  const body = root.querySelector("message-body");
  assert.equal(body?.textContent, hostile);
  assert.equal(body?.children.length, 0);
  const runtime = webviewRenderRuntime();
  assert.match(runtime, /function summarizeActivities/);
  assert.match(runtime, /function renderActivityTimeline/);
});
