import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { LegacyExportError, streamStringMap, stringChunks } from '../shared/runtime/migration/streamingJson.js';
import { openLegacyExport, readLegacyExportPage } from '../shared/runtime/migration/legacyExport.js';

function exists(file) {
  try { if (!fs.lstatSync(file).isFile()) throw new LegacyExportError('corrupt_source'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function* readMap(file) {
  if (!exists(file)) return;
  const input = fs.createReadStream(file, { highWaterMark: 16384 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  async function* decoded() {
    try { for await (const bytes of input) yield decoder.decode(bytes, { stream: true }); yield decoder.decode(); }
    finally { input.destroy(); }
  }
  yield* streamStringMap(decoded());
}
const historyPrefix = 'opencode.state.codexAuxiliaryHistory.v1.';
function keyNamespace(key) {
  const match = /^opencode\.state\.backendHistory\.v1\.([a-f0-9]{32})\./u.exec(key);
  if (key.startsWith('opencode.state.backendHistory.v1.') && !match) throw new LegacyExportError('unknown_namespace');
  return match ? `backend-history-v1:${match[1]}` : key.startsWith(historyPrefix) ? 'legacy-thread-id' : 'unattached-legacy-local';
}
export function createElectronLegacySource(filePath) {
  const root = path.dirname(filePath);
  const scope = createHash('sha256').update(path.resolve(filePath)).digest('hex');
  return async function* () {
    let db;
    try {
      const databaseFile = path.join(root, 'sessions.sqlite');
      if (exists(databaseFile)) db = new DatabaseSync(databaseFile, { readOnly: true });
      const imported = db?.prepare("SELECT value FROM meta WHERE key='legacy-import-v1'").get()?.value === 'complete';
      if (db) for (const table of ['meta', 'kv', 'threads', 'messages', 'parts']) {
        // Each SQLite row is the smallest legacy persistence unit. Never hydrate all messages or parts.
        for (const row of db.prepare(`SELECT rowid AS _rowid,* FROM ${table} ORDER BY rowid`).iterate()) {
          const namespace = row.namespace ?? 'unattached-legacy-local';
          const key = table === 'kv' ? row.key : JSON.stringify([table, row.namespace ?? '', row.thread_id ?? '', row.message_id ?? '', row.part_id ?? '', row.key ?? '']);
          const content = table === 'kv' ? row.value : JSON.stringify(Object.fromEntries(Object.entries(row).filter(([name]) => name !== '_rowid')));
          const tombstone = table === 'threads' && !db.prepare('SELECT 1 FROM messages WHERE namespace=? AND thread_id=? LIMIT 1').get(row.namespace, row.thread_id);
          for (const chunk of stringChunks(content)) yield { ...chunk, key, namespace, source: `electron:${scope}/sqlite/${table}`, authority: tombstone ? 'clear-tombstone' : imported ? 'sqlite-imported' : 'sqlite' };
        }
      }
      const rootKeys = new Set();
      for await (const piece of readMap(filePath)) rootKeys.add(piece.key);
      const files = [{ file: path.join(root, 'renderer-settings.json'), source: 'settings', authority: 'settings' }, { file: filePath, source: 'legacy-root', authority: imported ? 'legacy-backup' : 'legacy-root' }];
      let shardNames = [];
      try {
        const directory = `${filePath}.history`;
        if (!fs.lstatSync(directory).isDirectory()) throw new LegacyExportError('corrupt_source');
        shardNames = fs.readdirSync(directory).sort();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of shardNames) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw new LegacyExportError('corrupt_source');
        files.push({ file: path.join(`${filePath}.history`, name), source: `legacy-shard:${name.slice(0, -5)}`, authority: imported ? 'legacy-backup' : 'legacy-shard' });
      }
      for (const entry of files) for await (const piece of readMap(entry.file)) {
        if (entry.source.startsWith('legacy-shard:') && !piece.key.startsWith(historyPrefix)) throw new LegacyExportError('corrupt_source');
        const authority = entry.source.startsWith('legacy-shard:') && rootKeys.has(piece.key) ? 'shadowed-by-root' : entry.authority;
        yield { ...piece, source: `electron:${scope}/${entry.source}`, namespace: keyNamespace(piece.key), authority };
      }
    } catch (error) {
      if (error instanceof LegacyExportError) throw error;
      throw new LegacyExportError('source_unavailable');
    } finally { db?.close(); }
  };
}

export function serveLegacyExportWorker(port, filePath) {
  const source = createElectronLegacySource(filePath);
  let pending = Promise.resolve();
  port.on('message', ({ id, method, payload }) => {
    pending = pending.then(async () => {
      try {
        let value;
        switch (method) {
          case 'exportOpen': value = await openLegacyExport(source); break;
          case 'exportPage': value = await readLegacyExportPage(source, payload); break;
          case 'close': port.postMessage({ id, ok: true }); port.close(); return;
          default: throw new LegacyExportError('invalid_request');
        }
        port.postMessage({ id, ok: true, value });
      } catch (error) {
        const code = error instanceof LegacyExportError ? error.code : 'source_unavailable';
        port.postMessage({ id, ok: false, error: { name: 'LegacyExportError', message: code, code } });
      }
    });
  });
}
