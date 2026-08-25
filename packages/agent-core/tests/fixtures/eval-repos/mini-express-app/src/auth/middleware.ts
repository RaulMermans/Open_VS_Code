import { verifyToken, type UserPayload } from "./jwt.ts"

export interface AuthContext {
  readonly user?: UserPayload
  readonly authenticated: boolean
}

export function requireAuth(authHeader?: string): AuthContext {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { authenticated: false }
  }
  const token = authHeader.substring("Bearer ".length).trim()
  const payload = verifyToken(token)
  if (!payload) {
    return { authenticated: false }
  }
  return { authenticated: true, user: payload }
}
