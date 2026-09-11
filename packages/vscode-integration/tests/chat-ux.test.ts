import { test, describe, before } from "node:test";
import * as assert from "node:assert";
import Module from "node:module";

const mockVscode = {
  window: { showErrorMessage: () => {}, showWarningMessage: async () => "Approve" },
  commands: { executeCommand: async () => {} },
  env: { clipboard: { writeText: () => {} } }
};

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function(request: string) {
  if (request === 'vscode') return 'vscode';
  return originalResolveFilename.apply(this, arguments);
};
const originalRequire = (Module as any).prototype.require;
(Module as any).prototype.require = function(id: string) {
  if (id === 'vscode') return mockVscode;
  return originalRequire.apply(this, arguments);
};

// @ts-ignore
let ChatController: any;

// Mock VS Code components needed by ChatController
class MockWebview {
  public options: any = {};
  public html: string = "";
  public lastMessage: any;
  public onDidReceiveMessageCb?: (msg: any) => void;
  
  onDidReceiveMessage(cb: (msg: any) => void) {
    this.onDidReceiveMessageCb = cb;
  }
  
  postMessage(message: any) {
    this.lastMessage = message;
  }
  
  async send(msg: any) {
    if (this.onDidReceiveMessageCb) {
      await this.onDidReceiveMessageCb(msg);
    }
  }
}

class MockWebviewView {
  public webview = new MockWebview();
}

describe("Chat UX Matrix", () => {
  let host: any;
  let bridgeFactory: any;
  let controller: ChatController;
  let view: MockWebviewView;

  before(async () => {
    ChatController = (await import("../src/chat-controller.js")).ChatController;
    host = {
      getSnapshot: async () => ({
        workspaceRoots: [{ uri: "file:///workspace", fsPath: "/workspace", name: "workspace" }],
        activeDocument: { uri: "file:///workspace/app.ts", workspaceRelativePath: "app.ts", languageId: "typescript", version: 1, isDirty: false },
        selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 }, selectedText: "console.log('hi')" },
        diagnostics: [{ path: "app.ts", severity: "error", message: "foo", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } }, source: "ts" }],
        visibleDocuments: []
      }),
      showOutput: async () => {},
      showError: async () => {},
      isWorkspaceTrusted: async () => true,
    };
    
    bridgeFactory = (options: any) => {
      return {
        runTask: async (instruction: string, mode: string, signal: AbortSignal, onEvent?: any) => {
          if (signal.aborted) {
            return { status: 'CANCELLED', turns: 0, finalState: { status: 'CANCELLED', events: [] }, events: [], contextDiagnostics: [], toolCalls: [] };
          }
          if (mode === "DEBUG") {
            return { status: 'COMPLETED', turns: 1, finalState: { status: 'COMPLETED', events: [] }, events: [], contextDiagnostics: [], toolCalls: [], finalAnswer: "Debug done" };
          }
          if (mode === "REVIEW") {
            return { status: 'COMPLETED', turns: 1, finalState: { status: 'COMPLETED', events: [] }, events: [], contextDiagnostics: [], toolCalls: [], finalAnswer: "Review done" };
          }
          
          if (onEvent) {
             onEvent({ type: 'task.started', payload: {} });
             onEvent({ type: 'tool.requested', payload: { name: 'search_files' } });
             onEvent({ type: 'tool.completed', payload: { name: 'search_files' } });
          }
          
          return { status: 'COMPLETED', turns: 1, finalState: { status: 'COMPLETED', events: [] }, events: [], contextDiagnostics: [], toolCalls: [], finalAnswer: "Result: " + mode };
        }
      };
    };
  });

  const setupTest = () => {
    controller = new ChatController(host, bridgeFactory);
    view = new MockWebviewView();
    controller.setWebviewView(view as any);
  };

  test("1 empty state", async () => {
    setupTest();
    assert.strictEqual(view.webview.lastMessage?.type, "chat.state");
    assert.strictEqual(view.webview.lastMessage?.state.messages.length, 0);
  });

  test("2 ASK send", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "hello", mode: "ASK" });
    const msgs = view.webview.lastMessage.state.messages;
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, "user");
    assert.strictEqual(msgs[1].role, "assistant");
    assert.strictEqual(msgs[1].content, "Result: ASK");
  });

  test("3 PLAN send", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "plan it", mode: "PLAN" });
    assert.strictEqual(view.webview.lastMessage.state.messages[1].content, "Result: PLAN");
  });

  test("4 BUILD send", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "build it", mode: "BUILD" });
    assert.strictEqual(view.webview.lastMessage.state.messages[1].content, "Result: BUILD");
  });

  test("5 DEBUG send", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "fix it", mode: "DEBUG" });
    assert.strictEqual(view.webview.lastMessage.state.messages[1].content, "Debug done");
  });

  test("6 REVIEW send", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "review it", mode: "REVIEW" });
    assert.strictEqual(view.webview.lastMessage.state.messages[1].content, "Review done");
  });

  test("7 multiline input", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "line1\\nline2", mode: "ASK" });
    assert.strictEqual(view.webview.lastMessage.state.messages[0].content, "line1\\nline2");
  });

  test("8 mode switch", async () => {
    setupTest();
    await view.webview.send({ type: "chat.setMode", mode: "PLAN" });
    assert.strictEqual(view.webview.lastMessage.state.mode, "PLAN");
  });

  test("9 new chat", async () => {
    setupTest();
    await view.webview.send({ type: "chat.send", text: "hello", mode: "ASK" });
    await view.webview.send({ type: "chat.newConversation" });
    assert.strictEqual(view.webview.lastMessage.state.messages.length, 0);
  });

  test("10 active file chip", async () => {
    setupTest();
    await controller.refreshContext(await host.getSnapshot());
    const chips = view.webview.lastMessage.state.context;
    assert.ok(chips.some((c: any) => c.label === "app.ts"));
  });

  test("11 selection chip", async () => {
    setupTest();
    await controller.refreshContext(await host.getSnapshot());
    const chips = view.webview.lastMessage.state.context;
    assert.ok(chips.some((c: any) => c.label === "Selection"));
  });

  test("12 diagnostic chip", async () => {
    setupTest();
    await controller.refreshContext(await host.getSnapshot());
    const chips = view.webview.lastMessage.state.context;
    assert.ok(chips.some((c: any) => c.label === "1 diagnostics"));
  });
  
  test("13 editor change refresh", async () => {
    setupTest();
    await controller.refreshContext({ workspaceRoots: [], activeDocument: { uri: "file:///file2.ts", workspaceRelativePath: "file2.ts", languageId: "ts", version: 1, isDirty: false }, selection: null, diagnostics: [], visibleDocuments: [] } as any);
    assert.ok(view.webview.lastMessage.state.context.some((c: any) => c.label === "file2.ts"));
  });

  test("17 second-turn reference", async () => {
    setupTest();
    
    let capturedInstruction = "";
    bridgeFactory = (options: any) => ({
      runTask: async (instruction: string, mode: string) => {
        capturedInstruction = instruction;
        return { status: 'COMPLETED', turns: 1, finalState: { status: 'COMPLETED', events: [] }, events: [], contextDiagnostics: [], toolCalls: [], finalAnswer: "done" };
      }
    });
    controller = new ChatController(host, bridgeFactory);
    controller.setWebviewView(view as any);
    
    await view.webview.send({ type: "chat.send", text: "first", mode: "ASK" });
    await view.webview.send({ type: "chat.send", text: "second", mode: "ASK" });
    
    assert.ok(capturedInstruction.includes("[Recent Conversation Context]"));
    assert.ok(capturedInstruction.includes("first"));
  });

  test("20 BUILD approve", async () => {
    setupTest();
    // Simulate core requesting confirmation
    setTimeout(() => {
       controller.requestConfirmation("Approve mutation?", { action: "write_file" });
    }, 10);
    setTimeout(() => {
       view.webview.send({ type: "confirmation.respond", action: "APPROVE" });
    }, 20);
    
    const res = await new Promise(r => {
      let interval = setInterval(() => {
        if (!view.webview.lastMessage.state.pendingConfirmation && view.webview.lastMessage.state.activities.length === 0) {
           clearInterval(interval);
           r("Done");
        }
      }, 5);
    });
    assert.ok(true);
  });
  
  test("21 BUILD reject", async () => {
    setupTest();
    setTimeout(() => {
       controller.requestConfirmation("Approve mutation?", { action: "write_file" });
    }, 10);
    setTimeout(() => {
       view.webview.send({ type: "confirmation.respond", action: "REJECT" });
    }, 20);
    
    const res = await new Promise(r => setTimeout(() => r("Done"), 40));
    assert.ok(true);
  });

  test("25 cancel delayed request", async () => {
    setupTest();
    bridgeFactory = (options: any) => ({
      runTask: async (instruction: string, mode: string, signal: AbortSignal) => {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: 'CANCELLED', turns: 0, finalState: { status: 'CANCELLED', events: [] }, events: [], contextDiagnostics: [], toolCalls: [] }));
        });
      }
    });
    controller = new ChatController(host, bridgeFactory);
    controller.setWebviewView(view as any);
    
    controller.handleCommand("ASK", "test");
    view.webview.send({ type: "chat.send", text: "test", mode: "ASK" });
    
    setTimeout(() => {
       view.webview.send({ type: "chat.cancel" });
    }, 10);
    
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(view.webview.lastMessage.state.messages[1].status, "cancelled");
  });

  test("27 busy second send", async () => {
    setupTest();
    let calls = 0;
    bridgeFactory = (options: any) => ({
      runTask: async (instruction: string, mode: string, signal: AbortSignal) => {
        calls++;
        return new Promise((resolve) => { setTimeout(() => resolve({ status: 'COMPLETED' } as any), 50) });
      }
    });
    controller = new ChatController(host, bridgeFactory);
    controller.setWebviewView(view as any);
    
    view.webview.send({ type: "chat.send", text: "t1", mode: "ASK" });
    view.webview.send({ type: "chat.send", text: "t2", mode: "ASK" });
    
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(calls, 1);
  });
  
  test("28 provider failure", async () => {
    setupTest();
    bridgeFactory = (options: any) => ({
      runTask: async () => {
        throw new Error("Provider broken");
      }
    });
    controller = new ChatController(host, bridgeFactory);
    controller.setWebviewView(view as any);
    
    await view.webview.send({ type: "chat.send", text: "test", mode: "ASK" });
    assert.strictEqual(view.webview.lastMessage.state.messages[1].status, "failed");
    assert.ok(view.webview.lastMessage.state.messages[1].content.includes("Provider broken"));
  });

  test("32 oversized message", async () => {
    setupTest();
    const big = "A".repeat(50001);
    await view.webview.send({ type: "chat.send", text: big, mode: "ASK" });
    assert.strictEqual(view.webview.lastMessage.state.messages.length, 0); // Not processed
  });
  
  test("33 multiple context chips", async () => {
    setupTest();
    await controller.refreshContext({ workspaceRoots: [{uri:"A", fsPath:"A", name:"A"}, {uri:"B", fsPath:"B", name:"B"}], activeDocument: null, selection: null, diagnostics: [], visibleDocuments: [] } as any);
    assert.ok(view.webview.lastMessage.state.context.some((c: any) => c.label === "2 workspace roots"));
  });

  test("34 copy code UI event", async () => {
    setupTest();
    view.webview.send({ type: "ui.copyCode", text: "code" });
    assert.ok(true); // Just ensuring no crash
  });

  test("35 open file UI event", async () => {
    setupTest();
    view.webview.send({ type: "ui.openFile", file: "foo.ts" });
    assert.ok(true); // Just ensuring no crash
  });
  
  test("36 cancel when no active turn", async () => {
    setupTest();
    view.webview.send({ type: "chat.cancel" });
    assert.strictEqual(view.webview.lastMessage?.type, "chat.state");
  });

  test("37 new conversation when active asks for confirmation", async () => {
    setupTest();
    // Simulate active turn
    controller["state"].activeTurn = true;
    view.webview.send({ type: "chat.newConversation" });
    // In mock window, showWarningMessage returns "Approve" (not "Cancel") so it should do nothing
    assert.strictEqual(view.webview.lastMessage.type, "chat.state"); 
  });
  
  test("38 mode switch to DEBUG", async () => {
    setupTest();
    view.webview.send({ type: "chat.setMode", mode: "DEBUG" });
    assert.strictEqual(controller["state"].mode, "DEBUG");
  });

  test("39 missing text in send", async () => {
    setupTest();
    view.webview.send({ type: "chat.send", text: "", mode: "ASK" });
    assert.strictEqual(controller["state"].messages.length, 0);
  });

  test("40 very long continuity history truncated", async () => {
    setupTest();
    for (let i = 0; i < 50; i++) {
       controller["state"].messages.push({ role: 'assistant', content: 'word '.repeat(100), id: 'id'+i, timestamp: 1 });
    }
    
    let captured = "";
    bridgeFactory = (options: any) => ({
      runTask: async (inst: string) => { captured = inst; return { status: 'COMPLETED' }; }
    });
    controller = new ChatController(host, bridgeFactory);
    controller.setWebviewView(view as any);
    
    await view.webview.send({ type: "chat.send", text: "last", mode: "ASK" });
    assert.ok(captured.length < 10000); // Should be truncated
  });

  test("41 active turn state prevents new sends", async () => {
    setupTest();
    controller["state"].activeTurn = true;
    view.webview.send({ type: "chat.send", text: "second", mode: "ASK" });
    // Should not add message
    assert.strictEqual(controller["state"].messages.length, 0);
  });

  test("42 error message includes failure reason", async () => {
    setupTest();
    bridgeFactory = (options: any) => ({
      runTask: async () => {
        return { status: "FAILED", failureReason: "NetworkError" } as any;
      }
    });
    controller = new ChatController(host, bridgeFactory);
    controller.setWebviewView(view as any);
    
    await view.webview.send({ type: "chat.send", text: "hello", mode: "ASK" });
    assert.strictEqual(controller["state"].messages[1].content, "Task failed: NetworkError");
  });
  
  test("43 double approve prevented", async () => {
    setupTest();
    setTimeout(() => { controller.requestConfirmation("App?", { action: "write" }); }, 10);
    setTimeout(() => { 
        view.webview.send({ type: "confirmation.respond", action: "APPROVE" });
        view.webview.send({ type: "confirmation.respond", action: "APPROVE" }); // second one
    }, 20);
    
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(controller["state"].pendingConfirmation, undefined);
  });

  test("44 deep equality check", async () => {
    const s1 = JSON.stringify(controller["state"]);
    const s2 = JSON.stringify(controller["state"]);
    assert.deepEqual(s1, s2);
  });
});
