/**
 * Host-side chat UX helpers (Sprint 7A).
 *
 * Presentation-only: these functions describe context, connection, and
 * activity for the Webview. They never compile prompts, read secrets into
 * the model, or approve side effects. ContextCompiler remains the authority
 * over what enters the model prompt.
 */

import type { ChatActivity, ChatContextChip, ConnectionStatus, ConversationExecutionStatus, InferenceBackend } from "./chat-protocol.js";

/** Shown when the user rejects a proposed edit. This is a decision, not a malfunction. */
export const USER_REJECTION_MESSAGE = "Change rejected — no files modified."

export interface TerminalTaskReview {
  readonly kind: string
  readonly status: string
  readonly path?: string | undefined
  readonly command?: string | undefined
  readonly scriptName?: string | undefined
  readonly runId?: string | undefined
}

export interface TerminalTaskInput {
  readonly status: string
  readonly failureReason?: string | undefined
  readonly finalAnswer?: string | undefined
  readonly appliedMutations?: readonly { readonly path: string; readonly status?: string | undefined }[] | undefined
  readonly reviews?: readonly TerminalTaskReview[] | undefined
  /** When set, only reviews stamped with this run may support the outcome. */
  readonly runId?: string | undefined
}

/** Reviews that belong to one agent run. A missing run id matches nothing. */
export function reviewsForRun<T extends { readonly runId?: string | undefined }>(
  reviews: readonly T[] | undefined,
  runId: string | undefined,
): T[] {
  if (!runId) return []
  return (reviews || []).filter((review) => review.runId === runId)
}

export function formatTerminalTaskMessage(result: TerminalTaskInput): { content: string; lastStatus: ConversationExecutionStatus } {
  if (result.status === "CANCELLED") {
    return { content: appendVerified("Task cancelled.", result), lastStatus: "cancelled" }
  }
  if (result.status === "FAILED" && result.failureReason === "REJECTED") {
    return { content: rejectedMessage(result), lastStatus: "rejected" }
  }
  if (result.status === "FAILED") {
    const content = result.finalAnswer?.trim()
      ? `Task failed (${result.failureReason}): ${result.finalAnswer}`
      : `Task failed: ${result.failureReason}`
    return { content: appendVerified(content, result), lastStatus: "failed" }
  }
  const answer = result.finalAnswer?.trim()
    || (result.status === "COMPLETED" ? "Task completed successfully." : `Task finished with status: ${result.status}`)
  return {
    content: appendVerified(answer, result),
    lastStatus: "completed",
  }
}

function rejectedMessage(result: TerminalTaskInput): string {
  const reviews = taskReviews(result)
  const proposed = uniqueFactPaths(
    reviews
      .filter((review) => review.kind === "mutation" && review.status === "rejected")
      .map((review) => review.path),
  )
  const applied = appliedFactPaths(result, reviews)
  if (proposed.length === 0 && applied.length === 0) return USER_REJECTION_MESSAGE
  const lines = [
    applied.length === 0
      ? USER_REJECTION_MESSAGE
      : "Change rejected — the proposed edit was not applied.",
  ]
  if (proposed.length > 0) lines.push("", "Not applied: " + proposed.join(", "))
  if (applied.length > 0) {
    lines.push("", "Already applied earlier in this task:")
    for (const path of applied) lines.push("- " + path)
  }
  return lines.join("\n")
}

function taskReviews(result: TerminalTaskInput): readonly TerminalTaskReview[] {
  return reviewsForRun(result.reviews, result.runId)
}

function appendVerified(content: string, result: TerminalTaskInput): string {
  const facts = outcomeFacts(result)
  if (result.status === "CANCELLED") {
    return facts.length > 0 ? content + "\n\n" + facts.join("\n") : content
  }
  const note = claimNote(result, facts)
  const blocks = [content]
  if (note) blocks.push("", note)
  if (facts.length > 0) blocks.push("", "Verified outcome", ...facts)
  return blocks.join("\n")
}

function outcomeFacts(result: TerminalTaskInput): string[] {
  if (result.status === "FAILED" && result.failureReason === "REJECTED") return []
  const reviews = taskReviews(result)
  const paths = appliedFactPaths(result, reviews)
  if (result.status === "CANCELLED") {
    if (paths.length === 0) return []
    return ["Already applied before cancellation:", ...paths.map((path) => "- " + path)]
  }
  const checks = checkFacts(reviews)
  if (paths.length === 0 && checks.length === 0) return []
  const lines = [
    paths.length > 0 ? "Changed:" : "No files were changed.",
    ...paths.map((path) => "- " + path),
  ]
  if (checks.length > 0) lines.push(...checks)
  else if (paths.length > 0) lines.push("Verification was not executed.")
  return lines.filter((line) => line.length > 0)
}

type CheckClass = "test" | "lint" | "typecheck" | "other"

function checkFacts(reviews: readonly TerminalTaskReview[]): string[] {
  const commands = reviews.filter((review) => review.kind === "command")
  const latest = new Map<CheckClass, TerminalTaskReview>()
  for (const review of commands) latest.set(checkClass(review), review)
  const lines: string[] = []
  for (const kind of ["test", "lint", "typecheck", "other"] as const) {
    const review = latest.get(kind)
    const line = review ? checkLine(kind, review.status) : undefined
    if (line && !lines.includes(line)) lines.push(line)
  }
  return lines
}

function checkClass(review: TerminalTaskReview): CheckClass {
  const script = (review.scriptName || "").trim().toLowerCase()
  if (script) return classFromHint(script)
  const command = review.command || review.path || ""
  return classFromHint(command)
}

function classFromHint(value: string): CheckClass {
  const text = value.toLowerCase()
  if (/(^|[^a-z])(typecheck|type-check|tsc)([^a-z]|$)/.test(text)) return "typecheck"
  if (/(^|[^a-z])(lint|eslint|oxlint|ruff)([^a-z]|$)/.test(text)) return "lint"
  if (
    text === "test" ||
    text.startsWith("test:") ||
    /(^|[^a-z])(test|jest|vitest|pytest)([^a-z]|$)/.test(text)
  ) return "test"
  return "other"
}

function checkLine(kind: CheckClass, status: string): string | undefined {
  if (status === "rejected") return "Verification was rejected."
  if (status === "cancelled") return "Verification was cancelled."
  if (status === "interrupted") return "Verification was interrupted."
  if (status === "timed-out") {
    if (kind === "test") return "Tests timed out."
    if (kind === "lint") return "Lint timed out."
    if (kind === "typecheck") return "Typecheck timed out."
    return "Other checks timed out."
  }
  if (status === "succeeded") {
    if (kind === "test") return "Tests passed."
    if (kind === "lint") return "Lint passed."
    if (kind === "typecheck") return "Typecheck passed."
    return "Other checks completed."
  }
  if (status === "failed") {
    if (kind === "test") return "Tests failed."
    if (kind === "lint") return "Lint failed."
    if (kind === "typecheck") return "Typecheck failed."
    return "Other checks failed."
  }
  return undefined
}

const UNSUPPORTED_CLAIM = "Unsupported claim: the reply describes an outcome this run did not record."

function claimNote(result: TerminalTaskInput, facts: readonly string[]): string {
  if (result.status === "CANCELLED") return ""
  if (result.status === "FAILED" && result.failureReason === "REJECTED") return ""
  const answer = result.finalAnswer || ""
  if (!answer.trim()) return ""
  const recorded = facts.join("\n")
  // Past reports only. "tests pass" and "tests will pass" describe work that has not been recorded.
  const claims: Array<{ pattern: RegExp; satisfied: RegExp }> = [
    { pattern: /\btests?\s+(have\s+)?(passed|succeeded)\b/i, satisfied: /^Tests passed\.$/m },
    { pattern: /\blint\s+(passed|succeeded|is clean)\b/i, satisfied: /^Lint passed\.$/m },
    { pattern: /\btype-?\s?check\s+(passed|succeeded)\b/i, satisfied: /^Typecheck passed\.$/m },
    { pattern: /\b(checks|verification)\s+(passed|succeeded)\b/i, satisfied: /(Tests|Lint|Typecheck) passed\.|^Other checks completed\.$/m },
    { pattern: /\b(the edit (is|was) applied|files were changed|i applied the (edit|change|patch)|i (updated|edited|changed|modified|wrote|created) the)\b/i, satisfied: /^Changed:$/m },
  ]
  const contradicted = claims.some((claim) => claim.pattern.test(answer) && !claim.satisfied.test(recorded))
  return contradicted ? UNSUPPORTED_CLAIM : ""
}

function appliedFactPaths(result: TerminalTaskInput, reviews: readonly TerminalTaskReview[]): string[] {
  const fromResult = (result.appliedMutations || [])
    .filter((mutation) => !mutation.status || mutation.status === "APPLIED")
    .map((mutation) => mutation.path)
  const fromReviews = reviews
    .filter((review) => review.kind === "mutation" && review.status === "applied")
    .map((review) => review.path)
  return uniqueFactPaths([...fromResult, ...fromReviews])
}

function uniqueFactPaths(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of values) {
    const path = cleanFactPath(value)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
    if (paths.length >= 12) break
  }
  return paths
}

function cleanFactPath(value: string | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, "").trim()
  if (!trimmed || trimmed.length > 240) return null
  return trimmed
}

export const MAX_ATTACHMENTS = 8;
export const MAX_FILE_SEARCH_RESULTS = 20;
export const MAX_SEARCH_QUERY_CHARS = 80;
export const MAX_RELATIVE_PATH_CHARS = 500;

const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])\.env$/i,
  /(^|[\\/])\.env\./i,
  /\.(pem|key|p12|pfx|crt|cert|der)$/i,
  /\.(jks|keystore)$/i,
  /(^|[\\/])id_[a-z0-9]+$/i,
  /(^|[\\/])credentials$/i,
];

const IGNORED_PATH_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  "coverage",
  ".next",
]);

export interface ConnectionSnapshotInput {
  readonly inferenceBackend?: InferenceBackend | string;
  readonly modelLabel?: string;
  readonly providerLabel?: string;
  readonly configStatus?: "present" | "missing" | "invalid";
  readonly haloHealthChecked?: boolean;
  readonly haloReachable?: boolean;
  readonly lastError?: ConnectionStatus["state"];
  readonly activeTurn?: boolean;
  readonly trusted?: boolean;
  readonly endpointVerified?: boolean;
  readonly installedModels?: readonly string[];
  readonly selectedModel?: string;
  readonly endpoint?: string;
}

export interface AttachmentRequest {
  readonly kind: ChatContextChip["kind"];
  readonly path?: string;
  readonly label?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

const ACTIVITY_LABELS: Record<string, { kind: ChatActivity["kind"]; label: string }> = {
  "task.started": { kind: "task", label: "Starting task" },
  "context.compiled": { kind: "context", label: "Preparing context" },
  "model.requested": { kind: "model", label: "Waiting for the model" },
  "model.completed": { kind: "model", label: "Model responded" },
  "model.failed": { kind: "model", label: "Model request failed" },
  "tool.requested": { kind: "tool", label: "Requesting tool execution" },
  "tool.completed": { kind: "tool", label: "Tool finished" },
  "tool.failed": { kind: "tool", label: "Tool failed" },
  "tool.rejected": { kind: "tool", label: "Tool rejected" },
  "permission.requested": { kind: "approval", label: "Waiting for approval" },
  "permission.approved": { kind: "approval", label: "Approval granted" },
  "permission.rejected": { kind: "approval", label: "Approval rejected" },
  "permission.denied": { kind: "approval", label: "Permission denied" },
  "mutation.prepared": { kind: "mutation", label: "Preparing a change" },
  "mutation.confirmation_requested": { kind: "approval", label: "Waiting for approval" },
  "mutation.approved": { kind: "mutation", label: "Change approved" },
  "mutation.rejected": { kind: "mutation", label: "Change rejected" },
  "mutation.applied": { kind: "mutation", label: "Change applied" },
  "mutation.failed": { kind: "mutation", label: "Change failed" },
  "verification.requested": { kind: "verification", label: "Running verification" },
  "verification.prepared": { kind: "verification", label: "Preparing verification" },
  "verification.confirmation_requested": { kind: "approval", label: "Waiting for approval" },
  "verification.started": { kind: "verification", label: "Running verification" },
  "verification.completed": { kind: "verification", label: "Verification completed" },
  "verification.failed": { kind: "verification", label: "Verification failed" },
  "verification.timeout": { kind: "verification", label: "Verification timed out" },
  "verification.cancelled": { kind: "verification", label: "Verification cancelled" },
  "verification.rejected": { kind: "verification", label: "Verification rejected" },
  "task.completed": { kind: "task", label: "Completed" },
  "task.failed": { kind: "task", label: "Failed" },
  "task.cancelled": { kind: "task", label: "Cancelled" },
};

export function sanitizeRelativePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.length > MAX_RELATIVE_PATH_CHARS) return null;
  if (trimmed.includes("\0") || trimmed.includes("://")) return null;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return null;
  const parts = trimmed.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return null;
  if (parts.some((part) => part === ".." || part === "~")) return null;
  return parts.join("/");
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || normalized;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(base));
}

export function isIgnoredRelativePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  return parts.some((part) => IGNORED_PATH_SEGMENTS.has(part));
}

export function sanitizeSearchQuery(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[*?{}[\]\\]/g, "").trim().slice(0, MAX_SEARCH_QUERY_CHARS);
}

export function deriveConnectionStatus(input: ConnectionSnapshotInput): ConnectionStatus {
  const status = deriveConnectionStatusBody(input);
  const installed = (input.installedModels || [])
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim())
    .slice(0, 64);
  return {
    ...status,
    ...(installed.length ? { installedModels: installed } : {}),
    ...(input.selectedModel ? { selectedModel: input.selectedModel } : {}),
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
  };
}

function deriveConnectionStatusBody(input: ConnectionSnapshotInput): ConnectionStatus {
  const backend: InferenceBackend =
    input.inferenceBackend === "halo" ? "halo" : input.inferenceBackend === "standalone-local" ? "standalone-local" : "unknown";

  if (input.activeTurn) {
    return {
      state: "running",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: input.providerLabel,
      detail: "Agent is running",
      healthChecked: Boolean(input.haloHealthChecked),
      actionable: "none",
    };
  }

  if (input.lastError === "missing-config" || input.configStatus === "missing") {
    return {
      state: "missing-config",
      backend,
      detail: "No model configuration found (.open-vs-code/models.json)",
      healthChecked: false,
      actionable: "create-config",
    };
  }

  if (input.configStatus === "invalid") {
    return {
      state: "missing-config",
      backend,
      detail: "Model configuration is invalid",
      healthChecked: false,
      actionable: "open-config",
    };
  }

  if (input.lastError === "invalid-credentials") {
    return {
      state: "invalid-credentials",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: input.providerLabel,
      detail: "Configured credentials are missing or invalid",
      healthChecked: Boolean(input.haloHealthChecked),
      actionable: backend === "halo" ? "check-connection" : "open-config",
    };
  }

  if (input.lastError === "timeout") {
    return {
      state: "timeout",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: input.providerLabel,
      detail: "The last request timed out or was cancelled",
      healthChecked: Boolean(input.haloHealthChecked),
      actionable: "check-connection",
    };
  }

  if (input.lastError === "disconnected") {
    return {
      state: "disconnected",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: input.providerLabel,
      detail: input.endpoint
        ? `Ollama is offline or unreachable at ${input.endpoint}`
        : "Inference endpoint unreachable",
      healthChecked: Boolean(input.haloHealthChecked),
      actionable: "check-connection",
    };
  }

  if (input.lastError === "model-unavailable") {
    return {
      state: "model-unavailable",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: input.providerLabel,
      detail: input.selectedModel
        ? `${input.selectedModel} is not installed on the local endpoint`
        : "Configured model is not available on the endpoint",
      healthChecked: Boolean(input.haloHealthChecked),
      actionable: "open-config",
    };
  }

  if (backend === "halo") {
    if (input.haloHealthChecked && input.haloReachable) {
      return {
        state: "ready",
        backend,
        modelLabel: input.modelLabel,
        providerLabel: input.providerLabel || "HALO",
        detail: "HALO reachable",
        healthChecked: true,
        actionable: "none",
      };
    }
    return {
      state: "unavailable",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: "HALO",
      detail: input.haloHealthChecked ? "HALO Core is unavailable" : "HALO not verified — health check required",
      healthChecked: Boolean(input.haloHealthChecked),
      actionable: "check-connection",
    };
  }

  if (backend === "standalone-local" && input.configStatus === "present") {
    if (input.endpointVerified) {
      return {
        state: "ready",
        backend,
        modelLabel: input.modelLabel,
        providerLabel: input.providerLabel || "Standalone local",
        detail: "Standalone local configured",
        healthChecked: true,
        actionable: "none",
      };
    }
    return {
      state: "unavailable",
      backend,
      modelLabel: input.modelLabel,
      providerLabel: input.providerLabel || "Standalone local",
      detail: "Local inference configured — endpoint not verified this session",
      healthChecked: false,
      actionable: "open-config",
    };
  }

  return {
    state: "unavailable",
    backend,
    modelLabel: input.modelLabel,
    providerLabel: input.providerLabel,
    detail: "Inference backend is not ready",
    healthChecked: false,
    actionable: "open-config",
  };
}

export function classifyTurnError(message: string): ConnectionStatus["state"] | undefined {
  const text = String(message || "");
  if (text.includes("No model routing configuration found") || text.includes("No model configuration found")) {
    return "missing-config";
  }
  if (text.includes("AUTHENTICATION_REQUIRED") || text.includes("401") || text.includes("invalid api key") || text.includes("invalid credentials")) {
    return "invalid-credentials";
  }
  if (text.includes("ECONNREFUSED") || text.includes("fetch failed") || text.includes("ENOTFOUND") || text.includes("unreachable")) {
    return "disconnected";
  }
  if (text.includes("model") && (text.includes("not found") || text.includes("unavailable"))) {
    return "model-unavailable";
  }
  if (text.includes("Timeout") || text.includes("timed out") || text.includes("ABORT_ERR") || text.includes("aborted")) {
    return "timeout";
  }
  return undefined;
}

export function activityFromAgentEvent(ev: { type?: string; payload?: any }, id: string): ChatActivity | null {
  if (!ev || typeof ev.type !== "string") return null;
  const mapped = ACTIVITY_LABELS[ev.type];
  if (!mapped) return null;

  const toolName = typeof ev.payload?.name === "string" ? ev.payload.name.slice(0, 80) : undefined;
  const summary = activitySummary(ev);
  const runSource = typeof (ev as { taskId?: unknown }).taskId === "string"
    ? (ev as { taskId: string }).taskId
    : typeof ev.payload?.task?.id === "string"
      ? ev.payload.task.id
      : "";
  const runId = runSource.trim().slice(0, 80);
  let label = mapped.label;
  if (toolName && mapped.kind === "tool") {
    if (ev.type === "tool.requested") label = "Running " + toolName;
    else if (ev.type === "tool.completed") label = toolName + " completed";
    else if (ev.type === "tool.failed") label = toolName + " failed";
    else if (ev.type === "tool.rejected") label = toolName + " rejected";
  }

  let status: ChatActivity["status"] = "pending";
  if (
    ev.type.endsWith(".completed") ||
    ev.type.endsWith(".applied") ||
    ev.type.endsWith(".approved")
  ) {
    status = "completed";
  } else if (
    ev.type.endsWith(".failed") ||
    ev.type.endsWith(".denied") ||
    ev.type.endsWith(".timeout")
  ) {
    status = "failed";
  } else if (ev.type.endsWith(".cancelled") || ev.type.endsWith(".rejected")) {
    status = "cancelled";
  }

  return {
    id,
    kind: mapped.kind,
    label,
    status,
    toolName,
    ...(summary ? { summary } : {}),
    ...(runId ? { runId } : {}),
    ...(ev.payload?.task?.mode === "PLAN" ? { planning: true } : {}),
  };
}

function activitySummary(ev: { type?: string; payload?: any }): string | undefined {
  const payload = ev.payload;
  if (!payload || typeof payload !== "object") return undefined;
  if (ev.type === "task.started") {
    const taskId = typeof payload.task?.id === "string" ? payload.task.id : typeof payload.taskId === "string" ? payload.taskId : "";
    const trimmed = taskId.trim();
    return trimmed ? trimmed.slice(0, 80) : undefined;
  }
  const path = typeof payload.path === "string" ? payload.path : typeof payload.targetFile === "string" ? payload.targetFile : "";
  if (path.trim()) return path.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 240);
  const verification = payload.result && typeof payload.result === "object" ? payload.result.status : undefined;
  if (typeof verification === "string" && verification.trim()) return verification.trim().slice(0, 20);
  return undefined;
}

export function implicitContextChips(snapshot: {
  activeDocument?: { workspaceRelativePath?: string; uri?: string } | null;
  selection?: { selectedText?: string } | null;
  diagnostics?: unknown[] | null;
  workspaceRoots?: unknown[] | null;
}): ChatContextChip[] {
  const chips: ChatContextChip[] = [];
  if (snapshot.activeDocument) {
    const label = snapshot.activeDocument.workspaceRelativePath || snapshot.activeDocument.uri || "Active file";
    chips.push({ id: "implicit:active-file", kind: "active-file", label, path: snapshot.activeDocument.workspaceRelativePath, removable: false });
  }
  if (snapshot.selection && snapshot.selection.selectedText) {
    chips.push({ id: "implicit:selection", kind: "selection", label: "Selection", removable: false });
  }
  if (snapshot.diagnostics && snapshot.diagnostics.length > 0) {
    chips.push({
      id: "implicit:diagnostics",
      kind: "diagnostics",
      label: snapshot.diagnostics.length + " diagnostics",
      removable: false,
    });
  }
  if (snapshot.workspaceRoots && snapshot.workspaceRoots.length > 0) {
    chips.push({
      id: "implicit:workspace",
      kind: "workspace",
      label: snapshot.workspaceRoots.length + " workspace roots",
      removable: false,
    });
  }
  return chips;
}

export function describeAttachment(
  request: AttachmentRequest,
  options: { trusted: boolean; nextId: () => string },
): ChatContextChip {
  const id = options.nextId();
  if (!options.trusted && (request.kind === "file" || request.kind === "active-file" || request.kind === "selection")) {
    return {
      id,
      kind: request.kind,
      label: request.label || request.path || request.kind,
      path: request.path,
      removable: true,
      unavailable: true,
      reason: "Workspace is untrusted",
    };
  }

  if (request.path) {
    const path = sanitizeRelativePath(request.path);
    if (!path) {
      return {
        id,
        kind: request.kind,
        label: request.label || "Invalid path",
        removable: true,
        unavailable: true,
        reason: "Path is outside the workspace",
      };
    }
    if (isSensitiveRelativePath(path)) {
      return {
        id,
        kind: request.kind,
        label: path,
        path,
        removable: true,
        unavailable: true,
        reason: "Sensitive file — not attached",
      };
    }
    if (isIgnoredRelativePath(path)) {
      return {
        id,
        kind: request.kind,
        label: path,
        path,
        removable: true,
        unavailable: true,
        reason: "Ignored path — not attached",
      };
    }
    const range =
      typeof request.startLine === "number" && typeof request.endLine === "number"
        ? ":" + (request.startLine + 1) + "-" + (request.endLine + 1)
        : "";
    return {
      id,
      kind: request.kind,
      label: (request.label || path) + range,
      path,
      removable: true,
    };
  }

  return {
    id,
    kind: request.kind,
    label: request.label || request.kind || "context",
    removable: true,
    unavailable: request.kind !== "selection" && request.kind !== "active-file",
    reason: request.kind === "selection" || request.kind === "active-file" ? undefined : "Nothing to attach",
  };
}

export function formatAttachmentInstruction(attachments: readonly ChatContextChip[]): string {
  if (!attachments.length) return "";
  const lines = [
    "[Attached context]",
    "The user explicitly attached these workspace references. They are descriptors only. Read file contents through repository tools if needed. Do not assume file contents beyond what tools return.",
  ];
  for (const chip of attachments) {
    if (chip.unavailable) {
      lines.push("- unavailable: " + chip.label + (chip.reason ? " (" + chip.reason + ")" : ""));
    } else if (chip.truncated) {
      lines.push("- truncated: " + (chip.path || chip.label) + (chip.reason ? " (" + chip.reason + ")" : ""));
    } else {
      lines.push("- " + chip.kind + ": " + (chip.path || chip.label));
    }
  }
  return lines.join("\n");
}

export function upsertAttachment(existing: ChatContextChip[], next: ChatContextChip): ChatContextChip[] {
  const key = (chip: ChatContextChip) => (chip.path || chip.label) + ":" + chip.kind;
  const without = existing.filter((chip) => key(chip) !== key(next));
  const combined = [...without, next];
  if (combined.length <= MAX_ATTACHMENTS) return combined;
  return combined.slice(combined.length - MAX_ATTACHMENTS);
}

export function removeAttachment(existing: ChatContextChip[], id: string): ChatContextChip[] {
  return existing.filter((chip) => chip.id !== id);
}
