import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createImportService } from '../../../bridge/runtime/migration/importService.js';
import { createLegacyExportStorage } from '../../../electron/sessionStorage.js';
import { registerSessionDatabaseIpc } from '../../../electron/sessionDatabaseIpc.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';
export const environmentId = '11111111-1111-4111-8111-111111111111';
export const harnessInstanceId = '22222222-2222-4222-8222-222222222222';
export const profileId = '33333333-3333-4333-8333-333333333333';
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (name, observed, expected) => { assert.deepEqual(observed, expected, name); return { name, observed, expected, passed: true }; };
const binding = { environmentId, harnessInstanceId, nativeSessionId: 'same-native', profileId };
function batchFor(chunks, importId = hash('worker-fixture')) {
  return { importId, environmentId, sourceRevision: hash('unchanged source'), offset: 0, nextOffset: chunks.length, total: chunks.length, chunks };
}
function chunk(key, content, authority = 'sqlite-imported') { return { sourceKey: hash(key), content, checksum: hash(content), offset: 0, end: true, authority, binding }; }
function rows(directory) {
  const database = new DatabaseSync(path.join(directory, 'runtime/runtime.db'), { readOnly: true });
  try { return database.prepare('SELECT key,value FROM imports ORDER BY key').all().map(row => ({ key: row.key, value: JSON.parse(row.value) })); }
  finally { database.close(); }
}
function checkImportRows(assertions, name, values, chunks) {
  assertions.push(check(name, [values.filter(row => row.key.startsWith('chunk:')).length, values.filter(row => row.key.startsWith('admission:')).length,
    values.filter(row => row.key.startsWith('manifest:')).length, values.length], [chunks, 1, 1, chunks + 2]));
  assertions.push(check(name + ' admission descriptor stays bounded', values.filter(row => row.key.startsWith('admission:')).every(row =>
    Buffer.byteLength(JSON.stringify(row.value)) <= 65536 && row.value.entries.length <= 100), true));
}
async function manifestFaults(target, context, assertions) {
  const { store, directory } = target; await store.ready;
  const service = createImportService({ store, environmentId }); const observations = [];
  const fixture = async label => {
    const importId = hash('manifest-fault:' + label); const sourceKey = hash('manifest-source');
    const chunks = ['first🦉', 'other🦉'].map((content, index) => ({ ...chunk('unused', content, 'shadowed-by-root'), sourceKey, offset: index * Buffer.byteLength('first🦉'), end: index === 1 }));
    const batch = batchFor(chunks, importId); await service.accept(batch);
    return { batch, request: { importId, sourceRevision: batch.sourceRevision, expectedRecords: 1, expectedChunks: 2 }, values: rows(directory).filter(row => row.key.includes(importId)) };
  };
  for (const label of ['offset', 'binding', 'authority', 'native-id', 'profile-id', 'source-key', 'end', 'body', 'forged-checksum', 'extra-field', 'missing', 'extra', 'entity-key', 'reorder', 'declared-bytes', 'admission-seal', 'admission-source', 'admission-total', 'admission-extra', 'manifest-source', 'manifest-bytes', 'manifest-count', 'row-revision']) {
    const { batch, request, values } = await fixture(label);
    const original = values.find(row => row.key.startsWith('chunk:')); const admission = values.find(row => row.key.startsWith('admission:')); const manifest = values.find(row => row.key.startsWith('manifest:'));
    const database = new DatabaseSync(path.join(directory, 'runtime/runtime.db'));
    const put = (key, value) => database.prepare('UPDATE imports SET value=? WHERE key=?').run(JSON.stringify(value), key);
    try {
      const value = structuredClone(original.value);
      if (label === 'offset') value.offset = 999999;
      else if (label === 'binding') value.binding.harnessInstanceId = '44444444-4444-4444-8444-444444444444';
      else if (label === 'authority') value.authority = 'clear-tombstone';
      else if (label === 'native-id') value.binding.nativeSessionId = 'foreign-native';
      else if (label === 'profile-id') value.binding.profileId = '44444444-4444-4444-8444-444444444444';
      else if (label === 'source-key') value.sourceKey = hash('other-source');
      else if (label === 'end') value.end = true;
      else if (label === 'body') value.content = 'corrupted body';
      else if (label === 'forged-checksum') { value.content = 'other🦉'; value.checksum = hash(value.content); }
      else if (label === 'extra-field') value.unexpected = true;
      else if (label === 'missing') database.prepare('DELETE FROM imports WHERE key=?').run(original.key);
      else if (label === 'extra') database.prepare('INSERT INTO imports(environment,key,revision,value) VALUES(?,?,?,?)').run(environmentId, `chunk:${batch.importId}:${hash('extra')}:0000000000000000`, 1, JSON.stringify({ ...value, sourceKey: hash('extra') }));
      else if (label === 'entity-key') database.prepare('UPDATE imports SET key=? WHERE key=?').run(original.key + '-wrong', original.key);
      else if (label === 'reorder') { admission.value.entries.reverse(); put(admission.key, admission.value); }
      else if (label === 'declared-bytes') { admission.value.entries[0].bytes++; put(admission.key, admission.value); }
      else if (label === 'admission-seal') { admission.value.entries[0].digest = hash('forged'); put(admission.key, admission.value); }
      else if (label === 'admission-source') { admission.value.sourceRevision = hash('changed source'); put(admission.key, admission.value); }
      else if (label === 'admission-total') { admission.value.total++; put(admission.key, admission.value); }
      else if (label === 'admission-extra') database.prepare('INSERT INTO imports(environment,key,revision,value) VALUES(?,?,?,?)').run(environmentId, `admission:${batch.importId}:0000000000000999`, 1, JSON.stringify(admission.value));
      else if (label === 'manifest-source') { manifest.value.sourceRevision = hash('changed source'); put(manifest.key, manifest.value); }
      else if (label === 'manifest-bytes') { manifest.value.bytes++; put(manifest.key, manifest.value); }
      else if (label === 'manifest-count') { manifest.value.records = 0; put(manifest.key, manifest.value); }
      else if (label === 'row-revision') database.prepare('UPDATE imports SET revision=0 WHERE key=?').run(original.key);
      if (['offset', 'binding', 'authority', 'native-id', 'profile-id', 'source-key', 'end', 'body', 'forged-checksum', 'extra-field'].includes(label)) put(original.key, value);
    } finally { database.close(); }
    let error; try { await service.verify(request); } catch (caught) { error = caught; }
    const persisted = rows(directory).filter(row => row.key.includes(batch.importId));
    const phase = persisted.find(row => row.key.startsWith('manifest:')).value.phase;
    assertions.push(check('persisted ' + label + ' fault rejects without trusting unchanged row revision', [error?.code, phase], ['corrupt_import', 'staged']));
    observations.push({ label, request, rejection: error?.code, phase, persisted });
  }
  for (const label of ['read-race', 'commit-race', 'cached-race']) {
    const { batch, request, values } = await fixture(label); const key = values.find(row => row.key.startsWith('chunk:')).key;
    if (label === 'cached-race') await service.verify(request);
    let injected = false;
    const fault = async () => {
      injected = true; const current = await store.get({ collection: 'imports', key });
      await store.mutate({ intentId: 'concurrent-' + label, changes: [{ collection: 'imports', key, expectedRevision: current.revision, value: { ...current.value, authority: 'clear-tombstone' } }] });
    };
    const raced = createImportService({ environmentId, store: { ...store,
      get: async params => { const value = await store.get(params); if (label === 'read-race' && !injected && params.key === key) await fault(); return value; },
      mutate: async params => { if (label === 'commit-race' && !injected && params.intentId.startsWith('verify:')) await fault(); return store.mutate(params); },
      readIntent: async params => { const value = await store.readIntent(params); if (label === 'cached-race' && !injected && params.intentId.startsWith('verify:')) await fault(); return value; },
    } });
    let error; try { await raced.verify(request); } catch (caught) { error = caught; }
    const phase = rows(directory).find(row => row.key === `manifest:${batch.importId}`).value.phase;
    assertions.push(check('actual concurrent ' + label + ' cannot authorize cached or newly committed cutover', [injected, error?.code, phase], [true, 'source_revision_conflict', 'staged']));
    observations.push({ label, rejection: error?.code, phase, injected });
  }
  const valid = await fixture('valid-version'); const accepted = await service.verify(valid.request);
  assertions.push(check('unchanged verified snapshot returns its same durable acknowledgement', await service.verify(valid.request), accepted));
  const key = valid.values.find(row => row.key.startsWith('chunk:')).key; const current = await store.get({ collection: 'imports', key });
  await store.mutate({ intentId: 'new-storage-revision-same-bytes', changes: [{ collection: 'imports', key, expectedRevision: current.revision, value: current.value }] });
  const refreshed = await service.verify(valid.request);
  assertions.push(check('same bytes at a newer row revision require a fresh verified acknowledgement', refreshed.revision > accepted.revision && refreshed.intentId !== accepted.intentId, true));
  assertions.push(check('repeated verification of refreshed version returns only its current acknowledgement', await service.verify(valid.request), refreshed));
  const restored = rows(directory).filter(row => row.key.startsWith(`chunk:${valid.batch.importId}:`));
  assertions.push(check('valid contiguous source bytes and authority remain exact after version revalidation', [hash(restored.map(row => row.value.content).join('')), restored.map(row => row.value.authority)], [hash('first🦉other🦉'), ['shadowed-by-root', 'shadowed-by-root']]));
  const boundary = batchFor(Array.from({ length: 100 }, (_, index) => chunk('bounded-' + index, 'body-' + index)), hash('descriptor-boundary'));
  await service.accept(boundary); await service.verify({ importId: boundary.importId, sourceRevision: boundary.sourceRevision, expectedRecords: 100, expectedChunks: 100 });
  checkImportRows(assertions, 'maximum admitted batch has 100 chunks and one bounded immutable descriptor', rows(directory).filter(row => row.key.includes(boundary.importId)), 100);
  const receipt = path.join(context.outDir, 'failure-manifest-verification.json'); writeJson(receipt, { observations, accepted, refreshed, boundaryChunks: 100 });
  return artifact(receipt, 'persisted-manifest-faults-and-current-version');
}
export async function workerScenario(context) {
  const states = []; const assertions = []; const exits = []; const additionalArtifacts = [];
  const lifecycle = path.join(context.outDir, `${context.case}-worker-resources.json`);
  const resources = []; writeJson(lifecycle, { resources, phase: 'allocated' });
  const open = (name, options = {}) => {
    const directory = path.join(context.temporaryRoot, name);
    resources.push({ directory, state: 'starting' }); writeJson(lifecycle, { resources, phase: 'running' });
    const store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: profileId, epoch: harnessInstanceId, ...options });
    states.push(store); resources.at(-1).pid = store.pid; writeJson(lifecycle, { resources, phase: 'running' }); return { store, directory };
  };
  try {
    const first = open('target'); await first.store.ready;
    const service = createImportService({ store: first.store, environmentId });
    const content = [chunk('canonical', JSON.stringify({ info: { id: 'm1' }, parts: [{ text: 'raw Unicode 🦉', future: { preserve: true } }] })), chunk('tombstone', '{"cleared":true}', 'clear-tombstone'), chunk('shadow', '{"old":"do not resurrect"}', 'shadowed-by-root')];
    const batch = batchFor(content);
    const concurrent = await Promise.all([service.accept(batch), service.accept(batch)]);
    assertions.push(check('two clients receive one durable acknowledgement', concurrent[0], concurrent[1]));
    const before = rows(first.directory);
    checkImportRows(assertions, 'independent SQL contains exactly one manifest one admission and three raw chunks', before, 3);
    assertions.push(check('raw body and unknown fields match independent fixture hashes', before.filter(row => row.key.startsWith('chunk:')).map(row => hash(row.value.content)).sort(), content.map(value => hash(value.content)).sort()));
    assertions.push(check('tombstone and shadow authority are preserved separately', before.filter(row => row.key.startsWith('chunk:')).map(row => row.value.authority).sort(), ['clear-tombstone', 'shadowed-by-root', 'sqlite-imported']));
    const fence = (await first.store.inspect()).fence;
    exits.push(await first.store.terminate());
    const recovered = open('target', { takeover: { expectedFence: fence } }); await recovered.store.ready;
    const afterKill = createImportService({ store: recovered.store, environmentId });
    assertions.push(check('lost durable acknowledgement reconciles after real worker kill', await afterKill.accept(batch), concurrent[0]));
    await afterKill.verify({ importId: batch.importId, sourceRevision: batch.sourceRevision, expectedRecords: 3, expectedChunks: 3 });
    assertions.push(check('restart verification reads actual persisted target chunks', rows(first.directory).find(row => row.key.startsWith('manifest:')).value.phase, 'verified'));
    if (context.case === 'failure') {
      const beforeNegative = rows(recovered.directory);
      await assert.rejects(afterKill.accept({ ...batch, environmentId: harnessInstanceId }), { code: 'target_changed' });
      await assert.rejects(createImportService({ store: recovered.store, environmentId: harnessInstanceId }).accept({ ...batch, environmentId: harnessInstanceId }), { code: 'target_changed' });
      const changed = batchFor([chunk('canonical', 'changed')], batch.importId);
      await assert.rejects(afterKill.accept(changed), { code: 'source_revision_conflict' });
      await assert.rejects(afterKill.accept(batchFor([{ ...chunk('bad', 'body'), checksum: hash('different') }], hash('corrupt'))), { code: 'invalid_chunk' });
      await assert.rejects(afterKill.accept(batchFor([{ ...chunk('secret-extra', 'safe'), rawKey: 'https://u:private-canary@host' }], hash('secret'))), { code: 'invalid_chunk' });
      assertions.push(check('wrong target changed retry corrupt chunk and extra credential key never change target rows', rows(first.directory), beforeNegative));
      const conflictId = hash('cas-race');
      const alternatives = [batchFor([chunk('race', 'left')], conflictId), batchFor([chunk('race', 'right')], conflictId)];
      const raced = await Promise.allSettled(alternatives.map(value => afterKill.accept(value)));
      assertions.push(check('conflicting concurrent CAS intents admit exactly one source revision', raced.map(value => value.status).sort(), ['fulfilled', 'rejected']));
      const raceRows = rows(recovered.directory).filter(row => row.key.includes(conflictId));
      checkImportRows(assertions, 'losing CAS intent leaves no partial second chunk admission or manifest', raceRows, 1);
      const winner = raced.findIndex(value => value.status === 'fulfilled');
      assertions.push(check('winning CAS persists the independently known complete body', raceRows.find(row => row.key.startsWith('chunk:')).value.content, alternatives[winner].chunks[0].content));
      const corruptKey = beforeNegative.find(row => row.key.startsWith('chunk:')).key;
      const original = await recovered.store.get({ collection: 'imports', key: corruptKey });
      await recovered.store.mutate({ intentId: 'qa-corrupt-target', changes: [{ collection: 'imports', key: corruptKey, expectedRevision: original.revision, value: { ...original.value, content: 'altered-after-ack' } }] });
      await assert.rejects(afterKill.verify({ importId: batch.importId, sourceRevision: batch.sourceRevision, expectedRecords: 3, expectedChunks: 3 }), { code: 'corrupt_import' });
      assertions.push(check('full verification detects corrupt persisted body despite prior durable acknowledgement', rows(recovered.directory).find(row => row.key === corruptKey).value.content, 'altered-after-ack'));
      const corrupt = await recovered.store.get({ collection: 'imports', key: corruptKey });
      await recovered.store.mutate({ intentId: 'qa-restore-target', changes: [{ collection: 'imports', key: corruptKey, expectedRevision: corrupt.revision, value: original.value }] });
      await afterKill.verify({ importId: batch.importId, sourceRevision: batch.sourceRevision, expectedRecords: 3, expectedChunks: 3 });
      const doomed = open('before-ack'); await doomed.store.ready;
      const doomedFence = (await doomed.store.inspect()).fence;
      process.kill(doomed.store.pid, 'SIGSTOP');
      const pending = createImportService({ store: doomed.store, environmentId }).accept(batch);
      const rejected = assert.rejects(pending, error => ['reconcile_required', 'source_unavailable'].includes(error.code));
      exits.push(await doomed.store.terminate()); await rejected;
      assertions.push(check('worker killed before admission leaves no false acknowledged rows', rows(doomed.directory).length, 0));
      const retry = open('before-ack', { takeover: { expectedFence: doomedFence } }); await retry.store.ready;
      await createImportService({ store: retry.store, environmentId }).accept(batch);
      checkImportRows(assertions, 'same intent resumes after pre-ack interruption without duplicates', rows(retry.directory), 3);
      let interrupted = retry.store;
      for (let attempt = 0; attempt < 2; attempt++) {
        const interruptedFence = (await interrupted.inspect()).fence; exits.push(await interrupted.terminate());
        const resumed = open('before-ack', { takeover: { expectedFence: interruptedFence } }); await resumed.store.ready;
        const replayed = await createImportService({ store: resumed.store, environmentId }).accept(batch);
        assertions.push(check(`repeated interruption ${attempt + 1} returns the same durable acknowledgement`, replayed, concurrent[0]));
        assertions.push(check(`repeated interruption ${attempt + 1} retains full original chunk hashes`, rows(resumed.directory).filter(row => row.key.startsWith('chunk:')).map(row => hash(row.value.content)).sort(), content.map(value => hash(value.content)).sort()));
        interrupted = resumed.store;
      }

      const full = open('full', { storageBudgetBytes: 262144 }); await full.store.ready;
      const fullBatch = batchFor(Array.from({ length: 8 }, (_, index) => chunk(`large-${index}`, 'x'.repeat(60000))), hash('full'));
      await assert.rejects(createImportService({ store: full.store, environmentId }).accept(fullBatch), { code: 'source_unavailable', reason: 'disk_full' });
      assertions.push(check('actual SQLITE_FULL rolls back chunks progress and intent atomically', rows(full.directory).length, 0));
      const fullFence = (await full.store.inspect()).fence; exits.push(await full.store.terminate());
      const expanded = open('full', { takeover: { expectedFence: fullFence } }); await expanded.store.ready;
      await createImportService({ store: expanded.store, environmentId }).accept(fullBatch);
      checkImportRows(assertions, 'disk failure retry restores all eight chunks in real SQLite', rows(expanded.directory), 8);
      assertions.push(check('disk failure retry keeps all independently known body hashes', rows(expanded.directory).filter(row => row.key.startsWith('chunk:')).map(row => hash(row.value.content)).sort(), fullBatch.chunks.map(chunk => hash(chunk.content)).sort()));
      additionalArtifacts.push(await manifestFaults(open('manifest-verification'), context, assertions));
    }
    const receipt = path.join(context.outDir, `${context.case}-worker.json`); writeJson(receipt, { assertions, workerPids: states.map(store => store.pid), sourceBodyHashes: content.map(value => hash(value.content)) });
    return { name: 'actual Node24 RuntimeStore import durability and target isolation', assertions, artifacts: [artifact(receipt, 'runtime-worker-oracle'), ...additionalArtifacts] };
  } finally {
    for (const store of states) exits.push(await store.terminate());
    const live = states.filter(store => { try { process.kill(store.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }).map(store => store.pid);
    assert.deepEqual(live, []); writeJson(lifecycle, { resources, phase: 'closed', exits, live });
  }
}
export async function electronBindingScenario(context) {
  const directory = path.join(context.temporaryRoot, 'electron-binding'); await mkdir(directory);
  const file = path.join(directory, 'renderer-storage.json');
  const key = 'opencode.state.backendHistory.v1.' + 'a'.repeat(32) + '.same-native';
  const secretKey = 'opencode.kimiWebSessionModes.' + encodeURIComponent('["https://u:private-canary@host","same-native"]');
  await writeFile(file, JSON.stringify({ [key]: '{"raw":true}', [secretKey]: 'safe', 'opencode.drafts.composer.v1': '{}' }));
  const before = hash(await readFile(file)); const handlers = new Map(); let workers = 0; let closed = 0;
  registerSessionDatabaseIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, assertTrustedRenderer: event => assert.equal(event.trusted, true), getStorage: () => { throw new Error('legacy reader must not initialize ordinary storage'); }, getLegacyExportStorage: () => {
    workers++; const worker = createLegacyExportStorage(file); return { ...worker, close: async () => { await worker.close(); closed++; } };
  }, broadcastHistoryChange: () => { throw new Error('readonly binding must not broadcast writes'); } });
  const invoke = (method, payload) => handlers.get(`session-database-${method}`)({ trusted: true }, payload);
  const token = await invoke('exportOpen'); const page = await invoke('exportPage', { token }); const hints = [];
  for (const chunk of page.chunks) hints.push(await invoke('exportBinding', { sourceKey: chunk.sourceKey }));
  assert.equal(JSON.stringify(hints).includes('private-canary'), false);
  const assertions = [check('local IPC resolves proven scope without exposing endpoint or raw key', hints.some(hint => hint.nativeSessionId === 'same-native' && hint.scopeFingerprint === hash('backend-history-v1:' + 'a'.repeat(32))), true), check('credential-bearing raw keys stay private even through binding IPC', hints.every(hint => !('key' in hint) && !('endpoint' in hint)), true), check('private local resolver leaves original source bytes unchanged', hash(await readFile(file)), before)];
  await assert.rejects(handlers.get('session-database-exportBinding')({ trusted: false }, { sourceKey: page.chunks[0].sourceKey }));
  assertions.push(check('every readonly Electron worker closes including binding calls', workers, closed));
  const receipt = path.join(context.outDir, `${context.case}-electron-binding.json`); writeJson(receipt, { assertions, hints, workers, closed, sourceHash: before });
  return { name: 'actual readonly Electron binding worker and trusted IPC', assertions, artifacts: [artifact(receipt, 'electron-binding-oracle')] };
}
