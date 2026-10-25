/**
 * Production webview rendering helpers.
 *
 * Authority & Safety Model:
 *   Untrusted text (chat content, terminal output/command, confirmation summary,
 *   risk labels, file paths) is rendered strictly via `element.textContent = text`.
 *   Containers are cleared via `element.innerHTML = ''`.
 *   Zero script execution, zero event handler execution, zero unsafe navigation.
 *
 * This implementation is authoritative and shared between:
 *   - The shipped webview script runtime in `ChatViewProvider`
 *   - Production security evaluations and E2E rendering verification
 *
 * Functions in this file are function-declarations so ChatViewProvider can
 * inject them via Function.prototype.toString(). Do not use template literals
 * here — the host HTML is itself a template string.
 */

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "file"; path: string };

var MAX_CODE_CHARS = 100000;

export function parseMessageSegments(content: string): MessageSegment[] {
  var source = typeof content === "string" ? content : String(content == null ? "" : content);
  if (!source) return [{ kind: "text", text: "" }];

  var segments: MessageSegment[] = [];
  var last = 0;
  var fenceRe = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  var match: RegExpExecArray | null;
  while ((match = fenceRe.exec(source)) !== null) {
    if (match.index > last) {
      pushTextWithFileRefs(segments, source.slice(last, match.index));
    }
    var code = match[2] || "";
    if (code.length > MAX_CODE_CHARS) code = code.slice(0, MAX_CODE_CHARS) + "\n[TRUNCATED]";
    segments.push({ kind: "code", language: match[1] || "", text: code });
    last = match.index + match[0].length;
  }
  if (last < source.length) {
    pushTextWithFileRefs(segments, source.slice(last));
  }
  if (segments.length === 0) segments.push({ kind: "text", text: source });
  return segments;
}

function pushTextWithFileRefs(segments: MessageSegment[], text: string): void {
  if (!text) return;
  var re = /(?:^|[\s(])`([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)`/g;
  var last = 0;
  var match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    var path = match[1];
    var tokenStart = match.index + (match[0].length - path.length - 2);
    if (tokenStart > last) segments.push({ kind: "text", text: text.slice(last, tokenStart) });
    segments.push({ kind: "file", path: path });
    last = tokenStart + path.length + 2;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
}

function setText(el: any, value: string): void {
  el.textContent = value == null ? "" : String(value);
}

function setAttr(el: any, name: string, value: string): void {
  if (el && typeof el.setAttribute === "function") el.setAttribute(name, value);
}

function onClick(el: any, handler: () => void): void {
  if (el && typeof el.addEventListener === "function") el.addEventListener("click", handler);
}

function docOf(doc?: any): any {
  return doc || (typeof (globalThis as any).document !== "undefined" ? (globalThis as any).document : undefined);
}

function roleLabel(role: string, status?: string, inherited?: boolean): string {
  var label = role === "assistant" ? "Assistant" : role === "system" ? "System" : "You";
  if (status && status !== "completed" && status !== "pending") label += " · " + status;
  if (inherited) label += " · from an earlier conversation";
  return label;
}

function appendRoleLabel(d: any, div: any, role: string, status?: string, inherited?: boolean): void {
  var meta = d.createElement("div");
  meta.className = "message-meta";
  setText(meta, roleLabel(role, status, inherited));
  div.appendChild(meta);
}

export function renderChatMessage(
  container: any,
  message: { id?: string; role?: string; content: string; status?: string; attachments?: any[]; inherited?: boolean } | string,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  var d = docOf(doc);
  var div = d.createElement("div");
  var role = typeof message === "object" && message && message.role ? message.role : "user";
  var content = typeof message === "object" && message ? (message.content ?? "") : String(message ?? "");
  var status = typeof message === "object" && message ? message.status : undefined;
  var id = typeof message === "object" && message && message.id ? message.id : "";
  var inherited = typeof message === "object" && message ? message.inherited === true : false;
  div.className = "message " + role + (status ? " is-" + status : "") + (inherited ? " is-inherited" : "");
  setAttr(div, "data-message-id", id);
  setAttr(div, "role", "article");
  setAttr(div, "aria-label", (role === "assistant" ? "Assistant" : role === "system" ? "System" : "User") + " message" + (inherited ? " from an earlier conversation" : ""));

  appendRoleLabel(d, div, role, status, inherited);

  var body = d.createElement("div");
  body.className = "message-body";
  fillMessageBody(body, content, d, postMessage);
  div.appendChild(body);

  if (typeof message === "object" && message && Array.isArray(message.attachments) && message.attachments.length) {
    var row = d.createElement("div");
    row.className = "message-attachments";
    for (var i = 0; i < message.attachments.length; i++) {
      var chip = message.attachments[i];
      var btn = d.createElement("button");
      btn.className = "chip chip-file" + (chip.unavailable ? " chip-unavailable" : "");
      btn.type = "button";
      setText(btn, chip.label || chip.path || "file");
      setAttr(btn, "aria-label", "Open " + (chip.path || chip.label || "file"));
      if (postMessage && chip.path && !chip.unavailable) {
        onClick(btn, function (p: string) {
          return function () {
            postMessage({ type: "ui.openFile", path: p });
          };
        }(chip.path));
      }
      row.appendChild(btn);
    }
    div.appendChild(row);
  }

  container.appendChild(div);
  return div;
}

function fillMessageBody(body: any, content: string, d: any, postMessage?: (msg: any) => void): void {
  var segments = parseMessageSegments(content);
  var first = segments[0];
  if (segments.length === 1 && first.kind === "text") {
    setText(body, first.text);
    return;
  }
  body.textContent = "";
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (seg.kind === "text") {
      var span = d.createElement("span");
      span.className = "md-text";
      setText(span, seg.text);
      body.appendChild(span);
    } else if (seg.kind === "file") {
      var fileBtn = d.createElement("button");
      fileBtn.className = "file-ref";
      fileBtn.type = "button";
      setText(fileBtn, seg.path);
      setAttr(fileBtn, "aria-label", "Open file " + seg.path);
      if (postMessage) {
        onClick(fileBtn, function (p: string) {
          return function () {
            postMessage({ type: "ui.openFile", path: p });
          };
        }(seg.path));
      }
      body.appendChild(fileBtn);
    } else {
      var preWrap = d.createElement("div");
      preWrap.className = "code-block";
      var toolbar = d.createElement("div");
      toolbar.className = "code-toolbar";
      var lang = d.createElement("span");
      lang.className = "code-lang";
      setText(lang, seg.language || "code");
      var copyBtn = d.createElement("button");
      copyBtn.className = "btn-copy";
      copyBtn.type = "button";
      setText(copyBtn, "Copy");
      setAttr(copyBtn, "aria-label", "Copy code block");
      if (postMessage) {
        onClick(copyBtn, function (text: string) {
          return function () {
            postMessage({ type: "ui.copyCode", text: text });
          };
        }(seg.text));
      }
      toolbar.appendChild(lang);
      toolbar.appendChild(copyBtn);
      var pre = d.createElement("pre");
      var code = d.createElement("code");
      setText(code, seg.text);
      pre.appendChild(code);
      preWrap.appendChild(toolbar);
      preWrap.appendChild(pre);
      body.appendChild(preWrap);
    }
  }
}

function messageSig(
  message: { id?: string; role?: string; content: string; status?: string; attachments?: any[] }
): string {
  var att = "";
  if (message && message.attachments) {
    for (var i = 0; i < message.attachments.length; i++) {
      var chip = message.attachments[i];
      att += (chip && (chip.id || chip.path || chip.label) ? String(chip.id || chip.path || chip.label) : "") + ",";
    }
  }
  return String(message && message.content ? message.content : "") + "\0" +
    String(message && message.status ? message.status : "") + "\0" +
    String(message && message.role ? message.role : "") + "\0" + att;
}

export function updateChatMessage(
  el: any,
  message: { id?: string; role?: string; content: string; status?: string; attachments?: any[]; inherited?: boolean },
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  if (!el) return el;
  var d = docOf(doc);
  var role = message.role || "user";
  var status = message.status;
  var inherited = message.inherited === true;
  el.className = "message " + role + (status ? " is-" + status : "") + (inherited ? " is-inherited" : "");
  var body = null;
  var children = el.children || [];
  for (var i = 0; i < children.length; i++) {
    var cls = children[i].className ? String(children[i].className) : "";
    // The visible status ("Assistant · failed") follows the message, not just its class.
    if (cls === "message-meta") setText(children[i], roleLabel(role, status, inherited));
    if (cls.indexOf("message-body") !== -1) {
      body = children[i];
      break;
    }
  }
  if (!body) {
    body = d.createElement("div");
    body.className = "message-body";
    el.appendChild(body);
  }
  if (typeof body.replaceChildren === "function") body.replaceChildren();
  else body.innerHTML = "";
  fillMessageBody(body, message.content ?? "", d, postMessage);
  return el;
}

export function syncTranscript(
  container: any,
  messages: Array<{ id?: string; role?: string; content: string; status?: string; attachments?: any[] }>,
  doc?: any,
  postMessage?: (msg: any) => void
): { created: number; updated: number; removed: number } {
  var created = 0;
  var updated = 0;
  var removed = 0;
  var existing: Record<string, any> = {};
  var childList = container.children ? Array.prototype.slice.call(container.children) : [];
  for (var i = 0; i < childList.length; i++) {
    var child = childList[i];
    var id = "";
    if (typeof child.getAttribute === "function") id = child.getAttribute("data-message-id") || "";
    else if (child.dataset) id = child.dataset.messageId || "";
    if (id) existing[id] = child;
  }

  var seen: Record<string, boolean> = {};
  var list = messages || [];
  for (var m = 0; m < list.length; m++) {
    var msg = list[m];
    var mid = msg.id || "";
    if (mid) seen[mid] = true;
    var node = mid ? existing[mid] : null;
    var sig = messageSig(msg);
    if (node) {
      var prev = typeof node.getAttribute === "function" ? node.getAttribute("data-sig") : "";
      if (prev !== sig) {
        updateChatMessage(node, msg, doc, postMessage);
        if (typeof node.setAttribute === "function") node.setAttribute("data-sig", sig);
        updated++;
      }
      if (typeof container.appendChild === "function") container.appendChild(node);
    } else {
      var createdNode = renderChatMessage(container, msg, doc, postMessage);
      if (createdNode && typeof createdNode.setAttribute === "function") {
        createdNode.setAttribute("data-sig", sig);
      }
      created++;
    }
  }

  for (var key in existing) {
    if (!seen[key]) {
      var stale = existing[key];
      if (stale && stale.parentNode && typeof stale.parentNode.removeChild === "function") {
        stale.parentNode.removeChild(stale);
      } else if (container.removeChild) {
        try { container.removeChild(stale); } catch { /* ignore */ }
      }
      removed++;
    }
  }

  return { created: created, updated: updated, removed: removed };
}

export function renderActivityTimeline(container: any, activities: any[], doc?: any): any {
  var all = activities || [];
  var start = Math.max(0, all.length - 20);
  var sig = "";
  for (var s = start; s < all.length; s++) sig += (all[s].id || "") + "\u0000" + (all[s].status || "") + "\u0000" + (all[s].label || all[s].kind || "") + "\u0001";
  if (container.__activitySig === sig) return container.firstChild || null;
  container.__activitySig = sig;
  container.innerHTML = "";
  if (!all.length) return null;
  var d = docOf(doc);
  var list = d.createElement("ol");
  list.className = "activity-list";
  setAttr(list, "aria-label", "Agent activity");
  for (var i = start; i < activities.length; i++) {
    var act = activities[i];
    var li = d.createElement("li");
    li.className = "activity-item is-" + (act.status || "pending");
    setAttr(li, "aria-current", act.status === "pending" ? "step" : "false");
    var mark = d.createElement("span");
    mark.className = "activity-mark";
    setAttr(mark, "aria-hidden", "true");
    var label = d.createElement("span");
    label.className = "activity-label";
    setText(label, act.label || act.kind || "activity");
    li.appendChild(mark);
    li.appendChild(label);
    list.appendChild(li);
  }
  container.appendChild(list);
  return list;
}

export function renderContextChips(
  container: any,
  chips: any[],
  doc?: any,
  postMessage?: (msg: any) => void,
  removable?: boolean
): any {
  var sig = JSON.stringify([chips || [], !!removable, !!postMessage]);
  if (container.__chipsSig === sig) return container.firstChild ? container : null;
  container.__chipsSig = sig;
  container.innerHTML = "";
  if (!chips || !chips.length) return null;
  var d = docOf(doc);
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    var wrap = d.createElement("span");
    wrap.className = "chip" + (chip.unavailable ? " chip-unavailable" : "") + (chip.truncated ? " chip-truncated" : "");
    var label = d.createElement("button");
    label.className = "chip-label";
    label.type = "button";
    setText(label, chip.label || "context");
    setAttr(label, "aria-label", (chip.unavailable ? "Unavailable " : "") + (chip.label || "context"));
    if (postMessage && chip.path && !chip.unavailable) {
      onClick(label, function (p: string) {
        return function () {
          postMessage({ type: "ui.openFile", path: p });
        };
      }(chip.path));
    }
    wrap.appendChild(label);
    if ((removable || chip.removable) && chip.id && postMessage) {
      var remove = d.createElement("button");
      remove.className = "chip-remove";
      remove.type = "button";
      setText(remove, "×");
      setAttr(remove, "aria-label", "Remove " + (chip.label || "attachment"));
      onClick(remove, function (id: string) {
        return function () {
          postMessage({ type: "context.remove", id: id });
        };
      }(chip.id));
      wrap.appendChild(remove);
    }
    container.appendChild(wrap);
  }
  return container;
}

export function renderConnectionStatus(container: any, connection: any, doc?: any, postMessage?: (msg: any) => void): any {
  // The button is a live region: rebuilding it unchanged would drop focus and can re-announce.
  var sig = JSON.stringify([connection || null, !!postMessage]);
  if (container.__connectionSig === sig && container.firstChild) return container.firstChild;
  container.__connectionSig = sig;
  container.innerHTML = "";
  var d = docOf(doc);
  var status = connection || { state: "unavailable", backend: "unknown", healthChecked: false, detail: "Not verified" };
  var wrap = d.createElement("button");
  wrap.className = "connection-status is-" + status.state;
  wrap.type = "button";
  setAttr(wrap, "aria-live", "polite");
  var backendLabel =
    status.backend === "halo" ? "HALO" :
    status.backend === "standalone-local" ? "Standalone local" : "Backend";
  var model = status.modelLabel ? " · " + status.modelLabel : "";
  var stateLabel =
    status.state === "ready" ? "Ready" :
    status.state === "running" ? "Running" :
    status.state === "disconnected" ? "Disconnected" :
    status.state === "missing-config" ? "Not configured" :
    status.state === "invalid-credentials" ? "Invalid credentials" :
    status.state === "model-unavailable" ? "Model unavailable" :
    status.state === "timeout" ? "Timed out" : "Unavailable";
  setText(wrap, backendLabel + model + " · " + stateLabel);
  setAttr(wrap, "title", status.detail || stateLabel);
  setAttr(wrap, "aria-label", "Inference status: " + backendLabel + " " + stateLabel);
  if (postMessage) {
    onClick(wrap, function () {
      if (status.actionable === "check-connection") postMessage({ type: "chat.checkConnection" });
      else postMessage({ type: "ui.openModelConfig" });
    });
  }
  container.appendChild(wrap);
  return wrap;
}

function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !(ms >= 0)) return '';
  if (ms < 1000) return Math.round(ms) + ' ms';
  var seconds = ms / 1000;
  if (seconds < 10) return seconds.toFixed(1) + ' s';
  var total = Math.round(seconds);
  if (total < 60) return total + ' s';
  var rest = total % 60;
  return Math.floor(total / 60) + ' m' + (rest ? ' ' + rest + ' s' : '');
}

function formatBytes(bytes: number): string {
  if (typeof bytes !== 'number' || !(bytes > 0)) return '';
  return bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' bytes';
}

function formatArgs(args: any): string {
  if (!args || !args.length) return '(none)';
  var out = [];
  for (var i = 0; i < args.length; i++) {
    var a = String(args[i]);
    out.push(a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a);
  }
  return out.join(' ');
}

function terminalStatusLabel(term: any): string {
  switch (term.status) {
    case 'WAITING_APPROVAL': return 'Waiting for approval';
    case 'RUNNING': return 'Running';
    case 'SUCCEEDED': return 'Passed';
    case 'FAILED': return 'Failed';
    case 'TIMED_OUT': return 'Timed out';
    case 'CANCELLED': return 'Cancelled';
    case 'REJECTED': return 'Rejected — not run';
    default: return String(term.status || 'Unknown');
  }
}

function terminalResultText(term: any): string {
  var parts = [];
  if (term.status === 'TIMED_OUT') parts.push('Stopped after the ' + formatDuration(term.timeoutMs) + ' limit');
  if (term.exitCode !== undefined && term.exitCode !== null) parts.push('Exit ' + term.exitCode);
  if (term.exitSignal) parts.push('Signal ' + term.exitSignal);
  if (typeof term.durationMs === 'number') parts.push(formatDuration(term.durationMs));
  if (term.status === 'CANCELLED' && !parts.length) parts.push('Process stopped');
  return parts.join(' · ');
}

function terminalOutputText(term: any): string {
  var text = '';
  if (term.stdout) text += term.stdout;
  if (term.stderr) text += (text ? '\n--- stderr ---\n' : '') + term.stderr;
  if (text) return text;
  return term.status === 'RUNNING' ? '(waiting for output…)' : '(no output)';
}

function appendMetaRow(d: any, parent: any, label: string, value: string, mono?: boolean): any {
  var row = d.createElement('div');
  row.className = 'terminal-row';
  var k = d.createElement('span');
  k.className = 'terminal-row-label';
  setText(k, label);
  var v = d.createElement('span');
  v.className = mono ? 'terminal-row-value mono' : 'terminal-row-value';
  setText(v, value);
  row.appendChild(k);
  row.appendChild(v);
  parent.appendChild(row);
  return v;
}

function appendAction(d: any, parent: any, label: string, aria: string, handler?: () => void): any {
  var btn = d.createElement('button');
  btn.className = 'btn-reject';
  btn.type = 'button';
  setText(btn, label);
  setAttr(btn, 'aria-label', aria);
  if (handler) onClick(btn, handler);
  parent.appendChild(btn);
  return btn;
}

/** Elapsed time for a running command; called by the view's one-second ticker. */
export function updateTerminalElapsed(container: any, now: number): boolean {
  var view = container && container.__termView;
  if (!view || !view.elapsedEl || typeof view.startedAt !== 'number') return false;
  setText(view.elapsedEl, 'Running for ' + formatDuration(Math.max(0, now - view.startedAt)));
  return true;
}

/**
 * Renders the controlled-terminal card. Streaming updates for the same execution
 * only replace the output text; the card is rebuilt only when its structure changes.
 */
export function renderTerminalOutput(
  container: any,
  term: any,
  doc?: any,
  postMessage?: (msg: any) => void,
  onRetry?: (term: any) => void
): any {
  if (!term) {
    container.innerHTML = '';
    container.__termView = null;
    return null;
  }
  var structure = [term.executionId, term.status, term.isOutputVisible ? 1 : 0, term.stdoutTruncated ? 1 : 0,
    term.stderrTruncated ? 1 : 0, term.exitCode, term.exitSignal, term.durationMs].join('|');
  var existing = container.__termView;
  if (existing && existing.structure === structure) {
    if (existing.outBox) setText(existing.outBox, terminalOutputText(term));
    return existing.card;
  }

  container.innerHTML = '';
  var d = docOf(doc);
  var running = term.status === 'RUNNING';
  var finished = !running && term.status !== 'WAITING_APPROVAL';
  var card = d.createElement('div');
  card.className = 'terminal-card status-' + String(term.status || '').toLowerCase();
  setAttr(card, 'role', 'region');
  setAttr(card, 'aria-label', 'Controlled command: ' + terminalStatusLabel(term));

  var header = d.createElement('div');
  header.className = 'terminal-header';
  var title = d.createElement('span');
  title.className = 'terminal-title';
  setText(title, 'Command');
  var badge = d.createElement('span');
  badge.className = 'status-badge';
  setAttr(badge, 'role', 'status');
  setText(badge, terminalStatusLabel(term));
  header.appendChild(title);
  header.appendChild(badge);
  card.appendChild(header);

  var cmdBox = d.createElement('div');
  cmdBox.className = 'terminal-command-box';
  setAttr(cmdBox, 'aria-label', 'Command line');
  setText(cmdBox, term.command || '');
  card.appendChild(cmdBox);

  var meta = d.createElement('div');
  meta.className = 'terminal-meta';
  if (term.executable) appendMetaRow(d, meta, 'Executable', term.executable, true);
  if (term.args) appendMetaRow(d, meta, 'Arguments', formatArgs(term.args), true);
  appendMetaRow(d, meta, 'Directory', term.cwd || '', true);
  appendMetaRow(d, meta, 'Source', term.provenance || '');
  if (term.scriptName && term.scriptBody) appendMetaRow(d, meta, 'Script', term.scriptBody, true);
  appendMetaRow(d, meta, 'Time limit', formatDuration(term.timeoutMs));
  card.appendChild(meta);

  var elapsedEl = null;
  if (running && typeof term.startedAt === 'number') {
    elapsedEl = d.createElement('div');
    elapsedEl.className = 'terminal-elapsed';
    card.appendChild(elapsedEl);
  }
  var result = finished ? terminalResultText(term) : '';
  if (result) {
    var resultLine = d.createElement('div');
    resultLine.className = 'terminal-result';
    setText(resultLine, result);
    card.appendChild(resultLine);
  }

  var limit = formatBytes(term.outputLimitBytes) || 'the retained-output limit';
  var streams = [];
  if (term.stdoutTruncated) streams.push('stdout');
  if (term.stderrTruncated) streams.push('stderr');
  if (streams.length) {
    var truncWarn = d.createElement('div');
    truncWarn.className = 'truncation-warning';
    setAttr(truncWarn, 'role', 'note');
    setText(truncWarn, 'Output truncated: only the first ' + limit + ' of ' + streams.join(' and ') + ' was kept.');
    card.appendChild(truncWarn);
  }

  var outBox = null;
  if (term.isOutputVisible) {
    outBox = d.createElement('pre');
    outBox.className = 'terminal-output-box';
    setAttr(outBox, 'tabindex', '0');
    setAttr(outBox, 'aria-label', 'Command output');
    setText(outBox, terminalOutputText(term));
    card.appendChild(outBox);
  }

  var actions = d.createElement('div');
  actions.className = 'confirmation-actions';
  var send = postMessage;
  var id = term.executionId;
  if (term.status !== 'WAITING_APPROVAL') {
    appendAction(d, actions, term.isOutputVisible ? 'Hide output' : 'Show output',
      term.isOutputVisible ? 'Hide command output' : 'Show command output',
      send ? function () { send!({ type: 'terminal.toggleOutput', executionId: id }); } : undefined);
  }
  appendAction(d, actions, 'Copy command', 'Copy command line',
    send ? function () { send!({ type: 'terminal.copyCommand', executionId: id }); } : undefined);
  if (finished && term.status !== 'REJECTED') {
    appendAction(d, actions, 'Copy output', 'Copy command output',
      send ? function () { send!({ type: 'terminal.copyOutput', executionId: id }); } : undefined);
    appendAction(d, actions, 'Output panel', 'Open output in the Output panel',
      send ? function () { send!({ type: 'terminal.openOutput', executionId: id }); } : undefined);
  }
  if (running) {
    appendAction(d, actions, 'Cancel', 'Cancel the running command and stop the task',
      send ? function () { send!({ type: 'terminal.cancel', executionId: id }); } : undefined);
  }
  if (onRetry && (term.status === 'FAILED' || term.status === 'TIMED_OUT' || term.status === 'CANCELLED')) {
    appendAction(d, actions, 'Ask to retry', 'Draft a message asking the agent to run this check again',
      function () { onRetry(term); });
  }
  card.appendChild(actions);
  container.appendChild(card);
  container.__termView = {
    structure: structure,
    card: card,
    outBox: outBox,
    elapsedEl: elapsedEl,
    startedAt: running ? term.startedAt : null,
  };
  if (elapsedEl) updateTerminalElapsed(container, Date.now());
  return card;
}

function shortHash(hash: any): string {
  return typeof hash === 'string' && hash ? hash.slice(0, 12) : '';
}

function lineDelta(m: any): string {
  if (!m) return '';
  var parts = [];
  if (typeof m.linesAdded === 'number') parts.push('+' + m.linesAdded);
  if (typeof m.linesRemoved === 'number') parts.push('−' + m.linesRemoved);
  return parts.join(' ');
}

function reviewStatusLabel(status: string): string {
  switch (status) {
    case 'pending': return 'Awaiting review';
    case 'applied': return 'Applied';
    case 'rejected': return 'Rejected';
    case 'cancelled': return 'Cancelled';
    case 'stale': return 'Stale — not applied';
    case 'failed': return 'Failed';
    case 'running': return 'Running';
    case 'succeeded': return 'Passed';
    case 'timed-out': return 'Timed out';
    case 'interrupted': return 'Interrupted';
    default: return String(status || '');
  }
}

/** Compact per-conversation ledger of proposed changes and approved commands. */
export function renderReviewLedger(container: any, reviews: any[], doc?: any, postMessage?: (msg: any) => void): any {
  var list = reviews || [];
  var sig = JSON.stringify(list);
  if (container.__reviewSig === sig) return container.firstChild || null;
  container.__reviewSig = sig;
  container.innerHTML = '';
  if (!list.length) return null;

  var d = docOf(doc);
  var counts: Record<string, number> = {};
  for (var c = 0; c < list.length; c++) counts[list[c].status] = (counts[list[c].status] || 0) + 1;
  var summaryParts = [];
  var order = ['pending', 'running', 'applied', 'succeeded', 'rejected', 'stale', 'failed', 'timed-out', 'cancelled', 'interrupted'];
  for (var o = 0; o < order.length; o++) {
    if (counts[order[o]]) summaryParts.push(counts[order[o]] + ' ' + reviewStatusLabel(order[o]).toLowerCase());
  }

  var details = d.createElement('details');
  details.className = 'review-ledger';
  details.open = true;
  var summary = d.createElement('summary');
  setText(summary, 'Changes & commands · ' + summaryParts.join(' · '));
  details.appendChild(summary);

  var ul = d.createElement('ul');
  ul.className = 'review-list';
  setAttr(ul, 'aria-label', 'Changes and commands in this conversation');
  var anyApplied = false;
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.kind === 'mutation' && r.status === 'applied') anyApplied = true;
    var li = d.createElement('li');
    li.className = 'review-item is-' + r.status;
    var mark = d.createElement('span');
    mark.className = 'activity-mark';
    setAttr(mark, 'aria-hidden', 'true');
    li.appendChild(mark);

    var body = d.createElement('div');
    body.className = 'review-body';
    var line = d.createElement('div');
    line.className = 'review-line';
    var subject = d.createElement('span');
    subject.className = 'review-subject mono';
    if (r.kind === 'mutation') {
      setText(subject, (r.mutation && r.mutation.operation === 'create' ? 'New ' : '') + (r.path || 'unknown file'));
    } else {
      setText(subject, r.command || 'command');
    }
    line.appendChild(subject);
    var delta = r.kind === 'mutation' ? lineDelta(r.mutation) : '';
    if (delta) {
      var deltaEl = d.createElement('span');
      deltaEl.className = 'review-delta';
      setAttr(deltaEl, 'aria-label', delta.replace('+', 'added ').replace('−', 'removed '));
      setText(deltaEl, delta);
      line.appendChild(deltaEl);
    }
    var state = d.createElement('span');
    state.className = 'review-status';
    var stateText = reviewStatusLabel(r.status);
    if (r.kind === 'command' && r.exitCode !== undefined && r.exitCode !== null) stateText += ' · exit ' + r.exitCode;
    if (r.kind === 'command' && typeof r.durationMs === 'number') stateText += ' · ' + formatDuration(r.durationMs);
    setText(state, stateText);
    line.appendChild(state);
    body.appendChild(line);

    if (r.detail) {
      var detail = d.createElement('div');
      detail.className = 'review-detail';
      setText(detail, r.detail);
      body.appendChild(detail);
    }
    if (r.kind === 'mutation' && r.verifiedBy) {
      var ver = d.createElement('div');
      ver.className = 'review-detail';
      setText(ver, 'Checked by ' + r.verifiedBy.command + ': ' + reviewStatusLabel(r.verifiedBy.status).toLowerCase());
      body.appendChild(ver);
    }
    if (r.kind === 'command' && r.verifies && r.verifies.length) {
      var covers = d.createElement('div');
      covers.className = 'review-detail';
      setText(covers, 'Checks ' + r.verifies.length + ' applied change' + (r.verifies.length === 1 ? '' : 's'));
      body.appendChild(covers);
    }
    li.appendChild(body);

    if (postMessage) {
      var send = postMessage;
      if (r.kind === 'mutation' && r.path) {
        var openBtn = d.createElement('button');
        openBtn.className = 'btn-reject review-action';
        openBtn.type = 'button';
        setText(openBtn, r.status === 'applied' ? 'Changes' : 'Open');
        setAttr(openBtn, 'aria-label', (r.status === 'applied' ? 'Show changes in ' : 'Open ') + r.path);
        onClick(openBtn, function (mid: string) { return function () { send({ type: 'review.openChange', mutationId: mid }); }; }(r.id));
        li.appendChild(openBtn);
      } else if (r.kind === 'command' && r.status !== 'pending' && r.status !== 'rejected' && r.outputAvailable !== false) {
        var outBtn = d.createElement('button');
        outBtn.className = 'btn-reject review-action';
        outBtn.type = 'button';
        setText(outBtn, 'Output');
        setAttr(outBtn, 'aria-label', 'Open output of ' + (r.command || 'command') + ' in the Output panel');
        onClick(outBtn, function (eid: string) { return function () { send({ type: 'terminal.openOutput', executionId: eid }); }; }(r.id));
        li.appendChild(outBtn);
      }
    }
    ul.appendChild(li);
  }
  details.appendChild(ul);

  if (anyApplied && postMessage) {
    var scmRow = d.createElement('div');
    scmRow.className = 'review-footer';
    var send2 = postMessage;
    appendAction(d, scmRow, 'Source Control', 'Open the Source Control view to review applied changes',
      function () { send2({ type: 'ui.openSourceControl' }); });
    details.appendChild(scmRow);
  }
  container.appendChild(details);
  return details;
}

export function renderConfirmationSummary(
  container: any,
  conf: any,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  // An unchanged request keeps its card, so keyboard focus and the click lock survive
  // unrelated state pushes (activity, connection, history).
  var sig = conf ? JSON.stringify([conf, !!postMessage]) : '';
  if (container.__confirmationSig === sig && (!conf || container.firstChild)) return container.firstChild || null;
  container.__confirmationSig = sig;
  container.innerHTML = '';
  if (!conf) return null;

  const d = docOf(doc);
  const div = d.createElement('div');
  div.className = 'confirmation-card';
  setAttr(div, 'role', 'alertdialog');
  setAttr(div, 'aria-label', conf.riskLabel || 'Approval required');
  setAttr(div, 'data-confirmation-id', conf.id || '');

  const title = d.createElement('div');
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '5px';
  title.textContent = conf.riskLabel || 'Approval Required';

  const summary = d.createElement('div');
  summary.style.fontSize = '0.9em';
  summary.style.marginBottom = '10px';
  summary.textContent = conf.summary;

  div.appendChild(title);
  div.appendChild(summary);
  if (conf.preparedCommand) {
    var pc = conf.preparedCommand;
    var cmdBox = d.createElement('div');
    cmdBox.className = 'terminal-command-box';
    setAttr(cmdBox, 'aria-label', 'Command line');
    setText(cmdBox, pc.command || '');
    div.appendChild(cmdBox);
    var cmdMeta = d.createElement('div');
    cmdMeta.className = 'terminal-meta';
    if (pc.executable) appendMetaRow(d, cmdMeta, 'Executable', pc.executable, true);
    if (pc.args) appendMetaRow(d, cmdMeta, 'Arguments', formatArgs(pc.args), true);
    appendMetaRow(d, cmdMeta, 'Directory', pc.cwd || '', true);
    appendMetaRow(d, cmdMeta, 'Source', pc.provenance || '');
    if (pc.scriptName && pc.scriptBody) appendMetaRow(d, cmdMeta, 'Script', pc.scriptBody, true);
    if (typeof pc.timeoutMs === 'number') appendMetaRow(d, cmdMeta, 'Time limit', formatDuration(pc.timeoutMs));
    div.appendChild(cmdMeta);
  } else if (conf.mutationId) {
    var m = conf.mutation || {};
    var mutMeta = d.createElement('div');
    mutMeta.className = 'terminal-meta';
    appendMetaRow(d, mutMeta, m.operation === 'create' ? 'New file' : 'File', conf.path || 'unknown', true);
    var delta = lineDelta(m);
    if (delta) appendMetaRow(d, mutMeta, 'Lines', delta);
    if (m.beforeHash) appendMetaRow(d, mutMeta, 'Base', 'sha256 ' + shortHash(m.beforeHash) + ' — re-checked before writing', true);
    div.appendChild(mutMeta);
  }
  if (conf.blockedReason) {
    var blocked = d.createElement('div');
    blocked.className = 'confirmation-blocked';
    setAttr(blocked, 'role', 'alert');
    setText(blocked, conf.blockedReason);
    div.appendChild(blocked);
  }

  const actions = d.createElement('div');
  actions.className = 'confirmation-actions';

  const btnReject = d.createElement('button');
  btnReject.className = 'btn-reject';
  btnReject.id = 'btn-reject';
  btnReject.type = 'button';
  btnReject.textContent = 'Reject';
  setAttr(btnReject, 'aria-label', 'Reject this action');

  const btnApprove = d.createElement('button');
  btnApprove.className = 'btn-approve';
  btnApprove.id = 'btn-approve';
  btnApprove.type = 'button';
  btnApprove.textContent = conf.preparedCommand ? 'Run' : 'Approve';
  setAttr(btnApprove, 'aria-label', conf.preparedCommand ? 'Run this command' : 'Approve this change');

  let btnDiff: any = null;
  if (conf.mutationId) {
    btnDiff = d.createElement('button');
    btnDiff.className = 'btn-reject';
    btnDiff.id = 'btn-diff';
    btnDiff.type = 'button';
    btnDiff.textContent = 'Open Diff';
    setAttr(btnDiff, 'aria-label', 'Preview file change in a diff editor');
    actions.appendChild(btnDiff);
  }
  var btnOpen: any = null;
  if (conf.mutationId && conf.path && !(conf.mutation && conf.mutation.operation === 'create')) {
    btnOpen = d.createElement('button');
    btnOpen.className = 'btn-reject';
    btnOpen.type = 'button';
    btnOpen.textContent = 'Open File';
    setAttr(btnOpen, 'aria-label', 'Open the current ' + conf.path);
    actions.appendChild(btnOpen);
  }

  actions.appendChild(btnReject);
  actions.appendChild(btnApprove);
  div.appendChild(actions);
  container.appendChild(div);

  var locked = false;
  function lockButtons() {
    if (locked) return false;
    locked = true;
    btnApprove.disabled = true;
    btnReject.disabled = true;
    if (btnDiff) btnDiff.disabled = true;
    return true;
  }

  if (conf.responding) {
    lockButtons();
  }

  // Move keyboard focus to the new decision once, never onto Approve.
  var focusTarget = btnDiff || btnReject;
  if (container.__focusedConfirmation !== conf.id && !conf.responding) {
    container.__focusedConfirmation = conf.id;
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  }

  if (postMessage) {
    if (btnOpen && btnOpen.addEventListener) {
      var openPath = conf.path;
      btnOpen.addEventListener('click', () => {
        postMessage({ type: 'ui.openFile', path: openPath });
      });
    }
    if (btnDiff && btnDiff.addEventListener) {
      btnDiff.addEventListener('click', () => {
        postMessage({ type: 'ui.openDiff', mutationId: conf.mutationId, path: conf.path || 'unknown', isCreate: conf.type === 'create' });
      });
    }
    if (btnApprove.addEventListener) {
      btnApprove.addEventListener('click', () => {
        if (!lockButtons()) return;
        const msgType = conf.preparedCommand ? 'terminal.respond' : 'confirmation.respond';
        postMessage({ type: msgType, confirmationId: conf.id, action: 'APPROVE' });
      });
    }
    if (btnReject.addEventListener) {
      btnReject.addEventListener('click', () => {
        if (!lockButtons()) return;
        const msgType = conf.preparedCommand ? 'terminal.respond' : 'confirmation.respond';
        postMessage({ type: msgType, confirmationId: conf.id, action: 'REJECT' });
      });
    }
  }

  return div;
}

export function handleComposerKeydown(event: any, send: () => void): boolean {
  if (!event) return false;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    send();
    return true;
  }
  if (event.key === "Escape") {
    return false;
  }
  return false;
}

/**
 * Source injected into the Webview script tag. Helpers must be concatenated
 * because Function.prototype.toString() of a bundled export does not close
 * over sibling module locals (MAX_CODE_CHARS, setText, fillMessageBody, ...).
 */
// ---- Sprint 7C: conversation history, title bar and recovery view -------------

function conversationStatusLabel(status: string): string {
  switch (status) {
    case 'running': return 'Running';
    case 'interrupted': return 'Interrupted';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return '';
  }
}

function relativeTime(ts: number, now: number): string {
  if (typeof ts !== 'number' || !(ts > 0)) return '';
  var diff = Math.max(0, now - ts);
  var minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  var days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

export function filterConversations(conversations: any[], filter: string, showArchived: boolean): any[] {
  var q = String(filter || '').trim().toLowerCase();
  var out = [];
  for (var i = 0; i < (conversations || []).length; i++) {
    var c = conversations[i];
    if (!c || (c.archived && !showArchived)) continue;
    if (q) {
      var hay = (String(c.title || '') + '\n' + String(c.preview || '') + '\n' + String(c.mode || '')).toLowerCase();
      if (hay.indexOf(q) === -1) continue;
    }
    out.push(c);
  }
  return out;
}

/** Title of the active conversation, its status, and entry points to history and recovery. */
export function renderConversationBar(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var title = (state && state.conversationTitle) || 'New conversation';
  var status = (state && state.lastStatus) || 'idle';
  var sig = [state && state.conversationId, title, status, state && state.activeTurn ? 1 : 0, state && state.recovery ? 1 : 0].join('\u0000');
  if (container.__barSig === sig) return container.firstChild || null;
  container.__barSig = sig;
  container.innerHTML = '';
  var d = docOf(doc);
  var bar = d.createElement('div');
  bar.className = 'conversation-bar';
  var titleEl = d.createElement('span');
  titleEl.className = 'conversation-title';
  setAttr(titleEl, 'title', title);
  setText(titleEl, title);
  bar.appendChild(titleEl);
  var label = conversationStatusLabel(status);
  if (label && !(state && state.activeTurn && status === 'running')) {
    var badge = d.createElement('span');
    badge.className = 'conversation-status is-' + status;
    setText(badge, label);
    bar.appendChild(badge);
  }
  if (postMessage && (status === 'interrupted' || status === 'failed' || status === 'cancelled') && !(state && state.activeTurn)) {
    var send = postMessage;
    var id = state.conversationId;
    var rec = appendAction(d, bar, 'Recovery', 'Show recovery status for this conversation', function () {
      send({ type: 'conversation.inspectRecovery', conversationId: id });
    });
    rec.className = 'btn-reject conversation-action';
  }
  container.appendChild(bar);
  return bar;
}

/** Moves keyboard focus between the open buttons of the history list. */
export function moveListFocus(items: any[], current: any, delta: number): any {
  if (!items || !items.length) return null;
  var index = -1;
  for (var i = 0; i < items.length; i++) if (items[i] === current) index = i;
  var next = items[Math.max(0, Math.min(items.length - 1, index < 0 ? 0 : index + delta))];
  if (next && typeof next.focus === 'function') next.focus();
  return next;
}

/**
 * Conversation picker. Safe metadata only (title, time, mode, status, short
 * preview). Opening, renaming, archiving and deleting are requests to the host;
 * deleting is confirmed natively there.
 */
export function renderHistoryPanel(
  container: any,
  conversations: any[],
  options: any,
  doc?: any,
  postMessage?: (msg: any) => void,
  handlers?: any
): { visible: number; openButtons: any[] } {
  var opts = options || {};
  var list = filterConversations(conversations, opts.filter, opts.showArchived);
  var sig = JSON.stringify([list, opts.activeId, opts.filter, opts.showArchived, opts.renamingId, opts.history, Math.floor((opts.now || 0) / 60000)]);
  if (container.__historySig === sig && container.__historyResult) return container.__historyResult;
  container.__historySig = sig;
  container.innerHTML = '';
  var d = docOf(doc);
  var h = handlers || {};
  var openButtons: any[] = [];
  var result = { visible: list.length, openButtons: openButtons };
  container.__historyResult = result;

  if (opts.history && opts.history.notice) {
    var notice = d.createElement('div');
    notice.className = 'history-notice';
    setAttr(notice, 'role', 'status');
    setText(notice, opts.history.notice);
    container.appendChild(notice);
  }
  if (!list.length) {
    var empty = d.createElement('div');
    empty.className = 'history-empty';
    if (opts.history && opts.history.enabled === false) setText(empty, 'History is not saved in this window.');
    else if (!(conversations || []).length) setText(empty, 'No saved conversations yet. Send a message to start one.');
    else if (opts.filter) setText(empty, 'No conversations match "' + opts.filter + '".');
    else setText(empty, 'Only archived conversations exist. Turn on "Show archived" to see them.');
    container.appendChild(empty);
    return result;
  }

  var ul = d.createElement('ul');
  ul.className = 'history-list';
  setAttr(ul, 'aria-label', 'Conversations in this workspace, most recent first');
  var send = postMessage || function () {};
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var li = d.createElement('li');
    var isActive = c.id === opts.activeId;
    li.className = 'history-item' + (isActive ? ' is-active' : '') + (c.archived ? ' is-archived' : '');

    if (opts.renamingId === c.id) {
      var input = d.createElement('input');
      input.className = 'history-rename';
      input.type = 'text';
      input.value = c.title || '';
      setAttr(input, 'aria-label', 'New title for ' + (c.title || 'conversation') + '. Enter to save, Escape to cancel.');
      setAttr(input, 'maxlength', '80');
      if (typeof input.addEventListener === 'function') {
        input.addEventListener('keydown', function (cid: string, el: any) {
          return function (e: any) {
            if (e.key === 'Enter') {
              if (typeof e.preventDefault === 'function') e.preventDefault();
              send({ type: 'conversation.rename', conversationId: cid, title: String(el.value || '') });
              if (h.onRenameDone) h.onRenameDone(cid);
            } else if (e.key === 'Escape') {
              if (typeof e.preventDefault === 'function') e.preventDefault();
              if (typeof e.stopPropagation === 'function') e.stopPropagation();
              if (h.onRenameDone) h.onRenameDone(cid);
            }
          };
        }(c.id, input));
      }
      li.appendChild(input);
      ul.appendChild(li);
      if (typeof input.focus === 'function') input.focus();
      continue;
    }

    var open = d.createElement('button');
    open.className = 'history-open';
    open.type = 'button';
    if (isActive) setAttr(open, 'aria-current', 'true');
    var meta = [relativeTime(c.updatedAt, opts.now || Date.now()), c.mode, c.messageCount + ' message' + (c.messageCount === 1 ? '' : 's')];
    var statusLabel = conversationStatusLabel(c.lastStatus);
    if (statusLabel) meta.push(statusLabel);
    if (c.archived) meta.push('Archived');
    if (isActive) meta.push('Current');
    var titleSpan = d.createElement('span');
    titleSpan.className = 'history-title';
    setText(titleSpan, c.title || 'New conversation');
    open.appendChild(titleSpan);
    var metaSpan = d.createElement('span');
    metaSpan.className = 'history-meta';
    setText(metaSpan, meta.filter(function (x: string) { return !!x; }).join(' · '));
    open.appendChild(metaSpan);
    setAttr(open, 'aria-label', (c.title || 'New conversation') + ', ' + metaSpan.textContent + '. Enter to open, F2 to rename, Delete to delete.');
    onClick(open, function (cid: string) { return function () { send({ type: 'conversation.open', conversationId: cid }); if (h.onOpen) h.onOpen(cid); }; }(c.id));
    if (typeof open.addEventListener === 'function') {
      open.addEventListener('keydown', function (cid: string) {
        return function (e: any) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            moveListFocus(openButtons, e.currentTarget || e.target, e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key === 'Home' || e.key === 'End') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            var edge = openButtons[e.key === 'Home' ? 0 : openButtons.length - 1];
            if (edge && typeof edge.focus === 'function') edge.focus();
          } else if (e.key === 'F2') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            if (h.onRenameStart) h.onRenameStart(cid);
          } else if (e.key === 'Delete') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            send({ type: 'conversation.delete', conversationId: cid });
          }
        };
      }(c.id));
    }
    li.appendChild(open);
    openButtons.push(open);

    var actions = d.createElement('div');
    actions.className = 'history-actions';
    var title = c.title || 'conversation';
    appendAction(d, actions, 'Rename', 'Rename ' + title, function (cid: string) { return function () { if (h.onRenameStart) h.onRenameStart(cid); }; }(c.id));
    appendAction(d, actions, 'Continue', 'Start a new conversation using ' + title + ' as background context', function (cid: string) { return function () { send({ type: 'conversation.continueFrom', conversationId: cid }); }; }(c.id));
    appendAction(d, actions, c.archived ? 'Unarchive' : 'Archive', (c.archived ? 'Unarchive ' : 'Archive ') + title, function (cid: string, archived: boolean) { return function () { send({ type: 'conversation.archive', conversationId: cid, archived: !archived }); }; }(c.id, !!c.archived));
    appendAction(d, actions, 'Delete', 'Delete ' + title + ' (asks for confirmation)', function (cid: string) { return function () { send({ type: 'conversation.delete', conversationId: cid }); }; }(c.id));
    if (c.lastStatus === 'interrupted' || c.lastStatus === 'failed' || c.lastStatus === 'cancelled') {
      appendAction(d, actions, 'Recovery', 'Show recovery status for ' + title, function (cid: string) { return function () { send({ type: 'conversation.inspectRecovery', conversationId: cid }); }; }(c.id));
    }
    li.appendChild(actions);
    ul.appendChild(li);
  }
  container.appendChild(ul);
  return result;
}

function recoveryStateText(state: string): string {
  switch (state) {
    case 'NO_RUN': return 'No agent run was recorded for this conversation.';
    case 'NO_RECORD': return 'No checkpoint or journal remains for the last run. It may never have reached a checkpoint, or it was pruned.';
    case 'COMPLETED': return 'The last run completed. Nothing is waiting to resume.';
    case 'STOPPED': return 'The last run stopped or failed. Agent Core does not retry it automatically.';
    case 'INTERRUPTED': return 'The last run was interrupted between steps. No unfinished change or command is recorded.';
    case 'REVERIFY': return 'The last run was interrupted after a change or during a check. Re-run your checks before relying on the result.';
    case 'RECONFIRM': return 'The last run was waiting for your approval. That approval ended with the run; the pending change or command was not applied.';
    case 'MANUAL_INSPECTION': return 'Files are not in a state Agent Core can reconcile. Inspect the files below before continuing.';
    case 'UNREADABLE': return 'The recovery records for the last run could not be read. Inspect the files manually.';
    default: return String(state || '');
  }
}

function operationKindLabel(kind: string): string {
  switch (kind) {
    case 'MUTATION': return 'Change';
    case 'ROLLBACK_MUTATION': return 'Rollback';
    case 'VERIFICATION': return 'Command';
    case 'MCP_SIDE_EFFECT': return 'External tool call';
    case 'MCP_READ': return 'External read';
    case 'MODEL_CALL': return 'Model call';
    case 'CONTEXT_READ': return 'Context read';
    default: return String(kind || 'Operation');
  }
}

function operationStatusLabel(status: string): string {
  switch (status) {
    case 'PREPARED': return 'prepared';
    case 'STARTED': return 'started';
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'INTERRUPTED': return 'interrupted';
    case 'RECONCILED_APPLIED': return 'found applied on disk';
    case 'RECONCILED_NOT_APPLIED': return 'not applied';
    case 'AMBIGUOUS': return 'outcome unknown — inspect';
    case 'ROLLED_BACK': return 'rolled back';
    case 'SUPERSEDED': return 'superseded';
    default: return String(status || '').toLowerCase();
  }
}

/**
 * Read-only recovery view. It separates the three things a user might mean by
 * "recover": the restored display, a new task with this context, and resuming
 * the interrupted run, which the editor does not offer.
 */
export function renderRecoveryPanel(container: any, recovery: any, title: string, doc?: any, postMessage?: (msg: any) => void): any {
  var sig = recovery ? JSON.stringify([recovery, title]) : '';
  if (container.__recoverySig === sig) return container.firstChild || null;
  container.__recoverySig = sig;
  container.innerHTML = '';
  if (!recovery) return null;
  var d = docOf(doc);
  var send = postMessage || function () {};
  var panel = d.createElement('section');
  panel.className = 'recovery-panel' + (recovery.manualInspectionRequired ? ' needs-inspection' : '');
  setAttr(panel, 'aria-label', 'Recovery status for ' + (title || 'this conversation'));

  var header = d.createElement('div');
  header.className = 'terminal-header';
  var h = d.createElement('span');
  h.className = 'terminal-title';
  setText(h, 'Recovery status');
  header.appendChild(h);
  var badge = d.createElement('span');
  badge.className = 'status-badge';
  setAttr(badge, 'role', 'status');
  setText(badge, recovery.manualInspectionRequired ? 'Manual inspection required' : 'Read-only');
  header.appendChild(badge);
  panel.appendChild(header);

  appendMetaRow(d, panel, 'Conversation', title || 'this conversation');
  appendMetaRow(d, panel, 'Last task', conversationStatusLabel(recovery.lastStatus) || (recovery.lastStatus === 'completed' ? 'Completed' : 'No task yet'));
  if (recovery.checkpoint) {
    var cp = recovery.checkpoint;
    appendMetaRow(d, panel, 'Checkpoint', cp.reason + ' · ' + cp.phase + ' · ' + cp.status + (cp.fromEarlierProcess ? ' · from an earlier editor session' : ''));
    if (cp.createdAt) appendMetaRow(d, panel, 'Saved at', String(cp.createdAt));
  } else {
    appendMetaRow(d, panel, 'Checkpoint', 'None recorded');
  }
  var stateRow = d.createElement('div');
  stateRow.className = 'recovery-state';
  setText(stateRow, recoveryStateText(recovery.state));
  panel.appendChild(stateRow);
  if (recovery.reasons && recovery.reasons.length) {
    var reasons = d.createElement('div');
    reasons.className = 'review-detail';
    setText(reasons, 'Agent Core: ' + recovery.reasons.join(' '));
    panel.appendChild(reasons);
  }

  if (recovery.operations && recovery.operations.length) {
    var ops = d.createElement('ul');
    ops.className = 'review-list';
    setAttr(ops, 'aria-label', 'Recorded operations of the last run');
    for (var i = 0; i < recovery.operations.length; i++) {
      var op = recovery.operations[i];
      var li = d.createElement('li');
      li.className = 'review-item' + (op.blocked ? ' is-failed' : '');
      var text = operationKindLabel(op.kind) + (op.path ? ' ' + op.path : '') + ': ' + operationStatusLabel(op.journalStatus);
      if (op.observedStatus && op.observedStatus !== op.journalStatus) text += ' → ' + operationStatusLabel(op.observedStatus);
      setText(li, text);
      ops.appendChild(li);
    }
    panel.appendChild(ops);
  }

  if (recovery.files && recovery.files.length) {
    var files = d.createElement('div');
    files.className = 'recovery-files';
    var fl = d.createElement('span');
    fl.className = 'terminal-row-label';
    setText(fl, 'Files');
    files.appendChild(fl);
    for (var f = 0; f < recovery.files.length; f++) {
      var fb = d.createElement('button');
      fb.className = 'file-ref';
      fb.type = 'button';
      setText(fb, recovery.files[f]);
      setAttr(fb, 'aria-label', 'Open ' + recovery.files[f]);
      onClick(fb, function (p: string) { return function () { send({ type: 'ui.openFile', path: p }); }; }(recovery.files[f]));
      files.appendChild(fb);
    }
    panel.appendChild(files);
  }

  var options = d.createElement('ul');
  options.className = 'recovery-options';
  var o1 = d.createElement('li');
  setText(o1, 'Conversation display: restored. Restoring shows history only; it runs nothing and grants no approval.');
  options.appendChild(o1);
  var o2 = d.createElement('li');
  setText(o2, 'New task with this context: starts a fresh conversation with the last turns as background. Every change and command needs a new approval.');
  options.appendChild(o2);
  var o3 = d.createElement('li');
  setText(o3, 'Resume the interrupted run: not available from the editor. Interrupted changes, commands and external tool calls are never replayed.');
  options.appendChild(o3);
  panel.appendChild(options);

  var actions = d.createElement('div');
  actions.className = 'confirmation-actions';
  var cid = recovery.conversationId;
  var cont = appendAction(d, actions, 'Start new task with this context', 'Start a new conversation using this conversation as background context', function () {
    send({ type: 'conversation.continueFrom', conversationId: cid });
  });
  cont.className = 'btn-approve';
  appendAction(d, actions, 'Close', 'Close recovery status', function () { send({ type: 'conversation.closeRecovery' }); });
  panel.appendChild(actions);
  container.appendChild(panel);
  return panel;
}

export function webviewRenderRuntime(): string {
  return [
    "var MAX_CODE_CHARS = " + MAX_CODE_CHARS + ";",
    setText.toString(),
    setAttr.toString(),
    onClick.toString(),
    docOf.toString(),
    pushTextWithFileRefs.toString(),
    parseMessageSegments.toString(),
    roleLabel.toString(),
    appendRoleLabel.toString(),
    fillMessageBody.toString(),
    messageSig.toString(),
    renderChatMessage.toString(),
    updateChatMessage.toString(),
    syncTranscript.toString(),
    renderActivityTimeline.toString(),
    renderContextChips.toString(),
    renderConnectionStatus.toString(),
    formatDuration.toString(),
    formatBytes.toString(),
    formatArgs.toString(),
    terminalStatusLabel.toString(),
    terminalResultText.toString(),
    terminalOutputText.toString(),
    appendMetaRow.toString(),
    appendAction.toString(),
    updateTerminalElapsed.toString(),
    renderTerminalOutput.toString(),
    shortHash.toString(),
    lineDelta.toString(),
    reviewStatusLabel.toString(),
    renderReviewLedger.toString(),
    renderConfirmationSummary.toString(),
    handleComposerKeydown.toString(),
    conversationStatusLabel.toString(),
    relativeTime.toString(),
    filterConversations.toString(),
    renderConversationBar.toString(),
    moveListFocus.toString(),
    renderHistoryPanel.toString(),
    recoveryStateText.toString(),
    operationKindLabel.toString(),
    operationStatusLabel.toString(),
    renderRecoveryPanel.toString(),
  ].join("\n");
}
