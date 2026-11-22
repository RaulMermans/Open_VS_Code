import type { ElectronApplication } from "playwright-core"
import type { ChatMessage } from "./oracles.ts"

export type GuestOp =
  | { readonly op: "read"; readonly selector: string }
  | { readonly op: "messages" }
  | { readonly op: "fill"; readonly selector: string; readonly value: string }
  | { readonly op: "submit"; readonly value: string; readonly timeoutMs?: number }
  | { readonly op: "click"; readonly selector: string }
  | { readonly op: "select"; readonly selector: string; readonly value: string }
  | { readonly op: "press"; readonly selector: string; readonly key: string }

export interface GuestRead {
  readonly found: boolean
  readonly present?: boolean
  readonly visible?: boolean
  readonly text?: string
  readonly value?: string
  readonly ok?: boolean
  readonly messages?: ChatMessage[]
}

/**
 * Runs inside the webview guest. It is a string so the Electron main process
 * can pass it to executeJavaScript without Playwright attaching to the OOPIF.
 */
export const GUEST_RUNTIME = `function guest(op) {
  const composer = document.getElementById("composer");
  if (!composer) return { found: false };
  const visible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  };
  if (op.op === "messages") {
    const messages = Array.from(document.querySelectorAll(".message")).map((node) => {
      const role = node.classList.contains("assistant")
        ? "assistant"
        : node.classList.contains("user")
          ? "user"
          : "other";
      const body = node.querySelector(".message-body");
      return { role, text: ((body && body.textContent) || "").trim() };
    });
    return { found: true, messages };
  }
  if (op.op === "submit") {
    const send = document.getElementById("send-btn");
    if (!send) return { found: true, ok: false, text: "missing-send" };
    const collect = () => Array.from(document.querySelectorAll(".message")).map((node) => {
      const role = node.classList.contains("assistant")
        ? "assistant"
        : node.classList.contains("user")
          ? "user"
          : "other";
      const body = node.querySelector(".message-body");
      return { role: role, text: ((body && body.textContent) || "").trim() };
    });
    composer.value = op.value;
    if (typeof composer.selectionStart === "number") {
      composer.selectionStart = composer.value.length;
      composer.selectionEnd = composer.value.length;
    }
    send.click();
    const timeoutMs = typeof op.timeoutMs === "number" ? op.timeoutMs : 20000;
    const needle = String(op.value || "").trim();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const messages = collect();
        let assistant = "";
        let seenUser = false;
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          if (!seenUser && message.role === "user" && message.text.indexOf(needle) !== -1) {
            seenUser = true;
            assistant = "";
            continue;
          }
          if (seenUser && message.role === "assistant") assistant += message.text;
          if (seenUser && message.role === "user") break;
        }
        const cancel = document.getElementById("cancel-btn");
        const running = !!(cancel && cancel.getClientRects().length > 0);
        const elapsed = Date.now() - started;
        if ((seenUser && assistant && !running) || elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve({
            found: true,
            ok: true,
            value: composer.value,
            messages: messages,
            text: assistant,
            timedOut: elapsed >= timeoutMs && !assistant,
          });
        }
      }, 200);
    });
  }
  if (op.op === "fill") {
    const el = op.selector.charAt(0) === "#" ? document.getElementById(op.selector.slice(1)) : document.querySelector(op.selector);
    if (!el) return { found: true, ok: false, text: "missing-target" };
    el.value = op.value;
    if (typeof el.selectionStart === "number") {
      el.selectionStart = el.value.length;
      el.selectionEnd = el.value.length;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { found: true, ok: true, value: el.value };
  }
  if (op.op === "click") {
    const el = document.querySelector(op.selector);
    if (!el) return { found: true, ok: false };
    el.click();
    return { found: true, ok: true, value: composer.value };
  }
  if (op.op === "select") {
    const el = document.querySelector(op.selector);
    if (!el) return { found: true, ok: false };
    el.value = op.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { found: true, ok: true, value: el.value };
  }
  if (op.op === "press") {
    const el = document.querySelector(op.selector);
    if (!el) return { found: true, ok: false };
    if (op.key === "Shift+Enter") {
      const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
      el.value = el.value.slice(0, start) + "\\n" + el.value.slice(end);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { found: true, ok: true, value: el.value };
    }
    el.dispatchEvent(new KeyboardEvent("keydown", { key: op.key, bubbles: true }));
    return { found: true, ok: true, value: el.value };
  }
  const el = document.querySelector(op.selector);
  if (!el) return { found: true, present: false, visible: false, text: "", value: "" };
  return {
    found: true,
    present: true,
    visible: visible(el),
    text: el.innerText || el.textContent || "",
    value: "value" in el ? String(el.value) : "",
  };
}`

export async function queryGuest(app: ElectronApplication, op: GuestOp): Promise<GuestRead | null> {
  try {
    // The callback is sent to Electron as source text. It must stay plain JavaScript.
    const result = await app.evaluate(async (electron, payload) => {
      const contents = electron.webContents.getAllWebContents()
      const notes = []
      const frames = []
      const stack = []
      for (let index = 0; index < contents.length; index += 1) {
        try {
          if (contents[index].mainFrame) stack.push(contents[index].mainFrame)
        } catch (error) {
          notes.push(error && error.message ? error.message : String(error))
        }
      }
      while (stack.length > 0) {
        const frame = stack.pop()
        frames.push(frame)
        const children = frame.frames || []
        for (let child = 0; child < children.length; child += 1) stack.push(children[child])
      }
      let webviewFrames = 0
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]
        let url = ""
        try {
          url = String(frame.url || "")
        } catch (error) {
          url = ""
        }
        if (url.indexOf("vscode-webview:") === 0) webviewFrames += 1
        try {
          const value = await frame.executeJavaScript("(" + payload.source + ")(" + JSON.stringify(payload.op) + ")")
          if (value && value.found) return value
        } catch (error) {
          if (url.indexOf("vscode-webview:") === 0) {
            notes.push((error && error.message ? error.message : String(error)).slice(0, 180))
          }
        }
      }
      return {
        found: false,
        guestCount: contents.length,
        frameCount: frames.length,
        webviewFrames: webviewFrames,
        notes: notes.slice(0, 6),
      }
    }, { source: GUEST_RUNTIME, op })
    if (result && result.found === false) {
      const notes = Array.isArray(result.notes) ? result.notes.join(" | ") : ""
      return {
        found: false,
        text: `guests=${result.guestCount ?? 0} frames=${result.frameCount ?? 0} webviews=${result.webviewFrames ?? 0} ${notes}`.trim(),
      }
    }
    return result
  } catch (error) {
    return { found: false, text: error instanceof Error ? error.message : String(error) }
  }
}
