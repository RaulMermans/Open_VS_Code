import type { ToolAction } from "../contracts/tools.ts";
import type { ElementRef } from "./browser-contracts.ts";

export const DESTRUCTIVE_KEYWORDS = Object.freeze([
  "delete",
  "destroy",
  "remove",
  "purge",
  "drop",
  "erase",
  "terminate",
  "revoke",
  "cancel subscription",
  "clear all",
]);

export const SENSITIVE_KEYWORDS = Object.freeze([
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "private_key",
  "credit_card",
  "card_number",
  "ssn",
  "cvv",
  "pin",
]);

export const SIDE_EFFECT_KEYWORDS = Object.freeze([
  "submit",
  "purchase",
  "buy",
  "order",
  "checkout",
  "pay",
  "payment",
  "transfer",
  "upload",
  "publish",
  "deploy",
  "commit",
  "save",
  "send",
  "apply",
  "confirm",
  "register",
  "sign up",
  "signup",
  "login",
  "log in",
  "sign in",
  "signin",
  "mutate",
  "update profile",
  "change password",
  "reset password",
  "change email",
  "authenticate",
  "authorize",
]);

export function isDestructiveElement(element: Pick<ElementRef, "name" | "role" | "tag">): boolean {
  const text = `${element.name} ${element.role} ${element.tag}`.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some((kw) => text.includes(kw));
}

export function isSensitiveField(element: Pick<ElementRef, "name" | "role" | "tag" | "selector">): boolean {
  const text = `${element.name} ${element.role} ${element.tag} ${element.selector}`.toLowerCase();
  if (text.includes('type="password"') || text.includes("type='password'")) {
    return true;
  }
  return SENSITIVE_KEYWORDS.some((kw) => text.includes(kw));
}

export function isSideEffectElement(element: Pick<ElementRef, "name" | "role" | "tag" | "selector">): boolean {
  const text = `${element.name} ${element.role} ${element.tag} ${element.selector}`.toLowerCase();
  if (text.includes('type="submit"') || text.includes("type='submit'")) {
    return true;
  }
  return SIDE_EFFECT_KEYWORDS.some((kw) => text.includes(kw));
}

export function classifyBrowserToolAction(input: {
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly targetElement?: ElementRef | undefined;
}): ToolAction {
  const { toolName, targetElement } = input;

  switch (toolName) {
    case "browser_open":
    case "browser_snapshot":
    case "browser_screenshot":
    case "browser_close":
      return "browser_inspection";

    case "browser_navigate":
      return "browser_interaction";

    case "browser_click": {
      if (targetElement?.destructive || (targetElement && isDestructiveElement(targetElement))) {
        return "browser_destructive";
      }
      if (targetElement?.sensitive || (targetElement && isSensitiveField(targetElement))) {
        return "browser_sensitive";
      }
      if (targetElement?.sideEffect || (targetElement && isSideEffectElement(targetElement))) {
        return "browser_side_effect";
      }
      return "browser_interaction";
    }

    case "browser_fill": {
      if (targetElement?.sensitive || (targetElement && isSensitiveField(targetElement))) {
        return "browser_sensitive";
      }
      const val = typeof input.args?.value === "string" ? input.args.value.toLowerCase() : "";
      if (SENSITIVE_KEYWORDS.some((kw) => val.includes(kw))) {
        return "browser_sensitive";
      }
      if (targetElement?.destructive || (targetElement && isDestructiveElement(targetElement))) {
        return "browser_destructive";
      }
      if (targetElement?.sideEffect || (targetElement && isSideEffectElement(targetElement))) {
        return "browser_side_effect";
      }
      return "browser_interaction";
    }

    default:
      // High-risk capabilities (eval, cdp, cookie export, etc.) fail closed as unknown/dangerous
      return "unknown";
  }
}

/**
 * Redacts sensitive credentials, tokens, cookies, passwords, session verifiers, and private keys
 * from diagnostics, console logs, URLs, approval payloads, page titles, and errors.
 */
export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let redacted = text;
  // Redact embedded HTTP/WS Basic credentials
  redacted = redacted.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s/]+)@/g, "$1[REDACTED_CREDENTIALS]@");
  // Redact sensitive URL query & hash parameters
  redacted = redacted.replace(
    /([?&#](?:password|passwd|pwd|token|secret|api_key|apikey|key|access_token|refresh_token|client_secret|session|session_id|auth|credential)=)[^&#\s]+/gi,
    "$1[REDACTED_SECRET]"
  );
  // Redact Cookie / Set-Cookie headers
  redacted = redacted.replace(/((?:Set-)?Cookie:\s*)[^\r\n]+/gi, "$1[REDACTED_COOKIES]");
  // Redact Bearer tokens
  redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9_\-.=+/]{12,}/gi, "$1[REDACTED_TOKEN]");
  // Redact Open VS Code session tokens
  redacted = redacted.replace(/ovsc_sess_[a-zA-Z0-9_-]{8,}/g, "[REDACTED_SESSION_TOKEN]");
  // Redact AWS access keys
  redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]");
  // Redact GitHub / PAT tokens
  redacted = redacted.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]");
  // Redact sk- style API keys
  redacted = redacted.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]");
  // Redact JSON-encoded secret values
  redacted = redacted.replace(
    /("(?:password|passwd|secret|token|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|privateKey|private_key|authorization|cookie)"\s*:\s*")[^"]+(")/gi,
    "$1[REDACTED_SECRET]$2"
  );
  // Redact PEM private keys
  redacted = redacted.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]"
  );
  return redacted;
}

/**
 * Sanitizes a browser URL for display, timeline, and evidence records:
 * strips embedded credentials, redacts sensitive query/hash parameters, and bounds length.
 */
export function sanitizeBrowserUrl(rawUrl: string | undefined, maxLength = 512): string {
  if (!rawUrl) return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  const redacted = redactSensitiveText(trimmed);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
