import * as vscode from 'vscode';
import { StringDecoder } from 'node:string_decoder';

export type TerminalReviewStatus =
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'REJECTED';

const FINISHED_STATUSES: readonly TerminalReviewStatus[] = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED'];

export function isFinishedTerminalStatus(status: TerminalReviewStatus): boolean {
  return FINISHED_STATUSES.includes(status);
}

export function truncateUtf8Buffer(buf: Buffer, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  if (buf.length <= maxBytes) {
    return { buffer: buf, truncated: false };
  }
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end - 1];
    if (b === undefined || (b & 0xC0) !== 0x80) break;
    end--;
  }
  const lastByte = end > 0 ? buf[end - 1] : undefined;
  if (lastByte !== undefined && (lastByte & 0x80) !== 0) {
    const lead = lastByte;
    let seqLen = 1;
    if ((lead & 0xE0) === 0xC0) seqLen = 2;
    else if ((lead & 0xF0) === 0xE0) seqLen = 3;
    else if ((lead & 0xF8) === 0xF0) seqLen = 4;

    if (end - 1 + seqLen <= maxBytes) {
      end = end - 1 + seqLen;
    } else {
      end = end - 1;
    }
  }
  return { buffer: buf.subarray(0, end), truncated: true };
}

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
  startedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  isOutputVisible: boolean;
}

export interface TerminalReviewControllerOptions {
  readonly maxOutputBytes?: number;
  readonly maxReviews?: number;
  readonly maxTotalRetainedBytes?: number;
}

export class TerminalReviewController {
  private reviews = new Map<string, TerminalReviewEntry>();
  private confirmationToExecution = new Map<string, string>();
  private stdoutDecoders = new Map<string, StringDecoder>();
  private stderrDecoders = new Map<string, StringDecoder>();
  private maxOutputBytes: number;
  private maxReviews: number;
  private maxTotalRetainedBytes: number;
  private onDidChangeEmitter = vscode.EventEmitter ? new vscode.EventEmitter<string>() : null;
  readonly onDidChange = this.onDidChangeEmitter?.event;

  get outputLimitBytes(): number {
    return this.maxOutputBytes;
  }

  constructor(options?: TerminalReviewControllerOptions) {
    this.maxOutputBytes = options?.maxOutputBytes ?? 16 * 1024;
    this.maxReviews = options?.maxReviews ?? 50;
    this.maxTotalRetainedBytes = options?.maxTotalRetainedBytes ?? 1024 * 1024;
  }

  get totalReviews(): number {
    return this.reviews.size;
  }

  get totalRetainedBytes(): number {
    let total = 0;
    for (const r of this.reviews.values()) {
      total += Buffer.byteLength(r.stdout, 'utf-8') + Buffer.byteLength(r.stderr, 'utf-8');
    }
    return total;
  }

  registerPreparedCommand(params: {
    confirmationId: string;
    executionId: string;
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
    if (!params.executionId || typeof params.executionId !== 'string' || !params.executionId.trim()) {
      throw new Error("TerminalReviewController.registerPreparedCommand: executionId is required and cannot be empty");
    }
    this.enforceReviewCountBudget();

    const executionId = params.executionId.trim();
    
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
      startedAt: null,
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

  /**
   * Status is monotonic: once an execution has finished (including REJECTED or
   * CANCELLED), later or forged lifecycle signals cannot move it again.
   */
  setStatus(executionId: string, status: TerminalReviewStatus): boolean {
    const entry = this.reviews.get(executionId);
    if (!entry) return false;
    if (isFinishedTerminalStatus(entry.status)) return entry.status === status;
    if (status === 'RUNNING' && entry.startedAt === null) {
      entry.startedAt = Date.now();
      entry.isOutputVisible = true;
    }
    entry.status = status;
    this.onDidChangeEmitter?.fire(executionId);
    return true;
  }

  private getStdoutDecoder(executionId: string): StringDecoder {
    let decoder = this.stdoutDecoders.get(executionId);
    if (!decoder) {
      decoder = new StringDecoder('utf-8');
      this.stdoutDecoders.set(executionId, decoder);
    }
    return decoder;
  }

  private getStderrDecoder(executionId: string): StringDecoder {
    let decoder = this.stderrDecoders.get(executionId);
    if (!decoder) {
      decoder = new StringDecoder('utf-8');
      this.stderrDecoders.set(executionId, decoder);
    }
    return decoder;
  }

  appendOutput(executionId: string, stream: 'stdout' | 'stderr', chunk: string | Buffer): void {
    const entry = this.reviews.get(executionId);
    if (!entry) return;

    // If already in a terminal finished state, ignore late output
    if (isFinishedTerminalStatus(entry.status)) {
      return;
    }

    const isStdout = stream === 'stdout';
    const decoder = isStdout ? this.getStdoutDecoder(executionId) : this.getStderrDecoder(executionId);
    const chunkStr = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (!chunkStr) return;

    const currentText = isStdout ? entry.stdout : entry.stderr;
    const currentBytes = Buffer.byteLength(currentText, 'utf-8');

    if (currentBytes >= this.maxOutputBytes) {
      if (isStdout) entry.stdoutTruncated = true;
      else entry.stderrTruncated = true;
      this.onDidChangeEmitter?.fire(executionId);
      return;
    }

    const remaining = this.maxOutputBytes - currentBytes;
    const chunkBuf = Buffer.from(chunkStr, 'utf-8');

    if (chunkBuf.length > remaining) {
      const { buffer: safeSlice } = truncateUtf8Buffer(chunkBuf, remaining);
      const appended = safeSlice.toString('utf-8');
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

    this.enforceTotalRetainedBytesBudget();
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
    // A rejected command never ran, and a finished result is never overwritten by a
    // late or duplicate completion. A user cancel may still receive the engine's
    // exit details, but the status stays CANCELLED.
    if (entry.status === 'REJECTED') return;
    if (isFinishedTerminalStatus(entry.status) && entry.status !== 'CANCELLED') return;
    if (entry.status === 'CANCELLED' && entry.durationMs !== null) return;

    if (entry.status !== 'CANCELLED') entry.status = details.status;
    entry.exitCode = details.exitCode ?? null;
    entry.exitSignal = details.exitSignal ?? null;
    entry.durationMs = details.durationMs ?? (entry.startedAt !== null ? Date.now() - entry.startedAt : null);

    const outDecoder = this.stdoutDecoders.get(executionId);
    if (outDecoder) {
      const rem = outDecoder.end();
      if (rem) entry.stdout += rem;
      this.stdoutDecoders.delete(executionId);
    }
    const errDecoder = this.stderrDecoders.get(executionId);
    if (errDecoder) {
      const rem = errDecoder.end();
      if (rem) entry.stderr += rem;
      this.stderrDecoders.delete(executionId);
    }

    if (details.stdout !== undefined) {
      const buf = Buffer.from(details.stdout, 'utf-8');
      if (buf.length > this.maxOutputBytes) {
        const { buffer: safeSlice } = truncateUtf8Buffer(buf, this.maxOutputBytes);
        entry.stdout = safeSlice.toString('utf-8');
        entry.stdoutTruncated = true;
      } else {
        entry.stdout = details.stdout;
      }
    }

    if (details.stderr !== undefined) {
      const buf = Buffer.from(details.stderr, 'utf-8');
      if (buf.length > this.maxOutputBytes) {
        const { buffer: safeSlice } = truncateUtf8Buffer(buf, this.maxOutputBytes);
        entry.stderr = safeSlice.toString('utf-8');
        entry.stderrTruncated = true;
      } else {
        entry.stderr = details.stderr;
      }
    }

    this.enforceTotalRetainedBytesBudget();
    this.onDidChangeEmitter?.fire(executionId);
  }

  private enforceReviewCountBudget(): void {
    if (this.reviews.size < this.maxReviews) return;
    for (const [id, entry] of this.reviews) {
      if (isFinishedTerminalStatus(entry.status)) {
        this.clearReview(id);
        if (this.reviews.size < this.maxReviews) break;
      }
    }
  }

  private enforceTotalRetainedBytesBudget(): void {
    if (this.totalRetainedBytes <= this.maxTotalRetainedBytes) return;
    for (const [id, entry] of this.reviews) {
      if (isFinishedTerminalStatus(entry.status)) {
        this.clearReview(id);
        if (this.totalRetainedBytes <= this.maxTotalRetainedBytes) break;
      }
    }
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

  async copyOutput(executionId: string): Promise<boolean> {
    const entry = this.reviews.get(executionId);
    if (!entry) return false;
    try {
      await vscode.env.clipboard.writeText(formatTerminalTranscript(entry));
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
      this.stdoutDecoders.delete(executionId);
      this.stderrDecoders.delete(executionId);
    }
  }

  clearAll(): void {
    this.reviews.clear();
    this.confirmationToExecution.clear();
    this.stdoutDecoders.clear();
    this.stderrDecoders.clear();
  }
}

/** Plain-text record of a bounded execution, for the clipboard and the native Output panel. */
export function formatTerminalTranscript(entry: TerminalReviewEntry): string {
  const lines = [
    '$ ' + entry.command,
    'cwd: ' + entry.cwd,
    'provenance: ' + entry.provenance,
    'status: ' + entry.status +
      (entry.exitCode !== null ? ' · exit ' + entry.exitCode : '') +
      (entry.exitSignal ? ' · signal ' + entry.exitSignal : '') +
      (entry.durationMs !== null ? ' · ' + entry.durationMs + ' ms' : ''),
    '',
  ];
  if (entry.stdout) lines.push(entry.stdout);
  if (entry.stdoutTruncated) lines.push('[stdout truncated at the retained-output limit]');
  if (entry.stderr) lines.push('--- stderr ---', entry.stderr);
  if (entry.stderrTruncated) lines.push('[stderr truncated at the retained-output limit]');
  if (!entry.stdout && !entry.stderr) lines.push('(no output)');
  return lines.join('\n');
}
