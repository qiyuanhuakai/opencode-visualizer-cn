import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { statSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';
import { OPEN_CODE_VERSION, OPEN_CODE_LIMITS, summary, discoveryScope, pageLimit } from '../../../shared/runtime/native/opencode/protocol.js';

/** Only the target control plane supplies this path, obtained from that native process's `opencode db path`. */
export function createOpenCodeStoreReader({ databasePath, nativeVersion, timeoutMs = 15000 }) {
  const worker = new Worker(new URL('./openCodeStoreReader.mjs', import.meta.url), { workerData: { databasePath, nativeVersion } });
  const pending = new Map();
  let closed = false;
  let serial = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  function fail(error) {
    closed = true;
    readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  worker.on('message', (message) => {
    if (message.id === 0) {
      if (message.error) readyReject(new ProtocolError(message.error.code, message.error.field));
      else readyResolve(message.result);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new ProtocolError(message.error.code, message.error.field));
    else item.resolve(message.result);
  });
  worker.on('error', () => fail(new ProtocolError('source_unavailable', 'opencode.store_worker')));
  worker.on('exit', () => fail(new ProtocolError('source_unavailable', 'opencode.store_closed')));
  const initializationTimer = setTimeout(() => { fail(new ProtocolError('timeout', 'opencode.store_start')); void worker.terminate(); }, timeoutMs);
  ready.then(() => clearTimeout(initializationTimer), () => clearTimeout(initializationTimer));
  return {
    ready,
    async page(params = {}) {
      await ready;
      requireValue(!closed, 'opencode.store_closed', 'source_unavailable');
      requireValue(pending.size < 2, 'opencode.store_queue', 'source_unavailable');
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(new ProtocolError('timeout', 'opencode.store_page')); void worker.terminate(); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, params });
      });
    },
    async close() { clearTimeout(initializationTimer); fail(new ProtocolError('cancelled', 'opencode.store_closed')); await worker.terminate(); },
  };
}

function nativeStore({ databasePath, nativeVersion }) {
  requireValue(nativeVersion === OPEN_CODE_VERSION, 'opencode.store_version', 'unsupported');
  const canonical = realpathSync(databasePath);
  const initial = statSync(canonical);
  requireValue(initial.isFile() && (typeof process.getuid !== 'function' || initial.uid === process.getuid()), 'opencode.store_owner', 'unauthorized');
  const identity = `${initial.dev}:${initial.ino}`;
  const db = new DatabaseSync(canonical, { readOnly: true, enableForeignKeyConstraints: false });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
  const schema = db.prepare('PRAGMA table_info(session)').all();
  const columns = { id: 'TEXT', project_id: 'TEXT', parent_id: 'TEXT', directory: 'TEXT', title: 'TEXT', version: 'TEXT', time_created: 'INTEGER', time_updated: 'INTEGER', time_archived: 'INTEGER' };
  for (const [name, type] of Object.entries(columns)) requireValue(schema.some((column) => column.name === name && column.type.toUpperCase() === type && (name !== 'id' || column.pk === 1)), 'opencode.store_schema', 'unsupported');
  const schemaVersion = db.prepare('PRAGMA schema_version').get().schema_version;
  const cursors = new Map();
  const dataVersion = () => db.prepare('PRAGMA data_version').get().data_version;
  const check = (version) => {
    const current = statSync(canonical);
    requireValue(`${current.dev}:${current.ino}` === identity && realpathSync(databasePath) === canonical, 'opencode.store_replaced', 'reconcile_required');
    requireValue(db.prepare('PRAGMA schema_version').get().schema_version === schemaVersion && dataVersion() === version, 'opencode.store_changed', 'reconcile_required');
  };
  return {
    inspect: { nativeVersion, readOnly: true, schemaVersion, summaryOnly: true },
    page(params) {
      const limit = pageLimit(params.limit);
      const scope = discoveryScope(params.scope);
      for (const [key, cursor] of cursors) if (cursor.expiresAt <= Date.now()) cursors.delete(key);
      let cursor;
      if (params.cursor != null) {
        cursor = cursors.get(params.cursor);
        requireValue(cursor !== undefined && JSON.stringify(cursor.scope) === JSON.stringify(scope), 'opencode.store_cursor', 'reconcile_required');
        cursors.delete(params.cursor);
      } else {
        requireValue(cursors.size < 3, 'opencode.store_snapshots', 'reconcile_required');
        cursor = { last: '', version: dataVersion(), scope, expiresAt: Date.now() + 60000 };
      }
      check(cursor.version);
      const conditions = ['id > ?']; const values = [cursor.last];
      for (const [key, column] of [['projectID','project_id'], ['directory','directory'], ['parentID','parent_id']]) if (scope[key] !== undefined) { conditions.push(`${column} = ?`); values.push(scope[key]); }
      if (scope.roots === true) conditions.push('parent_id IS NULL');
      if (scope.archived !== undefined) conditions.push(scope.archived ? 'time_archived > 0' : '(time_archived IS NULL OR time_archived = 0)');
      // Bound every text projection before SQLite allocates it in JS; never query message/part tables.
      const rows = db.prepare(`SELECT substr(id,1,1025) id, substr(project_id,1,1025) projectID, substr(parent_id,1,1025) parentID, substr(directory,1,16385) directory, substr(title,1,8193) title, substr(version,1,1025) version, time_created, time_updated, time_archived FROM session WHERE ${conditions.join(' AND ')} ORDER BY id COLLATE BINARY LIMIT ?`).all(...values, limit + 1);
      check(cursor.version);
      const items = []; let bytes = 0;
      for (const row of rows.slice(0, limit)) {
        const item = summary({ ...row, time: { created: row.time_created, updated: row.time_updated, archived: row.time_archived } });
        const size = Buffer.byteLength(JSON.stringify(item));
        if (bytes + size > OPEN_CODE_LIMITS.pageBytes) break;
        bytes += size; items.push(item);
      }
      const complete = items.length === rows.length;
      let next = null;
      if (!complete) {
        requireValue(items.length > 0, 'opencode.store_page_size', 'unsupported');
        next = randomUUID();
        cursors.set(next, { ...cursor, last: items.at(-1).id });
      }
      return { items, cursor: next, completeness: complete ? 'complete' : 'partial', reason: complete ? 'native-store-eof' : 'more-pages', provenance: this.inspect };
    },
  };
}
if (!isMainThread) {
  let store;
  try { store = nativeStore(workerData); parentPort.postMessage({ id: 0, result: store.inspect }); }
  catch (error) { parentPort.postMessage({ id: 0, error: { code: error instanceof ProtocolError ? error.code : 'source_unavailable', field: error instanceof ProtocolError ? error.field : 'opencode.store_open' } }); }
  parentPort.on('message', ({ id, params }) => {
    try { requireValue(store !== undefined, 'opencode.store_unavailable', 'source_unavailable'); parentPort.postMessage({ id, result: store.page(params) }); }
    catch (error) { parentPort.postMessage({ id, error: { code: error instanceof ProtocolError ? error.code : 'source_unavailable', field: error instanceof ProtocolError ? error.field : 'opencode.store_read' } }); }
  });
}
