export function authenticate(token: string): boolean {
  return token === "local-token"
}
