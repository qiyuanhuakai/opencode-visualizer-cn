// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createCodexHistoryStream } from '../../../bridge/runtime/drivers/codexHistory.js';
import { createHistoryDiskBudget, createHistoryStream } from '../../../bridge/runtime/historyStream.js';
import { createCodexSubscriptions } from '../../../shared/runtime/native/codex/subscriptions.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import type { CodexEvent } from '../../../shared/runtime/native/codex/subscriptions.js';

async function fixture() {
  const session = parseSessionRef({ environmentId: parseEnvironmentId(randomUUID()), harnessInstanceId: parseHarnessInstanceId(randomUUID()), nativeSessionId: 'selected' });
  const epoch = randomUUID(), bus = createCodexSubscriptions();
  let observers = 0;
  const store = createHistoryStream({ scope: 'codex-live-qa', globalDisk: createHistoryDiskBudget(), createDirectory: async () => { throw new Error('Invalidation must not write transcript spools'); } });
  const options = {
    session, epoch, processGeneration: 1, assertCurrent() {}, randomUUID,
    request: async () => ({ data: [], nextCursor: null }),
    requestHistory() { throw new Error('Invalidation must not read native transcript pages'); },
    subscribe() {
      observers++;
      const iterator = bus.subscribe(session); let returned = false;
      return { ...iterator, async return() {
        if (!returned) { returned = true; observers--; }
        return iterator.return ? iterator.return() : { value: undefined, done: true as const };
      } };
    },
  };
  const handle = createCodexHistoryStream(options);
  const signal = () => new AbortController().signal;
  const emit = (type: string, override: Partial<CodexEvent> = {}) => bus.emit({ type, epoch, processGeneration: 1, session, payload: {}, ...override });
  return { handle, bus, session, emit, signal, observers: () => observers, store,
    async close() { await handle.close(); bus.close(); await store.close(); } };
}

it('invalidates selected Codex history on external native turn completion without observing another full session identity', async () => {
  const state = await fixture();
  try {
    expect(state.observers()).toBe(0);
    expect(state.handle.capabilities.live).toBe('invalidate');
    await state.handle.open({ signal: state.signal(), streamStore: state.store });
    expect(state.observers()).toBe(1);
    const waiting = state.handle.read({ after: 0, signal: state.signal() });
    let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
    state.emit('turn/completed', { session: { ...state.session, nativeSessionId: 'other' } });
    state.emit('turn/completed', { session: { ...state.session, harnessInstanceId: parseHarnessInstanceId(randomUUID()) } });
    state.emit('thread/tokenUsage/updated');
    state.emit('item/agentMessage/delta');
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(settled).toBe(false);
    state.emit('turn/completed');
    expect(await waiting).toEqual({ through: 1, changed: true, status: 'current' });
    expect(state.store.usage().diskBytes).toBe(0);
  } finally { await state.close(); }
  expect(state.observers()).toBe(0);
});

it('removes cancelled waiters immediately and closes only its selected observer', async () => {
  const state = await fixture();
  const peer = state.bus.subscribe();
  try {
    await state.handle.open({ signal: state.signal(), streamStore: state.store });
    for (let index = 0; index < 20; index++) {
      const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
      const waiting = state.handle.read({ after: 0, signal: controller.signal });
      const rejected = expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
      for (let spin = 0; spin < 4; spin++) await Promise.resolve();
      controller.abort();
      await rejected;
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    }
    const waiting = state.handle.read({ after: 0, signal: state.signal() });
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    for (let spin = 0; spin < 4; spin++) await Promise.resolve();
    await state.handle.close(); await rejected;
    expect(state.observers()).toBe(0);
    state.emit('turn/started');
    expect(await peer.next()).toMatchObject({ done: false, value: { type: 'turn/started' } });
  } finally { await peer.return?.(); await state.close(); }
});

it('preserves unseen progress when an overflowing native observer requires replay', async () => {
  const state = await fixture();
  try {
    await state.handle.open({ signal: state.signal(), streamStore: state.store });
    state.emit('item/completed');
    state.emit('item/agentMessage/delta', { payload: { delta: 'x'.repeat(1024 * 1024 + 1) } });
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(await state.handle.read({ after: 0, signal: state.signal() })).toEqual({ through: 1, changed: true, status: 'replay_required' });
    expect(await state.handle.read({ after: 1, signal: state.signal() })).toEqual({ through: 1, changed: false, status: 'replay_required' });
    expect(state.store.usage().diskBytes).toBe(0);
  } finally { await state.close(); }
});

it('distinguishes retrying errors from terminal native content changes and reports a closed producer', async () => {
  const state = await fixture();
  try {
    await state.handle.open({ signal: state.signal(), streamStore: state.store });
    const waiting = state.handle.read({ after: 0, signal: state.signal() });
    let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
    state.emit('error', { payload: { willRetry: true } });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(settled).toBe(false);
    state.emit('error', { payload: { willRetry: false } });
    expect(await waiting).toEqual({ through: 1, changed: true, status: 'current' });
    state.bus.close();
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(await state.handle.read({ after: 1, signal: state.signal() })).toEqual({ through: 1, changed: false, status: 'source_unavailable' });
  } finally { await state.close(); }
});
