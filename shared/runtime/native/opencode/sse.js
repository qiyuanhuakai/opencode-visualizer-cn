import { ProtocolError, requireValue } from '../../capabilities.js';
import { OPEN_CODE_LIMITS } from './protocol.js';

/** Incremental UTF-8 SSE decoder. CRLF may split across reads; incomplete frames stay bounded. */
export function createSseDecoder(maxBytes = OPEN_CODE_LIMITS.frame) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let buffer = '';
  return {
    push(bytes) {
      buffer += decoder.decode(bytes, { stream: true });
      requireValue(encoder.encode(buffer).byteLength <= maxBytes, 'opencode.sse_frame', 'reconcile_required');
      const frames = [];
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) {
          try { frames.push(JSON.parse(data)); }
          catch (error) { if (error instanceof SyntaxError) throw new ProtocolError('reconcile_required', 'opencode.sse_json'); throw error; }
        }
      }
      return frames;
    },
    finish() { buffer += decoder.decode(); requireValue(!buffer.trim(), 'opencode.sse_truncated', 'reconcile_required'); },
  };
}

/** Subscribers share one bounded producer budget; overflow invalidates all cursors explicitly. */
export function createEventSubscriptions({ maxBytes = OPEN_CODE_LIMITS.producer, onOverflow }) {
  const subscribers = new Set();
  const encoder = new TextEncoder();
  let bytes = 0;
  let closed = false;
  function release(subscriber) {
    for (const entry of subscriber.queue) bytes -= entry.bytes;
    subscriber.queue.length = 0;
    subscribers.delete(subscriber);
  }
  function fail(error) {
    for (const subscriber of subscribers) {
      subscriber.error = error;
      const pending = subscriber.pending; subscriber.pending = null;
      release(subscriber);
      pending?.reject(error);
    }
  }
  return {
    get bufferedBytes() { return bytes; },
    subscribe(predicate = () => true) {
      requireValue(!closed, 'opencode.subscriptions_closed', 'source_unavailable');
      requireValue(subscribers.size < 32, 'opencode.subscribers', 'source_unavailable');
      const subscriber = { queue: [], pending: null, error: null, done: false, predicate };
      subscribers.add(subscriber);
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (subscriber.error) return Promise.reject(subscriber.error);
          if (subscriber.queue.length) { const entry = subscriber.queue.shift(); bytes -= entry.bytes; return Promise.resolve({ value: entry.value, done: false }); }
          if (closed || subscriber.done) return Promise.resolve({ value: undefined, done: true });
          requireValue(!subscriber.pending, 'opencode.concurrent_next');
          return new Promise((resolve, reject) => { subscriber.pending = { resolve, reject }; });
        },
        return() {
          subscriber.done = true; release(subscriber);
          subscriber.pending?.resolve({ value: undefined, done: true }); subscriber.pending = null;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    publish(value) {
      if (closed) return;
      const size = encoder.encode(JSON.stringify(value)).byteLength;
      const targets = [...subscribers].filter((subscriber) => subscriber.predicate(value));
      const queued = targets.filter((subscriber) => !subscriber.pending).length;
      if (size > OPEN_CODE_LIMITS.frame || bytes + size * queued > maxBytes) {
        const error = new ProtocolError('replay_required', 'opencode.subscriber_overflow');
        fail(error); onOverflow(error); return;
      }
      for (const subscriber of targets) {
        if (subscriber.pending) { const pending = subscriber.pending; subscriber.pending = null; pending.resolve({ value, done: false }); }
        else { subscriber.queue.push({ value, bytes: size }); bytes += size; }
      }
    },
    fail,
    close() { closed = true; for (const subscriber of subscribers) { release(subscriber); subscriber.pending?.resolve({ value: undefined, done: true }); subscriber.pending = null; } },
  };
}
