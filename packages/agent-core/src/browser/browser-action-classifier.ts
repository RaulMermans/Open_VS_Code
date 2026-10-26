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
