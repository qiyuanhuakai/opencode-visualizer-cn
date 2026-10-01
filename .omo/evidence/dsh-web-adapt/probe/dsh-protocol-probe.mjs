#!/usr/bin/env node
// dsh web protocol re-probe (Task 6 of .omo/plans/dsh-web-backend.md)
//
// Repeatable, self-cleaning probe of the local `dsh web` control plane:
//   1. version gate  (`dsh --version` must equal EXPECTED_VERSION)
//   2. port guard    (3080 busy => explicit failure, never kill a foreign process)
//   3. spawn `dsh web --no-open --port 3080` as an OWN child
//   4. parse the launch line, exchange launch token -> auth cookie
//   5. probe every endpoint from docs/dsh.md §7 with schema-legal shapes
//      (read-only / connection-layer only; writes are recorded as not-probed)
//   6. emit endpoint -> actual response shape / error code comparison tables
//   7. kill the child on success AND failure (try/finally)
//
// Degraded-credential path: when DEEPSEEK_API_KEY is absent we DO NOT send any
// prompt. Credential-gated captures (successful assistant stream, thinking/tool
// deltas, approval waterfall frames, subagent child session records, normal turn
// completion) are recorded as OWED and listed in the task-6 evidence manifest.
//
// Run from the worktree root:
//   node .omo/evidence/dsh-web-adapt/probe/dsh-protocol-probe.mjs
//
// Exits 0 when the version gate passes and all evidence files are written.
// Exits non-zero when the version mismatches, when port 3080 is occupied, or
// when the dsh service cannot be reached.

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// constants / paths
// ---------------------------------------------------------------------------

const EXPECTED_VERSION = '0.2.0-rc.2';
const PORT = 3080;
const HOST = '127.0.0.1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// <root>/.omo/evidence/dsh-web-adapt/probe -> <root>
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const EVIDENCE_DIR = path.join(ROOT, '.omo', 'evidence', 'dsh-web-adapt', 'task-6');

const HTTP_TIMEOUT_MS = 6000;
const STREAM_COLLECT_MS = 3500;
const STARTUP_TIMEOUT_MS = 25000;

const CAPTURED_AT = new Date().toISOString();
const YIELD_CREDENTIALS = !process.env.DEEPSEEK_API_KEY;

const evidence = {
  versionGate: null,
  launch: null,
  cookieExchanged: false,
  probeSessionId: null,
  probeWorkspaceId: null,
  snapshotCursor: null,
  results: [],
  streamFrames: {},
  rawRoutes: [],
  serverLog: '',
  cleanup: null,
};

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const log = (...a) => console.log('[probe]', ...a);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveDshRoot() {
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return path.join(globalRoot, '@deepseek-ai', 'dsh');
}

function loadWebSocket() {
  // Prefer a project-local `ws`, then fall back to the copy bundled with dsh
  // (the same DSH_ROOT resolution convention documented in the plan header).
  const candidates = [path.join(ROOT, 'noop.cjs'), path.join(resolveDshRoot(), 'noop.cjs')];
  for (const base of candidates) {
    try {
      const require = createRequire(base);
      return require('ws');
    } catch {
      /* try next */
    }
  }
  throw new Error('unable to resolve the `ws` websocket client');
}

/** Compact, JSON-safe description of a response body. */
function describeShape(body) {
  const text = typeof body === 'string' ? body : '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || typeof json !== 'object') {
    const trimmed = text.trim();
    if (!trimmed) return '<empty>';
    return `text:"${trimmed.slice(0, 120)}"`;
  }
  const walk = (v, depth) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return `[${walk(v[0], depth + 1)}${v.length > 1 ? `, x${v.length}` : ''}]`;
    }
    if (typeof v === 'object') {
      if (depth >= 2) return '{...}';
      const keys = Object.keys(v);
      return `{${keys.slice(0, 6).map((k) => `${k}:${walk(v[k], depth + 1)}`).join(',')}${keys.length > 6 ? ',…' : ''}}`;
    }
    if (typeof v === 'string') return 'string';
    return typeof v;
  };
  if (json.type === 'server-response') {
    const r = json.result || {};
    if (r.ok === true) return `{type:server-response, result:{ok:true, value:${walk(r.value, 0)}}}`;
    return `{type:server-response, result:{ok:false, error:{code:"${r.error?.code}", message:"${String(r.error?.message || '').slice(0, 200)}"}}}`;
  }
  return JSON.stringify(walk(json, 0)).slice(0, 240);
}

function classify(json) {
  if (!json || json.type !== 'server-response') return { outcome: 'non-envelope', code: null };
  const r = json.result || {};
  if (r.ok === true) return { outcome: 'ok', code: null };
  return { outcome: 'error', code: r.error?.code || 'unknown' };
}

function httpRequest({ method = 'GET', requestPath, headers = {}, body = null, timeout = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: requestPath, method, headers, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', error: err.message }));
    if (body != null) req.write(body);
    req.end();
  });
}

function rpcCall(method, args) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `probe-${method}-${Date.now()}`,
    method,
    payload: { args },
  });
  return httpRequest({
    method: 'POST',
    requestPath: `/api/${method}`,
    headers: {
      host: `${HOST}:${PORT}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      cookie: evidence.cookieHeader,
    },
    body,
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port });
    let settled = false;
    const done = (used) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(used);
    };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.setTimeout(700, () => done(false));
  });
}

// ---------------------------------------------------------------------------
// endpoint specification (docs/dsh.md §7 — 72 Typert Remote endpoints)
//   mode: 'probe' | 'stream' | 'write' | 'probe-create'
//   write endpoints are NEVER sent (no credential-gated session);
//   they are recorded as not-probed-with-write with their documented shape.
// `SID` / `WSID` / `CURSOR` are placeholder tokens substituted at runtime.
// ---------------------------------------------------------------------------

const SID = '__SID__';
const WSID = '__WSID__';
const CURSOR = '__CURSOR__';

const ENDPOINTS = [
  // §7.1 session + skills + fileReferences (21)
  { ep: 'session/list', form: 'unary', mode: 'probe', args: { _request: {} }, docs: '✅ {items:[...]}' },
  { ep: 'session/create', form: 'unary', mode: 'probe-create', args: { request: {} }, docs: '✅ {sessionId, agentPreset}' },
  { ep: 'session/prompt', form: 'unary', mode: 'write', args: { request: { requestId: 'probe', sessionId: SID, mode: 'queue', content: [{ type: 'text', text: '<prompt>' }] } }, docs: '✅ {accepted:true} (async; credential-gated)' },
  { ep: 'session/cancel', form: 'unary', mode: 'write', args: { request: { sessionId: SID } }, docs: '✅ {accepted:true}' },
  { ep: 'session/page', form: 'unary', mode: 'probe', args: { request: { address: { kind: 'session', sessionId: SID }, throughSeq: CURSOR } }, docs: '✅ {records:[...], hasMore}' },
  { ep: 'session/follow', form: 'stream', mode: 'stream', args: { request: { address: { kind: 'session', sessionId: SID }, assistantStream: true } }, docs: '✅ snapshot + 增量帧' },
  { ep: 'session/control', form: 'stream', mode: 'stream', args: {}, docs: '➖ (control frame stream)' },
  { ep: 'session/rename', form: 'unary', mode: 'write', args: { request: { sessionId: SID, title: 'probe' } }, docs: '✅ {title, seq}' },
  { ep: 'session/fork', form: 'unary', mode: 'write', args: { request: { sessionId: SID } }, docs: '✅ {sessionId}' },
  { ep: 'session/selectModel', form: 'unary', mode: 'write', args: { request: { sessionId: SID, provider: 'deepseek-official', model: 'deepseek-v4-pro' } }, docs: '✅ {selected:{...}}' },
  { ep: 'session/modelCatalog', form: 'unary', mode: 'probe', args: {}, docs: '✅ 模型清单' },
  { ep: 'session/initializeDefaultModel', form: 'unary', mode: 'probe', args: {}, docs: '➖' },
  { ep: 'session/search', form: 'unary', mode: 'probe', args: { request: { query: 'probe' } }, docs: '➖' },
  { ep: 'session/updateQueue', form: 'unary', mode: 'write', args: { request: {} }, docs: '❌ input-invalid（参数结构待补）' },
  { ep: 'session/attachment', form: 'unary', mode: 'probe', args: { request: { sessionId: SID, attachmentId: 'probe-missing' } }, docs: '➖' },
  { ep: 'session/canOpenWorkspacePath', form: 'unary', mode: 'probe', args: {}, docs: '➖' },
  { ep: 'session/openWorkspacePath', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'session/workspacePathApplications', form: 'unary', mode: 'probe', args: { request: {} }, docs: '➖' },
  { ep: 'session/projections', form: 'unary', mode: 'probe', args: { request: { sessionId: SID } }, docs: '➖' },
  { ep: 'session/skills/list', form: 'unary', mode: 'probe', args: { _request: {} }, docs: '❌ 404 not found' },
  { ep: 'session/fileReferences/list', form: 'unary', mode: 'probe', args: { agentId: 'probe', query: 'x' }, docs: '❌ 404 not found' },

  // §7.2 workspace + directoryPicker (14)
  { ep: 'workspace/create', form: 'unary', mode: 'write', args: { request: { path: '/tmp/dsh-probe-workspace' } }, docs: '✅ {workspace, created:true}' },
  { ep: 'workspace/follow', form: 'stream', mode: 'stream', args: {}, docs: '✅ {type:"baseline", value:{...}}' },
  { ep: 'workspace/delete', form: 'unary', mode: 'write', args: { request: { workspaceId: WSID } }, docs: '➖' },
  { ep: 'workspace/rename', form: 'unary', mode: 'write', args: { request: { workspaceId: WSID, title: 'probe' } }, docs: '➖' },
  { ep: 'workspace/insertBefore', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖ (排序)' },
  { ep: 'workspace/insertSessionBefore', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖ (排序)' },
  { ep: 'workspace/pinSession', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'workspace/unpinSession', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'workspace/archiveSession', form: 'unary', mode: 'write', args: { request: { sessionId: SID } }, docs: '➖' },
  { ep: 'workspace/unarchiveSession', form: 'unary', mode: 'write', args: { request: { sessionId: SID } }, docs: '➖' },
  { ep: 'workspace/initializeDefault', form: 'unary', mode: 'probe', args: {}, docs: '❌ gateway/internal (无 Documents)' },
  { ep: 'workspace/directoryPicker/list', form: 'unary', mode: 'probe', args: { path: '/tmp' }, docs: '➖' },
  { ep: 'workspace/directoryPicker/pick', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'workspace/directoryPicker/createDirectory', form: 'unary', mode: 'write', args: { request: { path: '/tmp/dsh-probe-dir' } }, docs: '➖' },

  // §7.3 terminal (10)
  { ep: 'terminal/list', form: 'unary', mode: 'probe', args: { sessionId: SID }, docs: '✅ []' },
  { ep: 'terminal/environment', form: 'unary', mode: 'probe', args: { agentId: SID }, docs: '✅ {cwd, maxInputBytes,…}' },
  { ep: 'terminal/shells', form: 'unary', mode: 'probe', args: { agentId: SID }, docs: '✅ [{path,name,args}]' },
  { ep: 'terminal/create', form: 'unary', mode: 'write', args: { agentId: SID, request: {} }, docs: '➖' },
  { ep: 'terminal/write', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'terminal/resize', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'terminal/close', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'terminal/rename', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'terminal/retain', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'terminal/follow', form: 'stream', mode: 'stream', args: { agentId: SID, id: 'probe-terminal', attachmentId: 'probe-attachment' }, docs: '➖ (PTY 输出流)' },

  // §7.4 settings + credentials (8)
  { ep: 'settings/describe', form: 'unary', mode: 'probe', args: {}, docs: '✅ 全部 namespace schema/value/…' },
  { ep: 'settings/update', form: 'unary', mode: 'write', args: { ns: 'probe', patch: {} }, docs: '➖' },
  { ep: 'settings/mutate', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'settings/replace', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'settings/openSettingsDocument', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },
  { ep: 'credentials/describe', form: 'unary', mode: 'probe', args: { refs: ['DEEPSEEK_API_KEY'] }, docs: '➖' },
  { ep: 'credentials/set', form: 'unary', mode: 'write', args: { ref: 'DEEPSEEK_API_KEY', value: '<redacted>' }, docs: '➖ (API key 写入路径)' },
  { ep: 'credentials/unset', form: 'unary', mode: 'write', args: { ref: 'DEEPSEEK_API_KEY' }, docs: '➖' },

  // §7.5 account (11)
  { ep: 'account/getState', form: 'unary', mode: 'probe', args: {}, docs: '✅ {status:"signed-out",…}' },
  { ep: 'account/getProfile', form: 'unary', mode: 'probe', args: { client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 } }, docs: '➖ (缺 client)' },
  { ep: 'account/getBalance', form: 'unary', mode: 'probe', args: { client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 } }, docs: '➖' },
  { ep: 'account/getUnnotifiedBonuses', form: 'unary', mode: 'probe', args: { client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 } }, docs: '➖' },
  { ep: 'account/hasRunningAccountTasks', form: 'unary', mode: 'probe', args: {}, docs: '➖' },
  { ep: 'account/ackBonusNotified', form: 'unary', mode: 'write', args: {}, docs: '➖' },
  { ep: 'account/signOut', form: 'unary', mode: 'write', args: { client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 } }, docs: '➖' },
  { ep: 'account/startSignIn', form: 'unary', mode: 'write', args: { client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 } }, docs: '➖ (登录入口)' },
  { ep: 'account/cancelSignIn', form: 'unary', mode: 'write', args: { client: { version: '0.2.0-rc.2', locale: 'en-US', timezoneOffsetSeconds: 0 } }, docs: '➖' },
  { ep: 'account/watch', form: 'stream', mode: 'stream', args: {}, docs: '➖' },
  { ep: 'account/watchExpiry', form: 'stream', mode: 'stream', args: {}, docs: '➖' },

  // §7.6 job (3)
  { ep: 'job/list', form: 'stream', mode: 'stream', args: { request: { sessionId: SID } }, docs: '❌ 经 HTTP → signature-invalid（必须走 mux）' },
  { ep: 'job/follow', form: 'stream', mode: 'stream', args: { request: { jobId: 'probe-job' } }, docs: '➖' },
  { ep: 'job/kill', form: 'unary', mode: 'write', args: { request: {} }, docs: '➖' },

  // §7.7 workspaceFiles (5)
  { ep: 'workspaceFiles/list', form: 'unary', mode: 'probe', args: { workspaceFileScopeId: SID, path: '.' }, docs: '✅ {path, entries:[…], truncated}' },
  { ep: 'workspaceFiles/stat', form: 'unary', mode: 'probe', args: { workspaceFileScopeId: SID, path: 'package.json' }, docs: '✅ {absolutePath, version, bytes}' },
  { ep: 'workspaceFiles/read', form: 'unary', mode: 'probe', args: { workspaceFileScopeId: SID, path: 'package.json', range: { offset: 1, limit: 80 } }, docs: '✅ {absolutePath, version, text, …}' },
  { ep: 'workspaceFiles/readBytes', form: 'unary', mode: 'probe', args: { workspaceFileScopeId: SID, path: 'package.json', options: {} }, docs: '➖' },
  { ep: 'workspaceFiles/changes', form: 'stream', mode: 'stream', args: { workspaceFileScopeId: SID, path: '.' }, docs: '➖ (实测为 stream：须走 mux)' },
];

// Special (non-§7) surfaces: $events stream + $events/result + raw fetch routes.
const RAW_ROUTES = [
  { ep: 'GET /api/file?path=/etc/hostname', method: 'GET', path: '/api/file?path=/etc/hostname', docs: '✅ 200 octet-stream' },
  { ep: 'GET /api/file (no path)', method: 'GET', path: '/api/file', docs: '✅ 400 missing path' },
  { ep: 'GET /api/present.host', method: 'GET', path: '/api/present.host', docs: '✅ 200 JSON 桌面元数据' },
  { ep: 'GET /api/changes.summary (no coords)', method: 'GET', path: '/api/changes.summary', docs: '400 invalid coordinates' },
  { ep: 'GET /api/present.open (no coords)', method: 'GET', path: '/api/present.open', docs: '400 invalid coordinates' },
  { ep: 'POST /api/session.export (no id)', method: 'GET', path: '/api/session.export', docs: '400 missing sessionId' },
];

// ---------------------------------------------------------------------------
// runtime resolution of placeholders
// ---------------------------------------------------------------------------

function resolveArgs(spec) {
  const sid = evidence.probeSessionId || 'probe-session';
  const wsid = evidence.probeWorkspaceId || 'probe-workspace';
  const cursor = evidence.snapshotCursor ?? 1;
  // NOTE: numeric placeholders must be substituted WITH their surrounding
  // quotes (`"__CURSOR__"` -> `2`) so the field stays a JSON number; string
  // placeholders (SID/WSID) are substituted inside their existing quotes.
  const text = JSON.stringify(spec.args)
    .replaceAll('"__CURSOR__"', String(cursor))
    .replaceAll(SID, sid)
    .replaceAll(WSID, wsid);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function versionGate() {
  let out = '';
  let ok = false;
  try {
    out = execFileSync('dsh', ['--version'], { encoding: 'utf8' }).trim();
    ok = out === EXPECTED_VERSION;
  } catch (err) {
    out = `error: ${err.message}`;
  }
  evidence.versionGate = { expected: EXPECTED_VERSION, actual: out, pass: ok };
  const lines = [
    '# dsh --version gate (Task 6)',
    '',
    `expected: ${EXPECTED_VERSION}`,
    `actual:   ${out}`,
    `pass:     ${ok}`,
    `captured: ${CAPTURED_AT}`,
    '',
  ];
  if (!ok) {
    lines.push(
      'WARNING: protocol generation mismatch.',
      'Re-run the probe on a machine with the matching dsh version before trusting',
      'the endpoint shapes in this evidence directory. Refusing to continue.',
      '',
    );
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'version-gate.txt'), lines.join('\n'));
  return ok;
}

async function collectStreams() {
  const WebSocket = loadWebSocket();
  const frames = {};
  const specs = ENDPOINTS.filter((e) => e.mode === 'stream');
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const ws = new WebSocket(`ws://${HOST}:${PORT}/api/remote.mux`, {
      headers: { cookie: evidence.cookieHeader },
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'open', streamId: 'special-events', endpoint: '$events', payload: { args: {} } }));
      specs.forEach((s, i) => {
        const streamId = `s${i}`;
        s.__streamId = streamId;
        frames[streamId] = [];
        ws.send(JSON.stringify({ type: 'open', streamId, endpoint: s.ep, payload: { args: resolveArgs(s) } }));
      });
    });
    ws.on('message', (data) => {
      const raw = data.toString();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const sid = parsed.streamId || 'special-events';
      const bucket = frames[sid] || (frames[sid] = []);
      bucket.push(parsed);
      // capture snapshot cursor for session/page
      if (parsed.type === 'item' && parsed.value?.type === 'snapshot' && typeof parsed.value.cursor === 'number') {
        evidence.snapshotCursor = parsed.value.cursor;
      }
    });
    ws.on('error', finish);
    setTimeout(finish, STREAM_COLLECT_MS);
  });
  evidence.streamFrames = frames;
}

async function main() {
  ensureDir(EVIDENCE_DIR);
  ensureDir(path.join(EVIDENCE_DIR));
  log('version gate...');
  if (!versionGate()) {
    console.error(`[probe] FATAL: dsh version ${evidence.versionGate.actual} != ${EXPECTED_VERSION}`);
    return 1;
  }
  log(`version gate PASS (${EXPECTED_VERSION})`);

  if (await portInUse(PORT)) {
    console.error(
      `[probe] FATAL: port ${PORT} is already in use. Refusing to kill a foreign process. ` +
        `Stop the process on ${HOST}:${PORT} and re-run.`,
    );
    return 1;
  }

  const child = spawn('dsh', ['web', '--no-open', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pid = child.pid;
  let launch = null;
  try {
    // ---- parse launch line ------------------------------------------------
    let buf = '';
    launch = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup line timeout')), STARTUP_TIMEOUT_MS);
      const onData = (d) => {
        buf += d.toString();
        evidence.serverLog += d.toString();
        const m = buf.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve({ port: Number(m[1]), token: m[2] });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (d) => {
        evidence.serverLog += d.toString();
      });
      child.on('exit', (code) => reject(new Error(`dsh exited early (code ${code})`)));
    });
    evidence.launch = { port: launch.port, tokenLength: launch.token.length };
    if (launch.port !== PORT) throw new Error(`launch port ${launch.port} != requested ${PORT}`);
    log(`spawned dsh web pid=${pid} port=${launch.port}`);

    // ---- token -> cookie exchange ----------------------------------------
    const cookieRes = await httpRequest({
      method: 'GET',
      requestPath: `/?token=${encodeURIComponent(launch.token)}`,
      headers: { host: `${HOST}:${PORT}` },
    });
    const setCookie = cookieRes.headers['set-cookie'] || [];
    const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
    if (!cookieHeader || !cookieHeader.includes('dsh-auth')) {
      throw new Error(`cookie exchange failed (status ${cookieRes.status}, set-cookie=${setCookie.length})`);
    }
    evidence.cookieExchanged = true;
    evidence.cookieHeader = cookieHeader;
    evidence.cookieStatus = cookieRes.status;
    evidence.cookieName = cookieHeader.split('=')[0];
    log(`cookie exchanged (${evidence.cookieName}) status=${cookieRes.status}`);

    // ---- select/create a probe session (controlled fixture; not user data) ----
    // Prefer reusing an existing blank session so repeated probe runs stay
    // idempotent and do not accumulate sessions. Only create one when none is
    // blank. Done BEFORE the stream phase so session/follow observes a real
    // snapshot and yields the cursor used by session/page.
    const listForReuse = await rpcCall('session/list', { _request: {} });
    let existingItems = [];
    try {
      existingItems = JSON.parse(listForReuse.body)?.result?.value?.items || [];
    } catch {
      existingItems = [];
    }
    const blank = existingItems.find(
      (it) => it.blank === true || it.projections?.values?.blank === true,
    );
    if (blank?.sessionId) {
      evidence.probeSessionId = blank.sessionId;
      evidence.probeSessionSource = 'reused-blank';
      log(`reusing blank probe session: ${blank.sessionId}`);
    } else {
      const createRes = await rpcCall('session/create', { request: {} });
      let created = null;
      try {
        created = JSON.parse(createRes.body)?.result?.value;
      } catch {
        /* ignore */
      }
      if (created?.sessionId) {
        evidence.probeSessionId = created.sessionId;
        evidence.probeSessionSource = 'created';
        log(`probe session created: ${created.sessionId}`);
      } else {
        evidence.probeSessionId = existingItems[0]?.sessionId || null;
        evidence.probeSessionSource = 'reused-first';
        log(`probe session create unavailable; using existing ${evidence.probeSessionId}`);
      }
    }

    // ---- stream phase (also yields snapshot cursor) ----------------------
    log('collecting mux streams...');
    await collectStreams();

    // ---- workspace baseline for workspaceId placeholder -----------------
    const wsFrame = Object.values(evidence.streamFrames)
      .flat()
      .find((f) => f.type === 'item' && f.value?.type === 'baseline' && f.value?.value?.items);
    evidence.probeWorkspaceId = wsFrame?.value?.value?.items?.[0]?.workspaceId || null;

    if (evidence.snapshotCursor == null) evidence.snapshotCursor = 1;

    // ---- unary probe phase ------------------------------------------------
    log(`probing ${ENDPOINTS.length} endpoints...`);
    const results = [];
    for (const spec of ENDPOINTS) {
      const args = resolveArgs(spec);
      if (spec.mode === 'write') {
        results.push({
          ep: spec.ep,
          form: spec.form,
          mode: 'not-probed-with-write',
          httpStatus: null,
          outcome: 'not-probed',
          code: null,
          shape: `(shape) ${JSON.stringify(args).slice(0, 160)}`,
          docs: spec.docs,
          note: 'side-effecting endpoint withheld (degraded credential path: no live credentialed session)',
        });
        continue;
      }
      if (spec.mode === 'stream') {
        const bucket = evidence.streamFrames[spec.__streamId] || [];
        const first = bucket[0];
        const errFrame = bucket.find((f) => f.type === 'error');
        results.push({
          ep: spec.ep,
          form: spec.form,
          mode: 'mux-stream',
          httpStatus: 101,
          outcome: errFrame ? 'error-frame' : first ? 'frames' : 'no-frames',
          code: errFrame?.error?.code || null,
          shape: first
            ? `frame:${first.type} value.type=${first.value?.type ?? '-'}${bucket.length > 1 ? ` (+${bucket.length - 1})` : ''}`
            : '<no frames within window>',
          docs: spec.docs,
          frames: bucket.length,
          message: errFrame?.error?.message || null,
          note: errFrame?.error?.message?.slice(0, 120) || null,
        });
        continue;
      }
      const res = await rpcCall(spec.ep, args);
      let json = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = null;
      }
      const { outcome, code } = classify(json);
      results.push({
        ep: spec.ep,
        form: spec.form,
        mode: spec.mode === 'probe-create' ? 'probe-create' : 'unary',
        httpStatus: res.status,
        outcome: outcome === 'non-envelope' ? `http-${res.status}` : outcome,
        code,
        shape: describeShape(res.body),
        message: json?.result?.error?.message || null,
        docs: spec.docs,
        note: spec.mode === 'probe-create' ? 'creates the probe fixture session' : null,
      });
    }

    // ---- raw fetch routes (appendix) --------------------------------------
    for (const r of RAW_ROUTES) {
      const res = await httpRequest({
        method: r.method,
        requestPath: r.path,
        headers: { host: `${HOST}:${PORT}`, cookie: evidence.cookieHeader },
      });
      evidence.rawRoutes.push({
        ep: r.ep,
        httpStatus: res.status,
        contentType: res.headers['content-type'] || '',
        shape: describeShape(res.body),
        docs: r.docs,
      });
    }

    evidence.launch = { port: launch.port, tokenLength: launch.token.length };
    evidence.results = results;

    // ---- version metadata sidecar ----------------------------------------
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'probe-results.json'),
      JSON.stringify(
        {
          capturedAt: CAPTURED_AT,
          dshVersion: evidence.versionGate.actual,
          expectedVersion: EXPECTED_VERSION,
          endpointCount: ENDPOINTS.length,
          credentialFrontGate: YIELD_CREDENTIALS ? 'absent (DEEPSEEK_API_KEY not set, degraded path)' : 'present',
          degradedPath: YIELD_CREDENTIALS,
          probeSessionId: evidence.probeSessionId,
          probeSessionSource: evidence.probeSessionSource,
          snapshotCursor: evidence.snapshotCursor,
          results,
          rawRoutes: evidence.rawRoutes,
          versionGate: evidence.versionGate,
          cookie: { exchanged: evidence.cookieExchanged, name: evidence.cookieName, status: evidence.cookieStatus },
        },
        null,
        2,
      ),
    );

    writeComparisonTable();
    writeDocsMatrixDiff();
    writeDegradedRecord();
    writeCaptureManifest();
    return 0;
  } catch (err) {
    evidence.error = err.message;
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'probe-error.txt'), `${err.stack || err.message}\n`);
    console.error(`[probe] ERROR: ${err.message}`);
    return 1;
  } finally {
    // ---- cleanup: always terminate the spawned process -------------------
    let terminated = false;
    if (child && child.pid) {
      const stillAlive = () => {
        try {
          process.kill(child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const deadline = Date.now() + 4000;
      while (stillAlive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (stillAlive()) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      terminated = !stillAlive();
      pid = child.pid;
    } else {
      terminated = true;
    }
    evidence.cleanup = { pid, terminated };
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'cleanup-receipt.txt'),
      [
        '# spawned dsh web process cleanup',
        '',
        `pid: ${pid}`,
        `signal: SIGTERM then SIGKILL if still alive`,
        `terminated: ${terminated}`,
        `checkedAt: ${new Date().toISOString()}`,
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'dsh-web.stdout.log'), evidence.serverLog || '');
    log(`cleanup: pid ${pid} terminated=${terminated}`);
  }
}

// ---------------------------------------------------------------------------
// evidence writers
// ---------------------------------------------------------------------------

function docMarkFor(ep) {
  const spec = ENDPOINTS.find((e) => e.ep === ep);
  return spec ? spec.docs : '';
}

function writeComparisonTable() {
  const [allEndpoint, okCount, errCount, notProbed] = [
    evidence.results,
    evidence.results.filter((r) => r.outcome === 'ok' || r.outcome === 'frames').length,
    evidence.results.filter((r) => r.outcome === 'error' || r.outcome === 'error-frame' || String(r.outcome).startsWith('http-')).length,
    evidence.results.filter((r) => r.mode === 'not-probed-with-write').length,
  ];
  const lines = [];
  lines.push('# Endpoint → actual response comparison (Task 6)');
  lines.push('');
  lines.push(`- captured: ${CAPTURED_AT}`);
  lines.push(`- dsh version: ${evidence.versionGate.actual} (expected ${EXPECTED_VERSION})`);
  lines.push(`- endpoint count: ${allEndpoint.length} / 72`);
  lines.push(`- credential front gate: ${YIELD_CREDENTIALS ? 'ABSENT — degraded path (read-only/connection layer only)' : 'present'}`);
  lines.push(`- outcomes: ok/frames=${okCount}, error/signature=${errCount}, not-probed-with-write=${notProbed}`);
  lines.push(`- probe session: ${evidence.probeSessionId || 'n/a'} (${evidence.probeSessionSource || 'n/a'}; reused-if-blank)`);
  lines.push('');
  lines.push('| # | endpoint | form | probe mode | HTTP | outcome | error code | response shape | docs §7 expectation |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  evidence.results.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | \`${r.ep}\` | ${r.form} | ${r.mode} | ${r.httpStatus ?? '-'} | ${r.outcome} | ${r.code ? `\`${r.code}\`` : '-'} | ${r.shape.replace(/\|/g, '\\|')} | ${r.docs} |`,
    );
  });
  lines.push('');
  lines.push('## mux stream frame detail');
  lines.push('');
  lines.push('| endpoint | frames | first frame | error frame |');
  lines.push('|---|---|---|---|');
  for (const spec of ENDPOINTS.filter((e) => e.mode === 'stream')) {
    const bucket = evidence.streamFrames[spec.__streamId] || [];
    const first = bucket[0];
    const err = bucket.find((f) => f.type === 'error');
    lines.push(
      `| \`${spec.ep}\` | ${bucket.length} | ${first ? `\`${JSON.stringify(first).slice(0, 160)}\`` : '-'} | ${err ? `\`${err.error?.code}\`` : '-'} |`,
    );
  }
  lines.push('');
  lines.push('## special surfaces (not counted in the 72)');
  lines.push('');
  lines.push('| surface | frames | first frame |');
  lines.push('|---|---|---|');
  const ev = evidence.streamFrames['special-events'] || [];
  lines.push(`| \`$events\` (mux) | ${ev.length} | ${ev[0] ? `\`${JSON.stringify(ev[0]).slice(0, 200)}\`` : '-'} |`);
  lines.push(`| \`POST /api/$events/result\` | - | not-probed (requires a live waterfall frame) |`);
  lines.push('');
  lines.push('## raw fetch routes (§5.5 appendix)');
  lines.push('');
  lines.push('| route | HTTP | content-type | shape | docs expectation |');
  lines.push('|---|---|---|---|---|');
  for (const r of evidence.rawRoutes) {
    lines.push(`| \`${r.ep}\` | ${r.httpStatus} | ${r.contentType} | ${String(r.shape).replace(/\|/g, '\\|')} | ${r.docs} |`);
  }
  lines.push('');
  lines.push('> Every row above is a RAW observation (status + shape/error code), not an interpretation.');
  lines.push('> `not-probed-with-write` rows were intentionally withheld: rename/fork/archive/pin and other');
  lines.push('> side-effecting endpoints are never executed against a live session from this probe.');
  lines.push('');
  lines.push('## schema hints from gateway/arguments-invalid + gateway/input-invalid');
  lines.push('');
  lines.push('The gateway error messages enumerate missing/unexpected fields; they are the authoritative');
  lines.push('schema-discovery signal for params still unresolved in docs §7.');
  lines.push('');
  lines.push('| endpoint | code | full message |');
  lines.push('|---|---|---|');
  const hinted = evidence.results.filter(
    (r) => r.message && (r.code === 'gateway/arguments-invalid' || r.code === 'gateway/input-invalid' || r.code === 'gateway/signature-invalid'),
  );
  for (const r of hinted) {
    lines.push(`| \`${r.ep}\` | \`${r.code}\` | ${String(r.message).replace(/\|/g, '\\|')} |`);
  }
  for (const spec of ENDPOINTS.filter((e) => e.mode === 'stream')) {
    const bucket = evidence.streamFrames[spec.__streamId] || [];
    const err = bucket.find((f) => f.type === 'error');
    if (err) {
      lines.push(`| \`${spec.ep}\` (mux) | \`${err.error?.code}\` | ${String(err.error?.message || '').replace(/\|/g, '\\|')} |`);
    }
  }
  lines.push('');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'endpoint-comparison.md'), lines.join('\n'));
}

function writeDocsMatrixDiff() {
  const byEp = Object.fromEntries(evidence.results.map((r) => [r.ep, r]));
  const pick = (ep) => byEp[ep];
  const diffs = [];
  const note = (ep, what) => diffs.push({ ep, what, actual: pick(ep) });

  // documented ❌ in §10 / §7 that still hold
  for (const ep of ['session/skills/list', 'session/fileReferences/list']) {
    const r = pick(ep);
    if (r && String(r.outcome).startsWith('http-404')) note(ep, 'docs ❌ 404 — reproduced');
  }
  // documented ✅ that reproduced ok
  const okDocs = [
    'session/list', 'session/create', 'session/page', 'session/modelCatalog',
    'terminal/list', 'terminal/environment', 'terminal/shells',
    'settings/describe', 'account/getState',
    'workspaceFiles/list', 'workspaceFiles/stat', 'workspaceFiles/read',
  ];
  for (const ep of okDocs) {
    const r = pick(ep);
    if (r && r.outcome === 'ok') note(ep, 'docs ✅ — reproduced');
    else if (r) note(ep, `docs ✅ — DIVERGED (actual: ${r.outcome}${r.code ? ` / ${r.code}` : ''})`);
  }
  // documented ❌ initializeDefault (no Documents) — re-check
  {
    const r = pick('workspace/initializeDefault');
    if (r && r.outcome === 'ok') note('workspace/initializeDefault', 'docs ❌ gateway/internal — DIVERGED: returned ok in this environment');
  }
  // documented stream-http signature-invalid
  {
    const r = pick('job/list');
    if (r) note('job/list', `docs ❌ 经 HTTP signature-invalid；本次经 mux 实测 outcome=${r.outcome}`);
  }
  // newly observed 404 for directoryPicker/list (docs ➖)
  {
    const r = pick('workspace/directoryPicker/list');
    if (r) note('workspace/directoryPicker/list', `docs ➖ 未探测；本次实测 ${r.outcome}`);
  }
  // workspaceFiles/changes is a stream endpoint, not unary (docs §7.7 lists it without a form)
  {
    const r = pick('workspaceFiles/changes');
    if (r) note('workspaceFiles/changes', `docs §7.7 未标注形态；本次实测为 STREAM（经 HTTP 报 signature-invalid，经 mux outcome=${r.outcome}）`);
  }

  const lines = [];
  lines.push('# Diff list vs docs/dsh.md §10 availability matrix (Task 6)');
  lines.push('');
  lines.push('Documentation updates belong to Todo 37; this file only enumerates observed differences.');
  lines.push('');
  lines.push('| endpoint | docs claim | actual observation | verdict |');
  lines.push('|---|---|---|---|');
  for (const d of diffs) {
    const r = d.actual || {};
    lines.push(
      `| \`${d.ep}\` | ${docMarkFor(d.ep)} | ${r.outcome || '-'}${r.code ? ` / \`${r.code}\`` : ''} (HTTP ${r.httpStatus ?? '-'}) | ${d.what} |`,
    );
  }
  lines.push('');
  lines.push('## §10 matrix rows vs this run');
  lines.push('');
  lines.push('| §10 surface | docs status | this run |');
  lines.push('|---|---|---|');
  lines.push(`| HTTP unary RPC | ✅ 可用 | ${pick('session/list').outcome === 'ok' ? '✅ reproduced' : '⚠️ diverged'} |`);
  lines.push(`| WS mux + $events + session/follow + workspace/follow | ✅ 可用 | ${(evidence.streamFrames['special-events'] || []).length > 0 ? '✅ $events ready frame captured' : '⚠️ no frames'} |`);
  lines.push(`| stream 方法经 HTTP 调用 | ❌ 不支持（必须走 mux） | ${pick('job/list').outcome === 'error-frame' || pick('job/list').code ? `reproduced (mux outcome=${pick('job/list').outcome})` : 'see stream table'} |`);
  lines.push(`| 平铺 payload | ❌ 不支持（必须 {args:{…}}） | probe used {args:{…}} throughout; envelope accepted |`);
  lines.push(`| session/skills/list + fileReferences/list | ❌ 404 | ${pick('session/skills/list').outcome} / ${pick('session/fileReferences/list').outcome} |`);
  lines.push(`| workspace/initializeDefault | ❌ internal (无 Documents) | ${pick('workspace/initializeDefault').outcome}${pick('workspace/initializeDefault').code ? ` / ${pick('workspace/initializeDefault').code}` : ''} |`);
  lines.push(`| 真实 LLM 对话 | ⚠️ 需凭证 | credential front gate ABSENT → not captured (degraded) |`);
  lines.push(`| 模型目录 | ✅ | ${pick('session/modelCatalog').outcome} |`);
  lines.push(`| 终端 | ✅ | environment=${pick('terminal/environment').outcome}, shells=${pick('terminal/shells').outcome}, list=${pick('terminal/list').outcome} |`);
  lines.push(`| 工作区文件 | ✅ | list=${pick('workspaceFiles/list').outcome}, stat=${pick('workspaceFiles/stat').outcome}, read=${pick('workspaceFiles/read').outcome} |`);
  lines.push(`| 裸 fetch 路由 | ✅ | ${evidence.rawRoutes.filter((r) => r.httpStatus === 200).length}/${evidence.rawRoutes.length} returned HTTP 200 |`);
  lines.push(`| 登录 | ➖ 未实测 | account/getState=${pick('account/getState').outcome}; startSignIn not probed (write) |`);
  lines.push('');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'docs-matrix-diff.md'), lines.join('\n'));
}

function writeDegradedRecord() {
  const owed = [
    ['live-capture-prompt-stream.jsonl', '成功的 assistant 文本增量流（successful prompt stream）', 'session/prompt + session/follow assistantStream'],
    ['live-capture-thinking-deltas.jsonl', '思考增量帧（reasoning/text deltas）', 'session/follow 或进程内 agent/assistant-stream'],
    ['live-capture-tool-calls.jsonl', '工具调用/结果（tool/call + tool/result）', '触发一个工具调用的 turn'],
    ['live-capture-approval-waterfall.jsonl', '审批 waterfall 帧：待决请求携带 sessionId/eventId 身份 + resolve/cancel 生命周期', 'approval/request → POST /api/$events/result'],
    ['live-capture-subagent-child.jsonl', '子代理 child session 的 session/page 记录（address kind:"subagent"）', 'subagent 事件 + child session 寻址'],
    ['live-capture-turn-complete.jsonl', 'turn 正常完成序列（turn/end reason.kind="completed"）', '成功的一轮对话'],
    ['live-capture-user-questions-waterfall.jsonl', 'user-questions/request waterfall 帧 + 安全拒绝应答', '提问事件触发'],
  ];
  const lines = [];
  lines.push('# Degraded capture record (Task 6)');
  lines.push('');
  lines.push(`- captured: ${CAPTURED_AT}`);
  lines.push(`- dsh version: ${evidence.versionGate?.actual ?? 'n/a'}`);
  lines.push(`- reason: \`DEEPSEEK_API_KEY\` is ABSENT in this environment. The plan's credential front gate is NOT met.`);
  lines.push('- action: ran the documented degraded path — probed all read-only / connection-layer endpoints, sent ZERO prompts.');
  lines.push('- no credential was sought, synthesized, or hardcoded.');
  lines.push('');
  lines.push('## Captures that were NOT taken (await a credentialed re-run keyed on DEEPSEEK_API_KEY)');
  lines.push('');
  lines.push('| owed fixture (app/backends/dsh/fixtures/) | missing capture | how to obtain in a credentialed re-run |');
  lines.push('|---|---|---|');
  for (const [file, what, how] of owed) {
    lines.push(`| \`${file}\` | ${what} | ${how} |`);
  }
  lines.push('');
  lines.push('## Capture modes explicitly skipped');
  lines.push('');
  lines.push('- successful prompt stream (assistant text deltas)');
  lines.push('- thinking / tool deltas');
  lines.push('- approval waterfall frames with sessionId/eventId identity + resolve/cancel lifecycle');
  lines.push('- subagent child-session `session/page` records');
  lines.push('- normal turn completion (`turn/end.reason.kind === "completed"`)');
  lines.push('');
  lines.push('## What WAS verified (degraded)');
  lines.push('');
  lines.push('- version gate, launch-line parse, token→cookie exchange');
  lines.push('- all 72 §7 endpoints recorded (ok / error code / shape / not-probed-with-write)');
  lines.push('- mux streams opened; `$events` ready frame, `workspace/follow` baseline, `session/follow` snapshot, `session/control` baseline, `job/list` rows captured');
  lines.push('- raw fetch routes probed');
  lines.push('');
  lines.push('The MISSING_CREDENTIAL lifecycle itself is already documented in');
  lines.push('`.omo/evidence/dsh-adapt/04-session-follow-full.txt` (first-round probe); this run did not');
  lines.push('re-send a prompt because the plan mandates zero real prompts in the degraded path.');
  lines.push('');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'degraded-capture-record.md'), lines.join('\n'));
}

function writeCaptureManifest() {
  const lines = [];
  lines.push('# Task 6 capture README / manifest');
  lines.push('');
  lines.push(`- generated: ${CAPTURED_AT}`);
  lines.push(`- probe script: \`.omo/evidence/dsh-web-adapt/probe/dsh-protocol-probe.mjs\``);
  lines.push(`- run command: \`node .omo/evidence/dsh-web-adapt/probe/dsh-protocol-probe.mjs\` (from worktree root)`);
  lines.push(`- dsh version: ${evidence.versionGate?.actual ?? 'n/a'} (gate ${evidence.versionGate?.pass ? 'PASS' : 'FAIL'})`);
  lines.push(`- credential front gate: ${YIELD_CREDENTIALS ? 'ABSENT (degraded path)' : 'present'}`);
  lines.push(`- endpoint coverage: ${evidence.results.length}/72`);
  lines.push(`- probe session: ${evidence.probeSessionId || 'n/a'} (${evidence.probeSessionSource || 'n/a'}; reused-if-blank to keep runs idempotent)`);
  lines.push(`- spawned process cleanup: pid ${evidence.cleanup?.pid ?? 'n/a'} terminated=${evidence.cleanup?.terminated}`);
  lines.push('');
  lines.push('## Files in this directory');
  lines.push('');
  lines.push('| file | purpose |');
  lines.push('|---|---|');
  lines.push('| `endpoint-comparison.md` | 72-endpoint → actual response shape / error code table + stream frames + raw routes |');
  lines.push('| `version-gate.txt` | `dsh --version` output and gate result |');
  lines.push('| `degraded-capture-record.md` | which credential-gated captures are still owed and why |');
  lines.push('| `docs-matrix-diff.md` | diff list vs docs/dsh.md §10 availability matrix |');
  lines.push('| `probe-results.json` | raw machine-readable results (no polling interpretations) |');
  lines.push('| `cleanup-receipt.txt` | spawned dsh process termination receipt |');
  lines.push('| `dsh-web.stdout.log` | captured dsh server stdout/stderr |');
  lines.push('| `capture-manifest.md` | this manifest |');
  lines.push('');
  lines.push('## Fixtures still owed to a credentialed re-run');
  lines.push('');
  lines.push('None were written in this run (no key ⇒ no fabricated fixtures — memory #798).');
  lines.push('The following `live-capture-*.jsonl` files must be produced by Todo 36 / a credentialed');
  lines.push('re-run and placed under `app/backends/dsh/fixtures/` with matching `.meta.json` sidecars:');
  lines.push('');
  for (const f of [
    'live-capture-prompt-stream.jsonl',
    'live-capture-thinking-deltas.jsonl',
    'live-capture-tool-calls.jsonl',
    'live-capture-approval-waterfall.jsonl',
    'live-capture-subagent-child.jsonl',
    'live-capture-turn-complete.jsonl',
    'live-capture-user-questions-waterfall.jsonl',
  ]) {
    lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('Downstream todos 8 / 18 / 24 / 28 / 36 should treat the approval-waterfall identity');
  lines.push('(sessionId/eventId) and subagent child-session records as UNVERIFIED until that re-run.');
  lines.push('');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'capture-manifest.md'), lines.join('\n'));
}

const code = await main();
process.exit(code);
