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

function appendRoleLabel(d: any, div: any, role: string, status?: string): void {
  var meta = d.createElement("div");
  meta.className = "message-meta";
  var label = role === "assistant" ? "Assistant" : role === "system" ? "System" : "You";
  if (status && status !== "completed" && status !== "pending") label += " · " + status;
  setText(meta, label);
  div.appendChild(meta);
}

export function renderChatMessage(
  container: any,
  message: { id?: string; role?: string; content: string; status?: string; attachments?: any[] } | string,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  var d = docOf(doc);
  var div = d.createElement("div");
  var role = typeof message === "object" && message && message.role ? message.role : "user";
  var content = typeof message === "object" && message ? (message.content ?? "") : String(message ?? "");
  var status = typeof message === "object" && message ? message.status : undefined;
  var id = typeof message === "object" && message && message.id ? message.id : "";
  div.className = "message " + role + (status ? " is-" + status : "");
  setAttr(div, "data-message-id", id);
  setAttr(div, "role", "article");
  setAttr(div, "aria-label", (role === "assistant" ? "Assistant" : role === "system" ? "System" : "User") + " message");

  appendRoleLabel(d, div, role, status);

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
  var onlyPlain = segments.length === 1 && segments[0].kind === "text";
  if (onlyPlain) {
    setText(body, segments[0].text);
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
  message: { id?: string; role?: string; content: string; status?: string; attachments?: any[] },
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  if (!el) return el;
  var d = docOf(doc);
  var role = message.role || "user";
  var status = message.status;
  el.className = "message " + role + (status ? " is-" + status : "");
  var body = null;
  var children = el.children || [];
  for (var i = 0; i < children.length; i++) {
    if (children[i].className && String(children[i].className).indexOf("message-body") !== -1) {
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
  container.innerHTML = "";
  if (!activities || !activities.length) return null;
  var d = docOf(doc);
  var list = d.createElement("ol");
  list.className = "activity-list";
  setAttr(list, "aria-label", "Agent activity");
  var start = Math.max(0, activities.length - 20);
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

export function renderTerminalOutput(
  container: any,
  term: any,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
  container.innerHTML = '';
  if (!term) return null;

  const d = docOf(doc);
  const card = d.createElement('div');
  card.className = 'terminal-card';
  setAttr(card, 'role', 'region');
  setAttr(card, 'aria-label', 'Controlled terminal ' + term.status);

  const title = d.createElement('div');
  title.style.fontWeight = 'bold';
  title.style.marginBottom = '5px';
  title.textContent = 'Controlled Terminal Execution (' + term.status + ')';
  card.appendChild(title);

  const meta = d.createElement('div');
  meta.className = 'terminal-meta';
  meta.textContent = 'CWD: ' + term.cwd + ' | Provenance: ' + term.provenance + ' | Timeout: ' + (term.timeoutMs / 1000) + 's';
  card.appendChild(meta);

  const cmdBox = d.createElement('div');
  cmdBox.className = 'terminal-command-box';
  cmdBox.textContent = term.command;
  card.appendChild(cmdBox);

  if (term.exitCode !== undefined && term.exitCode !== null) {
    const resultLine = d.createElement('div');
    resultLine.className = 'terminal-meta';
    resultLine.textContent = 'Finished with code ' + term.exitCode + (term.durationMs ? ' (' + term.durationMs + 'ms)' : '');
    card.appendChild(resultLine);
  }

  if (term.isOutputVisible) {
    const outBox = d.createElement('div');
    outBox.className = 'terminal-output-box';
    let text = '';
    if (term.stdout) text += term.stdout;
    if (term.stderr) text += (text ? '\n--- STDERR ---\n' : '') + term.stderr;
    outBox.textContent = text || '(No output)';
    card.appendChild(outBox);

    if (term.stdoutTruncated || term.stderrTruncated) {
      const truncWarn = d.createElement('div');
      truncWarn.className = 'truncation-warning';
      truncWarn.textContent = '[Output bounded and truncated at limit]';
      card.appendChild(truncWarn);
    }
  }

  const actions = d.createElement('div');
  actions.className = 'confirmation-actions';

  const btnToggle = d.createElement('button');
  btnToggle.className = 'btn-reject';
  btnToggle.type = 'button';
  btnToggle.textContent = term.isOutputVisible ? 'Hide Output' : 'Show Output';
  setAttr(btnToggle, 'aria-label', term.isOutputVisible ? 'Hide terminal output' : 'Show terminal output');
  if (postMessage && btnToggle.addEventListener) {
    btnToggle.addEventListener('click', () => {
      postMessage({ type: 'terminal.toggleOutput', executionId: term.executionId });
    });
  }
  actions.appendChild(btnToggle);

  const btnCopy = d.createElement('button');
  btnCopy.className = 'btn-reject';
  btnCopy.type = 'button';
  btnCopy.textContent = 'Copy Command';
  setAttr(btnCopy, 'aria-label', 'Copy terminal command');
  if (postMessage && btnCopy.addEventListener) {
    btnCopy.addEventListener('click', () => {
      postMessage({ type: 'terminal.copyCommand', executionId: term.executionId });
    });
  }
  actions.appendChild(btnCopy);

  if (term.status === 'RUNNING') {
    const btnCancel = d.createElement('button');
    btnCancel.className = 'btn-reject';
    btnCancel.type = 'button';
    btnCancel.textContent = 'Cancel';
    setAttr(btnCancel, 'aria-label', 'Cancel running command');
    if (postMessage && btnCancel.addEventListener) {
      btnCancel.addEventListener('click', () => {
        postMessage({ type: 'terminal.cancel', executionId: term.executionId });
      });
    }
    actions.appendChild(btnCancel);
  }

  card.appendChild(actions);
  container.appendChild(card);
  return card;
}

export function renderConfirmationSummary(
  container: any,
  conf: any,
  doc?: any,
  postMessage?: (msg: any) => void
): any {
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

  if (conf.preparedCommand) {
    var cmdMeta = d.createElement('div');
    cmdMeta.className = 'terminal-meta';
    setText(cmdMeta, 'CWD: ' + (conf.preparedCommand.cwd || '') + ' | ' + (conf.preparedCommand.provenance || ''));
    var cmdBox = d.createElement('div');
    cmdBox.className = 'terminal-command-box';
    setText(cmdBox, conf.preparedCommand.command || '');
    div.appendChild(title);
    div.appendChild(summary);
    div.appendChild(cmdMeta);
    div.appendChild(cmdBox);
  } else {
    div.appendChild(title);
    div.appendChild(summary);
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
    setAttr(btnDiff, 'aria-label', 'Preview file change');
    actions.appendChild(btnDiff);
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

  if (postMessage) {
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
export function webviewRenderRuntime(): string {
  return [
    "var MAX_CODE_CHARS = " + MAX_CODE_CHARS + ";",
    setText.toString(),
    setAttr.toString(),
    onClick.toString(),
    docOf.toString(),
    pushTextWithFileRefs.toString(),
    parseMessageSegments.toString(),
    appendRoleLabel.toString(),
    fillMessageBody.toString(),
    messageSig.toString(),
    renderChatMessage.toString(),
    updateChatMessage.toString(),
    syncTranscript.toString(),
    renderActivityTimeline.toString(),
    renderContextChips.toString(),
    renderConnectionStatus.toString(),
    renderTerminalOutput.toString(),
    renderConfirmationSummary.toString(),
    handleComposerKeydown.toString(),
  ].join("\n");
}
