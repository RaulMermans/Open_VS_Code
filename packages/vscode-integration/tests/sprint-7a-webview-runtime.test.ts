import { test } from "node:test";
import * as assert from "node:assert/strict";
import { join } from "node:path";
import { build } from "esbuild";

test("bundled webview runtime is valid JavaScript and parses code fences", async () => {
  const result = await build({
    entryPoints: [join(process.cwd(), "src/webview-render-helpers.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
  });
  const code = result.outputFiles[0].text;
  const mod: { exports: Record<string, any> } = { exports: {} };
  const loader = new Function("module", "exports", code);
  loader(mod, mod.exports);
  const runtime = mod.exports.webviewRenderRuntime();
  assert.match(runtime, /var MAX_CODE_CHARS/);
  assert.match(runtime, /function setText/);
  assert.match(runtime, /function fillMessageBody/);
  const ctx = new Function(
    runtime + "; return { parseMessageSegments: parseMessageSegments };"
  )();
  const segs = ctx.parseMessageSegments("hello\n```js\n<img onerror=alert(1)>\n```");
  assert.equal(
    segs.some((s: { kind: string; text?: string }) => s.kind === "code" && String(s.text).includes("<img onerror=alert(1)>")),
    true
  );
});
