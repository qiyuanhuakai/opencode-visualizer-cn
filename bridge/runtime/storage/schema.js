import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import { COLLECTIONS, StoreError } from './storeProtocol.js';
export const SCHEMA_VERSION = 1;
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
export function prepareSchema(db, file) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new StoreError('version_mismatch', 'schema_version');
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new StoreError('source_unavailable', 'database_corrupt');
  let backupPath = null;
  if (version < SCHEMA_VERSION && db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get().count > 0) {
    backupPath = `${file}.v${version}.backup`;
    if (existsSync(backupPath)) throw new StoreError('conflict', 'backup_exists');
    db.prepare('VACUUM INTO ?').run(backupPath);
    chmodSync(backupPath, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new StoreError('source_unavailable', 'backup_corrupt'); }
    finally { backup.close(); }
  }
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_meta(environment TEXT PRIMARY KEY, owner TEXT, epoch TEXT NOT NULL, fence INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runtime_intents(environment TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(environment,id));
      CREATE TABLE IF NOT EXISTS runtime_events(environment TEXT NOT NULL, seq INTEGER NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(environment,seq));
      CREATE TABLE IF NOT EXISTS runtime_snapshots(token TEXT PRIMARY KEY, environment TEXT NOT NULL, collection TEXT NOT NULL, epoch TEXT NOT NULL, revision INTEGER NOT NULL, watermark INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_snapshot_rows(token TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT, PRIMARY KEY(token,key), FOREIGN KEY(token) REFERENCES runtime_snapshots(token) ON DELETE CASCADE);`);
    for (const name of COLLECTIONS) db.exec(`CREATE TABLE IF NOT EXISTS ${name}(environment TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT, PRIMARY KEY(environment,key));`);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  });
  return backupPath;
}
