import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { connectUpstreamWebSocket } from '../../codexWebSocketProxy.js';
import { decodeWebSocketFrames } from '../../webSocketFrames.js';
import { ProtocolError } from '../../../shared/runtime/capabilities.js';
import { parseAck, parseFrame, record } from '../../../shared/runtime/native/kimiWeb/protocol.js';

const MAX_RESPONSE = 2097152;
const MAX_FRAME = 1048576;
function failure(code, reason) { return new ProtocolError(code, reason); }
function maskedFrame(payload, opcode = 1) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length > MAX_FRAME) throw failure('invalid_request', 'native_frame_size');
  const offset = bytes.length < 126 ? 2 : bytes.length <= 65535 ? 4 : 10;
  const frame = Buffer.alloc(offset + 4 + bytes.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (offset === 2 ? bytes.length : offset === 4 ? 126 : 127);
  if (offset === 4) frame.writeUInt16BE(bytes.length, 2);
  if (offset === 10) frame.writeBigUInt64BE(BigInt(bytes.length), 2);
  const mask = randomBytes(4); mask.copy(frame, offset);
  for (let i = 0; i < bytes.length; i++) frame[offset + 4 + i] = bytes[i] ^ mask[i % 4];
  return frame;
}
export function createKimiWebTransport({ endpoint, getAuthorization, deadlineMs = 15000 }) {
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw failure('invalid_request', 'native_endpoint');
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15000)
    throw failure('invalid_request', 'native_deadline');
  const active = new Set();
  let stopped = false;
  let connection;
  let connecting;
  let serial = 0;
  let generation = 0;
  let pings = 0, pongs = 0;
  const pending = new Map();
  async function authorization() {
    try {
      const value = await getAuthorization();
      if (typeof value !== 'string' || !value.startsWith('Bearer ') || /[\r\n]/u.test(value))
        throw failure('unauthorized', 'native_authorization');
      return value;
    } catch { throw failure('unauthorized', 'native_authorization'); }
  }
  async function prepare(method, pathname, body) {
    if (stopped) throw failure('source_unavailable', 'driver_closed');
    if (!pathname.startsWith('/') || pathname.startsWith('//')) throw failure('invalid_request', 'native_path');
    const url = new URL(pathname, base);
    if (url.origin !== base.origin) throw failure('invalid_request', 'native_path');
    const auth = await authorization();
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (bytes && bytes.length > MAX_FRAME) throw failure('invalid_request', 'native_payload_size');
    return Object.freeze({
      // The caller prepares auth and body before durable SENT. This function enqueues without an await.
      send(signal) {
        if (stopped) return Promise.reject(failure('source_unavailable', 'driver_closed'));
        if (signal?.aborted) return Promise.reject(failure('cancelled', 'native_cancelled'));
        return new Promise((resolve, reject) => {
          let settled = false;
          const request = (url.protocol === 'https:' ? https : http).request(url, {
            method, headers: { Authorization: auth, ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) },
          });
          active.add(request);
          const settle = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); active.delete(request);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
          };
          const abort = () => { settle(failure('cancelled', 'native_cancelled')); request.destroy(); };
          const timer = setTimeout(() => { settle(failure('timeout', 'native_timeout')); request.destroy(); }, deadlineMs);
          signal?.addEventListener('abort', abort, { once: true });
          request.on('error', () => settle(failure('source_unavailable', 'native_transport')));
          request.on('response', (response) => {
            const chunks = []; let size = 0;
            response.on('error', () => settle(failure('source_unavailable', 'native_response')));
            response.on('aborted', () => settle(failure('source_unavailable', 'native_response')));
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > MAX_RESPONSE) { settle(failure('replay_required', 'native_response_size')); request.destroy(); }
              else chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              if (response.statusCode === 401 || response.statusCode === 403) return settle(failure('unauthorized', 'native_authorization'));
              if (response.statusCode < 200 || response.statusCode >= 300) return settle(failure('source_unavailable', 'native_http'));
              if (response.statusCode === 204) return settle(null, null);
              let value;
              try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
              catch { return settle(failure('source_unavailable', 'native_json')); }
              if (pathname === '/openapi.json' || pathname === '/asyncapi.json') return settle(null, value);
              if (!value || typeof value.code !== 'number' || !Object.hasOwn(value, 'data'))
                return settle(failure('source_unavailable', 'native_envelope'));
              if (value.code !== 0) return settle(failure(value.code === 40112 ? 'unauthorized' : pathname.includes('page_token=') ? 'replay_required' : 'source_unavailable', 'native_business_error'));
              settle(null, value.data);
            });
          });
          request.end(bytes);
        });
      },
    });
  }
  async function request(method, pathname, body, signal) { return (await prepare(method, pathname, body)).send(signal); }
  function send(frame, opcode = 1) {
    if (!connection || connection.socket.destroyed) throw failure('source_unavailable', 'native_disconnected');
    if (connection.socket.writableLength > MAX_FRAME) throw failure('replay_required', 'native_backpressure');
    connection.socket.write(maskedFrame(opcode === 1 ? JSON.stringify(frame) : frame, opcode));
  }
  function control(type, payload = {}) {
    if (pending.size >= 256) return Promise.reject(failure('source_unavailable', 'native_control_queue'));
    const id = `vis-${generation}-${++serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id); reject(failure('timeout', 'native_ack_timeout'));
        connection?.socket.destroy();
      }, deadlineMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ type, id, payload }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  async function open(onFrame, onDisconnect) {
    if (stopped) throw failure('source_unavailable', 'driver_closed');
    if (connecting) return connecting;
    if (connection) return { generation, hello: connection.hello };
    connecting = (async () => {
      const auth = await authorization();
      const target = new URL('/api/v1/ws', base); target.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      let upstream;
      try { upstream = await connectUpstreamWebSocket(target.toString(), auth, { handshakeTimeoutMs: deadlineMs }); }
      catch { throw failure('source_unavailable', 'native_ws_connect'); }
      if (stopped) { upstream.socket.destroy(); throw failure('source_unavailable', 'driver_closed'); }
      generation++;
      const current = { socket: upstream.socket, hello: undefined };
      connection = current;
      let buffer = Buffer.alloc(0), fragments = [], fragmentedBytes = 0, lastInbound = Date.now();
      let helloResolve, helloReject;
      const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
      const helloTimer = setTimeout(() => { helloReject(failure('timeout', 'native_hello')); current.socket.destroy(); }, deadlineMs);
      let watchdog;
      function dispatch(bytes) {
        let frame;
        try { frame = parseFrame(JSON.parse(bytes.toString('utf8'))); }
        catch { current.socket.destroy(); return; }
        if (frame.type === 'server_hello') {
          if (current.hello || frame.payload?.protocol_version !== 2) { helloReject(failure('version_mismatch', 'native_ws_version')); current.socket.destroy(); return; }
          current.hello = record(frame.payload);
          clearTimeout(helloTimer);
          const interval = frame.payload.heartbeat_ms;
          if (!Number.isSafeInteger(interval) || interval < 1 || interval > 120000) { helloReject(failure('invalid_request', 'native_heartbeat')); current.socket.destroy(); return; }
          watchdog = setInterval(() => { if (Date.now() - lastInbound > interval * 3) current.socket.destroy(); }, interval);
          helloResolve(current.hello);
        } else if (frame.type === 'ping') {
          pings++;
          if (frame.payload && Object.hasOwn(frame.payload, 'nonce')) { send({ type: 'pong', payload: { nonce: frame.payload.nonce } }); pongs++; }
        } else if (frame.type === 'ack') {
          const entry = pending.get(frame.id);
          if (entry) {
            pending.delete(frame.id); clearTimeout(entry.timer);
            try { entry.resolve(parseAck(frame)); } catch (error) { entry.reject(error); }
          }
        } else onFrame(frame, generation);
      }
      function receive(chunk) {
        lastInbound = Date.now();
        try {
          if (buffer.length + chunk.length > MAX_FRAME + 65536) throw failure('replay_required', 'native_frame_size');
          const decoded = decodeWebSocketFrames(Buffer.concat([buffer, chunk]), { maxPayloadBytes: MAX_FRAME });
          buffer = decoded.remaining;
          for (const frame of decoded.frames) {
            if (frame.masked) throw failure('invalid_request', 'native_server_mask');
            if (frame.opcode === 8) { current.socket.destroy(); return; }
            if (frame.opcode === 9) { send(frame.payload, 10); continue; }
            if (frame.opcode === 10) continue;
            if (frame.opcode !== 0 && frame.opcode !== 1) throw failure('invalid_request', 'native_opcode');
            if ((frame.opcode === 0) !== (fragments.length > 0)) throw failure('invalid_request', 'native_fragment');
            fragments.push(frame.payload); fragmentedBytes += frame.payload.length;
            if (fragmentedBytes > MAX_FRAME) throw failure('replay_required', 'native_frame_size');
            if (frame.fin) { dispatch(Buffer.concat(fragments)); fragments = []; fragmentedBytes = 0; }
          }
        } catch { current.socket.destroy(); }
      }
      current.socket.on('data', receive);
      current.socket.on('error', () => current.socket.destroy());
      current.socket.once('close', () => {
        clearTimeout(helloTimer); clearInterval(watchdog);
        helloReject(failure('source_unavailable', 'native_disconnected'));
        if (connection === current) connection = undefined;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure('reconcile_required', 'native_ack_lost')); }
        pending.clear();
        onDisconnect(generation);
      });
      if (upstream.head.length) receive(upstream.head);
      await hello;
      await control('client_hello', { client_id: 'vis-runtime', subscriptions: [] });
      return { generation, hello: current.hello };
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }
  async function disconnect() {
    const socket = connection?.socket;
    if (!socket) return;
    await new Promise((resolve) => { socket.once('close', resolve); socket.destroy(); });
  }
  async function close() {
    stopped = true;
    for (const request of active) request.destroy();
    await disconnect();
    if (connecting) await connecting.catch((error) => { if (!(error instanceof ProtocolError)) throw error; });
  }
  return { request, prepare, open, control, disconnect, close, get connected() { return !!connection && !connection.socket.destroyed; }, get generation() { return generation; }, get heartbeats() { return { pings, pongs }; } };
}
