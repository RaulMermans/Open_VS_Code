import * as vscode from 'vscode';

export type TerminalReviewStatus =
  | 'PREPARED'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'REJECTED';

export interface TerminalReviewEntry {
  readonly executionId: string;
  readonly confirmationId: string;
  readonly command: string;
  readonly cwd: string;
  readonly provenance: string;
  readonly timeoutMs: number;
  readonly executable: string;
  readonly args: readonly string[];
  readonly packageJsonPath?: string;
  readonly packageJsonHash?: string;
  readonly scriptName?: string;
  readonly scriptBody?: string;
  status: TerminalReviewStatus;
  exitCode: number | null;
  exitSignal: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  isOutputVisible: boolean;
}

export class TerminalReviewController {
  private reviews = new Map<string, TerminalReviewEntry>();
  private confirmationToExecution = new Map<string, string>();
  private maxOutputBytes: number;
  private onDidChangeEmitter = vscode.EventEmitter ? new vscode.EventEmitter<string>() : null;
  readonly onDidChange = this.onDidChangeEmitter?.event;

  constructor(options?: { maxOutputBytes?: number }) {
    this.maxOutputBytes = options?.maxOutputBytes ?? 16 * 1024;
  }

  get totalReviews(): number {
    return this.reviews.size;
  }

  registerPreparedCommand(params: {
    confirmationId: string;
    executionId?: string;
    command: string;
    cwd: string;
    provenance: string;
    timeoutMs: number;
    executable: string;
    args: readonly string[];
    packageJsonPath?: string;
    packageJsonHash?: string;
    scriptName?: string;
    scriptBody?: string;
  }): TerminalReviewEntry {
    const executionId = params.executionId || `term-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const entry: TerminalReviewEntry = {
      executionId,
      confirmationId: params.confirmationId,
      command: params.command,
      cwd: params.cwd,
      provenance: params.provenance,
      timeoutMs: params.timeoutMs,
      executable: params.executable,
      args: [...params.args],
      packageJsonPath: params.packageJsonPath,
      packageJsonHash: params.packageJsonHash,
      scriptName: params.scriptName,
      scriptBody: params.scriptBody,
      status: 'WAITING_APPROVAL',
      exitCode: null,
      exitSignal: null,
      durationMs: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      isOutputVisible: false,
    };

    this.reviews.set(executionId, entry);
    this.confirmationToExecution.set(params.confirmationId, executionId);
    this.onDidChangeEmitter?.fire(executionId);
    return entry;
  }

  getByExecutionId(executionId: string): TerminalReviewEntry | undefined {
    return this.reviews.get(executionId);
  }

  getByConfirmationId(confirmationId: string): TerminalReviewEntry | undefined {
    const executionId = this.confirmationToExecution.get(confirmationId);
    if (!executionId) return undefined;
    return this.reviews.get(executionId);
  }

  setStatus(executionId: string, status: TerminalReviewStatus): boolean {
    const entry = this.reviews.get(executionId);
    if (!entry) return false;
    entry.status = status;
    this.onDidChangeEmitter?.fire(executionId);
    return true;
  }

  appendOutput(executionId: string, stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    const entry = this.reviews.get(executionId);
    if (!entry) return;

    // If already in a terminal finished state, ignore late output
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED'].includes(entry.status)) {
      return;
    }

    const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const isStdout = stream === 'stdout';
    const currentBuf = Buffer.from(isStdout ? entry.stdout : entry.stderr, 'utf-8');
    const chunkBuf = Buffer.from(chunkStr, 'utf-8');

    if (currentBuf.length >= this.maxOutputBytes) {
      if (isStdout) entry.stdoutTruncated = true;
      else entry.stderrTruncated = true;
      this.onDidChangeEmitter?.fire(executionId);
      return;
    }

    const remaining = this.maxOutputBytes - currentBuf.length;
    if (chunkBuf.length > remaining) {
      const allowed = chunkBuf.subarray(0, remaining);
      const appended = allowed.toString('utf-8');
      if (isStdout) {
        entry.stdout += appended;
        entry.stdoutTruncated = true;
      } else {
        entry.stderr += appended;
        entry.stderrTruncated = true;
      }
    } else {
      if (isStdout) {
        entry.stdout += chunkStr;
      } else {
        entry.stderr += chunkStr;
      }
    }

    this.onDidChangeEmitter?.fire(executionId);
  }

  recordCompletion(executionId: string, details: {
    status: TerminalReviewStatus;
    exitCode?: number | null;
    exitSignal?: string | null;
    durationMs?: number;
    stdout?: string;
    stderr?: string;
  }): void {
    const entry = this.reviews.get(executionId);
    if (!entry) return;

    entry.status = details.status;
    entry.exitCode = details.exitCode ?? null;
    entry.exitSignal = details.exitSignal ?? null;
    entry.durationMs = details.durationMs ?? null;

    if (details.stdout !== undefined) {
      const buf = Buffer.from(details.stdout, 'utf-8');
      if (buf.length > this.maxOutputBytes) {
        entry.stdout = buf.subarray(0, this.maxOutputBytes).toString('utf-8');
        entry.stdoutTruncated = true;
      } else {
        entry.stdout = details.stdout;
      }
    }

    if (details.stderr !== undefined) {
      const buf = Buffer.from(details.stderr, 'utf-8');
      if (buf.length > this.maxOutputBytes) {
        entry.stderr = buf.subarray(0, this.maxOutputBytes).toString('utf-8');
        entry.stderrTruncated = true;
      } else {
        entry.stderr = details.stderr;
      }
    }

    this.onDidChangeEmitter?.fire(executionId);
  }

  toggleOutput(executionId: string): boolean {
    const entry = this.reviews.get(executionId);
    if (!entry) return false;
    entry.isOutputVisible = !entry.isOutputVisible;
    this.onDidChangeEmitter?.fire(executionId);
    return entry.isOutputVisible;
  }

  async copyCommand(executionId: string): Promise<boolean> {
    const entry = this.reviews.get(executionId);
    if (!entry) return false;
    try {
      await vscode.env.clipboard.writeText(entry.command);
      return true;
    } catch {
      return false;
    }
  }

  clearReview(executionId: string): void {
    const entry = this.reviews.get(executionId);
    if (entry) {
      this.confirmationToExecution.delete(entry.confirmationId);
      this.reviews.delete(executionId);
    }
  }

  clearAll(): void {
    this.reviews.clear();
    this.confirmationToExecution.clear();
  }
}
