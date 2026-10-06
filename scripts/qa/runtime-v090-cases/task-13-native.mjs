import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifact, writeJson } from '../runtime-v090-evidence.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function startNative(context) {
  const root = await mkdtemp(path.join(context.temporaryRoot, 'opencode-native-'));
  const workspace = path.join(root, 'non-git'); const git = path.join(root, 'git');
  await mkdir(workspace); await mkdir(git);
  const env = { ...process.env, XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_CONFIG_CONTENT: '{"plugin":[]}' };
  const version = execFileSync('opencode', ['--version'], { env, encoding: 'utf8', timeout: 15000 }).trim();
  assert.equal(version, '1.18.34', 'native profile version must be explicitly verified');
  const child = spawn('opencode', ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  let log = ''; let endpoint;
  const append = (chunk) => { log += chunk.toString(); if (Buffer.byteLength(log) > 65536) { log = log.slice(-32768); child.kill('SIGTERM'); } };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const wire = [];
  async function request(route, method = 'GET', body) {
    const response = await fetch(endpoint + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const raw = await response.text();
    wire.push({ method, route, status: response.status, requestBytes: body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body)), responseBytes: Buffer.byteLength(raw) });
    assert(response.ok, `native ${method} ${route}: HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    return raw ? JSON.parse(raw) : null;
  }
  try {
    const deadline = Date.now() + 20000;
    while (!(endpoint = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]) && Date.now() < deadline) { assert(child.exitCode === null, 'native exited during startup'); await pause(25); }
    assert(endpoint, 'native did not publish an owned endpoint');
    const health = await request('/global/health'); assert.equal(health.version, version);
    const document = await request('/doc');
    const databasePath = execFileSync('opencode', ['db', 'path'], { env, cwd: workspace, encoding: 'utf8', timeout: 15000 }).trim();
    assert(databasePath.startsWith(root + path.sep), 'official db path escaped isolated state');
    const docPath = path.join(context.outDir, `${context.case}-native-doc.json`); writeJson(docPath, document);
    return {
      root, workspace, git, env, version, endpoint, databasePath, document, request, wire, pid: child.pid,
      artifacts: [artifact(docPath, 'installed-native-openapi')],
      async importSession(info, cwd = workspace) {
        const filename = path.join(root, 'import.json'); await writeFile(filename, JSON.stringify({ info, messages: [] }));
        const output = execFileSync('opencode', ['import', filename, '--pure'], { env, cwd, encoding: 'utf8', timeout: 15000 });
        assert(output.includes(`Imported session: ${info.id}`), 'official native import did not acknowledge supplied ID');
        return request(`/session/${encodeURIComponent(info.id)}?directory=${encodeURIComponent(cwd)}`);
      },
      async close() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        const result = await exit; clearTimeout(force);
        const logPath = path.join(context.outDir, `${context.case}-native-process.log`); await writeFile(logPath, log || `native exit ${JSON.stringify(result)}`);
        const receiptPath = path.join(context.outDir, `${context.case}-native-receipt.json`);
        writeJson(receiptPath, { binary: 'opencode', version, argv: ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], pid: child.pid, endpoint, root, databasePath, exit: result, isolated: true, wire });
        await rm(root, { recursive: true, force: true });
        return [artifact(logPath, 'installed-native-process-log'), artifact(receiptPath, 'installed-native-receipt')];
      },
    };
  } catch (error) {
    child.kill('SIGTERM'); await exit; await rm(root, { recursive: true, force: true }); throw error;
  }
}
export function readGroundTruth(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      rows: db.prepare('SELECT id, project_id, parent_id, directory, title, time_created, time_updated, time_archived FROM session ORDER BY id COLLATE BINARY').all().map((row) => ({ ...row })),
      schema: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => ({ ...row })),
      ties: db.prepare('SELECT time_updated, count(*) count FROM session GROUP BY time_updated HAVING count(*) > 1').all().map((row) => ({ ...row })),
    };
  } finally { db.close(); }
}
export async function storeHashes(databasePath) {
  const hashes = {};
  for (const suffix of ['', '-wal', '-shm']) {
    try { const bytes = await readFile(databasePath + suffix); hashes[suffix || 'db'] = createHash('sha256').update(bytes).digest('hex'); }
    catch (error) { if (!(error instanceof Error) || error.code !== 'ENOENT') throw error; }
  }
  return hashes;
}
export async function seedNative(native, context) {
  const ids = []; const roots = [];
  const startedAt = Date.now();
  for (let index = 0; index < 1001; index++) { const item = await native.request('/session', 'POST', { title: `QA Global root ${index}` }); ids.push(item.id); roots.push(item); }
  for (let index = 0; index < 3; index++) { const item = await native.request('/session', 'POST', { title: `QA child ${index}`, parentID: roots[0].id }); ids.push(item.id); if (index === 0) await native.request(`/session/${item.id}`, 'PATCH', { time: { archived: 99 } }); }
  await native.request(`/session/${roots[0].id}`, 'PATCH', { time: { archived: 88 } });
  const tieDirectory = path.join(native.root, 'equal-time'); await mkdir(tieDirectory);
  for (let index = 0; index < 3; index++) {
    const item = await native.importSession({ ...roots[0], id: `ses_native_equal_000${index}`, title: `QA equal boundary ${index}`, ...(index === 1 ? { parentID: roots[0].id } : {}), time: { created: 1000, updated: 2000, ...(index === 2 ? { archived: 3000 } : {}) } }, tieDirectory);
    assert.equal(item.time.updated, 2000); ids.push(item.id);
  }
  execFileSync('git', ['init', '--quiet', native.git]);
  execFileSync('git', ['-C', native.git, '-c', 'user.name=QA', '-c', 'user.email=qa@example.com', 'commit', '--allow-empty', '--quiet', '-m', 'native profile']);
  const gitSession = await native.request(`/session?directory=${encodeURIComponent(native.git)}`, 'POST', { title: 'QA Git project' }); ids.push(gitSession.id);
  const orphanDirectory = path.join(native.root, 'removed-directory'); await mkdir(orphanDirectory);
  const orphan = await native.request(`/session?directory=${encodeURIComponent(orphanDirectory)}`, 'POST', { title: 'QA orphan' }); ids.push(orphan.id); await rm(orphanDirectory, { recursive: true });
  const truth = readGroundTruth(native.databasePath);
  assert.deepEqual([...ids].sort(), truth.rows.map((row) => row.id), 'official API/import inputs agree with independent readonly inventory');
  const probes = {};
  for (const query of ['', '?limit=1000', '?limit=2000', '?directory=%2F&scope=project&limit=2000', '?roots=true&limit=2000', '?start=2000&limit=2', '?start=2001&limit=2000', `?start=${Date.now() + 60000}&limit=2`]) {
    const rows = await native.request('/session' + query); probes['/session' + query] = { ids: rows.map((row) => row.id), times: rows.map((row) => row.time.updated), count: rows.length };
  }
  for (const query of ['?limit=2', '?limit=2&cursor=2000', '?limit=2&cursor=2001', '?limit=2000&archived=true', '?limit=2000&archived=false']) {
    const rows = await native.request('/experimental/session' + query); probes['/experimental/session' + query] = { ids: rows.map((row) => row.id), times: rows.map((row) => row.time.updated), count: rows.length };
  }
  const filename = path.join(context.outDir, `${context.case}-native-inventory.json`);
  writeJson(filename, { version: native.version, sources: ['official POST /session', 'official PATCH /session', 'official opencode import'], insertedIds: ids, truth, probes, seedDurationMs: Date.now() - startedAt, gitSession, orphan });
  return { truth, ids, roots, gitSession, orphan, tieDirectory, probes, artifact: artifact(filename, 'independent-native-inventory') };
}
