import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseSessionRef, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { StoreError } from '../storage/storeProtocol.js';
import { requireValue, integerValue, ProtocolError } from '../../../shared/runtime/capabilities.js';
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

export const ACP_HISTORY_LIMITS = Object.freeze({ chunkBytes: 65536, captureBytes: 2097152, headerBytes: 8192 });

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
      directory: cwd,
      native: { ...sessions.get(session.nativeSessionId)?.native, ...result },
    };
    sessions.set(session.nativeSessionId, value);
    if (sessions.size > ACP_SESSION_LIMITS.cached) sessions.delete(sessions.keys().next().value);
    return value;
  }
  async function create(input) {
    // This ACP process and its reverse-call scope are bound to one root (the factory's
    // firstRoot). A session/new for any other granted workspace would run the native agent
    // outside the connection's grant while the reverse tools remain scoped to the bound
    // root, so a non-bound workspace is refused BEFORE the native call rather than being
    // silently created in the bound root. `cwd` is what dispatch resolves from the request
    // workspaceKey; `directory` is the equivalent field used by direct driver callers.
    const requested = input.cwd ?? input.directory;
    requireValue(requested === undefined || requested === cwd, 'acp.workspace', 'unauthorized');
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
      history.floor = Math.max(history.floor, removed.seq);
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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function createAcpHistory(options) {
  const { session, authority, current, assertCurrent, attachRaw } = options;
  const uuid = options.randomUUID ?? randomUUID;
  const maxBytes = options.maxBytes ?? ACP_HISTORY_LIMITS.captureBytes;
  const nativeSessionId = text(session.nativeSessionId);
  const sessionField = new RegExp(`"sessionId"\\s*:\\s*${escapeRegExp(JSON.stringify(nativeSessionId))}`, 'u');
  let store, opened = false, closed = false, through = 0, failure, capture, captureSignal;
  const pages = new Set();
  let change = Promise.withResolvers();
  const wake = () => { const previous = change; change = Promise.withResolvers(); previous.resolve(); };
  // Settle when the native session advances or the caller aborts, and drop the abort listener once
  // either wins so a timed-out read cannot strand the owner or the exclusive read waiter.
  function awaitChange(signal) {
    const pending = change.promise;
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(new ProtocolError('cancelled', 'acp.history_read'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ProtocolError('cancelled', 'acp.history_read'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        () => { signal.removeEventListener('abort', onAbort); resolve(); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }
  function alive(signal) {
    requireValue(!closed, 'acp.history_closed', 'cancelled');
    requireValue(!signal?.aborted, 'acp.history_cancelled', 'cancelled');
    requireValue(current(), 'acp.history_generation', 'reconcile_required');
  }
  async function fenced(signal) { alive(signal); await assertCurrent(); alive(signal); }
  const grammar = Object.freeze({
    records: Object.freeze([Object.freeze({
      path: Object.freeze(['*']),
      fields: Object.freeze([
        Object.freeze({ name: 'sessionId', path: Object.freeze(['params', 'sessionId']) }),
        Object.freeze({ name: 'method', path: Object.freeze(['method']) }),
      ]),
      validate(metadata) {
        requireValue(metadata.method === 'session/update' && metadata.sessionId === nativeSessionId, 'acp.history_scope', 'reconcile_required');
        return uuid();
      },
    })]),
    fields: Object.freeze([]),
    validate() {},
  });
  function openCapture() {
    if (failure || closed) return false;
    let waiting, ended = false;
    const queue = [];
    const source = {
      push(piece) { if (ended) return; if (waiting) { const settle = waiting; waiting = undefined; settle({ value: piece, done: false }); } else queue.push(piece); },
      end() { if (ended) return; ended = true; if (waiting) { const settle = waiting; waiting = undefined; settle({ value: undefined, done: true }); } },
      [Symbol.asyncIterator]() { return { next() { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (ended) return Promise.resolve({ value: undefined, done: true }); return new Promise((resolve) => { waiting = resolve; }); } }; },
    };
    source.push(Uint8Array.of(0x5b));
    const work = (async () => {
      try { return await store.ingest({ source, cancel: () => source.end(), grammar, signal: captureSignal, maxBytes }); }
      catch (error) { failure ??= error; throw error; }
    })();
    work.catch(() => {});
    capture = { source, work, frames: 0 };
    return true;
  }
  function pushText(target, value) {
    if (!value) return;
    const bytes = Buffer.from(value, 'utf8');
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(ACP_HISTORY_LIMITS.chunkBytes, bytes.length - offset);
      const piece = new Uint8Array(length);
      piece.set(bytes.subarray(offset, offset + length));
      target.push(piece);
      offset += length;
    }
  }
  function decide(text_) {
    const method = /"method"\s*:\s*"([^"]*)"/u.exec(text_);
    if (method && method[1] !== 'session/update') return 'foreign';
    if (method && sessionField.test(text_)) return 'selected';
    if (text_.length >= ACP_HISTORY_LIMITS.headerBytes) return 'foreign';
    return 'undecided';
  }
  const decoder = new StringDecoder('utf8');
  let frameText = '', selected = null, discarding = false;
  function feed(chunk) {
    if (closed || !opened || !store || failure) return;
    let decoded;
    try { decoded = decoder.write(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)); }
    catch { return; }
    if (!decoded) return;
    frameText += decoded;
    for (;;) {
      if (discarding) {
        const boundary = frameText.indexOf('\n');
        if (boundary < 0) { frameText = ''; return; }
        frameText = frameText.slice(boundary + 1); discarding = false; selected = null;
        if (!frameText) return;
        continue;
      }
      if (selected === null) {
        const boundary = frameText.indexOf('\n');
        const limit = Math.min(boundary < 0 ? frameText.length : boundary, ACP_HISTORY_LIMITS.headerBytes);
        const verdict = decide(frameText.slice(0, limit));
        if (verdict === 'selected') selected = true;
        else {
          if (boundary >= 0) { frameText = frameText.slice(boundary + 1); if (!frameText) return; continue; }
          if (verdict === 'foreign') { discarding = true; continue; }
          return;
        }
      }
      // A frame is committed to the capture only once its newline arrives; a half-frame is retained
      // so a page switch always lands on a complete frame boundary instead of a synthetic `]`.
      const boundary = frameText.indexOf('\n');
      if (boundary < 0) {
        if (frameText.length > maxBytes) failure = new ProtocolError('source_unavailable', 'acp.history_frame');
        return;
      }
      if (!capture && !openCapture()) { discarding = true; continue; }
      if (capture.frames > 0) capture.source.push(Uint8Array.of(0x2c));
      pushText(capture.source, frameText.slice(0, boundary));
      frameText = frameText.slice(boundary + 1);
      capture.frames += 1; selected = null; through += 1; wake();
      if (!frameText) return;
    }
  }
  async function finalize() {
    const active = capture; capture = null;
    if (!active) return null;
    active.source.push(Uint8Array.of(0x5d));
    active.source.end();
    return active.work;
  }
  async function open({ signal, streamStore }) {
    requireValue(!opened && !closed, 'acp.history_open', 'conflict');
    await fenced(signal);
    opened = true; store = streamStore; captureSignal = signal;
    attachRaw(feed);
    return { fence: { id: uuid(), sourceGeneration: authority.processGeneration } };
  }
  async function page({ cursor, releasePageIds = [], signal }) {
    await fenced(signal);
    requireValue(opened && store, 'acp.history_open', 'replay_required');
    requireValue(Array.isArray(releasePageIds), 'acp.history_release');
    for (const id of releasePageIds) { text(id); requireValue(pages.has(id), 'acp.history_page_owner', 'unauthorized'); await store.release(id); pages.delete(id); }
    await fenced(signal);
    requireValue(cursor === undefined || cursor === null, 'acp.history_cursor', 'replay_required');
    if (failure) throw failure;
    if (!capture) openCapture();
    const output = await finalize();
    requireValue(output, 'acp.history_open', 'replay_required');
    await fenced(signal);
    pages.add(output.id);
    return {
      pageId: output.id,
      items: output.records.map((entry) => ({ recordId: entry.recordId, kind: 'stream', descriptor: { id: entry.id, format: entry.format, totalBytes: entry.totalBytes, sha256: entry.sha256 } })),
      document: { id: output.document.id, format: output.document.format, totalBytes: output.document.totalBytes, sha256: output.document.sha256 },
      cursor: null,
      completeness: 'partial',
      reason: 'native-live-session-update',
    };
  }
  async function chunk({ pageId, descriptorId, offset, signal }) {
    await fenced(signal);
    requireValue(opened && store, 'acp.history_open', 'replay_required');
    text(pageId); text(descriptorId); integerValue(offset, 'acp.history_offset');
    requireValue(pages.has(pageId), 'acp.history_page_owner', 'replay_required');
    const output = await store.read({ pageId, descriptorId, offset });
    await fenced(signal);
    return output;
  }
  async function read({ after, signal }) {
    await fenced(signal);
    requireValue(opened, 'acp.history_open', 'replay_required');
    integerValue(after, 'acp.history_after');
    for (;;) {
      if (failure) return { through, changed: through > after, status: failure.code === 'replay_required' ? 'replay_required' : 'source_unavailable' };
      if (through > after) return { through, changed: true, status: 'current' };
      if (closed || signal?.aborted) throw new ProtocolError('cancelled', 'acp.history_read');
      await awaitChange(signal);
      await fenced(signal);
    }
  }
  async function close() {
    if (closed) return;
    closed = true; wake();
    try { attachRaw(undefined); } catch {}
    const active = capture; capture = null;
    if (active) {
      active.source.push(Uint8Array.of(0x5d)); active.source.end();
      try { await active.work; } catch {}
    }
    const owned = [...pages]; pages.clear();
    for (const id of owned) { try { await store?.release(id); } catch {} }
    store = undefined;
  }
  return Object.freeze({ capabilities: Object.freeze({ archive: 'live-only', recordStream: true, live: 'invalidate' }), open, page, chunk, read, close });
}
