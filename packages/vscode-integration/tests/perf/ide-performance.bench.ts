// Sprint 7D — IDE responsiveness benchmark.
//
// Drives the real ChatController, the real generated webview page script (in a
// fake DOM), the real ConversationStore and the real AutocompleteController.
// It uses only APIs that existed before Sprint 7D, so the same file measures
// the baseline and the changed code. Inference is never called: autocomplete
// uses an in-process fake gateway, and no model latency is reported.
//
// Usage: node --expose-gc --import tsx tests/perf/ide-performance.bench.ts --label before --out <file.json>
import Module, { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { bootChatWebview, liveListenerCount, walk } from "../helpers/fake-webview.ts";
import { MockTextDocument, Pos, Rng, syntheticSource } from "../helpers/text-document.ts";

// ---- vscode stand-in --------------------------------------------------------
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
    showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined,
    showTextDocument: async () => {},
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
const req = createRequire(import.meta.url);
const { ChatController } = req("../../src/chat-controller.ts");
const { ChatViewProvider } = req("../../src/chat-view-provider.ts");
const { ConversationStore } = req("../../src/conversation-store.ts");
const { AutocompleteController } = req("../../src/autocomplete-controller.ts");

// ---- measurement helpers ----------------------------------------------------
interface Stats { n: number; median: number; p95: number; min: number; max: number; mean: number }
function stats(samples: number[]): Stats {
  const s = samples.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]), max: r(s[s.length - 1]), mean: r(s.reduce((a, b) => a + b, 0) / s.length) };
}
function timeEach(n: number, fn: (i: number) => void): Stats {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(i); out.push(performance.now() - t); }
  return stats(out);
}
async function timeEachAsync(n: number, fn: (i: number) => Promise<void>): Promise<Stats> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); out.push(performance.now() - t); }
  return stats(out);
}
function heapAfterGc(): number {
  const gc = (globalThis as any).gc;
  if (gc) { gc(); gc(); }
  return process.memoryUsage().heapUsed;
}
const mb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const cid = (n: number) => "c-" + n.toString(16).padStart(16, "0");
const WS = "w-dddddddddddddddddddddddd";

// ---- fixtures -----------------------------------------------------------------
type Charset = "ascii" | "cjk" | "emoji" | "escapes";
function body(i: number, chars: number, charset: Charset): string {
  if (charset === "cjk") return "漢字のテスト文章です。".repeat(Math.ceil(chars / 11)).slice(0, chars);
  // Raw terminal bytes pasted into chat: every control character becomes a 6-byte JSON escape.
  if (charset === "escapes") return "\x1b[0m\x01\x02\x03\x04\x05\x06".repeat(Math.ceil(chars / 10)).slice(0, chars);
  if (charset === "emoji") return "ok 🙂 ".repeat(Math.ceil(chars / 6)).slice(0, chars - (chars % 2));
  const text = `Step ${i}: update \`src/module-${i % 7}.ts\` so the parser handles the new token. `;
  const fence = i % 5 === 0 ? "\n```ts\nexport function f" + i + "(x: number) { return x * " + i + "; }\n```\n" : "";
  let out = text + fence;
  while (out.length < chars) out += "The change keeps the existing behaviour and adds a regression test. ";
  return out.slice(0, chars);
}
function longMessages(prefix: string, charset: Charset = "ascii", count = 100, perMessage = 1950) {
  return Array.from({ length: count }, (_, i) => ({
    id: prefix + i, role: i % 2 ? "assistant" : "user", content: body(i, perMessage, charset), timestamp: 1_700_000_000_000 + i,
    ...(i % 2 ? { status: "completed" } : {}),
  }));
}
const activities = (n: number, tag = "") => Array.from({ length: n }, (_, i) => ({ id: "a" + i, kind: "tool", label: "Read file src/module-" + i + ".ts" + tag, status: "completed", toolName: "read_file" }));
const reviews = Array.from({ length: 20 }, (_, i) => i % 2
  ? { id: "v" + i, kind: "command", status: "succeeded", command: "npm test", exitCode: 0, durationMs: 1200 + i }
  : { id: "m" + i, kind: "mutation", status: "applied", path: "src/module-" + i + ".ts", mutation: { operation: "update", linesAdded: 3, linesRemoved: 1 } });
const summaries = Array.from({ length: 50 }, (_, i) => ({ id: cid(i), title: "Conversation " + i, createdAt: 1, updatedAt: 1_700_000_000_000 - i * 60_000, mode: "BUILD", messageCount: 100, lastStatus: "completed", preview: "Preview " + i }));
function bigState(id: string, prefix: string, extra: Record<string, unknown> = {}) {
  return {
    conversationId: id, conversationTitle: "Long conversation " + prefix, lastStatus: "running", mode: "BUILD",
    messages: longMessages(prefix), activities: activities(20), reviews, conversations: summaries,
    context: [{ id: "implicit:active-file", kind: "active-file", label: "src/app.ts", path: "src/app.ts", removable: false }, { id: "implicit:workspace", kind: "workspace", label: "1 workspace roots", removable: false }],
    attachments: [{ id: "att1", kind: "file", label: "src/app.ts", path: "src/app.ts" }],
    connection: { state: "ready", backend: "standalone-local", healthChecked: true, modelLabel: "qwen2.5-coder", detail: "ok" },
    history: { enabled: true }, activeTurn: true,
    pendingConfirmation: { id: "conf-1", type: "mutation", riskLabel: "File change", summary: "Update src/app.ts", mutationId: "mut-1", path: "src/app.ts", mutation: { operation: "update", linesAdded: 4, linesRemoved: 2, beforeHash: "a".repeat(64) } },
    ...extra,
  };
}
function chatHtml(): string {
  let html = "";
  const provider = new ChatViewProvider({ fsPath: "/ext" }, { setWebviewView: () => {} });
  provider.resolveWebviewView({ webview: { options: {}, set html(v: string) { html = v; }, get html() { return html; } } } as any, {} as any, {} as any);
  return html;
}
const textOf = (el: any) => walk(el).map((e) => e.textContent).join("\n");

// ---- scenarios ------------------------------------------------------------------
const results: Record<string, any> = {};
const html = chatHtml();

function webviewScenarios() {
  // W1: first render of a long conversation.
  const first = timeEach(20, () => { const w = bootChatWebview(html); w.deliver({ type: "chat.state", state: bigState(cid(1), "m") }); });
  const probe = bootChatWebview(html);
  probe.dom.resetCounters();
  probe.deliver({ type: "chat.state", state: bigState(cid(1), "m") });
  results.W1_initial_render_long_conversation = { method: "mock-DOM", iterations: 20, ms: first, elementsCreated: probe.dom.counters.created };

  // W2: steady-state pushes during an active turn where only one activity changes.
  const w = bootChatWebview(html);
  w.deliver({ type: "chat.state", state: bigState(cid(1), "m") });
  const states = Array.from({ length: 200 }, (_, i) => bigState(cid(1), "m", { activities: activities(20, i % 2 ? " (again)" : "") }));
  w.dom.resetCounters();
  const push = timeEach(200, (i) => w.deliver({ type: "chat.state", state: states[i] }));
  const c = w.dom.counters;
  results.W2_state_push_activity_only = {
    method: "mock-DOM", iterations: 200, ms: push,
    perPush: { elementsCreated: c.created / 200, listenersAdded: c.listenersAdded / 200, scrollWrites: c.scrollWrites / 200, layoutReads: c.layoutReads / 200 },
  };

  // W2b: a push in which nothing changed at all (e.g. a context refresh with identical chips).
  w.dom.resetCounters();
  const same = bigState(cid(1), "m");
  const idle = timeEach(200, () => w.deliver({ type: "chat.state", state: same }));
  results.W2b_state_push_unchanged = {
    method: "mock-DOM", iterations: 200, ms: idle,
    perPush: { elementsCreated: w.dom.counters.created / 200, listenersAdded: w.dom.counters.listenersAdded / 200, scrollWrites: w.dom.counters.scrollWrites / 200, layoutReads: w.dom.counters.layoutReads / 200 },
  };

  // W3: focus and scroll position across an unrelated push.
  const f = bootChatWebview(html);
  f.deliver({ type: "chat.state", state: bigState(cid(1), "m") });
  const reject = walk(f.byId["confirmation-container"]).find((e) => e.tagName === "button" && e.textContent === "Reject");
  reject?.focus();
  f.byId.transcript.scrollTop = 0; // the user scrolled up to read
  f.byId.transcript.fire("scroll");
  f.deliver({ type: "chat.state", state: bigState(cid(1), "m", { activities: activities(21) }) });
  results.W3_focus_and_scroll_across_unrelated_push = {
    method: "mock-DOM",
    confirmationFocusKept: f.dom.activeElement === reject,
    scrollPositionKept: f.byId.transcript.scrollTop === 0,
  };

  // W4: switching between two long conversations.
  const s = bootChatWebview(html);
  const a = bigState(cid(1), "a", { activeTurn: false, pendingConfirmation: undefined });
  const b = bigState(cid(2), "b", { activeTurn: false, pendingConfirmation: undefined });
  s.deliver({ type: "chat.state", state: a });
  s.dom.resetCounters();
  const sw = timeEach(40, (i) => s.deliver({ type: "chat.state", state: i % 2 ? a : b }));
  results.W4_switch_long_conversations = { method: "mock-DOM", iterations: 40, ms: sw, elementsCreatedPerSwitch: s.dom.counters.created / 40 };

  // W5: terminal output flood up to the 16 KB stream bound.
  const t = bootChatWebview(html);
  t.deliver({ type: "chat.state", state: bigState(cid(1), "m", { pendingConfirmation: undefined }) });
  const term = (out: string) => ({ executionId: "exec-1", command: "npm test", cwd: ".", provenance: "agent", timeoutMs: 120000, executable: "npm", args: ["test"], startedAt: Date.now(), outputLimitBytes: 16384, status: "RUNNING", stdout: out, stderr: "", stdoutTruncated: false, stderrTruncated: false, isOutputVisible: true });
  let out = "";
  t.dom.resetCounters();
  const flood = timeEach(2000, () => { if (out.length < 16384) out += "PASS test case line with some output text\n"; t.deliver({ type: "terminal.updated", terminal: term(out) }); });
  results.W5_terminal_output_flood = { method: "mock-DOM", iterations: 2000, ms: flood, elementsCreatedTotal: t.dom.counters.created };

  // R1: retained DOM and listeners after 1000 pushes.
  const r = bootChatWebview(html);
  r.deliver({ type: "chat.state", state: bigState(cid(1), "m") });
  const nodes0 = walk(r.dom.body).length;
  const listeners0 = liveListenerCount(r.dom);
  const heap0 = heapAfterGc();
  for (let i = 0; i < 1000; i++) r.deliver({ type: "chat.state", state: states[i % 200] });
  results.R1_webview_retention_1000_pushes = {
    method: "mock-DOM",
    liveNodes: { before: nodes0, after: walk(r.dom.body).length },
    liveListeners: { before: listeners0, after: liveListenerCount(r.dom) },
    listenersAddedTotal: r.dom.counters.listenersAdded,
    heapDeltaMB: mb(heapAfterGc() - heap0),
    transcriptTextIntact: textOf(r.byId.transcript).includes("Step 99"),
  };
}

class CountingWebview {
  posts = 0; stateposts = 0; bytes = 0; stringifyMs = 0; deliverMs = 0;
  controller: any;
  constructor(private readonly page?: ReturnType<typeof bootChatWebview>) {}
  onDidReceiveMessage() { return { dispose() {} }; }
  postMessage(m: any) {
    const t = performance.now();
    const json = JSON.stringify(m);
    this.stringifyMs += performance.now() - t;
    this.posts++;
    if (m.type === "chat.state") this.stateposts++;
    this.bytes += json.length;
    if (this.page) { const t2 = performance.now(); this.page.deliver(JSON.parse(json)); this.deliverMs += performance.now() - t2; }
  }
  reset() { this.posts = 0; this.stateposts = 0; this.bytes = 0; this.stringifyMs = 0; this.deliverMs = 0; }
}

async function controllerWithLongConversation(page?: ReturnType<typeof bootChatWebview>) {
  const storageRoot = tmp("ovsc-7d-host-");
  const workspace = tmp("ovsc-7d-ws-");
  mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace }, name: "ws" }];
  const seed = new ConversationStore({ storageRoot, workspaceId: WS });
  await seed.load();
  await seed.save({ id: cid(1), createdAt: 1, updatedAt: 2, mode: "BUILD", messages: longMessages("h"), attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
  await seed.save({ id: cid(2), createdAt: 1, updatedAt: 1, mode: "BUILD", messages: longMessages("k"), attachments: [], reviews: [], lastStatus: "completed", runIds: [] });
  let runTask: any = async () => ({ status: "COMPLETED", finalAnswer: "done" });
  const host = {
    getSnapshot: async () => ({ workspaceRoots: [{ fsPath: workspace }], diagnostics: [], visibleDocuments: [], isTrusted: true }),
    showOutput: async () => {}, showError: async () => {}, openWorkspaceFile: async () => {},
  };
  const controller = new ChatController(host, () => ({ runTask: (i: string, m: string, s: AbortSignal, on: any, turns: any) => runTask(i, m, s, on, turns) }));
  const view = new CountingWebview(page);
  view.controller = controller;
  controller.setWebviewView({ webview: view } as any);
  const store = new ConversationStore({ storageRoot, workspaceId: WS });
  await controller.attachConversationStore(store);
  return { controller, view, store, storageRoot, workspace, setRunTask: (fn: any) => { runTask = fn; } };
}

async function hostScenarios() {
  // H1: editor cursor/selection storm — the same implicit context 500 times.
  const page = bootChatWebview(html);
  const fx = await controllerWithLongConversation(page);
  const snapshot = { activeDocument: { workspaceRelativePath: "src/app.ts" }, selection: null, diagnostics: [], workspaceRoots: [{ fsPath: fx.workspace }] };
  fx.controller.refreshContext(snapshot);
  fx.view.reset();
  page.dom.resetCounters();
  const t = performance.now();
  for (let i = 0; i < 500; i++) fx.controller.refreshContext(snapshot);
  const total = performance.now() - t;
  results.H1_cursor_storm_500_identical_context_refreshes = {
    method: "node host + mock-DOM page; JSON round-trip approximates webview message serialization",
    iterations: 500,
    statePosts: fx.view.stateposts,
    bytesPosted: fx.view.bytes,
    hostStringifyMs: Math.round(fx.view.stringifyMs * 10) / 10,
    pageRenderMs: Math.round(fx.view.deliverMs * 10) / 10,
    totalMs: Math.round(total * 10) / 10,
    pageElementsCreated: page.dom.counters.created,
    messagesInState: fx.controller.getState().messages.length,
  };

  // H2: agent event burst during a turn (20 tool cycles).
  const saves: number[] = [];
  const realSave = fx.store.save.bind(fx.store);
  fx.store.save = async (...args: any[]) => { const t0 = performance.now(); const r = await realSave(...args); saves.push(performance.now() - t0); return r; };
  let onEvent: any;
  let finish: any;
  const done = new Promise((r) => { finish = r; });
  fx.setRunTask(async (_i: string, _m: string, _s: AbortSignal, on: any) => { onEvent = on; return done; });
  fx.view.reset();
  const turn = fx.controller.handleWebviewMessage({ type: "chat.send", text: "Refactor the parser", mode: "BUILD" });
  while (!onEvent) await new Promise((r) => setImmediate(r));
  onEvent({ type: "task.started", payload: { task: { id: "session-7d-1" } } });
  for (let i = 0; i < 20; i++) {
    onEvent({ type: "model.requested", payload: {} });
    onEvent({ type: "model.completed", payload: {} });
    onEvent({ type: "tool.requested", payload: { toolName: "read_file", input: { path: "src/m" + i + ".ts" } } });
    onEvent({ type: "tool.completed", payload: { toolName: "read_file" } });
  }
  finish({ status: "COMPLETED", finalAnswer: "Refactored." });
  await turn;
  await fx.controller.flushPersistence();
  results.H2_agent_turn_80_events = {
    method: "node host + mock-DOM page",
    statePosts: fx.view.stateposts,
    bytesPosted: fx.view.bytes,
    hostStringifyMs: Math.round(fx.view.stringifyMs * 10) / 10,
    pageRenderMs: Math.round(fx.view.deliverMs * 10) / 10,
    saves: saves.length,
    saveMs: saves.length ? stats(saves) : null,
  };

  // H3: switching between two long stored conversations through the controller.
  fx.view.reset();
  const sw = await timeEachAsync(20, async (i) => { await fx.controller.openConversation(i % 2 ? cid(1) : cid(2)); });
  results.H3_open_conversation_switch = { method: "node host + real store on disk + mock-DOM page", iterations: 20, ms: sw, bytesPerSwitch: Math.round(fx.view.bytes / 20) };

  // R2: host-side retained state after 1000 agent events.
  const heap0 = heapAfterGc();
  let on2: any; let fin2: any;
  const done2 = new Promise((r) => { fin2 = r; });
  fx.setRunTask(async (_i: string, _m: string, _s: AbortSignal, on: any) => { on2 = on; return done2; });
  const turn2 = fx.controller.handleWebviewMessage({ type: "chat.send", text: "Long task", mode: "BUILD" });
  while (!on2) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 250; i++) {
    on2({ type: "tool.requested", payload: { toolName: "read_file" } });
    on2({ type: "tool.completed", payload: { toolName: "read_file" } });
    on2({ type: "model.requested", payload: {} });
    on2({ type: "model.completed", payload: {} });
  }
  const st = fx.controller.getState();
  const retained = { messages: st.messages.length, activities: st.activities.length, reviews: (st.reviews || []).length, conversations: (st.conversations || []).length };
  fin2({ status: "COMPLETED", finalAnswer: "ok" });
  await turn2;
  await fx.controller.flushPersistence();
  results.R2_host_retention_1000_events = { method: "node host", retained, heapDeltaMB: mb(heapAfterGc() - heap0) };
  rmSync(fx.storageRoot, { recursive: true, force: true });
}

async function storeScenarios() {
  const root = tmp("ovsc-7d-store-");
  const s = new ConversationStore({ storageRoot: root, workspaceId: WS });
  await s.load();
  const rec = (id: string, charset: Charset, updatedAt: number) => ({ id, createdAt: 1, updatedAt, mode: "BUILD", messages: longMessages("s", charset), attachments: [], reviews, lastStatus: "completed", runIds: [] });
  results.S1_save_long_ascii = { method: "node + real fs (APFS)", iterations: 30, ms: await timeEachAsync(30, async (i) => { await s.save(rec(cid(1), "ascii", 10 + i)); }) };
  results.S2_save_long_cjk_over_byte_cap = { method: "node + real fs (APFS)", iterations: 10, ms: await timeEachAsync(10, async (i) => { await s.save(rec(cid(2), "cjk", 100 + i)); }), keptMessages: (await s.read(cid(2)))?.messages.length };
  results.S3_save_long_emoji_over_byte_cap = { method: "node + real fs (APFS)", iterations: 10, ms: await timeEachAsync(10, async (i) => { await s.save(rec(cid(3), "emoji", 200 + i)); }), keptMessages: (await s.read(cid(3)))?.messages.length };
  results.S3b_save_escape_dense_over_byte_cap = { method: "node + real fs (APFS)", iterations: 10, ms: await timeEachAsync(10, async (i) => { await s.save(rec(cid(50), "escapes", 250 + i)); }), keptMessages: (await s.read(cid(50)))?.messages.length };
  await s.delete(cid(50));
  for (let i = 4; i < 50; i++) await s.save(rec(cid(i), "ascii", 300 + i));
  results.S4_load_50_with_index = { method: "node + real fs", iterations: 20, ms: await timeEachAsync(20, async () => { await new ConversationStore({ storageRoot: root, workspaceId: WS }).load(); }) };
  results.S5_load_50_rebuild_index = { method: "node + real fs", iterations: 10, ms: await timeEachAsync(10, async () => { unlinkSync(join(root, "conversations", "index.json")); await new ConversationStore({ storageRoot: root, workspaceId: WS }).load(); }) };
  results.S6_read_largest = { method: "node + real fs", iterations: 30, ms: await timeEachAsync(30, async () => { await s.read(cid(1)); }) };
  const heap0 = heapAfterGc();
  for (let i = 0; i < 200; i++) { await s.save(rec(cid(1), "ascii", 1000 + i)); await s.read(cid(i % 50)); }
  results.S7_store_retention_200_save_read = { method: "node + real fs", heapDeltaMB: mb(heapAfterGc() - heap0), indexEntries: s.list().length };
  rmSync(root, { recursive: true, force: true });
}

async function autocompleteScenarios() {
  const never = { schedule: () => ({ cancel() {} }) };
  const token = () => {
    const listeners: Function[] = [];
    return { isCancellationRequested: false, onCancellationRequested: (fn: Function) => { listeners.push(fn); return { dispose() {} }; }, cancel() { (this as any).isCancellationRequested = true; for (const fn of listeners) fn(); } };
  };
  // A1: per-keystroke editor extraction before the debounce, by document size.
  for (const size of [100_000, 1_000_000, 5_000_000]) {
    const ctrl = new AutocompleteController({ gateway: { complete: () => new Promise(() => {}) }, scheduler: never, debounceMs: 0 });
    const doc = new MockTextDocument(syntheticSource(size));
    const pos = doc.positionAt(Math.floor(size / 2));
    activeEditor = { document: doc, selection: { active: pos } };
    doc.charsCopied = 0;
    const ms = timeEach(30, () => { void ctrl.provideInlineCompletionItems(doc as any, pos as any, {} as any, token() as any); });
    results["A1_keystroke_extraction_" + size / 1000 + "KB"] = { method: "node + MockTextDocument (VS Code extension-host line model)", iterations: 30, ms, charsCopiedPerKeystroke: Math.round(doc.charsCopied / 30) };
    await ctrl.dispose();
  }

  // A2: rapid typing — 300 keystrokes, each cancelling the previous token, then the debounce fires.
  {
    const pending: Function[] = [];
    const scheduler = { schedule: (fn: Function) => { pending.push(fn); return { cancel() { const i = pending.indexOf(fn); if (i >= 0) pending.splice(i, 1); } }; } };
    let calls = 0;
    const ctrl = new AutocompleteController({ gateway: { complete: async (r: any) => { calls++; return { text: "value + 1;", deploymentId: "fake", providerId: "fake", requestId: r.requestId }; } }, scheduler, debounceMs: 0 });
    const doc = new MockTextDocument(syntheticSource(20_000));
    let prev: any = null;
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 300; i++) {
      prev?.cancel();
      doc.version++;
      const pos = doc.positionAt(10_000 + i);
      activeEditor = { document: doc, selection: { active: pos } };
      prev = token();
      promises.push(ctrl.provideInlineCompletionItems(doc as any, pos as any, {} as any, prev));
    }
    while (pending.length) await (pending.shift() as Function)();
    const out = await Promise.all(promises);
    results.A2_rapid_typing_300_keystrokes = {
      method: "node + fake gateway (no inference)",
      providerInvocations: calls,
      completionsShown: out.filter((r) => r && r.items && r.items.length).length,
      lastKeystrokeGotCompletion: !!(out[299] && out[299].items.length),
      telemetry: ctrl.service.telemetry,
    };
    await ctrl.dispose();
  }

  // A3: a late cancellation of an older request must not cancel the newer one.
  {
    const pending: Function[] = [];
    const scheduler = { schedule: (fn: Function) => { pending.push(fn); return { cancel() { const i = pending.indexOf(fn); if (i >= 0) pending.splice(i, 1); } }; } };
    const gates: Array<{ resolve: Function; signal: AbortSignal }> = [];
    const ctrl = new AutocompleteController({
      gateway: { complete: (r: any) => new Promise((resolve, reject) => { gates.push({ resolve, signal: r.signal }); r.signal.addEventListener("abort", () => reject(new Error("aborted"))); }) },
      scheduler, debounceMs: 0,
    });
    const doc = new MockTextDocument("function main() {\n  return value\n}\n");
    const posA = new Pos(1, 9);
    activeEditor = { document: doc, selection: { active: posA } };
    const tA = token();
    const pA = ctrl.provideInlineCompletionItems(doc as any, posA as any, {} as any, tA as any);
    await (pending.shift() as Function)(); // A is now in flight
    doc.version++;
    const posB = new Pos(1, 14);
    activeEditor = { document: doc, selection: { active: posB } };
    const tB = token();
    let bSettled = false;
    const pB = ctrl.provideInlineCompletionItems(doc as any, posB as any, {} as any, tB as any).then((r: any) => { bSettled = true; return r; });
    tA.cancel(); // VS Code cancels the old request after the new one was scheduled
    await new Promise((r) => setImmediate(r));
    const bCancelledByOldToken = bSettled;
    while (pending.length) { const fn = pending.shift() as Function; const run = fn(); while (!gates[1] && !bSettled) await new Promise((r) => setImmediate(r)); gates[1]?.resolve({ text: "value + 1", deploymentId: "fake", providerId: "fake" }); await run; }
    const resultB = await pB;
    await pA;
    results.A3_late_cancel_of_older_request = {
      method: "node + fake gateway (no inference)",
      newerRequestCancelledByOlderToken: bCancelledByOldToken,
      newerRequestCompleted: !!(resultB && resultB.items && resultB.items.length),
      telemetryCancelled: ctrl.service.telemetry.cancelled,
    };
    await ctrl.dispose();
  }

  // A4: inference endpoint unavailable.
  {
    const ctrl = new AutocompleteController({ gateway: { complete: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8080"); } }, debounceMs: 0 });
    const doc = new MockTextDocument("const value = compute(1);\nconst next = ");
    const pos = new Pos(1, 13);
    activeEditor = { document: doc, selection: { active: pos } };
    const t = performance.now();
    const r = await ctrl.provideInlineCompletionItems(doc as any, pos as any, {} as any, token() as any);
    results.A4_unavailable_endpoint = { method: "node + failing fake gateway", resultIsNull: r === null, msToNull: Math.round((performance.now() - t) * 10) / 10, telemetry: ctrl.service.telemetry };
    await ctrl.dispose();
  }
  activeEditor = null;
}

async function main() {
  const args = process.argv.slice(2);
  const label = args[args.indexOf("--label") + 1] || "run";
  const outIdx = args.indexOf("--out");
  let commit = "unknown";
  let sourceDiff = "unknown";
  try {
    commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    // Which code was measured: HEAD, or HEAD plus a working-tree diff identified by its hash.
    const diff = execSync("git diff HEAD -- src ../agent-core/src", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    sourceDiff = diff ? "sha256:" + createHash("sha256").update(diff).digest("hex").slice(0, 16) : "none";
  } catch { /* not a checkout */ }
  const started = Date.now();
  webviewScenarios();
  await hostScenarios();
  await storeScenarios();
  await autocompleteScenarios();
  const report = {
    label,
    date: new Date().toISOString(),
    commit, sourceDiff,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, gcExposed: typeof (globalThis as any).gc === "function" },
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: Math.round(totalmem() / 1073741824) },
    fixtures: {
      longConversation: "100 messages × 1,950 chars (≈195k chars, the 200k cap), code fences every 5th message, 20 activities, 20 ledger rows, 50 history summaries, 1 pending change approval",
      cjk: "100 × 1,950 CJK chars (3 UTF-8 bytes each, over the 512 KiB record cap)",
      emoji: "100 × ≈1,950 chars with emoji (surrogate pairs, 4 UTF-8 bytes each)",
      documents: "synthetic TypeScript, 100 KB / 1 MB / 5 MB, cursor mid-file",
    },
    methodology: [
      "Timings are wall-clock performance.now() per iteration; median, p95, min, max, mean reported in ms.",
      "mock-DOM = the real generated page script run against tests/helpers/fake-webview.ts; it measures script and DOM-call work, not Chromium layout or paint.",
      "Host posts are JSON-serialized and parsed (approximating VS Code's webview message serialization) before delivery to the page.",
      "Store scenarios use the real ConversationStore on the local APFS disk (exclusive temp file, fsync, rename).",
      "No inference: autocomplete uses an in-process fake gateway; no model latency, tokens/s or quality is measured.",
    ],
    durationMs: Date.now() - started,
    scenarios: results,
  };
  const json = JSON.stringify(report, null, 2);
  if (outIdx >= 0) writeFileSync(args[outIdx + 1], json + "\n");
  console.log(json);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
