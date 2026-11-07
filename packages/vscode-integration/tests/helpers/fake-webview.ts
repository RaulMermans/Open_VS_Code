// Sprint 7D — a small fake DOM that runs the real generated chat page script.
// It counts DOM work (elements created, listeners added, scroll writes, layout
// reads) and tracks focus, so tests and the IDE performance bench can measure
// redundant rendering. It is not Chromium: timings from it are labelled mock-DOM.

export interface DomCounters {
  created: number;
  listenersAdded: number;
  scrollWrites: number;
  layoutReads: number;
}

export class FakeElement {
  textContent = "";
  className = "";
  type = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  open = false;
  id = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  parentNode: FakeElement | null = null;
  [key: string]: any;
  private _scrollTop = 0;

  constructor(public tagName: string, private readonly dom: FakeDom) {}

  get scrollTop() { return this._scrollTop; }
  set scrollTop(v: number) { this.dom.counters.scrollWrites++; this._scrollTop = v; }
  get scrollHeight() { this.dom.counters.layoutReads++; return this.children.length * 100 + 400; }
  get clientHeight() { this.dom.counters.layoutReads++; return 400; }
  set innerHTML(v: string) { if (v === "") this.clear(); }
  get innerHTML() { return ""; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get isConnected() { return this.dom.body.contains(this); }
  private clear() { for (const c of this.children) c.parentNode = null; this.children = []; }
  appendChild(c: FakeElement) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeElement, ref: FakeElement | null) {
    if (!ref) return this.appendChild(c);
    if (c.parentNode) c.parentNode.removeChild(c);
    const at = this.children.indexOf(ref);
    c.parentNode = this;
    this.children.splice(at < 0 ? this.children.length : at, 0, c);
    return c;
  }
  removeChild(c: FakeElement) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...nodes: FakeElement[]) { this.clear(); for (const n of nodes) this.appendChild(n); }
  setAttribute(n: string, v: string) { this.attrs[n] = String(v); }
  getAttribute(n: string) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
  removeAttribute(n: string) { delete this.attrs[n]; }
  hasAttribute(n: string) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
  addEventListener(t: string, fn: Function) { this.dom.counters.listenersAdded++; (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t: string, fn: Function) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== fn); }
  contains(other: FakeElement | null) {
    for (let p = other; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  fire(t: string, extra: Record<string, unknown> = {}) {
    const ev: any = { type: t, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of this.listeners[t] || []) fn(ev);
    if (t === "keydown") for (let p = this.parentNode; p; p = p.parentNode) for (const fn of p.listeners[t] || []) fn(ev);
    return ev;
  }
  click() { this.fire("click"); }
  focus() { this.dom.focus(this); }
  blur() { if (this.dom.active === this) this.dom.active = null; }
}

export class FakeDom {
  readonly counters: DomCounters = { created: 0, listenersAdded: 0, scrollWrites: 0, layoutReads: 0 };
  readonly body: FakeElement;
  readonly byId: Record<string, FakeElement> = {};
  readonly focusTrail: FakeElement[] = [];
  active: FakeElement | null = null;

  constructor() {
    this.body = new FakeElement("body", this);
  }

  createElement(tag: string) { this.counters.created++; return new FakeElement(tag, this); }
  getElementById(id: string) { return this.byId[id] || null; }
  focus(el: FakeElement) { this.active = el; this.focusTrail.push(el); }
  /** Like a real DOM: a focused element that was removed no longer holds focus. */
  get activeElement() { return this.active && this.body.contains(this.active) ? this.active : this.body; }
  resetCounters() { for (const k of Object.keys(this.counters) as (keyof DomCounters)[]) this.counters[k] = 0; }
}

export function walk(el: FakeElement, out: FakeElement[] = []): FakeElement[] {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

/** Listeners currently attached to elements reachable from the page. */
export function liveListenerCount(dom: FakeDom): number {
  let n = 0;
  for (const el of walk(dom.body)) for (const list of Object.values(el.listeners)) n += list.length;
  return n;
}

// Under tsx (keepNames) the stringified helpers call __name; the esbuild production bundle does not.
const keepName = (fn: unknown) => fn;

export interface BootedWebview {
  dom: FakeDom;
  byId: Record<string, FakeElement>;
  posted: any[];
  deliver(message: unknown): void;
  intervals: number;
  savedState: () => any;
}

/** Runs the page script from ChatViewProvider's HTML against the fake DOM. */
export function bootChatWebview(html: string): BootedWebview {
  const match = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html);
  if (!match) throw new Error("page script not found");
  const dom = new FakeDom();
  const ids = Array.from(html.matchAll(/id="([^"]+)"/g)).map((m) => m[1]);
  for (const id of ids) {
    const tag = id === "composer" ? "textarea" : id.endsWith("-filter") ? "input" : id.endsWith("-btn") ? "button" : id === "mode-selector" || id === "model-selector" ? "select" : "div";
    const el = new FakeElement(tag, dom);
    el.id = id;
    dom.byId[id] = el;
    dom.body.appendChild(el);
  }
  if (dom.byId["history-panel"]) {
    dom.byId["history-panel"].hidden = true;
    if (dom.byId["history-list"]) dom.byId["history-panel"].appendChild(dom.byId["history-list"]);
    if (dom.byId["history-filter"]) dom.byId["history-panel"].appendChild(dom.byId["history-filter"]);
  }
  const posted: any[] = [];
  const handlers: Function[] = [];
  let saved: any;
  let intervals = 0;
  const win = { addEventListener: (t: string, fn: Function) => { if (t === "message") handlers.push(fn); } };
  const api = { postMessage: (m: any) => posted.push(m), getState: () => saved, setState: (s: any) => { saved = s; } };
  const doc = dom;
  new Function("document", "window", "acquireVsCodeApi", "setInterval", "clearInterval", "__name", match[1])(
    doc, win, () => api, () => ++intervals, () => {}, keepName,
  );
  return {
    dom,
    byId: dom.byId,
    posted,
    deliver(message: unknown) { for (const fn of handlers) fn({ data: message }); },
    get intervals() { return intervals; },
    savedState: () => saved,
  };
}
