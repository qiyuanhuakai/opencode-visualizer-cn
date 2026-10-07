import { EventEmitter } from 'node:events';
import { StoreError } from '../storage/storeProtocol.js';
import { jsonValue } from '../../../shared/runtime/capabilities.js';

export function createAcpRpc({
  manager,
  agentId,
  onRequest,
  onNotification,
  onExit,
  onOutgoing,
  onResult,
  deadlineMs = 30000,
}) {
  const socket = new EventEmitter();
  const pending = new Map();
  const tombstones = new Set();
  let next = 1;
  let active = true;
  let attachment;
  const nativeRequests = new Set();
  let closing = Promise.resolve();
  let shutdownError;
  const expire = (id) => {
    tombstones.add(id);
    if (tombstones.size > 256) tombstones.delete(tombstones.values().next().value);
  };
  function assertCurrent() {
    if (!active) throw new StoreError('reconcile_required', 'stale_generation');
  }
  function write(message) {
    assertCurrent();
    const text = JSON.stringify(jsonValue(message));
    if (Buffer.byteLength(text) > 1048576) throw new StoreError('invalid_request', 'rpc_size');
    onOutgoing?.(message);
    socket.emit('message', text);
    if (message.id !== undefined && message.method === undefined) nativeRequests.delete(message.id);
  }
  function reply(id, result) {
    write({ jsonrpc: '2.0', id, result });
  }
  socket.send = (line) => {
    if (!active) return;
    const message = JSON.parse(line);
    if (message === null || typeof message !== 'object' || Array.isArray(message))
      return socket.close();
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        if (
          !(typeof message.id === 'string' || Number.isSafeInteger(message.id)) ||
          nativeRequests.size >= 256 ||
          nativeRequests.has(message.id)
        ) {
          socket.close();
          return;
        }
        nativeRequests.add(message.id);
        Promise.resolve()
          .then(() => onRequest(message))
          .catch((error) => {
            if (active)
              write({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: -32603,
                  message: error instanceof StoreError ? error.reason : 'runtime_request_failed',
                },
              });
          });
      } else onNotification(message);
      return;
    }
    onResult?.(message);
    const waiter = pending.get(message.id);
    if (!waiter) {
      if (!tombstones.has(message.id))
        onNotification({ method: 'runtime/unknown_response', params: {} });
      return;
    }
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    expire(message.id);
    if (message.error)
      waiter.reject(new StoreError('source_unavailable', `native_rpc_${message.error.code}`));
    else if ('result' in message) waiter.resolve(jsonValue(message.result));
    else waiter.reject(new StoreError('invalid_request', 'rpc_response'));
  };
  socket.close = () => {
    if (!active) return;
    active = false;
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      expire(id);
      waiter.reject(new StoreError('reconcile_required', 'stale_generation'));
    }
    pending.clear();
    nativeRequests.clear();
    socket.emit('close');
    onExit();
    closing = attachment?.close() ?? Promise.resolve();
    void closing.catch((error) => {
      shutdownError = error;
    });
  };
  attachment = manager.attach(agentId, socket, { runtime: true });
  if (!attachment) throw new StoreError('source_unavailable', 'runtime_attachment');
  function request(method, params, { control = false } = {}) {
    assertCurrent();
    const normal = [...pending.values()].filter((value) => !value.control).length;
    if ((!control && normal >= 256) || pending.size >= 288)
      throw new StoreError('source_unavailable', 'rpc_queue');
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer =
        method === 'session/prompt'
          ? undefined
          : setTimeout(() => {
              pending.delete(id);
              expire(id);
              reject(new StoreError('timeout', 'native_rpc'));
            }, deadlineMs);
      pending.set(id, { resolve, reject, timer, control });
      try {
        write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  return {
    request,
    reply,
    assertCurrent,
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    get active() {
      return active;
    },
    processGeneration: attachment.processGeneration,
    pid: attachment.pid,
    async close() {
      socket.close();
      await closing;
      socket.removeAllListeners();
      if (shutdownError) throw shutdownError;
    },
  };
}
