/**
 * Connection states for MCP servers.
 *
 * Deterministic lifecycle states:
 * - DISABLED: Server is configured but explicitly disabled by user/workspace policy.
 * - DISCONNECTED: Server is enabled but not currently connected.
 * - CONNECTING: Connection and protocol negotiation is in progress.
 * - AUTH_REQUIRED: Server requires authentication before discovery or tool execution can proceed.
 * - CONNECTED: Successfully connected, protocol negotiated, and tools discovered.
 * - DEGRADED: Connected with reduced capabilities (e.g. some tools failed schema validation or older protocol fallback).
 * - FAILED: Connection attempt failed or reconnect attempts exhausted.
 */
export type McpConnectionState =
  | "DISABLED"
  | "DISCONNECTED"
  | "CONNECTING"
  | "AUTH_REQUIRED"
  | "CONNECTED"
  | "DEGRADED"
  | "FAILED";

export interface McpServerStatus {
  readonly serverId: string;
  readonly displayName?: string | undefined;
  readonly transport: string;
  readonly state: McpConnectionState;
  readonly toolsCount: number;
  readonly negotiatedProtocolVersion?: string | undefined;
  readonly lastConnectedAt?: string | undefined;
  readonly lastError?: string | undefined;
  readonly authRequired?: boolean | undefined;
  readonly authType?: string | undefined;
  readonly endpointOrCommand?: string | undefined;
}
