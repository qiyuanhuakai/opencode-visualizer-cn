import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import {
  ProtocolError,
  requireValue,
  textValue,
  integerValue,
} from '../../../shared/runtime/capabilities.js';
import { normalizeCodexTurnsToHistory } from '../../../shared/runtime/native/codex/normalize.js';
import { tokenizeHistoryJson } from '../historyJsonStream.js';
import { redactHistoryJson } from '../historyPrivacy.js';

const MAX_PAGE = 2 * 1024 * 1024;
const CHUNK = 64 * 1024;

/** Pages native items, never thread/read(includeTurns). Cursors retain no resident transcript. */
export function createCodexHistory({ request, processGeneration, epoch, assertCurrent }) {
  const key = randomBytes(32);
  function sign(state) {
    const body = Buffer.from(JSON.stringify(state)).toString('base64url');
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  }
  function decode(cursor, session) {
    requireValue(typeof cursor === 'string' && cursor.length < 16384, 'codex.history.cursor');
    const [body, signature] = cursor.split('.');
    const actual = Buffer.from(signature ?? '', 'base64url');
    const expected = createHmac('sha256', key).update(body).digest();
    requireValue(
      actual.length === expected.length && timingSafeEqual(actual, expected),
      'codex.history.cursor',
      'replay_required',
    );
    let state;
    try {
      state = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      throw new ProtocolError('invalid_request', 'codex.history.cursor');
    }
    requireValue(
      state.session === encodeSessionKey(session) &&
        state.generation === processGeneration &&
        state.epoch === epoch &&
        state.expires > Date.now(),
      'codex.history.scope',
      'replay_required',
    );
    return state;
  }
  const cursorValue = (page) => {
    const cursor = page.nextCursor ?? null;
    requireValue(cursor === null || typeof cursor === 'string', 'codex.history.native_cursor');
    return cursor;
  };
  return async function readHistoryPage({ session, cursor = null, limit = 200 }) {
    assertCurrent();
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'codex.history.limit');
    const state = cursor
      ? decode(cursor, session)
      : {
          session: encodeSessionKey(session),
          generation: processGeneration,
          epoch,
          expires: Date.now() + 60000,
          turnCursor: null,
          turn: null,
          itemCursor: null,
          parent: null,
          offset: 0,
          digest: null,
          turnSeen: [],
          itemSeen: [],
          pages: 0,
        };
    const remember = (list, value) => {
      if (!value) return list;
      const digest = createHmac('sha256', key).update(value).digest('hex').slice(0, 16);
      requireValue(!list.includes(digest), 'codex.history.repeated_cursor', 'reconcile_required');
      return [...list.slice(-127), digest];
    };
    try {
      requireValue(state.pages < 100000, 'codex.history.page_budget', 'reconcile_required');
      if (!state.turn) {
        const page = await request('thread/turns/list', {
          threadId: session.nativeSessionId,
          cursor: state.turnCursor,
          limit: 1,
          sortDirection: 'asc',
          itemsView: 'notLoaded',
        });
        assertCurrent();
        requireValue(Array.isArray(page.data) && page.data.length <= 1, 'codex.history.turn_page');
        if (!page.data.length) {
          requireValue(!page.nextCursor, 'codex.history.empty_progress', 'reconcile_required');
          return { items: [], cursor: null, completeness: 'complete' };
        }
        const turn = page.data[0];
        requireValue(
          typeof turn.id === 'string' && (!turn.items || turn.items.length === 0),
          'codex.history.metadata',
        );
        const next = cursorValue(page);
        requireValue(
          !next || next !== state.turnCursor,
          'codex.history.turn_progress',
          'reconcile_required',
        );
        state.turn = {
          id: turn.id,
          status: turn.status,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          createdAt: turn.createdAt,
        };
        state.turnSeen = remember(state.turnSeen, next);
        state.nextTurnCursor = next;
      }
      // One native item bounds amplification; a single oversize native frame fails explicitly in the client.
      const page = await request('thread/items/list', {
        threadId: session.nativeSessionId,
        turnId: state.turn.id,
        cursor: state.itemCursor,
        limit: 1,
        sortDirection: 'asc',
      });
      assertCurrent();
      requireValue(Array.isArray(page.data) && page.data.length <= 1, 'codex.history.item_page');
      const nextItem = cursorValue(page);
      requireValue(
        !nextItem || (page.data.length > 0 && nextItem !== state.itemCursor),
        'codex.history.item_progress',
        'reconcile_required',
      );
      const next = {
        ...state,
        offset: 0,
        digest: null,
        pages: state.pages + 1,
        itemSeen: remember(state.itemSeen, nextItem),
      };
      let payload = null;
      if (page.data.length) {
        const entry = page.data[0];
        requireValue(
          entry.turnId === state.turn.id && typeof entry.item?.id === 'string',
          'codex.history.item_scope',
        );
        const canonical = normalizeCodexTurnsToHistory({
          sessionId: session.nativeSessionId,
          turns: [{ ...state.turn, items: [entry.item] }],
          createdAt: entry.startedAtMs ?? 0,
          parentMessageId: state.parent ?? undefined,
        });
        for (const message of canonical)
          if (message.info.role === 'user') next.parent = message.info.id;
        payload = {
          turnId: entry.turnId,
          native: entry.item,
          canonical,
          startedAtMs: entry.startedAtMs ?? null,
          completedAtMs: entry.completedAtMs ?? null,
        };
      }
      if (nextItem) next.itemCursor = nextItem;
      else {
        next.turnCursor = state.nextTurnCursor;
        next.turn = null;
        next.itemCursor = null;
        next.itemSeen = [];
      }
      const more = Boolean(nextItem || state.nextTurnCursor);
      const serialized = Buffer.from(JSON.stringify(payload));
      if (payload && serialized.length > MAX_PAGE - 32768) {
        const digest = createHmac('sha256', key).update(serialized).digest('hex');
        requireValue(
          !state.digest || state.digest === digest,
          'codex.history.changed_item',
          'replay_required',
        );
        const end = Math.min(serialized.length, state.offset + CHUNK);
        const cursor =
          end < serialized.length
            ? sign({ ...state, offset: end, digest })
            : more
              ? sign(next)
              : null;
        return {
          items: [],
          chunk: {
            format: 'json-utf8-base64',
            data: serialized.subarray(state.offset, end).toString('base64'),
            offset: state.offset,
            totalBytes: serialized.length,
            digest,
          },
          cursor,
          completeness: cursor ? 'partial' : 'complete',
        };
      }
      requireValue(state.offset === 0, 'codex.history.changed_item', 'replay_required');
      return {
        items: payload ? [payload] : [],
        cursor: more ? sign(next) : null,
        completeness: more ? 'partial' : 'complete',
      };
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'unsupported')
        return { items: [], cursor: null, completeness: 'unsupported', reason: error.field };
      throw error;
    }
  };
}

const RAW_CHUNK_BYTES = 65536;

const RAW_ITEM_GRAMMAR = Object.freeze({
  records: Object.freeze([
    Object.freeze({
      path: Object.freeze(['result', 'data', '*']),
      fields: Object.freeze([
        Object.freeze({ name: 'itemId', path: Object.freeze(['item', 'id']) }),
        Object.freeze({ name: 'turnId', path: Object.freeze(['turnId']) }),
        Object.freeze({ name: 'startedAtMs', path: Object.freeze(['startedAtMs']) }),
        Object.freeze({ name: 'completedAtMs', path: Object.freeze(['completedAtMs']) }),
      ]),
      validate(metadata) {
        textValue(metadata.turnId, 'codex.history_turn');
        return textValue(metadata.itemId, 'codex.history_record_id');
      },
    }),
  ]),
  fields: Object.freeze([]),
  validate() {},
});

function* rechunk(piece) {
  for (let offset = 0; offset < piece.byteLength; offset += RAW_CHUNK_BYTES) {
    const length = Math.min(RAW_CHUNK_BYTES, piece.byteLength - offset);
    const slice = new Uint8Array(length);
    slice.set(piece.subarray(offset, offset + length));
    yield slice;
  }
}

/** Selected-history producer for one Codex session. `requestHistory` is the trusted, history-only raw
 * `thread/items/list` admission injected by the driver; the frame is fed to the bounded substrate before
 * any line assembly, filtered by the configured secret policy before a spool byte is written.
 */
export function createCodexHistoryStream(options) {
  const { session, request, requestHistory, processGeneration, assertCurrent, randomUUID } = options;
  const secrets = (options.secrets ?? []).filter((value) => typeof value === 'string' && value.length);
  const threadId = textValue(session.nativeSessionId, 'codex.history_session');
  const pages = new Set();
  const state = {
    turnCursor: null,
    nextTurnCursor: null,
    turn: null,
    itemCursor: null,
    lastNative: undefined,
  };
  let store,
    opened = false,
    closed = false,
    nativeCursor = null;
  function alive(signal) {
    requireValue(!closed, 'codex.history_closed', 'cancelled');
    requireValue(!signal?.aborted, 'codex.history_cancelled', 'cancelled');
  }
  async function fenced(signal) {
    alive(signal);
    await assertCurrent();
    alive(signal);
  }
  async function* redactedSource(stream, signal) {
    async function* raw() {
      for await (const chunk of stream) yield* rechunk(chunk);
    }
    for await (const token of redactHistoryJson(tokenizeHistoryJson(raw(), { signal }), {
      secrets,
      signal,
    }))
      yield token.raw;
  }
  async function open({ signal, streamStore }) {
    requireValue(!opened && !closed, 'codex.history_open', 'conflict');
    await fenced(signal);
    opened = true;
    store = streamStore;
    return { fence: { id: randomUUID(), sourceGeneration: processGeneration } };
  }
  async function page({ cursor, releasePageIds = [], signal }) {
    await fenced(signal);
    requireValue(opened && store, 'codex.history_open', 'replay_required');
    requireValue(Array.isArray(releasePageIds), 'codex.history_release');
    for (const id of releasePageIds) {
      textValue(id, 'codex.history_page');
      requireValue(pages.has(id), 'codex.history_page_owner', 'unauthorized');
      await store.release(id);
      pages.delete(id);
    }
    await fenced(signal);
    const before = cursor === undefined || cursor === null ? null : textValue(cursor, 'codex.history_cursor');
    requireValue(before === null || before === nativeCursor, 'codex.history_cursor', 'replay_required');
    if (!state.turn) {
      const turns = await request('thread/turns/list', {
        threadId,
        cursor: state.turnCursor,
        limit: 1,
        sortDirection: 'asc',
        itemsView: 'notLoaded',
      });
      await fenced(signal);
      requireValue(Array.isArray(turns?.data) && turns.data.length <= 1, 'codex.history.turn_page');
      if (!turns.data.length) {
        requireValue(!turns.nextCursor, 'codex.history.empty_progress', 'reconcile_required');
        return {
          pageId: randomUUID(),
          items: [],
          cursor: null,
          completeness: 'complete',
          reason: 'codex-raw-item-page',
        };
      }
      const turn = turns.data[0];
      requireValue(
        typeof turn.id === 'string' && (!turn.items || turn.items.length === 0),
        'codex.history_metadata',
      );
      const nextTurnCursor = turns.nextCursor ?? null;
      requireValue(
        nextTurnCursor === null || nextTurnCursor !== state.turnCursor,
        'codex.history.turn_progress',
        'reconcile_required',
      );
      state.turn = {
        id: turn.id,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        createdAt: turn.createdAt,
      };
      state.nextTurnCursor = nextTurnCursor;
    }
    const raw = requestHistory('thread/items/list', {
      threadId,
      turnId: state.turn.id,
      cursor: state.itemCursor,
      limit: 1,
      sortDirection: 'asc',
    });
    const output = await store.ingest({
      source: redactedSource(raw.stream, signal),
      cancel: () => {
        void raw.stream.return?.();
      },
      grammar: RAW_ITEM_GRAMMAR,
      signal,
    });
    await fenced(signal);
    const envelope = raw.envelope();
    requireValue(output.records.length <= 1, 'codex.history.item_amplification', 'reconcile_required');
    requireValue(
      output.records.length > 0 || envelope.nextCursor === null,
      'codex.history.empty_progress',
      'reconcile_required',
    );
    let next;
    if (envelope.nextCursor !== null) {
      textValue(envelope.nextCursor, 'codex.history_native_cursor');
      requireValue(
        envelope.nextCursor !== state.itemCursor,
        'codex.history.item_progress',
        'reconcile_required',
      );
      state.itemCursor = envelope.nextCursor;
      next = envelope.nextCursor;
    } else {
      state.turnCursor = state.nextTurnCursor;
      state.turn = null;
      state.itemCursor = null;
      next = state.nextTurnCursor;
    }
    requireValue(next === null || next !== state.lastNative, 'codex.history_repeated_cursor', 'reconcile_required');
    state.lastNative = next;
    nativeCursor = next;
    pages.add(output.id);
    return {
      pageId: output.id,
      items: output.records.map((record) => ({
        recordId: record.recordId,
        kind: 'stream',
        descriptor: {
          id: record.id,
          format: record.format,
          totalBytes: record.totalBytes,
          sha256: record.sha256,
        },
      })),
      document: {
        id: output.document.id,
        format: output.document.format,
        totalBytes: output.document.totalBytes,
        sha256: output.document.sha256,
      },
      cursor: nativeCursor,
      completeness: nativeCursor === null ? 'complete' : 'partial',
      reason: 'codex-raw-item-page',
    };
  }
  async function chunk({ pageId, descriptorId, offset, signal }) {
    await fenced(signal);
    requireValue(opened && store, 'codex.history_open', 'replay_required');
    textValue(pageId, 'codex.history_page');
    textValue(descriptorId, 'codex.history_descriptor');
    integerValue(offset, 'codex.history_offset');
    requireValue(pages.has(pageId), 'codex.history_page_owner', 'replay_required');
    const output = await store.read({ pageId, descriptorId, offset });
    await fenced(signal);
    return output;
  }
  async function read() {
    throw new ProtocolError('unsupported', 'codex.history_live');
  }
  async function close() {
    if (closed) return;
    closed = true;
    const owned = [...pages];
    pages.clear();
    for (const id of owned) {
      try {
        await store?.release(id);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    store = undefined;
  }
  return Object.freeze({
    capabilities: Object.freeze({ archive: 'paged', recordStream: true, live: 'unsupported' }),
    open,
    page,
    chunk,
    read,
    close,
  });
}
