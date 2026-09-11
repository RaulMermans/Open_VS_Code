import test from "node:test"
import assert from "node:assert/strict"
import { compileContext } from "../../src/context/compiler.ts"
import type { ConversationTurn } from "../../src/contracts/context.ts"

test("ContextCompiler - Recent Turns E2E", async (t) => {
  const baseInput = {
    task: "test task",
    projectInstructions: [],
    budget: { contextWindow: 100, reservedOutput: 10, reservedToolHistory: 10, availableContext: 80 }
  };

  await t.test("1. no recentTurns", () => {
    const ctx = compileContext(baseInput);
    assert.strictEqual(ctx.items.find(i => i.id.startsWith("recent-turn-group")), undefined);
  });

  await t.test("2. one recent turn", () => {
    const ctx = compileContext({ ...baseInput, recentTurns: [{ role: "user", content: "hello" }] });
    const turns = ctx.items.filter(i => i.id.startsWith("recent-turn-group"));
    assert.strictEqual(turns.length, 1);
  });

  await t.test("3. multiple recent turns", () => {
    const ctx = compileContext({ ...baseInput, recentTurns: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] });
    const turns = ctx.items.filter(i => i.id.startsWith("recent-turn-group"));
    assert.strictEqual(turns.length, 1); // Grouped into one turn!
  });

  await t.test("4. huge conversation history", () => {
    const turns: ConversationTurn[] = Array.from({length: 50}, () => ({ role: "user", content: "A".repeat(100) }));
    const ctx = compileContext({ ...baseInput, budget: { contextWindow: 8000, reservedOutput: 100, reservedToolHistory: 100, availableContext: 7800 }, recentTurns: turns });
    const retained = ctx.items.filter(i => i.id.startsWith("recent-turn-group"));
    assert.ok(retained.length > 0 && retained.length < 50); // Budget capped
  });

  await t.test("5. history dropped before required current task", () => {
    const turns: ConversationTurn[] = Array.from({length: 50}, () => ({ role: "user", content: "A".repeat(1000) }));
    const ctx = compileContext({ ...baseInput, recentTurns: turns });
    assert.ok(ctx.items.some(i => i.source.kind === "task"));
  });

  await t.test("6. history dropped before current Project Memory truth", () => {
    const turns: ConversationTurn[] = Array.from({length: 50}, () => ({ role: "user", content: "A".repeat(1000) }));
    const ctx = compileContext({ 
      ...baseInput, 
      memory: { projectFacts: [{ source: "test", content: "fact" }], activeTasks: [], decisions: [], sessionSummaries: [] }, 
      recentTurns: turns 
    });
    assert.ok(ctx.items.some(i => i.id === "memory:fact:test"));
  });

  await t.test("7. context stays within budget", () => {
    const turns: ConversationTurn[] = Array.from({length: 50}, () => ({ role: "user", content: "A".repeat(1000) }));
    const ctx = compileContext({ ...baseInput, budget: { contextWindow: 8000, reservedOutput: 100, reservedToolHistory: 100, availableContext: 7800 }, recentTurns: turns });
    assert.ok(ctx.totalEstimatedTokens <= 7800);
  });

  await t.test("8. no REQUIRED_CONTEXT_OVERFLOW caused solely by optional recent history", () => {
    const turns: ConversationTurn[] = Array.from({length: 1000}, () => ({ role: "user", content: "A".repeat(1000) }));
    assert.doesNotThrow(() => compileContext({ ...baseInput, budget: { contextWindow: 8000, reservedOutput: 100, reservedToolHistory: 100, availableContext: 7800 }, recentTurns: turns }));
  });

  await t.test("9. deterministic newest-turn selection", () => {
    const turns: ConversationTurn[] = [
      { role: "user", content: "oldest".repeat(1000) },
      { role: "user", content: "newest".repeat(10) }
    ];
    // small budget so oldest drops
    const ctx = compileContext({ ...baseInput, budget: { contextWindow: 200, reservedOutput: 10, reservedToolHistory: 10, availableContext: 180 }, recentTurns: turns });
    const retained = ctx.items.filter(i => i.id.startsWith("recent-turn-group"));
    assert.strictEqual(retained.length, 1);
    assert.ok(retained[0].content.includes("newest"));
  });

  await t.test("10. current task always retained", () => {
    const turns: ConversationTurn[] = Array.from({length: 50}, () => ({ role: "user", content: "A".repeat(1000) }));
    const ctx = compileContext({ ...baseInput, recentTurns: turns });
    assert.ok(ctx.items.some(i => i.source.kind === "task"));
  });
});
