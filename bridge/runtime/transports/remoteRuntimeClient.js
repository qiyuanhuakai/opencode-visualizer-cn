import { randomUUID } from 'node:crypto';
import { decodeFrame, encodeFrame, LIMITS, ProtocolError } from '../../../shared/runtime/protocol.js';
import { requireValue } from '../../../shared/runtime/capabilities.js';
import { parseRuntimeResult } from '../../../shared/runtime/runtimeWire.js';
import { relayRuntimeSocket } from './relayRuntime.js';

/** A retained, authenticated runtime connection. Never derives identity from its endpoint. */
export async function openRemoteRuntime({ endpoint, channel, environmentId, token, timeoutMs = 10000 }) {
  let socket;
  if (channel) socket = relayRuntimeSocket(channel);
  else {
    const url = new URL(endpoint);
    requireValue(['ws:', 'wss:'].includes(url.protocol), 'remote.endpoint');
    if (token) url.searchParams.set('bridgeToken', token);
    socket = new WebSocket(url);
  }
  socket.binaryType = 'arraybuffer';
  const pending = new Map(), listeners = new Set();
  const bindings = new Map(), children = new Map();
  let hello, closed = false, resolveHello, rejectHello;
  const ready = new Promise((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
  const timer = setTimeout(() => fail(new ProtocolError('timeout', 'remote.hello')), timeoutMs);
  function fail(error) {
    if (closed) return;
    closed = true; clearTimeout(timer); rejectHello(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear(); socket.close();
    for (const listener of listeners) listener({ kind: 'closed' });
  }
  socket.addEventListener('error', () => fail(new ProtocolError('source_unavailable', 'remote.socket')));
  socket.addEventListener('close', () => fail(new ProtocolError('source_unavailable', 'remote.closed')));
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string') {
        requireValue(hello && event.data.byteLength <= LIMITS.binaryBytes + 24, 'remote.binary');
        for (const listener of listeners) listener({ kind: 'binary', data: new Uint8Array(event.data) });
        return;
      }
      const frame = decodeFrame(event.data);
      if (!hello) {
        requireValue(frame.kind === 'hello' && frame.target === environmentId, 'remote.target', 'conflict');
        hello = frame; bindings.set(frame.target, frame); clearTimeout(timer); resolveHello(frame); return;
      }
      const bound = bindings.get(frame.target);
      requireValue(bound && frame.epoch === bound.epoch && frame.generation === bound.generation, 'remote.binding', 'reconcile_required');
      const request = frame.kind === 'result' ? pending.get(frame.id) : undefined;
      if (request) {
        requireValue(frame.target === request.target, 'remote.result_target', 'unauthorized');
        if (frame.ok && frame.phase === 'durable-accepted') { request.accepted?.(frame.result); return; }
        clearTimeout(request.timer); pending.delete(frame.id);
        if (frame.ok) request.resolve(parseRuntimeResult(request.method, frame.result));
        else {
          const legacyObserver = request.resolveSummary && frame.typedError.code === 'invalid_request'
            && frame.typedError.message === 'invalid_request: fields';
          const snapshotLimit = request.opensSnapshot && frame.typedError.code === 'conflict'
            && frame.typedError.message === 'conflict: runtime.store.snapshot_limit';
          const legacyInspection = request.sessionSearch && frame.typedError.code === 'invalid_request'
            && frame.typedError.message === 'invalid_request: fields';
          const field = snapshotLimit ? 'runtime.store.snapshot_limit' : legacyObserver || legacyInspection ? 'fields' : 'remote.request';
          request.reject(new ProtocolError(frame.typedError.code, field));
        }
      } else for (const listener of listeners) listener(frame);
    } catch (error) { fail(error); }
  });
  function request(frame, accepted, targetBinding = hello) {
    requireValue(!closed && hello, 'remote.connection', 'source_unavailable');
    requireValue(pending.size < 512 && socket.bufferedAmount < LIMITS.outboundBytes, 'remote.admission', 'source_unavailable');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new ProtocolError('timeout', 'remote.request')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method: frame.method, accepted, target: targetBinding.target,
        sessionSearch: frame.method === 'runtime.inspect' && frame.params?.sessionSearch === true,
        opensSnapshot: frame.method === 'runtime.snapshot' && frame.params?.token === undefined,
        resolveSummary: frame.method === 'runtime.observer.read' && frame.params?.resolveSummary === true });
      try { socket.send(encodeFrame({ ...frame, version: 1, kind: 'request', id, target: targetBinding.target, epoch: targetBinding.epoch, generation: targetBinding.generation })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  try {
    await ready;
    const inspection = await request({ method: 'runtime.inspect', params: { sessionSearch: true } }).catch(error => {
      if (!(error instanceof ProtocolError) || error.code !== 'invalid_request' || error.field !== 'fields') throw error;
      return request({ method: 'runtime.inspect', params: {} });
    });
    const grant = inspection.targets.find(entry => entry.target === environmentId);
    requireValue(grant && grant.capabilities.methods.every(method => method === 'runtime.session.search' || hello.capabilities.methods.includes(method)), 'remote.grant', 'unauthorized');
    if (grant.capabilities.methods.includes('runtime.session.search') && !hello.capabilities.methods.includes('runtime.session.search')) {
      hello = { ...hello, capabilities: { ...hello.capabilities, methods: [...hello.capabilities.methods, 'runtime.session.search'] } };
      bindings.set(hello.target, hello);
    }
    const subscribe = (target, listener) => {
      const filtered = frame => { if (frame.kind === 'closed' || frame.kind === 'binary' || frame.target === target) listener(frame); };
      listeners.add(filtered); return () => listeners.delete(filtered);
    };
    const sendBinary = data => { requireValue(!closed && socket.bufferedAmount + data.byteLength <= LIMITS.outboundBytes, 'remote.binary', 'source_unavailable'); socket.send(data); };
    const attachTarget = async target => {
      if (children.has(target)) return children.get(target);
      const attaching = (async () => {
        const result = await request({ method: 'runtime.target.attach', params: { target } });
        requireValue(result.hello.target === target && result.grant.target === target, 'remote.child_target', 'unauthorized');
        bindings.set(target, result.hello);
        return Object.freeze({
          hello: result.hello, grant: result.grant,
          request: (frame, accepted) => request(frame, accepted, result.hello),
          subscribe: listener => subscribe(target, listener),
          sendBinary,
          async close() {
            children.delete(target);
            try { await request({ method: 'runtime.target.detach', params: { target } }); }
            catch (error) { if (!(error instanceof ProtocolError) || !['unauthorized', 'source_unavailable', 'reconcile_required'].includes(error.code)) throw error; }
            finally { bindings.delete(target); }
          },
        });
      })();
      children.set(target, attaching);
      try { return await attaching; } catch (error) { children.delete(target); throw error; }
    };
    return Object.freeze({ hello, grant, inspection, request, attachTarget,
      subscribe: listener => subscribe(hello.target, listener),
      sendBinary,
      close() { fail(new ProtocolError('cancelled', 'remote.closed')); },
    });
  } catch (error) { fail(error); throw error; }
}
