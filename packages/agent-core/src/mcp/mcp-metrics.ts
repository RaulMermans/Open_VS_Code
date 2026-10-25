/**
 * Operational metrics for MCP integrations.
 *
 * Privacy and security boundary:
 * Metrics strictly avoid recording request arguments, tool output,
 * model prompts, or authentication tokens.
 */

export interface McpMetricsSnapshot {
  readonly connectionAttempts: number;
  readonly connectionsSuccessful: number;
  readonly connectionsFailed: number;
  readonly protocolVersionsNegotiated: Record<string, number>;
  readonly totalDiscoveryDurationMs: number;
  readonly toolsDiscoveredCount: number;
  readonly toolCallsTotal: number;
  readonly toolCallsCompleted: number;
  readonly toolCallsFailed: number;
  readonly timeoutsCount: number;
  readonly cancellationsCount: number;
  readonly reconnectAttempts: number;
  readonly approvalsGranted: number;
  readonly approvalsDenied: number;
  readonly validationFailuresCount: number;
  readonly resultsTruncatedCount: number;
  readonly totalResultBytesRetained: number;
}

export class McpMetricsTracker {
  private connectionAttempts = 0;
  private connectionsSuccessful = 0;
  private connectionsFailed = 0;
  private protocolVersions = new Map<string, number>();
  private totalDiscoveryDurationMs = 0;
  private toolsDiscoveredCount = 0;
  private toolCallsTotal = 0;
  private toolCallsCompleted = 0;
  private toolCallsFailed = 0;
  private timeoutsCount = 0;
  private cancellationsCount = 0;
  private reconnectAttempts = 0;
  private approvalsGranted = 0;
  private approvalsDenied = 0;
  private validationFailuresCount = 0;
  private resultsTruncatedCount = 0;
  private totalResultBytesRetained = 0;

  recordConnectionAttempt(_serverId: string, _transport: string): void {
    this.connectionAttempts++;
  }

  recordConnectionSuccess(_serverId: string, protocolVersion: string, _durationMs: number): void {
    this.connectionsSuccessful++;
    const current = this.protocolVersions.get(protocolVersion) ?? 0;
    this.protocolVersions.set(protocolVersion, current + 1);
  }

  recordConnectionFailure(_serverId: string, _errorReason: string): void {
    this.connectionsFailed++;
  }

  recordDiscovery(_serverId: string, toolCount: number, durationMs: number): void {
    this.toolsDiscoveredCount += toolCount;
    this.totalDiscoveryDurationMs += durationMs;
  }

  recordToolCallStart(): void {
    this.toolCallsTotal++;
  }

  recordToolCallSuccess(_bytesRetained: number, truncated: boolean): void {
    this.toolCallsCompleted++;
    this.totalResultBytesRetained += _bytesRetained;
    if (truncated) {
      this.resultsTruncatedCount++;
    }
  }

  recordToolCallFailure(): void {
    this.toolCallsFailed++;
  }

  recordTimeout(): void {
    this.timeoutsCount++;
  }

  recordCancellation(): void {
    this.cancellationsCount++;
  }

  recordReconnectAttempt(): void {
    this.reconnectAttempts++;
  }

  recordApproval(granted: boolean): void {
    if (granted) {
      this.approvalsGranted++;
    } else {
      this.approvalsDenied++;
    }
  }

  recordValidationFailure(): void {
    this.validationFailuresCount++;
  }

  getSnapshot(): McpMetricsSnapshot {
    return {
      connectionAttempts: this.connectionAttempts,
      connectionsSuccessful: this.connectionsSuccessful,
      connectionsFailed: this.connectionsFailed,
      protocolVersionsNegotiated: Object.fromEntries(this.protocolVersions.entries()),
      totalDiscoveryDurationMs: this.totalDiscoveryDurationMs,
      toolsDiscoveredCount: this.toolsDiscoveredCount,
      toolCallsTotal: this.toolCallsTotal,
      toolCallsCompleted: this.toolCallsCompleted,
      toolCallsFailed: this.toolCallsFailed,
      timeoutsCount: this.timeoutsCount,
      cancellationsCount: this.cancellationsCount,
      reconnectAttempts: this.reconnectAttempts,
      approvalsGranted: this.approvalsGranted,
      approvalsDenied: this.approvalsDenied,
      validationFailuresCount: this.validationFailuresCount,
      resultsTruncatedCount: this.resultsTruncatedCount,
      totalResultBytesRetained: this.totalResultBytesRetained,
    };
  }

  reset(): void {
    this.connectionAttempts = 0;
    this.connectionsSuccessful = 0;
    this.connectionsFailed = 0;
    this.protocolVersions.clear();
    this.totalDiscoveryDurationMs = 0;
    this.toolsDiscoveredCount = 0;
    this.toolCallsTotal = 0;
    this.toolCallsCompleted = 0;
    this.toolCallsFailed = 0;
    this.timeoutsCount = 0;
    this.cancellationsCount = 0;
    this.reconnectAttempts = 0;
    this.approvalsGranted = 0;
    this.approvalsDenied = 0;
    this.validationFailuresCount = 0;
    this.resultsTruncatedCount = 0;
    this.totalResultBytesRetained = 0;
  }
}
