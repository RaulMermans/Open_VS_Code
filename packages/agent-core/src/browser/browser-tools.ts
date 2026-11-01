import * as crypto from "node:crypto";
import type { ToolAction } from "../contracts/tools.ts";
import type { ToolRegistration, ToolExecutionContext, ReviewableExecution } from "../tools/registry.ts";
import type { BrowserEventCorrelation } from "./browser-observation-contracts.ts";
import { BrowserSessionManager, redactSensitiveText } from "./browser-session-manager.ts";
import { classifyBrowserToolAction } from "./browser-action-classifier.ts";

function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Field "${fieldName}" must be a non-empty string.`);
  }
  return value.trim();
}

function buildCorrelation(
  context?: Partial<ToolExecutionContext>,
  confirmationId?: string
): BrowserEventCorrelation {
  return {
    origin: context?.origin ?? "agent",
    ...(context?.taskId ? { taskId: context.taskId } : {}),
    ...(context?.callId ? { toolCallId: context.callId } : {}),
    ...(confirmationId ? { confirmationId } : {}),
  };
}

export function createBrowserToolRegistrations(
  sessionManager: BrowserSessionManager
): readonly ToolRegistration[] {
  const reportDenied = (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    effectiveAction: ToolAction,
    reason: string,
    context?: Partial<ToolExecutionContext>
  ) => {
    const refId = typeof input.refId === "string" ? input.refId : undefined;
    const rawTarget =
      typeof input.url === "string"
        ? input.url
        : refId
        ? sessionManager.getElementRef(refId)?.name
        : undefined;
    sessionManager.recordActionDenied(
      {
        tool: toolName,
        action: effectiveAction,
        ...(refId ? { refId } : {}),
        ...(rawTarget ? { target: redactSensitiveText(rawTarget) } : {}),
        reason,
      },
      buildCorrelation(context)
    );
  };

  // 1. browser_open
  const browserOpen: ToolRegistration = {
    definition: {
      name: "browser_open",
      description: "Launch or use the governed browser to open an authorized URL.",
      action: "browser_inspection",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to open in the browser (must be within authorized origins)",
          },
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
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_open", input, effectiveAction, reason, context),
    execute: async (input, context: ToolExecutionContext) => {
      const url = input.url as string;
      const result = await sessionManager.withCorrelation(buildCorrelation(context), () =>
        sessionManager.open(url, context.signal)
      );
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
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_navigate", input, effectiveAction, reason, context),
    prepareForReview: async (
      input: Readonly<Record<string, unknown>>,
      context: ToolExecutionContext
    ): Promise<ReviewableExecution> => {
      const url = input.url as string;
      const redactedUrl = redactSensitiveText(url);
      const confirmationId = `browser_nav_${crypto.randomUUID().slice(0, 8)}`;
      const correlation = buildCorrelation(context, confirmationId);
      sessionManager.recordApprovalRequested(
        {
          tool: "browser_navigate",
          action: "browser_interaction",
          target: redactedUrl,
          confirmationId,
        },
        correlation
      );
      return {
        id: confirmationId,
        reviewPayload: {
          tool: "browser_navigate",
          url: redactedUrl,
          action: "browser_interaction",
        },
        reject: (reason?: string) => {
          sessionManager.recordApprovalResolved(
            {
              tool: "browser_navigate",
              action: "browser_interaction",
              approved: false,
              target: redactedUrl,
              reason: reason || "USER_REJECTED",
              confirmationId,
            },
            correlation
          );
        },
        apply: async (applyContext?: ToolExecutionContext) => {
          const activeCorrelation = buildCorrelation(applyContext ?? context, confirmationId);
          sessionManager.recordApprovalResolved(
            {
              tool: "browser_navigate",
              action: "browser_interaction",
              approved: true,
              target: redactedUrl,
              confirmationId,
            },
            activeCorrelation
          );
          const res = await sessionManager.withCorrelation(activeCorrelation, () =>
            sessionManager.navigate(url, applyContext?.signal ?? context.signal)
          );
          return {
            ok: true,
            url: res.url,
            title: res.title,
          };
        },
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const url = input.url as string;
      const result = await sessionManager.withCorrelation(buildCorrelation(context), () =>
        sessionManager.navigate(url, context.signal)
      );
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
      description:
        "Capture a structured accessibility snapshot and indexed interactive elements from the current browser page.",
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
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_snapshot", input, effectiveAction, reason, context),
    execute: async (input, context: ToolExecutionContext) => {
      const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : undefined;
      const snapshot = await sessionManager.withCorrelation(buildCorrelation(context), () =>
        sessionManager.snapshot(maxDepth !== undefined ? { maxDepth } : undefined, context.signal)
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
      description:
        "Click an interactive element identified by refId from the latest accessibility snapshot.",
      action: "browser_interaction",
      inputSchema: {
        type: "object",
        properties: {
          refId: {
            type: "string",
            description: "Element refId from the latest snapshot (e.g. e1, e2)",
          },
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
    classifyAction: (input: Readonly<Record<string, unknown>>) => {
      const refId = input.refId as string;
      const target = sessionManager.getElementRef(refId);
      return classifyBrowserToolAction({
        toolName: "browser_click",
        args: input,
        targetElement: target,
      });
    },
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_click", input, effectiveAction, reason, context),
    prepareForReview: async (
      input: Readonly<Record<string, unknown>>,
      context: ToolExecutionContext
    ): Promise<ReviewableExecution> => {
      const refId = input.refId as string;
      const target = sessionManager.getElementRef(refId);
      const approvedAction = classifyBrowserToolAction({
        toolName: "browser_click",
        args: input,
        targetElement: target,
      });
      const page = sessionManager.getActivePage();
      const rawPageUrl = page ? page.url() : "";
      const approvedSnapshotId = sessionManager.getActiveSnapshotId();
      const approvedFingerprint = target?.targetFingerprint;
      const redactedTargetName = target?.name ? redactSensitiveText(target.name) : undefined;
      const confirmationId = `browser_click_${crypto.randomUUID().slice(0, 8)}`;
      const correlation = buildCorrelation(context, confirmationId);

      sessionManager.recordApprovalRequested(
        {
          tool: "browser_click",
          action: approvedAction,
          refId,
          ...(redactedTargetName ? { target: redactedTargetName } : {}),
          confirmationId,
        },
        correlation
      );

      return {
        id: confirmationId,
        reviewPayload: {
          tool: "browser_click",
          refId,
          targetName: redactedTargetName,
          targetRole: target?.role,
          action: approvedAction,
          pageUrl: redactSensitiveText(rawPageUrl),
          snapshotId: approvedSnapshotId,
          targetFingerprint: approvedFingerprint,
        },
        reject: (reason?: string) => {
          sessionManager.recordApprovalResolved(
            {
              tool: "browser_click",
              action: approvedAction,
              approved: false,
              refId,
              ...(redactedTargetName ? { target: redactedTargetName } : {}),
              reason: reason || "USER_REJECTED",
              confirmationId,
            },
            correlation
          );
        },
        apply: async (applyContext?: ToolExecutionContext) => {
          const activeCorrelation = buildCorrelation(applyContext ?? context, confirmationId);
          sessionManager.recordApprovalResolved(
            {
              tool: "browser_click",
              action: approvedAction,
              approved: true,
              refId,
              ...(redactedTargetName ? { target: redactedTargetName } : {}),
              confirmationId,
            },
            activeCorrelation
          );
          return sessionManager.withCorrelation(activeCorrelation, async () => {
            await sessionManager.revalidateApproval({
              toolName: "browser_click",
              refId,
              approvedSnapshotId,
              approvedPageUrl: rawPageUrl,
              approvedFingerprint,
              approvedAction,
            });
            const res = await sessionManager.click(refId, applyContext?.signal ?? context.signal);
            return {
              ok: res.success,
              refId,
              target: {
                name: res.target.name,
                role: res.target.role,
              },
            };
          });
        },
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const refId = input.refId as string;
      const res = await sessionManager.withCorrelation(buildCorrelation(context), () =>
        sessionManager.click(refId, context.signal)
      );
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
      description:
        "Fill a form input or text field identified by refId from the latest accessibility snapshot.",
      action: "browser_interaction",
      inputSchema: {
        type: "object",
        properties: {
          refId: {
            type: "string",
            description: "Field refId from the latest snapshot (e.g. e1)",
          },
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
    classifyAction: (input: Readonly<Record<string, unknown>>) => {
      const refId = input.refId as string;
      const target = sessionManager.getElementRef(refId);
      return classifyBrowserToolAction({
        toolName: "browser_fill",
        args: input,
        targetElement: target,
      });
    },
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_fill", input, effectiveAction, reason, context),
    prepareForReview: async (
      input: Readonly<Record<string, unknown>>,
      context: ToolExecutionContext
    ): Promise<ReviewableExecution> => {
      const refId = input.refId as string;
      const value = input.value as string;
      const target = sessionManager.getElementRef(refId);
      const approvedAction = classifyBrowserToolAction({
        toolName: "browser_fill",
        args: input,
        targetElement: target,
      });
      const page = sessionManager.getActivePage();
      const rawPageUrl = page ? page.url() : "";
      const approvedSnapshotId = sessionManager.getActiveSnapshotId();
      const isSens = approvedAction === "browser_sensitive" || (target?.sensitive ?? false);
      const approvedFingerprint = target?.targetFingerprint;
      const redactedFieldName = target?.name ? redactSensitiveText(target.name) : undefined;
      const confirmationId = `browser_fill_${crypto.randomUUID().slice(0, 8)}`;
      const correlation = buildCorrelation(context, confirmationId);

      sessionManager.recordApprovalRequested(
        {
          tool: "browser_fill",
          action: approvedAction,
          refId,
          ...(redactedFieldName ? { target: redactedFieldName } : {}),
          confirmationId,
        },
        correlation
      );

      return {
        id: confirmationId,
        reviewPayload: {
          tool: "browser_fill",
          refId,
          fieldName: redactedFieldName,
          fieldRole: target?.role,
          action: approvedAction,
          pageUrl: redactSensitiveText(rawPageUrl),
          snapshotId: approvedSnapshotId,
          targetFingerprint: approvedFingerprint,
          // Never expose sensitive values or embedded secrets in review display payload
          displayValue: isSens ? "[REDACTED SENSITIVE DATA]" : redactSensitiveText(value),
        },
        reject: (reason?: string) => {
          sessionManager.recordApprovalResolved(
            {
              tool: "browser_fill",
              action: approvedAction,
              approved: false,
              refId,
              ...(redactedFieldName ? { target: redactedFieldName } : {}),
              reason: reason || "USER_REJECTED",
              confirmationId,
            },
            correlation
          );
        },
        apply: async (applyContext?: ToolExecutionContext) => {
          const activeCorrelation = buildCorrelation(applyContext ?? context, confirmationId);
          sessionManager.recordApprovalResolved(
            {
              tool: "browser_fill",
              action: approvedAction,
              approved: true,
              refId,
              ...(redactedFieldName ? { target: redactedFieldName } : {}),
              confirmationId,
            },
            activeCorrelation
          );
          return sessionManager.withCorrelation(activeCorrelation, async () => {
            await sessionManager.revalidateApproval({
              toolName: "browser_fill",
              refId,
              approvedSnapshotId,
              approvedPageUrl: rawPageUrl,
              approvedFingerprint,
              approvedAction,
              fillValue: value,
            });
            const res = await sessionManager.fill(
              refId,
              value,
              applyContext?.signal ?? context.signal
            );
            return {
              ok: res.success,
              refId,
              target: {
                name: res.target.name,
                role: res.target.role,
              },
            };
          });
        },
      };
    },
    execute: async (input, context: ToolExecutionContext) => {
      const refId = input.refId as string;
      const value = input.value as string;
      const res = await sessionManager.withCorrelation(buildCorrelation(context), () =>
        sessionManager.fill(refId, value, context.signal)
      );
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
          fullPage: {
            type: "boolean",
            description: "Whether to capture the entire scrollable page",
          },
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
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_screenshot", input, effectiveAction, reason, context),
    execute: async (input, context: ToolExecutionContext) => {
      const fullPage = Boolean(input.fullPage);
      const res = await sessionManager.withCorrelation(buildCorrelation(context), () =>
        sessionManager.screenshot({ fullPage }, context.signal)
      );
      return {
        ok: true,
        bytes: res.bytes,
        width: res.width,
        height: res.height,
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
    onDenied: (input, effectiveAction, reason, context) =>
      reportDenied("browser_close", input, effectiveAction, reason, context),
    execute: async (_input, context: ToolExecutionContext) => {
      await sessionManager.withCorrelation(buildCorrelation(context), () => sessionManager.close());
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
