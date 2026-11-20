import { randomUUID } from 'node:crypto';
import { LIMITS } from '../../../shared/runtime/protocol.js';
import { StoreError, STORE_LIMITS } from './storeProtocol.js';
import { transaction } from './schema.js';
function item(row) {
  const bytes = row.bytes;
  return bytes > STORE_LIMITS.chunkBytes ? { key: row.key, revision: row.revision, chunked: true, bytes } : { key: row.key, revision: row.revision, value: row.value === null ? null : JSON.parse(row.value) };
}
// New tokens retain only values overwritten after their revision. Keep reads
// for materialized tokens from an older worker across same-epoch takeover.
// Older workers reject a prior-version token because its collection differs.
const PRIOR_SNAPSHOT_MARKER = '@';
const snapshotCollections = definition => definition.startsWith('[') ? JSON.parse(definition) : [definition];

export function createQueries(db, binding) {
  const environment = binding.environmentId;
  const meta = () => db.prepare('SELECT * FROM runtime_meta WHERE environment=?').get(environment);
  function page(params) {
    const limit = params.limit ?? STORE_LIMITS.page;
    const rows = db.prepare(`SELECT key,revision,length(CAST(value AS BLOB)) AS bytes,CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE NULL END AS value FROM ${params.collection} WHERE environment=? AND key>? ORDER BY key LIMIT ?`).all(environment, params.cursor ?? '', limit + 1);
    return bounded(rows, limit);
  }
  const searchLabels = new Map([['opencode', 'opencode'], ['codex', 'codex'], ['kimi-web', 'kimi web'],
    ['dsh', 'dsh'], ['acp', 'acp'], ['unknown', 'unknown']]);
  const validSearchText = (text, max) => typeof text === 'string' && text.length > 0
    && text.length <= max && !text.includes('\0');
  db.function('vis_session_matches', { deterministic: true }, (id, harnessId, title, directory, kind, needle) => {
    if (!validSearchText(id, 2048) || !validSearchText(harnessId, 64)) return 0;
    return id.toLowerCase().includes(needle)
      || (validSearchText(title, 8192) && title.toLowerCase().includes(needle))
      || (validSearchText(directory, 16384) && directory.toLowerCase().includes(needle))
      || searchLabels.get(kind).includes(needle) ? 1 : 0;
  });
  function searchSessions(params) {
    return transaction(db, () => {
      binding.assertOwner();
      const revision = meta().revision;
      if (params.revision !== undefined && params.revision !== revision) throw new StoreError('replay_required', 'search_revision');
      const needle = params.query.trim().toLowerCase();
      const scope = `FROM session_summaries s
        LEFT JOIN harnesses h ON h.environment=s.environment AND h.key=json_extract(s.value,'$.session.harnessInstanceId')
        WHERE s.environment=?`;
      const kind = `CASE WHEN json_extract(h.value,'$.kind') IN ('opencode','codex','kimi-web','dsh','acp')
        THEN json_extract(h.value,'$.kind') ELSE 'unknown' END`;
      const match = ` AND ${kind} IN (SELECT value FROM json_each(?))
        AND vis_session_matches(json_extract(s.value,'$.session.nativeSessionId'),
          json_extract(s.value,'$.session.harnessInstanceId'),json_extract(s.value,'$.title'),
          json_extract(s.value,'$.directory'),${kind},?)`;
      const filters = [environment, JSON.stringify(params.kinds), needle];
      const scanned = db.prepare('SELECT count(*) AS count FROM session_summaries WHERE environment=?').get(environment).count;
      if (!needle || params.kinds.length === 0) return { revision, scanned, totalMatched: 0, items: [], cursor: null };
      const totalMatched = db.prepare('SELECT count(*) AS count '+scope+match).get(...filters).count;
      const limit = params.limit ?? STORE_LIMITS.page;
      const rows = db.prepare(`SELECT s.key,s.revision,length(CAST(s.value AS BLOB)) AS bytes,
        CASE WHEN length(CAST(s.value AS BLOB))<=65536 THEN s.value ELSE NULL END AS value
        ${scope}${match} AND s.key>? ORDER BY s.key LIMIT ?`).all(...filters, params.cursor ?? '', limit + 1);
      return { revision, scanned, totalMatched, ...bounded(rows, limit) };
    });
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
        const definition = params.collections ? JSON.stringify(params.collections) : params.collection;
        db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?,?,?,?,?)').run(
          token, environment, PRIOR_SNAPSHOT_MARKER + definition, state.epoch, state.revision, state.seq, now + LIMITS.snapshotTtlMs,
        );
      }
      const header = snapshotHeader({ ...params, token });
      const multiple = header.definition.startsWith('[');
      if (params.collections && header.definition !== JSON.stringify(params.collections)) throw new StoreError('replay_required', 'snapshot_collections');
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
      let rows;
      if (header.priors) {
        rows = db.prepare(`
          SELECT key,${valueColumns} FROM ${params.collection} WHERE environment=? AND key>? AND revision<=?
          UNION ALL
          SELECT key,${valueColumns} FROM runtime_snapshot_priors WHERE token=? AND collection=? AND key>?
          ORDER BY key LIMIT ?
        `).all(environment, cursor, header.revision, token, params.collection, cursor, limit + 1);
      } else if (multiple) {
        const prefix = `${JSON.stringify([params.collection]).slice(0, -1)},`;
        rows = db.prepare(`SELECT key,${valueColumns} FROM runtime_snapshot_rows WHERE token=? AND key>? AND key<? ORDER BY key LIMIT ?`)
          .all(token, cursor ? JSON.stringify([params.collection, cursor]) : prefix, `${prefix}\uffff`, limit + 1)
          .map(row => ({ ...row, key: JSON.parse(row.key)[1] }));
      } else {
        rows = db.prepare(`SELECT key,${valueColumns} FROM runtime_snapshot_rows WHERE token=? AND key>? ORDER BY key LIMIT ?`).all(token, cursor, limit + 1);
      }
      const result = bounded(rows, limit);
      if (multiple && result.cursor !== null) result.cursor = Buffer.from(JSON.stringify([token, params.collection, result.cursor])).toString('base64url');
      return { ...result, token, epoch: header.epoch, revision: header.revision, watermark: header.watermark, expiresAt: header.expires };
    });
  }
  function snapshotHeader(params) {
    const header = db.prepare('SELECT * FROM runtime_snapshots WHERE token=? AND environment=?').get(params.token, environment);
    if (!header || header.expires <= Date.now() || header.epoch !== meta().epoch) throw new StoreError('replay_required', 'snapshot_expired');
    const priors = header.collection.startsWith(PRIOR_SNAPSHOT_MARKER);
    const definition = priors ? header.collection.slice(PRIOR_SNAPSHOT_MARKER.length) : header.collection;
    if (!snapshotCollections(definition).includes(params.collection)) throw new StoreError('replay_required', 'snapshot_collection');
    return { ...header, definition, priors };
  }
  function claimPriorStorage(previousFence, fence) {
    const previousWriter = db.prepare('SELECT fence FROM runtime_snapshot_writers WHERE environment=?').get(environment);
    if (previousFence !== undefined && previousWriter?.fence !== previousFence) {
      // An older worker may have written without retaining the before-images.
      db.prepare('DELETE FROM runtime_snapshots WHERE environment=? AND collection LIKE ?')
        .run(environment, PRIOR_SNAPSHOT_MARKER + '%');
    }
    db.prepare(`INSERT INTO runtime_snapshot_writers VALUES(?,?)
      ON CONFLICT(environment) DO UPDATE SET fence=excluded.fence`).run(environment, fence);
  }
  function activePriorSnapshots() {
    return db.prepare("SELECT token,revision,collection FROM runtime_snapshots WHERE environment=? AND epoch=? AND expires>? AND collection LIKE '@%'")
      .all(environment, binding.epoch, Date.now())
      .map(row => ({ ...row, collections: new Set(snapshotCollections(row.collection.slice(PRIOR_SNAPSHOT_MARKER.length))) }));
  }
  function preservePrior(snapshots, collection, key, revision, retainedTokens) {
    for (const snapshot of snapshots) {
      if (snapshot.revision < revision || !snapshot.collections.has(collection)) continue;
      retainedTokens.add(snapshot.token);
      db.prepare(`
        INSERT OR IGNORE INTO runtime_snapshot_priors
        SELECT ?,?,key,revision,value FROM ${collection} WHERE environment=? AND key=?
      `).run(snapshot.token, collection, environment, key);
    }
  }
  function discardPriorSnapshots(tokens) {
    const discard = db.prepare('DELETE FROM runtime_snapshots WHERE token=? AND environment=? AND epoch=? AND collection LIKE ?');
    for (const token of tokens) discard.run(token, environment, binding.epoch, PRIOR_SNAPSHOT_MARKER + '%');
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
    meta, page, searchSessions, snapshot, replay, trim, claimPriorStorage, activePriorSnapshots, preservePrior, discardPriorSnapshots,
    releaseSnapshot(params) {
      return transaction(db, () => {
        binding.assertOwner();
        const result = db.prepare('DELETE FROM runtime_snapshots WHERE environment=? AND epoch=? AND token=?').run(environment, params.epoch, params.token);
        return { released: result.changes === 1 };
      });
    },
    get(params) { const row = db.prepare(`SELECT key,revision,length(CAST(value AS BLOB)) AS bytes,CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE NULL END AS value FROM ${params.collection} WHERE environment=? AND key=?`).get(environment, params.key); return row ? item(row) : null; },
    getMany(params) {
      const placeholders = params.keys.map(() => '?').join(',');
      return db.prepare(`
        SELECT key,revision,length(CAST(value AS BLOB)) AS bytes,
          CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE NULL END AS value
        FROM ${params.collection} WHERE environment=? AND key IN (${placeholders})
      `).all(environment, ...params.keys).map(item);
    },
    readChunk(params) {
      const header = params.token ? snapshotHeader(params) : undefined;
      const chunkColumns = 'revision,length(CAST(value AS BLOB)) AS bytes,substr(CAST(value AS BLOB),?,?) AS chunk';
      let row;
      if (header?.priors) {
        row = db.prepare(`
          SELECT ${chunkColumns} FROM (
            SELECT revision,value FROM ${params.collection} WHERE environment=? AND key=? AND revision<=?
            UNION ALL
            SELECT revision,value FROM runtime_snapshot_priors WHERE token=? AND collection=? AND key=?
          )
        `).get(params.offset + 1, STORE_LIMITS.chunkBytes, environment, params.key, header.revision,
          params.token, params.collection, params.key);
      } else if (header) {
        const key = header.definition.startsWith('[') ? JSON.stringify([params.collection, params.key]) : params.key;
        row = db.prepare(`SELECT ${chunkColumns} FROM runtime_snapshot_rows WHERE token=? AND key=?`)
          .get(params.offset + 1, STORE_LIMITS.chunkBytes, params.token, key);
      } else {
        row = db.prepare(`SELECT ${chunkColumns} FROM ${params.collection} WHERE environment=? AND key=?`)
          .get(params.offset + 1, STORE_LIMITS.chunkBytes, environment, params.key);
      }
      if (!row || row.revision !== params.revision) throw new StoreError('conflict', 'chunk_revision');
      return { revision: row.revision, bytes: row.bytes, offset: params.offset, data: Buffer.from(row.chunk ?? []).toString('base64'), nextOffset: params.offset + STORE_LIMITS.chunkBytes < row.bytes ? params.offset + STORE_LIMITS.chunkBytes : null };
    },
  };
}
