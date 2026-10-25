import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalSerialize, redactRuntimeEvalSecrets } from '@open-vs-code/agent-core';
import {
  CONVERSATION_ID_PATTERN,
  type ChatContextChip,
  type ChatMessage,
  type ChatMode,
  type ConversationExecutionStatus,
  type ConversationSummaryDto,
  type MutationSummaryDto,
  type ReviewRecordDto,
  type ReviewRecordStatus,
} from './chat-protocol.js';
import { sanitizeRelativePath } from './chat-ux-model.js';

/**
 * Sprint 7C — visible conversation history, per workspace.
 *
 * This is display history only. It is not agent memory (SessionSummaryStorage,
 * `.open-vs-code/sessions.jsonl`), not a checkpoint (CheckpointStore) and not an
 * execution log (OperationJournal). It never holds approval state, tool output,
 * hidden reasoning or workspace file contents, and restoring it runs nothing.
 */

export const CONVERSATION_SCHEMA_VERSION = 1;
export const MAX_CONVERSATIONS = 50;
export const MAX_PERSISTED_MESSAGES = 100;
export const MAX_PERSISTED_CHARS = 200_000;
export const MAX_MESSAGE_CHARS = 50_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_RECORD_BYTES = 512 * 1024;
export const MAX_RUN_IDS = 10;
export const MAX_QUARANTINED_FILES = 5;
const MAX_ATTACHMENTS = 20;
const MAX_REVIEWS = 20;
const MAX_PREVIEW_CHARS = 120;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MODES: ChatMode[] = ['ASK', 'PLAN', 'BUILD', 'DEBUG', 'REVIEW'];
const EXECUTION_STATUSES: ConversationExecutionStatus[] = ['idle', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
const REVIEW_STATUSES: ReviewRecordStatus[] = ['pending', 'applied', 'rejected', 'cancelled', 'stale', 'failed', 'running', 'succeeded', 'timed-out', 'interrupted'];
const CHIP_KINDS = ['workspace', 'active-file', 'selection', 'file', 'diagnostics', 'implicit'];
const INDEX_FILE = 'index.json';

export interface PersistedConversation {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  title: string;
  titleSource: 'auto' | 'user';
  createdAt: number;
  updatedAt: number;
  mode: ChatMode;
  customModeId?: string;
  messages: ChatMessage[];
  attachments: ChatContextChip[];
  reviews: ReviewRecordDto[];
  lastStatus: ConversationExecutionStatus;
  runIds: string[];
  archived: boolean;
}

export type ConversationInput = Omit<PersistedConversation, 'schemaVersion' | 'workspaceId' | 'archived' | 'titleSource' | 'title'> & {
  title?: string;
  titleSource?: 'auto' | 'user';
  archived?: boolean;
  customModeId?: string;
};

export type StoreIssueCode = 'CORRUPT' | 'UNSUPPORTED_VERSION' | 'FOREIGN_WORKSPACE' | 'OVERSIZED' | 'UNSAFE_ENTRY' | 'INDEX_REBUILT';
export interface StoreIssue { code: StoreIssueCode; id?: string }

export class ConversationStoreError extends Error {
  constructor(readonly code: 'UNSAFE_STORAGE' | 'INVALID_ID' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'ConversationStoreError';
  }
}

export function newConversationId(): string {
  return 'c-' + randomBytes(8).toString('hex');
}

/** Workspace identity: a hash of the canonical workspace root, never the path itself. */
export function computeWorkspaceId(workspaceRoot: string): string {
  let canonical = resolve(workspaceRoot);
  try { canonical = realpathSync(canonical); } catch { /* keep the resolved path */ }
  return 'w-' + createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

function redact(text: string): string {
  return redactRuntimeEvalSecrets(text);
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** User-supplied title: one line, no control characters, bounded. Empty means "no title". */
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = clip(redact(oneLine(raw)), MAX_TITLE_CHARS);
  return title ? title : null;
}

export function deriveTitle(messages: readonly ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && !m.inherited && m.content.trim());
  if (!first) return 'New conversation';
  return clip(redact(oneLine(first.content)), 60) || 'New conversation';
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function sanitizeChip(raw: any): ChatContextChip | null {
  if (!raw || typeof raw !== 'object') return null;
  const label = typeof raw.label === 'string' ? clip(redact(oneLine(raw.label)), 200) : '';
  const path = typeof raw.path === 'string' ? sanitizeRelativePath(raw.path) : null;
  if (!label && !path) return null;
  const chip: ChatContextChip = { label: label || path || 'file' };
  if (typeof raw.id === 'string' && ITEM_ID_PATTERN.test(raw.id)) chip.id = raw.id;
  if (CHIP_KINDS.includes(raw.kind)) chip.kind = raw.kind;
  if (path) chip.path = path;
  if (raw.truncated === true) chip.truncated = true;
  if (raw.unavailable === true) chip.unavailable = true;
  if (typeof raw.reason === 'string') chip.reason = clip(redact(oneLine(raw.reason)), 200);
  return chip;
}

function sanitizeChips(raw: unknown): ChatContextChip[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ATTACHMENTS).map(sanitizeChip).filter((c): c is ChatContextChip => c !== null);
}

function sanitizeMessage(raw: any, index: number): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'system') return null;
  if (typeof raw.content !== 'string') return null;
  const message: ChatMessage = {
    id: typeof raw.id === 'string' && ITEM_ID_PATTERN.test(raw.id) ? raw.id : 'm' + index,
    role: raw.role,
    content: clip(redact(raw.content), MAX_MESSAGE_CHARS),
    timestamp: finiteNumber(raw.timestamp),
  };
  if (raw.status === 'pending' || raw.status === 'completed' || raw.status === 'failed' || raw.status === 'cancelled') message.status = raw.status;
  const attachments = sanitizeChips(raw.attachments);
  if (attachments.length) message.attachments = attachments;
  if (raw.inherited === true) message.inherited = true;
  return message;
}

/** Newest messages win; the total is bounded by count and by characters. */
function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages = raw.map(sanitizeMessage).filter((m): m is ChatMessage => m !== null).slice(-MAX_PERSISTED_MESSAGES);
  let chars = messages.reduce((n, m) => n + m.content.length, 0);
  while (chars > MAX_PERSISTED_CHARS && messages.length > 1) chars -= messages.shift()!.content.length;
  return messages;
}

function sanitizeMutationSummary(raw: any): MutationSummaryDto | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.operation !== 'string') return undefined;
  const summary: MutationSummaryDto = { operation: clip(oneLine(raw.operation), 20) };
  const added = optionalInt(raw.linesAdded);
  const removed = optionalInt(raw.linesRemoved);
  if (added !== undefined) summary.linesAdded = added;
  if (removed !== undefined) summary.linesRemoved = removed;
  if (typeof raw.beforeHash === 'string' && HASH_PATTERN.test(raw.beforeHash)) summary.beforeHash = raw.beforeHash;
  if (typeof raw.afterHash === 'string' && HASH_PATTERN.test(raw.afterHash)) summary.afterHash = raw.afterHash;
  return summary;
}

function sanitizeReview(raw: any): ReviewRecordDto | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ITEM_ID_PATTERN.test(raw.id)) return null;
  if (raw.kind !== 'mutation' && raw.kind !== 'command') return null;
  if (!REVIEW_STATUSES.includes(raw.status)) return null;
  const review: ReviewRecordDto = { id: raw.id, kind: raw.kind, status: raw.status };
  const path = typeof raw.path === 'string' ? sanitizeRelativePath(raw.path) : null;
  if (path) review.path = path;
  const mutation = sanitizeMutationSummary(raw.mutation);
  if (mutation) review.mutation = mutation;
  if (typeof raw.command === 'string') review.command = clip(redact(oneLine(raw.command)), 500);
  if (raw.exitCode === null || optionalInt(raw.exitCode) !== undefined) review.exitCode = raw.exitCode;
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) review.durationMs = raw.durationMs;
  if (typeof raw.detail === 'string') review.detail = clip(redact(oneLine(raw.detail)), 300);
  if (Array.isArray(raw.verifies)) {
    const ids = raw.verifies.filter((v: unknown) => typeof v === 'string' && ITEM_ID_PATTERN.test(v)).slice(0, MAX_REVIEWS);
    if (ids.length) review.verifies = ids;
  }
  const by = raw.verifiedBy;
  if (by && typeof by.id === 'string' && ITEM_ID_PATTERN.test(by.id) && typeof by.command === 'string' && REVIEW_STATUSES.includes(by.status)) {
    review.verifiedBy = { id: by.id, command: clip(redact(oneLine(by.command)), 500), status: by.status };
  }
  return review;
}

/**
 * The single boundary every record crosses, on save and on load: known fields
 * only, bounded, secrets redacted, paths workspace-relative.
 */
export function sanitizeConversation(raw: any, workspaceId: string): PersistedConversation {
  const messages = sanitizeMessages(raw?.messages);
  const titleSource = raw?.titleSource === 'user' ? 'user' : 'auto';
  const title = (titleSource === 'user' ? normalizeTitle(raw?.title) : null) || deriveTitle(messages);
  const customModeId = typeof raw?.customModeId === 'string' && raw.customModeId.length <= 100 ? raw.customModeId : undefined;
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    id: raw.id,
    workspaceId,
    title,
    titleSource: titleSource === 'user' && normalizeTitle(raw?.title) ? 'user' : 'auto',
    createdAt: finiteNumber(raw?.createdAt),
    updatedAt: finiteNumber(raw?.updatedAt),
    mode: MODES.includes(raw?.mode) ? raw.mode : 'ASK',
    ...(customModeId ? { customModeId } : {}),
    messages,
    attachments: sanitizeChips(raw?.attachments),
    reviews: Array.isArray(raw?.reviews) ? raw.reviews.slice(-MAX_REVIEWS).map(sanitizeReview).filter((r: ReviewRecordDto | null): r is ReviewRecordDto => r !== null) : [],
    lastStatus: EXECUTION_STATUSES.includes(raw?.lastStatus) ? raw.lastStatus : 'idle',
    runIds: Array.isArray(raw?.runIds) ? raw.runIds.filter((r: unknown) => typeof r === 'string' && RUN_ID_PATTERN.test(r)).slice(-MAX_RUN_IDS) : [],
    archived: raw?.archived === true,
  };
}

/**
 * What a restored record may show. Anything that was undecided or running when
 * the editor closed is shown as interrupted; nothing is resumed or re-approved.
 */
export function prepareForRestore(record: PersistedConversation): PersistedConversation & { interrupted: boolean } {
  const interrupted = record.lastStatus === 'running';
  return {
    ...record,
    lastStatus: interrupted ? 'interrupted' : record.lastStatus,
    messages: record.messages.map((m) => (m.status === 'pending' ? { ...m, status: 'cancelled' as const } : m)),
    reviews: record.reviews.map((r) => (r.status === 'pending' || r.status === 'running'
      ? { ...r, status: 'interrupted' as const, detail: 'The editor closed before an outcome was recorded. Check the file and the recovery status before retrying.' }
      : r)),
    interrupted,
  };
}

export function summarize(record: PersistedConversation): ConversationSummaryDto {
  const firstUser = record.messages.find((m) => m.role === 'user' && !m.inherited);
  const summary: ConversationSummaryDto = {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    mode: record.mode,
    messageCount: record.messages.length,
    lastStatus: record.lastStatus,
  };
  if (record.customModeId) summary.customModeId = record.customModeId;
  if (record.archived) summary.archived = true;
  if (firstUser) summary.preview = clip(oneLine(firstUser.content), MAX_PREVIEW_CHARS);
  return summary;
}

function sanitizeSummary(raw: any): ConversationSummaryDto | null {
  if (!raw || typeof raw.id !== 'string' || !CONVERSATION_ID_PATTERN.test(raw.id)) return null;
  const customModeId = typeof raw.customModeId === 'string' && raw.customModeId.length <= 100 ? raw.customModeId : undefined;
  const summary: ConversationSummaryDto = {
    id: raw.id,
    title: normalizeTitle(raw.title) || 'New conversation',
    createdAt: finiteNumber(raw.createdAt),
    updatedAt: finiteNumber(raw.updatedAt),
    mode: MODES.includes(raw.mode) ? raw.mode : 'ASK',
    messageCount: Math.max(0, Math.min(MAX_PERSISTED_MESSAGES, Math.floor(finiteNumber(raw.messageCount)))),
    lastStatus: EXECUTION_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : 'idle',
  };
  if (customModeId) summary.customModeId = customModeId;
  if (raw.archived === true) summary.archived = true;
  if (typeof raw.preview === 'string') summary.preview = clip(redact(oneLine(raw.preview)), MAX_PREVIEW_CHARS);
  return summary;
}

function checksumOf(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}

function byRecency(a: ConversationSummaryDto, b: ConversationSummaryDto): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface ConversationStoreOptions {
  /** A per-workspace directory owned by the editor (ExtensionContext.storageUri), not the repository. */
  storageRoot: string;
  workspaceId: string;
  maxConversations?: number;
  maxRecordBytes?: number;
  now?: () => number;
}

type ReadOutcome =
  | { ok: true; record: PersistedConversation }
  | { ok: false; issue: StoreIssueCode; quarantine: boolean };

let tmpCounter = 0;

export class ConversationStore {
  readonly storageRoot: string;
  readonly workspaceId: string;
  private readonly maxConversations: number;
  private readonly maxRecordBytes: number;
  private readonly now: () => number;
  private readonly dir: string;
  private index = new Map<string, ConversationSummaryDto>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ConversationStoreOptions) {
    this.storageRoot = resolve(options.storageRoot);
    this.workspaceId = options.workspaceId;
    this.maxConversations = options.maxConversations ?? MAX_CONVERSATIONS;
    this.maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
    this.now = options.now ?? Date.now;
    this.dir = join(this.storageRoot, 'conversations');
  }

  /** Most recent first. */
  list(): ConversationSummaryDto[] {
    return Array.from(this.index.values()).sort(byRecency);
  }

  get(id: string): ConversationSummaryDto | undefined {
    return this.index.get(id);
  }

  /** Waits for every queued write. */
  flush(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  /**
   * Loads the index and reconciles it with the record files on disk. Records
   * left `running` by an earlier process are listed as interrupted.
   */
  load(): Promise<{ conversations: ConversationSummaryDto[]; issues: StoreIssue[] }> {
    return this.enqueue(async () => {
      const issues: StoreIssue[] = [];
      await this.ensureDir();
      const names = await readdir(this.dir);
      const fileIds = new Set(names.filter((n) => /^c-[0-9a-f]{16}\.json$/.test(n)).map((n) => n.slice(0, -5)));

      const indexed = new Map<string, ConversationSummaryDto>();
      let indexValid = false;
      let indexEntries = 0;
      const rawIndex = await this.readJsonFile(join(this.dir, INDEX_FILE));
      if (rawIndex.ok && rawIndex.value && rawIndex.value.schemaVersion === CONVERSATION_SCHEMA_VERSION &&
          rawIndex.value.workspaceId === this.workspaceId && Array.isArray(rawIndex.value.conversations)) {
        const { checksum, ...rest } = rawIndex.value;
        if (checksum === checksumOf(rest)) {
          indexValid = true;
          indexEntries = rawIndex.value.conversations.length;
          for (const entry of rawIndex.value.conversations) {
            const summary = sanitizeSummary(entry);
            if (summary && fileIds.has(summary.id)) indexed.set(summary.id, summary);
          }
        }
      }

      // Files the index does not know about (or every file, if the index is unusable).
      let rebuilt = !indexValid;
      for (const id of fileIds) {
        if (indexed.has(id)) continue;
        rebuilt = true;
        const outcome = await this.readRecordFile(id);
        if (outcome.ok) indexed.set(id, summarize(outcome.record));
        else {
          issues.push({ code: outcome.issue, id });
          if (outcome.quarantine) await this.quarantine(id + '.json');
        }
      }
      if (indexValid && indexed.size !== indexEntries) rebuilt = true;

      for (const summary of indexed.values()) {
        if (summary.lastStatus === 'running') summary.lastStatus = 'interrupted';
      }
      this.index = indexed;
      if (rebuilt) {
        if (rawIndex.ok || rawIndex.code !== 'ENOENT') issues.push({ code: 'INDEX_REBUILT' });
        await this.writeIndex();
      }
      return { conversations: this.list(), issues };
    });
  }

  /** Reads and validates one record; corrupt files are quarantined, never trusted. */
  read(id: string): Promise<PersistedConversation | null> {
    if (!CONVERSATION_ID_PATTERN.test(id)) return Promise.reject(new ConversationStoreError('INVALID_ID', 'Invalid conversation id'));
    return this.enqueue(async () => {
      await this.ensureDir();
      const outcome = await this.readRecordFile(id);
      if (outcome.ok) return outcome.record;
      if (outcome.quarantine) {
        await this.quarantine(id + '.json');
        if (this.index.delete(id)) await this.writeIndex();
      }
      return null;
    });
  }

  save(input: ConversationInput, options: { protect?: readonly string[] } = {}): Promise<ConversationSummaryDto> {
    if (!CONVERSATION_ID_PATTERN.test(input.id)) return Promise.reject(new ConversationStoreError('INVALID_ID', 'Invalid conversation id'));
    return this.enqueue(async () => {
      await this.ensureDir();
      const existing = this.index.get(input.id);
      const record = sanitizeConversation({
        ...input,
        archived: input.archived ?? existing?.archived ?? false,
      }, this.workspaceId);
      const summary = await this.writeRecord(record);
      await this.enforceRetention([input.id, ...(options.protect || [])]);
      await this.writeIndex();
      return summary;
    });
  }

  rename(id: string, rawTitle: string): Promise<ConversationSummaryDto | null> {
    return this.update(id, (record) => {
      const title = normalizeTitle(rawTitle);
      return title
        ? { ...record, title, titleSource: 'user' }
        : { ...record, title: deriveTitle(record.messages), titleSource: 'auto' };
    });
  }

  setArchived(id: string, archived: boolean): Promise<ConversationSummaryDto | null> {
    return this.update(id, (record) => ({ ...record, archived }), false);
  }

  delete(id: string): Promise<boolean> {
    if (!CONVERSATION_ID_PATTERN.test(id)) return Promise.reject(new ConversationStoreError('INVALID_ID', 'Invalid conversation id'));
    return this.enqueue(async () => {
      await this.ensureDir();
      let removed = false;
      try {
        await unlink(join(this.dir, id + '.json'));
        removed = true;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      removed = this.index.delete(id) || removed;
      await this.writeIndex();
      return removed;
    });
  }

  private update(id: string, change: (record: PersistedConversation) => PersistedConversation, touch = true): Promise<ConversationSummaryDto | null> {
    if (!CONVERSATION_ID_PATTERN.test(id)) return Promise.reject(new ConversationStoreError('INVALID_ID', 'Invalid conversation id'));
    return this.enqueue(async () => {
      await this.ensureDir();
      const outcome = await this.readRecordFile(id);
      if (!outcome.ok) return null;
      const changed = change(outcome.record);
      const record = sanitizeConversation({ ...changed, updatedAt: touch ? this.now() : changed.updatedAt }, this.workspaceId);
      const summary = await this.writeRecord(record);
      await this.writeIndex();
      return summary;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The storage directory must be a real directory directly under the storage root. */
  private async ensureDir(): Promise<void> {
    await mkdir(this.storageRoot, { recursive: true });
    const rootReal = await realpath(this.storageRoot);
    try {
      const st = await lstat(this.dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new ConversationStoreError('UNSAFE_STORAGE', 'Conversation storage is not a plain directory');
      }
    } catch (err: any) {
      if (err instanceof ConversationStoreError) throw err;
      if (err?.code !== 'ENOENT') throw err;
      await mkdir(this.dir, { mode: 0o700 });
    }
    const dirReal = await realpath(this.dir);
    if (dirname(dirReal) !== rootReal) {
      throw new ConversationStoreError('UNSAFE_STORAGE', 'Conversation storage escapes its root');
    }
  }

  private async readJsonFile(path: string, maxBytes = this.maxRecordBytes * 2): Promise<
    { ok: true; value: any } | { ok: false; code: 'ENOENT' | 'UNSAFE' | 'OVERSIZED' | 'CORRUPT' }
  > {
    let st;
    try {
      st = await lstat(path);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { ok: false, code: 'ENOENT' };
      throw err;
    }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'UNSAFE' };
    if (st.size > maxBytes) return { ok: false, code: 'OVERSIZED' };
    let handle;
    try {
      // O_NOFOLLOW closes the gap between lstat and open.
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { ok: false, code: 'ENOENT' };
      if (err?.code === 'ELOOP') return { ok: false, code: 'UNSAFE' };
      throw err;
    }
    try {
      const text = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, code: 'OVERSIZED' };
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, code: 'CORRUPT' };
    } finally {
      await handle.close();
    }
  }

  private async readRecordFile(id: string): Promise<ReadOutcome> {
    const raw = await this.readJsonFile(join(this.dir, id + '.json'));
    if (!raw.ok) {
      if (raw.code === 'ENOENT') return { ok: false, issue: 'CORRUPT', quarantine: false };
      if (raw.code === 'UNSAFE') return { ok: false, issue: 'UNSAFE_ENTRY', quarantine: false };
      if (raw.code === 'OVERSIZED') return { ok: false, issue: 'OVERSIZED', quarantine: true };
      return { ok: false, issue: 'CORRUPT', quarantine: true };
    }
    const value = raw.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, issue: 'CORRUPT', quarantine: true };
    if (typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion) && value.schemaVersion > CONVERSATION_SCHEMA_VERSION) {
      // Written by a newer build: leave it untouched.
      return { ok: false, issue: 'UNSUPPORTED_VERSION', quarantine: false };
    }
    if (value.schemaVersion !== CONVERSATION_SCHEMA_VERSION) return { ok: false, issue: 'CORRUPT', quarantine: true };
    if (value.workspaceId !== this.workspaceId) return { ok: false, issue: 'FOREIGN_WORKSPACE', quarantine: false };
    if (value.id !== id) return { ok: false, issue: 'CORRUPT', quarantine: true };
    const { checksum, ...rest } = value;
    if (typeof checksum !== 'string' || checksum !== checksumOf(rest)) return { ok: false, issue: 'CORRUPT', quarantine: true };
    // Integrity proven; the record still crosses the sanitization boundary.
    return { ok: true, record: sanitizeConversation(rest, this.workspaceId) };
  }

  /** Atomic write: exclusive temp file, then rename over the target. */
  private async atomicWrite(target: string, content: string): Promise<void> {
    const tmp = `${target}.tmp-${process.pid}-${++tmpCounter}-${randomBytes(4).toString('hex')}`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  private async writeRecord(record: PersistedConversation): Promise<ConversationSummaryDto> {
    const bounded = { ...record, messages: record.messages.slice() };
    let body = JSON.stringify({ ...bounded, checksum: checksumOf(bounded) });
    // Byte cap: drop the oldest messages first; a single huge message is clipped.
    // Dropping message i shrinks the body by exactly its JSON plus one comma (the
    // checksum has a fixed length), so the oldest-first cut is found in one pass
    // instead of re-serialising and re-hashing the record once per message (Sprint 7D).
    let excess = Buffer.byteLength(body, 'utf8') - this.maxRecordBytes;
    if (excess > 0 && bounded.messages.length > 1) {
      let drop = 0;
      while (excess > 0 && drop < bounded.messages.length - 1) {
        excess -= Buffer.byteLength(JSON.stringify(bounded.messages[drop]), 'utf8') + 1;
        drop++;
      }
      bounded.messages.splice(0, drop);
      body = JSON.stringify({ ...bounded, checksum: checksumOf(bounded) });
    }
    while (Buffer.byteLength(body, 'utf8') > this.maxRecordBytes) {
      if (bounded.messages.length > 1) bounded.messages.shift();
      else if (bounded.messages.length === 1) {
        const only = bounded.messages[0];
        bounded.messages[0] = { ...only, content: clip(only.content, Math.max(1, Math.floor(only.content.length / 2))) };
      } else {
        bounded.reviews = [];
        bounded.attachments = [];
      }
      body = JSON.stringify({ ...bounded, checksum: checksumOf(bounded) });
      if (!bounded.messages.length && !bounded.reviews.length && Buffer.byteLength(body, 'utf8') > this.maxRecordBytes) break;
    }
    await this.atomicWrite(join(this.dir, record.id + '.json'), body);
    const summary = summarize(bounded);
    this.index.set(record.id, summary);
    return summary;
  }

  private async writeIndex(): Promise<void> {
    const body: any = { schemaVersion: CONVERSATION_SCHEMA_VERSION, workspaceId: this.workspaceId, conversations: this.list() };
    body.checksum = checksumOf(body);
    await this.atomicWrite(join(this.dir, INDEX_FILE), JSON.stringify(body));
  }

  private async enforceRetention(protect: readonly string[]): Promise<void> {
    const ordered = this.list();
    let excess = ordered.length - this.maxConversations;
    for (let i = ordered.length - 1; i >= 0 && excess > 0; i--) {
      const victim = ordered[i];
      if (protect.includes(victim.id)) continue;
      await unlink(join(this.dir, victim.id + '.json')).catch((err: any) => {
        if (err?.code !== 'ENOENT') throw err;
      });
      this.index.delete(victim.id);
      excess--;
    }
  }

  /** Corrupt files are set aside (bounded), never silently deleted or trusted. */
  private async quarantine(name: string): Promise<void> {
    try {
      await rename(join(this.dir, name), join(this.dir, `${name}.corrupt-${this.now()}`));
    } catch {
      return;
    }
    const kept = (await readdir(this.dir)).filter((n) => n.includes('.corrupt-')).sort((a, b) => {
      const ta = Number(a.slice(a.lastIndexOf('-') + 1)) || 0;
      const tb = Number(b.slice(b.lastIndexOf('-') + 1)) || 0;
      return ta - tb;
    });
    while (kept.length > MAX_QUARANTINED_FILES) {
      const oldest = kept.shift()!;
      await unlink(join(this.dir, oldest)).catch(() => undefined);
    }
  }
}
