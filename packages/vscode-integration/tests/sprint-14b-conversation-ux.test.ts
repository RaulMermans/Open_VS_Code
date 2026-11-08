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
    if (child) this.children.push(child);
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
    runId: "run-pass",
    appliedMutations: [{ path: "src/add.ts", status: "APPLIED" }],
    reviews: [{ kind: "command", status: "succeeded", path: "npm test", runId: "run-pass" }],
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
  assert.match(notRun.content, /Verification was not executed\./);
  assert.doesNotMatch(notRun.content, /Tests passed/);

  const failed = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "VERIFICATION_FAILED",
    finalAnswer: "The edit is applied and tests passed.",
    runId: "run-fail",
    appliedMutations: [{ path: "src/add.ts", status: "APPLIED" }],
    reviews: [{ kind: "command", status: "failed", scriptName: "test", runId: "run-fail" }],
  });
  assert.match(failed.content, /Task failed \(VERIFICATION_FAILED\)/);
  assert.equal(failed.lastStatus, "failed");
  assert.match(failed.content, /Tests failed\./);
  assert.match(failed.content, /Unsupported claim/);
  assert.doesNotMatch(failed.content, /Task completed/);
});

test("rejection names only the proposed file and cancellation is not success", () => {
  const rejected = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "REJECTED",
    finalAnswer: "The requested edit was applied.",
    runId: "run-reject",
    reviews: [{ kind: "mutation", status: "rejected", path: "src/add.ts", runId: "run-reject" }],
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
  assert.equal(groups.find((group) => group.category === "consult")?.title, "Consulting the model");
  assert.equal(groups.some((group) => group.title === "Planning changes"), false);

  const root = new MockElement("div");
  renderActivityTimeline(root, activities, mockDoc());
  const summaryText = labels(root, "activity-label").join("\n");
  assert.match(summaryText, /Reading files failed/);
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

test("a check is classified from the command that ran, not from a successful exit alone", () => {
  const lint = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "Lint is clean.",
    runId: "run-lint",
    reviews: [{ kind: "command", status: "succeeded", scriptName: "lint", command: "npm run lint", runId: "run-lint" }],
  });
  assert.match(lint.content, /Lint passed\./);
  assert.doesNotMatch(lint.content, /Tests passed/);
  assert.doesNotMatch(lint.content, /Unsupported claim/);

  const types = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "VERIFICATION_FAILED",
    finalAnswer: "Typecheck passed.",
    runId: "run-types",
    reviews: [{ kind: "command", status: "failed", scriptName: "typecheck", runId: "run-types" }],
  });
  assert.match(types.content, /Typecheck failed\./);
  assert.match(types.content, /Unsupported claim/);

  const other = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "The command finished.",
    runId: "run-other",
    reviews: [{ kind: "command", status: "succeeded", command: "echo ok", runId: "run-other" }],
  });
  assert.match(other.content, /Other checks completed\./);
  assert.doesNotMatch(other.content, /Tests passed/);

  const rejected = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "I did not run it.",
    runId: "run-rejected-check",
    reviews: [{ kind: "command", status: "rejected", scriptName: "test", runId: "run-rejected-check" }],
  });
  assert.match(rejected.content, /Verification was rejected\./);
  assert.doesNotMatch(rejected.content, /Tests passed/);

  const interrupted = formatTerminalTaskMessage({
    status: "FAILED",
    failureReason: "INTERRUPTED",
    finalAnswer: "Checks passed.",
    runId: "run-interrupted",
    reviews: [{ kind: "command", status: "interrupted", command: "npm test", runId: "run-interrupted" }],
  });
  assert.match(interrupted.content, /Verification was interrupted\./);
  assert.match(interrupted.content, /Unsupported claim/);
});

test("two sequential tasks keep the earlier run's files and checks out of the later answer", () => {
  const shared = [
    { kind: "mutation", status: "applied", path: "src/old.ts", runId: "run-a" },
    { kind: "command", status: "succeeded", scriptName: "test", command: "npm test", runId: "run-a" },
    { kind: "mutation", status: "applied", path: "src/new.ts", runId: "run-b" },
    { kind: "command", status: "failed", scriptName: "lint", command: "npm run lint", runId: "run-b" },
  ];
  const first = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "I updated the adder.",
    runId: "run-a",
    appliedMutations: [{ path: "src/old.ts", status: "APPLIED" }],
    reviews: shared,
  });
  assert.match(first.content, /src\/old\.ts/);
  assert.match(first.content, /Tests passed\./);
  assert.doesNotMatch(first.content, /src\/new\.ts|Lint failed/);

  const second = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "The explanation is above. Tests passed.",
    runId: "run-b",
    reviews: shared,
  });
  assert.match(second.content, /src\/new\.ts/);
  assert.match(second.content, /Lint failed\./);
  assert.match(second.content, /Unsupported claim/);
  assert.doesNotMatch(second.content, /src\/old\.ts/);
  assert.doesNotMatch(second.content.split("Verified outcome")[1] || "", /Tests passed/);

  const third = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "Nothing in this run wrote a file.",
    runId: "run-c",
    reviews: shared,
  });
  assert.equal(third.content, "Nothing in this run wrote a file.");

  const uncorrelated = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "Once the tests pass, the file can be merged. Tests will pass after the fix.",
    appliedMutations: [{ path: "src/add.ts", status: "APPLIED" }],
    reviews: [
      { kind: "command", status: "succeeded", scriptName: "test", command: "npm test" },
      { kind: "mutation", status: "applied", path: "src/old.ts", runId: "run-a" },
    ],
  });
  assert.match(uncorrelated.content, /Changed:\n- src\/add\.ts/);
  assert.match(uncorrelated.content, /Verification was not executed\./);
  assert.doesNotMatch(uncorrelated.content, /Tests passed|src\/old\.ts|Unsupported claim/);

  const pastClaim = formatTerminalTaskMessage({
    status: "COMPLETED",
    finalAnswer: "The tests passed.",
    runId: "run-empty",
    reviews: [{ kind: "command", status: "succeeded", scriptName: "test", runId: "run-other" }],
  });
  assert.match(pastClaim.content, /Unsupported claim/);
  assert.doesNotMatch(pastClaim.content, /Tests passed/);
});

test("planning is titled only when the activity carries plan evidence", () => {
  const ask = summarizeActivities([
    { id: "m", kind: "model", label: "Waiting for the model", status: "pending" },
    { id: "g", kind: "tool", label: "Running grep", status: "completed", toolName: "grep" },
  ]);
  assert.equal(ask.find((group) => group.category === "consult")?.title, "Consulting the model");
  assert.equal(ask.find((group) => group.category === "explore")?.title, "Exploring the repository");
  assert.equal(ask.some((group) => group.title === "Planning changes"), false);

  const plan = summarizeActivities([
    { id: "m", kind: "model", label: "Waiting for the model", status: "pending", planning: true, runId: "run-plan" },
  ]);
  assert.equal(plan[0]?.title, "Planning changes");
  const root = new MockElement("div");
  renderActivityTimeline(root, [
    { id: "m", kind: "model", label: "Waiting for the model", status: "pending", planning: true, runId: "run-plan" },
  ], mockDoc());
  assert.equal(root.querySelector("details")?.open, false);
  assert.match(labels(root, "activity-label").join("\n"), /run-plan/);
});
