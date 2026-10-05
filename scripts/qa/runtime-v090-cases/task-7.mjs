import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRuntimeStore, resolveStoreWorker } from '../../../bridge/runtime/storage/runtimeStore.js';
import { classifyFilesystem } from '../../../bridge/runtime/storage/localFilesystem.js';
import { artifact, digest, writeJson } from '../runtime-v090-evidence.mjs';
export const sourceFiles = ['runtimeDatabaseWorker.mjs', 'runtimeStore.js', 'runtimeStore.d.ts', 'schema.js', 'storeProtocol.js', 'storeQueries.js', 'localFilesystem.js'].map((name) => `bridge/runtime/storage/${name}`);
const environmentId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const epoch = '33333333-3333-4333-8333-333333333333';
export async function run(context) {
  const temporary = await mkdtemp(path.join(context.temporaryRoot, 'store-'));
  const scenarios = []; const stores = []; const exits = []; const artifacts = [];
  const check = (name, observed, expected) => { assert.deepEqual(observed, expected, name); scenarios.push({ name, assertions: [{ name, observed, expected, passed: true }] }); };
  const open = (directory, extra = {}) => { const store = createRuntimeStore({ stateDirectory: path.join(temporary, directory), environmentId, ownerId, epoch, ...extra }); stores.push(store); return store; };
  const failure = async (name, action, code, reason) => {
    let observed;
    try { await action(); } catch (error) { observed = { code: error.code, reason: error.reason }; }
    check(name, observed, { code, reason });
  };
  try {
    if (context.case === 'happy') {
      const store = open('main'); const ready = await store.ready;
      check('positive local filesystem probe', ready.locality.local, true);
      check('local worker is a separate Node process', store.pid !== process.pid, true);
      const changes = [
        { collection: 'threads', key: 'thread-1', value: { title: 'durable', participants: ['session-1'] } },
        { collection: 'session_summaries', key: 'session-1', value: { nativeSessionId: 'native-1', environmentId } },
        { collection: 'interactions', key: 'interaction-1', value: { status: 'pending', request: 'approval' } },
      ];
      const ack = await store.mutate({ intentId: 'durable-1', changes });
      check('ack only after transaction commit', ack.phase, 'durable-accepted');
      const before = await Promise.all(changes.map(({ collection, key }) => store.get({ collection, key })));
      exits.push(await store.terminate());
      const restarted = open('main', { takeover: { expectedFence: ready.fence } }); await restarted.ready;
      const after = await Promise.all(changes.map(({ collection, key }) => restarted.get({ collection, key })));
      check('full Thread Session interaction hash survives SIGKILL restart', digest(JSON.stringify(after)), digest(JSON.stringify(before)));
      check('durable intent reconciliation reads acknowledged record', await restarted.readIntent({ intentId: 'durable-1' }), ack);
      check('durable retry retains original acknowledgement', await restarted.mutate({ intentId: 'durable-1', changes }), ack);
      for (let start = 0; start < 401; start += 100) await restarted.mutate({ intentId: `page-${start}`, changes: Array.from({ length: Math.min(100, 401 - start) }, (_, offset) => ({ collection: 'tasks', key: `task-${String(start + offset).padStart(4, '0')}`, value: { body: 'x'.repeat(8000) } })) });
      const snapshot = await restarted.snapshot({ collection: 'tasks' });
      await restarted.mutate({ intentId: 'delete', changes: [{ collection: 'tasks', key: 'task-0000', value: null }] });
      let page = snapshot; const keys = []; let maxPageBytes = 0;
      while (page !== null) { keys.push(...page.items.map((item) => item.key)); maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page.items))); page = page.cursor ? await restarted.snapshot({ collection: 'tasks', token: snapshot.token, cursor: page.cursor }) : null; }
      check('materialized snapshot streams 401 unique keyset rows across concurrent deletion', [keys.length, new Set(keys).size, snapshot.items[0].value.body.length], [401, 401, 8000]);
      check('page serialized bytes bounded', maxPageBytes <= 512 * 1024, true);
      check('delete leaves a revisioned tombstone', (await restarted.get({ collection: 'tasks', key: 'task-0000' })).value, null);
      const big = { content: '汉'.repeat(80000) };
      const bigAck = await restarted.mutate({ intentId: 'chunk', changes: [{ collection: 'artifacts', key: 'large', value: big }] });
      check('large row descriptor avoids eager JSON body', (await restarted.get({ collection: 'artifacts', key: 'large' })).chunked, true);
      const chunks = []; let offset = 0;
      do { const chunk = await restarted.readChunk({ collection: 'artifacts', key: 'large', revision: bigAck.revision, offset }); chunks.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset; } while (offset !== null);
      check('64KiB chunk readback full UTF8 hash', digest(Buffer.concat(chunks)), digest(JSON.stringify(big)));
      const replay = await restarted.replay({ epoch, after: snapshot.watermark });
      check('snapshot watermark joins later revision events', replay.events.map((event) => event.collection), ['tasks', 'artifacts']);
      exits.push(await restarted.close());
      const database = new DatabaseSync(path.join(temporary, 'main/runtime/runtime.db'), { readOnly: true });
      check('SQLite integrity after killed worker and restart', database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      check('schema version', database.prepare('PRAGMA user_version').get().user_version, 1); database.close();
      check('database permissions', (await stat(path.join(temporary, 'main/runtime/runtime.db'))).mode & 0o777, 0o600);
      check('installed paths independent of cwd', resolveStoreWorker('/opt/vis').workerPath, '/opt/vis/runtime/runtimeDatabaseWorker.mjs');
      const oldPath = path.join(temporary, 'upgrade/runtime'); await mkdir(oldPath, { recursive: true });
      const old = new DatabaseSync(path.join(oldPath, 'runtime.db')); old.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('preserved');"); old.close();
      const upgraded = open('upgrade'); const upgrade = await upgraded.ready;
      const backup = new DatabaseSync(upgrade.backupPath, { readOnly: true });
      check('preupgrade backup preserves original rows', backup.prepare('SELECT value FROM legacy').get().value, 'preserved');
      check('backup integrity verified', backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); backup.close();
      check('upgraded backup permission', (await stat(upgrade.backupPath)).mode & 0o777, 0o600);
    } else {
      for (const type of ['6969', 'bd00bd0', '794c7630', 'unknown']) await failure(`reject shared or unknown Linux filesystem ${type}`, () => classifyFilesystem('linux', type), 'unsupported', 'unverified_local_filesystem');
      const store = open('failure'); const initial = await store.ready;
      const rival = open('failure'); await failure('reject simultaneous owner', () => rival.ready, 'conflict', 'owner_conflict');
      const successor = open('failure', { takeover: { expectedFence: initial.fence } }); await successor.ready;
      await failure('stale owner write fenced in transaction', () => store.mutate({ intentId: 'stale', changes: [{ collection: 'threads', key: 'bad', value: {} }] }), 'conflict', 'stale_owner');
      const mutation = { intentId: 'retained', changes: [{ collection: 'threads', key: 'one', value: { approved: false } }] };
      await successor.mutate(mutation);
      await failure('dirty intent cannot overwrite accepted content', () => successor.mutate({ ...mutation, changes: [{ collection: 'threads', key: 'one', value: { approved: true } }] }), 'conflict', 'intent_mismatch');
      await failure('invalid collection is not SQL', () => successor.page({ collection: 'threads;DROP TABLE threads' }), 'invalid_request', 'collection');
      await failure('normal entity cannot take control slot', () => successor.mutateControl(mutation), 'invalid_request', 'control_collection');
      await failure('malformed change rejects typed', () => successor.mutate({ intentId: 'bad', changes: [null] }), 'invalid_request', 'change');
      await failure('oversized ingress rejected before admission', () => successor.mutate({ intentId: 'large', changes: [{ collection: 'threads', key: 'too-large', value: 'x'.repeat(1024 * 1024) }] }), 'invalid_request', 'request_size');
      await failure('stale entity revision rejected', () => successor.mutate({ intentId: 'revision', changes: [{ collection: 'threads', key: 'one', expectedRevision: 0, value: {} }] }), 'conflict', 'entity_revision');
      const lock = new DatabaseSync(path.join(temporary, 'failure/runtime/runtime.db')); lock.exec('BEGIN IMMEDIATE');
      await failure('actual SQLITE_BUSY rejects unacknowledged intent', () => successor.mutate({ intentId: 'busy', changes: [{ collection: 'threads', key: 'busy', value: {} }] }), 'source_unavailable', 'database_busy');
      lock.exec('ROLLBACK'); lock.close();
      check('busy intent can retry unchanged', (await successor.mutate({ intentId: 'busy', changes: [{ collection: 'threads', key: 'busy', value: {} }] })).phase, 'durable-accepted');
      const fullDirectory = path.join(temporary, 'full/runtime'); await mkdir(fullDirectory, { recursive: true });
      const oldFull = new DatabaseSync(path.join(fullDirectory, 'runtime.db')); oldFull.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('backup-survives-full');"); oldFull.close();
      const full = open('full', { storageBudgetBytes: 262144 }); const fullReady = await full.ready;
      const fullBackupHash = digest(await readFile(fullReady.backupPath));
      await full.mutate({ intentId: 'before-full', changes: [{ collection: 'interactions', key: 'approval', value: { pending: true } }] });
      const prior = await full.get({ collection: 'interactions', key: 'approval' });
      const fullMutation = { intentId: 'full', changes: [{ collection: 'threads', key: 'huge', value: 'x'.repeat(600000) }] };
      await failure('actual SQLITE_FULL rejects without misleading durable ack', () => full.mutate(fullMutation), 'source_unavailable', 'disk_full');
      check('SQLITE_FULL preserves preupgrade backup bytes', digest(await readFile(fullReady.backupPath)), fullBackupHash);
      const fullFence = (await full.inspect()).fence; exits.push(await full.terminate());
      const expanded = open('full', { takeover: { expectedFence: fullFence } }); await expanded.ready;
      check('acknowledged interaction preserved through SQLITE_FULL', await expanded.get({ collection: 'interactions', key: 'approval' }), prior);
      check('full rejected intent retries intact after restart', (await expanded.mutate(fullMutation)).phase, 'durable-accepted');
      const corruptDirectory = path.join(temporary, 'corrupt/runtime'); await mkdir(corruptDirectory, { recursive: true });
      const corruptFile = path.join(corruptDirectory, 'runtime.db'); await writeFile(corruptFile, 'corrupt original bytes');
      const corrupt = open('corrupt'); await failure('corrupt database explicit source failure', () => corrupt.ready, 'source_unavailable', 'database_corrupt');
      check('corrupt source remains recoverable unchanged', await readFile(corruptFile, 'utf8'), 'corrupt original bytes');
      const queued = open('queued', { requestTimeoutMs: 1500 }); await queued.ready; process.kill(queued.pid, 'SIGSTOP');
      const requests = Array.from({ length: 256 }, () => queued.page({ collection: 'threads' }).catch((error) => error.reason));
      check('normal queue at finite cap', queued.queue.normal, 256);
      await failure('257th normal request rejected', () => queued.page({ collection: 'threads' }), 'source_unavailable', 'queue_full');
      const control = queued.mutateControl({ intentId: 'cancel', changes: [{ collection: 'operations', key: 'cancel', value: { status: 'cancelled' } }] }).catch((error) => error.reason); check('reserved control admitted with full normal queue', queued.queue.control, 1);
      const controls = Array.from({ length: 15 }, () => queued.inspect().catch((error) => error.reason));
      await failure('17th reserved request rejected', () => queued.inspect(), 'source_unavailable', 'queue_full');
      await Promise.all(controls);
      check('hung worker timeout reconciles all requests', [...new Set(await Promise.all(requests))], ['worker_timeout']);
      check('control timeout explicit', await control, 'worker_timeout');
      const byteBound = open('bytes'); await byteBound.ready; process.kill(byteBound.pid, 'SIGSTOP');
      const byteRequests = Array.from({ length: 20 }, (_, index) => byteBound.mutate({ intentId: `bytes-${index}`, changes: [{ collection: 'threads', key: String(index), value: 'x'.repeat(900000) }] }).catch((error) => error.reason));
      check('queued payload never exceeds total16MiB including reserve', byteBound.queue.bytes <= 16 * 1024 * 1024 && byteBound.queue.normal < 20, true);
      exits.push(await byteBound.terminate());
      check('byte limit rejects unaccepted payloads explicitly', (await Promise.all(byteRequests)).includes('queue_full'), true);
      const dying = open('dying'); await dying.ready; process.kill(dying.pid, 'SIGSTOP');
      const interrupted = dying.mutate({ intentId: 'interrupted', changes: [{ collection: 'threads', key: 'pending', value: { payload: 'preserve' } }] });
      const expected = failure('worker exit rejects pending mutation for reconciliation', () => interrupted, 'reconcile_required', 'worker_exit');
      exits.push(await dying.terminate()); await expected;
      const aged = new DatabaseSync(path.join(temporary, 'failure/runtime/runtime.db'));
      aged.prepare('UPDATE runtime_events SET created=0').run(); aged.close();
      await failure('trimmed by age cursor explicitly requires replay', () => successor.replay({ epoch, after: 0 }), 'replay_required', 'event_cursor');
      await failure('wrong epoch cannot replay another event generation', () => successor.replay({ epoch: 'old', after: 2 }), 'replay_required', 'event_cursor');
      const expiredSnapshot = await successor.snapshot({ collection: 'threads' });
      const expireDb = new DatabaseSync(path.join(temporary, 'failure/runtime/runtime.db')); expireDb.prepare('UPDATE runtime_snapshots SET expires=0 WHERE token=?').run(expiredSnapshot.token); expireDb.close();
      await failure('expired snapshot token requires new snapshot', () => successor.snapshot({ collection: 'threads', token: expiredSnapshot.token }), 'replay_required', 'snapshot_expired');
      for (let i = 0; i < 3; i++) await successor.snapshot({ collection: 'threads' });
      await failure('fourth snapshot rejected at fixed token budget', () => successor.snapshot({ collection: 'threads' }), 'conflict', 'snapshot_limit');
    }
  } finally {
    for (const store of stores) exits.push(await store.terminate());
    await rm(temporary, { recursive: true, force: true });
    const cleanup = path.join(context.outDir, `${context.case}-resources.json`);
    writeJson(cleanup, { temporary, removed: true, exits, workerPids: [...new Set(stores.map((store) => store.pid))], liveWorkers: stores.filter((store) => { try { process.kill(store.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }).map((store) => store.pid) });
    artifacts.push(artifact(cleanup, 'resource-cleanup'));
  }
  return { scenarios, artifacts };
}
