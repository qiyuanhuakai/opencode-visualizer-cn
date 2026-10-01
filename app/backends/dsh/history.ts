/**
 * dsh web session-history paging (plan Todo 26).
 *
 * `session/page` returns raw records in the SAME vocabulary as `session/follow`
 * (`{type:'event', event:{…}}`, docs/dsh.md §8.2), so history is pure replay
 * through the Todo 18 normalizer: no live bridge, no popups, no busy
 * re-derivation.
 *
 * Wire facts this module encodes (task-7 replay boundary contract):
 *   - `throughSeq`  is a CLOSED upper bound on records and must never exceed
 *                   the watermark (`cursor` of the authoritative snapshot);
 *                   exceeding it is a wire bad-request (R6).
 *   - `beforeSeq`   is an OPEN upper bound (`seq < beforeSeq`), so the first
 *                   window is `cursor + 1` — the `+1` is what includes the
 *                   cursor itself (R6).
 *   - `hasMore`     was measured CONSTANT `false`, including on windows that
 *                   were truncated by `beforeSeq` and still had older records
 *                   behind them (R6). It is therefore read as envelope
 *                   metadata only and NEVER drives the walk: the walk ends on
 *                   window emptiness / lack of progress, exactly as the Todo 16
 *                   bootstrap pager does.
 *   - a subagent child session is its OWN message space, addressed by
 *                   `{kind:'subagent',parentSessionId,childSessionId,mode}`
 *                   (Metis #7/#10). The same method with different args means
 *                   a different thing (kimi lesson L14), so a child window is
 *                   paged and normalized through the child address and its
 *                   records are never interleaved into the parent's order.
 *
 * Reuse note: bootstrap.ts already walks windows below the snapshot cursor for
 * the backfill. This module is the general continuation used by the reload
 * path (`useBackendSessionReload`) and the child addressing bootstrap does not
 * know about; `DSH_HISTORY_MAX_PAGES` and the `cursor + 1` / `lowestSeq`
 * advance rule are deliberately the same in both.
 */

import { createDshNormalizer } from './normalize';
import type { DshNormalizeOp } from './ops';
import type { DshJsonValue, DshSessionAddress, DshSessionRecord } from './types';
import type { MessageInfo, MessagePart } from '../../types/sse';

// ---------------------------------------------------------------------------
// Page envelope: `type`/`args` are data, `status`/`cursor`/`hasMore` are envelope
// ---------------------------------------------------------------------------

/**
 * One `session/page` reply after classification.
 *
 * Only `records` is data. `status` / `cursor` / `hasMore` describe the
 * transport and the frame — never the message body — so a reply that carries
 * records under one of them is malformed rather than "a page in disguise"
 * (misleading-success-output guard).
 */
export type DshHistoryPageReply = {
  readonly records: readonly DshSessionRecord[];
  readonly hasMore?: boolean;
  readonly status?: number;
  readonly cursor?: number;
};

export type DshHistoryErrorKind =
  /** The reply is not a page: wrong envelope, missing/invalid records. */
  | 'malformed-page'
  /** Authorization was invalidated (401/403) and the refresh did not help. */
  | 'auth-invalidated'
  /** dsh answered the unary call with `ok:false` (gateway/… error code). */
  | 'remote-error';

export class DshHistoryError extends Error {
  readonly kind: DshHistoryErrorKind;
  readonly remoteCode?: string;
  readonly address?: DshSessionAddress;

  constructor(
    kind: DshHistoryErrorKind,
    message: string,
    details: { remoteCode?: string; address?: DshSessionAddress } = {},
  ) {
    super(message);
    this.name = 'DshHistoryError';
    this.kind = kind;
    if (details.remoteCode !== undefined) this.remoteCode = details.remoteCode;
    if (details.address !== undefined) this.address = details.address;
  }
}

/** Transport/remote codes that mean "re-authenticate and retry once". */
const AUTH_CODES = ['401', '403', 'unauthorized', 'unauthenticated', 'forbidden', 'permission-denied'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** HTTP-status-looking envelope values (401/403) reported by the transport. */
function authStatusOf(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const status = raw.status;
  if (typeof status === 'number') return status === 401 || status === 403;
  if (typeof status === 'string') return AUTH_CODES.includes(status.toLowerCase());
  return false;
}

function remoteErrorOf(raw: unknown): { code: string; message: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const result = raw.result;
  if (isRecord(result) && result.ok === false && isRecord(result.error)) {
    return {
      code: typeof result.error.code === 'string' ? result.error.code : 'unknown',
      message: typeof result.error.message === 'string' ? result.error.message : '',
    };
  }
  if (isRecord(raw.error) && typeof raw.error.code === 'string') {
    return { code: raw.error.code, message: '' };
  }
  return undefined;
}

function isAuthCode(code: string): boolean {
  const normalized = code.toLowerCase();
  return AUTH_CODES.some((candidate) => normalized.includes(candidate));
}

export function isDshAuthInvalidatedReply(raw: unknown): boolean {
  if (authStatusOf(raw)) return true;
  const remote = remoteErrorOf(raw);
  return remote !== undefined && isAuthCode(remote.code);
}

/**
 * Classify one raw `session/page` reply.
 *
 * Accepts both transport shapes seen in production: the unary envelope
 * (`{type:'server-response',rpcId,result:{ok:true,value}}`, docs/dsh.md §5) and
 * the bare `{records,hasMore}` value the injected bridge page source hands
 * over. Anything else — including a `client-request` carrying `payload.args` —
 * is rejected: a request never becomes a page by riding the same envelope.
 */
export function readDshHistoryPage(raw: unknown, address?: DshSessionAddress): DshHistoryPageReply {
  if (isDshAuthInvalidatedReply(raw)) {
    const remote = remoteErrorOf(raw);
    throw new DshHistoryError('auth-invalidated', 'dsh history page requires re-authorization (401/403)', {
      remoteCode: remote?.code,
      address,
    });
  }
  const remote = remoteErrorOf(raw);
  if (remote) {
    throw new DshHistoryError('remote-error', `dsh session/page failed: ${remote.code} ${remote.message}`.trim(), {
      remoteCode: remote.code,
      address,
    });
  }
  if (!isRecord(raw)) {
    throw new DshHistoryError('malformed-page', 'dsh history page is not an object', { address });
  }

  const value = isRecord(raw.result) && raw.result.ok === true ? raw.result.value : raw;
  if (!isRecord(value) || !Array.isArray(value.records)) {
    throw new DshHistoryError('malformed-page', 'dsh history page is missing its records', { address });
  }
  const records = value.records.filter((record): record is DshSessionRecord => isDshSessionRecordish(record));
  if (records.length !== value.records.length) {
    throw new DshHistoryError('malformed-page', 'dsh history page carries a record that is not {type:"event"}', {
      address,
    });
  }

  const reply: {
    records: readonly DshSessionRecord[];
    hasMore?: boolean;
    status?: number;
    cursor?: number;
  } = { records };
  // Read but deliberately not used to drive the walk (R6: hasMore measured false).
  if (typeof value.hasMore === 'boolean') reply.hasMore = value.hasMore;
  const envelopeCursor = typeof raw.cursor === 'number' ? raw.cursor : value.cursor;
  if (typeof envelopeCursor === 'number') reply.cursor = envelopeCursor;
  if (typeof raw.status === 'number') reply.status = raw.status;
  return reply;
}

/** `{type:'event', event:{type,seq,time,data}}` — the record envelope, not the frame. */
function isDshSessionRecordish(value: unknown): value is DshSessionRecord {
  if (!isRecord(value) || value.type !== 'event') return false;
  const event = value.event;
  if (!isRecord(event)) return false;
  return typeof event.type === 'string' && typeof event.seq === 'number' && typeof event.time === 'number';
}

// ---------------------------------------------------------------------------
// Subagent child-session discovery (session/list, session/tree when present)
// ---------------------------------------------------------------------------

export type DshSubagentMode = 'one-shot' | 'continuable' | 'unknown';

/** One `session/list` item (or tree node) as the pager needs it. */
export type DshHistorySessionItem = {
  readonly sessionId: string;
  readonly parentSession?: string;
  readonly mode?: DshSubagentMode;
};

export type DshChildMatch = 'parent' | 'prefix';

/** A child session resolved for paging, with how it was resolved. */
export type DshHistoryChild = {
  readonly sessionId: string;
  readonly mode: DshSubagentMode;
  readonly matched: DshChildMatch;
};

/**
 * Children of `parentSessionId`.
 *
 * Two resolution rules, both asserted in tests:
 *   - `parent` — the item names the parent (`parentSession === parentSessionId`);
 *   - `prefix` — the item's session id starts with the parent's (Metis #7).
 *
 * Parent links win over prefix matches, and a session never parents itself.
 */
export function matchDshChildSessions(
  parentSessionId: string,
  items: readonly DshHistorySessionItem[],
): readonly DshHistoryChild[] {
  const byParent: DshHistoryChild[] = [];
  const byPrefix: DshHistoryChild[] = [];
  const seen = new Set<string>([parentSessionId]);
  for (const item of items) {
    if (!isRecord(item) || typeof item.sessionId !== 'string' || item.sessionId.length === 0) continue;
    if (seen.has(item.sessionId)) continue;
    const mode: DshSubagentMode =
      item.mode === 'one-shot' || item.mode === 'continuable' ? item.mode : 'unknown';
    if (item.parentSession === parentSessionId) {
      seen.add(item.sessionId);
      byParent.push({ sessionId: item.sessionId, mode, matched: 'parent' });
      continue;
    }
    if (item.sessionId.startsWith(parentSessionId)) {
      seen.add(item.sessionId);
      byPrefix.push({ sessionId: item.sessionId, mode, matched: 'prefix' });
    }
  }
  return [...byParent, ...byPrefix];
}

/** Where a child structure came from. */
export type DshChildStructureSource = 'session/list' | 'session/tree';

export type DshHistoryChildAddress = {
  readonly address: Extract<DshSessionAddress, { kind: 'subagent' }>;
  readonly source: DshChildStructureSource;
  readonly matched: DshChildMatch;
  /**
   * The child's own watermark. A child is its own message space, so the parent
   * cursor says nothing about it; without a watermark the child is not paged
   * at all (the walk would be unbounded in a space nobody has measured).
   */
  readonly throughSeq?: number;
};

export async function resolveDshChildSessions(params: {
  sessionId: string;
  listSessions?: () => Promise<readonly DshHistorySessionItem[]>;
  /**
   * `session/tree` probe. Not on the verified endpoint list, so it is optional
   * and its absence is REPORTED instead of being papered over with the list.
   */
  probeTree?: () => Promise<readonly DshHistorySessionItem[]>;
}): Promise<{
  source: DshChildStructureSource;
  treeProbed: boolean;
  children: readonly Omit<DshHistoryChildAddress, 'throughSeq'>[];
}> {
  if (params.probeTree) {
    const nodes = await params.probeTree();
    return {
      source: 'session/tree',
      treeProbed: true,
      children: toChildAddresses(params.sessionId, nodes, 'session/tree'),
    };
  }
  const items = params.listSessions ? await params.listSessions() : [];
  return {
    source: 'session/list',
    treeProbed: false,
    children: toChildAddresses(params.sessionId, items, 'session/list'),
  };
}

function toChildAddresses(
  parentSessionId: string,
  items: readonly DshHistorySessionItem[],
  source: DshChildStructureSource,
): readonly Omit<DshHistoryChildAddress, 'throughSeq'>[] {
  return matchDshChildSessions(parentSessionId, items).map((child) => ({
    address: {
      kind: 'subagent' as const,
      parentSessionId,
      childSessionId: child.sessionId,
      mode: child.mode,
    },
    source,
    matched: child.matched,
  }));
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** Hard upper bound so a hostile page loop can never spin forever. */
export const DSH_HISTORY_MAX_PAGES = 100;

export type DshHistoryPageRequest = {
  readonly address: DshSessionAddress;
  /** Closed upper bound on records; never above the watermark (R6). */
  readonly throughSeq: number;
  /** Open upper bound (`seq < beforeSeq`); `cursor + 1` includes the cursor. */
  readonly beforeSeq: number;
  readonly limit?: number;
};

export type DshHistoryPageFetcher = (request: DshHistoryPageRequest) => Promise<unknown>;

export type DshHistoryNormalizeRequest = {
  /** One dimension's records, already merged and ordered oldest-first. */
  readonly records: readonly DshSessionRecord[];
  readonly address: DshSessionAddress;
};

export type DshHistoryNormalizeResult = {
  readonly entries?: readonly unknown[];
  readonly ops?: readonly DshNormalizeOp[];
};

export type DshHistoryNormalizer = (request: DshHistoryNormalizeRequest) => DshHistoryNormalizeResult;

/**
 * Adaptive → bounded settle wait.
 *
 * History must never be requested while the session is still loading, so the
 * pager waits instead of racing a live load. The wait is adaptive (short
 * backoff first, then longer) and always bounded: an unsettled load is
 * reported as `skipped: 'busy-timeout'` with zero pages issued rather than
 * silently publishing nothing.
 */
export type DshHistorySettleOptions = {
  readonly delaysMs?: readonly number[];
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_SETTLE_DELAYS: readonly number[] = [0, 2, 4, 8, 16, 32];
const DEFAULT_SETTLE_TIMEOUT_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true when the caller may issue its next page. */
export async function settleDshHistoryWait(
  isBusy: (() => boolean) | undefined,
  options: DshHistorySettleOptions | undefined,
): Promise<boolean> {
  if (!isBusy || !isBusy()) return true;
  const delays = options?.delaysMs ?? DEFAULT_SETTLE_DELAYS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const sleep = options?.sleep ?? defaultSleep;
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0);
    attempt += 1;
    if (!isBusy()) return true;
  }
  return !isBusy();
}

export type DshHistoryRecord = {
  readonly record: DshSessionRecord;
  /** Which message space the record belongs to (parent or child). */
  readonly sessionId: string;
  readonly address: DshSessionAddress;
};

export type DshHistorySkipReason = 'no-watermark' | 'superseded' | 'busy-timeout';

export type DshHistoryCollection = {
  /** loadHistory-ready entries, parent space first, then each child in order. */
  readonly entries: readonly unknown[];
  readonly records: readonly DshHistoryRecord[];
  readonly ops: readonly DshNormalizeOp[];
  readonly pages: number;
  /** True when the page cap (or a window moving the wrong way) bounded the walk. */
  readonly truncated: boolean;
  /** Lowest seq the walk reached (the next open upper bound). */
  readonly cursor: number;
  readonly childCount: number;
  readonly skipped?: DshHistorySkipReason;
};

export type DshHistoryLoadParams = {
  sessionId: string;
  /** Authoritative watermark (the snapshot cursor). Negative = no history yet. */
  throughSeq: number;
  fetchPage: DshHistoryPageFetcher;
  normalize?: DshHistoryNormalizer;
  /** Child addresses to page after the parent dimension. */
  childAddresses?: readonly DshHistoryChildAddress[];
  /** Gate: false leaves the children alone (the caller has its own hydration). */
  pageChildren?: boolean;
  /** Generation fence: `false` aborts before the first page. */
  isCurrent?: () => boolean;
  /** Live-load gate: the pager waits, it never races. */
  isBusy?: () => boolean;
  settle?: DshHistorySettleOptions;
  /** Fired once the busy wait resolved; the caller can now claim the flag. */
  onSettled?: () => void;
  /** 401/403 → refresh → retry the SAME window once, then surface the error. */
  refreshAuth?: () => Promise<void> | void;
  maxPages?: number;
  limit?: number;
};

/** Default mapping: the Todo 18 normalizer, one per dimension, then entries. */
export const normalizeDshHistoryPage: DshHistoryNormalizer = (request) => {
  const normalizer = createDshNormalizer({ address: request.address });
  const ops: DshNormalizeOp[] = [];
  for (const record of request.records) ops.push(...normalizer.ingest(record).ops);
  return { entries: entriesFromDshOps(ops), ops };
};

/** Flatten neutral ops into `{info, parts}` entries (the `loadHistory` shape). */
function entriesFromDshOps(ops: readonly DshNormalizeOp[]): unknown[] {
  const byMessage = new Map<string, { info: MessageInfo; parts: MessagePart[] }>();
  const entries: Array<{ info: MessageInfo; parts: MessagePart[] }> = [];
  for (const op of ops) {
    if (op.kind === 'message') {
      const info = op.message;
      const existing = byMessage.get(info.id);
      if (existing) {
        existing.info = info;
        continue;
      }
      const entry = { info, parts: [] };
      byMessage.set(info.id, entry);
      entries.push(entry);
      continue;
    }
    if (op.kind === 'part') {
      const part = op.part;
      const entry = byMessage.get(part.messageID);
      if (!entry) continue;
      const index = entry.parts.findIndex((existing) => existing.id === part.id);
      if (index < 0) entry.parts.push(part);
      else entry.parts[index] = part;
    }
  }
  return entries;
}

/** The single ordering dimension dsh exposes: the record's own `seq`. */
function dshRecordSeq(record: DshSessionRecord): number {
  return record.event.seq;
}

function sessionIdOf(address: DshSessionAddress): string {
  return address.kind === 'session' ? address.sessionId : address.childSessionId;
}

function emptyCollection(skipped: DshHistorySkipReason, childCount = 0): DshHistoryCollection {
  return { entries: [], records: [], ops: [], pages: 0, truncated: false, cursor: -1, childCount, skipped };
}

/**
 * Page one message space (the parent session, or one child session).
 *
 * Returns the merged, ordered records plus the walk outcome. The walk is
 * driven by the OPEN upper bound only — `hasMore` is deliberately unread here
 * because it was measured constant-false (task 7 R6).
 */
async function pageDshHistoryDimension(params: {
  address: DshSessionAddress;
  throughSeq: number;
  fetchPage: DshHistoryPageFetcher;
  maxPages: number;
  limit?: number;
  isCurrent?: () => boolean;
  isBusy?: () => boolean;
  settle?: DshHistorySettleOptions;
  onSettled?: () => void;
  refreshAuth?: () => Promise<void> | void;
}): Promise<
  | { ok: false; reason: DshHistorySkipReason; pages: number; truncated: boolean }
  | {
      ok: true;
      records: readonly DshSessionRecord[];
      pages: number;
      truncated: boolean;
      cursor: number;
    }
> {
  const address = params.address;
  const watermark = params.throughSeq;
  if (watermark < 0) return { ok: false, reason: 'no-watermark', pages: 0, truncated: false };

  const collected: DshSessionRecord[] = [];
  const seenKeys = new Set<number>();
  // Open upper bound: `+1` is what includes the watermark itself (R6).
  let beforeSeq = watermark + 1;
  let previousMaxKey = Number.POSITIVE_INFINITY;
  let pages = 0;
  let truncated = false;
  let settled = false;
  let refreshed = false;

  const fetchOnePage = async (request: DshHistoryPageRequest): Promise<DshHistoryPageReply> =>
    readDshHistoryPage(await params.fetchPage(request), address);

  while (pages < params.maxPages) {
    if (params.isCurrent && !params.isCurrent()) {
      return { ok: false, reason: 'superseded', pages, truncated };
    }
    // A live load owns the session: wait for it, never race it.
    const mayProceed = await settleDshHistoryWait(settled ? undefined : params.isBusy, params.settle);
    if (!mayProceed) {
      return { ok: false, reason: 'busy-timeout', pages, truncated };
    }
    if (!settled) {
      settled = true;
      params.onSettled?.();
    }
    if (params.isCurrent && !params.isCurrent()) {
      return { ok: false, reason: 'superseded', pages, truncated };
    }

    const request: DshHistoryPageRequest = {
      address,
      throughSeq: watermark,
      beforeSeq,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    };

    let reply: DshHistoryPageReply;
    try {
      reply = await fetchOnePage(request);
    } catch (error) {
      // Retry a mid-walk 401/403 exactly once; a refresh loop is worse than a
      // surfaced error, so the second invalidation propagates.
      const authInvalidated = error instanceof DshHistoryError && error.kind === 'auth-invalidated';
      if (!authInvalidated || refreshed || !params.refreshAuth) throw error;
      refreshed = true;
      await params.refreshAuth();
      reply = await fetchOnePage(request);
    }
    pages += 1;

    if (reply.records.length === 0) break;
    const keys = reply.records.map(dshRecordSeq);
    const minKey = Math.min(...keys);
    const maxKey = Math.max(...keys);
    // The window moved backwards past what we already have: the server ignored
    // the open upper bound, so stop instead of looping over the same records.
    if (maxKey > previousMaxKey) {
      truncated = true;
      break;
    }
    // A frozen window must not loop forever.
    if (minKey >= beforeSeq) break;

    for (const record of reply.records) {
      if (seenKeys.has(record.event.seq)) continue;
      seenKeys.add(record.event.seq);
      collected.push(record);
    }
    previousMaxKey = maxKey;
    beforeSeq = minKey;
  }
  if (pages >= params.maxPages && collected.length > 0) truncated = true;

  // Cumulative non-overlapping sort: pages arrive newest-first, the merged
  // history is oldest-first, and no key appears twice.
  const records = [...collected].sort((left, right) => dshRecordSeq(left) - dshRecordSeq(right));
  const cursor = records.length > 0 ? dshRecordSeq(records[0]!) : -1;
  return { ok: true, records, pages, truncated, cursor };
}

/**
 * Load a session's history (and, optionally, its subagent child histories).
 *
 * Nothing here opens a window, publishes a turn, or refreshes the tree: history
 * is replay. The caller publishes `entries` once the whole walk succeeded, so
 * a mid-walk failure never installs a truncated view.
 */
export async function loadDshHistory(params: DshHistoryLoadParams): Promise<DshHistoryCollection> {
  const maxPages = Math.max(1, params.maxPages ?? DSH_HISTORY_MAX_PAGES);
  const normalize = params.normalize ?? normalizeDshHistoryPage;
  const childAddresses = params.pageChildren ? (params.childAddresses ?? []) : [];

  const parent = await pageDshHistoryDimension({
    address: { kind: 'session', sessionId: params.sessionId },
    throughSeq: params.throughSeq,
    fetchPage: params.fetchPage,
    maxPages,
    limit: params.limit,
    isCurrent: params.isCurrent,
    isBusy: params.isBusy,
    settle: params.settle,
    onSettled: params.onSettled,
    refreshAuth: params.refreshAuth,
  });
  if (!parent.ok) {
    return parent.reason === 'no-watermark'
      ? emptyCollection('no-watermark')
      : emptyCollection(parent.reason);
  }

  const entries: unknown[] = [];
  const ops: DshNormalizeOp[] = [];
  const records: DshHistoryRecord[] = [];
  let childCount = 0;
  const parentSessionId = sessionIdOf({ kind: 'session', sessionId: params.sessionId });

  if (parent.records.length > 0) {
    const normalized = normalize({ records: parent.records, address: { kind: 'session', sessionId: params.sessionId } });
    if (normalized.entries) entries.push(...normalized.entries);
    if (normalized.ops) ops.push(...normalized.ops);
    for (const record of parent.records) {
      records.push({ record, sessionId: parentSessionId, address: { kind: 'session', sessionId: params.sessionId } });
    }
  }

  for (const child of childAddresses) {
    const dimension = await pageDshHistoryDimension({
      address: child.address,
      throughSeq: child.throughSeq ?? -1,
      fetchPage: params.fetchPage,
      maxPages,
      limit: params.limit,
      isCurrent: params.isCurrent,
      isBusy: params.isBusy,
      settle: params.settle,
      onSettled: params.onSettled,
      refreshAuth: params.refreshAuth,
    });
    if (!dimension.ok) continue;
    childCount += 1;
    if (dimension.records.length === 0) continue;
    const normalized = normalize({ records: dimension.records, address: child.address });
    if (normalized.entries) entries.push(...normalized.entries);
    if (normalized.ops) ops.push(...normalized.ops);
    const childSessionId = sessionIdOf(child.address);
    for (const record of dimension.records) {
      records.push({ record, sessionId: childSessionId, address: child.address });
    }
  }

  return {
    entries,
    records,
    ops,
    pages: parent.pages,
    truncated: parent.truncated,
    cursor: parent.cursor,
    childCount,
  };
}

export type { DshJsonValue, DshSessionAddress, DshSessionRecord };
