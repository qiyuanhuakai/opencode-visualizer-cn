import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/** Controlled protocol fault server; never reported as a live OpenCode implementation. */
export async function startFixture(document) {
  const streams = new Set(); const calls = []; const sessions = new Map(); const messages = new Map(); const gates = new Map();
  let serial = 0, connections = 0, disconnected = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/global/health') { response.end('{"healthy":true,"version":"1.18.34"}'); return; }
    if (url.pathname === '/doc') { response.end(JSON.stringify(document)); return; }
    if (url.pathname === '/global/event') { connections++; response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders(); streams.add(response); response.on('close', () => { streams.delete(response); disconnected++; }); return; }
    const gate = gates.get(url.pathname); if (gate) await gate;
    if (url.pathname === '/session' && request.method === 'POST') {
      const item = { id: `ses_fixture_${++serial}`, projectID: 'global', directory: url.searchParams.get('directory') ?? '/fixture', title: body?.title ?? 'Fixture', version: '1.18.34', time: { created: Date.now(), updated: Date.now() } };
      sessions.set(item.id, item); response.end(JSON.stringify(item)); return;
    }
    if (url.pathname === '/session') { response.end(JSON.stringify([...sessions.values()].slice(0, Number(url.searchParams.get('limit') ?? 100)))); return; }
    const match = /^\/session\/([^/]+)(.*)$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]); const suffix = match[2]; const item = sessions.get(id);
      if (suffix === '/prompt_async') {
        const info = { id: body?.messageID ?? `msg_fixture_${++serial}`, sessionID: id, role: 'user', time: { created: Date.now() } };
        messages.set(id, [...(messages.get(id) ?? []), { info, parts: body?.parts ?? [] }]);
        emit('message.updated', { info }); emit('session.status', { sessionID: id, status: { type: 'busy' } });
        response.statusCode = 204; response.end(); return;
      }
      if (suffix === '/message') { response.end(JSON.stringify(messages.get(id) ?? [])); return; }
      if (suffix === '/abort') { emit('session.idle', { sessionID: id }); response.end('true'); return; }
      if (suffix === '' && request.method === 'GET') { response.end(JSON.stringify(item)); return; }
      if (suffix === '' && request.method === 'PATCH') { const updated = { ...item, ...body, time: { ...item.time, ...body?.time, updated: Date.now() } }; sessions.set(id, updated); emit('session.updated', { info: updated }); response.end(JSON.stringify(updated)); return; }
      if (suffix === '' && request.method === 'DELETE') { sessions.delete(id); emit('session.deleted', { info: item }); response.end('true'); return; }
    }
    if (url.pathname === '/global/config' || url.pathname === '/provider') { response.end(JSON.stringify({ model: 'fixture/model', apiKey: 'fake-native-secret', nested: { token: 'fake-token' } })); return; }
    response.end('true');
  });
  function emit(type, properties, directory = '/fixture') { for (const stream of streams) stream.write(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`); }
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`, calls, sessions, messages, emit,
    gate(route, promise) { if (promise) gates.set(route, promise); else gates.delete(route); },
    get connections() { return connections; }, get disconnected() { return disconnected; },
    raw(value) { for (const stream of streams) stream.write(value); },
    disconnect() { for (const stream of streams) stream.destroy(); },
    async close() { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
export function summaryFixture(databasePath, count = 1005) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER); BEGIN;');
  const insert = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?)');
  for (let index = 0; index < count; index++) insert.run(`ses_${String(index).padStart(6, '0')}`, index % 2 ? 'global' : 'project', index % 3 ? null : 'ses_parent', index % 7 ? '/fixture' : '', `Summary ${index}`, '1.18.34', 10, 20, index % 5 ? null : 30);
  db.exec('COMMIT');
  return db;
}
export async function until(predicate, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  while (!(await predicate())) { assert(Date.now() < deadline, 'controlled protocol condition did not arrive'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
export async function nextEvent(iterator, type) {
  let timeout;
  try {
    return await Promise.race([
      (async () => { for (let index = 0; index < 1000; index++) { const next = await iterator.next(); assert(!next.done, 'event stream ended'); if (next.value.type === type) return next.value; } assert.fail('event not found within bound'); })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`event ${type} timed out`)), 5000); }),
    ]);
  } finally { clearTimeout(timeout); }
}
