import { classifySendAck, turnReplyText, type ChatMessage, type SendAck } from "./oracles.ts"

export interface CdpTurnRaw {
  readonly found?: boolean
  readonly taskId?: string
  readonly reason?: string
  readonly sendClicks?: number
  readonly approvalClicks?: number
  readonly rejectionClicks?: number
  readonly composerValue?: string
  readonly messages?: ChatMessage[]
  readonly userCount?: number
  readonly assistant?: string
  readonly running?: boolean
  readonly timedOut?: boolean
  readonly model?: string
  readonly mode?: string
  readonly readyText?: string
  readonly approvalNotes?: string[]
  readonly approvalBlocked?: boolean
  readonly activities?: readonly string[]
  readonly frame?: string
  readonly confirmationId?: string
}

export interface InterpretedTurn {
  readonly ack: SendAck
  readonly assistant: string
  readonly userCount: number
  readonly sendClicks: number
  readonly problems: string[]
}

/**
 * Runs in the webview host document, the iframe whose URL contains index.html.
 * The inner Agent page is `#active-frame`'s contentDocument. One evaluation
 * clicks Send at most once.
 */
/** Edit, test, and one repair round. A repeated card still stops the turn. */
const MAX_FIXTURE_CONFIRMATIONS = 8

export const CDP_TURN_RUNTIME = `function cdpTurn(op) {
  const frame = document.getElementById("active-frame");
  const doc = frame && frame.contentDocument;
  if (!doc) {
    return { found: false, taskId: "", reason: "active-frame contentDocument unavailable", sendClicks: 0, messages: [] };
  }
  const composer = doc.getElementById("composer");
  const send = doc.getElementById("send-btn");
  const model = doc.getElementById("model-selector");
  const mode = doc.getElementById("mode-selector");
  const status = doc.getElementById("connection-status");
  if (!composer || !send) {
    return { found: false, taskId: op.taskId || "", reason: "composer missing", sendClicks: 0, messages: [] };
  }
  const collect = () => Array.from(doc.querySelectorAll(".message")).map((node) => {
    const role = node.classList.contains("assistant")
      ? "assistant"
      : node.classList.contains("user")
        ? "user"
        : "other";
    const body = node.querySelector(".message-body");
    const statusMatch = String(node.className || "").match(/is-(failed|completed|rejected|cancelled)/);
    return { role: role, text: ((body && body.textContent) || "").trim(), status: statusMatch ? statusMatch[1] : "" };
  });
  const readCard = () => {
    const card = doc.querySelector(".confirmation-card");
    if (!card) return null;
    const rows = {};
    const rowNodes = card.querySelectorAll(".terminal-row");
    for (let index = 0; index < rowNodes.length; index += 1) {
      const row = rowNodes[index];
      const labelNode = row.querySelector(".terminal-row-label");
      const valueNode = row.querySelector(".terminal-row-value");
      const label = ((labelNode && labelNode.textContent) || "").trim();
      const value = ((valueNode && valueNode.textContent) || "").trim();
      if (label) rows[label] = value;
    }
    const commandNode = card.querySelector(".terminal-command-box");
    const command = ((commandNode && commandNode.textContent) || "").trim();
    const summary = ((card.innerText || "")).trim();
    const marked = summary.match(/\\((patch|create|delete|command)\\)/i);
    const operation = card.getAttribute("data-operation")
      || (marked ? marked[1].toLowerCase() : "")
      || (rows["New file"] ? "create" : "")
      || (rows["File"] ? "patch" : "")
      || (command ? "command" : "");
    const path = card.getAttribute("data-path") || rows["File"] || rows["New file"] || "";
    const id = card.getAttribute("data-confirmation-id") || path || command;
    return {
      id: id,
      kind: command || operation === "command" ? "command" : path ? "mutation" : "unknown",
      operation: operation,
      path: path,
      cwd: card.getAttribute("data-cwd") || rows["Directory"] || "",
      executable: rows["Executable"] || "",
      args: rows["Arguments"] || "",
      command: command,
    };
  };
  window.__ovscLab = window.__ovscLab || { pending: null, permit: null };
  const prompt = String(op.prompt || "");
  const countUsers = (messages) => messages.filter((message) => message.role === "user" && message.text.indexOf(prompt) !== -1).length;
  const assistantFor = (messages) => {
    let seen = false;
    const parts = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!seen && message.role === "user" && message.text.indexOf(prompt) !== -1) {
        seen = true;
        continue;
      }
      if (!seen) continue;
      if (message.role === "user") break;
      if (message.role === "assistant" || message.role === "other") parts.push(message.text);
    }
    return parts.join("\\n");
  };
  return new Promise((resolve) => {
    const started = Date.now();
    let sendClicks = 0;
    let approvalClicks = 0;
    let rejectionClicks = 0;
    let phase = "prepare";
    let approvalBlocked = false;
    const approvalNotes = [];
    let lastDecisionText = "";
    let holdForRun = false;
    let sawRunningAfterDecision = false;
    let sawRunningAfterContinue = false;
    let stable = 0;
    let modeAttempts = 0;
    const timeoutMs = typeof op.timeoutMs === "number" ? op.timeoutMs : 20000;
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      const messages = collect();
      const userCount = countUsers(messages);
      const assistant = assistantFor(messages);
      const cancel = doc.getElementById("cancel-btn");
      const running = !!(cancel && cancel.getClientRects && cancel.getClientRects().length > 0);
      const readyText = status ? (status.innerText || status.textContent || "") : "Ready";
      const finish = (extra) => {
        clearInterval(timer);
        resolve(Object.assign({
          found: true,
          taskId: op.taskId || "",
          sendClicks: sendClicks,
          approvalClicks: approvalClicks,
          rejectionClicks: rejectionClicks,
          composerValue: String(composer.value || ""),
          messages: messages,
          userCount: userCount,
          assistant: assistant,
          running: running,
          timedOut: elapsed >= timeoutMs && !assistant,
          model: model ? String(model.value || "") : "",
          mode: mode ? String(mode.value || "") : "",
          readyText: readyText,
          approvalNotes: approvalNotes,
          approvalBlocked: approvalBlocked,
          activities: Array.from(doc.querySelectorAll(".activity-label")).map((node) => (node.textContent || "").trim()).filter(Boolean).slice(0, 40),
          frame: "active-frame",
        }, extra || {}));
      };
      if (userCount > 1) return finish({ reason: "duplicate user turn" });
      if (elapsed >= timeoutMs) return finish({ reason: assistant ? "" : "timed out waiting for the assistant reply" });
      if (phase === "prepare") {
        if (status && !/ready/i.test(readyText)) return;
        if (model && op.model) {
          const options = Array.from(model.options || []);
          if (!options.some((option) => option.value === op.model)) {
            return finish({ reason: "model option missing" });
          }
          if (model.value !== op.model) {
            model.value = op.model;
            model.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
        if (mode && op.mode && op.mode !== "NONE" && mode.value !== op.mode) {
          const modeOption = Array.from(mode.options || []).find((option) => option.value === op.mode);
          if (!modeOption) return finish({ reason: "mode option missing" });
          if (modeOption.disabled) return finish({ reason: "mode " + op.mode + " is disabled until the folder is trusted" });
          modeAttempts += 1;
          if (modeAttempts > 3) return finish({ reason: "mode did not stay on " + op.mode });
          mode.value = op.mode;
          mode.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (op.continueRun) {
          const continueBtn = doc.querySelector(".btn-continue-run");
          if (!continueBtn || !continueBtn.getClientRects || !continueBtn.getClientRects().length) {
            return finish({ reason: "Continue this run was not visible" });
          }
          continueBtn.click();
          sendClicks += 1;
          phase = "wait";
          return;
        }
        if (userCount === 1) return finish({ reason: "user turn already present" });
        composer.value = prompt;
        if (typeof composer.selectionStart === "number") {
          composer.selectionStart = composer.value.length;
          composer.selectionEnd = composer.value.length;
        }
        sendClicks += 1;
        send.click();
        phase = "wait";
        return;
      }
      if (op.decision === "hold") {
        const diff = doc.getElementById("btn-diff");
        const approve = doc.getElementById("btn-approve");
        const card = doc.querySelector(".confirmation-card");
        const diffVisible = !!(diff && diff.getClientRects && diff.getClientRects().length > 0);
        const approveVisible = !!(approve && !approve.disabled && approve.getClientRects && approve.getClientRects().length > 0);
        if (diffVisible || approveVisible || card) {
          return finish({ reason: "confirmation visible", confirmationId: card && card.getAttribute("data-confirmation-id") || "" });
        }
        return;
      }
      if (op.decision === "none") {
        const reject = doc.getElementById("btn-reject");
        const rejectVisible = !!(reject && !reject.disabled && reject.getClientRects && reject.getClientRects().length > 0);
        if (rejectVisible) {
          const card = readCard();
          const cardId = card && card.id ? card.id : "reject";
          if (lastDecisionText !== cardId) {
            reject.click();
            rejectionClicks += 1;
            approvalNotes.push("rejected because this scenario does not approve");
            lastDecisionText = cardId;
            holdForRun = true;
            sawRunningAfterDecision = false;
            stable = 0;
          }
        }
      }
      if ((op.decision === "approve" || op.decision === "reject") && !approvalBlocked) {
        const button = doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject");
        const visible = !!(button && !button.disabled && button.getClientRects && button.getClientRects().length > 0);
        if (visible) {
          const card = readCard();
          if (card && card.id) {
            window.__ovscLab.pending = card;
            const permit = window.__ovscLab.permit;
            if (permit && permit.id === card.id && permit.action === op.decision) {
              if (!permit.allow) {
                approvalBlocked = true;
                approvalNotes.push(card.path || card.command || card.id);
                return finish({ reason: permit.reason || "confirmation was not fixture-scoped" });
              }
              if (lastDecisionText !== card.id) {
                if (approvalClicks + rejectionClicks >= ${MAX_FIXTURE_CONFIRMATIONS}) {
                  approvalBlocked = true;
                  return finish({ reason: "approval cap" });
                }
                button.click();
                if (op.decision === "approve") approvalClicks += 1;
                else rejectionClicks += 1;
                approvalNotes.push(permit.reason || card.path || card.id);
                lastDecisionText = card.id;
                window.__ovscLab.permit = null;
                holdForRun = true;
                sawRunningAfterDecision = false;
                stable = 0;
              }
            }
          }
        }
      }
      if (holdForRun && running) sawRunningAfterDecision = true;
      if (holdForRun && sawRunningAfterDecision && !running) holdForRun = false;
      if (op.continueRun && running) sawRunningAfterContinue = true;
      const decisionVisible = !!((op.decision === "approve" || op.decision === "reject") && doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject") && !doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject").disabled && doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject").getClientRects().length > 0);
      const settled = op.continueRun
        ? sawRunningAfterContinue && !running && !holdForRun && !decisionVisible && /ready/i.test(readyText)
        : userCount === 1 && assistant && !running && !holdForRun && !decisionVisible && /ready/i.test(readyText);
      stable = settled ? stable + 1 : 0;
      if (stable >= 2) return finish();
    }, 200);
  });
}`

export interface AgentSurfaceSnapshot {
  readonly found: boolean
  readonly kind?: "sidebar" | "wide" | "unknown"
  readonly reason?: string
  readonly composerVisible?: boolean
  readonly composerValue?: string
  readonly wideButtonVisible?: boolean
  readonly historyOpen?: boolean
  readonly historyItems?: readonly { readonly label: string; readonly current: boolean }[]
  readonly messages?: ChatMessage[]
  readonly activities?: readonly string[]
  readonly activityStatuses?: readonly string[]
  readonly trace?: readonly string[]
  readonly technicalOpen?: boolean
  readonly confirmationId?: string
  readonly confirmationPath?: string
  readonly diffVisible?: boolean
  readonly approveVisible?: boolean
  readonly rejectVisible?: boolean
  readonly continueVisible?: boolean
  readonly bodyText?: string
  readonly reviews?: readonly string[]
  readonly outcomeVisible?: boolean
  readonly outcomeText?: string
  readonly modelsVisible?: boolean
}

/**
 * Read or click Agent UI in the webview host document. Clicks real controls.
 * Does not call ChatController methods.
 */
export const CDP_SURFACE_RUNTIME = `function cdpSurface(op) {
  const frame = document.getElementById("active-frame");
  const doc = frame && frame.contentDocument;
  if (!doc) return { found: false, reason: "active-frame contentDocument unavailable" };
  const visible = (el) => !!(el && el.getClientRects && el.getClientRects().length > 0);
  const composer = doc.getElementById("composer");
  const wideBtn = doc.getElementById("wide-chat-btn");
  const historyBtn = doc.getElementById("history-btn");
  const historyPanel = doc.getElementById("history-panel");
  const kind = doc.body && doc.body.classList.contains("wide-chat") ? "wide" : "sidebar";
  const collectMessages = () => Array.from(doc.querySelectorAll(".message")).map((node) => {
    const role = node.classList.contains("assistant")
      ? "assistant"
      : node.classList.contains("user")
        ? "user"
        : "other";
    const body = node.querySelector(".message-body");
    const statusMatch = String(node.className || "").match(/is-(failed|completed|rejected|cancelled)/);
    return { role: role, text: ((body && body.textContent) || "").trim(), status: statusMatch ? statusMatch[1] : "" };
  });
  const snapshot = () => {
    const card = doc.querySelector(".confirmation-card");
    const approve = doc.getElementById("btn-approve");
    const reject = doc.getElementById("btn-reject");
    const diff = doc.getElementById("btn-diff");
    const models = doc.getElementById("models-btn");
    const outcome = doc.querySelector(".outcome-card");
    const trace = doc.querySelector(".activity-trace");
    const historyItems = Array.from(doc.querySelectorAll(".history-open")).map((node) => ({
      label: String(node.getAttribute("aria-label") || node.textContent || "").trim(),
      current: node.getAttribute("aria-current") === "true",
    }));
    return {
      found: true,
      kind: kind,
      composerVisible: visible(composer),
      composerValue: composer ? String(composer.value || "") : "",
      wideButtonVisible: visible(wideBtn),
      historyOpen: !!(historyPanel && !historyPanel.hidden),
      historyItems: historyItems,
      messages: collectMessages(),
      activities: Array.from(doc.querySelectorAll(".activity-summary .activity-label")).map((node) => (node.textContent || "").trim()).filter(Boolean).slice(0, 40),
      activityStatuses: Array.from(doc.querySelectorAll(".activity-summary .activity-item")).map((node) => {
        const match = String(node.className || "").match(/is-([a-z-]+)/);
        return match ? match[1] : "";
      }),
      trace: Array.from(doc.querySelectorAll(".activity-list .activity-label")).map((node) => (node.textContent || "").trim()).filter(Boolean).slice(0, 80),
      technicalOpen: !!(trace && trace.open),
      confirmationId: card ? String(card.getAttribute("data-confirmation-id") || "") : "",
      confirmationPath: card ? String(card.getAttribute("data-path") || "") : "",
      diffVisible: visible(diff),
      approveVisible: visible(approve) && !(approve && approve.disabled),
      rejectVisible: visible(reject) && !(reject && reject.disabled),
      modelsVisible: visible(models),
      outcomeVisible: visible(outcome),
      outcomeText: outcome ? String(outcome.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500) : "",
      bodyText: String((doc.body && doc.body.innerText) || "").slice(0, 4000),
      reviews: Array.from(doc.querySelectorAll(".review-item")).map((node) => String(node.textContent || "").replace(/\\s+/g, " ").trim()).slice(0, 20),
      continueVisible: visible(doc.querySelector(".btn-continue-run")),
    };
  };
  if (op.op === "snapshot") return snapshot();
  if (op.op === "fill" && composer) {
    composer.focus();
    composer.value = String(op.value || "");
    if (typeof composer.selectionStart === "number") {
      composer.selectionStart = composer.value.length;
      composer.selectionEnd = composer.value.length;
    }
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return snapshot();
  }
  if (op.op === "click") {
    const node = op.selector ? doc.querySelector(op.selector) : null;
    if (!node) return Object.assign(snapshot(), { found: false, reason: "missing " + (op.selector || "") });
    node.click();
    return snapshot();
  }
  if (op.op === "historyOpen") {
    if (!historyBtn) return Object.assign(snapshot(), { found: false, reason: "missing history control" });
    if (historyPanel && historyPanel.hidden) historyBtn.click();
    return snapshot();
  }
  if (op.op === "historySelect") {
    const needle = String(op.value || "");
    const items = Array.from(doc.querySelectorAll(".history-open"));
    const match = items.find((node) => String(node.getAttribute("aria-label") || node.textContent || "").indexOf(needle) !== -1);
    if (!match) return Object.assign(snapshot(), { found: false, reason: "history item not listed" });
    match.click();
    return snapshot();
  }
  return snapshot();
}`

export function confirmationAllowed(note: string, workspace: string): boolean {
  if (note.includes("../") || note.includes("..\\")) return false
  const matches = note.match(/(^|\s)(\/[^\s]+)/g) ?? []
  for (const raw of matches) {
    const token = raw.trim()
    if (token.length < 2) continue
    if (!workspace) return false
    if (token !== workspace && !token.startsWith(`${workspace}/`)) return false
  }
  return true
}

export function interpretCdpTurn(input: {
  readonly taskId: string
  readonly prompt: string
  readonly workspace: string
  readonly raw: CdpTurnRaw
}): InterpretedTurn {
  const messages = input.raw.messages ?? []
  const users = messages
    .filter((message) => message.role === "user" && message.text.includes(input.prompt.trim()))
    .map((message) => message.text)
  const sendClicks = input.raw.sendClicks ?? 0
  const ack = input.raw.found === false && sendClicks === 0
    ? "not_attempted"
    : classifySendAck({
      prompt: input.prompt,
      composerValue: input.raw.composerValue ?? "",
      userMessages: users,
      sendClicked: sendClicks > 0,
      clickError: input.raw.reason,
    })
  const problems: string[] = []
  if ((input.raw.taskId ?? "") !== input.taskId) problems.push(`task id mismatch: ${input.raw.taskId || "missing"}`)
  if (sendClicks > 1) problems.push(`send clicked ${sendClicks} times`)
  if (users.length > 1) problems.push(`duplicate user turn (${users.length})`)
  if (ack === "acknowledged" && users.length !== 1) problems.push(`expected one user turn, saw ${users.length}`)
  if (input.raw.timedOut && !turnReplyText(messages, input.prompt)) {
    problems.push("timed out before the assistant reply")
  }
  for (const note of input.raw.approvalNotes ?? []) {
    if (!confirmationAllowed(note, input.workspace)) problems.push("confirmation was not fixture-scoped")
  }
  if (input.raw.approvalBlocked) problems.push(input.raw.reason || "approval blocked")
  return {
    ack,
    assistant: turnReplyText(messages, input.prompt),
    userCount: users.length,
    sendClicks,
    problems,
  }
}

export function debuggerBindProblems(addresses: readonly string[]): string[] {
  if (addresses.length === 0) return ["debug port is not listening"]
  const loopback = new Set(["127.0.0.1", "::1"])
  if (addresses.some((address) => !loopback.has(address))) return ["debug port is not limited to loopback"]
  return []
}

export function assertLocalDebuggerUrl(raw: string): URL {
  const url = new URL(raw)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (url.protocol !== "ws:" && url.protocol !== "http:") {
    throw new Error(`Debug endpoint must be a local ws or http URL: ${url.protocol}`)
  }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Debug endpoint is not loopback: ${host}`)
  }
  return url
}
