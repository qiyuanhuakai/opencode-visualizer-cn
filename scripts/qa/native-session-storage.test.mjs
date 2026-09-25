import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStorage } from '../../electron/sessionStorage.js';
import { registerPersistentStorageIpc } from '../../electron/persistentStorageIpc.js';
import { registerSessionDatabaseIpc } from '../../electron/sessionDatabaseIpc.js';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const historyKey = 'opencode.state.codexAuxiliaryHistory.v1.thread';

test('loads the unpacked worker beneath a CommonJS parent package', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vis-worker-commonjs-'));
  let store;
  t.after(async () => {
    if (store) await Promise.allSettled([store.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const source = await fs.readFile(new URL('../../electron/sessionStorage.js', import.meta.url), 'utf8');
  const workerName = source.match(/new URL\('\.\/([^']+)'/u)?.[1];
  assert.ok(workerName, 'The production adapter must resolve its worker entry');
  await fs.writeFile(path.join(directory, 'sessionStorage.mjs'), source);
  await fs.copyFile(new URL(`../../electron/${workerName}`, import.meta.url), path.join(directory, workerName));
  const adapter = await import(pathToFileURL(path.join(directory, 'sessionStorage.mjs')).href);
  store = adapter.createSessionStorage(path.join(directory, 'profile', 'renderer-storage.json'));
  await store.prepare();
  await store.setItem('opencode.drafts.composer.v1', 'portable');
  assert.equal(store.getItem('opencode.drafts.composer.v1'), 'portable');
});
const entry = (id, partId, status = 'completed') => ({
  info: { id, sessionID: 'thread', role: 'assistant', time: { created: 1 } },
  parts: [{ id: partId, messageID: id, sessionID: 'thread', type: 'tool', state: { status, input: {} } }],
});
async function fixture(t, initial = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vis-sqlite-'));
  const file = path.join(directory, 'renderer-storage.json');
  await fs.writeFile(file, JSON.stringify(initial));
  const stores = [];
  t.after(async () => {
    await Promise.allSettled(stores.map((store) => store.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const open = () => { const store = createSessionStorage(file); stores.push(store); return store; };
  return { directory, file, open };
}

test('imports legacy history and KV without changing backups; clear cannot resurrect on restart', async (t) => {
  const initial = { [historyKey]: JSON.stringify({ version: 1, threadId: 'thread', entries: [entry('m', 'p')] }), 'opencode.drafts.composer.v1': 'draft' };
  const fixtureData = await fixture(t, initial);
  const before = await fs.readFile(fixtureData.file, 'utf8');
  const store = fixtureData.open();
  await store.prepare();
  assert.equal(store.getItem('opencode.drafts.composer.v1'), 'draft');
  assert.deepEqual((await store.readHistory({ threadId: 'thread' })).entries, [entry('m', 'p')]);
  await store.clearHistory({ threadId: 'thread' });
  await store.close();
  const restarted = fixtureData.open();
  await restarted.prepare();
  assert.deepEqual((await restarted.readHistory({ threadId: 'thread' })).entries, []);
  await restarted.migrate(initial);
  assert.deepEqual((await restarted.readHistory({ threadId: 'thread' })).entries, []);
  assert.equal(await fs.readFile(fixtureData.file, 'utf8'), before);
});

test('merges interleaved parts and prevents terminal status regression with indexed pages', async (t) => {
  const { open } = await fixture(t);
  const store = open();
  await store.prepare();
  await store.upsertHistory({ threadId: 'thread', entries: [entry('a', 'one')] });
  await store.upsertHistory({ threadId: 'thread', entries: [entry('a', 'two'), entry('b', 'three')] });
  await store.upsertHistory({ threadId: 'thread', entries: [entry('a', 'one', 'running')] });
  const first = await store.readHistory({ threadId: 'thread', limit: 1 });
  assert.equal(first.entries[0].parts.length, 2);
  assert.equal(first.entries[0].parts[0].state.status, 'completed');
  assert.ok(first.nextCursor);
  const second = await store.readHistory({ threadId: 'thread', limit: 1, cursor: first.nextCursor });
  assert.equal(second.entries[0].info.id, 'b');
  assert.equal(second.nextCursor, null);
});

test('rolls back malformed migration, keeps legacy settings readable, and retries after repair', async (t) => {
  const { file, open } = await fixture(t, { [historyKey]: '{bad', 'opencode.settings.theme': 'dark' });
  const store = open();
  await assert.rejects(store.prepare());
  assert.equal(await store.getItem('opencode.settings.theme'), 'dark');
  await assert.rejects(store.setItem('opencode.settings.theme', 'light'));
  await fs.writeFile(file, JSON.stringify({ [historyKey]: JSON.stringify({ version: 1, threadId: 'thread', entries: [entry('m', 'p')] }) }));
  await store.prepare();
  assert.equal((await store.readHistory({ threadId: 'thread' })).entries.length, 1);
});

test('publishes KV changes only after durable worker acknowledgement and closes pending requests', async (t) => {
  const { open } = await fixture(t);
  const store = open();
  await store.prepare();
  const write = store.setItem('opencode.drafts.composer.v1', 'saved');
  assert.deepEqual(store.drainPendingChanges(), []);
  await write;
  assert.deepEqual(store.drainPendingChanges(), [{ key: 'opencode.drafts.composer.v1', oldValue: null, newValue: 'saved' }]);
  await store.close();
  await assert.rejects(store.upsertHistory({ threadId: 'thread', entries: [] }), /closed/);
});

test('imports shards but keeps root authoritative and rolls back malformed later files', async (t) => {
  const snapshot = (entries) => JSON.stringify({ version: 1, threadId: 'thread', entries });
  const { file, directory, open } = await fixture(t, { [historyKey]: snapshot([entry('root', 'part')]) });
  await fs.mkdir(`${file}.history`);
  await fs.writeFile(`${file}.history/a.json`, JSON.stringify({ [historyKey]: snapshot([entry('shard', 'part')]) }));
  await fs.writeFile(`${file}.history/z.json`, '{broken');
  const store = open();
  await assert.rejects(store.prepare());
  const inspect = new DatabaseSync(path.join(directory, 'sessions.sqlite'));
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM meta').get().n, 0);
  inspect.close();
  await fs.rm(`${file}.history/z.json`);
  await store.prepare();
  assert.deepEqual((await store.readHistory({ threadId: 'thread' })).entries.map((item) => item.info.id), ['root']);
  assert.equal(await fs.readFile(`${file}.history/a.json`, 'utf8'), JSON.stringify({ [historyKey]: snapshot([entry('shard', 'part')]) }));
});

test('native IPC acknowledges committed KV and broadcasts only history identities', async (t) => {
  const { open } = await fixture(t);
  const store = open();
  await store.prepare();
  const handlers = new Map();
  const broadcasts = [];
  const invalidations = [];
  const ipcMain = { on: (name, handler) => handlers.set(name, handler), handle: (name, handler) => handlers.set(name, handler) };
  const trusted = (event) => { if (event.sender.id !== 7) throw new Error('untrusted'); };
  registerPersistentStorageIpc({ ipcMain, assertTrustedRenderer: trusted, getStorage: () => store,
    broadcastChange: (...args) => broadcasts.push(args), getLocalApplicationPath: () => null,
    localApplicationPathKey: 'opencode.settings.localApplicationPath.v1', rendererStoragePrefix: 'opencode.' });
  registerSessionDatabaseIpc({ ipcMain, assertTrustedRenderer: trusted, getStorage: () => store,
    broadcastHistoryChange: (...args) => invalidations.push(args) });
  const event = { sender: { id: 7 }, returnValue: undefined };
  const pending = handlers.get('persistent-storage-set')(event, { key: 'opencode.drafts.composer.v1', value: 'native' });
  assert.equal(event.returnValue, undefined);
  assert.deepEqual(broadcasts, []);
  await pending;
  assert.equal(event.returnValue, true);
  assert.equal(broadcasts[0][0].newValue, 'native');
  await handlers.get('session-database-upsertHistory')(event, { threadId: 'thread', entries: [entry('m', 'p')] });
  assert.deepEqual(invalidations, [['thread', 7]]);
  assert.equal(broadcasts.length, 1);
  await assert.rejects(handlers.get('session-database-readHistory')({ sender: { id: 8 } }, { threadId: 'thread' }), /untrusted/);
});

test('rejects pending operations when the real worker is terminated', async (t) => {
  const { file } = await fixture(t);
  let worker;
  const store = createSessionStorage(file, (filename, options) => { worker = new Worker(filename, options); return worker; });
  const pending = store.prepare();
  const observed = assert.rejects(pending, /worker exited/);
  await worker.terminate();
  await observed;
  await assert.rejects(store.flush(), /worker exited/);
  await assert.rejects(store.close(), /worker exited/);
});

test('upsert validation rolls back all entries rather than publishing a partial update', async (t) => {
  const { open } = await fixture(t);
  const store = open();
  await store.prepare();
  await assert.rejects(store.upsertHistory({ threadId: 'thread', entries: [entry('good', 'p'), { info: { id: 'wrong', sessionID: 'other' }, parts: [] }] }));
  assert.deepEqual((await store.readHistory({ threadId: 'thread' })).entries, []);
});

test('stores growing KV in SQLite and small settings separately without rewriting originals', async (t) => {
  const { file, directory, open } = await fixture(t, { 'opencode.settings.theme': 'dark' });
  const before = await fs.readFile(file, 'utf8');
  const store = open();
  await store.prepare();
  await store.setItem('opencode.drafts.composer.v1', 'draft');
  await store.setItem('opencode.settings.theme', 'light');
  const db = new DatabaseSync(path.join(directory, 'sessions.sqlite'));
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(db.prepare('SELECT value FROM kv WHERE key=?').get('opencode.drafts.composer.v1').value, 'draft');
  assert.equal(db.prepare('SELECT value FROM kv WHERE key=?').get('opencode.settings.theme'), undefined);
  db.close();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'renderer-settings.json'), 'utf8')), { 'opencode.settings.theme': 'light' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await assert.rejects(store.migrate({ 'opencode.drafts.question.v1': 'partial', [historyKey]: '{malformed' }));
  await store.prepare();
  assert.equal(store.getItem('opencode.drafts.question.v1'), null);
});
