import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export function createSessionStorage(filePath, createWorker = (filename, options) => new Worker(filename, options)) {
  const workerPath = fileURLToPath(new URL('./sessionDatabaseWorker.mjs', import.meta.url)).replace(/app\.asar([/\\])/u, 'app.asar.unpacked$1');
  const worker = createWorker(workerPath, { workerData: { filePath } });
  const requests = new Map();
  const cache = new Map();
  const changes = [];
  let sequence = 0;
  let ready = false;
  let failure = null;
  let closing = null;
  let closed = false;
  const fail = (error) => {
    failure = error;
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (!closed) fail(new Error(`Session database worker exited (${code})`)); });
  worker.on('message', (response) => {
    const request = requests.get(response.id);
    if (!request) return;
    requests.delete(response.id);
    if (response.ok) request.resolve(response.value);
    else request.reject(Object.assign(new Error(response.error.message), { name: response.error.name }));
  });
  function send(method, payload) {
    if (closed || closing) return Promise.reject(new Error('Session database is closed'));
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      requests.set(id, { resolve, reject });
      try { worker.postMessage({ id, method, payload }); }
      catch (error) { requests.delete(id); reject(error); }
    });
  }
  function publish(committed) {
    for (const change of committed) {
      if (change.newValue === null) cache.delete(change.key);
      else cache.set(change.key, change.newValue);
      changes.push(change);
    }
    return committed;
  }
  return {
    async prepare() {
      const entries = await send('prepare');
      cache.clear();
      for (const [key, value] of Object.entries(entries)) cache.set(key, value);
      ready = true;
    },
    getItem(key) {
      if (!ready) return send('legacyGet', { key });
      if (key.startsWith('opencode.state.codexAuxiliaryHistory.v1.')) return send('readSnapshot', { key });
      return cache.get(key) ?? null;
    },
    async setItem(key, value) { const result = publish(await send('mutate', { key, value })); return result[0]?.oldValue ?? null; },
    async removeItem(key) { const result = publish(await send('mutate', { key, value: null })); return result[0]?.oldValue ?? null; },
    async setItemAsync(key, value) {
      if (!key.startsWith('opencode.state.codexAuxiliaryHistory.v1.')) throw new TypeError('Async storage is restricted to auxiliary history');
      const result = publish(await send('mutate', { key, value }));
      return result[0]?.oldValue ?? null;
    },
    async migrate(entries) { return publish(await send('migrate', entries)); },
    drainPendingChanges() { return changes.splice(0); },
    readHistory(payload) { return send('readHistory', payload); },
    upsertHistory(payload) { return send('upsertHistory', payload); },
    clearHistory(payload) { return send('clearHistory', payload); },
    flush() { return send('flush'); },
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      const closeRequest = send('close');
      closing = closeRequest.finally(async () => { closed = true; await worker.terminate(); });
      return closing;
    },
  };
}
