import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';

import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { RELAY_MAX_FRAME_BYTES, decodeRelayFrames, encodeRelayFrame } from './processRelay.js';
import { RELAY_HELLO_ACK_KIND, RELAY_HANDSHAKE_KIND } from './relayHandshake.js';

/**
 * Compute relay (plan task 29 / Scope 13).
 *
 * The relay is the login-owned long-term endpoint. It presents either an authenticated TCP
 * listener (for the login-SSH-forward channel) or a compute-local socket (for the batch-owned
 * Bridge that the `srun` relay step forwards bytes to). On top of the binary-clean length-prefix
 * framing from `processRelay` it carries three things:
 *
 *  - control messages (JSON, tag 1) — the relay handshake and future control verbs;
 *  - data messages (tag 2) — opaque framed bytes, never coerced through a string;
 *  - reverse storage RPCs (tags 3/4) — the compute Runtime asks the login control store to
 *    perform a durable mutation and awaits the store's durable acknowledgement.
 *
 * A client connection is a short-lived laptop session. Closing it removes only that connection:
 * the relay stays `listening` and keeps serving the same live job, so the job is never killed by
 * a client disconnect.
 */
export const RELAY_TAG = Object.freeze({ control: 1, data: 2, storageRequest: 3, storageAck: 4 });
export const RELAY_STORAGE_OPS = Object.freeze(['readIntent', 'writeIntent', 'updateIntent', 'listIntents', 'bumpEpoch', 'verifyIntegrity']);
export const RELAY_ROLES = Object.freeze(['login', 'compute']);
const DATA_TAGS = Object.freeze(Object.values(RELAY_TAG));

/** Wraps a payload in a length-prefixed relay frame with a one-byte channel tag. */
export function encodeRelayMessage(tag, payload, options = {}) {
  requireValue(DATA_TAGS.includes(tag), 'relay.tag');
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return encodeRelayFrame(Buffer.concat([Buffer.from([tag]), body]), options);
}

/** Decodes tagged relay messages from a byte stream; `remaining` is the incomplete tail. */
export function decodeRelayMessages(buffer, options = {}) {
  const max = options.maxFrameBytes ?? RELAY_MAX_FRAME_BYTES;
  const { frames, remaining } = decodeRelayFrames(buffer, { maxFrameBytes: max });
  const messages = frames.map((frame) => {
    requireValue(frame.length >= 1, 'relay.frame');
    return Object.freeze({ tag: frame[0], payload: Buffer.from(frame.subarray(1)) });
  });
  return { messages, remaining };
}

function jsonParse(payload) {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw new ProtocolError('invalid_request', 'relay.control');
  }
}

/**
 * A duplex tagged relay channel over any stream (a net socket or an srun stdio pipe). The
 * `login` role opens the handshake; the `compute` role verifies it and acks. `ready` resolves
 * only after both ends verified the credential-protected binding.
 */
export function createRelayChannel(stream, options = {}) {
  const handshake = options.handshake;
  requireValue(handshake !== null && typeof handshake === 'object', 'relay.handshake');
  const role = options.role;
  requireValue(RELAY_ROLES.includes(role), 'relay.role', 'unsupported');
  requireValue(stream !== null && typeof stream === 'object', 'relay.stream');
  const timeoutMs = options.timeoutMs ?? 15_000;

  let state = 'handshaking';
  let buffer = Buffer.alloc(0);
  const pendingStore = new Map();
  const dataHandlers = [];
  const controlHandlers = [];
  const storageHandlers = [];
  const closeHandlers = [];
  let settleReady;
  let failReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });
  ready.catch(() => {});

  function emitClose() {
    if (state === 'closed') return;
    state = state === 'rejected' ? state : 'closed';
    for (const handler of closeHandlers) handler();
  }

  function fail(error) {
    if (state === 'closed' || state === 'rejected') return;
    state = 'rejected';
    for (const [, record] of pendingStore) {
      clearTimeout(record.timer);
      record.reject(error);
    }
    pendingStore.clear();
    failReady(error);
    try {
      stream.destroy?.();
    } catch {
      // A destroy failure must not mask the rejection cause.
    }
    emitClose();
  }

  function write(tag, payload) {
    try {
      stream.write?.(encodeRelayMessage(tag, payload));
    } catch (error) {
      fail(error instanceof ProtocolError ? error : new ProtocolError('source_unavailable', 'relay.write'));
    }
  }

  function handleHandshake(message) {
    if (role === 'login') {
      if (message?.kind !== RELAY_HELLO_ACK_KIND || handshake.verify(message) !== true) {
        fail(new ProtocolError('unauthorized', 'relay.handshake'));
        return;
      }
      state = 'ready';
      settleReady({ role, binding: handshake.binding });
      return;
    }
    if (message?.kind !== RELAY_HANDSHAKE_KIND || handshake.verify(message) !== true) {
      fail(new ProtocolError('unauthorized', 'relay.handshake'));
      return;
    }
    write(RELAY_TAG.control, handshake.ack(message.nonce));
    state = 'ready';
    settleReady({ role, binding: handshake.binding });
  }

  function handleStorageRequest(payload) {
    let request;
    try {
      request = jsonParse(payload);
    } catch (error) {
      fail(error);
      return;
    }
    const handler = storageHandlers[0];
    if (handler === undefined) {
      write(RELAY_TAG.storageAck, { id: request.id, ok: false, error: { code: 'unsupported', field: 'relay.storage.op' } });
      return;
    }
    Promise.resolve(handler(request)).then(
      (result) => write(RELAY_TAG.storageAck, { id: request.id, ...(result ?? { ok: true }) }),
      (error) =>
        write(RELAY_TAG.storageAck, {
          id: request.id,
          ok: false,
          error: { code: error?.code ?? 'source_unavailable', field: error?.field ?? 'relay.storage' },
        }),
    );
  }

  function handleStorageAck(payload) {
    let message;
    try {
      message = jsonParse(payload);
    } catch (error) {
      fail(error);
      return;
    }
    const record = pendingStore.get(message.id);
    if (record === undefined) return;
    pendingStore.delete(message.id);
    clearTimeout(record.timer);
    if (message.ok === true) record.resolve(message);
    else record.reject(new ProtocolError(message.error?.code ?? 'source_unavailable', message.error?.field ?? 'relay.storage'));
  }

  function dispatch(message) {
    const { tag, payload } = message;
    if (tag === RELAY_TAG.control) {
      let value;
      try {
        value = jsonParse(payload);
      } catch (error) {
        fail(error);
        return;
      }
      if (state === 'handshaking') {
        handleHandshake(value);
        return;
      }
      for (const handler of controlHandlers) handler(value);
      return;
    }
    if (tag === RELAY_TAG.data) {
      for (const handler of dataHandlers) handler(payload);
      return;
    }
    if (tag === RELAY_TAG.storageRequest) {
      handleStorageRequest(payload);
      return;
    }
    if (tag === RELAY_TAG.storageAck) handleStorageAck(payload);
  }

  function onData(chunk) {
    if (state === 'closed' || state === 'rejected') return;
    buffer = Buffer.concat([buffer, chunk]);
    let decoded;
    try {
      decoded = decodeRelayMessages(buffer);
    } catch {
      fail(new ProtocolError('invalid_request', 'relay.frame'));
      return;
    }
    buffer = decoded.remaining;
    for (const message of decoded.messages) dispatch(message);
  }

  stream.on?.('data', onData);
  stream.on?.('error', () => fail(new ProtocolError('source_unavailable', 'relay.stream')));
  stream.on?.('end', emitClose);
  stream.on?.('close', emitClose);

  if (role === 'login') write(RELAY_TAG.control, handshake.challenge());

  return Object.freeze({
    role,
    binding: handshake.binding,
    ready,
    state: () => state,
    onData(handler) {
      dataHandlers.push(handler);
      return this;
    },
    onControl(handler) {
      controlHandlers.push(handler);
      return this;
    },
    onStorageRequest(handler) {
      storageHandlers.push(handler);
      return this;
    },
    onClose(handler) {
      closeHandlers.push(handler);
      if (state === 'closed' || state === 'rejected') handler();
      return this;
    },
    sendData(payload) {
      requireValue(state === 'ready', 'relay.state', 'conflict');
      write(RELAY_TAG.data, payload);
    },
    sendControl(message) {
      requireValue(state === 'ready', 'relay.state', 'conflict');
      write(RELAY_TAG.control, message);
    },
    /** Reverse storage RPC: the compute asks the login store to mutate durably and awaits the ack. */
    requestStore(op, params = {}) {
      requireValue(state === 'ready', 'relay.state', 'conflict');
      requireValue(RELAY_STORAGE_OPS.includes(op), 'relay.storage.op', 'unsupported');
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingStore.delete(id);
          reject(new ProtocolError('timeout', 'relay.storage'));
        }, timeoutMs);
        pendingStore.set(id, { resolve, reject, timer });
        write(RELAY_TAG.storageRequest, { id, op, params });
      });
    },
    close() {
      if (state === 'closed') return;
      for (const [, record] of pendingStore) {
        clearTimeout(record.timer);
        record.reject(new ProtocolError('cancelled', 'relay.storage'));
      }
      pendingStore.clear();
      try {
        stream.end?.();
        stream.destroy?.();
      } catch {
        // Ignore teardown races.
      }
      state = 'closed';
      emitClose();
    },
  });
}

/** Dispatches one reverse storage operation to the login control store, returning a durable ack body. */
export async function dispatchStoreOperation(store, request) {
  const op = request?.op;
  requireValue(RELAY_STORAGE_OPS.includes(op), 'relay.storage.op', 'unsupported');
  const params = request?.params ?? {};
  switch (op) {
    case 'readIntent':
      return Object.freeze({ ok: true, durable: true, value: (await store.readIntent(params.intentId)) ?? null });
    case 'writeIntent':
      return Object.freeze({ ok: true, durable: true, value: await store.writeIntent(params) });
    case 'updateIntent':
      return Object.freeze({ ok: true, durable: true, value: await store.updateIntent(params.intentId, params.patch ?? {}) });
    case 'listIntents':
      return Object.freeze({ ok: true, durable: true, value: await store.listIntents() });
    case 'bumpEpoch':
      return Object.freeze({ ok: true, durable: true, value: await store.bumpEpoch(params) });
    case 'verifyIntegrity':
      return Object.freeze({ ok: true, durable: true, value: await store.verifyIntegrity() });
    default:
      throw new ProtocolError('unsupported', 'relay.storage.op');
  }
}

/**
 * The long-term relay endpoint. `mode: 'tcp'` opens an authenticated listener (combined with a
 * login SSH forward by the TCP transport); `mode: 'local-socket'` opens a compute-local socket
 * for the `srun` relay step to forward to. Each accepted client becomes a relay channel; a client
 * disconnect removes only that channel and leaves the listener (and its job bindings) alive.
 */
export function createComputeRelay(options = {}) {
  const handshake = options.handshake;
  requireValue(handshake !== null && typeof handshake === 'object', 'relay.handshake');
  const mode = options.mode;
  requireValue(mode === 'tcp' || mode === 'local-socket', 'relay.mode', 'unsupported');
  const connectionHandlers = [];
  const channels = new Set();
  const bindings = new Map();
  let state = 'idle';
  let server;

  function track(channel) {
    channels.add(channel);
    const key = `${channel.binding.intentId}:${channel.binding.epoch}`;
    bindings.set(key, channel.binding);
    for (const handler of connectionHandlers) handler(channel);
    channel.onClose(() => {
      channels.delete(channel);
    });
  }

  function attach(socket) {
    const channel = createRelayChannel(socket, {
      handshake,
      role: 'compute',
      timeoutMs: options.timeoutMs,
    });
    channel.ready.then(() => track(channel), () => channels.delete(channel));
  }

  async function listen() {
    requireValue(state === 'idle', 'relay.state', 'conflict');
    server = options.createServer ? options.createServer() : createNetServer();
    server.on('connection', attach);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      if (mode === 'tcp') server.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 }, resolve);
      else server.listen(options.socketPath, resolve);
    });
    state = 'listening';
    const address = server.address();
    return Object.freeze(
      mode === 'tcp'
        ? { mode, host: typeof address === 'object' && address !== null ? address.address : options.host, port: typeof address === 'object' && address !== null ? address.port : options.port }
        : { mode, path: options.socketPath },
    );
  }

  async function close() {
    if (state === 'closed') return;
    state = 'closed';
    for (const channel of channels) channel.close();
    channels.clear();
    await new Promise((resolve) => {
      if (server === undefined || typeof server.close !== 'function') {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return Object.freeze({
    mode,
    state: () => state,
    connectionCount: () => channels.size,
    jobBindings: () => Object.freeze([...bindings.values()]),
    onConnection(handler) {
      connectionHandlers.push(handler);
      return this;
    },
    listen,
    close,
  });
}
