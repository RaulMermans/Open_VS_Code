import type { ReviewRecordStatus } from './chat-protocol.js';
import type { ReviewStatus } from './diff-review-controller.js';
import type { TerminalReviewEntry, TerminalReviewStatus } from './terminal-review-controller.js';

/** Rows kept in the per-conversation "Changes & commands" ledger. */
export const MAX_REVIEW_RECORDS = 20;

export function reviewStatusFromMutation(status: ReviewStatus): ReviewRecordStatus {
  switch (status) {
    case 'APPROVED': return 'approved';
    case 'APPLIED': return 'applied';
    case 'REJECTED': return 'rejected';
    case 'CANCELLED': return 'cancelled';
    case 'STALE': return 'stale';
    case 'FAILED': return 'failed';
    default: return 'pending';
  }
}

export function reviewStatusFromTerminal(status: TerminalReviewStatus): ReviewRecordStatus {
  switch (status) {
    case 'RUNNING': return 'running';
    case 'SUCCEEDED': return 'succeeded';
    case 'FAILED': return 'failed';
    case 'TIMED_OUT': return 'timed-out';
    case 'CANCELLED': return 'cancelled';
    case 'REJECTED': return 'rejected';
    default: return 'pending';
  }
}

const MUTATION_FAILURE_TEXT: Record<string, string> = {
  STALE_BASE: 'The file changed after the agent prepared this edit (content hash mismatch). Nothing was written.',
  FILE_EXISTS: 'The file already exists, so it was not created. Nothing was written.',
  PATH_ESCAPE: 'The target path is outside the workspace. Nothing was written.',
  OUTSIDE_WORKSPACE: 'The target path is outside the workspace. Nothing was written.',
  FILE_NOT_FOUND: 'The file no longer exists. Nothing was written.',
  SENSITIVE_PATH: 'The target is a protected file. Nothing was written.',
  SYMLINK_ESCAPE: 'The target resolves outside the workspace. Nothing was written.',
};

/**
 * Turns an engine failure into a short user-facing sentence. Raw exception
 * messages are not shown; only a known code or a generic fallback with the code.
 */
export function describeMutationFailure(error: unknown): { stale: boolean; detail: string } {
  const code = typeof (error as any)?.code === 'string' ? (error as any).code : '';
  const message = typeof (error as any)?.message === 'string' ? (error as any).message : '';
  const known = code || Object.keys(MUTATION_FAILURE_TEXT).find((k) => message.includes(k)) || '';
  const stale = known === 'STALE_BASE' || known === 'FILE_EXISTS';
  const detail = MUTATION_FAILURE_TEXT[known] ||
    ('The change could not be applied' + (/^[A-Z_]{2,40}$/.test(known) ? ' (' + known + ')' : '') + '. Nothing was written.');
  return { stale, detail };
}

/** Changes whenever the retained output or its bounds change; equal signatures mean nothing new to show. */
export function terminalOutputSignature(entry: TerminalReviewEntry): string {
  return [
    entry.executionId,
    entry.status,
    entry.stdout.length,
    entry.stderr.length,
    entry.stdoutTruncated ? 1 : 0,
    entry.stderrTruncated ? 1 : 0,
    entry.isOutputVisible ? 1 : 0,
  ].join(':');
}
