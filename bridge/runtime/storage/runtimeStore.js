import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseOptions, parseRequest, StoreError, STORE_LIMITS } from './storeProtocol.js';

export function resolveStoreWorker(installRoot) {
  return installRoot ? { workerPath: path.resolve(installRoot, 'runtime/runtimeDatabaseWorker.mjs'), execPath: path.resolve(installRoot, `runtime/vis_bridge_node${process.platform === 'win32' ? '.exe' : ''}`) } : { workerPath: fileURLToPath(new URL('./runtimeDatabaseWorker.mjs', import.meta.url)), execPath: process.execPath };
}
export function createRuntimeStore(input) {
  const options = parseOptions(input);
  const { workerPath, execPath } = resolveStoreWorker(options.installRoot);
  const worker = fork(workerPath, [], { execPath, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map(); let sequence = 0; let bytes = 0; let normal = 0; let control = 0; let stopped = false;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  function settle(id, error, value) {
    const entry = pending.get(id); if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); bytes -= entry.bytes;
    if (entry.control) control--; else normal--;
    if (error) entry.reject(error); else entry.resolve(value);
  }
  function failAll(error) { stopped = true; for (const id of pending.keys()) settle(id, error); }
  worker.on('error', () => { failAll(new StoreError('source_unavailable', 'worker_exit')); worker.kill('SIGKILL'); });
  worker.on('exit', (code, signal) => { failAll(new StoreError('reconcile_required', 'worker_exit')); resolveExit({ code, signal, pid: worker.pid }); });
  worker.on('message', (message) => { if (message.ok) settle(message.id, null, message.result); else settle(message.id, new StoreError(message.error.code, message.error.reason)); });
  function request(method, params, reserved = false) {
    if (stopped) return Promise.reject(new StoreError('source_unavailable', 'store_closed'));
    const size = Buffer.byteLength(JSON.stringify(params));
    if ((reserved ? control >= STORE_LIMITS.control : normal >= STORE_LIMITS.requests) || bytes + size > STORE_LIMITS.bytes - (reserved ? 0 : STORE_LIMITS.reservedBytes)) return Promise.reject(new StoreError('source_unavailable', 'queue_full'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { failAll(new StoreError('reconcile_required', 'worker_timeout')); worker.kill('SIGKILL'); }, options.requestTimeoutMs ?? 15000);
      pending.set(id, { resolve, reject, timer, bytes: size, control: reserved }); bytes += size;
      if (reserved) control++; else normal++;
      worker.send({ id, method, params }, (error) => { if (error) { failAll(new StoreError('reconcile_required', 'worker_exit')); worker.kill('SIGKILL'); } });
    });
  }
  const ready = request('initialize', options, true);
  // Keep failed startup observable through ready without an orphan rejection during shutdown.
  ready.catch(() => undefined);
  function dispatch(method, input, reserved = false) {
    try { return request(method, parseRequest(method, input), reserved); }
    catch (error) { return Promise.reject(error); }
  }
  return {
    ready, pid: worker.pid,
    mutate: (params) => dispatch('mutate', params),
    mutateControl: (params) => dispatch('mutateControl', params, true),
    readIntent: (params) => dispatch('readIntent', params, true),
    getControl: (params) => dispatch('getControl', params, true),
    get: (params) => dispatch('get', params), page: (params) => dispatch('page', params),
    snapshot: (params) => dispatch('snapshot', params), replay: (params) => dispatch('replay', params), readChunk: (params) => dispatch('readChunk', params),
    inspect: () => dispatch('inspect', {}, true),
    async close() { if (!stopped) { try { await dispatch('close', {}, true); } finally { worker.kill('SIGTERM'); } } return exited; },
    async terminate() { if (!stopped) { stopped = true; worker.kill('SIGKILL'); } return exited; },
    get queue() { return { normal, control, bytes }; },
  };
}
