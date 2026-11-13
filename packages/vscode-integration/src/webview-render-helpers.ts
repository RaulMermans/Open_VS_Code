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
  if (status && status !== "completed" && status !== "pending") {
    label += " · " + (status === "rejected" ? "Change rejected" : status);
  }
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
  if (renderOutcomeBody(body, content, d, postMessage)) return;
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

function activityCategory(act: any): string {
  var kind = String((act && act.kind) || "");
  var tool = String((act && act.toolName) || "");
  var label = String((act && act.label) || "");
  if (kind === "approval" || label.indexOf("Waiting for approval") === 0 || label.indexOf("Approval") === 0) return "approval";
  if (kind === "verification") return "checks";
  if (kind === "mutation") return "edit";
  if (kind === "tool") {
    if (tool === "read_file" || tool === "read_file_range") return "read";
    return "explore";
  }
  if (kind === "context") return "understand";
  if (kind === "model") return act && act.planning ? "plan" : "consult";
  if (kind === "task") {
    if (label === "Starting task") return "understand";
    return "outcome";
  }
  return "understand";
}

function activityGroupStatus(items: any[]): string {
  var pending = false;
  var failed = false;
  var cancelled = false;
  var interrupted = false;
  for (var i = 0; i < items.length; i++) {
    var status = items[i] && items[i].status;
    if (status === "pending" || status === "running") pending = true;
    else if (status === "failed") failed = true;
    else if (status === "cancelled") cancelled = true;
    else if (status === "interrupted") interrupted = true;
  }
  if (failed) return "failed";
  if (pending) return "pending";
  if (cancelled) return "cancelled";
  if (interrupted) return "interrupted";
  return "completed";
}

function outcomeTitle(items: any[]): string {
  var last = items[items.length - 1] || {};
  var label = String(last.label || "");
  if (label === "Change rejected" || last.status === "rejected") return "Change rejected";
  if (last.status === "failed" || label === "Failed") return "Failed";
  if (last.status === "cancelled" || label === "Cancelled") return "Cancelled";
  if (last.status === "interrupted" || label === "Interrupted") return "Interrupted";
  if (label.toLowerCase().indexOf("blocked") !== -1) return "Blocked";
  if (label === "Completed" || last.status === "completed") return "Completed";
  return label || "Completed";
}

function groupRetryNote(items: any[]): string {
  var failed = false;
  var completed = false;
  for (var i = 0; i < items.length; i++) {
    var status = items[i] && items[i].status;
    if (status === "failed") failed = true;
    if (status === "completed") completed = true;
  }
  return failed && completed ? " · retry recorded" : "";
}

function activityFiles(items: any[]): string[] {
  var seen: Record<string, boolean> = {};
  var paths: string[] = [];
  for (var i = 0; i < items.length; i++) {
    var act = items[i];
    var kind = act && act.kind;
    if (kind !== "tool" && kind !== "mutation") continue;
    var summary = act && act.summary;
    if (typeof summary !== "string") continue;
    var path = summary.trim();
    if (!path || path.length > 80 || path.indexOf("\n") !== -1) continue;
    if (!seen[path]) {
      seen[path] = true;
      paths.push(path);
    }
  }
  return paths;
}

function fileCountPhrase(count: number, inspected: boolean): string {
  if (count <= 0) return "";
  return " — " + String(count) + " " + (count === 1 ? "file" : "files") + (inspected ? " inspected" : "");
}

function groupTitle(category: string, items: any[]): string {
  var status = activityGroupStatus(items);
  var files = activityFiles(items);
  var retry = groupRetryNote(items);
  if (category === "approval") {
    if (status === "pending") return "Waiting for approval";
    if (status === "failed") return "Permission denied";
    if (status === "cancelled") return "Approval rejected";
    if (status === "interrupted") return "Approval interrupted";
    return "Approval granted";
  }
  if (category === "outcome") return outcomeTitle(items);
  if (category === "checks") {
    if (status === "pending") return "Verifying";
    if (status === "failed") return "Verification failed" + retry;
    if (status === "cancelled") return "Verification cancelled";
    if (status === "interrupted") return "Verification interrupted";
    return "Verification finished";
  }
  if (category === "edit") {
    var rejectedEdit = false;
    for (var e = 0; e < items.length; e++) {
      if (items[e] && items[e].label === "Change rejected") rejectedEdit = true;
    }
    var editBase = status === "pending" ? "Implementing changes" : status === "failed" ? "Edit failed" : rejectedEdit ? "Change rejected" : status === "cancelled" ? "Edit cancelled" : status === "interrupted" ? "Edit interrupted" : "Implemented changes";
    return editBase + fileCountPhrase(files.length, false) + (status === "failed" ? retry : "");
  }
  if (category === "explore") {
    var exploreBase = status === "failed" ? "Exploring repository failed" : status === "cancelled" ? "Exploring repository cancelled" : status === "interrupted" ? "Exploring repository interrupted" : status === "pending" ? "Exploring repository" : "Explored repository";
    return exploreBase + fileCountPhrase(files.length, true) + (status === "failed" ? retry : "");
  }
  if (category === "read") {
    var readBase = status === "failed" ? "Reading files failed" : status === "cancelled" ? "Reading files cancelled" : status === "interrupted" ? "Reading files interrupted" : status === "pending" ? "Reading files" : "Read files";
    return readBase + fileCountPhrase(files.length, false) + (status === "failed" ? retry : "");
  }
  if (category === "consult") {
    if (status === "failed") return "Model request failed" + retry;
    if (status === "cancelled") return "Thinking cancelled";
    if (status === "interrupted") return "Thinking interrupted";
    if (status === "pending") return "Thinking";
    return "Model replied";
  }
  if (category === "plan") {
    if (status === "failed") return "Planning failed";
    if (status === "cancelled") return "Planning cancelled";
    if (status === "interrupted") return "Planning interrupted";
    return "Planning changes";
  }
  if (category === "understand") return "Understanding the request";
  if (category === "review") return "Reviewing results";
  return "Working";
}

function groupDetail(items: any[]): string {
  var names: string[] = [];
  for (var i = 0; i < items.length; i++) {
    var summary = items[i] && items[i].summary;
    if (typeof summary !== "string" || !summary || summary.length > 80) continue;
    if (names.indexOf(summary) === -1) names.push(summary);
  }
  if (!names.length) return "";
  var shown = names.slice(0, 3).join(", ");
  if (names.length > 3) shown += " +" + String(names.length - 3);
  return shown;
}

function pushActivityGroup(summarized: Array<{ category: string; title: string; status: string; count: number; detail: string }>, category: string, items: any[]): void {
  var showPaths = category === "edit" || category === "read" || category === "explore";
  summarized.push({
    category: category,
    title: groupTitle(category, items),
    status: activityGroupStatus(items),
    count: items.length,
    detail: showPaths ? groupDetail(items) : "",
  });
}

export function summarizeActivities(activities: any[]): Array<{ category: string; title: string; status: string; count: number; detail: string }> {
  var summarized: Array<{ category: string; title: string; status: string; count: number; detail: string }> = [];
  var list = activities || [];
  var segments: Array<{ items: any[]; outcome: any }> = [];
  var segment: any[] = [];
  for (var n = 0; n < list.length; n++) {
    var item = list[n];
    if (activityCategory(item) === "outcome") {
      segments.push({ items: segment, outcome: item });
      segment = [];
    } else {
      segment.push(item);
    }
  }
  if (segment.length) segments.push({ items: segment, outcome: null });
  for (var s = 0; s < segments.length; s++) {
    var part = segments[s];
    if (!part) continue;
    var buckets: Array<{ category: string; items: any[] }> = [];
    for (var i = 0; i < part.items.length; i++) {
      var act = part.items[i];
      var category = activityCategory(act);
      var bucket = null;
      for (var b = 0; b < buckets.length; b++) {
        if (buckets[b] && buckets[b].category === category) bucket = buckets[b];
      }
      if (bucket) bucket.items.push(act);
      else buckets.push({ category: category, items: [act] });
    }
    for (var g = 0; g < buckets.length; g++) {
      var group = buckets[g];
      if (group) pushActivityGroup(summarized, group.category, group.items);
    }
    if (part.outcome) pushActivityGroup(summarized, "outcome", [part.outcome]);
  }
  return compressTrivialTimeline(summarized);
}

function compressTrivialTimeline(groups: Array<{ category: string; title: string; status: string; count: number; detail: string }>): Array<{ category: string; title: string; status: string; count: number; detail: string }> {
  var substantial = false;
  for (var i = 0; i < groups.length; i++) {
    var category = groups[i] && groups[i].category;
    if (category === "read" || category === "explore" || category === "edit" || category === "checks" || category === "approval" || category === "plan" || category === "review") {
      substantial = true;
    }
  }
  if (substantial) return groups;
  var kept: Array<{ category: string; title: string; status: string; count: number; detail: string }> = [];
  for (var j = 0; j < groups.length; j++) {
    var group = groups[j];
    if (!group) continue;
    if (group.category === "outcome" || group.status === "failed" || group.status === "cancelled" || group.status === "interrupted") kept.push(group);
  }
  return kept.length ? kept : groups;
}

function renderOutcomeBody(body: any, content: string, d: any, postMessage?: (msg: any) => void): boolean {
  var rejected = content.indexOf("Change rejected —") === 0;
  var marker = "\n\nVerified outcome\n";
  var idx = content.indexOf(marker);
  if (!rejected && idx < 0) return false;
  var prose = rejected ? "" : content.slice(0, idx);
  var facts = rejected ? content : content.slice(idx + marker.length);
  if (prose) {
    var lead = d.createElement("div");
    lead.className = "md-text";
    setText(lead, prose);
    body.appendChild(lead);
  }
  var card = d.createElement("div");
  card.className = "outcome-card" + (rejected ? " is-rejected" : " is-verified");
  setAttr(card, "role", "status");
  setAttr(card, "data-outcome", rejected ? "rejected" : "verified");
  if (!rejected) {
    var heading = d.createElement("div");
    heading.className = "outcome-title";
    setText(heading, "Task completed.");
    card.appendChild(heading);
  }
  var lines = facts.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    if (line.indexOf("- ") === 0) {
      var path = line.slice(2);
      var row = d.createElement("div");
      row.className = "outcome-file";
      var btn = d.createElement("button");
      btn.className = "file-ref";
      btn.type = "button";
      setText(btn, path);
      setAttr(btn, "aria-label", "Open applied change " + path);
      if (postMessage) {
        onClick(btn, function (p: string) {
          return function () {
            postMessage({ type: "ui.openFile", path: p });
          };
        }(path));
      }
      row.appendChild(btn);
      card.appendChild(row);
    } else {
      var p = d.createElement("div");
      p.className = line === "Change rejected — no files modified." || line.indexOf("Change rejected") === 0 ? "outcome-title" : "outcome-line";
      setText(p, line);
      card.appendChild(p);
    }
  }
  body.appendChild(card);
  return true;
}

export function renderActivityTimeline(container: any, activities: any[], doc?: any): any {
  var all = activities || [];
  var start = Math.max(0, all.length - 20);
  var visible = all.slice(start);
  var groups = summarizeActivities(visible);
  var sig = "";
  for (var s = 0; s < groups.length; s++) {
    var group = groups[s];
    if (!group) continue;
    sig += group.category + "\u0000" + group.status + "\u0000" + group.title + "\u0000" + group.detail + "\u0001";
  }
  for (var r = 0; r < visible.length; r++) {
    var raw = visible[r];
    sig += (raw.id || "") + "\u0000" + (raw.status || "") + "\u0000" + (raw.label || "") + "\u0000" + (raw.summary || "") + "\u0002";
  }
  if (container.__activitySig === sig) return container.firstChild || null;
  container.__activitySig = sig;
  container.innerHTML = "";
  if (!all.length) return null;
  var d = docOf(doc);
  var panel = d.createElement("div");
  panel.className = "activity-panel";
  var working = false;
  var summaryList = d.createElement("ol");
  summaryList.className = "activity-summary";
  setAttr(summaryList, "aria-label", "Task activity");
  for (var i = 0; i < groups.length; i++) {
    var item = groups[i];
    if (!item) continue;
    if (item.status === "pending") working = true;
    var li = d.createElement("li");
    li.className = "activity-item is-" + item.status;
    setAttr(li, "aria-current", item.status === "pending" ? "step" : "false");
    var mark = d.createElement("span");
    mark.className = "activity-mark";
    setAttr(mark, "aria-hidden", "true");
    var label = d.createElement("span");
    label.className = "activity-label";
    var text = item.title;
    if (item.detail) text += ": " + item.detail;
    setText(label, text);
    li.appendChild(mark);
    li.appendChild(label);
    summaryList.appendChild(li);
  }
  panel.appendChild(summaryList);
  var details = d.createElement("details");
  details.className = "activity-trace";
  details.open = false;
  var summary = d.createElement("summary");
  setText(summary, "Technical details");
  var rawList = d.createElement("ol");
  rawList.className = "activity-list";
  setAttr(rawList, "aria-label", "Technical activity trace");
  for (var t = 0; t < visible.length; t++) {
    var act = visible[t];
    var row = d.createElement("li");
    row.className = "activity-item is-" + (act.status || "pending");
    var rawLabel = d.createElement("span");
    rawLabel.className = "activity-label";
    var line = act.label || act.kind || "activity";
    if (act.summary) line += " — " + act.summary;
    if (act.runId && line.indexOf(act.runId) === -1) line += " — " + act.runId;
    setText(rawLabel, line);
    row.appendChild(rawLabel);
    rawList.appendChild(row);
  }
  details.appendChild(summary);
  details.appendChild(rawList);
  panel.appendChild(details);
  if (working) setAttr(panel, "aria-busy", "true");
  container.appendChild(panel);
  return panel;
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
    status.backend === "standalone-local" ? "Local" : "Backend";
  var modelName = status.selectedModel || status.modelLabel || "";
  var model = modelName ? " · " + modelName : "";
  var stateLabel =
    status.state === "ready" ? "Ready" :
    status.state === "running" ? "Running" :
    status.state === "disconnected" ? "Disconnected" :
    status.state === "missing-config" ? "Not configured" :
    status.state === "invalid-credentials" ? "Invalid credentials" :
    status.state === "model-unavailable" ? "Model unavailable" :
    status.state === "timeout" ? "Timed out" : "Unavailable";
  setText(wrap, stateLabel + model);
  var title = status.detail || stateLabel;
  if (status.endpoint) title += " (" + status.endpoint + ")";
  setAttr(wrap, "title", backendLabel + " · " + title);
  setAttr(wrap, "aria-label", "Inference status: " + backendLabel + " " + stateLabel);
  if (postMessage) {
    onClick(wrap, function () {
      if (status.actionable === "check-connection") postMessage({ type: "chat.checkConnection" });
      else postMessage({ type: "modelManager.open" });
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
  var meta = d.createElement('div');
  meta.className = 'terminal-meta';
  if (term.executable) appendMetaRow(d, meta, 'Executable', term.executable, true);
  if (term.args) appendMetaRow(d, meta, 'Arguments', formatArgs(term.args), true);
  appendMetaRow(d, meta, 'Directory', term.cwd || '', true);
  appendMetaRow(d, meta, 'Source', term.provenance || '');
  if (term.scriptName && term.scriptBody) appendMetaRow(d, meta, 'Script', term.scriptBody, true);
  appendMetaRow(d, meta, 'Time limit', formatDuration(term.timeoutMs));
  if (finished) {
    var details = d.createElement('details');
    details.className = 'terminal-details';
    var summary = d.createElement('summary');
    setText(summary, 'Command details');
    details.appendChild(summary);
    details.appendChild(cmdBox);
    details.appendChild(meta);
    card.appendChild(details);
  } else {
    card.appendChild(cmdBox);
    card.appendChild(meta);
  }

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

function reviewStatusLabel(status: string, record?: any): string {
  if (record && record.kind === 'mutation') {
    if (status === 'pending') return 'Proposed';
    if (status === 'approved') return 'Approved';
    if (status === 'verified' || (status === 'applied' && record.verifiedBy && record.verifiedBy.status === 'succeeded')) return 'Verified';
    if (status === 'applied') return 'Applied';
    if (status === 'rejected') return 'Rejected';
  }
  switch (status) {
    case 'pending': return 'Awaiting review';
    case 'approved': return 'Approved';
    case 'applied': return 'Applied';
    case 'verified': return 'Verified';
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
  var order = ['pending', 'approved', 'running', 'applied', 'verified', 'succeeded', 'rejected', 'stale', 'failed', 'timed-out', 'cancelled', 'interrupted'];
  for (var o = 0; o < order.length; o++) {
    if (counts[order[o]]) {
      var sample = null;
      for (var s = 0; s < list.length; s++) {
        if (list[s].status === order[o]) { sample = list[s]; break; }
      }
      summaryParts.push(counts[order[o]] + ' ' + reviewStatusLabel(order[o], sample).toLowerCase());
    }
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
    var displayStatus = (r.kind === 'mutation' && r.status === 'applied' && r.verifiedBy && r.verifiedBy.status === 'succeeded') ? 'verified' : r.status;
    li.className = 'review-item is-' + displayStatus;
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
    var stateText = reviewStatusLabel(r.status, r);
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
        var showApplied = r.status === 'applied' || r.status === 'verified';
        var historical = r.status === 'rejected' || r.status === 'cancelled' || r.status === 'interrupted';
        if (!historical) {
          setText(openBtn, showApplied ? 'Changes' : 'Open');
          setAttr(openBtn, 'aria-label', (showApplied ? 'Show changes in ' : 'Open ') + r.path);
          onClick(openBtn, function (mid: string) { return function () { send({ type: 'review.openChange', mutationId: mid }); }; }(r.id));
          li.appendChild(openBtn);
        }
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
  setAttr(div, 'data-operation', conf.preparedCommand ? 'command' : ((conf.mutation && conf.mutation.operation) || (conf.mutationId ? 'patch' : '')));
  setAttr(div, 'data-path', conf.path || '');
  setAttr(div, 'data-cwd', (conf.preparedCommand && conf.preparedCommand.cwd) || '');

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
  if (conf.mutationId && !conf.responding) {
    var proposed = d.createElement('div');
    proposed.className = 'review-detail';
    setText(proposed, 'Proposed — nothing is written until you approve this change.');
    div.appendChild(proposed);
  }
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
  setAttr(btnReject, 'aria-label', conf.preparedCommand ? 'Do not run this command' : 'Reject this file change');

  const btnApprove = d.createElement('button');
  btnApprove.className = 'btn-approve';
  btnApprove.id = 'btn-approve';
  btnApprove.type = 'button';
  btnApprove.textContent = conf.preparedCommand ? 'Run' : 'Approve';
  setAttr(btnApprove, 'aria-label', conf.preparedCommand ? 'Run this command' : 'Approve this file change');

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
    case 'rejected': return 'Rejected';
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

export function renderProfileSection(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};
  var account = (state && state.account) || {};

  var card = d.createElement('div');
  card.className = 'hub-card profile-card';

  var header = d.createElement('div');
  header.className = 'hub-card-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, 'Account Profile');
  header.appendChild(title);

  var statusBadge = d.createElement('span');
  statusBadge.className = 'status-badge ' + (account.status === 'ONLINE' ? 'is-success' : account.status === 'OFFLINE' ? 'is-failed' : 'is-disabled');
  setText(statusBadge, account.status === 'ONLINE' ? 'Online' : account.status === 'OFFLINE' ? 'Offline' : 'Unauthenticated');
  header.appendChild(statusBadge);
  card.appendChild(header);

  if (account.status === 'ONLINE' || account.status === 'OFFLINE') {
    var user = account.user || {};
    appendMetaRow(d, card, 'User', (user.username || 'Unknown') + ' (' + (user.role || 'USER') + ')');
    appendMetaRow(d, card, 'Account Status', user.status || 'ACTIVE');
    appendMetaRow(d, card, 'Backend URL', account.serverUrl || 'http://127.0.0.1:4040');
    if (account.isStale) {
      appendMetaRow(d, card, 'Profile Cache', 'Stale (cached from previous session; local features functional)');
    }
    if (account.lastSyncTime) {
      appendMetaRow(d, card, 'Last Sync', String(account.lastSyncTime));
    }
    if (account.error) {
      appendMetaRow(d, card, 'Diagnostic', String(account.error));
    }

    var actions = d.createElement('div');
    actions.className = 'confirmation-actions';
    if (account.status === 'ONLINE') {
      var syncBtn = appendAction(d, actions, 'Sync Integrations', 'Synchronize saved MCP configurations from account', function () {
        send({ type: 'integration.syncAccount' });
      });
      syncBtn.className = 'btn-approve';
    }
    var logoutBtn = appendAction(d, actions, 'Log Out', 'Revoke session and disconnect account integrations', function () {
      send({ type: 'integration.accountLogout' });
    });
    logoutBtn.className = 'btn-reject';
    card.appendChild(actions);
  } else {
    appendMetaRow(d, card, 'Status', 'Not logged in. Open VS Code operates in local-first standalone mode.');
    appendMetaRow(d, card, 'Local Features', '100% operational: local editing, local inference and local MCP tools are available.');

    var actions = d.createElement('div');
    actions.className = 'confirmation-actions';
    var loginBtn = appendAction(d, actions, 'Log In', 'Log in to an Open VS Code Account', function () {
      send({ type: 'integration.accountLogin' });
    });
    loginBtn.className = 'btn-approve';
    card.appendChild(actions);
  }

  container.appendChild(card);
  return card;
}

export function renderMcpDashboard(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  if (state && state.wizard) {
    return renderAddMcpWizard(container, state, d, send);
  }

  if (state && state.inspectingServerId) {
    return renderToolInspector(container, state, d, send);
  }

  // Dashboard Toolbar
  var toolbar = d.createElement('div');
  toolbar.className = 'hub-toolbar';

  var addBtn = appendAction(d, toolbar, '+ Add Server', 'Open Add MCP Server wizard', function () {
    send({ type: 'integration.startWizard' });
  });
  addBtn.className = 'btn-approve';

  var refreshBtn = appendAction(d, toolbar, 'Refresh Discovery', 'Re-scan tool definitions from all servers', function () {
    send({ type: 'integration.refreshDiscovery' });
  });
  refreshBtn.className = 'hub-btn-secondary';

  var syncBtn = appendAction(d, toolbar, 'Sync Account', 'Fetch latest integrations from private account profile', function () {
    send({ type: 'integration.syncAccount' });
  });
  syncBtn.className = 'hub-btn-secondary';

  container.appendChild(toolbar);

  // Servers List
  var servers = (state && state.servers) || [];
  if (servers.length === 0) {
    var empty = d.createElement('div');
    empty.className = 'hub-empty-state';
    setText(empty, 'No MCP servers configured yet. Click "+ Add Server" to connect an MCP server.');
    container.appendChild(empty);
    return container;
  }

  var list = d.createElement('div');
  list.className = 'hub-server-list';
  setAttr(list, 'role', 'list');
  setAttr(list, 'aria-label', 'Configured MCP Servers');

  for (var i = 0; i < servers.length; i++) {
    var s = servers[i];
    var card = d.createElement('div');
    card.className = 'hub-server-card is-' + String(s.state || 'disconnected').toLowerCase();
    setAttr(card, 'role', 'listitem');

    var cardHeader = d.createElement('div');
    cardHeader.className = 'hub-server-header';

    var titleGroup = d.createElement('div');
    titleGroup.className = 'hub-server-title-group';
    var nameEl = d.createElement('span');
    nameEl.className = 'hub-server-name';
    setText(nameEl, s.name || s.id);
    titleGroup.appendChild(nameEl);

    var idEl = d.createElement('span');
    idEl.className = 'hub-server-id';
    setText(idEl, '(' + s.id + ')');
    titleGroup.appendChild(idEl);
    cardHeader.appendChild(titleGroup);

    var badgeGroup = d.createElement('div');
    badgeGroup.className = 'hub-badge-group';

    var transportBadge = d.createElement('span');
    transportBadge.className = 'status-badge hub-transport-badge';
    setText(transportBadge, s.transport || 'unknown');
    badgeGroup.appendChild(transportBadge);

    var provBadge = d.createElement('span');
    provBadge.className = 'status-badge hub-provenance-badge ' + (s.source === 'account' ? 'is-account' : s.source === 'local' ? 'is-local' : 'is-workspace');
    setText(provBadge, s.source === 'account' ? 'Account' : s.source === 'local' ? 'Local' : 'Workspace');
    badgeGroup.appendChild(provBadge);

    var stateBadge = d.createElement('span');
    stateBadge.className = 'status-badge ' + (s.state === 'CONNECTED' ? 'is-success' : s.state === 'AUTH_REQUIRED' ? 'is-failed' : s.state === 'DISABLED' ? 'is-disabled' : 'is-disconnected');
    setText(stateBadge, s.state || 'DISCONNECTED');
    badgeGroup.appendChild(stateBadge);

    cardHeader.appendChild(badgeGroup);
    card.appendChild(cardHeader);

    // Meta details
    appendMetaRow(d, card, 'Target', s.urlOrCommand || 'N/A');
    appendMetaRow(d, card, 'Discovered Tools', String(s.toolCount || (s.tools ? s.tools.length : 0)));
    appendMetaRow(d, card, 'Workspace Scope', s.workspaceEnabled ? 'Enabled in this workspace' : 'Disabled by workspace policy');
    if (s.lastConnectedAt) {
      appendMetaRow(d, card, 'Last Connected', String(s.lastConnectedAt));
    }
    if (s.error) {
      var errRow = d.createElement('div');
      errRow.className = 'hub-error-row';
      setText(errRow, 'Error: ' + s.error);
      card.appendChild(errRow);
    }

    // Action buttons
    var actions = d.createElement('div');
    actions.className = 'hub-card-actions';

    var sid = s.id;
    var isConnected = s.state === 'CONNECTED' || s.state === 'DEGRADED';
    var isEnabled = Boolean(s.enabled);
    var isWsAllowed = Boolean(s.workspaceEnabled);

    if (isConnected) {
      var dcBtn = appendAction(d, actions, 'Disconnect', 'Disconnect transport', (function (id) {
        return function () { send({ type: 'integration.disconnectMcp', serverId: id }); };
      })(sid));
      dcBtn.className = 'btn-reject';
    } else {
      var connBtn = appendAction(d, actions, 'Connect', 'Connect to MCP server and discover tools', (function (id) {
        return function () { send({ type: 'integration.connectMcp', serverId: id }); };
      })(sid));
      connBtn.className = isEnabled && isWsAllowed ? 'btn-approve' : 'btn-approve is-disabled';
      if (!isEnabled || !isWsAllowed) {
        setAttr(connBtn, 'title', !isEnabled ? 'Server is disabled' : 'Disabled by workspace policy');
      }
    }

    var toggleBtn = appendAction(d, actions, isEnabled ? 'Disable' : 'Enable', 'Toggle server enabled preference', (function (id, en) {
      return function () { send({ type: 'integration.toggleMcp', serverId: id, enabled: !en }); };
    })(sid, isEnabled));
    toggleBtn.className = 'hub-btn-secondary';

    var wsToggleBtn = appendAction(d, actions, isWsAllowed ? 'Workspace: On' : 'Workspace: Off', 'Toggle activation for current workspace', (function (id, wsEn) {
      return function () { send({ type: 'integration.toggleWorkspacePolicy', serverId: id, enabled: !wsEn }); };
    })(sid, isWsAllowed));
    wsToggleBtn.className = 'hub-btn-secondary';

    var inspectBtn = appendAction(d, actions, 'Inspect Tools (' + String(s.toolCount || 0) + ')', 'Inspect tools and local permissions', (function (id) {
      return function () { send({ type: 'integration.inspectTools', serverId: id }); };
    })(sid));
    inspectBtn.className = 'hub-btn-secondary';

    if (s.source === 'account' || s.source === 'local') {
      var sName = s.name || s.id;
      var rmBtn = appendAction(d, actions, 'Remove', 'Remove this server configuration', (function (id, name) {
        return function () { send({ type: 'integration.promptRemoveServer', serverId: id, serverName: name }); };
      })(sid, sName));
      rmBtn.className = 'btn-reject hub-btn-sm';
    }

    card.appendChild(actions);
    list.appendChild(card);
  }

  container.appendChild(list);
  return container;
}

export function renderAddMcpWizard(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};
  var wizard = (state && state.wizard) || { step: 1, draft: { transport: 'streamable_http' } };
  var draft = wizard.draft || {};
  var step = wizard.step || 1;

  var panel = d.createElement('div');
  panel.className = 'hub-wizard-panel';

  var header = d.createElement('div');
  header.className = 'hub-wizard-header';
  var h = d.createElement('h3');
  h.className = 'hub-card-title';
  setText(h, 'Add MCP Server — Step ' + step + ' of 5');
  header.appendChild(h);

  var cancelBtn = appendAction(d, header, 'Cancel', 'Cancel wizard and return to server list', function () {
    send({ type: 'integration.cancelWizard' });
  });
  cancelBtn.className = 'btn-reject';
  panel.appendChild(header);

  // Stepper indicator
  var stepsIndicator = d.createElement('div');
  stepsIndicator.className = 'hub-wizard-stepper';
  var stepNames = ['Transport', 'Configuration', 'Validation', 'Save & Connect', 'Discovered Tools'];
  for (var s = 1; s <= 5; s++) {
    var stepDot = d.createElement('span');
    stepDot.className = 'hub-step-dot' + (step === s ? ' is-current' : step > s ? ' is-done' : '');
    setText(stepDot, s + '. ' + stepNames[s - 1]);
    stepsIndicator.appendChild(stepDot);
  }
  panel.appendChild(stepsIndicator);

  // Error alert
  if (wizard.error) {
    var errBox = d.createElement('div');
    errBox.className = 'hub-error-banner';
    setText(errBox, 'Error: ' + wizard.error);
    panel.appendChild(errBox);
  }

  // Step 1: Transport Selection
  if (step === 1) {
    var desc1 = d.createElement('p');
    desc1.className = 'hub-wizard-desc';
    setText(desc1, 'Select a supported Model Context Protocol transport:');
    panel.appendChild(desc1);

    var transList = d.createElement('div');
    transList.className = 'hub-transport-picker';

    var optHttp = d.createElement('button');
    optHttp.type = 'button';
    optHttp.className = 'hub-transport-card' + (draft.transport === 'streamable_http' ? ' is-selected' : '');
    setText(optHttp, 'Streamable HTTP (Stateless MCP 2026-07-28 POST — Recommended)');
    onClick(optHttp, function () { send({ type: 'integration.wizardTransport', transport: 'streamable_http' }); });
    transList.appendChild(optHttp);

    var optSse = d.createElement('button');
    optSse.type = 'button';
    optSse.className = 'hub-transport-card' + (draft.transport === 'sse' ? ' is-selected' : '');
    setText(optSse, 'SSE (Server-Sent Events 2024-11-05 Stream)');
    onClick(optSse, function () { send({ type: 'integration.wizardTransport', transport: 'sse' }); });
    transList.appendChild(optSse);

    var optStdio = d.createElement('button');
    optStdio.type = 'button';
    optStdio.className = 'hub-transport-card' + (draft.transport === 'stdio' ? ' is-selected' : '');
    setText(optStdio, 'stdio (Local Process with isolated environment)');
    onClick(optStdio, function () { send({ type: 'integration.wizardTransport', transport: 'stdio' }); });
    transList.appendChild(optStdio);

    panel.appendChild(transList);
  }

  // Step 2: Configuration
  else if (step === 2) {
    var form = d.createElement('div');
    form.className = 'hub-wizard-form';

    // Server ID
    var idRow = d.createElement('div');
    idRow.className = 'hub-form-row';
    var idLabel = d.createElement('label');
    setText(idLabel, 'Server Identifier (ID):');
    idRow.appendChild(idLabel);
    var idInput = d.createElement('input');
    idInput.type = 'text';
    idInput.className = 'hub-input';
    idInput.value = draft.serverId || '';
    idInput.placeholder = 'e.g. postgres-tools';
    idRow.appendChild(idInput);
    form.appendChild(idRow);

    // Display Name
    var nameRow = d.createElement('div');
    nameRow.className = 'hub-form-row';
    var nameLabel = d.createElement('label');
    setText(nameLabel, 'Display Name:');
    nameRow.appendChild(nameLabel);
    var nameInput = d.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'hub-input';
    nameInput.value = draft.displayName || '';
    nameInput.placeholder = 'e.g. PostgreSQL Tools';
    nameRow.appendChild(nameInput);
    form.appendChild(nameRow);

    var urlInput: any = null;
    var cmdInput: any = null;
    var argsInput: any = null;
    var credInput: any = null;
    var secretValInput: any = null;

    if (draft.transport === 'streamable_http' || draft.transport === 'sse') {
      var urlRow = d.createElement('div');
      urlRow.className = 'hub-form-row';
      var urlLabel = d.createElement('label');
      setText(urlLabel, 'Endpoint URL (HTTPS or verified loopback):');
      urlRow.appendChild(urlLabel);
      urlInput = d.createElement('input');
      urlInput.type = 'text';
      urlInput.className = 'hub-input';
      urlInput.value = draft.url || '';
      urlInput.placeholder = 'https://mcp.internal.net/v1 or http://127.0.0.1:8080/mcp';
      urlRow.appendChild(urlInput);
      form.appendChild(urlRow);

      var credRow = d.createElement('div');
      credRow.className = 'hub-form-row';
      var credLabel = d.createElement('label');
      setText(credLabel, 'SecretStorage Key for Bearer Token (Optional):');
      credRow.appendChild(credLabel);
      credInput = d.createElement('input');
      credInput.type = 'text';
      credInput.className = 'hub-input';
      credInput.value = draft.credentialRef || '';
      credInput.placeholder = 'e.g. mcp_bearer_token';
      credRow.appendChild(credInput);
      form.appendChild(credRow);

      var secretValRow = d.createElement('div');
      secretValRow.className = 'hub-form-row';
      var secLabel = d.createElement('label');
      setText(secLabel, 'Token Value (Stored securely in VS Code SecretStorage; never sent in plaintext):');
      secretValRow.appendChild(secLabel);
      secretValInput = d.createElement('input');
      secretValInput.type = 'password';
      secretValInput.className = 'hub-input';
      secretValInput.placeholder = 'Enter secret token to store in SecretStorage';
      secretValRow.appendChild(secretValInput);
      form.appendChild(secretValRow);
    } else if (draft.transport === 'stdio') {
      var cmdRow = d.createElement('div');
      cmdRow.className = 'hub-form-row';
      var cmdLabel = d.createElement('label');
      setText(cmdLabel, 'Command Executable:');
      cmdRow.appendChild(cmdLabel);
      cmdInput = d.createElement('input');
      cmdInput.type = 'text';
      cmdInput.className = 'hub-input';
      cmdInput.value = draft.command || '';
      cmdInput.placeholder = 'e.g. sqlite3 or uv';
      cmdRow.appendChild(cmdInput);
      form.appendChild(cmdRow);

      var argsRow = d.createElement('div');
      argsRow.className = 'hub-form-row';
      var argsLabel = d.createElement('label');
      setText(argsLabel, 'Arguments (space-separated):');
      argsRow.appendChild(argsLabel);
      argsInput = d.createElement('input');
      argsInput.type = 'text';
      argsInput.className = 'hub-input';
      argsInput.value = draft.args ? draft.args.join(' ') : '';
      argsInput.placeholder = 'e.g. run mcp-server-sqlite --db /path/to/db';
      argsRow.appendChild(argsInput);
      form.appendChild(argsRow);
    }

    var wsRow = d.createElement('div');
    wsRow.className = 'hub-form-row is-checkbox';
    var wsCheck = d.createElement('input');
    wsCheck.type = 'checkbox';
    wsCheck.checked = draft.workspaceScoped !== false;
    wsRow.appendChild(wsCheck);
    var wsLabel = d.createElement('label');
    setText(wsLabel, ' Scope activation to current workspace only');
    wsRow.appendChild(wsLabel);
    form.appendChild(wsRow);

    var persistRow = d.createElement('div');
    persistRow.className = 'hub-form-row is-checkbox';
    var persistCheck = d.createElement('input');
    persistCheck.type = 'checkbox';
    persistCheck.checked = Boolean(draft.persistToAccount);
    persistRow.appendChild(persistCheck);
    var persistLabel = d.createElement('label');
    setText(persistLabel, ' Save to private account profile (persists across devices)');
    persistRow.appendChild(persistLabel);
    form.appendChild(persistRow);

    var btnRow = d.createElement('div');
    btnRow.className = 'confirmation-actions';
    var backBtn = appendAction(d, btnRow, '← Back', 'Return to transport selection', function () {
      send({ type: 'integration.wizardStep', step: 1 });
    });
    backBtn.className = 'hub-btn-secondary';

    var validateBtn = appendAction(d, btnRow, 'Validate Configuration →', 'Perform local validation of this configuration', function () {
      var updates: any = {
        serverId: idInput.value,
        displayName: nameInput.value,
        workspaceScoped: wsCheck.checked,
        persistToAccount: persistCheck.checked,
      };
      if (urlInput) updates.url = urlInput.value;
      if (credInput) updates.credentialRef = credInput.value;
      if (secretValInput && secretValInput.value) updates.secretValue = secretValInput.value;
      if (cmdInput) updates.command = cmdInput.value;
      if (argsInput) updates.args = argsInput.value ? argsInput.value.split(/\s+/).filter(Boolean) : [];

      send({ type: 'integration.wizardDraft', draft: updates });
      send({ type: 'integration.wizardValidate' });
    });
    validateBtn.className = 'btn-approve';

    form.appendChild(btnRow);
    panel.appendChild(form);
  }

  // Step 3: Local Validation Results
  else if (step === 3) {
    var vRes = wizard.validationResult || { valid: true, warnings: [] };
    var valBox = d.createElement('div');
    valBox.className = 'hub-validation-results ' + (vRes.valid ? 'is-valid' : 'is-invalid');

    appendMetaRow(d, valBox, 'Configuration Status', vRes.valid ? 'Valid' : 'Validation Failed');
    appendMetaRow(d, valBox, 'Network Policy Guard', vRes.networkPolicyCheck || 'Passed');
    appendMetaRow(d, valBox, 'Target Availability', vRes.executableOrUrlCheck || 'Passed');
    appendMetaRow(d, valBox, 'Credential Boundary', vRes.credentialCheck || 'None required');

    if (vRes.warnings && vRes.warnings.length) {
      var warnTitle = d.createElement('div');
      warnTitle.className = 'hub-warning-title';
      setText(warnTitle, 'Security & Policy Warnings:');
      valBox.appendChild(warnTitle);
      var wList = d.createElement('ul');
      wList.className = 'hub-warning-list';
      for (var w = 0; w < vRes.warnings.length; w++) {
        var wLi = d.createElement('li');
        setText(wLi, vRes.warnings[w]);
        wList.appendChild(wLi);
      }
      valBox.appendChild(wList);
    }

    panel.appendChild(valBox);

    var vActions = d.createElement('div');
    vActions.className = 'confirmation-actions';

    var editBtn = appendAction(d, vActions, '← Edit Draft', 'Go back and edit configuration fields', function () {
      send({ type: 'integration.wizardStep', step: 2 });
    });
    editBtn.className = 'hub-btn-secondary';

    if (vRes.valid) {
      var proceedBtn = appendAction(d, vActions, 'Proceed to Save →', 'Advance to save options', function () {
        send({ type: 'integration.wizardStep', step: 4 });
      });
      proceedBtn.className = 'btn-approve';
    }

    panel.appendChild(vActions);
  }

  // Step 4: Save & Optionally Connect
  else if (step === 4) {
    var saveDesc = d.createElement('p');
    saveDesc.className = 'hub-wizard-desc';
    setText(saveDesc, 'Ready to register MCP server "' + (draft.serverId || '') + '". Saving creates the registration without starting executables.');
    panel.appendChild(saveDesc);

    var sActions = d.createElement('div');
    sActions.className = 'confirmation-actions';

    var saveConnBtn = appendAction(d, sActions, 'Save & Connect Now', 'Persist configuration and establish connection immediately', function () {
      send({ type: 'integration.wizardSave', connectNow: true });
    });
    saveConnBtn.className = 'btn-approve';

    var saveOnlyBtn = appendAction(d, sActions, 'Save Only (Disconnected)', 'Persist configuration without connecting', function () {
      send({ type: 'integration.wizardSave', connectNow: false });
    });
    saveOnlyBtn.className = 'hub-btn-secondary';

    var backToVal = appendAction(d, sActions, '← Back', 'Return to validation step', function () {
      send({ type: 'integration.wizardStep', step: 3 });
    });
    backToVal.className = 'hub-btn-secondary';

    panel.appendChild(sActions);
  }

  // Step 5: Discovered Tools
  else if (step === 5) {
    var dTools = wizard.discoveredTools || [];
    var doneDesc = d.createElement('p');
    doneDesc.className = 'hub-wizard-desc';
    setText(doneDesc, 'Successfully connected to server "' + (draft.serverId || '') + '". Discovered ' + dTools.length + ' tools:');
    panel.appendChild(doneDesc);

    var tList = d.createElement('ul');
    tList.className = 'hub-tool-list';
    for (var ti = 0; ti < dTools.length; ti++) {
      var tool = dTools[ti];
      var tLi = d.createElement('li');
      tLi.className = 'hub-tool-item';
      var tName = d.createElement('strong');
      setText(tName, tool.toolName || tool.canonicalName);
      tLi.appendChild(tName);
      var tDesc = d.createElement('div');
      tDesc.className = 'hub-tool-desc';
      setText(tDesc, tool.description || 'No description provided.');
      tLi.appendChild(tDesc);
      tList.appendChild(tLi);
    }
    panel.appendChild(tList);

    var dActions = d.createElement('div');
    dActions.className = 'confirmation-actions';
    var doneBtn = appendAction(d, dActions, 'Done', 'Close wizard and view server list', function () {
      send({ type: 'integration.cancelWizard' });
    });
    doneBtn.className = 'btn-approve';
    panel.appendChild(dActions);
  }

  container.appendChild(panel);
  return panel;
}

export function renderToolInspector(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};
  var serverId = state && state.inspectingServerId;
  var servers = (state && state.servers) || [];
  var server = servers.find(function (s: any) { return s.id === serverId; });

  var panel = d.createElement('div');
  panel.className = 'hub-inspector-panel';

  var header = d.createElement('div');
  header.className = 'hub-inspector-header';
  var backBtn = appendAction(d, header, '← Back to Servers', 'Return to MCP servers list', function () {
    send({ type: 'integration.inspectTools', serverId: undefined });
  });
  backBtn.className = 'hub-btn-secondary';

  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, 'Discovered Tools: ' + (server ? server.name : serverId));
  header.appendChild(title);
  panel.appendChild(header);

  // Security Policy Callout Banner
  var securityNotice = d.createElement('div');
  securityNotice.className = 'hub-security-notice';
  setText(securityNotice, 'Security Notice: Tool permissions derive from trusted local policy. Server-authored annotations cannot lower risk. UI settings cannot override mandatory runtime constraints.');
  panel.appendChild(securityNotice);

  var tools = (server && server.tools) || [];
  if (tools.length === 0) {
    var empty = d.createElement('div');
    empty.className = 'hub-empty-state';
    setText(empty, 'No tools discovered for this server yet. Connect the server to discover available tools.');
    panel.appendChild(empty);
    container.appendChild(panel);
    return panel;
  }

  var list = d.createElement('div');
  list.className = 'hub-tool-inspector-list';

  for (var i = 0; i < tools.length; i++) {
    var t = tools[i];
    var card = d.createElement('div');
    card.className = 'hub-tool-card';

    var cHeader = d.createElement('div');
    cHeader.className = 'hub-tool-header';

    var tTitle = d.createElement('span');
    tTitle.className = 'hub-tool-name';
    setText(tTitle, t.canonicalName || t.toolName);
    cHeader.appendChild(tTitle);

    var permClass = t.permissionGate || 'CONFIRM';
    var isReadOnly = t.annotations && t.annotations.readOnlyHint;
    var permBadge = d.createElement('span');
    permBadge.className = 'status-badge ' + (permClass === 'ALLOW' ? 'is-success' : 'is-warning');
    setText(permBadge, permClass === 'ALLOW' ? 'ALLOW (Read-Only)' : 'CONFIRM (Human Review Required)');
    cHeader.appendChild(permBadge);

    card.appendChild(cHeader);

    // Description (safely rendered textContent)
    var descEl = d.createElement('p');
    descEl.className = 'hub-tool-description';
    setText(descEl, t.description || 'No description provided by server.');
    card.appendChild(descEl);

    // Side-effects / warnings
    if (t.isDestructive) {
      var wDestr = d.createElement('div');
      wDestr.className = 'hub-warning-banner is-destructive';
      setText(wDestr, '⚠️ Destructive Operation: Executes potentially irreversible changes.');
      card.appendChild(wDestr);
    }
    if (t.isSensitive) {
      var wSens = d.createElement('div');
      wSens.className = 'hub-warning-banner is-sensitive';
      setText(wSens, '🔒 Workspace Content Transmission: Transmits editor data externally.');
      card.appendChild(wSens);
    }

    // Input parameters schema
    if (t.inputSchema) {
      var schemaDetails = d.createElement('details');
      schemaDetails.className = 'hub-schema-details';
      var summary = d.createElement('summary');
      setText(summary, 'Input Schema Parameters');
      schemaDetails.appendChild(summary);
      var codePre = d.createElement('pre');
      codePre.className = 'hub-schema-pre';
      setText(codePre, JSON.stringify(t.inputSchema, null, 2));
      schemaDetails.appendChild(codePre);
      card.appendChild(schemaDetails);
    }

    list.appendChild(card);
  }

  panel.appendChild(list);
  container.appendChild(panel);
  return panel;
}

export function renderSkillsSection(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  var panel = d.createElement('div');
  panel.className = 'hub-skills-panel';

  var header = d.createElement('div');
  header.className = 'hub-card-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, 'Portable Skills Inventory');
  header.appendChild(title);

  var isRuntimeEn = Boolean(state && state.skillsRuntimeEnabled);
  var rBadge = d.createElement('span');
  rBadge.className = 'status-badge ' + (isRuntimeEn ? 'is-success' : 'is-disabled');
  setText(rBadge, isRuntimeEn ? 'Runtime: Enabled' : 'Runtime: Off (Guidance Only)');
  header.appendChild(rBadge);
  panel.appendChild(header);

  var notice = d.createElement('p');
  notice.className = 'hub-wizard-desc';
  setText(notice, 'Skills provide structured task instructions and guidance. They load lazily upon task match and never grant automatic tool execution or mutation authority.');
  panel.appendChild(notice);

  var skills = (state && state.skills) || [];
  if (skills.length === 0) {
    var empty = d.createElement('div');
    empty.className = 'hub-empty-state';
    setText(empty, 'No built-in or workspace skills discovered.');
    panel.appendChild(empty);
    container.appendChild(panel);
    return panel;
  }

  var list = d.createElement('div');
  list.className = 'hub-skills-list';

  for (var i = 0; i < skills.length; i++) {
    var sk = skills[i];
    var card = d.createElement('div');
    card.className = 'hub-skill-card';

    var sHead = d.createElement('div');
    sHead.className = 'hub-skill-header';
    var sName = d.createElement('strong');
    setText(sName, sk.name || sk.id);
    sHead.appendChild(sName);

    var sSrc = d.createElement('span');
    sSrc.className = 'status-badge ' + (sk.source === 'workspace' ? 'is-workspace' : 'is-local');
    setText(sSrc, sk.source === 'workspace' ? 'Workspace' : 'Built-in');
    sHead.appendChild(sSrc);
    card.appendChild(sHead);

    var sDesc = d.createElement('p');
    sDesc.className = 'hub-tool-description';
    setText(sDesc, sk.description || 'No description.');
    card.appendChild(sDesc);

    appendMetaRow(d, card, 'File Path', sk.filePath || 'N/A');

    if (sk.diagnostics && sk.diagnostics.length) {
      var dList = d.createElement('div');
      dList.className = 'hub-error-row';
      setText(dList, 'Diagnostics: ' + sk.diagnostics.join(', '));
      card.appendChild(dList);
    }

    var actions = d.createElement('div');
    actions.className = 'confirmation-actions';
    var openBtn = appendAction(d, actions, 'Open SKILL.md', 'Open skill instruction file in editor', (function (sid) {
      return function () { send({ type: 'integration.openSkillFile', skillId: sid }); };
    })(sk.id));
    openBtn.className = 'hub-btn-secondary';
    card.appendChild(actions);

    list.appendChild(card);
  }

  panel.appendChild(list);
  container.appendChild(panel);
  return panel;
}

export function renderModeWizard(container: any, wizard: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};
  var draft = (wizard && wizard.draft) || {};
  var step = (wizard && wizard.step) || 1;

  var panel = d.createElement('div');
  panel.className = 'hub-wizard-panel';
  setAttr(panel, 'role', 'region');
  setAttr(panel, 'aria-label', 'Custom Mode Wizard');

  // Header
  var header = d.createElement('div');
  header.className = 'hub-wizard-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, wizard && wizard.modeId ? 'Edit Custom Mode Profile' : 'Create Custom Mode Profile');
  header.appendChild(title);

  var cancelBtn = appendAction(d, header, 'Cancel', 'Exit mode wizard', function () {
    send({ type: 'integration.cancelModeWizard' });
  });
  cancelBtn.className = 'hub-btn-secondary';
  panel.appendChild(header);

  // Stepper (9 steps)
  var stepper = d.createElement('div');
  stepper.className = 'hub-wizard-stepper';
  var stepNames = [
    '1. Identity',
    '2. Base Mode',
    '3. Skills',
    '4. MCP & Tools',
    '5. Model',
    '6. Workflow',
    '7. Instructions',
    '8. Permissions',
    '9. Save'
  ];
  for (var s = 1; s <= 9; s++) {
    var dot = d.createElement('button');
    dot.type = 'button';
    dot.className = 'hub-step-dot' + (step === s ? ' is-current' : '') + (step > s ? ' is-done' : '');
    setText(dot, stepNames[s - 1]);
    onClick(dot, (function (targetStep) {
      return function () {
        send({ type: 'integration.modeWizardStep', step: targetStep });
      };
    })(s));
    stepper.appendChild(dot);
  }
  panel.appendChild(stepper);

  // Validation feedback
  if (wizard.validationErrors && wizard.validationErrors.length > 0) {
    var errBox = d.createElement('div');
    errBox.className = 'hub-empty-state is-warning';
    var errTitle = d.createElement('strong');
    setText(errTitle, 'Validation Diagnostics:');
    errBox.appendChild(errTitle);
    var errList = d.createElement('ul');
    for (var ei = 0; ei < wizard.validationErrors.length; ei++) {
      var eli = d.createElement('li');
      setText(eli, wizard.validationErrors[ei]);
      errList.appendChild(eli);
    }
    errBox.appendChild(errList);
    panel.appendChild(errBox);
  }

  // Step 1: Identity & Scope
  if (step === 1) {
    var form1 = d.createElement('div');
    form1.className = 'hub-wizard-form';

    var nameRow = d.createElement('div');
    nameRow.className = 'hub-form-row';
    var nameLabel = d.createElement('label');
    setText(nameLabel, 'Profile Name:');
    nameRow.appendChild(nameLabel);
    var nameInput = d.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'hub-input';
    nameInput.value = draft.name || '';
    nameInput.placeholder = 'e.g. Security Audit Mode';
    nameRow.appendChild(nameInput);
    form1.appendChild(nameRow);

    var idRow = d.createElement('div');
    idRow.className = 'hub-form-row';
    var idLabel = d.createElement('label');
    setText(idLabel, 'Identifier (ID):');
    idRow.appendChild(idLabel);
    var idInput = d.createElement('input');
    idInput.type = 'text';
    idInput.className = 'hub-input';
    idInput.value = draft.id || '';
    idInput.placeholder = 'e.g. security-audit';
    idRow.appendChild(idInput);
    form1.appendChild(idRow);

    var descRow = d.createElement('div');
    descRow.className = 'hub-form-row';
    var descLabel = d.createElement('label');
    setText(descLabel, 'Description:');
    descRow.appendChild(descLabel);
    var descInput = d.createElement('input');
    descInput.type = 'text';
    descInput.className = 'hub-input';
    descInput.value = draft.description || '';
    descInput.placeholder = 'Brief summary of specialized agent behavior';
    descRow.appendChild(descInput);
    form1.appendChild(descRow);

    var scopeRow = d.createElement('div');
    scopeRow.className = 'hub-form-row';
    var scopeLabel = d.createElement('label');
    setText(scopeLabel, 'Persistence Scope:');
    scopeRow.appendChild(scopeLabel);
    var scopeSelect = d.createElement('select');
    scopeSelect.className = 'hub-input';
    var optWork = d.createElement('option');
    optWork.value = 'workspace';
    setText(optWork, 'Workspace (.open-vs-code/modes.json) — Local first');
    scopeSelect.appendChild(optWork);
    var optAcc = d.createElement('option');
    optAcc.value = 'account';
    setText(optAcc, 'Account (Private Account Service) — Synchronized across devices');
    scopeSelect.appendChild(optAcc);
    scopeSelect.value = draft.scope || 'workspace';
    scopeRow.appendChild(scopeSelect);
    form1.appendChild(scopeRow);

    panel.appendChild(form1);

    var syncDraft1 = function () {
      send({
        type: 'integration.modeWizardDraft',
        draft: {
          name: nameInput.value,
          id: idInput.value,
          description: descInput.value,
          scope: scopeSelect.value,
        },
      });
    };
    nameInput.addEventListener('change', syncDraft1);
    idInput.addEventListener('change', syncDraft1);
    descInput.addEventListener('change', syncDraft1);
    scopeSelect.addEventListener('change', syncDraft1);
  }

  // Step 2: Base Agent Mode
  else if (step === 2) {
    var modePanel = d.createElement('div');
    modePanel.className = 'hub-wizard-form';
    var modeHelp = d.createElement('p');
    modeHelp.className = 'hub-empty-state';
    setText(modeHelp, 'Every custom mode maps to exactly one of the 5 canonical base modes. A profile cannot elevate base permissions.');
    modePanel.appendChild(modeHelp);

    var baseModes = [
      { id: 'ASK', label: 'ASK — Pure read-only Q&A (no mutations, no execution)' },
      { id: 'PLAN', label: 'PLAN — Architecture & design planning (read-only research)' },
      { id: 'BUILD', label: 'BUILD — Implementation (can request mutations, subject to approval)' },
      { id: 'DEBUG', label: 'DEBUG — Diagnostic investigation (repro, test, inspection)' },
      { id: 'REVIEW', label: 'REVIEW — Code audit & verification (read-only critique)' }
    ];

    for (var bi = 0; bi < baseModes.length; bi++) {
      var bm = baseModes[bi];
      var bmBtn = d.createElement('button');
      bmBtn.type = 'button';
      bmBtn.className = 'hub-transport-card' + (draft.baseMode === bm.id ? ' is-selected' : '');
      setText(bmBtn, bm.label);
      onClick(bmBtn, (function (selectedMode) {
        return function () {
          send({
            type: 'integration.modeWizardDraft',
            draft: { baseMode: selectedMode },
          });
        };
      })(bm.id));
      modePanel.appendChild(bmBtn);
    }
    panel.appendChild(modePanel);
  }

  // Step 3: Skills Integration
  else if (step === 3) {
    var skillPanel = d.createElement('div');
    skillPanel.className = 'hub-wizard-form';
    var sHelp = d.createElement('p');
    sHelp.className = 'hub-empty-state';
    setText(sHelp, 'Configure required and optional skills. Missing required skills block mode execution.');
    skillPanel.appendChild(sHelp);

    var skills = (state && state.skills) || [];
    if (skills.length === 0) {
      var noSkills = d.createElement('p');
      noSkills.className = 'hub-empty-state';
      setText(noSkills, 'No installed skills found in this workspace.');
      skillPanel.appendChild(noSkills);
    } else {
      var reqList = draft.requiredSkills || [];
      var optList = draft.optionalSkills || [];

      for (var si = 0; si < skills.length; si++) {
        var sk = skills[si];
        var sRow = d.createElement('div');
        sRow.className = 'hub-form-row';
        var sHeader = d.createElement('div');
        sHeader.style.display = 'flex';
        sHeader.style.justifyContent = 'space-between';
        var sTitle = d.createElement('strong');
        setText(sTitle, sk.name + ' (' + sk.id + ')');
        sHeader.appendChild(sTitle);
        sRow.appendChild(sHeader);

        var sControls = d.createElement('div');
        sControls.style.display = 'flex';
        sControls.style.gap = '12px';

        var reqLabel = d.createElement('label');
        reqLabel.className = 'hub-form-row is-checkbox';
        var reqBox = d.createElement('input');
        reqBox.type = 'checkbox';
        reqBox.checked = reqList.includes(sk.id);
        reqLabel.appendChild(reqBox);
        var reqText = d.createElement('span');
        setText(reqText, 'Required');
        reqLabel.appendChild(reqText);
        sControls.appendChild(reqLabel);

        var optLabel = d.createElement('label');
        optLabel.className = 'hub-form-row is-checkbox';
        var optBox = d.createElement('input');
        optBox.type = 'checkbox';
        optBox.checked = optList.includes(sk.id);
        optLabel.appendChild(optBox);
        var optText = d.createElement('span');
        setText(optText, 'Optional');
        optLabel.appendChild(optText);
        sControls.appendChild(optLabel);

        sRow.appendChild(sControls);
        skillPanel.appendChild(sRow);

        (function (skId, rBox, oBox) {
          rBox.addEventListener('change', function () {
            var curReq = (draft.requiredSkills || []).slice();
            var curOpt = (draft.optionalSkills || []).slice();
            if (rBox.checked) {
              if (!curReq.includes(skId)) curReq.push(skId);
              curOpt = curOpt.filter(function (x: any) { return x !== skId; });
              oBox.checked = false;
            } else {
              curReq = curReq.filter(function (x: any) { return x !== skId; });
            }
            send({
              type: 'integration.modeWizardDraft',
              draft: { requiredSkills: curReq, optionalSkills: curOpt },
            });
          });

          oBox.addEventListener('change', function () {
            var curReq = (draft.requiredSkills || []).slice();
            var curOpt = (draft.optionalSkills || []).slice();
            if (oBox.checked) {
              if (!curOpt.includes(skId)) curOpt.push(skId);
              curReq = curReq.filter(function (x: any) { return x !== skId; });
              rBox.checked = false;
            } else {
              curOpt = curOpt.filter(function (x: any) { return x !== skId; });
            }
            send({
              type: 'integration.modeWizardDraft',
              draft: { requiredSkills: curReq, optionalSkills: curOpt },
            });
          });
        })(sk.id, reqBox, optBox);
      }
    }
    panel.appendChild(skillPanel);
  }

  // Step 4: MCP Servers & Tool Allowlist
  else if (step === 4) {
    var mcpPanel = d.createElement('div');
    mcpPanel.className = 'hub-wizard-form';

    var servers = (state && state.servers) || [];
    var reqMcp = draft.requiredMcpServers || [];
    var optMcp = draft.optionalMcpServers || [];

    var mcpHeader = d.createElement('h4');
    setText(mcpHeader, 'Registered MCP Servers:');
    mcpPanel.appendChild(mcpHeader);

    if (servers.length === 0) {
      var noMcp = d.createElement('p');
      noMcp.className = 'hub-empty-state';
      setText(noMcp, 'No MCP servers currently registered.');
      mcpPanel.appendChild(noMcp);
    } else {
      for (var mi = 0; mi < servers.length; mi++) {
        var srv = servers[mi];
        var mRow = d.createElement('div');
        mRow.className = 'hub-form-row';
        var mTitle = d.createElement('strong');
        setText(mTitle, srv.displayName + ' (' + srv.id + ')');
        mRow.appendChild(mTitle);

        var mControls = d.createElement('div');
        mControls.style.display = 'flex';
        mControls.style.gap = '12px';

        var mReqLabel = d.createElement('label');
        mReqLabel.className = 'hub-form-row is-checkbox';
        var mReqBox = d.createElement('input');
        mReqBox.type = 'checkbox';
        mReqBox.checked = reqMcp.includes(srv.id);
        mReqLabel.appendChild(mReqBox);
        var mReqText = d.createElement('span');
        setText(mReqText, 'Required');
        mReqLabel.appendChild(mReqText);
        mControls.appendChild(mReqLabel);

        var mOptLabel = d.createElement('label');
        mOptLabel.className = 'hub-form-row is-checkbox';
        var mOptBox = d.createElement('input');
        mOptBox.type = 'checkbox';
        mOptBox.checked = optMcp.includes(srv.id);
        mOptLabel.appendChild(mOptBox);
        var mOptText = d.createElement('span');
        setText(mOptText, 'Optional');
        mOptLabel.appendChild(mOptText);
        mControls.appendChild(mOptLabel);

        mRow.appendChild(mControls);
        mcpPanel.appendChild(mRow);

        (function (srvId, rBox, oBox) {
          rBox.addEventListener('change', function () {
            var curReq = (draft.requiredMcpServers || []).slice();
            var curOpt = (draft.optionalMcpServers || []).slice();
            if (rBox.checked) {
              if (!curReq.includes(srvId)) curReq.push(srvId);
              curOpt = curOpt.filter(function (x: any) { return x !== srvId; });
              oBox.checked = false;
            } else {
              curReq = curReq.filter(function (x: any) { return x !== srvId; });
            }
            send({
              type: 'integration.modeWizardDraft',
              draft: { requiredMcpServers: curReq, optionalMcpServers: curOpt },
            });
          });

          oBox.addEventListener('change', function () {
            var curReq = (draft.requiredMcpServers || []).slice();
            var curOpt = (draft.optionalMcpServers || []).slice();
            if (oBox.checked) {
              if (!curOpt.includes(srvId)) curOpt.push(srvId);
              curReq = curReq.filter(function (x: any) { return x !== srvId; });
              rBox.checked = false;
            } else {
              curOpt = curOpt.filter(function (x: any) { return x !== srvId; });
            }
            send({
              type: 'integration.modeWizardDraft',
              draft: { requiredMcpServers: curReq, optionalMcpServers: curOpt },
            });
          });
        })(srv.id, mReqBox, mOptBox);
      }
    }

    var allowRow = d.createElement('div');
    allowRow.className = 'hub-form-row';
    var allowLabel = d.createElement('label');
    setText(allowLabel, 'Tool Allowlist (Comma-separated tool names, or empty for unrestricted):');
    allowRow.appendChild(allowLabel);
    var allowInput = d.createElement('input');
    allowInput.type = 'text';
    allowInput.className = 'hub-input';
    allowInput.value = (draft.toolAllowlist || []).join(', ');
    allowInput.placeholder = 'e.g. read_file, search_files, mcp_postgres_query';
    allowRow.appendChild(allowInput);
    mcpPanel.appendChild(allowRow);

    allowInput.addEventListener('change', function () {
      var raw = allowInput.value.trim();
      var list = raw ? raw.split(',').map(function (s: any) { return s.trim(); }).filter(Boolean) : undefined;
      send({
        type: 'integration.modeWizardDraft',
        draft: { toolAllowlist: list },
      });
    });

    panel.appendChild(mcpPanel);
  }

  // Step 5: Preferred Model
  else if (step === 5) {
    var modelPanel = d.createElement('div');
    modelPanel.className = 'hub-wizard-form';

    var modRow = d.createElement('div');
    modRow.className = 'hub-form-row';
    var modLabel = d.createElement('label');
    setText(modLabel, 'Preferred Model Deployment ID:');
    modRow.appendChild(modLabel);
    var modInput = d.createElement('input');
    modInput.type = 'text';
    modInput.className = 'hub-input';
    modInput.value = draft.preferredModelId || '';
    modInput.placeholder = 'e.g. local-chat or qwen2.5-coder-7b';
    modRow.appendChild(modInput);
    modelPanel.appendChild(modRow);

    var modHelp = d.createElement('p');
    modHelp.className = 'hub-empty-state';
    setText(modHelp, 'Model preferences map to existing ModelRouter deployments. A mode preference cannot silently download weights or bypass configured fallback policies.');
    modelPanel.appendChild(modHelp);

    modInput.addEventListener('change', function () {
      send({
        type: 'integration.modeWizardDraft',
        draft: { preferredModelId: modInput.value.trim() || undefined },
      });
    });

    panel.appendChild(modelPanel);
  }

  // Step 6: Workflow Preferences
  else if (step === 6) {
    var wfPanel = d.createElement('div');
    wfPanel.className = 'hub-wizard-form';

    var wfRow = d.createElement('div');
    wfRow.className = 'hub-form-row';
    var wfLabel = d.createElement('label');
    setText(wfLabel, 'Workflow Execution Mode:');
    wfRow.appendChild(wfLabel);
    var wfSelect = d.createElement('select');
    wfSelect.className = 'hub-input';

    var wfOpt1 = d.createElement('option');
    wfOpt1.value = 'standard';
    setText(wfOpt1, 'Standard Loop (Single-turn verified engineering)');
    wfSelect.appendChild(wfOpt1);

    var wfOpt2 = d.createElement('option');
    wfOpt2.value = 'structured_engineering';
    setText(wfOpt2, 'Structured Engineering Loop (Multi-phase ADR-030)');
    wfSelect.appendChild(wfOpt2);

    var wfOpt3 = d.createElement('option');
    wfOpt3.value = 'direct';
    setText(wfOpt3, 'Direct Conversation (No workflow wrapper)');
    wfSelect.appendChild(wfOpt3);

    wfSelect.value = draft.workflowPreference || 'standard';
    wfRow.appendChild(wfSelect);
    wfPanel.appendChild(wfRow);

    wfSelect.addEventListener('change', function () {
      send({
        type: 'integration.modeWizardDraft',
        draft: { workflowPreference: wfSelect.value },
      });
    });

    panel.appendChild(wfPanel);
  }

  // Step 7: Custom Instructions & Context
  else if (step === 7) {
    var insPanel = d.createElement('div');
    insPanel.className = 'hub-wizard-form';

    var insRow = d.createElement('div');
    insRow.className = 'hub-form-row';
    var insLabel = d.createElement('label');
    setText(insLabel, 'Bounded Custom Instructions (max 4,000 characters):');
    insRow.appendChild(insLabel);

    var insArea = d.createElement('textarea');
    insArea.className = 'hub-input';
    insArea.rows = 8;
    insArea.value = draft.customInstructions || '';
    insArea.placeholder = 'Provide specialized behavioral guidance, domain constraints, or review criteria. These instructions cannot bypass system permission checks or workspace trust.';
    insRow.appendChild(insArea);
    insPanel.appendChild(insRow);

    var charCount = d.createElement('div');
    charCount.style.fontSize = '0.8em';
    charCount.style.opacity = '0.7';
    setText(charCount, (draft.customInstructions || '').length + ' / 4000 characters');
    insPanel.appendChild(charCount);

    insArea.addEventListener('input', function () {
      setText(charCount, insArea.value.length + ' / 4000 characters');
    });

    insArea.addEventListener('change', function () {
      send({
        type: 'integration.modeWizardDraft',
        draft: { customInstructions: insArea.value.trim() || undefined },
      });
    });

    panel.appendChild(insPanel);
  }

  // Step 8: Permission & Dependency Review
  else if (step === 8) {
    var revPanel = d.createElement('div');
    revPanel.className = 'hub-wizard-form';

    var permCard = d.createElement('div');
    permCard.className = 'terminal-meta';

    appendMetaRow(d, permCard, 'Base Mode', draft.baseMode || 'ASK');
    appendMetaRow(d, permCard, 'Mutation Authority', draft.baseMode === 'BUILD' ? 'MUTATION CAPABLE (Confirmation Required)' : 'READ-ONLY (Mutations Blocked)');
    appendMetaRow(d, permCard, 'Workspace Trust', 'Enforced by PermissionGate');
    appendMetaRow(d, permCard, 'Tool Allowlist', draft.toolAllowlist && draft.toolAllowlist.length ? draft.toolAllowlist.join(', ') : 'All enabled tools');
    appendMetaRow(d, permCard, 'Required Skills', (draft.requiredSkills || []).join(', ') || 'None');
    appendMetaRow(d, permCard, 'Required MCP', (draft.requiredMcpServers || []).join(', ') || 'None');
    revPanel.appendChild(permCard);

    if (wizard.resolvedPreview) {
      var prevTitle = d.createElement('h4');
      setText(prevTitle, 'Live Execution Resolution:');
      revPanel.appendChild(prevTitle);

      var pBox = d.createElement('div');
      pBox.className = 'hub-empty-state ' + (wizard.resolvedPreview.isReady ? 'is-clean' : 'is-warning');
      setText(pBox, wizard.resolvedPreview.isReady ? '✓ Mode is READY for execution in current workspace.' : '⚠️ Mode is NOT READY: missing required dependencies.');
      revPanel.appendChild(pBox);
    }

    panel.appendChild(revPanel);
  }

  // Step 9: Save & Activate
  else if (step === 9) {
    var savePanel = d.createElement('div');
    savePanel.className = 'hub-wizard-form';

    var summary = d.createElement('div');
    summary.className = 'terminal-meta';
    appendMetaRow(d, summary, 'Name', draft.name || 'Unnamed');
    appendMetaRow(d, summary, 'ID', draft.id || 'auto-generated');
    appendMetaRow(d, summary, 'Base Mode', draft.baseMode || 'ASK');
    appendMetaRow(d, summary, 'Scope', draft.scope || 'workspace');
    savePanel.appendChild(summary);

    var saveActions = d.createElement('div');
    saveActions.className = 'hub-card-actions';

    var saveBtn = appendAction(d, saveActions, 'Save Mode Profile', 'Persist configuration profile', function () {
      send({ type: 'integration.modeWizardSave', activateNow: false });
    });
    saveBtn.className = 'btn-approve';

    var actBtn = appendAction(d, saveActions, 'Save & Set Active', 'Persist and immediately switch to this mode', function () {
      send({ type: 'integration.modeWizardSave', activateNow: true });
    });
    actBtn.className = 'btn-approve';

    savePanel.appendChild(saveActions);
    panel.appendChild(savePanel);
  }

  // Navigation Bar (Back & Next)
  var navRow = d.createElement('div');
  navRow.className = 'hub-wizard-actions';
  navRow.style.display = 'flex';
  navRow.style.justifyContent = 'space-between';
  navRow.style.marginTop = '16px';

  if (step > 1) {
    var backBtn = appendAction(d, navRow, '← Back', 'Previous step', function () {
      send({ type: 'integration.modeWizardStep', step: step - 1 });
    });
    backBtn.className = 'hub-btn-secondary';
  } else {
    var spacer = d.createElement('div');
    navRow.appendChild(spacer);
  }

  if (step < 9) {
    var nextBtn = appendAction(d, navRow, 'Next →', 'Next step', function () {
      send({ type: 'integration.modeWizardStep', step: step + 1 });
    });
    nextBtn.className = 'btn-approve';
  }

  panel.appendChild(navRow);
  container.appendChild(panel);
  return panel;
}

export function renderModeInspector(container: any, detail: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  var panel = d.createElement('div');
  panel.className = 'hub-inspector-panel';
  setAttr(panel, 'role', 'region');
  setAttr(panel, 'aria-label', 'Mode Detail Inspector');

  var header = d.createElement('div');
  header.className = 'hub-inspector-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, detail.name + ' (v' + detail.version + ')');
  header.appendChild(title);

  var closeBtn = appendAction(d, header, 'Close', 'Close mode inspection', function () {
    send({ type: 'integration.inspectMode', modeId: undefined });
  });
  closeBtn.className = 'hub-btn-secondary';
  panel.appendChild(header);

  var meta = d.createElement('div');
  meta.className = 'terminal-meta';
  appendMetaRow(d, meta, 'Profile ID', detail.id);
  appendMetaRow(d, meta, 'Base Agent Mode', detail.baseMode);
  appendMetaRow(d, meta, 'Scope', detail.scope);
  appendMetaRow(d, meta, 'Execution Readiness', detail.isReady ? 'READY' : 'UNREADY');
  if (detail.preferredModelId) appendMetaRow(d, meta, 'Preferred Model', detail.preferredModelId);
  if (detail.workflowPreference) appendMetaRow(d, meta, 'Workflow', detail.workflowPreference);
  appendMetaRow(d, meta, 'Tool Allowlist', (detail.toolAllowlist && detail.toolAllowlist.length) ? detail.toolAllowlist.join(', ') : 'Unrestricted (all enabled tools)');
  panel.appendChild(meta);

  if (detail.description) {
    var descP = d.createElement('p');
    descP.style.margin = '8px 0';
    setText(descP, detail.description);
    panel.appendChild(descP);
  }

  if (detail.customInstructions) {
    var insBox = d.createElement('div');
    insBox.className = 'terminal-command-box';
    insBox.style.whiteSpace = 'pre-wrap';
    setText(insBox, detail.customInstructions);
    panel.appendChild(insBox);
  }

  // Dependencies
  var depTitle = d.createElement('h4');
  setText(depTitle, 'Configured Dependencies:');
  panel.appendChild(depTitle);

  var depList = d.createElement('ul');
  depList.className = 'hub-skills-list';

  (detail.requiredSkills || []).forEach(function (s: string) {
    var li = d.createElement('li');
    setText(li, 'Skill (Required): ' + s);
    depList.appendChild(li);
  });
  (detail.optionalSkills || []).forEach(function (s: string) {
    var li = d.createElement('li');
    setText(li, 'Skill (Optional): ' + s);
    depList.appendChild(li);
  });
  (detail.requiredMcpServers || []).forEach(function (s: string) {
    var li = d.createElement('li');
    setText(li, 'MCP Server (Required): ' + s);
    depList.appendChild(li);
  });
  (detail.optionalMcpServers || []).forEach(function (s: string) {
    var li = d.createElement('li');
    setText(li, 'MCP Server (Optional): ' + s);
    depList.appendChild(li);
  });
  panel.appendChild(depList);

  if (detail.diagnostics && detail.diagnostics.length > 0) {
    var dTitle = d.createElement('h4');
    setText(dTitle, 'Active Diagnostics:');
    panel.appendChild(dTitle);
    var dList = d.createElement('ul');
    for (var i = 0; i < detail.diagnostics.length; i++) {
      var dItem = d.createElement('li');
      setText(dItem, detail.diagnostics[i]);
      dList.appendChild(dItem);
    }
    panel.appendChild(dList);
  }

  container.appendChild(panel);
  return panel;
}

export function renderModesSection(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  // If wizard is active, render it
  if (state && state.modeWizard) {
    return renderModeWizard(container, state.modeWizard, state, d, send);
  }

  // If inspecting a mode, render detail inspector
  if (state && state.inspectingModeDetail) {
    return renderModeInspector(container, state.inspectingModeDetail, d, send);
  }

  var panel = d.createElement('div');
  panel.className = 'hub-modes-panel';

  var header = d.createElement('div');
  header.className = 'hub-card-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, 'Execution Modes & Custom Profiles');
  header.appendChild(title);

  var addBtn = appendAction(d, header, '+ Create Mode', 'Create a new custom mode profile', function () {
    send({ type: 'integration.startModeWizard' });
  });
  addBtn.className = 'btn-approve';
  panel.appendChild(header);

  var desc = d.createElement('p');
  desc.className = 'hub-placeholder-desc';
  setText(desc, 'Custom modes configure specialized agent behavior by combining a base execution mode (ASK, PLAN, BUILD, DEBUG, REVIEW), installed skills, MCP tools, and model preferences. Profiles cannot bypass the PermissionGate.');
  panel.appendChild(desc);

  var modes = (state && state.modes) || [];
  if (modes.length === 0) {
    var empty = d.createElement('div');
    empty.className = 'hub-empty-state';
    setText(empty, 'No custom mode profiles loaded. Create one to specialize agent execution.');
    panel.appendChild(empty);
  } else {
    var list = d.createElement('div');
    list.className = 'hub-server-list';
    list.setAttribute('role', 'list');

    for (var i = 0; i < modes.length; i++) {
      var mode = modes[i];
      var card = d.createElement('div');
      card.className = 'hub-server-card' + (mode.enabled ? '' : ' is-disabled');
      card.setAttribute('role', 'listitem');

      var mHeader = d.createElement('div');
      mHeader.className = 'hub-server-header';

      var titleGroup = d.createElement('div');
      var nameEl = d.createElement('span');
      nameEl.className = 'hub-server-name';
      setText(nameEl, mode.name);
      titleGroup.appendChild(nameEl);

      var badgeGroup = d.createElement('div');
      badgeGroup.className = 'hub-badge-group';

      var baseBadge = d.createElement('span');
      baseBadge.className = 'status-badge';
      setText(baseBadge, 'Base: ' + mode.baseMode);
      badgeGroup.appendChild(baseBadge);

      var scopeBadge = d.createElement('span');
      scopeBadge.className = 'hub-provenance-badge is-' + (mode.scope || 'local');
      setText(scopeBadge, mode.scope);
      badgeGroup.appendChild(scopeBadge);

      var readyBadge = d.createElement('span');
      readyBadge.className = 'status-badge ' + (mode.isReady ? 'is-running' : 'is-disabled');
      setText(readyBadge, mode.isReady ? 'Ready' : 'Dependencies Missing');
      badgeGroup.appendChild(readyBadge);

      if (state.activeModeId === mode.id) {
        var activeBadge = d.createElement('span');
        activeBadge.className = 'status-badge is-running';
        setText(activeBadge, '✓ Active');
        badgeGroup.appendChild(activeBadge);
      }

      mHeader.appendChild(titleGroup);
      mHeader.appendChild(badgeGroup);
      card.appendChild(mHeader);

      var descP = d.createElement('p');
      descP.style.fontSize = '0.85em';
      descP.style.margin = '4px 0 8px 0';
      setText(descP, mode.description || '');
      card.appendChild(descP);

      var actions = d.createElement('div');
      actions.className = 'hub-card-actions';

      (function (m) {
        if (state.activeModeId !== m.id && m.enabled) {
          var actBtn = appendAction(d, actions, 'Set Active', 'Make this profile active in chat', function () {
            send({ type: 'integration.setActiveMode', modeId: m.id });
          });
          actBtn.className = 'hub-btn-sm btn-approve';
        }

        var inspBtn = appendAction(d, actions, 'Inspect', 'Inspect mode details & effective permissions', function () {
          send({ type: 'integration.inspectMode', modeId: m.id });
        });
        inspBtn.className = 'hub-btn-sm hub-btn-secondary';

        if (m.scope !== 'builtin') {
          var editBtn = appendAction(d, actions, 'Edit', 'Edit this profile configuration', function () {
            send({ type: 'integration.startModeWizard', modeId: m.id });
          });
          editBtn.className = 'hub-btn-sm hub-btn-secondary';
        }

        var dupBtn = appendAction(d, actions, 'Duplicate', 'Clone into workspace profile', function () {
          send({ type: 'integration.duplicateMode', modeId: m.id, targetScope: 'workspace' });
        });
        dupBtn.className = 'hub-btn-sm hub-btn-secondary';

        var togBtn = appendAction(d, actions, m.enabled ? 'Disable' : 'Enable', 'Toggle profile active state', function () {
          send({ type: 'integration.toggleMode', modeId: m.id, enabled: !m.enabled });
        });
        togBtn.className = 'hub-btn-sm hub-btn-secondary';

        if (m.scope !== 'builtin') {
          var delBtn = appendAction(d, actions, 'Delete', 'Remove this custom mode profile', function () {
            send({ type: 'integration.deleteMode', modeId: m.id });
          });
          delBtn.className = 'hub-btn-sm btn-reject';
        }
      })(mode);

      card.appendChild(actions);
      list.appendChild(card);
    }
    panel.appendChild(list);
  }

  container.appendChild(panel);
  return panel;
}

export function renderDiagnosticsSection(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  var panel = d.createElement('div');
  panel.className = 'hub-diagnostics-panel';

  var header = d.createElement('div');
  header.className = 'hub-card-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, 'System & Integration Diagnostics');
  header.appendChild(title);

  var refreshBtn = appendAction(d, header, 'Refresh', 'Re-scan system diagnostics', function () {
    send({ type: 'integration.refreshDiscovery' });
  });
  refreshBtn.className = 'hub-btn-secondary';
  panel.appendChild(header);

  var diags = (state && state.diagnostics) || [];
  if (diags.length === 0) {
    var clean = d.createElement('div');
    clean.className = 'hub-empty-state is-clean';
    setText(clean, 'All systems clean. No warnings or errors reported across MCP servers, account backend, or skills.');
    panel.appendChild(clean);
  } else {
    var list = d.createElement('ul');
    list.className = 'hub-diagnostic-list';
    for (var i = 0; i < diags.length; i++) {
      var item = d.createElement('li');
      item.className = 'hub-diagnostic-item';
      setText(item, diags[i]);
      list.appendChild(item);
    }
    panel.appendChild(list);
  }

  container.appendChild(panel);
  return panel;
}

export function renderPackInspector(container: any, pack: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  var panel = d.createElement('div');
  panel.className = 'hub-modes-panel';

  var backBtn = appendAction(d, panel, '← Back to Capability Packs', 'Return to packs list', function () {
    send({ type: 'integration.inspectPack', packId: undefined });
  });
  backBtn.className = 'btn-secondary';

  var header = d.createElement('div');
  header.className = 'hub-card-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, pack.name + ' (v' + pack.version + ')');
  header.appendChild(title);

  var statusBadge = d.createElement('span');
  statusBadge.className = 'status-badge status-' + (pack.isReady ? 'ready' : 'blocked');
  setText(statusBadge, pack.status);
  header.appendChild(statusBadge);
  panel.appendChild(header);

  var metaGrid = d.createElement('div');
  metaGrid.className = 'hub-meta-grid';

  var metaItems = [
    { label: 'Pack ID', value: pack.id },
    { label: 'Scope', value: pack.scope },
    { label: 'Publisher', value: pack.publisher ? pack.publisher.name : 'Unknown' },
    { label: 'License', value: pack.license },
    { label: 'Base Mode', value: pack.baseMode },
    { label: 'Integrity Digest', value: pack.integrity ? pack.integrity.digest.substring(0, 16) + '...' : 'None' },
  ];

  for (var m = 0; m < metaItems.length; m++) {
    var mRow = d.createElement('div');
    mRow.className = 'hub-meta-item';
    var lbl = d.createElement('strong');
    setText(lbl, metaItems[m].label + ': ');
    mRow.appendChild(lbl);
    var val = d.createElement('span');
    setText(val, metaItems[m].value);
    mRow.appendChild(val);
    metaGrid.appendChild(mRow);
  }
  panel.appendChild(metaGrid);

  var desc = d.createElement('p');
  desc.className = 'hub-placeholder-desc';
  setText(desc, pack.description || 'No description provided.');
  panel.appendChild(desc);

  // Requested Permissions
  var permSection = d.createElement('div');
  permSection.className = 'hub-card-section';
  var permTitle = d.createElement('h4');
  setText(permTitle, 'Requested Permissions');
  permSection.appendChild(permTitle);

  var perms = pack.permissionDeclarations || [];
  if (perms.length === 0) {
    var noPerm = d.createElement('p');
    setText(noPerm, 'Zero external or mutation permissions requested.');
    permSection.appendChild(noPerm);
  } else {
    var pList = d.createElement('ul');
    for (var p = 0; p < perms.length; p++) {
      var pItem = d.createElement('li');
      setText(pItem, perms[p]);
      pList.appendChild(pItem);
    }
    permSection.appendChild(pList);
  }
  panel.appendChild(permSection);

  // Dependencies
  var depSection = d.createElement('div');
  depSection.className = 'hub-card-section';
  var depTitle = d.createElement('h4');
  setText(depTitle, 'Dependencies');
  depSection.appendChild(depTitle);

  var depList = d.createElement('ul');
  var reqSkills = pack.requiredSkills || [];
  for (var s = 0; s < reqSkills.length; s++) {
    var sItem = d.createElement('li');
    setText(sItem, 'Required Skill: ' + reqSkills[s]);
    depList.appendChild(sItem);
  }
  var reqMcps = pack.requiredMcpServers || [];
  for (var c = 0; c < reqMcps.length; c++) {
    var cItem = d.createElement('li');
    setText(cItem, 'Required MCP Server: ' + (reqMcps[c].id || reqMcps[c]));
    depList.appendChild(cItem);
  }
  if (reqSkills.length === 0 && reqMcps.length === 0) {
    var noDep = d.createElement('li');
    setText(noDep, 'Zero external dependencies required.');
    depList.appendChild(noDep);
  }
  depSection.appendChild(depList);
  panel.appendChild(depSection);

  // Diagnostics
  if (pack.diagnostics && pack.diagnostics.length > 0) {
    var diagSection = d.createElement('div');
    diagSection.className = 'hub-card-section';
    var diagTitle = d.createElement('h4');
    setText(diagTitle, 'Readiness Diagnostics');
    diagSection.appendChild(diagTitle);

    var diagList = d.createElement('ul');
    for (var dIdx = 0; dIdx < pack.diagnostics.length; dIdx++) {
      var dItem = d.createElement('li');
      dItem.className = 'hub-diagnostic-item';
      setText(dItem, pack.diagnostics[dIdx]);
      diagList.appendChild(dItem);
    }
    diagSection.appendChild(diagList);
    panel.appendChild(diagSection);
  }

  // Action Buttons
  var actions = d.createElement('div');
  actions.className = 'hub-action-bar';

  if (pack.scope !== 'builtin') {
    if (pack.enabled) {
      appendAction(d, actions, 'Disable Pack', 'Disable this capability pack', function () {
        send({ type: 'integration.disablePack', packId: pack.id });
      });
    } else {
      appendAction(d, actions, 'Enable Pack', 'Enable this capability pack', function () {
        send({ type: 'integration.enablePack', packId: pack.id });
      });
    }

    if (pack.hasRollback) {
      appendAction(d, actions, 'Roll Back', 'Roll back to previous version (' + pack.previousVersion + ')', function () {
        send({ type: 'integration.rollbackPack', packId: pack.id });
      });
    }

    appendAction(d, actions, 'Remove Pack', 'Remove this pack', function () {
      send({ type: 'integration.removePack', packId: pack.id });
    });
  }

  if (pack.enabled && pack.isReady) {
    var actBtn = appendAction(d, actions, pack.isActive ? 'Active Mode' : 'Activate Mode', 'Activate underlying custom mode', function () {
      send({ type: 'integration.activatePack', packId: pack.id });
    });
    actBtn.className = 'btn-approve';
  }

  panel.appendChild(actions);
  container.appendChild(panel);
  return panel;
}

export function renderPacksSection(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var d = docOf(doc);
  var send = postMessage || function () {};

  if (state && state.inspectingPackDetail) {
    return renderPackInspector(container, state.inspectingPackDetail, d, send);
  }

  var panel = d.createElement('div');
  panel.className = 'hub-modes-panel';

  var header = d.createElement('div');
  header.className = 'hub-card-header';
  var title = d.createElement('h3');
  title.className = 'hub-card-title';
  setText(title, 'Capability Packs');
  header.appendChild(title);

  var importBtn = appendAction(d, header, '+ Import Manifest', 'Import and install a Capability Pack manifest', function () {
    send({ type: 'integration.importPackPrompt' });
  });
  importBtn.className = 'btn-approve';
  panel.appendChild(header);

  var desc = d.createElement('p');
  desc.className = 'hub-placeholder-desc';
  setText(desc, 'Capability Packs are declarative bundles of Custom Modes, portable Skills, MCP tools, and workflow requirements. Installation does not enable; enablement does not grant tool authority.');
  panel.appendChild(desc);

  var packs = (state && state.packs) || [];
  if (packs.length === 0) {
    var empty = d.createElement('div');
    empty.className = 'hub-empty-state';
    setText(empty, 'No capability packs loaded.');
    panel.appendChild(empty);
  } else {
    var list = d.createElement('div');
    list.className = 'hub-server-list';
    list.setAttribute('role', 'list');

    for (var i = 0; i < packs.length; i++) {
      var pack = packs[i];
      var card = d.createElement('div');
      card.className = 'hub-server-card' + (pack.enabled ? '' : ' is-disabled');
      card.setAttribute('role', 'listitem');

      var pHeader = d.createElement('div');
      pHeader.className = 'hub-server-header';

      var titleGroup = d.createElement('div');
      var nameEl = d.createElement('span');
      nameEl.className = 'hub-server-name';
      setText(nameEl, pack.name + ' (v' + pack.version + ')');
      titleGroup.appendChild(nameEl);

      var badgeGroup = d.createElement('div');
      badgeGroup.className = 'hub-badge-group';

      var scopeBadge = d.createElement('span');
      scopeBadge.className = 'status-badge';
      setText(scopeBadge, pack.scope);
      badgeGroup.appendChild(scopeBadge);

      var statusBadge = d.createElement('span');
      statusBadge.className = 'status-badge status-' + (pack.isReady ? 'ready' : 'blocked');
      setText(statusBadge, pack.status);
      badgeGroup.appendChild(statusBadge);

      if (pack.isActive) {
        var activeBadge = d.createElement('span');
        activeBadge.className = 'status-badge is-active';
        setText(activeBadge, 'Active');
        badgeGroup.appendChild(activeBadge);
      }

      titleGroup.appendChild(badgeGroup);
      pHeader.appendChild(titleGroup);

      var actionGroup = d.createElement('div');
      actionGroup.className = 'hub-server-actions';

      appendAction(d, actionGroup, 'Inspect', 'Inspect pack details', (function (pid) {
        return function () { send({ type: 'integration.inspectPack', packId: pid }); };
      })(pack.id));

      if (pack.scope !== 'builtin') {
        if (pack.enabled) {
          appendAction(d, actionGroup, 'Disable', 'Disable pack', (function (pid) {
            return function () { send({ type: 'integration.disablePack', packId: pid }); };
          })(pack.id));
        } else {
          appendAction(d, actionGroup, 'Enable', 'Enable pack', (function (pid) {
            return function () { send({ type: 'integration.enablePack', packId: pid }); };
          })(pack.id));
        }
      }

      if (pack.enabled && pack.isReady && !pack.isActive) {
        var actBtn = appendAction(d, actionGroup, 'Activate', 'Activate mode', (function (pid) {
          return function () { send({ type: 'integration.activatePack', packId: pid }); };
        })(pack.id));
        actBtn.className = 'btn-approve';
      }

      pHeader.appendChild(actionGroup);
      card.appendChild(pHeader);

      var cardDesc = d.createElement('p');
      cardDesc.className = 'hub-server-desc';
      setText(cardDesc, pack.description || 'No description');
      card.appendChild(cardDesc);

      list.appendChild(card);
    }

    panel.appendChild(list);
  }

  container.appendChild(panel);
  return panel;
}

export function renderIntegrationsHub(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  if (!state) return null;
  var d = docOf(doc);
  var send = postMessage || function () {};
  container.innerHTML = '';

  var hub = d.createElement('section');
  hub.className = 'integrations-hub';
  setAttr(hub, 'aria-label', 'Visual Integration Manager');

  // Top header with title and close button
  var header = d.createElement('div');
  header.className = 'hub-header';

  var titleGroup = d.createElement('div');
  titleGroup.className = 'hub-title-group';
  var h = d.createElement('h2');
  h.className = 'hub-title';
  setText(h, 'Integrations & Account');
  titleGroup.appendChild(h);
  header.appendChild(titleGroup);

  var closeBtn = d.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-reject hub-close-btn';
  setText(closeBtn, '✕ Close');
  setAttr(closeBtn, 'aria-label', 'Close Integrations Hub and return to Chat');
  onClick(closeBtn, function () { send({ type: 'integration.closeHub' }); });
  header.appendChild(closeBtn);
  hub.appendChild(header);

  // Navigation tab bar
  var tabNav = d.createElement('nav');
  tabNav.className = 'hub-nav';
  setAttr(tabNav, 'role', 'tablist');
  setAttr(tabNav, 'aria-label', 'Integration Management Tabs');

  var tabs = [
    { id: 'profile', label: 'Profile' },
    { id: 'mcp', label: 'MCP Servers' },
    { id: 'skills', label: 'Skills' },
    { id: 'modes', label: 'Modes' },
    { id: 'packs', label: 'Capability Packs' },
    { id: 'diagnostics', label: 'Diagnostics' },
  ];

  var activeTab = (state && state.activeTab) || 'profile';

  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    var tabBtn = d.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = 'hub-tab-btn' + (activeTab === t.id ? ' is-active' : '');
    setAttr(tabBtn, 'role', 'tab');
    setAttr(tabBtn, 'aria-selected', activeTab === t.id ? 'true' : 'false');
    setAttr(tabBtn, 'id', 'tab-' + t.id);
    setText(tabBtn, t.label);
    onClick(tabBtn, (function (tid) {
      return function () { send({ type: 'integration.setTab', tab: tid }); };
    })(t.id));
    tabNav.appendChild(tabBtn);
  }
  hub.appendChild(tabNav);

  // Status message bar (if present)
  if (state.statusMessage || state.isLoading) {
    var statusBar = d.createElement('div');
    statusBar.className = 'hub-status-bar' + (state.isLoading ? ' is-loading' : '');
    setAttr(statusBar, 'role', 'status');
    setText(statusBar, (state.isLoading ? '⌛ ' : '') + (state.statusMessage || 'Loading...'));
    hub.appendChild(statusBar);
  }

  // Pending Confirmation Modal (e.g. Remove Server)
  if (state.pendingConfirmation) {
    var confCard = d.createElement('div');
    confCard.className = 'hub-confirmation-card';
    var confTitle = d.createElement('div');
    confTitle.className = 'confirmation-prompt';
    setText(confTitle, 'Are you sure you want to remove MCP server "' + state.pendingConfirmation.serverName + '"?');
    confCard.appendChild(confTitle);

    var confActions = d.createElement('div');
    confActions.className = 'confirmation-actions';
    var removeBtn = appendAction(d, confActions, 'Remove Server', 'Confirm removal of this integration', function () {
      send({ type: 'integration.executeRemoveServer', serverId: state.pendingConfirmation.serverId });
    });
    removeBtn.className = 'btn-reject';

    var cancelBtn = appendAction(d, confActions, 'Cancel', 'Cancel server removal', function () {
      send({ type: 'integration.cancelConfirmation' });
    });
    cancelBtn.className = 'btn-approve';
    confCard.appendChild(confActions);
    hub.appendChild(confCard);
  }

  // Content panel container
  var content = d.createElement('div');
  content.className = 'hub-tab-content';
  setAttr(content, 'role', 'tabpanel');
  setAttr(content, 'aria-labelledby', 'tab-' + activeTab);

  if (activeTab === 'profile') {
    renderProfileSection(content, state, d, send);
  } else if (activeTab === 'mcp') {
    renderMcpDashboard(content, state, d, send);
  } else if (activeTab === 'skills') {
    renderSkillsSection(content, state, d, send);
  } else if (activeTab === 'modes') {
    renderModesSection(content, state, d, send);
  } else if (activeTab === 'packs') {
    renderPacksSection(content, state, d, send);
  } else if (activeTab === 'diagnostics') {
    renderDiagnosticsSection(content, state, d, send);
  }

  hub.appendChild(content);
  container.appendChild(hub);
  return hub;
}

export function renderTrustNotice(container: any, state: any, doc?: any, postMessage?: (msg: any) => void): any {
  var trusted = !state || state.workspaceTrusted !== false;
  var notice = state && state.modelManager && state.modelManager.trustNotice;
  var sig = trusted ? "trusted" : "untrusted:" + (notice || "");
  if (container.__trustSig === sig && container.firstChild) return container.firstChild;
  container.__trustSig = sig;
  container.innerHTML = "";
  if (trusted) return null;
  var d = docOf(doc);
  var banner = d.createElement("div");
  banner.className = "trust-banner";
  setAttr(banner, "role", "status");
  var text = d.createElement("p");
  setText(text, notice || "This folder is not trusted. Ask can read. Agent and Debug stay unavailable until you trust the folder.");
  banner.appendChild(text);
  if (postMessage) {
    var button = d.createElement("button");
    button.type = "button";
    button.className = "secondary";
    setText(button, "Manage Workspace Trust");
    setAttr(button, "aria-label", "Manage Workspace Trust. This does not trust the folder automatically.");
    onClick(button, function () { postMessage({ type: "ui.manageTrust" }); });
    banner.appendChild(button);
  }
  container.appendChild(banner);
  return banner;
}

export function renderModelManager(container: any, snapshot: any, doc?: any, postMessage?: (msg: any) => void): any {
  var open = !!(snapshot && snapshot.open);
  var sig = open ? JSON.stringify(snapshot) : "closed";
  if (container.__modelSig === sig && (container.firstChild || !open)) return container.firstChild || null;
  container.__modelSig = sig;
  container.innerHTML = "";
  if (!open) return null;
  var d = docOf(doc);
  var panel = d.createElement("section");
  panel.className = "model-manager";
  setAttr(panel, "aria-label", "Model manager");
  var title = d.createElement("h2");
  setText(title, "Models");
  panel.appendChild(title);
  var notice = d.createElement("p");
  setText(notice, (snapshot && snapshot.notice) || "");
  panel.appendChild(notice);
  var status = d.createElement("p");
  var statusText = snapshot && snapshot.endpointError
    ? "Offline at " + snapshot.endpoint + ". " + snapshot.endpointError
    : snapshot && snapshot.endpointReachable
      ? "Connected to " + snapshot.endpoint + "."
      : "Not connected.";
  if (snapshot && snapshot.workspaceOverrideActive) statusText += " Workspace override is active.";
  if (snapshot && snapshot.workspaceOverrideIgnored) statusText += " Workspace file ignored because the folder is untrusted.";
  setText(status, statusText);
  panel.appendChild(status);
  appendManagerLine(d, panel, "Active chat model: " + ((snapshot && snapshot.chatModel) || "none"));
  appendManagerLine(d, panel, "Active autocomplete model: " + ((snapshot && snapshot.autocompleteModel) || "none"));
  appendManagerLine(d, panel, "Active endpoint: " + ((snapshot && snapshot.endpoint) || "none"));
  appendManagerLine(d, panel, routingSourceLine(snapshot));
  var overrideActive = !!(snapshot && snapshot.workspaceOverrideActive);
  if (overrideActive) {
    appendManagerLine(d, panel, "Global preferences stay saved. Changing them does not switch the active route. Use global models to suspend the override without editing the project file.");
  }
  if (snapshot && snapshot.workspaceTrusted === false && snapshot.trustNotice) {
    appendManagerLine(d, panel, snapshot.trustNotice);
  }
  var chatLabel = overrideActive ? "Global chat preference" : "Chat and Agent";
  var completeLabel = overrideActive ? "Global autocomplete preference" : "Autocomplete";
  var chatSelected = overrideActive ? snapshot && snapshot.globalChatModel : snapshot && snapshot.chatModel;
  var completeSelected = overrideActive ? snapshot && snapshot.globalAutocompleteModel : snapshot && snapshot.autocompleteModel;
  appendModelSelect(d, panel, postMessage, chatLabel, snapshot && snapshot.installedModels, chatSelected, "modelManager.setChat");
  appendModelSelect(d, panel, postMessage, completeLabel, snapshot && snapshot.installedModels, completeSelected, "modelManager.setAutocomplete");
  var endpointLabel = d.createElement("label");
  setText(endpointLabel, overrideActive ? "Global endpoint" : "Endpoint");
  var endpoint = d.createElement("input");
  endpoint.type = "text";
  endpoint.value = overrideActive ? ((snapshot && snapshot.globalEndpoint) || "") : ((snapshot && snapshot.endpoint) || "");
  setAttr(endpoint, "aria-label", "Local inference endpoint");
  endpointLabel.appendChild(endpoint);
  panel.appendChild(endpointLabel);
  appendManagerButton(d, panel, postMessage, "Save endpoint", function () {
    if (postMessage) postMessage({ type: "modelManager.setEndpoint", endpoint: endpoint.value || "" });
  });
  appendManagerButton(d, panel, postMessage, "Test connection", function () {
    if (postMessage) postMessage({ type: "modelManager.test" });
  });
  if (snapshot && snapshot.workspaceOverridePresent && snapshot.workspaceTrusted) {
    appendManagerButton(d, panel, postMessage, snapshot.workspaceOverrideActive ? "Use global models" : "Use workspace models.json", function () {
      if (postMessage) postMessage({ type: snapshot.workspaceOverrideActive ? "modelManager.suspendOverride" : "modelManager.useOverride" });
    });
  }
  appendManagerButton(d, panel, postMessage, "Open workspace file", function () {
    if (postMessage) postMessage({ type: "ui.openModelConfig" });
  });
  var advanced = d.createElement("details");
  var summary = d.createElement("summary");
  setText(summary, "Advanced routing");
  advanced.appendChild(summary);
  var advancedInput = d.createElement("textarea");
  setAttr(advancedInput, "aria-label", "Advanced routing JSON");
  advancedInput.placeholder = "Optional routing JSON. Saved globally. It does not edit the project.";
  advanced.appendChild(advancedInput);
  appendManagerButton(d, advanced, postMessage, "Save advanced routing", function () {
    if (postMessage) postMessage({ type: "modelManager.setAdvanced", text: advancedInput.value || "" });
  });
  if (snapshot && snapshot.advancedActive) {
    appendManagerButton(d, advanced, postMessage, "Clear advanced routing", function () {
      if (postMessage) postMessage({ type: "modelManager.clearAdvanced" });
    });
  }
  panel.appendChild(advanced);
  var tokenLabel = d.createElement("label");
  setText(tokenLabel, snapshot && snapshot.credentialConfigured ? "Endpoint token (stored securely)" : "Endpoint token (optional)");
  var token = d.createElement("input");
  token.type = "password";
  token.value = "";
  setAttr(token, "aria-label", "Local endpoint token. Stored in secure storage only.");
  token.placeholder = snapshot && snapshot.credentialConfigured ? "A token is already stored" : "Stored in secure storage, never in a project file";
  tokenLabel.appendChild(token);
  panel.appendChild(tokenLabel);
  appendManagerButton(d, panel, postMessage, "Save token", function () {
    if (postMessage) postMessage({ type: "modelManager.setCredential", token: token.value || "" });
  });
  appendManagerButton(d, panel, postMessage, "Close", function () {
    if (postMessage) postMessage({ type: "modelManager.close" });
  });
  container.appendChild(panel);
  return panel;
}

function routingSourceLine(snapshot: any): string {
  if (!snapshot || snapshot.workspaceTrusted === false) {
    return "Source: global. This folder is not trusted, so a workspace model file cannot redirect inference.";
  }
  if (snapshot.workspaceOverrideActive) return "Source: workspace override (active).";
  if (snapshot.workspaceConfigInvalid && snapshot.workspaceOverridePresent) {
    return "Source: global. The workspace model file is invalid and was not applied.";
  }
  if (snapshot.workspaceOverridePresent) {
    return "Source: global. The workspace override is suspended. The project file was not modified.";
  }
  if (snapshot.source === "discovered") return "Source: models discovered from the global endpoint.";
  if (snapshot.source === "none") return "Source: none. Choose a model.";
  return "Source: global.";
}

function appendManagerLine(d: any, parent: any, text: string): void {
  var line = d.createElement("p");
  setText(line, text);
  parent.appendChild(line);
}

function appendModelSelect(d: any, parent: any, postMessage: any, labelText: string, models: any, selected: any, messageType: string): void {
  var label = d.createElement("label");
  setText(label, labelText);
  var select = d.createElement("select");
  setAttr(select, "aria-label", labelText);
  var names = models || [];
  if (!names.length) {
    var empty = d.createElement("option");
    empty.value = "";
    setText(empty, "No models discovered");
    select.appendChild(empty);
    select.disabled = true;
  }
  for (var i = 0; i < names.length; i++) {
    var option = d.createElement("option");
    option.value = names[i];
    setText(option, names[i]);
    if (names[i] === selected) option.selected = true;
    select.appendChild(option);
  }
  if (postMessage) {
    select.addEventListener("change", function () {
      if (!select.value) return;
      var message: any = { type: messageType, name: select.value };
      postMessage(message);
    });
  }
  label.appendChild(select);
  parent.appendChild(label);
}

function appendManagerButton(d: any, parent: any, postMessage: any, label: string, run: () => void): void {
  var button = d.createElement("button");
  button.type = "button";
  button.className = "secondary";
  setText(button, label);
  setAttr(button, "aria-label", label);
  if (postMessage) onClick(button, run);
  parent.appendChild(button);
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
    renderOutcomeBody.toString(),
    fillMessageBody.toString(),
    messageSig.toString(),
    renderChatMessage.toString(),
    updateChatMessage.toString(),
    syncTranscript.toString(),
    activityCategory.toString(),
    activityGroupStatus.toString(),
    outcomeTitle.toString(),
    activityFiles.toString(),
    fileCountPhrase.toString(),
    groupRetryNote.toString(),
    groupTitle.toString(),
    groupDetail.toString(),
    pushActivityGroup.toString(),
    summarizeActivities.toString(),
    compressTrivialTimeline.toString(),
    renderActivityTimeline.toString(),
    renderContextChips.toString(),
    renderConnectionStatus.toString(),
    renderTrustNotice.toString(),
    renderModelManager.toString(),
    routingSourceLine.toString(),
    appendManagerLine.toString(),
    appendModelSelect.toString(),
    appendManagerButton.toString(),
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
    renderProfileSection.toString(),
    renderMcpDashboard.toString(),
    renderAddMcpWizard.toString(),
    renderToolInspector.toString(),
    renderSkillsSection.toString(),
    renderModeWizard.toString(),
    renderModeInspector.toString(),
    renderModesSection.toString(),
    renderPackInspector.toString(),
    renderPacksSection.toString(),
    renderDiagnosticsSection.toString(),
    renderIntegrationsHub.toString(),
  ].join("\n");
}
