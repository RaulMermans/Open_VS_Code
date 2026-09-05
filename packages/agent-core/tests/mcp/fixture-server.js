#!/usr/bin/env node

import readline from "node:readline";
import { spawn } from "node:child_process";

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

let childProc = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const { id, method, params } = msg;

  if (method === "initialize") {
    sendResponse(id, { capabilities: {}, serverInfo: { name: "fixture", version: "1" } });
  } else if (method === "tools/list") {
    sendResponse(id, { tools: [
      { name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "hang", description: "hang", inputSchema: { type: "object", properties: {} } },
      { name: "crash", description: "crash", inputSchema: { type: "object", properties: {} } },
      { name: "spawn_child", description: "spawn child", inputSchema: { type: "object", properties: {} } }
    ] });
  } else if (method === "tools/call") {
    if (params.name === "echo") {
      sendResponse(id, { content: [{ type: "text", text: params.arguments.text }], isError: false });
    } else if (params.name === "hang") {
      // do nothing, let it hang
    } else if (params.name === "crash") {
      process.exit(1);
    } else if (params.name === "spawn_child") {
      childProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      sendResponse(id, { content: [{ type: "text", text: String(childProc.pid) }], isError: false });
    }
  }
});

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
