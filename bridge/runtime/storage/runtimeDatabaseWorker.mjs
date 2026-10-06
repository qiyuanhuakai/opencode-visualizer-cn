import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { parseOptions, parseRequest, StoreError, storageError } from './storeProtocol.js';
import { prepareSchema, transaction } from './schema.js';
import { probeLocalFilesystem } from './localFilesystem.js';
import { createQueries } from './storeQueries.js';
let db; let options; let queries; let fence; let lease; let backupPath; let locality;
const send = (value) => { if (process.connected) process.send(value); };
function assertOwner() {
  const current = queries.meta();
  if (current.owner !== lease || current.fence !== fence || current.epoch !== options.epoch) throw new StoreError('conflict', 'stale_owner');
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
  transaction(db, () => {
    const current = queries.meta();
    if (current?.owner && options.takeover?.expectedFence !== current.fence) throw new StoreError('conflict', 'owner_conflict');
    if (options.takeover && options.takeover.expectedFence !== current?.fence) throw new StoreError('conflict', 'stale_takeover');
    fence = (current?.fence ?? 0) + 1;
    db.prepare('INSERT INTO runtime_meta(environment,owner,epoch,fence) VALUES(?,?,?,?) ON CONFLICT(environment) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,fence=excluded.fence').run(options.environmentId, lease, options.epoch, fence);
    if (current && current.epoch !== options.epoch) {
      db.prepare('DELETE FROM runtime_events WHERE environment=?').run(options.environmentId);
      db.prepare('DELETE FROM runtime_snapshots WHERE environment=?').run(options.environmentId);
      db.prepare('UPDATE runtime_meta SET seq=0,floor=0 WHERE environment=?').run(options.environmentId);
    }
  });
  return { ...queries.meta(), owner: undefined, fence, epoch: options.epoch, locality, backupPath, pid: process.pid };
}
function mutate(params) {
  return transaction(db, () => {
    assertOwner();
    const environment = options.environmentId;
    const digest = createHash('sha256').update(JSON.stringify(params.changes)).digest('hex');
    const previous = db.prepare('SELECT digest,result FROM runtime_intents WHERE environment=? AND id=?').get(environment, params.intentId);
    if (previous) { if (previous.digest !== digest) throw new StoreError('conflict', 'intent_mismatch'); return JSON.parse(previous.result); }
    let { revision, seq } = queries.meta();
    for (const change of params.changes) {
      const current = db.prepare(`SELECT revision FROM ${change.collection} WHERE environment=? AND key=?`).get(environment, change.key);
      if (change.expectedRevision !== undefined && change.expectedRevision !== (current?.revision ?? 0)) throw new StoreError('conflict', 'entity_revision');
      revision++; seq++;
      db.prepare(`INSERT INTO ${change.collection} VALUES(?,?,?,?) ON CONFLICT(environment,key) DO UPDATE SET revision=excluded.revision,value=excluded.value`).run(environment, change.key, revision, change.value === null ? null : JSON.stringify(change.value));
      if (change.value === null) db.prepare('INSERT INTO tombstones VALUES(?,?,?,?) ON CONFLICT(environment,key) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(environment, JSON.stringify([change.collection, change.key]), revision, JSON.stringify({ collection: change.collection, key: change.key }));
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
      case 'getControl': assertOwner(); result = queries.get(params); break;
      case 'page': result = queries.page(params); break;
      case 'readChunk': result = queries.readChunk(params); break;
      case 'snapshot': result = queries.snapshot(params); break;
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
process.on('disconnect', () => { if (db?.isOpen) db.close(); });
