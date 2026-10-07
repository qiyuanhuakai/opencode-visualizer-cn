import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connectUpstreamWebSocket } from '../../codexWebSocketProxy.js';
import { decodeWebSocketFrames, encodeWebSocketFrame } from '../../webSocketFrames.js';
import { request, response, muxFrame, fail, DshError } from '../../../shared/runtime/native/dsh/protocol.js';

const BODY_LIMIT = 16777216;
const FRAME_LIMIT = 2097152;
function maskedFrame(value, opcode = 1) {
  const frame = encodeWebSocketFrame(value, opcode);
  const headerLength = frame[1] === 127 ? 10 : frame[1] === 126 ? 4 : 2;
  const mask = randomBytes(4), payload = frame.subarray(headerLength);
  const header = Buffer.from(frame.subarray(0, headerLength)); header[1] |= 128;
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Trusted owned-child endpoint and credentials are injected by the Runtime host, never renderer data. */
export function createDshTransport({ getOwnedEndpoint, auth, deadlineMs = 15000 }) {
  let closed = false;
  const sockets = new Set(), requests = new Set();
  function capture() {
    if (closed) fail('source_unavailable', 'closed');
    const lease = getOwnedEndpoint();
    if (!lease || lease.state !== 'ready') fail(lease?.state === 'auth-required' ? 'unauthorized' : 'source_unavailable', 'not_ready');
    if (lease.nativeVersion !== '0.2.0-rc.2') fail('version_mismatch', 'native_version');
    if (lease.ownership !== 'owned' || !Number.isSafeInteger(lease.generation) || lease.generation < 1) fail('unauthorized', 'owned_child_required');
    const url = new URL(lease.origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('unauthorized', 'owned_endpoint');
    const frozen = Object.freeze({ origin: url.origin, authority: url.host, generation: lease.generation });
    return frozen;
  }
  function assertCurrent(lease) {
    const current = capture();
    if (current.origin !== lease.origin || current.generation !== lease.generation) fail('reconcile_required', 'owned_child_changed');
  }
  async function cookieFor(lease) {
    let cookie;
    try { cookie = await auth.getCookie(lease.authority); }
    catch { fail('unauthorized', 'credential_unavailable'); }
    if (typeof cookie !== 'string' || !cookie || /[\r\n\0]/.test(cookie)) fail('unauthorized', 'credential_unavailable');
    assertCurrent(lease);
    return cookie;
  }
  async function prepare(method, args, { signal, maxBytes = BODY_LIMIT } = {}) {
    const lease = capture(), rpcId = randomUUID();
    const payload = Buffer.from(JSON.stringify(request(method, args, rpcId)));
    if (payload.length > 1048576) fail('invalid_request', 'request_size');
    const cookie = await cookieFor(lease);
    if (signal?.aborted) fail('cancelled', 'request');
    let dispatched = false;
    return { lease,
      send(sendSignal = signal) {
        if (dispatched) fail('conflict', 'request_already_sent');
        assertCurrent(lease);
        if (sendSignal?.aborted) fail('cancelled', 'request');
        dispatched = true;
        // No await occurs between the caller's durable sent CAS and this native enqueue.
        return new Promise((resolve, reject) => {
          const req = httpRequest(`${lease.origin}/api/${method}`, { method: 'POST', agent: false,
            headers: { cookie, 'content-type': 'application/json', 'content-length': payload.length } });
          requests.add(req);
          const abort = () => req.destroy(new DshError('cancelled', 'dsh.request'));
          sendSignal?.addEventListener('abort', abort, { once: true });
          const timer = setTimeout(() => req.destroy(new DshError('timeout', 'dsh.deadline')), deadlineMs);
          const finish = (error, result) => {
            clearTimeout(timer); requests.delete(req); sendSignal?.removeEventListener('abort', abort);
            if (error) reject(error instanceof DshError ? error : new DshError('source_unavailable', 'dsh.transport'));
            else resolve(result);
          };
          req.once('error', (error) => finish(error));
          req.once('response', (res) => {
            if (res.statusCode === 401 || res.statusCode === 403) auth.invalidate(lease.authority);
            let size = 0; const chunks = [];
            res.on('data', (chunk) => {
              size += chunk.length;
              if (size > maxBytes) req.destroy(new DshError('source_unavailable', 'dsh.response_size'));
              else chunks.push(chunk);
            });
            res.once('error', (error) => finish(error));
            res.once('aborted', () => finish(new DshError('source_unavailable', 'dsh.response_aborted')));
            res.once('end', () => {
              try {
                assertCurrent(lease);
                if (res.statusCode === 401 || res.statusCode === 403) fail('unauthorized', 'native_auth');
                if (res.statusCode !== 200) fail('source_unavailable', 'http_status');
                const result = response(JSON.parse(Buffer.concat(chunks).toString('utf8')), rpcId);
                finish(null, result);
              } catch (error) {
                if (error instanceof DshError && error.code === 'unauthorized') auth.invalidate(lease.authority);
                finish(error instanceof DshError ? error : new DshError('invalid_request', 'dsh.response'));
              }
            });
          });
          req.end(payload);
        });
      },
    };
  }
  async function connect({ onDisconnect } = {}) {
    const lease = capture(), cookie = await cookieFor(lease);
    let upstream;
    try { upstream = await connectUpstreamWebSocket(`${lease.origin.replace('http:', 'ws:')}/api/remote.mux`, { cookie }, { handshakeTimeoutMs: deadlineMs }); }
    catch { auth.invalidate(lease.authority); fail('source_unavailable', 'mux_connect'); }
    try { assertCurrent(lease); } catch (error) { upstream.socket.destroy(); throw error; }
    const { socket, head } = upstream;
    sockets.add(socket);
    let ended = false, buffer = Buffer.alloc(0), fragments = [], fragmentBytes = 0, fragmenting = false;
    let counter = 0; const connectionId = randomUUID(), streams = new Map();
    const send = (value, opcode = 1) => {
      assertCurrent(lease);
      if (ended || socket.destroyed) fail('source_unavailable', 'mux_closed');
      const bytes = maskedFrame(value, opcode);
      if (socket.writableLength + bytes.length > 1048576) fail('source_unavailable', 'mux_backpressure');
      socket.write(bytes);
    };
    const finish = (error = new DshError('source_unavailable', 'dsh.mux_disconnected')) => {
      if (ended) return;
      ended = true; sockets.delete(socket); socket.destroy();
      for (const stream of streams.values()) stream.end(error);
      streams.clear(); onDisconnect?.(error);
    };
    const deliver = (bytes) => {
      const frame = muxFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      const stream = streams.get(frame.streamId);
      if (!stream) return;
      if (frame.type === 'item') stream.item(frame.value ?? null);
      else { streams.delete(frame.streamId); stream.end(frame.type === 'error' ? new DshError('source_unavailable', 'dsh.stream_error') : undefined); }
    };
    const consume = (chunk) => {
      try {
        assertCurrent(lease);
        if (buffer.length + chunk.length > FRAME_LIMIT + 65550) fail('source_unavailable', 'mux_size');
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeWebSocketFrames(buffer, { maxPayloadBytes: FRAME_LIMIT }); buffer = decoded.remaining;
        for (const frame of decoded.frames) {
          if (frame.masked) fail('invalid_request', 'masked_server');
          if (frame.opcode >= 8 && (!frame.fin || frame.payload.length > 125)) fail('invalid_request', 'control_frame');
          if (frame.opcode === 9) { send(frame.payload, 10); continue; }
          if (frame.opcode === 10) continue;
          if (frame.opcode === 8) { finish(new DshError([1003, 1008].includes(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000) ? 'invalid_request' : 'source_unavailable', 'dsh.mux_closed')); return; }
          if (frame.opcode === 1 && !fragmenting) {
            if (frame.fin) deliver(frame.payload);
            else { fragmenting = true; fragments = [frame.payload]; fragmentBytes = frame.payload.length; }
          } else if (frame.opcode === 0 && fragmenting) {
            fragmentBytes += frame.payload.length;
            if (fragmentBytes > FRAME_LIMIT) fail('source_unavailable', 'mux_size');
            fragments.push(frame.payload);
            if (frame.fin) { deliver(Buffer.concat(fragments)); fragments = []; fragmentBytes = 0; fragmenting = false; }
          } else fail('invalid_request', 'mux_opcode');
        }
      } catch (error) { finish(error instanceof DshError ? error : new DshError('invalid_request', 'dsh.mux_frame')); }
    };
    socket.on('data', consume); socket.once('close', () => finish()); socket.once('error', () => finish());
    if (head.length) queueMicrotask(() => consume(head));
    return { lease, connectionId,
      open(endpoint, args, { onItem, onEnd } = {}) {
        if (streams.size >= 16) fail('source_unavailable', 'stream_limit');
        const streamId = `${connectionId}:${++counter}`;
        const entry = { item: onItem ?? (() => {}), end: onEnd ?? (() => {}) };
        streams.set(streamId, entry);
        try { send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })); }
        catch (error) { streams.delete(streamId); throw error; }
        return { streamId, cancel() {
          if (!streams.delete(streamId)) return;
          if (!ended) send(JSON.stringify({ type: 'cancel', streamId }));
        } };
      },
      close() { finish(new DshError('cancelled', 'dsh.mux_closed')); },
    };
  }
  return { capture, assertCurrent, prepare, connect,
    async call(method, args, options) { const prepared = await prepare(method, args, options); return prepared.send(); },
    close() { closed = true; for (const req of requests) req.destroy(new DshError('cancelled', 'dsh.closed')); for (const socket of sockets) socket.destroy(); },
  };
}
