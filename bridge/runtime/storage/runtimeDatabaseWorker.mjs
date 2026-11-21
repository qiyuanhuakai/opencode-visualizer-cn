import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { parseOptions, parseRequest, StoreError, storageError } from './storeProtocol.js';
import { prepareSchema, transaction } from './schema.js';
import { probeLocalFilesystem } from './localFilesystem.js';
import { createQueries } from './storeQueries.js';
let db; let options; let queries; let fence; let lease; let backupPath; let locality;
const send = (value) => {
  if (!process.connected) return;
  process.send(value, error => { if (error) shutdownWorker(); });
};
function assertOwner() {
  const current = queries.meta();
  if (current.owner !== lease || current.fence !== fence || current.epoch !== options.epoch) throw new StoreError('conflict', 'stale_owner');
}
function localProcessScope() {
  if (process.platform !== 'linux') return null;
  try {
    return {
      boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      namespace: readlinkSync('/proc/self/ns/pid'),
    };
  } catch { return null; }
}
function canRecoverDeadOwner(current, scope) {
  if (!options.recoverDeadOwner || !scope || !current?.owner) return false;
  const processOwner = db.prepare('SELECT * FROM runtime_owner_processes WHERE environment=? AND owner=?')
    .get(options.environmentId, current.owner);
  if (!processOwner || !Number.isSafeInteger(processOwner.pid) || processOwner.pid <= 0) return false;
  if (processOwner.boot !== scope.boot) return locality.local === true;
  if (processOwner.namespace !== scope.namespace) return false;
  try { process.kill(processOwner.pid, 0); }
  catch (error) { return error?.code === 'ESRCH'; }
  return false;
}
function initialize(input) {
  options = parseOptions(input);
  const directory = path.resolve(options.stateDirectory, 'runtime');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  locality = probeLocalFilesystem(directory);
  const file = path.join(directory, 'runtime.db');
  closeSync(openSync(file, 'a', 0o600)); chmodSync(file, 0o600);
  db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  backupPath = prepareSchema(db, file);
  db.exec('PRAGMA journal_mode=DELETE');
  if (options.storageBudgetBytes) db.exec(`PRAGMA max_page_count=${Math.floor(options.storageBudgetBytes / db.prepare('PRAGMA page_size').get().page_size)}`);
  queries = createQueries(db, { ...options, assertOwner }); lease = randomUUID();
  const scope = localProcessScope();
  transaction(db, () => {
    const current = queries.meta();
    if (current?.owner && options.takeover?.expectedFence !== current.fence && !canRecoverDeadOwner(current, scope)) throw new StoreError('conflict', 'owner_conflict');
    if (options.takeover && options.takeover.expectedFence !== current?.fence) throw new StoreError('conflict', 'stale_takeover');
    fence = (current?.fence ?? 0) + 1;
    db.prepare('INSERT INTO runtime_meta(environment,owner,epoch,fence) VALUES(?,?,?,?) ON CONFLICT(environment) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,fence=excluded.fence').run(options.environmentId, lease, options.epoch, fence);
    db.prepare('DELETE FROM runtime_owner_processes WHERE environment=?').run(options.environmentId);
    if (scope) db.prepare('INSERT INTO runtime_owner_processes(environment,owner,pid,boot,namespace) VALUES(?,?,?,?,?)')
      .run(options.environmentId, lease, process.pid, scope.boot, scope.namespace);
    queries.claimPriorStorage(current?.fence, fence);
    if (current && current.epoch !== options.epoch) {
      db.prepare('DELETE FROM runtime_events WHERE environment=?').run(options.environmentId);
      db.prepare('DELETE FROM runtime_snapshots WHERE environment=?').run(options.environmentId);
      db.prepare('UPDATE runtime_meta SET seq=0,floor=0 WHERE environment=?').run(options.environmentId);
    }
  });
  return { ...queries.meta(), owner: undefined, fence, epoch: options.epoch, locality, backupPath, pid: process.pid };
}
function mutate(params) {
  for (;;) {
    const retainedTokens = new Set();
    try {
      return writeMutation(params, retainedTokens);
    } catch (error) {
      if (retainedTokens.size === 0 || storageError(error).reason !== 'disk_full') throw error;
      // SQLite may fill before we reach the next view. Each retry drops at least
      // one attempted view, and this synchronous request cannot admit new views.
      transaction(db, () => {
        assertOwner();
        queries.discardPriorSnapshots(retainedTokens);
      });
    }
  }
}
function writeMutation(params, retainedTokens) {
  return transaction(db, () => {
    assertOwner();
    const environment = options.environmentId;
    const digest = createHash('sha256').update(JSON.stringify(params.changes)).digest('hex');
    const previous = db.prepare('SELECT digest,result FROM runtime_intents WHERE environment=? AND id=?').get(environment, params.intentId);
    if (previous) { if (previous.digest !== digest) throw new StoreError('conflict', 'intent_mismatch'); return JSON.parse(previous.result); }
    let { revision, seq } = queries.meta();
    const priorSnapshots = queries.activePriorSnapshots();
    for (const change of params.changes) {
      const current = db.prepare(`SELECT revision FROM ${change.collection} WHERE environment=? AND key=?`).get(environment, change.key);
      if (change.expectedRevision !== undefined && change.expectedRevision !== (current?.revision ?? 0)) throw new StoreError('conflict', change.checkOnly === true ? 'entity_precondition' : 'entity_revision');
      if (change.checkOnly === true) continue;
      if (current) queries.preservePrior(priorSnapshots, change.collection, change.key, current.revision, retainedTokens);
      revision++; seq++;
      db.prepare(`INSERT INTO ${change.collection} VALUES(?,?,?,?) ON CONFLICT(environment,key) DO UPDATE SET revision=excluded.revision,value=excluded.value`).run(environment, change.key, revision, change.value === null ? null : JSON.stringify(change.value));
      if (change.value === null) {
        const key = JSON.stringify([change.collection, change.key]);
        if (priorSnapshots.some(snapshot => snapshot.collections.has('tombstones'))) {
          const prior = db.prepare('SELECT revision FROM tombstones WHERE environment=? AND key=?').get(environment, key);
          if (prior) queries.preservePrior(priorSnapshots, 'tombstones', key, prior.revision, retainedTokens);
        }
        db.prepare('INSERT INTO tombstones VALUES(?,?,?,?) ON CONFLICT(environment,key) DO UPDATE SET revision=excluded.revision,value=excluded.value')
          .run(environment, key, revision, JSON.stringify({ collection: change.collection, key: change.key }));
      }
      // Replay stores identity/revision patches; native transcript remains in its authority.
      const event = JSON.stringify({ seq, entityRevision: revision, epoch: options.epoch, collection: change.collection, key: change.key, deleted: change.value === null });
      db.prepare('INSERT INTO runtime_events VALUES(?,?,?,?,?,?)').run(environment, seq, revision, Date.now(), Buffer.byteLength(event), event);
    }
    db.prepare('UPDATE runtime_meta SET revision=?,seq=? WHERE environment=?').run(revision, seq, environment);
    queries.trim();
    const result = { phase: 'durable-accepted', intentId: params.intentId, revision, watermark: seq };
    db.prepare('INSERT INTO runtime_intents VALUES(?,?,?,?)').run(environment, params.intentId, digest, JSON.stringify(result));
    return result;
  });
}
process.on('message', (message) => {
  try {
    if (message.method === 'initialize') { send({ id: message.id, ok: true, result: initialize(message.params) }); return; }
    if (!queries) throw new StoreError('source_unavailable', 'worker_uninitialized');
    const params = parseRequest(message.method, message.params);
    let result;
    switch (message.method) {
      case 'mutate': case 'mutateControl': result = mutate(params); break;
      case 'readIntent': {
        const row = db.prepare('SELECT result FROM runtime_intents WHERE environment=? AND id=?').get(options.environmentId, params.intentId);
        result = row ? JSON.parse(row.result) : null; break;
      }
      case 'get': result = queries.get(params); break;
      case 'getMany': result = queries.getMany(params); break;
      case 'getControl': assertOwner(); result = queries.get(params); break;
      case 'page': result = queries.page(params); break;
      case 'readChunk': result = queries.readChunk(params); break;
      case 'snapshot': result = queries.snapshot(params); break;
      case 'searchSessions': result = queries.searchSessions(params); break;
      case 'releaseSnapshot': result = queries.releaseSnapshot(params); break;
      case 'replay': result = queries.replay(params); break;
      case 'inspect': result = { ...queries.meta(), owner: undefined, fence, locality, backupPath, pid: process.pid }; break;
      case 'close':
        transaction(db, () => { assertOwner(); db.prepare('UPDATE runtime_meta SET owner=NULL WHERE environment=?').run(options.environmentId); });
        db.close(); result = null; break;
      default: throw new StoreError('unsupported', 'method');
    }
    send({ id: message.id, ok: true, result });
    if (message.method === 'close') process.disconnect();
  } catch (error) {
    const failure = storageError(error);
    send({ id: message.id, ok: false, error: { code: failure.code, reason: failure.reason } });
    if (message.method === 'initialize') { if (db) db.close(); process.disconnect(); }
  }
});
function releaseLease() {
  if (!db?.isOpen) return;
  try {
    if (lease && fence) {
      transaction(db, () => {
        db.prepare('UPDATE runtime_meta SET owner=NULL WHERE environment=? AND owner=? AND epoch=? AND fence=?')
          .run(options.environmentId, lease, options.epoch, fence);
      });
    }
  } finally {
    db.close();
  }
}
function shutdownWorker() {
  try {
    releaseLease();
  } catch (error) {
    const failure = storageError(error);
    console.error(`vis_bridge runtime store cleanup failed: ${failure.code}/${failure.reason}`);
    process.exitCode = 1;
  }
  if (process.connected) process.disconnect();
}
process.on('disconnect', shutdownWorker);
process.once('SIGTERM', shutdownWorker);
