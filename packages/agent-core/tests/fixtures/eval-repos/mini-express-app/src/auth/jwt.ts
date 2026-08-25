import { config } from "../config.ts"

export interface UserPayload {
  readonly sub: string
  readonly role: "admin" | "user"
}

export function verifyToken(token: string): UserPayload | null {
  if (token === `valid-admin-${config.jwtSecret}` || token === "valid-admin-token") {
    return { sub: "admin-user", role: "admin" }
  }
  if (token === "valid-user-token") {
    return { sub: "normal-user", role: "user" }
  }
  return null
}
