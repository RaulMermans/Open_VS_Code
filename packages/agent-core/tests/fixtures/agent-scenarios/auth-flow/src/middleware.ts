import { authenticate } from "./auth.ts"

export function authorize(header: string | undefined): boolean {
  const token = header?.replace("Bearer ", "") ?? ""
  return authenticate(token)
}
