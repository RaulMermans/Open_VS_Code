/**
 * Lightweight deterministic DOM test harness for exercising the shared production
 * `browser-panel-render-helpers.ts` functions in Node tests without external dependencies.
 */

export class FakeDomElement {
  public readonly tagName: string;
  public className = "";
  public id = "";
  public type = "";
  public placeholder = "";
  public value = "";
  public disabled = false;
  public checked = false;
  public readonly style: Record<string, string> = {};
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(ev?: any) => void>>();
  public children: FakeDomElement[] = [];
  #textContent = "";
  public innerHtmlSetCount = 0;
  public nonEmptyInnerHtmlAttempted = false;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get textContent(): string {
    if (this.children.length === 0) {
      return this.#textContent;
    }
    return this.#textContent + this.children.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    this.children = [];
    this.#textContent = val == null ? "" : String(val);
  }

  get innerHTML(): string {
    return "";
  }

  set innerHTML(val: string) {
    this.innerHtmlSetCount += 1;
    if (val !== "") {
      this.nonEmptyInnerHtmlAttempted = true;
    }
    this.children = [];
    this.#textContent = "";
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeDomElement): FakeDomElement {
    this.children.push(child);
    return child;
  }

  addEventListener(event: string, cb: (ev?: any) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  click(): void {
    if (this.disabled) return;
    for (const cb of this.listeners.get("click") ?? []) {
      cb({});
    }
  }

  findAll(predicate: (el: FakeDomElement) => boolean): FakeDomElement[] {
    const out: FakeDomElement[] = [];
    const visit = (node: FakeDomElement) => {
      if (predicate(node)) out.push(node);
      for (const child of node.children) visit(child);
    };
    visit(this);
    return out;
  }
}

export class FakeDomDocument {
  public activeElement: FakeDomElement | null = null;
  public readonly createdElements: FakeDomElement[] = [];

  createElement(tagName: string): FakeDomElement {
    const el = new FakeDomElement(tagName);
    this.createdElements.push(el);
    return el;
  }
}
