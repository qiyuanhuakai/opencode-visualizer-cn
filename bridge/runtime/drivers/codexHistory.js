import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeSessionKey } from '../../../shared/runtime/identity.js';
import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { normalizeCodexTurnsToHistory } from '../../../shared/runtime/native/codex/normalize.js';

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
