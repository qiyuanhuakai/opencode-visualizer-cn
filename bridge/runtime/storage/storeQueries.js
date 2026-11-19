import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../../shared/runtime/protocol.js';
import { StoreError, STORE_LIMITS } from './storeProtocol.js';
import { transaction } from './schema.js';
function item(row) {
  const bytes = row.bytes;
  return bytes > STORE_LIMITS.chunkBytes ? { key: row.key, revision: row.revision, chunked: true, bytes } : { key: row.key, revision: row.revision, value: row.value === null ? null : JSON.parse(row.value) };
}
export function createQueries(db, binding) {
  const environment = binding.environmentId;
  const meta = () => db.prepare('SELECT * FROM runtime_meta WHERE environment=?').get(environment);
  function page(params) {
    const limit = params.limit ?? STORE_LIMITS.page;
    const rows = db.prepare(`SELECT key,revision,length(CAST(value AS BLOB)) AS bytes,CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE NULL END AS value FROM ${params.collection} WHERE environment=? AND key>? ORDER BY key LIMIT ?`).all(environment, params.cursor ?? '', limit + 1);
    return bounded(rows, limit);
  }
  function bounded(rows, limit) {
    const items = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const entry = item(row); const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > STORE_LIMITS.pageBytes) break;
      items.push(entry); bytes += size;
    }
    return { items, cursor: rows.length > items.length ? items.at(-1).key : null };
  }
  function snapshot(params) {
    return transaction(db, () => {
      binding.assertOwner();
      const now = Date.now();
      db.prepare('DELETE FROM runtime_snapshots WHERE expires<=?').run(now);
      let token = params.token;
      if (!token) {
        if (params.cursor != null) throw new StoreError('replay_required', 'snapshot_cursor');
        if (db.prepare('SELECT count(*) AS count FROM runtime_snapshots WHERE environment=?').get(environment).count >= LIMITS.snapshotTokens) throw new StoreError('conflict', 'snapshot_limit');
        token = randomUUID(); const state = meta();
        db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?,?,?,?,?)').run(token, environment, params.collections ? JSON.stringify(params.collections) : params.collection, state.epoch, state.revision, state.seq, now + LIMITS.snapshotTtlMs);
        if (params.collections) {
          for (const name of params.collections) db.prepare(`INSERT INTO runtime_snapshot_rows SELECT ?,json_array(?,key),revision,value FROM ${name} WHERE environment=?`).run(token, name, environment);
        } else db.prepare(`INSERT INTO runtime_snapshot_rows SELECT ?,key,revision,value FROM ${params.collection} WHERE environment=?`).run(token, environment);
      }
      const header = snapshotHeader({ ...params, token });
      const multiple = header.collection.startsWith('[');
      if (params.collections && header.collection !== JSON.stringify(params.collections)) throw new StoreError('replay_required', 'snapshot_collections');
      let cursor = params.cursor ?? '';
      if (multiple && cursor) {
        let decoded;
        try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); }
        catch { throw new StoreError('replay_required', 'snapshot_cursor'); }
        if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== token || decoded[1] !== params.collection || typeof decoded[2] !== 'string' || Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor) throw new StoreError('replay_required', 'snapshot_cursor');
        cursor = decoded[2];
      }
      const limit = params.limit ?? STORE_LIMITS.page;
      const valueColumns = 'revision,length(CAST(value AS BLOB)) AS bytes,CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE NULL END AS value';
      const prefix = `${JSON.stringify([params.collection]).slice(0, -1)},`;
      const rows = multiple
        ? db.prepare(`SELECT key,${valueColumns} FROM runtime_snapshot_rows WHERE token=? AND key>? AND key<? ORDER BY key LIMIT ?`).all(token, cursor ? JSON.stringify([params.collection, cursor]) : prefix, `${prefix}\uffff`, limit + 1).map((row) => ({ ...row, key: JSON.parse(row.key)[1] }))
        : db.prepare(`SELECT key,${valueColumns} FROM runtime_snapshot_rows WHERE token=? AND key>? ORDER BY key LIMIT ?`).all(token, cursor, limit + 1);
      const result = bounded(rows, limit);
      if (multiple && result.cursor !== null) result.cursor = Buffer.from(JSON.stringify([token, params.collection, result.cursor])).toString('base64url');
      return { ...result, token, epoch: header.epoch, revision: header.revision, watermark: header.watermark, expiresAt: header.expires };
    });
  }
  function snapshotHeader(params) {
    const header = db.prepare('SELECT * FROM runtime_snapshots WHERE token=? AND environment=?').get(params.token, environment);
    if (!header || header.expires <= Date.now() || header.epoch !== meta().epoch) throw new StoreError('replay_required', 'snapshot_expired');
    const collections = header.collection.startsWith('[') ? JSON.parse(header.collection) : [header.collection];
    if (!collections.includes(params.collection)) throw new StoreError('replay_required', 'snapshot_collection');
    return header;
  }
  function replay(params) {
    const state = meta();
    const expired = db.prepare('SELECT max(seq) AS seq FROM runtime_events WHERE environment=? AND created<=?').get(environment, Date.now() - LIMITS.replayAgeMs).seq ?? 0;
    if (params.epoch !== state.epoch || params.after < Math.max(state.floor, expired) || params.after > state.seq) throw new StoreError('replay_required', 'event_cursor');
    const rows = db.prepare('SELECT seq,payload FROM runtime_events WHERE environment=? AND seq>? ORDER BY seq LIMIT ?').all(environment, params.after, params.limit ?? STORE_LIMITS.page);
    const events = []; let bytes = 0;
    for (const row of rows) { bytes += Buffer.byteLength(row.payload); if (bytes > STORE_LIMITS.pageBytes) break; events.push(JSON.parse(row.payload)); }
    return { epoch: state.epoch, events, through: events.at(-1)?.seq ?? params.after, watermark: state.seq };
  }
  function trim() {
    const oldest = db.prepare('SELECT max(seq) AS seq FROM runtime_events WHERE environment=? AND created<=?').get(environment, Date.now() - LIMITS.replayAgeMs).seq;
    let floor = oldest ?? meta().floor;
    const bytes = db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM runtime_events WHERE environment=? AND seq>?').get(environment, floor).bytes;
    if (bytes > LIMITS.replayBytes) {
      const cutoff = db.prepare('SELECT seq FROM (SELECT seq,sum(bytes) OVER (ORDER BY seq DESC) AS total FROM runtime_events WHERE environment=? AND seq>?) WHERE total>? ORDER BY seq DESC LIMIT 1').get(environment, floor, LIMITS.replayBytes);
      floor = cutoff.seq;
    }
    db.prepare('DELETE FROM runtime_events WHERE environment=? AND seq<=?').run(environment, floor);
    db.prepare('UPDATE runtime_meta SET floor=? WHERE environment=?').run(floor, environment);
  }
  return {
    meta, page, snapshot, replay, trim,
    get(params) { const row = db.prepare(`SELECT key,revision,length(CAST(value AS BLOB)) AS bytes,CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE NULL END AS value FROM ${params.collection} WHERE environment=? AND key=?`).get(environment, params.key); return row ? item(row) : null; },
    readChunk(params) {
      let key = params.key;
      if (params.token) {
        const header = snapshotHeader(params);
        if (header.collection.startsWith('[')) key = JSON.stringify([params.collection, key]);
      }
      const table = params.token ? 'runtime_snapshot_rows' : params.collection;
      const field = params.token ? 'token' : 'environment';
      const row = db.prepare(`SELECT revision,length(CAST(value AS BLOB)) AS bytes,substr(CAST(value AS BLOB),?,?) AS chunk FROM ${table} WHERE ${field}=? AND key=?`).get(params.offset + 1, STORE_LIMITS.chunkBytes, params.token ?? environment, key);
      if (!row || row.revision !== params.revision) throw new StoreError('conflict', 'chunk_revision');
      return { revision: row.revision, bytes: row.bytes, offset: params.offset, data: Buffer.from(row.chunk ?? []).toString('base64'), nextOffset: params.offset + STORE_LIMITS.chunkBytes < row.bytes ? params.offset + STORE_LIMITS.chunkBytes : null };
    },
  };
}
