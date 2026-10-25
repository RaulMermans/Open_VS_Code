// Sprint 7D — IDE responsiveness, performance and UX hardening.
import { test, describe, before } from "node:test";
import * as assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootChatWebview, liveListenerCount, walk, type FakeElement } from "./helpers/fake-webview.ts";
import { MockTextDocument, Pos, Rng, syntheticSource } from "./helpers/text-document.ts";

let activeEditor: any = null;
class InlineItem { command?: any; constructor(public insertText: string, public range: any) {} }
class InlineList { constructor(public items: any[]) {} }
const mockVscode: any = {
  Position: Pos,
  Range: Rng,
  InlineCompletionItem: InlineItem,
  InlineCompletionList: InlineList,
  EventEmitter: class { event() { return () => {}; } fire() {} dispose() {} },
  window: {
    get activeTextEditor() { return activeEditor; },
    showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined, showTextDocument: async () => {},
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
  commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose() {} }) },
  languages: { registerInlineCompletionItemProvider: () => ({ dispose() {} }) },
  env: { clipboard: { writeText: async () => {} } },
  workspace: {
    isTrusted: true, workspaceFolders: [] as any[], textDocuments: [] as any[],
    asRelativePath: (uri: any) => String(uri?.toString?.() ?? uri).replace(/^file:\/\/\/workspace\//, ""),
  },
  Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }) },
};
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string) {
  if (request === "vscode") return "vscode";
  return originalResolve.apply(this, arguments);
};
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "vscode") return mockVscode;
  return originalRequire.apply(this, arguments);
};

let ChatController: any;
let ChatViewProvider: any;
let Store: any;
let S: any;
let AutocompleteController: any;
let editorTextAround: any;
let coalesceRefresh: any;
let AC: any;

before(() => {
  const req = createRequire(import.meta.url);
  ChatController = req("../src/chat-controller.ts").ChatController;
  ChatViewProvider = req("../src/chat-view-provider.ts").ChatViewProvider;
  S = req("../src/conversation-store.ts");
  Store = S.ConversationStore;
  ({ AutocompleteController, editorTextAround } = req("../src/autocomplete-controller.ts"));
  coalesceRefresh = req("../src/extension.ts").coalesceRefresh;
  AC = req("@open-vs-code/agent-core");
});

// ---- helpers ---------------------------------------------------------------

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const cid = (n: number) => "c-" + n.toString(16).padStart(16, "0");
const WS = "w-eeeeeeeeeeeeeeeeeeeeeeee";
const tick = () => new Promise((r) => setImmediate(r));
const completedTurn = async () => ({ status: "COMPLETED", finalAnswer: "done" });
const storedMessages = (p: string) => Array.from({ length: 40 }, (_, i) => ({ id: p + i, role: i % 2 ? "assistant" : "user", content: p + " " + i, timestamp: i }));
const prefixSnapshot = (character: number, documentVersion: number) => ({ rawPrefix: "function main() {\n  return value".slice(0, 18 + character), rawSuffix: "", languageId: "typescript", relativePath: "a.ts", documentVersion, cursorLine: 1, cursorCharacter: character });
const multibyteBody = (charset: "cjk" | "escapes", n: number) => (charset === "cjk" ? "漢字のテスト文章です。" : "\x1b[0m\x01\x02\x03\x04\x05\x06").repeat(400).slice(0, n);
/** Waits for a condition, failing (never hanging) after a deadline. */
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await tick();
  }
}

function html(): string {
  let out = "";
  new ChatViewProvider({ fsPath: "/ext" }, { setWebviewView: () => {} })
    .resolveWebviewView({ webview: { options: {}, set html(v: string) { out = v; }, get html() { return out; } } } as any, {} as any, {} as any);
  return out;
}

/** Host → page through a JSON round trip, the way VS Code serializes webview messages. */
class PipeWebview {
  posts: any[] = [];
  page?: ReturnType<typeof bootChatWebview>;
  onDidReceiveMessage() { return { dispose() {} }; }
  postMessage(m: any) {
    const copy = JSON.parse(JSON.stringify(m));
    this.posts.push(copy);
    this.page?.deliver(copy);
  }
  states() { return this.posts.filter((p) => p.type === "chat.state"); }
}

function fixture(opts: { page?: boolean; store?: any } = {}) {
  const workspace = tmp("ovsc-7d-ws-");
  mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace }, name: "ws" }];
  let runTask: any = completedTurn;
  const host = {
    getSnapshot: async () => ({ workspaceRoots: [{ fsPath: workspace }], diagnostics: [], visibleDocuments: [], isTrusted: true }),
    showOutput: async () => {}, showError: async () => {}, openWorkspaceFile: async () => {},
  };
  const controller = new ChatController(host, () => ({ runTask: (i: string, m: string, s: AbortSignal, on: any, t: any) => runTask(i, m, s, on, t) }));
  const webview = new PipeWebview();
  if (opts.page) webview.page = bootChatWebview(html());
  controller.setWebviewView({ webview } as any);
  return { controller, webview, workspace, setRunTask: (fn: any) => { runTask = fn; } };
}

/** A turn the test drives event by event. */
function scriptedTurn(fx: ReturnType<typeof fixture>, text = "go") {
  const ctl: any = {};
  const done = new Promise<any>((resolve) => { ctl.finish = resolve; });
  fx.setRunTask(async (_i: string, _m: string, signal: AbortSignal, onEvent: any) => { ctl.onEvent = onEvent; ctl.signal = signal; return done; });
  ctl.turn = fx.controller.handleWebviewMessage({ type: "chat.send", text, mode: "BUILD" });
  return ctl;
}

const pageTranscript = (page: ReturnType<typeof bootChatWebview>) =>
  page.byId.transcript.children.map((el: FakeElement) => el.getAttribute("data-message-id"));
const hostTranscript = (fx: ReturnType<typeof fixture>) => fx.controller.getState().messages.map((m: any) => m.id);
const button = (root: FakeElement, label: string) => walk(root).find((e) => e.tagName === "button" && e.textContent === label);

function bigState(extra: Record<string, unknown> = {}) {
  return {
    conversationId: cid(1), conversationTitle: "T", lastStatus: "running", mode: "BUILD",
    messages: Array.from({ length: 30 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", content: "message " + i, timestamp: i })),
    activities: [{ id: "a1", kind: "tool", label: "Read file", status: "completed" }],
    reviews: [], conversations: [], context: [{ id: "implicit:active-file", kind: "active-file", label: "src/a.ts", path: "src/a.ts" }],
    attachments: [], connection: { state: "ready", backend: "standalone-local", healthChecked: true },
    history: { enabled: true }, activeTurn: true,
    pendingConfirmation: { id: "conf-1", riskLabel: "File change", summary: "Update src/a.ts", mutationId: "mut-1", path: "src/a.ts", mutation: { operation: "update", linesAdded: 1, linesRemoved: 1 } },
    ...extra,
  };
}

// ---- host: posting ---------------------------------------------------------

describe("Sprint 7D host posting", () => {
  test("1. identical editor context posts nothing; a real change posts once", () => {
    const fx = fixture();
    const snap = { activeDocument: { workspaceRelativePath: "src/a.ts" }, selection: null, diagnostics: [], workspaceRoots: [{}] };
    fx.controller.refreshContext(snap);
    const postsBefore = fx.webview.states().length;
    for (let i = 0; i < 500; i++) fx.controller.refreshContext(snap);
    assert.equal(fx.webview.states().length, postsBefore, "cursor moves in the same file post nothing");
    assert.equal(fx.controller.uiMetrics.contextRefreshesSkipped, 500);
    fx.controller.refreshContext({ ...snap, selection: { selectedText: "x" } });
    assert.equal(fx.webview.states().length, postsBefore + 1, "a new selection chip is posted");
    assert.deepEqual(fx.controller.getState().context.map((c: any) => c.id), ["implicit:active-file", "implicit:selection", "implicit:workspace"]);
  });

  test("2. an unchanged transcript is omitted; everything else in the state is still sent", async () => {
    const fx = fixture();
    const ctl = scriptedTurn(fx, "first");
    await until(() => !!ctl.onEvent, "the turn to start");
    const n = fx.webview.posts.length;
    ctl.onEvent({ type: "tool.requested", payload: { name: "read_file" } });
    const post = fx.webview.posts[n];
    assert.equal(post.type, "chat.state");
    assert.equal(post.transcript, "unchanged");
    assert.equal(post.state.messages, undefined);
    const full = { ...fx.controller.getState() };
    delete full.messages;
    assert.deepEqual(post.state, JSON.parse(JSON.stringify(full)), "only the transcript is left out");
    ctl.finish({ status: "COMPLETED", finalAnswer: "answer" });
    await ctl.turn;
    const last = fx.webview.states().at(-1);
    assert.equal(last.transcript, undefined, "a new message carries the transcript");
    assert.deepEqual(last.state.messages.map((m: any) => m.content), ["first", "answer"]);
  });

  test("3. a status change of an existing message is re-sent", async () => {
    const fx = fixture();
    fx.controller.getState().messages.push({ id: "x1", role: "assistant", content: "hi", timestamp: 1, status: "pending" });
    fx.controller.handleWebviewMessage({ type: "chat.setMode", mode: "PLAN" });
    fx.controller.handleWebviewMessage({ type: "chat.setMode", mode: "ASK" });
    assert.equal(fx.webview.states().at(-1).transcript, "unchanged");
    fx.controller.getState().messages[0].status = "failed";
    fx.controller.handleWebviewMessage({ type: "chat.setMode", mode: "PLAN" });
    const last = fx.webview.states().at(-1);
    assert.equal(last.transcript, undefined);
    assert.equal(last.state.messages[0].status, "failed");
  });

  test("4. a new view, a page reload (chat.ready) and a conversation reset each get the full transcript", async () => {
    const fx = fixture();
    await fx.controller.handleWebviewMessage({ type: "chat.send", text: "hello", mode: "ASK" });
    fx.controller.handleWebviewMessage({ type: "chat.setMode", mode: "ASK" });
    assert.equal(fx.webview.states().at(-1).transcript, "unchanged");
    await fx.controller.handleWebviewMessage({ type: "chat.ready" });
    assert.equal(fx.webview.states().at(-1).state.messages.length, 2, "reloaded page gets the transcript");
    const second = new PipeWebview();
    fx.controller.setWebviewView({ webview: second } as any);
    assert.equal(second.states().at(-1).state.messages.length, 2, "a new view gets the transcript");
    await fx.controller.handleWebviewMessage({ type: "chat.newConversation" });
    const reset = second.posts.findIndex((p) => p.type === "conversation.reset");
    assert.ok(reset >= 0);
    assert.deepEqual(second.posts[reset + 1].state.messages, [], "the state after a reset carries its (empty) transcript");
  });

  test("5. the real page keeps an exact transcript through a long turn, a reset and a reload", async () => {
    const fx = fixture({ page: true });
    const page = fx.webview.page!;
    const ctl = scriptedTurn(fx, "refactor");
    await until(() => !!ctl.onEvent, "the turn to start");
    for (let i = 0; i < 60; i++) {
      ctl.onEvent({ type: "model.requested", payload: {} });
      ctl.onEvent({ type: "model.completed", payload: {} });
      ctl.onEvent({ type: "tool.requested", payload: { name: "read_file" } });
      ctl.onEvent({ type: "tool.completed", payload: { name: "read_file" } });
      assert.deepEqual(pageTranscript(page), hostTranscript(fx));
    }
    ctl.finish({ status: "COMPLETED", finalAnswer: "done" });
    await ctl.turn;
    assert.deepEqual(pageTranscript(page), hostTranscript(fx));
    const omitted = fx.webview.states().filter((p) => p.transcript === "unchanged").length;
    assert.ok(omitted >= 200, `most of the turn's posts omit the transcript (${omitted})`);
    await fx.controller.handleWebviewMessage({ type: "chat.newConversation" });
    assert.deepEqual(pageTranscript(page), []);
    await fx.controller.handleWebviewMessage({ type: "chat.send", text: "again", mode: "ASK" });
    assert.deepEqual(pageTranscript(page), hostTranscript(fx));
    fx.webview.page = bootChatWebview(html()); // the webview reloads
    await fx.controller.handleWebviewMessage({ type: "chat.ready" });
    assert.deepEqual(pageTranscript(fx.webview.page), hostTranscript(fx));
  });

  test("6. switching between stored conversations shows each transcript exactly", async () => {
    const root = tmp("ovsc-7d-switch-");
    const seed = new Store({ storageRoot: root, workspaceId: WS });
    await seed.load();
    await seed.save({ id: cid(1), createdAt: 1, updatedAt: 2, mode: "ASK", messages: storedMessages("a"), attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
    await seed.save({ id: cid(2), createdAt: 1, updatedAt: 1, mode: "ASK", messages: storedMessages("b"), attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
    const fx = fixture({ page: true });
    await fx.controller.attachConversationStore(new Store({ storageRoot: root, workspaceId: WS }));
    for (let i = 0; i < 20; i++) {
      await fx.controller.openConversation(i % 2 ? cid(1) : cid(2));
      assert.deepEqual(pageTranscript(fx.webview.page!), hostTranscript(fx));
      assert.equal(pageTranscript(fx.webview.page!)[0], i % 2 ? "a0" : "b0");
    }
  });
});

// ---- host: activity and metrics -------------------------------------------

describe("Sprint 7D activity accuracy, bounds and metrics", () => {
  test("7. a model response resolves its request row; nothing stays pending after it finished", async () => {
    const fx = fixture();
    const ctl = scriptedTurn(fx);
    await until(() => !!ctl.onEvent, "the turn to start");
    ctl.onEvent({ type: "model.requested", payload: {} });
    ctl.onEvent({ type: "model.completed", payload: {} });
    ctl.onEvent({ type: "tool.requested", payload: { name: "read_file" } });
    ctl.onEvent({ type: "tool.completed", payload: { name: "read_file" } });
    const acts = fx.controller.getState().activities;
    assert.deepEqual(acts.map((a: any) => [a.kind, a.status, a.label]), [
      ["task", "pending", "Starting task"].slice(0, 0).length ? [] : ["model", "completed", "Model responded"],
      ["tool", "completed", "read_file completed"],
    ].filter((x) => x.length));
    ctl.onEvent({ type: "model.requested", payload: {} });
    ctl.onEvent({ type: "model.failed", payload: {} });
    assert.equal(fx.controller.getState().activities.at(-1).label, "Model request failed");
    assert.equal(fx.controller.getState().activities.filter((a: any) => a.status === "pending").length, 0);
    ctl.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await ctl.turn;
  });

  test("8. a long turn keeps at most 50 activity rows, even with many pending ones", async () => {
    const fx = fixture();
    const ctl = scriptedTurn(fx);
    await until(() => !!ctl.onEvent, "the turn to start");
    for (let i = 0; i < 500; i++) {
      ctl.onEvent({ type: "model.requested", payload: {} });
      ctl.onEvent({ type: "model.completed", payload: {} });
    }
    assert.ok(fx.controller.getState().activities.length <= 50);
    for (let i = 0; i < 80; i++) ctl.onEvent({ type: "permission.requested", payload: {} });
    const acts = fx.controller.getState().activities;
    assert.ok(acts.length <= 50, `bounded with ≥ 50 pending rows (${acts.length})`);
    assert.ok(acts.every((a: any) => a.status === "pending"), "the newest pending rows are the ones kept");
    assert.ok(fx.controller.uiMetrics.peakActivities <= 50);
    ctl.finish({ status: "COMPLETED", finalAnswer: "ok" });
    await ctl.turn;
  });

  test("9. metrics are numbers only, copied on read, and record turns, cancellation and saves", async () => {
    const root = tmp("ovsc-7d-metrics-");
    const fx = fixture();
    await fx.controller.attachConversationStore(new Store({ storageRoot: root, workspaceId: WS }));
    const ctl = scriptedTurn(fx, "cancel me");
    await until(() => !!ctl.onEvent, "the turn to start");
    ctl.signal.addEventListener("abort", () => setTimeout(() => ctl.finish({ status: "CANCELLED" }), 5));
    fx.controller.cancelTurn();
    await ctl.turn;
    await fx.controller.flushPersistence();
    const m = fx.controller.uiMetrics;
    for (const [k, v] of Object.entries(m)) assert.equal(typeof v, "number", k);
    assert.equal(m.turns, 1);
    assert.ok(m.lastCancelLatencyMs >= 0, "cancel latency recorded");
    assert.ok(m.saves >= 2 && m.maxSaveMs >= m.lastSaveMs);
    assert.ok(m.statePosts >= m.transcriptPosts && m.transcriptPosts >= 1);
    (m as any).turns = 99;
    assert.equal(fx.controller.uiMetrics.turns, 1, "the getter returns a copy");
    assert.equal(fx.controller.getState().activeTurn, false);
    assert.equal(fx.controller.getState().lastStatus, "cancelled");
  });
});

// ---- webview page ----------------------------------------------------------

describe("Sprint 7D webview rendering", () => {
  test("10. an unchanged push creates no elements and adds no listeners", () => {
    const w = bootChatWebview(html());
    w.deliver({ type: "chat.state", state: bigState() });
    w.dom.resetCounters();
    for (let i = 0; i < 100; i++) w.deliver({ type: "chat.state", state: bigState(), transcript: "unchanged" });
    assert.deepEqual(w.dom.counters, { created: 0, listenersAdded: 0, scrollWrites: 0, layoutReads: 0 });
  });

  test("11. keyboard focus on an approval card survives unrelated pushes, and so does the click lock", () => {
    const w = bootChatWebview(html());
    w.deliver({ type: "chat.state", state: bigState() });
    const reject = button(w.byId["confirmation-container"], "Reject")!;
    reject.focus();
    w.deliver({ type: "chat.state", state: bigState({ activities: [{ id: "a2", kind: "model", label: "Model responded", status: "completed" }], connection: { state: "running", backend: "standalone-local" } }), transcript: "unchanged" });
    assert.equal(w.dom.activeElement, reject, "focus stays on Reject");
    const approve = button(w.byId["confirmation-container"], "Approve")!;
    approve.click();
    const posted = w.posted.filter((m) => m.type === "confirmation.respond").length;
    w.deliver({ type: "chat.state", state: bigState(), transcript: "unchanged" });
    assert.equal(button(w.byId["confirmation-container"], "Approve"), approve, "same card");
    assert.equal(approve.disabled, true, "still locked");
    approve.click();
    assert.equal(w.posted.filter((m) => m.type === "confirmation.respond").length, posted, "no second decision");
    w.deliver({ type: "chat.state", state: bigState({ pendingConfirmation: undefined, activeTurn: false }) });
    assert.equal(w.byId["confirmation-container"].children.length, 0, "a resolved request removes the card");
  });

  test("12. the connection status (a live region) is not rebuilt unless it changes", () => {
    const w = bootChatWebview(html());
    w.deliver({ type: "chat.state", state: bigState() });
    const status = w.byId["connection-status"].children[0];
    w.deliver({ type: "chat.state", state: bigState(), transcript: "unchanged" });
    assert.equal(w.byId["connection-status"].children[0], status);
    w.deliver({ type: "chat.state", state: bigState({ connection: { state: "disconnected", backend: "standalone-local" } }), transcript: "unchanged" });
    assert.notEqual(w.byId["connection-status"].children[0], status);
    assert.match(w.byId["connection-status"].children[0].textContent, /Disconnected/);
  });

  test("13. new messages follow the bottom only when the reader is there, or just sent", () => {
    const w = bootChatWebview(html());
    const t = w.byId.transcript;
    const idle = (extra: Record<string, unknown> = {}) => bigState({ activeTurn: false, pendingConfirmation: undefined, ...extra });
    w.deliver({ type: "chat.state", state: idle() });
    assert.ok(t.scrollTop > 0, "first render shows the latest messages");
    t.scrollTop = 0;
    t.fire("scroll"); // the reader scrolls up
    const more = bigState().messages.concat([{ id: "m30", role: "assistant", content: "new", timestamp: 30 }]);
    w.deliver({ type: "chat.state", state: idle({ messages: more }) });
    assert.equal(t.scrollTop, 0, "reading position kept");
    w.byId.composer.value = "follow-up";
    w.byId["send-btn"].click();
    const mine = more.concat([{ id: "m31", role: "user", content: "follow-up", timestamp: 31 }]);
    w.deliver({ type: "chat.state", state: idle({ messages: mine }) });
    assert.ok(t.scrollTop > 0, "sending scrolls to the new message");
  });

  test("14. a message's visible status label follows status changes", () => {
    const w = bootChatWebview(html());
    const msg = { id: "q1", role: "assistant", content: "working", timestamp: 1, status: "pending", inherited: true };
    w.deliver({ type: "chat.state", state: bigState({ messages: [msg] }) });
    const el = w.byId.transcript.children[0];
    const meta = () => el.children.find((c: FakeElement) => c.className === "message-meta")!.textContent;
    assert.equal(meta(), "Assistant · from an earlier conversation");
    w.deliver({ type: "chat.state", state: bigState({ messages: [{ ...msg, status: "failed", content: "it failed" }] }) });
    assert.equal(w.byId.transcript.children[0], el, "updated in place");
    assert.equal(meta(), "Assistant · failed · from an earlier conversation");
    assert.match(el.className, /is-failed/);
    assert.match(el.className, /is-inherited/);
  });

  test("15. a reset clears the timeline and the card, and the next identical state renders again", () => {
    const w = bootChatWebview(html());
    const s = bigState();
    w.deliver({ type: "chat.state", state: s });
    w.deliver({ type: "conversation.reset" });
    assert.equal(w.byId.activities.children.length, 0);
    assert.equal(w.byId["confirmation-container"].children.length, 0);
    assert.equal(w.byId.transcript.children.length, 0);
    w.deliver({ type: "chat.state", state: s });
    assert.equal(w.byId.activities.children.length, 1, "activities rendered again");
    assert.equal(w.byId["confirmation-container"].children.length, 1, "card rendered again");
    assert.equal(w.byId.transcript.children.length, 30);
  });

  test("16. 1000 pushes and 5000 terminal updates leave nodes and listeners bounded", () => {
    const w = bootChatWebview(html());
    w.deliver({ type: "chat.state", state: bigState() });
    const nodes = walk(w.dom.body).length;
    const listeners = liveListenerCount(w.dom);
    let out = "";
    for (let i = 0; i < 5000; i++) {
      if (out.length < 16384) out += "line " + i + "\n";
      w.deliver({ type: "terminal.updated", terminal: { executionId: "e1", command: "npm test", status: "RUNNING", startedAt: 1, isOutputVisible: true, stdout: out } });
      if (i % 5 === 0) w.deliver({ type: "chat.state", state: bigState({ activities: [{ id: "a" + (i % 3), kind: "tool", label: "Read " + (i % 3), status: "completed" }] }), transcript: "unchanged" });
    }
    const term = walk(w.byId["terminal-container"]).find((e) => e.className === "terminal-output-box")!;
    assert.equal(term.textContent, out);
    assert.ok(walk(w.dom.body).length <= nodes + 40, "DOM stays bounded");
    assert.ok(liveListenerCount(w.dom) <= listeners + 10, "no listener accumulation");
  });

  test("17. untrusted labels stay text in the skipped and re-rendered paths", () => {
    const w = bootChatWebview(html());
    const evil = "<img src=x onerror=alert(1)>";
    w.deliver({ type: "chat.state", state: bigState({
      activities: [{ id: "x", kind: "tool", label: evil, status: "completed" }],
      context: [{ id: "c", kind: "file", label: evil, path: "a.ts" }],
      pendingConfirmation: { id: "c2", riskLabel: evil, summary: evil, mutationId: "m", path: evil },
    }) });
    w.deliver({ type: "chat.state", state: bigState({ activities: [{ id: "x", kind: "tool", label: evil, status: "completed" }] }), transcript: "unchanged" });
    assert.equal(walk(w.dom.body).some((e) => e.tagName === "img"), false);
    assert.ok(walk(w.byId.activities).some((e) => e.textContent === evil));
  });
});

// ---- autocomplete -----------------------------------------------------------

function token() {
  const listeners = new Set<Function>();
  return {
    isCancellationRequested: false,
    listeners,
    onCancellationRequested(fn: Function) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
    cancel() { this.isCancellationRequested = true; for (const fn of listeners) fn(); },
  };
}
function manualScheduler() {
  const pending: Function[] = [];
  return { pending, schedule: (fn: Function) => { pending.push(fn); return { cancel() { const i = pending.indexOf(fn); if (i >= 0) pending.splice(i, 1); } }; } };
}

describe("Sprint 7D autocomplete", () => {
  test("18. the bounded editor window yields exactly the context built from the full text", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const pieces = ["const x = 1;", "  ", "\t", "😀", "漢字", "a", "\n", "\r\n", " ", "}", " "];
    let checked = 0;
    for (let doc = 0; doc < 60; doc++) {
      const crlf = doc % 3 === 0;
      let text = "";
      const len = [200, 9000, 30000][doc % 3];
      while (text.length < len) {
        let p = pieces[rand(pieces.length)];
        if (crlf && p === "\n") p = "\r\n";
        if (!crlf && p === "\r\n") p = "\n";
        text += p;
      }
      const d = new MockTextDocument(text);
      for (let k = 0; k < 8; k++) {
        const pos = d.positionAt(rand(text.length + 1));
        const offset = d.offsetAt(pos);
        const full = { rawPrefix: text.slice(0, offset), rawSuffix: text.slice(offset) };
        const windowed = editorTextAround(d as any, pos as any);
        const base = { languageId: "typescript", relativePath: "src/a.ts", documentVersion: 1, cursorLine: pos.line, cursorCharacter: pos.character };
        assert.deepEqual(AC.buildAutocompleteContext({ ...base, ...windowed }), AC.buildAutocompleteContext({ ...base, ...full }), `doc ${doc} offset ${offset}`);
        checked++;
      }
    }
    assert.equal(checked, 480);
  });

  test("19. a whitespace-only window falls back to the full prefix, so the empty-prefix decision is unchanged", () => {
    const text = "abc" + "\n".repeat(20000);
    const d = new MockTextDocument(text);
    const pos = d.positionAt(text.length);
    const w = editorTextAround(d as any, pos as any);
    assert.equal(w.rawPrefix, text);
    const ctx = AC.buildAutocompleteContext({ ...w, languageId: "typescript", relativePath: "a.ts", documentVersion: 1, cursorLine: pos.line, cursorCharacter: 0 });
    assert.equal(ctx.ok, true);
  });

  test("20. per-keystroke extraction does not grow with the document", async () => {
    const copied: number[] = [];
    for (const size of [100_000, 5_000_000]) {
      const ctrl = new AutocompleteController({ gateway: { complete: () => new Promise(() => {}) }, scheduler: manualScheduler(), debounceMs: 0 });
      const d = new MockTextDocument(syntheticSource(size));
      const pos = d.positionAt(size / 2);
      d.charsCopied = 0;
      void ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, token() as any);
      copied.push(d.charsCopied);
      await ctrl.dispose();
    }
    assert.equal(copied[0], copied[1]);
    assert.ok(copied[1] <= AC.PREFIX_CHAR_CEILING + AC.SUFFIX_CHAR_CEILING + 200, `copied ${copied[1]} chars`);
  });

  test("21. a late cancel of an older request does not cancel the newer one", async () => {
    const sch = manualScheduler();
    const gates: Array<{ resolve: Function }> = [];
    const ctrl = new AutocompleteController({
      gateway: { complete: (r: any) => new Promise((resolve, reject) => { gates.push({ resolve }); r.signal.addEventListener("abort", () => reject(new Error("aborted"))); }) },
      scheduler: sch, debounceMs: 0,
    });
    const d = new MockTextDocument("function main() {\n  return value\n}\n");
    const posA = new Pos(1, 9);
    activeEditor = { document: d, selection: { active: posA } };
    const tA = token();
    const pA = ctrl.provideInlineCompletionItems(d as any, posA as any, {} as any, tA as any);
    await (sch.pending.shift() as Function)();
    d.version++;
    const posB = new Pos(1, 14);
    activeEditor = { document: d, selection: { active: posB } };
    const pB = ctrl.provideInlineCompletionItems(d as any, posB as any, {} as any, token() as any);
    tA.cancel();
    await tick();
    assert.equal(sch.pending.length, 1, "B is still waiting for its debounce");
    const run = (sch.pending.shift() as Function)();
    await until(() => gates.length >= 2, "the second provider call");
    gates[1].resolve({ text: "value + 1", deploymentId: "d", providerId: "p" });
    await run;
    const b = await pB;
    assert.equal(b.items[0].insertText, " + 1", "B completes (the sanitizer strips the echoed prefix)");
    assert.equal(await pA, null);
    assert.equal(ctrl.service.telemetry.cancelled, 1, "A's cancellation is counted once");
    activeEditor = null;
    await ctrl.dispose();
  });

  test("21b. at the service, a superseded request's signal aborted later does not cancel its replacement", async () => {
    // The controller disposes a finished request's token subscription, so through VS Code this
    // path is closed twice; direct service callers pass a raw AbortSignal and rely on this guard.
    const sch = manualScheduler();
    let calls = 0;
    const service = new AC.AutocompleteService({ gateway: { complete: async () => { calls++; return { text: "value + 1", deploymentId: "d", providerId: "p" }; } }, scheduler: sch, debounceMs: 0 });
    const a = new AbortController();
    const pA = service.trigger(prefixSnapshot(9, 1), "file:///a.ts", a.signal);
    const pB = service.trigger(prefixSnapshot(14, 2), "file:///a.ts", new AbortController().signal);
    assert.equal(await pA, null, "A was superseded while still waiting");
    a.abort();
    assert.equal(sch.pending.length, 1, "B's debounce is still scheduled");
    await (sch.pending.shift() as Function)();
    assert.notEqual(await pB, null);
    assert.equal(calls, 1);
    assert.equal(service.telemetry.cancelled, 0, "a superseded request is not counted as a VS Code cancellation");
    await service.dispose();
  });

  test("22. an already-cancelled request never reaches the provider", async () => {
    let calls = 0;
    const ctrl = new AutocompleteController({ gateway: { complete: async () => { calls++; return { text: "x", deploymentId: "d", providerId: "p" }; } }, debounceMs: 0 });
    const d = new MockTextDocument("const value = ");
    const t = token();
    t.cancel();
    assert.equal(await ctrl.provideInlineCompletionItems(d as any, new Pos(0, 14) as any, {} as any, t as any), null);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 0);
    assert.equal(ctrl.service.telemetry.cancelled, 1);
    await ctrl.dispose();
  });

  test("23. rapid typing: one provider call, only the last keystroke can show a completion", async () => {
    const sch = manualScheduler();
    let calls = 0;
    const ctrl = new AutocompleteController({ gateway: { complete: async () => { calls++; return { text: "next();", deploymentId: "d", providerId: "p" }; } }, scheduler: sch, debounceMs: 0 });
    const d = new MockTextDocument(syntheticSource(20_000));
    const results: Promise<any>[] = [];
    let prev: any;
    for (let i = 0; i < 300; i++) {
      prev?.cancel();
      d.version++;
      const pos = d.positionAt(9000 + i);
      activeEditor = { document: d, selection: { active: pos } };
      prev = token();
      results.push(ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, prev));
    }
    while (sch.pending.length) await (sch.pending.shift() as Function)();
    const out = await Promise.all(results);
    assert.equal(calls, 1);
    assert.equal(out.slice(0, -1).every((r) => r === null), true, "no superseded request returns text");
    assert.equal(out[299].items.length, 1);
    activeEditor = null;
    await ctrl.dispose();
  });

  test("24. a result for a moved cursor or an edited document is discarded", async () => {
    for (const change of ["cursor", "version"] as const) {
      const sch = manualScheduler();
      let release!: Function;
      const ctrl = new AutocompleteController({ gateway: { complete: () => new Promise((r) => { release = r; }) }, scheduler: sch, debounceMs: 0 });
      const d = new MockTextDocument("const value = compute(1);\nconst next = ");
      const pos = new Pos(1, 13);
      activeEditor = { document: d, selection: { active: pos } };
      const p = ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, token() as any);
      const run = (sch.pending.shift() as Function)();
      await until(() => !!release, "the provider call");
      if (change === "cursor") activeEditor = { document: d, selection: { active: new Pos(0, 3) } };
      else d.version++;
      release({ text: "value + 1;", deploymentId: "d", providerId: "p" });
      await run;
      assert.equal(await p, null, change);
      assert.equal(ctrl.service.telemetry.staleDiscarded, 1, change);
      activeEditor = null;
      await ctrl.dispose();
    }
  });

  test("25. an unreachable endpoint returns nothing quietly; disabling stops requests; re-enabling resumes", async () => {
    let calls = 0;
    let fail = true;
    const ctrl = new AutocompleteController({ gateway: { complete: async () => { calls++; if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:8080"); return { text: "1;", deploymentId: "d", providerId: "p" }; } }, debounceMs: 0 });
    const d = new MockTextDocument("const value = ");
    const pos = new Pos(0, 14);
    activeEditor = { document: d, selection: { active: pos } };
    assert.equal(await ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, token() as any), null);
    assert.equal(ctrl.service.telemetry.failed, 1);
    ctrl.service.enabled = false;
    assert.equal(await ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, token() as any), null);
    assert.equal(calls, 1, "disabled: no request");
    ctrl.service.enabled = true;
    fail = false;
    const ok = await ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, token() as any);
    assert.equal(ok.items[0].insertText, "1;");
    activeEditor = null;
    await ctrl.dispose();
  });

  test("26. each request releases its cancellation listener", async () => {
    const ctrl = new AutocompleteController({ gateway: { complete: async () => ({ text: "1;", deploymentId: "d", providerId: "p" }) }, debounceMs: 0 });
    const d = new MockTextDocument("const value = ");
    const pos = new Pos(0, 14);
    activeEditor = { document: d, selection: { active: pos } };
    const t = token();
    for (let i = 0; i < 20; i++) await ctrl.provideInlineCompletionItems(d as any, pos as any, {} as any, t as any);
    assert.equal(t.listeners.size, 0);
    activeEditor = null;
    await ctrl.dispose();
  });
});

// ---- persistence -------------------------------------------------------------

describe("Sprint 7D persistence", () => {

  test("27. over the byte cap, the newest messages are kept and the cut is minimal (same as dropping one at a time)", async () => {
    for (const charset of ["cjk", "escapes"] as const) {
      const root = tmp("ovsc-7d-cap-");
      const s = new Store({ storageRoot: root, workspaceId: WS });
      await s.load();
      const messages = Array.from({ length: 100 }, (_, i) => ({ id: "m" + i, role: i % 2 ? "assistant" : "user", content: multibyteBody(charset, 1950), timestamp: i }));
      await s.save({ id: cid(1), createdAt: 1, updatedAt: 2, mode: "ASK", messages, attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
      const file = join(root, "conversations", cid(1) + ".json");
      const bytes = readFileSync(file).length;
      assert.ok(bytes <= S.MAX_RECORD_BYTES, charset);
      const kept = (await s.read(cid(1))).messages;
      assert.ok(kept.length < 100 && kept.length > 1, `${charset}: kept ${kept.length}`);
      assert.deepEqual(kept.map((m: any) => m.id), messages.slice(-kept.length).map((m) => m.id), "oldest dropped first");
      // Minimal: one more message would not have fitted.
      const record = S.sanitizeConversation({ id: cid(1), createdAt: 1, updatedAt: 2, mode: "ASK", messages: messages.slice(-(kept.length + 1)), attachments: [], reviews: [], lastStatus: "completed", runIds: [], archived: false }, WS);
      const { createHash } = await import("node:crypto");
      const withOneMore = JSON.stringify({ ...record, checksum: createHash("sha256").update(AC.canonicalSerialize(record), "utf8").digest("hex") });
      assert.ok(Buffer.byteLength(withOneMore, "utf8") > S.MAX_RECORD_BYTES, `${charset}: cut is minimal`);
    }
  });

  test("28. a single oversized message is still clipped to the cap", async () => {
    const root = tmp("ovsc-7d-one-");
    const s = new Store({ storageRoot: root, workspaceId: WS });
    await s.load();
    await s.save({ id: cid(1), createdAt: 1, updatedAt: 2, mode: "ASK", messages: [{ id: "m0", role: "user", content: multibyteBody("escapes", 50000), timestamp: 1 }], attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
    assert.ok(readFileSync(join(root, "conversations", cid(1) + ".json")).length <= S.MAX_RECORD_BYTES);
    assert.equal((await s.read(cid(1))).messages.length, 1);
  });

  test("29. an interrupted write (leftover temp file) never replaces or corrupts the record", async () => {
    const root = tmp("ovsc-7d-torn-");
    const s = new Store({ storageRoot: root, workspaceId: WS });
    await s.load();
    const rec = { id: cid(1), createdAt: 1, updatedAt: 2, mode: "ASK", messages: [{ id: "m0", role: "user", content: "keep me", timestamp: 1 }], attachments: [], reviews: [], lastStatus: "completed", runIds: [] };
    await s.save(rec);
    const dir = join(root, "conversations");
    const target = join(dir, cid(1) + ".json");
    writeFileSync(target + ".tmp-999-1-deadbeef", '{"schemaVersion":1,"id":"' + cid(1) + '","messa');
    const fresh = new Store({ storageRoot: root, workspaceId: WS });
    const { conversations, issues } = await fresh.load();
    assert.deepEqual(issues, []);
    assert.equal(conversations.length, 1);
    assert.equal((await fresh.read(cid(1))).messages[0].content, "keep me");
    for (let i = 0; i < 30; i++) await fresh.save({ ...rec, updatedAt: 10 + i, messages: [...rec.messages, { id: "n" + i, role: "assistant", content: "r" + i, timestamp: i }] });
    assert.equal((await fresh.read(cid(1))).messages.at(-1).content, "r29");
    assert.equal(readdirSync(dir).filter((n) => n.includes(".tmp-") && !n.includes("deadbeef")).length, 0, "no temp files of our own left behind");
  });

  test("30. secrets in the newly covered formats never reach the history file", async () => {
    const root = tmp("ovsc-7d-secret-");
    const s = new Store({ storageRoot: root, workspaceId: WS });
    await s.load();
    const secrets = ["hunter2-correct-horse", "hunter2pass", "hf_abcdefghijklmnopqrstuvwxyzABCDEFGH", "glpat-abcdefghij1234567890", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "XXXXXXXXXXXXXXXXXXXXXXXX", "abcdef1234567890abcdef"];
    const content = [
      'config: {"password": "hunter2-correct-horse"}',
      "DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app",
      "HF hf_abcdefghijklmnopqrstuvwxyzABCDEFGH and glpat-abcdefghij1234567890",
      "key AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "hook https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
      "Cookie: session=abcdef1234567890abcdef",
    ].join("\n");
    await s.save({ id: cid(1), createdAt: 1, updatedAt: 2, mode: "ASK", messages: [{ id: "m0", role: "user", content, timestamp: 1 }], attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
    const raw = readFileSync(join(root, "conversations", cid(1) + ".json"), "utf8") + readFileSync(join(root, "conversations", "index.json"), "utf8");
    for (const secret of secrets) assert.equal(raw.includes(secret), false, secret);
    const restored = (await s.read(cid(1))).messages[0].content;
    assert.match(restored, /DATABASE_URL=postgres:\/\/admin:\[REDACTED\]@db\.internal/);
    assert.match(restored, /config: \{"password": "\[REDACTED\]"\}/);
  });

  test("31. 100 save/read cycles keep the index consistent and memory bounded", async () => {
    const root = tmp("ovsc-7d-cycle-");
    const s = new Store({ storageRoot: root, workspaceId: WS });
    await s.load();
    const gc = (globalThis as any).gc;
    const heap0 = (gc?.(), process.memoryUsage().heapUsed);
    for (let i = 0; i < 100; i++) {
      await s.save({ id: cid(i % 5), createdAt: 1, updatedAt: 100 + i, mode: "ASK", messages: [{ id: "m", role: "user", content: "x".repeat(2000), timestamp: i }], attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
      await s.read(cid((i + 2) % 5));
    }
    assert.equal(s.list().length, 5);
    assert.equal((await new Store({ storageRoot: root, workspaceId: WS }).load()).conversations.length, 5);
    const growth = process.memoryUsage().heapUsed - heap0;
    assert.ok(growth < 64 * 1024 * 1024, `heap growth ${growth}`);
  });
});

// ---- extension ---------------------------------------------------------------

describe("Sprint 7D editor-event coalescing", () => {
  test("32. a burst of editor events takes two snapshots, the last state wins, and errors do not wedge it", async () => {
    let runs = 0;
    let value = 0;
    let seen = -1;
    let release!: Function;
    const refresh = coalesceRefresh(async () => {
      runs++;
      const snapshot = value;
      await new Promise((r) => { release = r; });
      seen = snapshot;
    });
    const first = refresh();
    for (let i = 1; i <= 100; i++) { value = i; void refresh(); }
    release();
    await until(() => runs >= 2, "the trailing refresh");
    release();
    await first;
    await tick();
    assert.equal(runs, 2, "100 events during one snapshot cause exactly one more");
    assert.equal(seen, 100, "the trailing refresh sees the latest state");

    let attempts = 0;
    const flaky = coalesceRefresh(async () => { attempts++; if (attempts === 1) throw new Error("snapshot failed"); });
    await flaky().catch(() => {});
    await flaky();
    assert.equal(attempts, 2, "a failed refresh does not block the next one");
  });
});
