/**
 * Standardized error definitions for the Account Service
 */

export class AccountServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly safeDetails?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AccountServiceError";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.safeDetails ? { details: this.safeDetails } : {}),
      },
    };
  }
}

export class InvalidCredentialsError extends AccountServiceError {
  constructor(message = "Invalid username or password.") {
    super("INVALID_CREDENTIALS", message, 401);
  }
}

export class AccountDisabledError extends AccountServiceError {
  constructor(message = "This account has been disabled by an administrator.") {
    super("ACCOUNT_DISABLED", message, 403);
  }
}

export class UnauthorizedError extends AccountServiceError {
  constructor(message = "Authentication required.") {
    super("UNAUTHORIZED", message, 401);
  }
}

export class ForbiddenError extends AccountServiceError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AccountServiceError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} was not found.`, 404);
  }
}

export class ConflictError extends AccountServiceError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

export class RateLimitExceededError extends AccountServiceError {
  constructor(message = "Too many failed attempts. Please try again later.") {
    super("RATE_LIMIT_EXCEEDED", message, 429);
  }
}

export class BootstrapDisallowedError extends AccountServiceError {
  constructor(message = "Administrator bootstrap is only allowed when no accounts exist.") {
    super("BOOTSTRAP_DISALLOWED", message, 400);
  }
}

export class PublicSignupDisabledError extends AccountServiceError {
  constructor(message = "Public registration is disabled. Accounts must be provisioned by an administrator.") {
    super("PUBLIC_SIGNUP_DISABLED", message, 403);
  }
}

export class InvalidInputError extends AccountServiceError {
  constructor(message: string, safeDetails?: Record<string, unknown>) {
    super("INVALID_INPUT", message, 400, safeDetails);
  }
}

export class PayloadTooLargeError extends AccountServiceError {
  constructor(message = "Request payload exceeds maximum allowed size.") {
    super("PAYLOAD_TOO_LARGE", message, 413);
  }
}

export class SecurityViolationError extends AccountServiceError {
  constructor(message: string) {
    super("SECURITY_VIOLATION", message, 400);
  }
}

export class VaultNotConfiguredError extends AccountServiceError {
  constructor(message = "Server-side credential vault is not configured on this host.") {
    super("VAULT_NOT_CONFIGURED", message, 500);
  }
}
