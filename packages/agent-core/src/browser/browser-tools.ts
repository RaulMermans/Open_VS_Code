import * as crypto from "node:crypto";
import type { ToolRegistration, ToolExecutionContext, ReviewableExecution } from "../tools/registry.ts";
import type { BrowserSessionManager } from "./browser-session-manager.ts";
import { classifyBrowserToolAction } from "./browser-action-classifier.ts";

function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Field "${fieldName}" must be a non-empty string.`);
  }
  return value.trim();
}

export function createBrowserToolRegistrations(
  sessionManager: BrowserSessionManager
): readonly ToolRegistration[] {
  // 1. browser_open
  const browserOpen: ToolRegistration = {
    definition: {
      name: "browser_open",
      description: "Launch or use the governed browser to open an authorized URL.",
      action: "browser_inspection",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open in the browser (must be within authorized origins)" },
        },
        required: ["url"],
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("browser_open arguments must be an object.");
      }
      const raw = input as Record<string, unknown>;
      const url = validateString(raw.url, "url");
      return { url };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const url = input.url as string;
      const result = await sessionManager.open(url, context.signal);
      return {
        ok: true,
        pageId: result.pageId,
        url: result.url,
        title: result.title,
      };
    },
  };

  // 2. browser_navigate
  const browserNavigate: ToolRegistration = {
    definition: {
      name: "browser_navigate",
      description: "Navigate active browser page to another authorized URL.",
      action: "browser_interaction",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL to navigate to" },
        },
        required: ["url"],
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("browser_navigate arguments must be an object.");
      }
      const raw = input as Record<string, unknown>;
      const url = validateString(raw.url, "url");
      return { url };
    },
    prepareForReview: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ReviewableExecution> => {
      const url = input.url as string;
      return {
        id: `browser_nav_${crypto.randomUUID().slice(0, 8)}`,
        reviewPayload: {
          tool: "browser_navigate",
          url,
          action: "browser_interaction",
        },
        apply: async () => {
          return await sessionManager.navigate(url, context.signal);
        },
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const url = input.url as string;
      const result = await sessionManager.navigate(url, context.signal);
      return {
        ok: true,
        url: result.url,
        title: result.title,
      };
    },
  };

  // 3. browser_snapshot
  const browserSnapshot: ToolRegistration = {
    definition: {
      name: "browser_snapshot",
      description: "Capture a structured accessibility snapshot and indexed interactive elements from the current browser page.",
      action: "browser_inspection",
      inputSchema: {
        type: "object",
        properties: {
          maxDepth: { type: "number", description: "Optional max accessibility tree depth" },
        },
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {};
      }
      const raw = input as Record<string, unknown>;
      return {
        maxDepth: typeof raw.maxDepth === "number" ? raw.maxDepth : undefined,
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : undefined;
      const snapshot = await sessionManager.snapshot(
        maxDepth !== undefined ? { maxDepth } : undefined,
        context.signal
      );
      return {
        ok: true,
        snapshotId: snapshot.snapshotId,
        url: snapshot.url,
        title: snapshot.title,
        tree: snapshot.tree,
        elementCount: snapshot.elementCount,
        truncated: snapshot.truncated,
        bytes: snapshot.bytes,
      };
    },
  };

  // 4. browser_click
  const browserClick: ToolRegistration = {
    definition: {
      name: "browser_click",
      description: "Click an interactive element identified by refId from the latest accessibility snapshot.",
      action: "browser_interaction",
      inputSchema: {
        type: "object",
        properties: {
          refId: { type: "string", description: "Element refId from the latest snapshot (e.g. e1, e2)" },
        },
        required: ["refId"],
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("browser_click arguments must be an object.");
      }
      const raw = input as Record<string, unknown>;
      const refId = validateString(raw.refId, "refId");
      return { refId };
    },
    prepareForReview: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ReviewableExecution> => {
      const refId = input.refId as string;
      const target = sessionManager.getElementRef(refId);
      const action = classifyBrowserToolAction({
        toolName: "browser_click",
        args: input,
        targetElement: target,
      });

      return {
        id: `browser_click_${crypto.randomUUID().slice(0, 8)}`,
        reviewPayload: {
          tool: "browser_click",
          refId,
          targetName: target?.name,
          targetRole: target?.role,
          action,
        },
        apply: async () => {
          return await sessionManager.click(refId, context.signal);
        },
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const refId = input.refId as string;
      const res = await sessionManager.click(refId, context.signal);
      return {
        ok: res.success,
        refId,
        target: {
          name: res.target.name,
          role: res.target.role,
        },
      };
    },
  };

  // 5. browser_fill
  const browserFill: ToolRegistration = {
    definition: {
      name: "browser_fill",
      description: "Fill a form input or text field identified by refId from the latest accessibility snapshot.",
      action: "browser_interaction",
      inputSchema: {
        type: "object",
        properties: {
          refId: { type: "string", description: "Field refId from the latest snapshot (e.g. e1)" },
          value: { type: "string", description: "Text value to fill into the field" },
        },
        required: ["refId", "value"],
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("browser_fill arguments must be an object.");
      }
      const raw = input as Record<string, unknown>;
      const refId = validateString(raw.refId, "refId");
      if (typeof raw.value !== "string") {
        throw new Error('Field "value" must be a string.');
      }
      return { refId, value: raw.value };
    },
    prepareForReview: async (input: Readonly<Record<string, unknown>>, context: ToolExecutionContext): Promise<ReviewableExecution> => {
      const refId = input.refId as string;
      const value = input.value as string;
      const target = sessionManager.getElementRef(refId);
      const action = classifyBrowserToolAction({
        toolName: "browser_fill",
        args: input,
        targetElement: target,
      });

      return {
        id: `browser_fill_${crypto.randomUUID().slice(0, 8)}`,
        reviewPayload: {
          tool: "browser_fill",
          refId,
          fieldName: target?.name,
          fieldRole: target?.role,
          action,
          // Redact password value in review display
          displayValue: target?.sensitive ? "[REDACTED SENSITIVE DATA]" : value,
        },
        apply: async () => {
          return await sessionManager.fill(refId, value, context.signal);
        },
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const refId = input.refId as string;
      const value = input.value as string;
      const res = await sessionManager.fill(refId, value, context.signal);
      return {
        ok: res.success,
        refId,
        target: {
          name: res.target.name,
          role: res.target.role,
        },
      };
    },
  };

  // 6. browser_screenshot
  const browserScreenshot: ToolRegistration = {
    definition: {
      name: "browser_screenshot",
      description: "Capture a screenshot observation of the current browser page.",
      action: "browser_inspection",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "Whether to capture the entire scrollable page" },
        },
      },
    },
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return {};
      }
      const raw = input as Record<string, unknown>;
      return {
        fullPage: Boolean(raw.fullPage),
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const fullPage = Boolean(input.fullPage);
      const res = await sessionManager.screenshot({ fullPage }, context.signal);
      return {
        ok: true,
        bytes: res.bytes,
        mimeType: res.mimeType,
        hasImage: Boolean(res.base64),
      };
    },
  };

  // 7. browser_close
  const browserClose: ToolRegistration = {
    definition: {
      name: "browser_close",
      description: "Close active browser session and cleanup browser resources.",
      action: "browser_inspection",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    validate: () => ({}),
    execute: async () => {
      await sessionManager.close();
      return { ok: true, status: "CLOSED" };
    },
  };

  return [
    browserOpen,
    browserNavigate,
    browserSnapshot,
    browserClick,
    browserFill,
    browserScreenshot,
    browserClose,
  ];
}
