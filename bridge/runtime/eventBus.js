import { parseBinding } from '../../shared/runtime/protocol.js';
import { StoreError } from './storage/storeProtocol.js';
import { createReplayLog } from './replayLog.js';
import { createEventObserver, OBSERVER_LIMITS } from './eventObservers.js';

export function createRuntimeEventBus({ store, pollMs = 20 }) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new StoreError('invalid_request', 'event_poll_interval');
  const log = createReplayLog({ store });
  const observers = new Set();
  let closed = false;
  let running = null;
  let timer = null;
  let through = null;
  async function pump() {
    const ready = await store.ready;
    if (through === null) through = (await store.inspect()).seq;
    for (let page = 0; page < 8 && !closed; page++) {
      let replay;
      try { replay = await log.read({ epoch: ready.epoch, after: through, limit: 200 }); }
      catch (error) {
        for (const observer of observers) observer.recover(String(error?.code ?? 'source_unavailable'));
        if (error?.code === 'replay_required') through = (await store.inspect()).seq;
        return;
      }
      for (const patch of replay.events) {
        for (const observer of observers) {
          try { observer.push(log.envelope(observer.binding, patch), patch.collection === 'interactions' || patch.collection === 'operations'); }
          catch { observer.close(); }
        }
      }
      through = replay.through;
      if (through === replay.watermark) return;
    }
  }
  function nudge() {
    if (closed) return Promise.resolve();
    if (running) return running;
    if (timer !== null) clearTimeout(timer);
    running = pump().finally(() => {
      running = null;
      if (!closed) { timer = setTimeout(() => { nudge().catch(() => {}); }, pollMs); timer.unref?.(); }
    });
    return running;
  }
  return {
    async connect(input, { after, isCurrent }) {
      const binding = parseBinding(input);
      const ready = await store.ready;
      if (closed || binding.epoch !== ready.epoch || !isCurrent()) throw new StoreError('replay_required', 'event_binding');
      if (binding.target !== ready.environment) throw new StoreError('unauthorized', 'event_target');
      if (observers.size >= OBSERVER_LIMITS.observers) throw new StoreError('source_unavailable', 'event_observers');
      await nudge();
      if (closed || !isCurrent()) throw new StoreError('replay_required', 'event_binding');
      if (observers.size >= OBSERVER_LIMITS.observers) throw new StoreError('source_unavailable', 'event_observers');
      if (after > through) throw new StoreError('replay_required', 'event_ahead');
      let observer;
      observer = createEventObserver({ binding, after, isCurrent, onClose: () => observers.delete(observer) });
      observers.add(observer);
      if (after !== through) observer.recover('initial_replay');
      return observer;
    },
    nudge,
    log,
    async close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      await running;
      for (const observer of observers) observer.close();
    },
    get state() { return { observers: observers.size, through, polling: running !== null, closed }; },
  };
}
