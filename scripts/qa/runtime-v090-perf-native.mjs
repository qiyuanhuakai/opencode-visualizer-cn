import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { writeJson } from './runtime-v090-evidence.mjs';
import path from 'node:path';
import { summaryAt, wireAt, expectedInventory } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';
import { startKimiFixture } from './runtime-v090-cases/task-16-fixture.mjs';
import { createFixture as startDshFixture } from './runtime-v090-cases/task-17-fixture.mjs';
import { OPEN_CODE_OPERATIONS } from '../../shared/runtime/native/opencode/operations.js';

const root = path.resolve(process.argv[2]);
const count = Number(process.argv[3]);
await mkdir(root, { recursive: true });
const nativeRows = (index) => Array.from({ length: count / 5 }, (_, offset) => {
  const summary = summaryAt(offset * 5 + index);
  return { summary, wire: wireAt({ ...summary, workspace: summary.workspace ? path.join(root, summary.workspace) : null }) };
});
const opencode = nativeRows(0);
const historySample = opencode.find(({ summary }) => !summary.archived && !summary.parentId && summary.workspace);
historySample.wire.title = 'Vis measured native history session';
const databasePath = path.join(root, 'opencode.db');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER); BEGIN');
const insert = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)');
for (const { wire } of opencode) insert.run(wire.id, wire.projectID, wire.parentID ?? null, wire.directory, wire.title, '1.18.34', wire.time.created, wire.time.updated, wire.time.archived ?? null);
db.exec('COMMIT');
const streams = new Set();
const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': heartbeat\n\n'); }, 1000);
heartbeat.unref();
const paths = {};
for (const operation of Object.values(OPEN_CODE_OPERATIONS)) (paths[operation.path ?? `/session/{sessionID}${operation.suffix}`] ??= {})[operation.method.toLowerCase()] = {};
let calls = 0, bytes = 0;
const server = createServer(async (request, response) => {
  calls++;
  const url = new URL(request.url, 'http://native');
  const send = (value) => {
    const text = JSON.stringify(value);
    bytes += Buffer.byteLength(text);
    response.setHeader('Content-Type', 'application/json');
    response.end(text);
  };
  if (url.pathname === '/global/health') return send({ healthy: true, version: '1.18.34' });
  if (url.pathname === '/doc') return send({ paths });
  if (url.pathname === '/global/event') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(': connected\n\n');
    streams.add(response); response.once('close', () => streams.delete(response));
    return;
  }
  if (url.pathname === '/qa/event') {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const { wire } = opencode.find(({ summary }) => !summary.archived && !summary.parentId && summary.workspace);
    const title = url.searchParams.get('title') ?? 'Seed090 changed session';
    const updated = { ...wire, title, time: { ...wire.time, updated: Date.now() } };
    const preparationStarted = performance.now();
    db.prepare('UPDATE session SET title=?,time_updated=? WHERE id=?').run(title, updated.time.updated, wire.id);
    const preparationMs = performance.now() - preparationStarted;
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ directory: wire.directory, payload: { type: 'session.updated', properties: { info: updated } } })}\n\n`);
    return send({ sessionId: wire.id, title, preparationMs });
  }
  if (url.pathname === '/qa/stats') return send({ calls, bytes, streams: streams.size, expected: expectedInventory(count) });
  if (url.pathname === '/session') return send(opencode.slice(0, Number(url.searchParams.get('limit') ?? 100)).map(({ wire }) => wire));
  const sessionId = decodeURIComponent(url.pathname.split('/')[2] ?? '');
  if (url.pathname.endsWith('/message')) {
    return send([{ info: { id: 'seed-message', sessionID: sessionId, role: 'user', time: { created: 1 } }, parts: [{ id: 'seed-part', sessionID: sessionId, messageID: 'seed-message', type: 'text', text: `Seed090 native history for ${sessionId}.` }] }]);
  }
  if (url.pathname.startsWith('/session/')) return send(opencode.find(({ wire }) => wire.id === sessionId)?.wire ?? {});
  if (url.pathname === '/project') return send([]);
  if (url.pathname === '/provider') return send({ all: [{ id: 'seed', name: 'Seed protocol peer', models: { model: { id: 'model', name: 'Seed model', limit: { context: 32000, output: 4000 } } } }], connected: ['seed'], default: { seed: 'model' } });
  if (url.pathname === '/global/config') return send({ model: 'seed/model' });
  if (url.pathname === '/agent') return send([{ name: 'build', mode: 'primary' }]);
  return send([]);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const kimi = await startKimiFixture({ count: 0, advanced: true });
for (const { summary, wire } of nativeRows(3)) {
  kimi.sessions.set(wire.id, { id: wire.id, workspace: { id: summary.workspace ?? 'orphan', cwd: wire.metadata.cwd }, meta: { title: wire.title, archived: summary.archived, updated_at: wire.updated_at, created_at: wire.created_at }, activity: { status: 'idle' }, ...(summary.parentId ? { parent_session_id: summary.parentId } : {}) });
}
const dsh = await startDshFixture(() => {}, [], { advanced: true });
const dshRows = nativeRows(4);
dsh.state.summaries = dshRows.map(({ wire }) => ({ ...wire, projections: { values: { title: wire.title } } }));
dsh.state.baseline = { type: 'baseline', value: { items: [], archivedSessionIds: dshRows.filter(({ summary }) => summary.archived).map(({ wire }) => wire.sessionId), pinnedSessionIds: [] } };
const descriptor = { pid: process.pid, count, root, opencode: `http://127.0.0.1:${server.address().port}`, databasePath, kimi: kimi.endpoint, dsh: dsh.origin };
writeJson(path.join(root, 'native.json'), descriptor);
console.log(JSON.stringify(descriptor));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  clearInterval(heartbeat);
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), kimi.close(), dsh.close()]);
  db.close();
  process.exit(0);
});
