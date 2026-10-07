export async function browserFaults(configuration) {
  const { local, options, port, equal, assertions, digest, originalHash } = window.__migrationQa;
  const { createImportCoordinator } = await import('/app/runtime/migration/importCoordinator.ts');
  const gate = await import('/app/runtime/migration/writerFreeze.ts');
  const { storageSetJSON, StorageKeys } = await import('/app/utils/storageKeys.ts');
  const encoder = new TextEncoder();
  const rejection = async (name, run, expected) => { let error; try { await run(); } catch (value) { error = value; } equal(name, expected.includes(error?.code ?? error?.name), true); };
  const batch = Array.from({ length: 32 }, (_, index) => ({ identity: { context: 'qa-abort-' + index, clientOrigin: 'client-a', revision: 1 }, parts: [{ name: 'body', kind: 'body', bytes: encoder.encode('atomic-body-' + index) }], checkpoint: { key: 'qa-abort-' + index, value: { acknowledged: index } } }));
  const nativePut = IDBObjectStore.prototype.put; let headers = 0; let aborted = false;
  IDBObjectStore.prototype.put = function (...args) {
    const request = nativePut.apply(this, args);
    if (this.name === 'headers' && String(args[1]).includes('qa-abort-') && ++headers === 16) { aborted = true; this.transaction.abort(); }
    return request;
  };
  try { await rejection('actual mid-batch transaction abort rejects acknowledgement', () => local.commitInlineBatch(batch), ['unavailable', 'AbortError']); }
  finally { IDBObjectStore.prototype.put = nativePut; }
  equal('abort injected after sixteen real header puts', aborted, true);
  equal('entire concrete unacknowledged batch remains retained', [local.paused, local.pendingCount], [true, 1]);
  for (const entry of batch) {
    equal('no partial header acknowledged ' + entry.identity.context, await local.header(entry.identity) === undefined, true);
    equal('no partial progress acknowledged ' + entry.identity.context, await local.readCheckpoint(entry.checkpoint.key) === undefined, true);
  }
  await local.retry(); await local.commitInlineBatch(batch);
  equal('retry and identical replay drain exactly the retained batch', [local.paused, local.pendingCount], [false, 0]);
  for (const [index, entry] of batch.entries()) {
    const header = await local.header(entry.identity); let text = '';
    for await (const bytes of local.readPart(header, header.parts[0])) text += new TextDecoder().decode(bytes);
    equal('full retried body survives actual IndexedDB ' + index, text, 'atomic-body-' + index);
  }
  const header = await local.header(batch[0].identity);
  await local.commit({ parts: header.parts.map(part => ({ sha256: part.sha256, chunks: part.chunks, bytes: part.bytes, kind: part.kind, name: part.name })), revision: header.revision, clientOrigin: header.clientOrigin, context: header.context });
  equal('order-only immutable header replay preserves semantic fields', await local.header(header), header);
  await rejection('changed body under same revision remains an immutable conflict', () => local.commitInline(header, [{ name: 'body', kind: 'body', bytes: encoder.encode('different') }]), ['conflict']);
  await rejection('changed full body hash never acknowledges a header', () => local.commit({ ...header, parts: [{ ...header.parts[0], sha256: '0'.repeat(64) }] }), ['corrupt']);
  await rejection('changed byte count never acknowledges a header', () => local.commit({ ...header, parts: [{ ...header.parts[0], bytes: header.parts[0].bytes + 1 }] }), ['corrupt']);
  await rejection('missing data under a different revision never acknowledges a header', () => local.commit({ ...header, revision: 2 }), ['corrupt']);
  const database = await new Promise((resolve, reject) => { const request = indexedDB.open('vis-runtime-client', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const key = [JSON.stringify([header.context, header.clientOrigin, header.revision]), 'body', 0];
  const read = () => new Promise((resolve, reject) => { const request = database.transaction('bodies').objectStore('bodies').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const put = value => new Promise((resolve, reject) => { const tx = database.transaction('bodies', 'readwrite'); tx.objectStore('bodies').put(value, key); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  try {
    const original = await read(); await put({ ...original, bytes: encoder.encode('corrupted') });
    try {
      await rejection('actual persisted chunk corruption blocks lazy reads', async () => { for await (const bytes of local.readPart(header, header.parts[0])) void bytes; }, ['corrupt']);
      await rejection('corrupt existing bytes cannot be hidden by a matching stored hash field', () => local.commitInlineBatch([batch[0]]), ['corrupt']);
    } finally { await put(original); }
  } finally { database.close(); }
  let abortedWrite; const abortedSignal = new Promise(resolve => { abortedWrite = resolve; }); let injected = false;
  IDBObjectStore.prototype.put = function (...args) {
    const request = nativePut.apply(this, args);
    if (!injected && this.name === 'raw' && JSON.stringify(args[1]).includes('pending:')) {
      injected = true; this.transaction.addEventListener('abort', abortedWrite, { once: true }); this.transaction.abort();
    }
    return request;
  };
  try {
    for (let index = 0; index < 32; index++) storageSetJSON(StorageKeys.drafts.composer, { pending: index });
    equal('unacknowledged writer burst stays within count and byte budgets', gate.writerPendingState().count === 32 && gate.writerPendingState().bytes <= 8 * 1024 * 1024, true);
    const drained = rejection('real abort retains the entire writer queue until retry', () => gate.flushFrozenLegacyWrites(), ['unavailable', 'AbortError']);
    await rejection('the thirty-third unacknowledged edit is refused before source mutation', async () => storageSetJSON(StorageKeys.drafts.composer, { pending: 32 }), ['pending_budget']);
    await abortedSignal;
    await drained;
    await rejection('paused editing cannot admit another user edit', async () => gate.assertLegacyEditAdmission(), ['editing_paused']);
  } finally { IDBObjectStore.prototype.put = nativePut; }
  equal('failed post-freeze writes leave original source intact', await digest(JSON.stringify(Object.entries(localStorage).sort())), originalHash);
  await local.retry(); await gate.retryFrozenLegacyWrites();
  equal('all concrete pending edits become durable before queue eviction', gate.writerPendingState(), { count: 0, bytes: 0, failed: false });
  let cursor; const pendingValues = [];
  do { const page = await local.page({ after: cursor }); for (const item of page.headers.filter(value => value.context.startsWith('pending:'))) { let text = ''; for await (const bytes of local.readPart(item, item.parts[0])) text += new TextDecoder().decode(bytes); pendingValues.push(JSON.parse(text).pending); } cursor = page.next; } while (cursor);
  equal('all thirty-two admitted edits retain distinct durable revisions', pendingValues.sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index));
  await rejection('oversized pending edit is refused without exceeding the byte budget', async () => gate.retainFrozenLegacyWrite({ channel: 'storage', key: 'too-large', value: 'x'.repeat(4 * 1024 * 1024 + 1) }), ['pending_budget']);
  equal('rejected oversized edit is never retained as acknowledged', gate.writerPendingState().count, 0); await gate.retryFrozenLegacyWrites();
  for (const label of ['offset', 'binding', 'authority']) {
    let verification;
    const faulted = createImportCoordinator({ ...options, target: { ...options.target, service: { ...options.target.service, verify: async request => {
      const response = await fetch('/import/verify-fault-' + label, { method: 'POST', body: JSON.stringify(request) }); verification = await response.json();
      if (!response.ok) throw Object.assign(new Error(verification.code), { code: verification.code }); return verification;
    } } } });
    await rejection('persisted target ' + label + ' corruption prevents actual coordinator cutover', () => faulted.run(), ['corrupt_import']);
    equal('target ' + label + ' failure leaves real SQLite manifest staged', verification.phase, 'staged');
    equal('target ' + label + ' failure leaves browser checkpoint before cutover', (await local.readCheckpoint('migration-active')).phase === 'cutover', false);
    equal('target ' + label + ' failure preserves complete original source bytes', await digest(JSON.stringify(Object.entries(localStorage).sort())), originalHash);
  }
  let selected = configuration.environmentId;
  const switched = createImportCoordinator({ ...options, currentEnvironment: () => selected, target: { ...options.target, service: { ...options.target.service, accept: async request => { const result = await options.target.service.accept(request); selected = configuration.harnessInstanceId; return result; } } } });
  await rejection('target switch immediately after real durable ack blocks cutover', () => switched.run(), ['target_changed']);
  equal('target-switch checkpoint is not a successful cutover', (await local.readCheckpoint('migration-active')).phase === 'cutover', false);
  const raceKey = 'opencode.state.codexTurnEfforts.v1.racing-writer'; let opens = 0;
  const racing = createImportCoordinator({ ...options, source: { ...port, open: async () => { if (++opens === 2) localStorage.setItem(raceKey, '{"changed":true}'); return port.open(); } } });
  const stale = await port.open();
  try {
    await rejection('external old writer mutation between backup and target upload blocks cutover', () => racing.run(), ['source_changed']);
    await rejection('stale export cursor cannot be reused against changed source', () => port.page({ token: stale, limit: 8 }), ['source_changed']);
    equal('racing writer bytes remain in original source for reconciliation', localStorage.getItem(raceKey), '{"changed":true}');
    equal('source-race checkpoint is not a successful cutover', (await local.readCheckpoint('migration-active')).phase === 'cutover', false);
  } finally { localStorage.removeItem(raceKey); }
  let uploads = 0;
  const ambiguous = createImportCoordinator({ ...options, mappings: [...options.mappings, { ...options.mappings[0], profileId: configuration.harnessInstanceId }], target: { ...options.target, service: { accept: async () => { uploads++; throw new Error('ambiguous binding uploaded'); }, verify: async () => { throw new Error('ambiguous binding verified'); } } } });
  const localResult = await ambiguous.run(); equal('two plausible profile bindings remain entirely local', [localResult.boundRecords, uploads], [0, 0]);
  const wrongCheckpoint = createImportCoordinator({ ...options, currentEnvironment: () => configuration.harnessInstanceId, target: { ...options.target, environmentId: configuration.harnessInstanceId } });
  await rejection('a cutover checkpoint for another environment cannot authorize the current target', () => wrongCheckpoint.cutoverStatus(), ['target_changed']);
  equal('all failure probes preserve original complete source bytes', await digest(JSON.stringify(Object.entries(localStorage).sort())), originalHash);
  return { assertions, originalHash, retainedPendingRevisions: pendingValues.length };
}

export async function browserQuota(input) {
  const { equal, assertions, digest, originalHash } = window.__migrationQa;
  if (input.phase === 'fail') {
    window.__migrationQa.local.close();
    const { DraftStore } = await import('/app/runtime/draftStore.ts');
    window.__migrationQa.local = await DraftStore.open();
  }
  const local = window.__migrationQa.local;
  if (input.phase === 'fail') {
    let observed; let batch;
    for (let revision = 1; revision <= 32 && !observed; revision++) {
      batch = Array.from({ length: 32 }, (_, index) => ({ identity: { context: 'qa-quota-' + index, clientOrigin: 'client-a', revision }, parts: [{ name: 'body', kind: 'body', bytes: crypto.getRandomValues(new Uint8Array(65536)) }] }));
      try { await local.commitInlineBatch(batch); } catch (error) { observed = error.name; }
    }
    window.__quotaBatch = batch; window.__quotaExpectedHashes = await Promise.all(batch.map(entry => digest(entry.parts[0].bytes)));
    window.__quotaRevision = batch[0].identity.revision;
    equal('real Chromium quota exhaustion rejects the strict transaction', observed, 'QuotaExceededError');
    equal('quota failure retains concrete batch without acknowledging it', [local.paused, local.pendingCount], [true, 1]);
    for (const entry of batch) equal('quota cannot leave a partial durable header ' + entry.identity.context, await local.header(entry.identity) === undefined, true);
  } else {
    const batch = window.__quotaBatch;
    await local.retry();
    const { DraftDigest } = await import('/app/runtime/migration/draftChunks.ts');
    for (const [index, entry] of batch.entries()) {
      const header = await local.header(entry.identity); const sum = new DraftDigest();
      for await (const bytes of local.readPart(header, header.parts[0])) sum.update(bytes);
      equal('quota recovery full body matches independent Node hash ' + index, sum.finish(), input.expectedHashes[index]);
    }
    equal('quota retry releases pending bytes only after durable completion', [local.paused, local.pendingCount], [false, 0]);
  }
  equal('quota failure and retry preserve all original legacy bytes', await digest(JSON.stringify(Object.entries(localStorage).sort())), originalHash);
  return { assertions, originalHash, expectedHashes: window.__quotaExpectedHashes, quotaRevision: window.__quotaRevision };
}

export async function browserRestartFailures(input) {
  const { DraftStore } = await import('/app/runtime/draftStore.ts');
  const { DraftDigest } = await import('/app/runtime/migration/draftChunks.ts');
  const local = await DraftStore.open(); const assertions = [];
  const equal = (name, observed, expected) => { if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(name + ': ' + JSON.stringify(observed)); assertions.push({ name, observed, expected, passed: true }); };
  for (let index = 0; index < 32; index++) {
    const header = await local.header({ context: 'qa-quota-' + index, clientOrigin: 'client-a', revision: input.quotaRevision }); const sum = new DraftDigest();
    for await (const bytes of local.readPart(header, header.parts[0])) sum.update(bytes);
    equal('recovered quota batch remains durable after real browser restart ' + index, sum.finish(), input.expectedHashes[index]);
    const aborted = await local.header({ context: 'qa-abort-' + index, clientOrigin: 'client-a', revision: 1 }); let body = '';
    for await (const bytes of local.readPart(aborted, aborted.parts[0])) body += new TextDecoder().decode(bytes);
    equal('recovered aborted batch remains durable after restart ' + index, body, 'atomic-body-' + index);
  }
  const hash = await (await fetch('/hash', { method: 'POST', body: JSON.stringify(Object.entries(localStorage).sort()) })).text();
  equal('browser restart retains original complete source after all failures', hash, input.originalHash);
  local.close(); return { assertions };
}

export async function connectBrowserControl(url) {
  const socket = new WebSocket(url); const requests = new Map(); let next = 0;
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)); const request = requests.get(message.id);
    if (!request) return; requests.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(request.method + ': ' + JSON.stringify(message.error))); else request.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('owned browser closed')); } requests.clear(); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return {
    send(method, params = {}, sessionId) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error('CDP command timed out: ' + method)); }, 10000);
        requests.set(id, { resolve, reject, timer, method }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    async close() { socket.close(); await closed; },
    closed,
  };
}

export async function browserAuxiliaryFailure() {
  const storage = await import('/app/backends/codex/auxiliaryStorage.ts');
  const gate = await import('/app/runtime/migration/writerFreeze.ts');
  await storage.initializeCodexAuxiliaryStorage();
  const assertions = [];
  const equal = (name, observed, expected) => { if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(name + ': ' + JSON.stringify(observed)); assertions.push({ name, observed, expected, passed: true }); };
  const keyFor = thread => 'opencode.state.codexAuxiliaryHistory.v1.' + thread;
  const writeRemote = async (thread, value) => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('opencode.codexAuxiliaryHistory'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { await new Promise((resolve, reject) => { const tx = database.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put(JSON.stringify(value), keyFor(thread)); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); }
    finally { database.close(); }
  };
  const refreshFromRemote = async (thread, afterRead) => {
    const get = IDBObjectStore.prototype.get; let refreshed;
    const refresh = new Promise(resolve => { refreshed = resolve; });
    IDBObjectStore.prototype.get = function (...args) {
      const request = get.apply(this, args);
      if (this.transaction.db.name === 'opencode.codexAuxiliaryHistory' && args[0] === keyFor(thread)) {
        afterRead?.();
        this.transaction.addEventListener('complete', () => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); refreshed(); }; channel.port2.postMessage(null); }, { once: true });
      }
      return request;
    };
    const remote = new BroadcastChannel('opencode.codexAuxiliaryHistory');
    try { remote.postMessage(keyFor(thread)); await refresh; }
    finally { remote.close(); IDBObjectStore.prototype.get = get; }
  };
  await writeRemote('qa-read-race', { text: 'older remote value' });
  await refreshFromRemote('qa-read-race', () => storage.writeCodexAuxiliarySnapshot('qa-read-race', { text: 'accepted after read began' }));
  equal('read begun before a newly admitted write cannot replace its newer snapshot', storage.readCodexAuxiliarySnapshot('qa-read-race'), { text: 'accepted after read began' });
  await storage.flushCodexAuxiliaryStorage();
  const put = IDBObjectStore.prototype.put; let aborted = 0;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    if (this.transaction.db.name === 'opencode.codexAuxiliaryHistory' && args[1] === keyFor('qa-drain')) { aborted++; this.transaction.abort(); }
    return request;
  };
  const raw = { text: 'immutable accepted auxiliary snapshot' };
  try {
    storage.writeCodexAuxiliarySnapshot('qa-drain', raw); raw.text = 'later mutation';
    let rejected = false;
    try { await gate.freezeLegacyWriters({ clientOrigin: 'qa', persist: async () => {} }); } catch { rejected = true; }
    equal('a real aborted auxiliary IDB write prevents source freeze', [rejected, gate.legacyWriterPhase(), aborted > 0], [true, 'paused', true]);
    equal('failed accepted auxiliary bytes remain available for retry', storage.readCodexAuxiliarySnapshot('qa-drain'), { text: 'immutable accepted auxiliary snapshot' });
    await refreshFromRemote('qa-drain');
    equal('a real remote invalidation cannot replace an unacknowledged local snapshot', storage.readCodexAuxiliarySnapshot('qa-drain'), { text: 'immutable accepted auxiliary snapshot' });
    await writeRemote('qa-other', { text: 'independent remote value' }); await refreshFromRemote('qa-other');
    equal('another key continues refreshing while this key has failed writes', storage.readCodexAuxiliarySnapshot('qa-other'), { text: 'independent remote value' });

    rejected = false;
    try { await gate.retryFrozenLegacyWrites(); } catch { rejected = true; }
    equal('a second actual aborted auxiliary write still blocks cutover', [rejected, gate.legacyWriterPhase(), aborted >= 2], [true, 'paused', true]);
  } finally { IDBObjectStore.prototype.put = put; }
  await gate.retryFrozenLegacyWrites();
  equal('source freeze completes only after auxiliary transaction commits', gate.legacyWriterPhase(), 'frozen');
  const database = await new Promise((resolve, reject) => { const request = indexedDB.open('opencode.codexAuxiliaryHistory'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    const value = await new Promise((resolve, reject) => { const tx = database.transaction('snapshots', 'readonly'); const request = tx.objectStore('snapshots').get('opencode.state.codexAuxiliaryHistory.v1.qa-drain'); tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); });
    equal('independent durable read restores the exact accepted snapshot', value, JSON.stringify({ text: 'immutable accepted auxiliary snapshot' }));
    await writeRemote('qa-drain', { text: 'later acknowledged remote update' }); await refreshFromRemote('qa-drain');
    equal('remote invalidation resumes after the local write is acknowledged', storage.readCodexAuxiliarySnapshot('qa-drain'), { text: 'later acknowledged remote update' });
    await new Promise((resolve, reject) => { const tx = database.transaction('snapshots', 'readwrite'); for (const thread of ['qa-drain', 'qa-other', 'qa-read-race']) tx.objectStore('snapshots').delete(keyFor(thread)); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  } finally { database.close(); }
  return { assertions, aborted };
}

export async function browserCrashImport(input) {
  const { createBrowserLegacySource, openLegacyExport, readLegacyExportPage, resolveLegacyLocalBinding } = await import('/app/runtime/migration/legacyExport.ts');
  const { describeLocalBinding } = await import('/app/runtime/migration/legacyBinding.ts');
  const { createImportCoordinator } = await import('/app/runtime/migration/importCoordinator.ts');
  const { DraftStore } = await import('/app/runtime/draftStore.ts');
  const { StorageKeys, storageSetJSON } = await import('/app/utils/storageKeys.ts');
  const local = await DraftStore.open(); const assertions = [];
  const equal = (name, observed, expected) => { if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(name + ': ' + JSON.stringify(observed)); assertions.push({ name, observed, expected, passed: true }); };
  const digest = async value => (await fetch('/hash', { method: 'POST', body: value })).text();
  if (input.phase === 'seed') storageSetJSON(StorageKeys.drafts.composer, Object.fromEntries(Array.from({ length: 32 }, (_, index) => ['crash-source-' + index, { messageInput: 'crash body ' + index, attachments: [], unknown: { preserved: index } }])));
  const sourceHash = await digest(JSON.stringify(Object.entries(localStorage).sort()));
  if (input.phase === 'seed') { local.close(); return { sourceHash }; }
  const source = createBrowserLegacySource({ storage: localStorage, indexedDB, origin: location.origin });
  const port = { open: () => openLegacyExport(source), page: request => readLegacyExportPage(source, request), binding: async key => describeLocalBinding(await resolveLegacyLocalBinding(source, key), key) };
  const token = await port.open();
  if (input.phase === 'recover') {
    equal('killed migration retains the complete original source', sourceHash, input.sourceHash);
    let after; let incomplete = 0;
    do { const page = await local.page({ after, limit: 100 }); incomplete += page.headers.filter(header => header.context.startsWith('unattached:') && header.clientOrigin === 'legacy:' + token.revision && header.parts.some(part => part.kind === 'body')).length; after = page.next ?? undefined; } while (after);
    equal('browser kill before transaction completion acknowledges no batch headers', incomplete, 0);
  }
  const call = async (method, request) => { const response = await fetch('/import/' + method, { method: 'POST', body: JSON.stringify(request) }); const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.code), value); return value; };
  const options = { source: port, local, clientOrigin: 'crash-client', mappings: [{ profileId: input.profileId, environmentId: input.environmentId, harnessInstanceId: input.harnessInstanceId, nativeSessionId: 'same-native', scopeFingerprint: await digest('backend-history-v1:' + 'a'.repeat(32)), evidence: 'endpoint' }], currentEnvironment: () => input.environmentId, target: { environmentId: input.environmentId, service: { accept: batch => call('accept', batch), verify: request => call('verify', request) } } };
  const coordinator = createImportCoordinator(options);
  if (input.phase === 'start') {
    let held; const barrier = new Promise(resolve => { held = resolve; });
    const put = IDBObjectStore.prototype.put; let headers = 0;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === 'headers' && args[0]?.context?.startsWith('unattached:') && args[0].parts.some(part => part.kind === 'body')) {
        headers++;
        if (headers === 16) {
          const store = this; let reads = 0;
          const keepTransactionOpen = () => { const read = store.get('__crash_barrier__'); read.onsuccess = () => { reads++; if (reads === 2) held({ sourceHash, sourceRevision: token.revision, uncommittedHeaders: headers, transactionMode: store.transaction.mode }); keepTransactionOpen(); }; };
          keepTransactionOpen();
        }
      }
      return request;
    };
    void coordinator.run().then(() => held({ error: 'migration completed before crash barrier' }), error => held({ error: String(error) }));
    return barrier;
  }
  const result = await coordinator.run();
  equal('restart imports every original composer and question entry', result.drafts, 33);
  const bodies = []; let after;
  do {
    const page = await local.page({ after, limit: 100 });
    for (const header of page.headers.filter(header => header.context.startsWith('unattached:') && header.clientOrigin === 'legacy:' + result.sourceRevision)) {
      for (const part of header.parts.filter(part => part.kind === 'body')) { let text = ''; for await (const bytes of local.readPart(header, part)) text += new TextDecoder().decode(bytes); bodies.push(text); }
    }
    after = page.next ?? undefined;
  } while (after);
  equal('recovered migration restores every full original body', bodies.sort(), Array.from({ length: 32 }, (_, index) => 'crash body ' + index).sort());
  equal('successful retry preserves original source bytes', await digest(JSON.stringify(Object.entries(localStorage).sort())), sourceHash);
  local.close(); return { assertions, sourceHash, sourceRevision: result.sourceRevision };
}
