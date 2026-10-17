import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { createLegacyExportStorage } from '../../../electron/sessionStorage.js';
import { registerSessionDatabaseIpc } from '../../../electron/sessionDatabaseIpc.js';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';

export const sourceFiles = ['app/runtime/migration/legacyInventory.ts', 'app/runtime/migration/legacyExport.ts', 'app/runtime/migration/legacyBrowserSource.ts', 'shared/runtime/migration/legacyExport.js', 'shared/runtime/migration/streamingJson.js', 'electron/sessionDatabaseWorker.mjs', 'electron/legacyExportSource.mjs', 'electron/sessionStorage.js', 'electron/sessionDatabaseIpc.js', 'electron/preload.cjs', 'electron/main.js', 'electron-builder.yml', 'app/types/sessionDatabase.ts', 'electron/sessionStorage.d.ts', 'electron/sessionDatabaseIpc.d.ts', 'electron/legacyExportSource.d.mts'];
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (name, observed, expected) => { assert.deepEqual(observed, expected, name); return { name, observed, expected, passed: true }; };
const historyKey = 'opencode.state.codexAuxiliaryHistory.v1.thread';
async function fileHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(entry.parentPath, entry.name); return [path.relative(root, file), hash(await fs.readFile(file))];
  })));
}
function credentialCases() {
  const secret = 'matrix-private-canary';
  const urls = ['%2F', '%22', '%40', '%252F', '%2522', '%2540', '@', '"'].flatMap(delimiter => [
    'https://user:' + secret + delimiter + 'tail@host.invalid',
    'https://' + secret + delimiter + 'tail@host.invalid',
  ]);
  for (const key of ['TOKEN', 'PASSWORD', 'CLIENT_SECRET', 'API_KEY', 'AUTHORIZATION']) {
    const value = 'https://host.invalid/?' + key + '=' + secret;
    urls.push(value, encodeURIComponent(encodeURIComponent(value)));
  }
  const values = urls.flatMap(value => [value, JSON.stringify({ body: 'b'.repeat(16340), metadata: { endpoint: value } })]);
  for (const delimiter of ['%2f', '%22', '%252f', '%2522']) {
    const json = JSON.stringify({ metadata: { endpoint: 'https://u:' + secret + delimiter + 'tail@edge.invalid/a' } });
    for (const escaped of [json.replaceAll('/', '\\/'), json.replaceAll('https:', 'https\\u003a').replaceAll('/', '\\u002f').replaceAll('@', '\\u0040')]) {
      values.push(escaped, JSON.stringify({ info: escaped }), encodeURIComponent(encodeURIComponent(escaped)));
    }
  }
  for (const key of ['TOKEN', 'PASSWORD', 'CLIENT_SECRET', 'API_KEY', 'AUTHORIZATION']) {
    const json = JSON.stringify({ endpoint: 'https://edge.invalid/?' + key + '=' + secret });
    values.push(json.replaceAll('/', '\\/').replaceAll('?', '\\u003f').replaceAll('=', '\\u003d').replace(key, [...key].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')));
  }
  const benign = [
    'https://host.invalid/path/a@b',
    'https://host.invalid/path/with%2Fslash%22quote',
    'https://host.invalid/?description=token&client_secretary=public',
    JSON.stringify({ endpoint: 'https://host.invalid', email: 'reader@example.invalid' }),
    JSON.stringify({ endpoint: 'https://host.invalid/path/%2f%22', email: 'reader@example.invalid' }).replaceAll('/', '\\/'),
    JSON.stringify({ endpoint: 'https://host.invalid/path/%2f%22', email: 'reader@example.invalid' }).replaceAll('https:', 'https\\u003a').replaceAll('/', '\\u002f'),
  ];
  return { values, benign, secret };
}
async function credentialWorkerScenario(context) {
  const directory = path.join(context.temporaryRoot, 'credentials'); await fs.mkdir(directory);
  const file = path.join(directory, 'renderer-storage.json');
  const { values, benign, secret } = credentialCases();
  await fs.writeFile(file, JSON.stringify(Object.fromEntries([...values, ...benign].map((value, index) => [historyKey + index, value]))));
  const db = new DatabaseSync(path.join(directory, 'sessions.sqlite'));
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE threads(namespace TEXT,thread_id TEXT); CREATE TABLE messages(seq INTEGER PRIMARY KEY,namespace TEXT,thread_id TEXT,message_id TEXT,info TEXT); CREATE TABLE parts(namespace TEXT,thread_id TEXT,message_id TEXT,part_id TEXT,data TEXT,terminal INTEGER);');
  for (const [index, value] of values.entries()) db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(index, 'legacy-thread-id', 'credential', String(index), JSON.stringify({ metadata: { endpoint: value } }));
  db.close();
  const before = await fileHashes(directory); const worker = createLegacyExportStorage(file); const assertions = [];
  try {
    const token = await worker.exportOpen(); let next = token; const chunks = [];
    do { const page = await worker.exportPage({ token: next, limit: 7 }); chunks.push(...page.chunks); next = page.next; } while (next);
    assertions.push(check('worker scalar nested and SQLite credential matrix all quarantined', token.localOnlyRecords, values.length * 2));
    assertions.push(check('worker matrix leaves innocent URLs exportable', token.exportableRecords, benign.length));
    assertions.push(check('worker matrix payload and cursor contain no canary', JSON.stringify({ token, chunks }).includes(secret), false));
    assertions.push(check('worker innocent URL raw content preserved', chunks.map(chunk => hash(chunk.content)).sort(), benign.map(value => hash(value)).sort()));
    assertions.push(check('worker matrix all source bytes unchanged', await fileHashes(directory), before));
  } finally { await worker.close(); }
  const receipt = path.join(context.outDir, path.basename(context.out, '.json') + '-credentials.json');
  writeJson(receipt, { assertions, sourceHashes: before, workerClosed: true });
  return { name: 'real worker credential URL matrix and lossless innocent URLs', assertions, artifacts: [artifact(receipt, 'credential-worker-matrix')] };
}
async function electronScenario(context) {
  const root = path.join(context.temporaryRoot, 'electron'); await fs.mkdir(root);
  const file = path.join(root, 'renderer-storage.json');
  const body = JSON.stringify({ version: 1, threadId: 'thread', entries: [{ body: '🦉正文'.repeat(12000) }] });
  await fs.writeFile(file, JSON.stringify({ [historyKey]: body, 'opencode.drafts.composer.v1': 'draft' }));
  await fs.writeFile(path.join(root, 'renderer-settings.json'), JSON.stringify({ 'opencode.settings.regionTheme.v1': 'light', 'opencode.auth.codexBridgeToken.v1': 'fixture-private-token', 'opencode.auth.serverUrl.v1': 'https://user:fixture-private-token@fixture.invalid' }));
  const shardDir = `${file}.history`; await fs.mkdir(shardDir);
  const shard = path.join(shardDir, `${hash(historyKey)}.json`);
  await fs.writeFile(shard, JSON.stringify({ [historyKey]: 'shadowed original' }));
  const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE threads(namespace TEXT,thread_id TEXT); CREATE TABLE messages(seq INTEGER PRIMARY KEY,namespace TEXT,thread_id TEXT,message_id TEXT,info TEXT); CREATE TABLE parts(namespace TEXT,thread_id TEXT,message_id TEXT,part_id TEXT,data TEXT,terminal INTEGER);');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('legacy-import-v1', 'complete');
  db.prepare('INSERT INTO kv VALUES(?,?)').run('opencode.favorites.messages.v1', 'favorites');
  db.prepare('INSERT INTO threads VALUES(?,?)').run('legacy-thread-id', 'cleared');
  for (let i = 0; i < 205; i++) db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(i, 'legacy-thread-id', 'thread', `m${i}`, JSON.stringify({ body: `message-${i}` }));
  db.prepare('INSERT INTO parts VALUES(?,?,?,?,?,?)').run('legacy-thread-id', 'thread', 'm0', 'p0', '{"text":"part"}', 1);
  db.close();
  const before = await fileHashes(root);
  const handlers = new Map(); let workerCount = 0; let closed = 0;
  registerSessionDatabaseIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, assertTrustedRenderer: event => assert.equal(event.trusted, true), getStorage: () => { throw new Error('Normal storage must not initialize'); }, getLegacyExportStorage: () => {
    workerCount++; const worker = createLegacyExportStorage(file); return { ...worker, close: async () => { await worker.close(); closed++; } };
  }, broadcastHistoryChange: () => { throw new Error('Read-only export must not broadcast mutation'); } });
  const invoke = (method, payload) => handlers.get(`session-database-${method}`)({ trusted: true }, payload);
  const assertions = [];
  const token = await invoke('exportOpen');
  assertions.push(check('every SQLite KV settings root shard record accounted for', [token.records, token.exportableRecords, token.localOnlyRecords], [215, 213, 2]));
  const chunks = []; let next = token; let pages = 0;
  do { const page = await invoke('exportPage', { token: next, limit: 100 }); chunks.push(...page.chunks); next = page.next; pages++; } while (next);
  assertions.push(check('resume spans multiple real worker pages', pages >= 3, true));
  assertions.push(check('205 SQLite message rows preserved', chunks.filter(chunk => chunk.source.endsWith('/sqlite/messages') && chunk.end).length, 205));
  const expectedMessages = Array.from({ length: 205 }, (_, i) => JSON.stringify({ seq: i, namespace: 'legacy-thread-id', thread_id: 'thread', message_id: `m${i}`, info: JSON.stringify({ body: `message-${i}` }) })).join('\n');
  assertions.push(check('all SQLite message bodies match independent source hash', hash(chunks.filter(chunk => chunk.source.endsWith('/sqlite/messages')).map(chunk => chunk.content).join('\n')), hash(expectedMessages)));
  assertions.push(check('all source files unchanged by initial export', await fileHashes(root), before));
  assertions.push(check('cleared thread tombstone preserved', chunks.some(chunk => chunk.authority === 'clear-tombstone'), true));
  assertions.push(check('legacy duplicate provenance preserved', chunks.some(chunk => chunk.authority === 'shadowed-by-root'), true));
  const historyChunks = chunks.filter(chunk => chunk.source.endsWith('/legacy-root') && chunk.content !== 'draft');
  assertions.push(check('raw Unicode history independent body hash', hash(historyChunks.map(chunk => chunk.content).join('')), hash(body)));
  assertions.push(check('chunk size at most 64KiB', chunks.every(chunk => Buffer.byteLength(chunk.content) <= 65536), true));
  assertions.push(check('independent SHA256 for every chunk', chunks.every(chunk => hash(chunk.content) === chunk.checksum), true));
  assertions.push(check('credential key and URL value stay local', JSON.stringify(chunks).includes('fixture-private-token'), false));
  await assert.rejects(handlers.get('session-database-exportOpen')({ trusted: false }));
  assertions.push(check('untrusted IPC did not create worker', workerCount, closed));
  if (context.case === 'failure') {
    await fs.appendFile(shard, 'garbage');
    await assert.rejects(invoke('exportOpen'), { code: 'corrupt_source' });
    assertions.push(check('corrupt shard remains available unchanged by reader', await fs.readFile(shard, 'utf8'), JSON.stringify({ [historyKey]: 'shadowed original' }) + 'garbage'));
    await fs.writeFile(shard, JSON.stringify({ [historyKey]: 'shadowed original' }));
    await fs.writeFile(file, JSON.stringify({ [historyKey]: body, 'opencode.drafts.composer.v1': 'new revision' }));
    await assert.rejects(invoke('exportPage', { token }), { code: 'source_changed' });
    await fs.writeFile(file, JSON.stringify({ [historyKey]: body, 'opencode.drafts.composer.v1': 'draft' }));
    const unknown = new DatabaseSync(path.join(root, 'sessions.sqlite'));
    unknown.prepare('INSERT INTO threads VALUES(?,?)').run('unknown-namespace', 'thread'); unknown.close();
    await assert.rejects(invoke('exportOpen'), { code: 'unknown_namespace' });
    const restore = new DatabaseSync(path.join(root, 'sessions.sqlite')); restore.prepare('DELETE FROM threads WHERE namespace=?').run('unknown-namespace'); restore.close();
    // SQLite header changes from the synthetic test writes; compare the reader against the new source baseline below.
    const failureBefore = await fileHashes(root); await invoke('exportOpen');
    assertions.push(check('failed and resumed exports leave latest SQLite source untouched', await fileHashes(root), failureBefore));
    assertions.push(check('stale resume rejected', true, true));
  } else assertions.push(check('all original source file hashes unchanged', await fileHashes(root), before));
  assertions.push(check('every IPC worker closed including failures', closed, workerCount));
  const receipt = path.join(context.outDir, `${path.basename(context.out, '.json')}-electron.json`);
  writeJson(receipt, { assertions, before, after: await fileHashes(root), workerCount, closed, pages });
  return { name: 'real Electron Node SQLite worker and trusted IPC', assertions, artifacts: [artifact(receipt, 'worker-source-hash-receipt')] };
}

async function browserExercise(matrix) {
  const { createBrowserLegacySource, openLegacyExport, readLegacyExportPage } = await import('/app/runtime/migration/legacyExport.ts');
  const assertions = [];
  const equal = (name, observed, expected) => { if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error(name); assertions.push({ name, observed, expected, passed: true }); };
  const digest = async value => (await fetch('/hash', { method: 'POST', body: value })).text();
  let foreignOrigin = false; try { createBrowserLegacySource({ storage: localStorage, indexedDB, origin: 'https://other.invalid' }); } catch (error) { foreignOrigin = error.code === 'origin_mismatch'; }
  equal('foreign origin access refused', foreignOrigin, true);
  const { legacyKeyInventory } = await import('/app/runtime/migration/legacyInventory.ts');
  const expected = new Map();
  for (const item of legacyKeyInventory) {
    localStorage.setItem(item.key, item.localOnly ? 'fixture-private-token' : `value-${item.category}`);
    if (!item.localOnly) expected.set(item.key, `value-${item.category}`);
  }
  for (const [key, value] of [
    ['opencode.state.pinnedSessions.v1', JSON.stringify(Array.from({ length: 10001 }, (_, i) => `pin-${i}`))],
    ['opencode.state.acpMessageAttribution.v1', JSON.stringify(Array.from({ length: 31 }, () => Array.from({ length: 501 }, (_, i) => i)))],
    ['opencode.state.kimiWebTurnPermissions.v1', JSON.stringify(Array.from({ length: 1001 }, (_, i) => i))],
    ['opencode.state.codexThreadActivity.v1', JSON.stringify({ old: { active: true } })],
  ]) { localStorage.setItem(key, value); expected.set(key, value); }
  const large = JSON.stringify({ entries: [{ body: '原样🦉'.repeat(13000) }] });
  localStorage.setItem('opencode.drafts.composer.v1', large); expected.set('opencode.drafts.composer.v1', large);
  localStorage.setItem('opencode.auth.credentials.v1', 'fixture-private-token');
  localStorage.setItem(`opencode.kimiWebSessionModes.${encodeURIComponent('["https://u:fixture-private-token@host","session"]')}`, 'mode');
  localStorage.setItem('opencode.auth.serverUrl.v1', 'https://host/?token=fixture-private-token');
  expected.delete('opencode.auth.serverUrl.v1');
  expected.set(`opencode.kimiWebSessionModes.${encodeURIComponent('["https://u:fixture-private-token@host","session"]')}`, 'mode');
  const databases = [['opencode.codexAuxiliaryHistory', 'snapshots'], ['opencode.backendHistory', 'histories']];
  for (const [name, store] of databases) await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { const table = request.result.createObjectStore(store); if (store === 'histories') table.createIndex('session', 'session'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const transaction = db.transaction(store, 'readwrite');
      if (store === 'snapshots') transaction.objectStore(store).put(large, 'opencode.state.codexAuxiliaryHistory.v1.thread');
      else { const scope = `opencode.state.backendHistory.v1.${'a'.repeat(32)}.thread`; transaction.objectStore(store).put({ session: scope, entry: { info: { id: 'm', sessionID: 'thread' }, parts: [{ body: 'body' }] } }, [scope, 'm']); }
      transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onerror = () => reject(transaction.error);
    };
  });
  const source = createBrowserLegacySource({ storage: localStorage, indexedDB, origin: location.origin });
  const token = await openLegacyExport(source); equal('separate exportable and local-only record counts', [token.exportableRecords, token.localOnlyRecords], [expected.size + 2, 7]); let next = token; const chunks = []; let pages = 0;
  do { const page = await readLegacyExportPage(source, { token: next, limit: pages === 0 ? 2 : 100 }); chunks.push(...page.chunks); next = page.next; pages++; } while (next);
  equal('browser pages pause and resume', pages > 1, true);
  equal('IDB snapshot body hash equals independently seeded body', await digest(chunks.filter(chunk => chunk.source.includes('/snapshots')).map(chunk => chunk.content).join('')), await digest(large));
  const grouped = new Map();
  for (const chunk of chunks.filter(chunk => chunk.source.endsWith('/localStorage'))) grouped.set(chunk.sourceKey, (grouped.get(chunk.sourceKey) ?? '') + chunk.content);
  for (const [key, value] of expected) {
    const opaque = await digest(JSON.stringify([`browser:${await digest(location.origin)}/localStorage`, key]));
    equal('registered local body preserved by hash', await digest(grouped.get(opaque) ?? ''), await digest(value));
  }
  equal('all inventory and IDB records exported', chunks.filter(chunk => chunk.end).length, expected.size + 2);
  equal('secret in dynamic key and URL value withheld', JSON.stringify({ token, chunks }).includes('fixture-private-token'), false);
  equal('source is still present after export', localStorage.getItem('opencode.drafts.composer.v1'), large);
  // A real browser quota failure must not alter the previously committed source or its export revision.
  let quota = false;
  try { localStorage.setItem('quota-probe', 'q'.repeat(32 * 1024 * 1024)); } catch (error) { quota = error instanceof DOMException && error.name === 'QuotaExceededError'; }
  equal('real localStorage quota failure observed', quota, true);
  equal('revision survives failed quota write', (await openLegacyExport(source)).revision, token.revision);
  localStorage.setItem('opencode.drafts.composer.v1', 'changed');
  let stale = false; try { await readLegacyExportPage(source, { token }); } catch (error) { stale = error.code === 'source_changed'; }
  equal('stale browser revision is rejected', stale, true);
  localStorage.setItem('opencode.drafts.composer.v1', large);
  equal('source content restored for independent final hash', await digest(localStorage.getItem('opencode.drafts.composer.v1')), await digest(large));
  for (const [index, value] of [...matrix.values, ...matrix.benign].entries()) localStorage.setItem('opencode.state.codexAuxiliaryHistory.v1.matrix-' + index, value);
  const matrixBefore = JSON.stringify(Object.entries(localStorage).sort());
  const matrixToken = await openLegacyExport(source); const matrixChunks = []; let matrixNext = matrixToken;
  do { const page = await readLegacyExportPage(source, { token: matrixNext, limit: 7 }); matrixChunks.push(...page.chunks); matrixNext = page.next; } while (matrixNext);
  equal('browser scalar nested boundary credential matrix all quarantined', matrixToken.localOnlyRecords - token.localOnlyRecords, matrix.values.length);
  equal('browser matrix leaves innocent URLs exportable', matrixToken.exportableRecords - token.exportableRecords, matrix.benign.length);
  equal('browser matrix payload and cursor contain no canary', JSON.stringify({ token: matrixToken, chunks: matrixChunks }).includes(matrix.secret), false);
  for (const [index, value] of matrix.benign.entries()) {
    const key = 'opencode.state.codexAuxiliaryHistory.v1.matrix-' + (matrix.values.length + index);
    const opaque = await digest(JSON.stringify([`browser:${await digest(location.origin)}/localStorage`, key]));
    equal('browser innocent URL raw content preserved', await digest(matrixChunks.filter(chunk => chunk.sourceKey === opaque).map(chunk => chunk.content).join('')), await digest(value));
  }
  equal('browser matrix original storage bytes unchanged', await digest(JSON.stringify(Object.entries(localStorage).sort())), await digest(matrixBefore));
  // Keep artifacts free of bodies or secret-bearing source identifiers.
  const safe = assertions.map(row => row.name === 'source is still present after export' ? { ...row, observed: true, expected: true } : row);
  document.body.textContent = `Legacy export: ${safe.length} assertions passed; ${pages} pages; isolated IDB and localStorage.`;
  return { assertions: safe, pages, secureContext: isSecureContext, subtleCryptoAvailable: Boolean(crypto.subtle), userAgent: navigator.userAgent };
}
async function browserScenario(context) {
  const server = await createServer({ configFile: false, appType: 'custom', root: context.root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, allowedHosts: ['vis-export-fixture.invalid'] } });
  server.middlewares.use('/hash', async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); response.end(hash(Buffer.concat(chunks)));
  });
  server.middlewares.use('/task11', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated legacy export QA</title><body>Legacy export fixture</body>'); });
  const session = `vis-task11-${process.pid}-${context.case}`;
  const command = async (...args) => {
    try { return await exec('agent-browser', ['--session', session, '--args', '--host-resolver-rules=MAP vis-export-fixture.invalid 127.0.0.1,--no-proxy-server', '--profile', path.join(context.temporaryRoot, 'browser-profile'), ...args], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) { throw new Error('Isolated browser command failed: ' + args[0] + ' (' + error.code + ')'); }
  };
  const artifacts = []; let closed = false;
  try {
    await server.listen(); const address = server.httpServer.address(); assert(address && typeof address === 'object');
    await command('open', `http://${context.case === 'failure' ? 'vis-export-fixture.invalid' : '127.0.0.1'}:${address.port}/task11`);
    const result = await command('eval', `(${browserExercise.toString()})((${credentialCases.toString()})())`, '--json');
    const envelope = JSON.parse(result.stdout); assert.equal(envelope.success, true);
    const value = envelope.data.result;
    assert(value.assertions.length >= 10);
    value.assertions.push(check('actual browser secure-context capability', value.secureContext, context.case !== 'failure'));
    value.assertions.push(check('actual browser SubtleCrypto capability', value.subtleCryptoAvailable, context.case !== 'failure'));
    const receipt = path.join(context.outDir, `${path.basename(context.out, '.json')}-browser.json`); writeJson(receipt, value); artifacts.push(artifact(receipt, 'real-browser-assertions'));
    const screenshot = path.join(context.outDir, `${path.basename(context.out, '.json')}-browser.png`); await command('screenshot', screenshot); artifacts.push(artifact(screenshot, 'screenshot'));
    return { name: 'real isolated browser IDB localStorage quota and resume', assertions: value.assertions, artifacts };
  } finally {
    try { await command('close'); closed = true; } finally { await server.close(); }
    const receipt = path.join(context.outDir, `${path.basename(context.out, '.json')}-browser-cleanup.json`); writeJson(receipt, { browserClosed: closed, serverClosed: !server.httpServer?.listening, isolatedProfile: true }); artifacts.push(artifact(receipt, 'resource-cleanup'));
  }
}
async function packagingScenario(context) {
  const require = createRequire(import.meta.url);
  const asar = createRequire(require.resolve('electron-builder'))('@electron/asar');
  const staging = path.join(context.temporaryRoot, 'package'); await fs.mkdir(staging);
  const files = ['electron/sessionStorage.js', 'electron/sessionDatabaseWorker.mjs', 'electron/legacyExportSource.mjs', 'shared/runtime/migration/legacyExport.js', 'shared/runtime/migration/streamingJson.js'];
  for (const file of files) { const target = path.join(staging, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(context.root, file), target); }
  await fs.writeFile(path.join(staging, 'package.json'), '{"type":"module"}');
  const target = path.join(context.temporaryRoot, 'app.asar');
  await asar.createPackageWithOptions(staging, target, { unpack: '**/{electron/sessionDatabaseWorker.mjs,electron/legacyExportSource.mjs,shared/runtime/migration/**/*}' });
  const assertions = [];
  for (const file of files.filter(file => !file.endsWith('sessionStorage.js'))) assertions.push(check('worker import exists outside ASAR', hash(await fs.readFile(path.join(`${target}.unpacked`, file))), hash(await fs.readFile(path.join(staging, file)))));
  // Real Node worker resolution from the unpacked package, including relative shared imports.
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(path.join(`${target}.unpacked`, 'electron/sessionDatabaseWorker.mjs'), { workerData: { filePath: path.join(context.temporaryRoot, 'absent', 'renderer-storage.json'), mode: 'legacy-export' } });
  try {
    const response = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); worker.postMessage({ id: 1, method: 'exportOpen' }); });
    assertions.push(check('unpacked worker imports and exports empty source', response.ok && response.value.count === 0, true));
    await assert.rejects(fs.access(path.join(context.temporaryRoot, 'absent')), { code: 'ENOENT' });
    assertions.push(check('readonly worker creates no absent source directory', true, true));
  } finally { await worker.terminate(); }
  const receipt = path.join(context.outDir, `${path.basename(context.out, '.json')}-asar.json`); writeJson(receipt, { assertions, workerClosed: true });
  return { name: 'actual ASAR unpacked worker dependency layout', assertions, artifacts: [artifact(receipt, 'asar-worker-receipt')] };
}
export async function run(context) {
  const packaging = await packagingScenario(context);
  const electron = await electronScenario(context);
  const browser = await browserScenario(context);
  const credentials = await credentialWorkerScenario(context);
  return { scenarios: [packaging, electron, browser, credentials].map(({ name, assertions }) => ({ name, assertions })), artifacts: [...packaging.artifacts, ...electron.artifacts, ...browser.artifacts, ...credentials.artifacts] };
}
