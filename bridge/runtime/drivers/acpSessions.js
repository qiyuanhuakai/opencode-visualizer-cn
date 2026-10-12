import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseSessionRef, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { StoreError } from '../storage/storeProtocol.js';
import { requireValue, integerValue, ProtocolError } from '../../../shared/runtime/capabilities.js';
import { record, text } from '../../../shared/runtime/native/acp/capabilities.js';

export const ACP_HISTORY_LIMITS = Object.freeze({ chunkBytes: 65536, captureBytes: 2097152, headerBytes: 8192 });

export function createAcpSessions({ rpc, mutations, capabilities, queue, cwd, emit }) {
  const sessions = new Map();
  const cursors = new Map();
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
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
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
  async function list(input = {}) {
    if (!capabilities.list)
      return {
        items: [...sessions.values()],
        status: 'unsupported',
        cursor: null,
        reason: 'native_session_list_unsupported',
      };
    const page = input.cursor ? cursors.get(input.cursor) : { seen: [], native: null };
    if (!page) throw new StoreError('invalid_request', 'session_cursor');
    const response = record(
      await rpc.request('session/list', { cwd, ...(page.native ? { cursor: page.native } : {}) }),
    );
    if (!Array.isArray(response.sessions) || response.sessions.length > 1000)
      throw new StoreError('invalid_request', 'session_list');
    const items = response.sessions.map((item) => register(record(item)));
    const next = response.nextCursor;
    if (next === undefined || next === null)
      return capabilities.listCompleteness === 'bounded'
        ? { items, status: 'partial', cursor: null, reason: 'native_session_list_bounded' }
        : { items, status: 'complete', cursor: null };
    text(next);
    if (page.native === next || page.seen.includes(next))
      return { items, status: 'partial', cursor: null, reason: 'repeated_cursor' };
    if (page.seen.length >= 1000)
      return { items, status: 'partial', cursor: null, reason: 'cursor_budget' };
    const cursor = randomUUID();
    cursors.set(cursor, { native: next, seen: [...page.seen, next] });
    if (cursors.size > 128) cursors.delete(cursors.keys().next().value);
    return { items, status: 'partial', cursor };
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
        if (verdict === 'selected') {
          if (!capture && !openCapture()) { discarding = true; continue; }
          if (capture.frames > 0) capture.source.push(Uint8Array.of(0x2c));
          selected = true;
        } else {
          if (boundary >= 0) { frameText = frameText.slice(boundary + 1); if (!frameText) return; continue; }
          if (verdict === 'foreign') { discarding = true; continue; }
          return;
        }
      }
      const boundary = frameText.indexOf('\n');
      if (boundary < 0) { pushText(capture.source, frameText); frameText = ''; return; }
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
      if (failure) return { through, changed: false, status: failure.code === 'replay_required' ? 'replay_required' : 'source_unavailable' };
      if (through > after) return { through, changed: true, status: 'current' };
      if (closed || signal?.aborted) throw new ProtocolError('cancelled', 'acp.history_read');
      await change.promise;
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
