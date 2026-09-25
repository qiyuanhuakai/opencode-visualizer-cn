import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const historyPrefix = 'opencode.state.codexAuxiliaryHistory.v1.';
const namespace = 'legacy-thread-id';
const legacyFile = workerData.filePath;
const settingsFile = path.join(path.dirname(legacyFile), 'renderer-settings.json');
fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
const databaseFile = path.join(path.dirname(legacyFile), 'sessions.sqlite');
const db = new DatabaseSync(databaseFile);
fs.chmodSync(databaseFile, 0o600);
db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS threads(namespace TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY(namespace,thread_id));
  CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL, info TEXT NOT NULL, UNIQUE(namespace,thread_id,message_id),
    FOREIGN KEY(namespace,thread_id) REFERENCES threads(namespace,thread_id));
  CREATE INDEX IF NOT EXISTS message_pages ON messages(namespace,thread_id,seq);
  CREATE TABLE IF NOT EXISTS parts(namespace TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
    part_id TEXT NOT NULL, data TEXT NOT NULL, terminal INTEGER NOT NULL,
    PRIMARY KEY(namespace,thread_id,message_id,part_id),
    FOREIGN KEY(namespace,thread_id,message_id) REFERENCES messages(namespace,thread_id,message_id) ON DELETE CASCADE);`);
let ready = false;
let settings = {};

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireId(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('Invalid history identity');
  return value;
}
function isDatabaseKey(key) {
  return /^opencode\.(drafts\.|favorites\.|state\.(codexTurnEfforts|codexMessageModels|codexThreadActivity|acpMessageAttribution|acpArchivedSessions|kimiWebTurnPermissions)(\.|$))/u.test(key);
}
function readObject(file) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const value = JSON.parse(source);
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) throw new TypeError(`Invalid legacy storage: ${file}`);
  return value;
}
function writeSettings(next) {
  const temporary = `${settingsFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    const descriptor = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, settingsFile);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(settingsFile), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
const insertThread = db.prepare('INSERT OR IGNORE INTO threads VALUES(?,?)');
const insertMessage = db.prepare(`INSERT INTO messages(namespace,thread_id,message_id,info) VALUES(?,?,?,?)
  ON CONFLICT(namespace,thread_id,message_id) DO UPDATE SET info=excluded.info WHERE info<>excluded.info`);
const insertPart = db.prepare(`INSERT INTO parts VALUES(?,?,?,?,?,?)
  ON CONFLICT(namespace,thread_id,message_id,part_id) DO UPDATE SET data=excluded.data,terminal=excluded.terminal
  WHERE NOT(parts.terminal=1 AND excluded.terminal=0) AND parts.data<>excluded.data`);
function upsert(threadId, entries) {
  requireId(threadId);
  if (!Array.isArray(entries)) throw new TypeError('History entries must be an array');
  insertThread.run(namespace, threadId);
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.info) || !Array.isArray(entry.parts) || entry.info.sessionID !== threadId) throw new TypeError('Invalid history message');
    const messageId = requireId(entry.info.id);
    insertMessage.run(namespace, threadId, messageId, JSON.stringify(entry.info));
    for (const part of entry.parts) {
      if (!isRecord(part) || part.sessionID !== threadId || part.messageID !== messageId) throw new TypeError('Invalid history part');
      const partId = requireId(part.id);
      const terminal = part.type === 'tool' && ['completed', 'error'].includes(part.state?.status) ? 1 : 0;
      insertPart.run(namespace, threadId, messageId, partId, JSON.stringify(part), terminal);
    }
  }
}
function importSnapshot(key, raw, fillMissing = false) {
  const threadId = decodeURIComponent(key.slice(historyPrefix.length));
  if (fillMissing && db.prepare('SELECT 1 FROM threads WHERE namespace=? AND thread_id=?').get(namespace, threadId)) return;
  const snapshot = JSON.parse(raw);
  if (!isRecord(snapshot) || snapshot.version !== 1 || snapshot.threadId !== threadId) throw new TypeError('Invalid legacy history snapshot');
  upsert(threadId, snapshot.entries);
}
function prepare() {
  if (ready) return cacheEntries();
  if (!db.prepare("SELECT 1 FROM meta WHERE key='legacy-import-v1'").get()) {
    const root = readObject(legacyFile);
    let shardNames;
    try { shardNames = fs.readdirSync(`${legacyFile}.history`).filter((name) => name.endsWith('.json')).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; shardNames = []; }
    transaction(() => {
      for (const name of shardNames) {
        for (const [key, value] of Object.entries(readObject(path.join(`${legacyFile}.history`, name)))) {
          if (!key.startsWith(historyPrefix)) throw new TypeError('Invalid legacy history shard');
          if (!Object.hasOwn(root, key)) importSnapshot(key, value);
        }
      }
      let initialSettings = readObject(settingsFile);
      for (const [key, value] of Object.entries(root)) {
        if (key.startsWith(historyPrefix)) importSnapshot(key, value);
        else if (isDatabaseKey(key)) db.prepare('INSERT OR IGNORE INTO kv VALUES(?,?)').run(key, value);
        else if (!Object.hasOwn(initialSettings, key)) initialSettings = { ...initialSettings, [key]: value };
      }
      writeSettings(initialSettings);
      db.prepare('INSERT INTO meta VALUES(?,?)').run('legacy-import-v1', 'complete');
    });
  }
  settings = readObject(settingsFile);
  ready = true;
  return cacheEntries();
}
function cacheEntries() { return { ...settings, ...Object.fromEntries(db.prepare('SELECT key,value FROM kv').all().map((row) => [row.key, row.value])) }; }
function requireReady() { if (!ready) throw new Error('Session database migration has not completed; mutation blocked'); }
function readHistory({ threadId, cursor = null, limit = 100 }) {
  requireReady(); requireId(threadId);
  if (cursor !== null && (typeof cursor !== 'string' || !/^\d+$/u.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new TypeError('Invalid history cursor');
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid history page limit');
  const pageSize = Math.min(limit, 200);
  const rows = db.prepare('SELECT seq,message_id,info FROM messages WHERE namespace=? AND thread_id=? AND seq>? ORDER BY seq LIMIT ?')
    .all(namespace, threadId, Number(cursor ?? 0), pageSize + 1);
  const selected = rows.slice(0, pageSize);
  return {
    entries: selected.map((row) => ({ info: JSON.parse(row.info), parts: db.prepare('SELECT data FROM parts WHERE namespace=? AND thread_id=? AND message_id=? ORDER BY rowid').all(namespace, threadId, row.message_id).map((part) => JSON.parse(part.data)) })),
    nextCursor: rows.length > pageSize ? String(selected.at(-1).seq) : null,
  };
}
function mutate(key, value) {
  requireReady();
  if (typeof key !== 'string' || (value !== null && typeof value !== 'string')) throw new TypeError('Invalid storage mutation');
  if (key.startsWith(historyPrefix)) {
    transaction(() => {
      if (value === null) clearHistory({ threadId: decodeURIComponent(key.slice(historyPrefix.length)) });
      else importSnapshot(key, value);
    });
    return [];
  }
  const oldValue = isDatabaseKey(key) ? db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value ?? null : Object.hasOwn(settings, key) ? settings[key] : null;
  if (oldValue === value) return [];
  if (isDatabaseKey(key)) {
    if (value === null) db.prepare('DELETE FROM kv WHERE key=?').run(key);
    else db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  } else {
    const next = value === null ? { ...settings } : { ...settings, [key]: value };
    if (value === null) delete next[key];
    writeSettings(next); settings = next;
  }
  return [{ key, oldValue, newValue: value }];
}
function clearHistory({ threadId }) {
  requireReady(); requireId(threadId);
  insertThread.run(namespace, threadId);
  db.prepare('DELETE FROM messages WHERE namespace=? AND thread_id=?').run(namespace, threadId);
}
function migrate(entries) {
  requireReady();
  let nextSettings = { ...settings };
  const changes = transaction(() => {
    const committed = [];
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== 'string') throw new TypeError('Invalid migration value');
      if (key.startsWith(historyPrefix)) importSnapshot(key, value, true);
      else {
        const existing = isDatabaseKey(key) ? db.prepare('SELECT value FROM kv WHERE key=?').get(key) : Object.hasOwn(nextSettings, key);
        if (existing) continue;
        if (isDatabaseKey(key)) db.prepare('INSERT INTO kv VALUES(?,?)').run(key, value);
        else nextSettings = { ...nextSettings, [key]: value };
        committed.push({ key, oldValue: null, newValue: value });
      }
    }
    if (committed.some((change) => !isDatabaseKey(change.key))) writeSettings(nextSettings);
    return committed;
  });
  settings = nextSettings;
  return changes;
}
function dispatch(method, payload) {
  switch (method) {
    case 'prepare': return prepare();
    case 'legacyGet': {
      const root = readObject(legacyFile);
      return Object.hasOwn(root, payload.key) ? root[payload.key] : null;
    }
    case 'readHistory': return readHistory(payload);
    case 'readSnapshot': {
      requireReady();
      const threadId = decodeURIComponent(payload.key.slice(historyPrefix.length));
      if (!db.prepare('SELECT 1 FROM threads WHERE namespace=? AND thread_id=?').get(namespace, threadId)) return null;
      const entries = [];
      let cursor = null;
      do {
        const page = readHistory({ threadId, cursor, limit: 200 });
        entries.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return JSON.stringify({ version: 1, threadId, entries });
    }
    case 'upsertHistory': requireReady(); return transaction(() => upsert(payload.threadId, payload.entries));
    case 'clearHistory': return transaction(() => clearHistory(payload));
    case 'mutate': return mutate(payload.key, payload.value);
    case 'migrate': return migrate(payload);
    case 'flush': return undefined;
    case 'close': db.close(); return undefined;
    default: throw new TypeError('Unknown session database operation');
  }
}
parentPort.on('message', ({ id, method, payload }) => {
  try { parentPort.postMessage({ id, ok: true, value: dispatch(method, payload) }); }
  catch (error) { parentPort.postMessage({ id, ok: false, error: { name: error.name, message: error.message } }); }
  if (method === 'close') parentPort.close();
});
