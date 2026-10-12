import { ProtocolError, requireValue } from '../../capabilities.js';

const bytes = (value) => new TextEncoder().encode(value).byteLength;
const HEAD_BYTES = 65536;
const TAIL_BYTES = 65536;
const idFirstPattern = /^\s*\{\s*"id"\s*:\s*(-?\d+)/u;
const idLastPattern = /"id"\s*:\s*(-?\d+)\s*\}\s*$/u;
const codePattern = /"code"\s*:\s*(-?\d+)/u;
const resultPattern = /"result"\s*:\s*\{/u;
const errorPattern = /"error"\s*:\s*\{/u;
const cursorPattern = /"nextCursor"\s*:\s*(null|"(?:[^"\\]|\\.)*")/u;

/** Bounded head/tail window over one JSON-RPC frame. The frame is a single object whose small envelope
 * keys (`id`, `result`/`error`, `nextCursor`) sit at the start or the end, so the id is correlated even
 * when the server emits it after a large result without materialising the payload in memory.
 */
function createFrameWindow() {
  const head = [];
  let headBytes = 0,
    tail = Buffer.alloc(0);
  return {
    push(chunk) {
      if (headBytes < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - headBytes, chunk.length);
        head.push(Buffer.from(chunk.subarray(0, take)));
        headBytes += take;
      }
      tail = Buffer.concat([tail, chunk.subarray(Math.max(0, chunk.length - TAIL_BYTES))]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    },
    envelope() {
      const front = Buffer.concat(head).toString('utf8');
      const rear = tail.toString('utf8');
      const idMatch = idFirstPattern.exec(front) ?? idLastPattern.exec(rear);
      const codeMatch = codePattern.exec(front) ?? codePattern.exec(rear);
      const cursorMatch = cursorPattern.exec(rear) ?? cursorPattern.exec(front);
      const kind =
        errorPattern.test(front) || errorPattern.test(rear)
          ? 'error'
          : resultPattern.test(front) || resultPattern.test(rear)
            ? 'result'
            : 'unknown';
      return {
        id: idMatch ? Number(idMatch[1]) : null,
        kind,
        errorCode: codeMatch ? Number(codeMatch[1]) : null,
        nextCursor: cursorMatch
          ? cursorMatch[1] === 'null'
            ? null
            : JSON.parse(cursorMatch[1])
          : null,
      };
    },
  };
}

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
    requestHistory(method, params) {
      requireValue(!closed && pending.size < 512, 'codex.pending', 'source_unavailable');
      requireValue(method === 'thread/items/list', 'codex.history_method', 'unsupported');
      requireValue(typeof transport.requestRaw === 'function', 'codex.history_transport', 'unsupported');
      const id = ++nextId;
      const window = createFrameWindow();
      let envelope,
        failure,
        done = false;
      const frame = transport.requestRaw(JSON.stringify({ id, method, params }), id);
      async function* stream() {
        try {
          for await (const chunk of frame) {
            window.push(chunk);
            yield chunk;
          }
          const value = window.envelope();
          if (value.id !== id)
            throw new ProtocolError('reconcile_required', 'codex.history_correlation');
          if (value.kind === 'error') {
            const code =
              value.errorCode === -32601
                ? 'unsupported'
                : [-32600, -32602].includes(value.errorCode)
                  ? 'invalid_request'
                  : 'source_unavailable';
            const error = new ProtocolError(code, `codex.rpc.${method}`);
            error.nativeCode = value.errorCode ?? null;
            throw error;
          }
          if (value.kind !== 'result')
            throw new ProtocolError('reconcile_required', 'codex.history_response');
          envelope = value;
        } catch (error) {
          failure ??= error;
          throw error;
        } finally {
          done = true;
        }
      }
      return {
        id,
        stream: stream(),
        envelope() {
          if (failure) throw failure;
          if (!envelope) throw new ProtocolError('reconcile_required', 'codex.history_incomplete');
          return envelope;
        },
        get settled() {
          return done;
        },
      };
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
