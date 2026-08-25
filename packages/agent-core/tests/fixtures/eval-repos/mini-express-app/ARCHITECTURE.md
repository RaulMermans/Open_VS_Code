# Architecture

## Overview

The application follows a layered design:

1. **Configuration**: `src/config.ts` reads environment variables (PORT, JWT_SECRET, NODE_ENV).
2. **Authentication**: `src/auth/` implements JWT token verification (`jwt.ts`) and Express middleware (`middleware.ts`).
3. **Routing**: `src/routes/` exposes business logic endpoints.
4. **Server**: `src/server.ts` composes middlewares and routes.

## Security Constraints

- Authentication header must follow `Bearer <token>` format.
- Token validation checks static secret against configured keys.
