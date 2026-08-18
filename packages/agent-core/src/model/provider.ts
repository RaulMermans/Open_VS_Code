import type { ModelRequest } from "../contracts/model.ts"

export function validateModelRequest(request: ModelRequest): void {
  if (!Array.isArray(request.messages)) throw new TypeError("Model messages must be an array")
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0)) {
    throw new TypeError("Model temperature must be a non-negative finite number")
  }
  if (request.maxOutputTokens !== undefined && (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)) {
    throw new TypeError("Maximum output tokens must be a positive integer")
  }
  for (const message of request.messages) {
    if (typeof message.content !== "string") throw new TypeError("Model message content must be a string")
  }
}
