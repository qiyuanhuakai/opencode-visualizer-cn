import { randomUUID } from 'node:crypto';
import { parseSessionRef, encodeSessionKey } from '../../../shared/runtime/identity.js';
import { StoreError } from '../storage/storeProtocol.js';
import { record, text } from '../../../shared/runtime/native/acp/capabilities.js';

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
