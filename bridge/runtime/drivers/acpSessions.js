import { randomUUID } from 'node:crypto';
import { parseSessionRef, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { StoreError } from '../storage/storeProtocol.js';
import { record, text } from '../../../shared/runtime/native/acp/capabilities.js';

// ACP session/list takes no page-size parameter, so a conforming agent may answer with any
// number of sessions and the adapter - not the agent - decides how much of that answer
// reaches the index in one discovery round. The index commits one bounded transaction
// batch per scheduler round, so this adapter buffers each native response and hands it out
// in internal pages of at most NATIVE_PAGE_SIZE items, advancing its own opaque cursor
// over the buffer. The DSH driver already uses this shape for its unbounded native
// snapshot (dshDriver.js:199-228). Handing the whole native answer over at once is what
// made a 600+ session account blow the scheduler's per-round deadline and lose the page.
const NATIVE_PAGE_SIZE = 200;
// Adapter-local fences, NOT protocol bounds: the ACP specification defines no maximum
// page size for session/list (its request has no limit parameter at all and it only says
// agents SHOULD enforce reasonable page sizes internally), so nothing here is a contract
// an agent is required to honor. They bound this process's memory and cursor lifetime and
// must never be restated elsewhere as a native limit.
const ACP_SESSION_LIMITS = Object.freeze({
  nativePage: 1000,
  internalPage: NATIVE_PAGE_SIZE,
  cached: 1000,
  cursorRounds: 1000,
  cursors: 128,
  // A cursor is a lease on one native answer's buffer. The expiry covers the only retry a
  // caller really gets - the next page of the same scan, asked for within one scheduler
  // round - and the byte budget is what actually bounds memory, because the count cap
  // alone still admits 128 answers of roughly 1MiB each.
  cursorTtlMs: 300000,
  cursorBytes: 8388608,
});
export function createAcpSessions({ rpc, mutations, capabilities, queue, cwd, emit }) {
  const sessions = new Map();
  const cursors = new Map();
  let cursorBytes = 0;
  const histories = new Map();
  function sessionFor(nativeSessionId) {
    return parseSessionRef({
      environmentId: mutations.binding.target,
      harnessInstanceId: mutations.binding.harnessInstanceId,
      nativeSessionId: text(nativeSessionId),
    });
  }
  function requireSession(session) {
    mutations.scopeFor(session);
    return session;
  }
  function register(result) {
    const session = sessionFor(text(result.sessionId));
    const value = {
      session,
      key: encodeSessionKey(session),
      native: { ...sessions.get(session.nativeSessionId)?.native, ...result },
    };
    sessions.set(session.nativeSessionId, value);
    if (sessions.size > ACP_SESSION_LIMITS.cached) sessions.delete(sessions.keys().next().value);
    return value;
  }
  async function create(input) {
    return queue(async () => {
      const result = await mutations.run(
        {
          idempotencyKey: input.idempotencyKey,
          method: 'session/new',
          payload: { cwd, mcpServers: [] },
        },
        ({ payload }) => rpc.request('session/new', payload),
      );
      if (result.result === null) return result;
      return { ...result, ...register(record(result.result)) };
    });
  }
  async function load(input, method = 'session/load') {
    requireSession(input.session);
    if (!(method === 'session/load' ? capabilities.load : capabilities.resume))
      throw new StoreError('unsupported', method);
    return queue(async () => {
      const result = await mutations.run(
        {
          session: input.session,
          idempotencyKey: input.idempotencyKey,
          method,
          payload: { cwd, mcpServers: [], sessionId: input.session.nativeSessionId },
        },
        ({ payload }) => rpc.request(method, payload),
      );
      if (result.result === null) return result;
      return {
        ...result,
        ...register({ ...record(result.result), sessionId: input.session.nativeSessionId }),
      };
    });
  }
  // Reading a value is not releasing its container: a cursor that has been handed its page
  // still pins the whole native buffer it was cut from, so spending the token deletes it.
  // Cursors the caller never resumes are reclaimed here, oldest first (Map iteration is
  // insertion order), never the one just issued - evicting that would return a dead cursor.
  function expired(state) {
    return Date.now() - state.at >= ACP_SESSION_LIMITS.cursorTtlMs;
  }
  function drop(cursor, state) {
    cursors.delete(cursor);
    cursorBytes -= state.bytes;
  }
  function sweep(fresh) {
    // Expiry is per cursor, not per position: resuming a mid-buffer page re-inserts an older
    // buffer at the tail, so Map order stops tracking age and stopping at the first live
    // entry would leave expired state readable. Every live cursor is therefore checked for
    // its lease, and only then are the count and byte budgets enforced, oldest first.
    const now = Date.now();
    for (const [cursor, state] of cursors) {
      if (cursor !== fresh && now - state.at >= ACP_SESSION_LIMITS.cursorTtlMs) drop(cursor, state);
    }
    for (const budget of [() => cursors.size > ACP_SESSION_LIMITS.cursors, () => cursorBytes > ACP_SESSION_LIMITS.cursorBytes]) {
      while (budget()) {
        const oldest = [...cursors.keys()].find((cursor) => cursor !== fresh);
        if (oldest === undefined) break;
        const state = cursors.get(oldest);
        if (state === undefined) break;
        drop(oldest, state);
      }
    }
  }
  function keep(state) {
    const cursor = randomUUID();
    cursors.set(cursor, state);
    cursorBytes += state.bytes;
    sweep(cursor);
    return cursor;
  }
  async function list(input = {}) {
    if (!capabilities.list)
      return {
        items: [...sessions.values()],
        status: 'unsupported',
        cursor: null,
        reason: 'native_session_list_unsupported',
      };
    sweep(null);
    const held = input.cursor ? cursors.get(input.cursor) : null;
    // A cursor is a lease on one native answer: resuming one whose lease has lapsed is a
    // replay of a buffer the account may have moved on from, so it is refused here even if
    // the sweep has not reached it yet.
    if (input.cursor && (!held || expired(held))) throw new StoreError('invalid_request', 'session_cursor');
    if (held !== null) {
      cursors.delete(input.cursor);
      cursorBytes -= held.bytes;
    }
    let state = held;
    if (state === null || state.offset >= state.buffer.length) {
      const send = state === null ? null : state.next;
      const response = record(
        await rpc.request('session/list', { cwd, ...(send === null ? {} : { cursor: send }) }),
      );
      if (!Array.isArray(response.sessions) || response.sessions.length > ACP_SESSION_LIMITS.nativePage)
        throw new StoreError('invalid_request', 'session_list');
      const buffer = response.sessions.map((item) => register(record(item)));
      // The index dedupes one internal page at a time, so a native answer that repeats a
      // session across two internal pages has to be fenced here or it would slip through.
      if (new Set(buffer.map((item) => item.session.nativeSessionId)).size !== buffer.length)
        throw new StoreError('reconcile_required', 'index_duplicate_page');
      const next = response.nextCursor ?? null;
      const seen = state === null ? [] : state.seen;
      // Ending the walk is not a licence to hand the index an unbounded page: the reason is
      // parked on the paging state, the native cursor is dropped so no further page is
      // requested, and the slices below still drain this answer one index page at a time.
      let termination = null;
      if (next !== null) {
        text(next);
        if (send === next || seen.includes(next)) termination = 'repeated_cursor';
        else if (seen.length >= ACP_SESSION_LIMITS.cursorRounds) termination = 'cursor_budget';
      }
      state = {
        next: termination === null ? next : null,
        seen: next === null ? seen : [...seen, next],
        buffer,
        offset: 0,
        bytes: Buffer.byteLength(JSON.stringify(response.sessions)),
        at: Date.now(),
        termination,
      };
    }
    const items = state.buffer.slice(state.offset, state.offset + ACP_SESSION_LIMITS.internalPage);
    const drained = state.offset + items.length;
    if (drained < state.buffer.length)
      return { items, status: 'partial', cursor: keep({ ...state, offset: drained }) };
    if (state.termination !== null)
      return { items, status: 'partial', cursor: null, reason: state.termination };
    if (state.next === null)
      return capabilities.listCompleteness === 'bounded'
        ? { items, status: 'partial', cursor: null, reason: 'native_session_list_bounded' }
        : { items, status: 'complete', cursor: null };
    return {
      items,
      status: 'partial',
      cursor: keep({ next: state.next, seen: state.seen, buffer: [], offset: 0, bytes: 0, at: Date.now(), termination: null }),
    };
  }
  function update(params) {
    const input = record(params);
    const session = sessionFor(text(input.sessionId));
    if (!sessions.has(session.nativeSessionId)) register({ sessionId: session.nativeSessionId });
    const history = histories.get(session.nativeSessionId) ?? {
      items: [],
      seq: 0,
      bytes: 0,
      floor: 0,
    };
    const update = record(input.update);
    const native = sessions.get(session.nativeSessionId).native;
    if (update.sessionUpdate === 'available_commands_update')
      native.availableCommands = update.availableCommands;
    if (update.sessionUpdate === 'config_option_update')
      native.configOptions = update.configOptions;
    if (update.sessionUpdate === 'current_mode_update' && native.modes)
      native.modes.currentModeId = update.currentModeId;
    const bytes = Buffer.byteLength(JSON.stringify(update));
    history.seq++;
    if (bytes <= 262144) {
      history.items.push({ seq: history.seq, update });
      history.bytes += bytes;
    } else history.floor = history.seq;
    while (history.items.length > 128 || history.bytes > 1048576) {
      const removed = history.items.shift();
      history.bytes -= Buffer.byteLength(JSON.stringify(removed.update));
      history.floor = removed.seq;
    }
    histories.set(session.nativeSessionId, history);
    if (histories.size > 128) histories.delete(histories.keys().next().value);
    emit({ type: 'session.update', session, seq: history.seq, update });
  }
  return {
    create,
    load,
    list,
    update,
    sessionFor,
    requireSession,
    register,
    forget(session) {
      requireSession(session);
      sessions.delete(session.nativeSessionId);
      histories.delete(session.nativeSessionId);
    },
    get(session) {
      requireSession(session);
      return (
        sessions.get(session.nativeSessionId) ?? {
          session,
          status: 'partial',
          reason: 'not_loaded',
        }
      );
    },
    history(input) {
      requireSession(input.session);
      const after = input.after ?? 0;
      if (!Number.isSafeInteger(after) || after < 0)
        throw new StoreError('invalid_request', 'history_cursor');
      const history = histories.get(input.session.nativeSessionId);
      return {
        items: history?.items.filter((item) => item.seq > after) ?? [],
        status: 'partial',
        reason: 'native_history_not_paginated',
        floor: history?.floor ?? 0,
        through: history?.seq ?? 0,
      };
    },
  };
}
