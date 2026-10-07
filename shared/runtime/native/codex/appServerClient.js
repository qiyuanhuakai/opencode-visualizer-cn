import { ProtocolError, requireValue } from '../../capabilities.js';

const bytes = (value) => new TextEncoder().encode(value).byteLength;

/** Owns one native connection; closed generations never dispatch late frames. */
export function createAppServerClient({
  transport,
  onMessage,
  onFailure,
  deadlineMs = 15000,
  maxFrameBytes = 4 * 1024 * 1024,
}) {
  let closed = false,
    nextId = 0,
    queuedBytes = 0,
    draining = false;
  const pending = new Map(),
    queue = [];
  function close(error = new ProtocolError('source_unavailable', 'codex.connection')) {
    if (closed) return;
    closed = true;
    unsubscribe();
    queue.length = 0;
    queuedBytes = 0;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    transport.close();
    onFailure?.(error);
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!closed && queue.length) {
        const entry = queue.shift();
        await onMessage(entry.message);
        queuedBytes -= entry.size;
      }
    } catch {
      close(new ProtocolError('reconcile_required', 'codex.notification'));
    } finally {
      draining = false;
    }
  }
  const unsubscribe = transport.subscribe(
    (raw) => {
      if (closed) return;
      try {
        requireValue(
          typeof raw === 'string' && bytes(raw) <= maxFrameBytes,
          'codex.frame',
          'reconcile_required',
        );
        const message = JSON.parse(raw);
        requireValue(
          message && typeof message === 'object' && !Array.isArray(message),
          'codex.message',
        );
        if (typeof message.method === 'string') {
          const size = bytes(raw);
          requireValue(
            queuedBytes + size <= 4 * 1024 * 1024,
            'codex.producer',
            'reconcile_required',
          );
          queuedBytes += size;
          queue.push({ message, size });
          void drain();
          return;
        }
        const waiter = pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        if (message.error) {
          const nativeCode = Number.isInteger(message.error.code) ? message.error.code : null;
          const code =
            nativeCode === -32601
              ? 'unsupported'
              : [-32600, -32602].includes(nativeCode)
                ? 'invalid_request'
                : 'source_unavailable';
          const error = new ProtocolError(code, `codex.rpc.${waiter.method}`);
          error.nativeCode = nativeCode;
          waiter.reject(error);
        } else if (Object.hasOwn(message, 'result')) waiter.resolve(message.result);
        else waiter.reject(new ProtocolError('invalid_request', 'codex.response'));
      } catch {
        close(new ProtocolError('reconcile_required', 'codex.frame'));
      }
    },
    () => close(),
  );
  function write(value) {
    requireValue(!closed, 'codex.closed', 'source_unavailable');
    const raw = JSON.stringify(value);
    requireValue(bytes(raw) <= 1024 * 1024, 'codex.request');
    transport.send(raw);
  }
  return {
    request(method, params) {
      requireValue(!closed && pending.size < 512, 'codex.pending', 'source_unavailable');
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new ProtocolError('timeout', `codex.rpc.${method}`));
        }, deadlineMs);
        pending.set(id, { resolve, reject, timer, method });
        try {
          write({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    reply(id, result) {
      write({ id, result });
    },
    reject(id, code) {
      write({ id, error: { code, message: 'Unsupported native request' } });
    },
    close,
    get closed() {
      return closed;
    },
  };
}
