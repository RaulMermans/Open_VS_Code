export interface User {
  readonly id: string
  readonly name: string
  readonly role: "admin" | "user"
}

const mockUsers: readonly User[] = [
  { id: "usr_1", name: "Alice", role: "admin" },
  { id: "usr_2", name: "Bob", role: "user" },
]

export function listUsers(): readonly User[] {
  return mockUsers
}

export function getUserById(id: string): User | undefined {
  return mockUsers.find((u) => u.id === id)
}

export const usersRouter = {
  list: listUsers,
  getById: getUserById,
}
