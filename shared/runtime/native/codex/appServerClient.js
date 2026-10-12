import { ProtocolError, requireValue } from '../../capabilities.js';

const bytes = (value) => new TextEncoder().encode(value).byteLength;
const STRING_CAP_BYTES = 4096;
const SCALAR_CAP_BYTES = 64;
const isDigit = (byte) => byte >= 0x30 && byte <= 0x39;
const isAlpha = (byte) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
const isSpace = (byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isNumberByte = (byte) =>
  isDigit(byte) || byte === 0x2d || byte === 0x2b || byte === 0x2e || byte === 0x65 || byte === 0x45;
const INTEGER = /^-?\d+$/u;

/** Bounded, JSON-layer-aware envelope scanner over one JSON-RPC frame. It reads ONLY the depth-1
 * `id`/`result`/`error` members and the depth-2 `nextCursor` / `error.code` members, so a legitimate
 * nested `error` inside `result.data[].item` (a rejected or failed tool call) is never mistaken for a
 * top-level RPC error, and a nested `nextCursor` never shadows the result-level cursor. Memory is O(1):
 * bytes below the envelope are counted for depth, never buffered, so a >4 MiB result stays bounded.
 */
function createEnvelopeScanner() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let capturing = false;
  let overflowed = false;
  let stringDepth = 0;
  let stringBytes = null;
  let closed = null;
  let key = null;
  let number = null;
  let literal = null;
  let resultDepth = null;
  let errorDepth = null;
  let kind = 'unknown';
  let id = null;
  let errorCode = null;
  let nextCursor = null;
  const capture = (byte) => {
    if (overflowed) return;
    if (stringBytes.length >= STRING_CAP_BYTES) {
      overflowed = true;
      stringBytes = null;
      return;
    }
    stringBytes.push(byte);
  };
  const finishScalar = (buffered) => {
    const owner = buffered.key;
    key = null;
    if (!owner || buffered.truncated) return;
    const text = Buffer.from(buffered.bytes).toString('utf8');
    if (owner.depth === 1 && owner.name === 'id' && INTEGER.test(text)) id = Number(text);
    else if (owner.depth === errorDepth && owner.name === 'code' && INTEGER.test(text))
      errorCode = Number(text);
  };
  const step = (byte) => {
    if (inString) {
      if (escaped) {
        escaped = false;
        if (capturing) capture(byte);
      } else if (byte === 0x5c) {
        escaped = true;
        if (capturing) capture(byte);
      } else if (byte === 0x22) {
        inString = false;
        closed = capturing
          ? {
              value: overflowed ? null : Buffer.from(stringBytes).toString('utf8'),
              overflow: overflowed,
              depth: stringDepth,
            }
          : null;
        capturing = false;
        stringBytes = null;
      } else if (capturing) capture(byte);
      return;
    }
    if (number) {
      if (isNumberByte(byte)) {
        if (number.bytes.length < SCALAR_CAP_BYTES) number.bytes.push(byte);
        else number.truncated = true;
        return;
      }
      finishScalar(number);
      number = null;
    }
    if (literal) {
      if (isAlpha(byte)) {
        if (literal.bytes.length < SCALAR_CAP_BYTES) literal.bytes.push(byte);
        else literal.truncated = true;
        return;
      }
      finishScalar(literal);
      literal = null;
    }
    if (isSpace(byte)) return;
    if (closed) {
      const string = closed;
      closed = null;
      if (byte === 0x3a) {
        key = { name: string.value, depth: string.depth };
        return;
      }
      const owner = key;
      key = null;
      if (
        owner &&
        !string.overflow &&
        string.value !== null &&
        owner.depth === 2 &&
        resultDepth === 2 &&
        owner.name === 'nextCursor'
      )
        nextCursor = JSON.parse(`"${string.value}"`);
    }
    if (byte === 0x22) {
      inString = true;
      escaped = false;
      capturing = depth <= 2;
      overflowed = false;
      stringDepth = depth;
      stringBytes = capturing ? [] : null;
      return;
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (key) {
        if (key.depth === 1 && key.name === 'result' && kind !== 'error') {
          kind = 'result';
          resultDepth = depth + 1;
        } else if (key.depth === 1 && key.name === 'error') {
          kind = 'error';
          errorDepth = depth + 1;
        }
        key = null;
      }
      depth += 1;
      return;
    }
    if (byte === 0x7d || byte === 0x5d) {
      depth -= 1;
      if (resultDepth !== null && depth < resultDepth) resultDepth = null;
      if (errorDepth !== null && depth < errorDepth) errorDepth = null;
      return;
    }
    if (byte === 0x2c || byte === 0x3a) return;
    if (isDigit(byte) || byte === 0x2d) {
      number = { bytes: [byte], key, truncated: false };
      return;
    }
    if (byte === 0x6e || byte === 0x74 || byte === 0x66) {
      literal = { bytes: [byte], key, truncated: false };
    }
  };
  return {
    push(chunk) {
      for (let index = 0; index < chunk.length; index += 1) step(chunk[index]);
    },
    envelope() {
      return { id, kind, errorCode, nextCursor };
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
      const scanner = createEnvelopeScanner();
      let envelope,
        failure,
        done = false;
      const frame = transport.requestRaw(JSON.stringify({ id, method, params }), id);
      async function* stream() {
        try {
          for await (const chunk of frame) {
            scanner.push(chunk);
            yield chunk;
          }
          const value = scanner.envelope();
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
