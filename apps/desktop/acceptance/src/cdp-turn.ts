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
  readonly frame?: string
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
    return { role: role, text: ((body && body.textContent) || "").trim() };
  });
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
  const foreignAbsolute = (note, workspace) => {
    const matches = String(note || "").match(/(^|\\s)(\\/[^\\s]+)/g) || [];
    for (let index = 0; index < matches.length; index += 1) {
      const token = matches[index].trim();
      if (token.length < 2) continue;
      if (!workspace) return true;
      if (token !== workspace && token.indexOf(workspace + "/") !== 0) return true;
    }
    return false;
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
      if ((op.decision === "approve" || op.decision === "reject") && !approvalBlocked) {
        const button = doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject");
        const visible = !!(button && !button.disabled && button.getClientRects && button.getClientRects().length > 0);
        if (visible) {
          const actions = button.closest ? button.closest(".confirmation-actions") : null;
          const card = actions && actions.parentElement ? actions.parentElement : button.parentElement;
          const note = ((card && (card.innerText || card.textContent)) || "").trim().slice(0, 500);
          if (note !== lastDecisionText) {
            if (approvalClicks + rejectionClicks >= 4) {
              approvalBlocked = true;
              return finish({ reason: "approval cap" });
            }
            if (note.indexOf("../") !== -1 || note.indexOf("..\\\\") !== -1 || foreignAbsolute(note, String(op.workspace || ""))) {
              approvalBlocked = true;
              approvalNotes.push(note);
              return finish({ reason: "confirmation path is outside the fixture" });
            }
            button.click();
            if (op.decision === "approve") approvalClicks += 1;
            else rejectionClicks += 1;
            approvalNotes.push(note);
            lastDecisionText = note;
            holdForRun = true;
            sawRunningAfterDecision = false;
            stable = 0;
          }
        }
      }
      if (holdForRun && running) sawRunningAfterDecision = true;
      if (holdForRun && sawRunningAfterDecision && !running) holdForRun = false;
      const decisionVisible = !!((op.decision === "approve" || op.decision === "reject") && doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject") && !doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject").disabled && doc.getElementById(op.decision === "approve" ? "btn-approve" : "btn-reject").getClientRects().length > 0);
      const settled = userCount === 1 && assistant && !running && !holdForRun && !decisionVisible && /ready/i.test(readyText);
      stable = settled ? stable + 1 : 0;
      if (stable >= 2) return finish();
    }, 200);
  });
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
