import { ProtocolError, requireValue } from '../../capabilities.js';

/** One bounded producer queue; slow observers must recover durable interactions and native history. */
export function createCodexSubscriptions() {
  const subscribers = new Set();
  let bytes = 0,
    closed = false;
  const remove = (state) => {
    for (const entry of state.queue) bytes -= entry.bytes;
    state.queue.length = 0;
    subscribers.delete(state);
  };
  return {
    emit(event) {
      if (closed) return;
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      for (const state of subscribers) {
        if (state.session && event.session?.nativeSessionId !== state.session.nativeSessionId)
          continue;
        if (size > 1024 * 1024 || bytes + size > 4 * 1024 * 1024) {
          remove(state);
          state.error = new ProtocolError('replay_required', 'codex.subscriber');
          state.waiter?.reject(state.error);
          state.waiter = null;
          continue;
        }
        if (state.waiter) {
          state.waiter.resolve({ value: event, done: false });
          state.waiter = null;
        } else {
          state.queue.push({ event, bytes: size });
          bytes += size;
        }
      }
    },
    subscribe(session) {
      requireValue(!closed && subscribers.size < 16, 'codex.subscriber', 'source_unavailable');
      const state = { session, queue: [], waiter: null, error: null, done: false };
      subscribers.add(state);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (state.error) return Promise.reject(state.error);
          const item = state.queue.shift();
          if (item) {
            bytes -= item.bytes;
            return Promise.resolve({ value: item.event, done: false });
          }
          if (state.done || closed) return Promise.resolve({ value: undefined, done: true });
          requireValue(!state.waiter, 'codex.subscriber.concurrent_next', 'conflict');
          return new Promise((resolve, reject) => {
            state.waiter = { resolve, reject };
          });
        },
        async return() {
          remove(state);
          state.done = true;
          state.waiter?.resolve({ value: undefined, done: true });
          state.waiter = null;
          return { value: undefined, done: true };
        },
      };
    },
    close() {
      closed = true;
      for (const state of subscribers) {
        state.done = true;
        state.waiter?.resolve({ value: undefined, done: true });
        state.waiter = null;
      }
      subscribers.clear();
      bytes = 0;
    },
  };
}
