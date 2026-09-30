/**
 * dsh web session-history paging tests (plan Todo 26).
 *
 * Record shapes are FIXTURE-DRIVEN: they come verbatim from the captured
 * dsh@0.2.0-rc.2 `session/follow` snapshot (`wire-session-follow-snapshot.jsonl`,
 * version-gated by `./fixtures`), which carries the same `{type:'event',
 * event:{...}}` record vocabulary `session/page` returns (docs/dsh.md §8.2).
 * The `session/page` REPLY ENVELOPE is SCHEMA-DRIVEN (the capture holds no page
 * *reply* — only `wire-mux-error.jsonl`'s failing page *open*): it follows
 * `docs/dsh.md` §5 (`{type:'server-response',result:{ok,value}}`) and the
 * `DshSessionPageResult` contract in `./types`.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadDshWireFixture } from './fixtures';
import {
  DshHistoryError,
  DSH_HISTORY_MAX_PAGES,
  loadDshHistory,
  matchDshChildSessions,
  readDshHistoryPage,
  resolveDshChildSessions,
  type DshHistoryPageReply,
} from './history';
import { createDshNormalizer } from './normalize';
import type { DshNormalizeOp } from './ops';
import type { DshSessionAddress, DshSessionRecord, DshSessionWireEvent } from './types';

const SESSION_ID = 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf';
const CHILD_SESSION_ID = 'session-4d0e6409-6de0-4cb5-a6b0-de3c6d54b7c1';
const CHILD_CURSOR = 3;
/** Metis #7 prefix addressing: a child id that begins with the parent's. */
const PREFIXED_CHILD_SESSION_ID = SESSION_ID + '-agent-0';

const snapshot = (() => {
  const frame = loadDshWireFixture('wire-session-follow-snapshot.jsonl').frames[0];
  const value = frame.type === 'item' ? frame.value : frame;
  if (!value || typeof value !== 'object') throw new Error('fixture frame is missing');
  return value as { cursor: number; records: readonly DshSessionRecord[] };
})();

/** Real captured records in wire order. */
const RECORDS: readonly DshSessionRecord[] = snapshot.records;
const CURSOR = snapshot.cursor;

/** A window of the captured records: `[lowest, below)` by seq, ascending. */
function windowOf(lowest: number, below: number): readonly DshSessionRecord[] {
  return RECORDS.filter((record) => record.event.seq >= lowest && record.event.seq < below);
}

/** Every seq the walker must finally have collected, oldest first. */
const ALL_SEQS = RECORDS.map((record) => record.event.seq);

/**
 * A schema-driven paging server over synthetic records, used where the walk
 * must exceed the captured fixture (page-cap / truncation assertions).
 */
function syntheticSeqRecords(from: number, count: number): readonly DshSessionRecord[] {
  const template = RECORDS.find((record) => record.event.type === 'user/message');
  if (!template) throw new Error('fixture has no user/message record');
  const records: DshSessionRecord[] = [];
  for (let seq = from; seq < from + count; seq += 1) {
    records.push({
      type: 'event',
      event: { ...template.event, seq, time: 1790692597000 + seq } as unknown as DshSessionWireEvent,
    });
  }
  return records;
}

/** Pages `size` records at a time, always ending at the incoming beforeSeq. */
function pagedServer(total: number, size: number) {
  const records = [...syntheticSeqRecords(0, total)];
  return (request: PageRequest) =>
    pageReply(records.filter((record) => record.event.seq < request.beforeSeq).slice(-size), true);
}

function subagentAddress(overrides: Partial<Extract<DshSessionAddress, { kind: 'subagent' }>> = {}) {
  return {
    kind: 'subagent',
    parentSessionId: SESSION_ID,
    childSessionId: CHILD_SESSION_ID,
    mode: 'one-shot',
    ...overrides,
  } as const satisfies Extract<DshSessionAddress, { kind: 'subagent' }>;
}

function sessionAddress(sessionId = SESSION_ID) {
  return { kind: 'session', sessionId } as const satisfies DshSessionAddress;
}

/** The captured terminal record recast with the `aborted` reason (Todo 18). */
function abortedTurnEnd(seq: number, turn: number, time: number): DshSessionRecord {
  const template = RECORDS.find((record) => record.event.type === 'turn/end');
  if (!template) throw new Error('fixture has no turn/end record');
  return {
    type: 'event',
    event: {
      ...template.event,
      type: 'turn/end',
      seq,
      time,
      data: { turn, reason: { kind: 'aborted' } },
    } as unknown as DshSessionWireEvent,
  };
}

/** Schema-driven unary reply envelope (docs/dsh.md §5). */
function unaryReply(value: unknown, envelope: Record<string, unknown> = {}): unknown {
  return { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value }, ...envelope };
}

function pageReply(
  records: readonly DshSessionRecord[],
  hasMore = false,
  envelope: Record<string, unknown> = {},
): unknown {
  return unaryReply({ records, hasMore }, envelope);
}

/** A never-resolving sleep proves an unsettled wait never issues a page. */
function neverSleep() {
  return vi.fn(() => new Promise<void>(() => {}));
}

type PageRequest = { address: DshSessionAddress; beforeSeq: number; throughSeq: number };

function createHarness(
  handler: (request: PageRequest, call: number) => unknown,
  normalize: NonNullable<Parameters<typeof loadDshHistory>[0]['normalize']> = () => ({ entries: [] }),
) {
  const requests: PageRequest[] = [];
  const fetch = vi.fn(async (request: PageRequest) => {
    const call = requests.length;
    requests.push(request);
    return handler(request, call);
  });
  return { requests, fetch, normalize };
}

/** Flatten normalized ops into `{info, parts}` entries the way `history.ts` must. */
function entriesFromOps(ops: readonly Record<string, unknown>[]) {
  const byMessage = new Map<string, { info: unknown; parts: unknown[] }>();
  const entries: Array<{ info: unknown; parts: unknown[] }> = [];
  for (const op of ops) {
    if (op.kind === 'message') {
      const info = op.message as { id: string };
      const entry = { info, parts: [] };
      byMessage.set(info.id, entry);
      entries.push(entry);
      continue;
    }
    if (op.kind === 'part') {
      const part = op.part as { id: string; messageID: string };
      const entry = byMessage.get(part.messageID);
      if (entry && !entry.parts.some((existing) => (existing as { id: string }).id === part.id)) {
        entry.parts.push(part);
      }
    }
  }
  return entries;
}

describe('dsh history — session/page envelope classification', () => {
  it('reads records as data and status/cursor/hasMore as envelope', () => {
    const page: DshHistoryPageReply = readDshHistoryPage(
      pageReply(RECORDS.slice(0, 4), false, { status: 200, cursor: CURSOR }),
    );
    expect(page.records.map((record) => record.event.seq)).toEqual([0, 1, 2, 3]);
    expect(page.hasMore).toBe(false);
    expect(page.status).toBe(200);
    expect(page.cursor).toBe(CURSOR);
    // Nothing but those four fields exists: the envelope never doubles as data.
    expect(Object.keys(page).sort()).toEqual(['cursor', 'hasMore', 'records', 'status']);
  });

  it('rejects a reply that smuggles records under an envelope-only field', () => {
    for (const field of ['status', 'cursor', 'hasMore']) {
      expect(() => readDshHistoryPage({ [field]: RECORDS })).toThrowError(
        expect.objectContaining({ name: 'DshHistoryError', kind: 'malformed-page' }),
      );
    }
  });

  it('rejects a request envelope carrying args where a page value belongs', () => {
    // L14: the same method with different args means a different thing — a
    // request never becomes a page just because it rides the same envelope.
    expect(() =>
      readDshHistoryPage({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'session/page',
        payload: { args: { request: { address: { kind: 'session', sessionId: SESSION_ID } } } },
      }),
    ).toThrowError(expect.objectContaining({ name: 'DshHistoryError', kind: 'malformed-page' }));
  });

  it('surfaces a remote page error with its code', () => {
    try {
      readDshHistoryPage({
        type: 'server-response',
        rpcId: 'rpc-1',
        result: { ok: false, error: { code: 'gateway/bad-request', message: 'session/page through seq past cursor' } },
      });
      expect.unreachable('a failing page reply must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DshHistoryError);
      expect((error as DshHistoryError).kind).toBe('remote-error');
      expect((error as DshHistoryError).remoteCode).toBe('gateway/bad-request');
    }
  });
});

describe('dsh history — cursor paging', () => {
  it('walks windows backwards with an open upper bound and a bounded throughSeq', async () => {
    const harness = createHarness((request) =>
      request.beforeSeq <= 8
        ? pageReply(windowOf(0, 8), false)
        : pageReply(windowOf(8, request.beforeSeq), false),
    );

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      maxPages: 10,
    });

    expect(harness.requests).toEqual([
      { address: sessionAddress(), beforeSeq: CURSOR + 1, throughSeq: CURSOR },
      { address: sessionAddress(), beforeSeq: 8, throughSeq: CURSOR },
      { address: sessionAddress(), beforeSeq: 0, throughSeq: CURSOR },
    ]);
    expect(collection.pages).toBe(3);
    expect(collection.truncated).toBe(false);
    // Cumulative non-overlapping sort: the merged history is oldest-first.
    expect(collection.records.map((entry) => entry.record.event.seq)).toEqual(ALL_SEQS);
    expect(collection.cursor).toBe(0);
    expect(collection.skipped).toBeUndefined();
  });

  it('ignores hasMore entirely: a true flag with an empty window stops the walk', async () => {
    const harness = createHarness(() => pageReply([], true));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
    });

    expect(harness.fetch).toHaveBeenCalledTimes(1);
    expect(collection.pages).toBe(1);
    expect(collection.truncated).toBe(false);
    expect(collection.records).toHaveLength(0);
  });

  it('ignores hasMore entirely: a false flag with records does not end the walk', async () => {
    const harness = createHarness(() => pageReply(windowOf(0, 4), false));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
    });

    expect(harness.fetch.mock.calls.length).toBeGreaterThan(1);
    expect(harness.requests[1]?.beforeSeq).toBe(0);
    expect(collection.truncated).toBe(false);
  });

  it('stops on a frozen window instead of looping forever', async () => {
    const harness = createHarness(() => pageReply(windowOf(0, 4), true));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
    });

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(collection.truncated).toBe(false);
  });

  it('reports a bounded history when the page cap is reached', async () => {
    const harness = createHarness(pagedServer(400, 4));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: 399,
      fetchPage: harness.fetch,
      maxPages: 3,
    });

    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(collection.pages).toBe(3);
    expect(collection.truncated).toBe(true);
  });

  it('never pages a session whose go state has no history yet', async () => {
    const harness = createHarness(() => pageReply(RECORDS, false));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: -1,
      fetchPage: harness.fetch,
    });

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(collection.pages).toBe(0);
    expect(collection.records).toHaveLength(0);
    expect(collection.skipped).toBe('no-watermark');
  });

  it('clamps the first window to the watermark instead of paging above it', async () => {
    const harness = createHarness(() => pageReply([], false));

    await loadDshHistory({ sessionId: SESSION_ID, throughSeq: CURSOR, fetchPage: harness.fetch });

    expect(harness.requests).toEqual([
      { address: sessionAddress(), beforeSeq: CURSOR + 1, throughSeq: CURSOR },
    ]);
  });

  it('surfaces a malformed page instead of publishing a partial history', async () => {
    const harness = createHarness((_request, call) =>
      call === 0 ? pageReply(windowOf(4, 18), false) : { records: 'not-an-array' },
    );

    await expect(
      loadDshHistory({ sessionId: SESSION_ID, throughSeq: CURSOR, fetchPage: harness.fetch }),
    ).rejects.toBeInstanceOf(DshHistoryError);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
  });

  it('drops a whole superseded walk without fetching a single page', async () => {
    const harness = createHarness(() => pageReply(windowOf(8, 18), false));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      isCurrent: () => false,
    });

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(collection.records).toHaveLength(0);
    expect(collection.skipped).toBe('superseded');
  });

  it('defaults to a bounded page cap rather than an unbounded walk', async () => {
    const harness = createHarness(pagedServer(400, 4));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: 399,
      fetchPage: harness.fetch,
    });

    expect(harness.fetch).toHaveBeenCalledTimes(DSH_HISTORY_MAX_PAGES);
    expect(collection.pages).toBe(DSH_HISTORY_MAX_PAGES);
    expect(collection.truncated).toBe(true);
  });
});

describe('dsh history — smart waiting around a live load', () => {
  it('does not issue loadHistory while the session is still loading', async () => {
    let busy = true;
    const harness = createHarness(() => pageReply(windowOf(0, 4), false));

    const pending = loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      isBusy: () => busy,
      settle: {
        delaysMs: [1, 2],
        timeoutMs: 100,
        sleep: async () => {
          await Promise.resolve();
        },
      },
    });

    // Still loading: the pager must not have issued a single page request.
    expect(harness.fetch).not.toHaveBeenCalled();
    busy = false;
    const collection = await pending;

    expect(harness.fetch).toHaveBeenCalled();
    expect(collection.pages).toBeGreaterThan(0);
  });

  it('abandons a load that never settles inside the bounded wait', async () => {
    const harness = createHarness(() => pageReply(windowOf(0, 4), false));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      isBusy: () => true,
      settle: { delaysMs: [1, 1, 1], timeoutMs: 0, sleep: neverSleep() },
    });

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(collection.pages).toBe(0);
    expect(collection.records).toHaveLength(0);
    expect(collection.skipped).toBe('busy-timeout');
  });
});

describe('dsh history — authorization-invalidated refresh', () => {
  it('refreshes once and retries the same window', async () => {
    let unauthorized = true;
    const harness = createHarness(() => {
      if (unauthorized) {
        unauthorized = false;
        return {
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: false, error: { code: 'gateway/unauthorized', message: '401' } },
        };
      }
      return pageReply(windowOf(0, 4), false);
    });
    const refreshAuth = vi.fn(async () => {});

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      refreshAuth,
    });

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(3);
    expect(harness.requests[1]).toEqual(harness.requests[0]);
    expect(collection.records.map((entry) => entry.record.event.seq)).toEqual([0, 1, 2, 3]);
  });

  it('surfaces an error when authorization stays invalid after the refresh', async () => {
    const harness = createHarness(() => ({ status: 403 }));
    const refreshAuth = vi.fn(async () => {});

    await expect(
      loadDshHistory({ sessionId: SESSION_ID, throughSeq: CURSOR, fetchPage: harness.fetch, refreshAuth }),
    ).rejects.toBeInstanceOf(DshHistoryError);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(harness.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('dsh history — subagent child session addressing', () => {
  it('maps child records to subagent content instead of interleaving them', async () => {
    const address = subagentAddress();
    const harness = createHarness((request) =>
      request.address.kind === 'session'
        ? pageReply(windowOf(8, 12), false)
        : pageReply(windowOf(0, 4), false),
    );

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      childAddresses: [
        { address, source: 'session/list', matched: 'parent', throughSeq: CHILD_CURSOR },
      ],
      pageChildren: true,
    });

    // L14: the same method with different args addresses a different space.
    expect(harness.requests[0]?.address).toEqual(sessionAddress());
    const childRequests = harness.requests.filter((request) => request.address.kind === 'subagent');
    expect(childRequests[0]?.address).toEqual(address);
    expect(childRequests[0]?.beforeSeq).toBe(CHILD_CURSOR + 1);
    expect(childRequests[0]?.throughSeq).toBe(CHILD_CURSOR);

    const parentSeqs = collection.records
      .filter((entry) => entry.sessionId === SESSION_ID)
      .map((entry) => entry.record.event.seq);
    const childSeqs = collection.records
      .filter((entry) => entry.sessionId === CHILD_SESSION_ID)
      .map((entry) => entry.record.event.seq);
    // The child never lands in the parent's message space.
    expect(parentSeqs).toEqual([8, 9, 10, 11]);
    expect(childSeqs).toEqual([0, 1, 2, 3]);
    expect(collection.childCount).toBe(1);
  });

  it('keeps the aborted terminal of a child turn (Todo 18 terminal mapping)', async () => {
    const address = subagentAddress();
    const harness = createHarness((request) =>
      request.address.kind === 'session' ? pageReply(windowOf(8, 12), false) : pageReply(windowOf(0, 4), false),
    );

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      childAddresses: [
        { address, source: 'session/list', matched: 'parent', throughSeq: CHILD_CURSOR },
      ],
      pageChildren: true,
      normalize: (request) => {
        const normalizer = createDshNormalizer({ address: request.address });
        const ops: DshNormalizeOp[] = [];
        for (const record of request.records) ops.push(...normalizer.ingest(record).ops);
        if (request.address.kind === 'subagent') {
          ops.push(...normalizer.ingest(abortedTurnEnd(4, 1, 1790692597000)).ops);
        }
        return { ops, entries: entriesFromOps(ops) };
      },
    });

    const terminal = collection.ops.find((op) => op.kind === 'subagent' && op.phase === 'terminal');
    expect(terminal).toMatchObject({
      parentSessionId: SESSION_ID,
      childSessionId: CHILD_SESSION_ID,
      mode: 'one-shot',
    });
    expect((terminal as { reason: { kind: string } }).reason.kind).toBe('aborted');
    const childEntries = collection.entries.filter((entry) => {
      const info = (entry as { info?: { sessionID?: string } }).info;
      return info?.sessionID === CHILD_SESSION_ID;
    });
    expect(childEntries.length).toBeGreaterThan(0);
  });

  it('never pages a child whose own watermark is unknown', async () => {
    const harness = createHarness(() => pageReply(windowOf(8, 12), false));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      childAddresses: [{ address: subagentAddress(), source: 'session/list', matched: 'parent' }],
      pageChildren: true,
    });

    expect(harness.requests.every((request) => request.address.kind === 'session')).toBe(true);
    expect(collection.childCount).toBe(0);
  });
});

describe('dsh history — session/list and session/tree probing', () => {
  it('matches children by parent link and by session id prefix', () => {
    const matched = matchDshChildSessions(SESSION_ID, [
      { sessionId: SESSION_ID },
      { sessionId: CHILD_SESSION_ID, parentSession: SESSION_ID },
      { sessionId: PREFIXED_CHILD_SESSION_ID },
      { sessionId: 'session-unrelated', parentSession: 'someone-else' },
    ]);

    expect(matched).toEqual([
      { sessionId: CHILD_SESSION_ID, mode: 'unknown', matched: 'parent' },
      { sessionId: PREFIXED_CHILD_SESSION_ID, mode: 'unknown', matched: 'prefix' },
    ]);
  });

  it('reports the tree probe as unavailable instead of fabricating a structure', async () => {
    const resolved = await resolveDshChildSessions({
      sessionId: SESSION_ID,
      listSessions: async () => [{ sessionId: CHILD_SESSION_ID, parentSession: SESSION_ID }],
    });

    expect(resolved.source).toBe('session/list');
    expect(resolved.treeProbed).toBe(false);
    expect(resolved.children).toEqual([
      {
        address: subagentAddress({ mode: 'unknown' }),
        source: 'session/list',
        matched: 'parent',
      },
    ]);
  });

  it('prefers the tree structure when the endpoint answers', async () => {
    const resolved = await resolveDshChildSessions({
      sessionId: SESSION_ID,
      listSessions: async () => [],
      probeTree: async () => [
        { sessionId: CHILD_SESSION_ID, parentSession: SESSION_ID, mode: 'continuable' },
      ],
    });

    expect(resolved.source).toBe('session/tree');
    expect(resolved.treeProbed).toBe(true);
    expect(resolved.children[0]?.address.mode).toBe('continuable');
    expect(resolved.children[0]?.matched).toBe('parent');
  });
});

describe('dsh history — replay safety', () => {
  it('normalizes the parent dimension as a session address', async () => {
    const phases: string[] = [];
    const harness = createHarness(() => pageReply(windowOf(0, 4), false), (request) => {
      phases.push(request.address.kind);
      return { entries: [] };
    });

    await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      normalize: harness.normalize,
    });

    expect(phases).toEqual(['session']);
  });

  it('normalizes each child window through the child address', async () => {
    const phases: string[] = [];
    const harness = createHarness(
      (request) =>
        request.address.kind === 'session'
          ? pageReply(windowOf(8, 12), false)
          : pageReply(windowOf(0, 2), false),
      (request) => {
        phases.push(request.address.kind);
        return { entries: [] };
      },
    );

    await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
      normalize: harness.normalize,
      childAddresses: [
        { address: subagentAddress(), source: 'session/list', matched: 'parent', throughSeq: CHILD_CURSOR },
      ],
      pageChildren: true,
    });

    expect(phases).toEqual(['session', 'subagent']);
  });

  it('maps real captured records into loadHistory entries through the default path', async () => {
    const harness = createHarness(() => pageReply(windowOf(0, 4), false));

    const collection = await loadDshHistory({
      sessionId: SESSION_ID,
      throughSeq: CURSOR,
      fetchPage: harness.fetch,
    });

    const infos = collection.entries.map(
      (entry) => (entry as { info: { id: string; sessionID: string; role: string } }).info,
    );
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.every((info) => info.sessionID === SESSION_ID)).toBe(true);
    expect(infos.map((info) => info.id)).toContain('ec747195-c21f-4de7-9df6-fcbf4ff4e75b');
  });
});
