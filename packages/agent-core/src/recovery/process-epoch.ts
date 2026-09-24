/**
 * Process Epoch Provider
 * Sprint 4C — Process crash / restart separation
 */

import { randomUUID } from "node:crypto"

let currentProcessEpochId: string = randomUUID()

export function getProcessEpochId(): string {
  return currentProcessEpochId
}

/**
 * For testing / simulation: force a new process epoch without terminating process
 */
export function resetProcessEpochId(newEpochId?: string): string {
  currentProcessEpochId = newEpochId ?? randomUUID()
  return currentProcessEpochId
}
