// Sprint 7D — a TextDocument stand-in that follows VS Code's extension-host
// document model: text is held as lines, getText(range) joins the lines it
// spans, offsets count the EOL characters, and positionAt/offsetAt clamp.

export class Pos {
  constructor(public line: number, public character: number) {}
}

export class Rng {
  constructor(public start: Pos, public end: Pos) {}
}

export class MockTextDocument {
  readonly lines: string[];
  readonly eol: string;
  private readonly lineStarts: number[];
  readonly uri: { toString: () => string; fsPath: string };
  /** Characters copied out by getText, to compare extraction strategies. */
  charsCopied = 0;

  constructor(text: string, public version = 1, public languageId = "typescript", uri = "file:///workspace/src/big.ts") {
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    this.lines = text.split(/\r\n|\n/);
    this.lineStarts = Array.from({ length: this.lines.length }, () => 0);
    let offset = 0;
    for (let i = 0; i < this.lines.length; i++) {
      this.lineStarts[i] = offset;
      offset += this.lines[i].length + this.eol.length;
    }
    this.uri = { toString: () => uri, fsPath: uri.replace(/^file:\/\//, "") };
  }

  get lineCount() { return this.lines.length; }

  lineAt(line: number) {
    const text = this.lines[line];
    return { text, range: new Rng(new Pos(line, 0), new Pos(line, text.length)) };
  }

  private clampPos(p: Pos): Pos {
    if (p.line < 0) return new Pos(0, 0);
    if (p.line >= this.lines.length) return new Pos(this.lines.length - 1, this.lines[this.lines.length - 1].length);
    return new Pos(p.line, Math.max(0, Math.min(p.character, this.lines[p.line].length)));
  }

  offsetAt(position: Pos): number {
    const p = this.clampPos(position);
    return this.lineStarts[p.line] + p.character;
  }

  positionAt(offset: number): Pos {
    const o = Math.max(0, Math.floor(offset));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= o) lo = mid; else hi = mid - 1;
    }
    return new Pos(lo, Math.min(o - this.lineStarts[lo], this.lines[lo].length));
  }

  getText(range?: Rng): string {
    let out: string;
    if (!range) {
      out = this.lines.join(this.eol);
    } else {
      const s = this.clampPos(range.start);
      const e = this.clampPos(range.end);
      if (s.line === e.line) {
        out = this.lines[s.line].slice(s.character, e.character);
      } else {
        const parts = [this.lines[s.line].slice(s.character)];
        for (let i = s.line + 1; i < e.line; i++) parts.push(this.lines[i]);
        parts.push(this.lines[e.line].slice(0, e.character));
        out = parts.join(this.eol);
      }
    }
    this.charsCopied += out.length;
    return out;
  }
}

/** Deterministic source text of roughly `bytes` characters. */
export function syntheticSource(bytes: number): string {
  const line = "  const value_%d = compute(alpha, beta, gamma) + offset; // line %d\n";
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const l = line.replace("%d", String(i)).replace("%d", String(i));
    parts.push(l);
    size += l.length;
  }
  return parts.join("");
}
