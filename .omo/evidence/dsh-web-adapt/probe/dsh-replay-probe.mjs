#!/usr/bin/env node
// dsh web reconnect / replay boundary probe (Task 7 of .omo/plans/dsh-web-backend.md)
//
// Injects three scenarios against a real local `dsh web` (0.2.0-rc.2) and lands
// the raw frame sequences + distilled measurements that the replay-boundary
// contract (`.omo/evidence/dsh-web-adapt/task-7/replay-boundary-contract.md`)
// is written from:
//
//   Scenario 1 — mid-stream mux kill + reconnect: does a re-opened `$events`
//     yield a NEW clientId, does a re-opened `session/follow` replay from the
//     beginning or from a cursor, and in what order/timing do the multi-stream
//     first frames arrive? Also: is the same streamId reusable on the new
//     connection, and are stray frames for unknown streams dropped silently?
//
//   Scenario 2 — events produced while disconnected (session/rename writes +
//     a session/create that should emit `api-session/added` on `$events`):
//     after reconnect, snapshot `cursor` vs pre-disconnect cursor, which seqs
//     the snapshot records actually cover (full replay vs tail window), and
//     whether `$events` replays missed broadcast events.
//
//   Scenario 3 — `session/page` (throughSeq / beforeSeq / maxMessages /
//     turnWindow) vs snapshot records: the complementary boundary, plus
//     windowed `session/follow` opens (maxMessages / turnWindow on follow).
//
//   Late-frame probes — uplink `end` then stray items, `cancel` then stray
//     items, duplicate `open` of the same streamId on one socket.
//
// Degraded-credential path: DEEPSEEK_API_KEY is ABSENT, so this probe sends
// ZERO `session/prompt` calls and touches no credentials. Turn lifecycles are
// therefore NOT constructed; every measurement above is connection-layer only.
// Event production uses `session/rename` on a probe-owned session (calibrated
// live first: if rename appends no event, the calibration falls back to
// `session/selectModel` and records which producer worked).
//
// Reuses the Task 6 scaffolding (`.omo/evidence/dsh-web-adapt/probe/
// dsh-protocol-probe.mjs`): version gate, port guard, own child spawn, launch-
// line parse, token->cookie exchange, SIGTERM/SIGKILL cleanup in `finally`.
// The mux client speaks RAW WS (`ws` resolved from the dsh global module root)
// to observe true wire behavior.
//
// Run from the worktree root:
//   node .omo/evidence/dsh-web-adapt/probe/dsh-replay-probe.mjs
//
// Exits 0 when all scenarios ran and evidence is written. Exits non-zero on
// version mismatch, occupied port, spawn/launch/cookie failure, or a scenario
// error (errors are still recorded to evidence before exiting non-zero).

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
const EVIDENCE_DIR = path.join(ROOT, '.omo', 'evidence', 'dsh-web-adapt', 'task-7');

const HTTP_TIMEOUT_MS = 6000;
const STARTUP_TIMEOUT_MS = 25000;
const FRAME_TIMEOUT_MS = 6000;
const SOCKET_TIMEOUT_MS = 8000;

const RUN_ID = `${Date.now().toString(36)}`;
const CAPTURED_AT = new Date().toISOString();
const T0 = Date.now();
const now = () => Date.now() - T0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const measurements = {
  runId: RUN_ID,
  capturedAt: CAPTURED_AT,
  versionGate: null,
  launch: null,
  cookie: null,
  session: null,
  calibration: null,
  scenario1: null,
  scenario2: null,
  scenario3: null,
  lateFrames: null,
  errors: [],
};

// scenario-tagged raw timeline (written verbatim as JSONL evidence)
const timeline = [];
const scenarioEvents = {};
function rec(scenario, entry) {
  const e = { scenario, t_ms: now(), ...entry };
  timeline.push(e);
  (scenarioEvents[scenario] ??= []).push(e);
  return e;
}

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
  // Same resolution convention as the Task 6 probe: prefer the copy bundled
  // with dsh (the repo itself has no `ws` dependency).
  const candidates = [path.join(resolveDshRoot(), 'noop.cjs')];
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

/**
 * Polls the scenario timeline until `pred(entry)` matches. Raw-first: entries
 * keep their raw wire text. Each call continues from the previous match
 * (high-water mark per scenario) so a re-opened streamId on a new connection
 * never re-matches the OLD connection's frame.
 */
const waitMark = {};
function waitFor(scenario, pred, timeoutMs, label, fromIndex) {
  const startIndex = fromIndex ?? waitMark[scenario] ?? 0;
  return new Promise((resolve, reject) => {
    const begin = Date.now();
    const tick = () => {
      const list = scenarioEvents[scenario] || [];
      for (let i = startIndex; i < list.length; i += 1) {
        if (pred(list[i])) {
          waitMark[scenario] = i;
          return resolve(list[i]);
        }
      }
      if (Date.now() - begin > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Current high-water index for a scenario (for post-hoc filters). */
function markOf(scenario) {
  return waitMark[scenario] ?? 0;
}

function httpRequest({ method = 'GET', requestPath, headers = {}, body = null, cookie = '', timeout = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: requestPath, method, headers: { host: `${HOST}:${PORT}`, cookie, ...headers }, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: '', error: err.message }));
    if (body != null) req.write(body);
    req.end();
  });
}

function rpcCall(method, args, cookie) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `probe7-${method}-${Date.now()}`,
    method,
    payload: { args },
  });
  return httpRequest({
    method: 'POST',
    requestPath: `/api/${method}`,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
    cookie,
  });
}

function rpcJson(method, args, cookie) {
  return rpcCall(method, args, cookie).then((res) => {
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      /* non-envelope */
    }
    return { httpStatus: res.status, json, body: res.body };
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

const openFrame = (streamId, endpoint, args) => ({ type: 'open', streamId, endpoint, payload: { args } });

// ---------------------------------------------------------------------------
// mux connection helper (raw WS)
// ---------------------------------------------------------------------------

async function connectMux(scenario, label, cookie) {
  const WebSocket = loadWebSocket();
  const ws = new WebSocket(`ws://${HOST}:${PORT}/api/remote.mux`, { headers: { cookie } });
  const conn = {
    label,
    ws,
    send(frame) {
      ws.send(JSON.stringify(frame));
      rec(scenario, { conn: label, dir: 'c2s', frame });
    },
    hardClose(note = 'hard close (network-drop simulation)') {
      rec(scenario, { conn: label, dir: 'c2s', note });
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    },
    softClose(code = 1000, reason = 'probe done') {
      rec(scenario, { conn: label, dir: 'c2s', note: `soft close ${code} ${reason}` });
      try {
        ws.close(code, reason);
      } catch {
        /* already gone */
      }
    },
  };
  await withTimeout(
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mux socket open timeout (${label})`)), SOCKET_TIMEOUT_MS);
      ws.on('open', () => {
        clearTimeout(timer);
        rec(scenario, { conn: label, dir: 's2c', note: 'socket-open' });
        resolve();
      });
      ws.on('message', (data) => {
        const raw = data.toString();
        let frame = null;
        try {
          frame = JSON.parse(raw);
        } catch {
          /* keep raw */
        }
        rec(scenario, { conn: label, dir: 's2c', raw, frame });
      });
      ws.on('close', (code, reason) => {
        rec(scenario, { conn: label, dir: 's2c', note: 'socket-close', code, reason: String(reason ?? '') });
      });
      ws.on('error', (err) => {
        rec(scenario, { conn: label, dir: 's2c', note: 'socket-error', message: err.message });
      });
    }),
    SOCKET_TIMEOUT_MS + 1000,
    `mux connect (${label})`,
  );
  return conn;
}

// ---------------------------------------------------------------------------
// record-shape helpers (shape only; raw frames stay in the JSONL evidence)
// ---------------------------------------------------------------------------

function snapshotShape(frame) {
  const v = frame?.frame?.value;
  if (v?.type !== 'snapshot') return null;
  const seqs = (v.records || []).map((r) => r.event?.seq).filter((s) => typeof s === 'number');
  return {
    cursor: v.cursor,
    hasMore: v.hasMore,
    recordCount: seqs.length,
    seqMin: seqs.length ? Math.min(...seqs) : null,
    seqMax: seqs.length ? Math.max(...seqs) : null,
    projectionsAsOfSeq: v.projections?.asOfSeq ?? null,
    header: v.header
      ? { version: v.header.version, id: v.header.id, isSeeded: v.header.isSeeded, agentPreset: v.header.agentPreset ?? null }
      : null,
    recordTypes: (v.records || []).map((r) => r.event?.type),
  };
}

function pageShape(res) {
  const v = res?.json?.result?.value;
  if (!v || !Array.isArray(v.records)) return { httpStatus: res?.httpStatus, outcome: res?.json?.result?.ok === false ? 'error' : 'non-envelope', detail: res?.body?.slice(0, 200) };
  const seqs = v.records.map((r) => r.event?.seq).filter((s) => typeof s === 'number');
  return {
    httpStatus: res.httpStatus,
    outcome: 'ok',
    recordCount: seqs.length,
    seqMin: seqs.length ? Math.min(...seqs) : null,
    seqMax: seqs.length ? Math.max(...seqs) : null,
    hasMore: v.hasMore,
    hasCursorField: Object.prototype.hasOwnProperty.call(v, 'cursor'),
    hasProjectionsField: Object.prototype.hasOwnProperty.call(v, 'projections'),
    recordTypes: v.records.map((r) => r.event?.type),
    seqs,
  };
}

// ---------------------------------------------------------------------------
// setup phases (mirrors the Task 6 probe)
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
  measurements.versionGate = { expected: EXPECTED_VERSION, actual: out, pass: ok };
  return ok;
}

async function exchangeCookie(launch) {
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
  measurements.cookie = { exchanged: true, name: cookieHeader.split('=')[0], status: cookieRes.status };
  return cookieHeader;
}

async function selectProbeSession(cookie) {
  const listRes = await rpcJson('session/list', { _request: {} }, cookie);
  const items = listRes?.json?.result?.value?.items || [];
  const blank = items.find((it) => it.blank === true || it.projections?.values?.blank === true);
  if (blank?.sessionId) {
    measurements.session = { sessionId: blank.sessionId, source: 'reused-blank', knownSessions: items.length };
    return blank.sessionId;
  }
  const createRes = await rpcJson('session/create', { request: {} }, cookie);
  const created = createRes?.json?.result?.value;
  if (created?.sessionId) {
    measurements.session = { sessionId: created.sessionId, source: 'created', knownSessions: items.length };
    return created.sessionId;
  }
  const fallback = items[0]?.sessionId;
  if (fallback) {
    measurements.session = { sessionId: fallback, source: 'reused-first', knownSessions: items.length };
    return fallback;
  }
  throw new Error('no probe session available (list empty, create failed)');
}

/**
 * Calibration: prove that session/rename appends events to the followed
 * session log (the only zero-prompt event producer) and capture the event
 * type it emits. Falls back to session/selectModel, then records failure.
 */
async function calibrateEventProducer(cookie, sessionId) {
  const scenario = 'calibration';
  const conn = await connectMux(scenario, 'cal-conn', cookie);
  const followArgs = { request: { address: { kind: 'session', sessionId }, assistantStream: true } };
  conn.send(openFrame('cal-sf', 'session/follow', followArgs));
  const snap0 = await waitFor(
    scenario,
    (e) => e.frame?.streamId === 'cal-sf' && e.frame?.value?.type === 'snapshot',
    FRAME_TIMEOUT_MS,
    'calibration snapshot',
  );
  const shape0 = snapshotShape(snap0);
  conn.softClose();

  const result = { snapshotBefore: shape0, producer: null, eventType: null, renameSeq: null, cursorBefore: shape0?.cursor ?? null };

  // try session/rename first
  const renameTitle = `replay-probe ${RUN_ID}`;
  const renameRes = await rpcJson('session/rename', { request: { sessionId, title: renameTitle } }, cookie);
  result.rename = { httpStatus: renameRes.httpStatus, value: renameRes?.json?.result?.value ?? null };
  const renameSeq = renameRes?.json?.result?.value?.seq;
  result.renameSeq = typeof renameSeq === 'number' ? renameSeq : null;

  if (result.renameSeq != null) {
    // verify via session/page that the seq exists in the log and what it is
    const pageRes = await rpcJson('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: result.renameSeq } }, cookie);
    const p = pageShape(pageRes);
    const rec0 = pageRes?.json?.result?.value?.records?.find((r) => r.event?.seq === result.renameSeq);
    result.pageAfterRename = p;
    result.eventType = rec0?.event?.type ?? null;
    if (result.eventType) {
      result.producer = 'session/rename';
      result.cursorAfter = p.seqMax;
      return result;
    }
  }

  // fallback: session/selectModel
  const modelRes = await rpcJson(
    'session/selectModel',
    { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    cookie,
  );
  result.selectModel = { httpStatus: modelRes.httpStatus, ok: modelRes?.json?.result?.ok === true };
  const modelSeq = modelRes?.json?.result?.value?.seq;
  if (typeof modelSeq === 'number') {
    const pageRes = await rpcJson('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: modelSeq } }, cookie);
    const rec0 = pageRes?.json?.result?.value?.records?.find((r) => r.event?.seq === modelSeq);
    result.eventType = rec0?.event?.type ?? null;
    if (result.eventType) {
      result.producer = 'session/selectModel';
      result.cursorAfter = pageShape(pageRes).seqMax;
      return result;
    }
  }

  result.producer = null;
  result.note = 'neither session/rename nor session/selectModel appended an observable event';
  return result;
}

// ---------------------------------------------------------------------------
// scenario 1 — mid-stream kill + reconnect resubscription
// ---------------------------------------------------------------------------

async function scenario1(cookie, sessionId) {
  const scenario = 'scenario1';
  const followArgs = { request: { address: { kind: 'session', sessionId }, assistantStream: true } };
  const m = { connections: [] };

  // ---- connection A: three streams, then hard drop while in flight --------
  const a = await connectMux(scenario, 'A', cookie);
  const tOpens = now();
  a.send(openFrame('ev1', '$events', {}));
  a.send(openFrame('ws1', 'workspace/follow', {}));
  a.send(openFrame('sf1', 'session/follow', followArgs));
  const readyA = await waitFor(scenario, (e) => e.frame?.streamId === 'ev1' && e.frame?.value?.type === 'ready', FRAME_TIMEOUT_MS, 'A $events ready');
  const baselineA = await waitFor(scenario, (e) => e.frame?.streamId === 'ws1' && e.frame?.value?.type === 'baseline', FRAME_TIMEOUT_MS, 'A workspace baseline');
  const snapshotA = await waitFor(scenario, (e) => e.frame?.streamId === 'sf1' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'A follow snapshot');

  // produce one increment while connected, so an item frame is provably live
  const renameRes = await rpcJson('session/rename', { request: { sessionId, title: `replay-probe ${RUN_ID} s1` } }, cookie);
  const renameSeq = renameRes?.json?.result?.value?.seq ?? null;
  const itemA = await waitFor(
    scenario,
    (e) => e.frame?.streamId === 'sf1' && e.frame?.type === 'item' && e.frame?.value?.type === 'event' && e.frame?.value?.event?.seq === renameSeq,
    2500,
    'A follow increment for rename event',
  ).catch(() => null);

  const shapeA = snapshotShape(snapshotA);
  a.hardClose('hard close while streams in flight (post-snapshot, post-increment)');

  // ---- connection B: immediate reconnect, SAME streamIds -------------------
  const b = await connectMux(scenario, 'B', cookie);
  const tReopen = now();
  b.send(openFrame('ev1', '$events', {}));
  b.send(openFrame('ws1', 'workspace/follow', {}));
  b.send(openFrame('sf1', 'session/follow', followArgs));
  const readyB = await waitFor(scenario, (e) => e.frame?.streamId === 'ev1' && e.frame?.value?.type === 'ready', FRAME_TIMEOUT_MS, 'B $events ready');
  const baselineB = await waitFor(scenario, (e) => e.frame?.streamId === 'ws1' && e.frame?.value?.type === 'baseline', FRAME_TIMEOUT_MS, 'B workspace baseline');
  const snapshotB = await waitFor(scenario, (e) => e.frame?.streamId === 'sf1' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'B follow snapshot');

  // stray frame for a never-opened streamId on the live socket
  b.send({ type: 'item', streamId: 'ghost-never-opened', value: { probe: 'late-unknown-stream' } });
  await sleep(400);
  const strayResponses = (scenarioEvents[scenario] || []).filter(
    (e) => e.dir === 's2c' && e.frame?.streamId === 'ghost-never-opened',
  );
  m.strayUnknownStreamResponses = strayResponses.map((e) => e.frame);

  m.connections.push({
    label: 'A',
    reconnectedAs: 'same streamIds (ev1/ws1/sf1)',
    clientId: readyA.frame.value.clientId,
    baselineItems: baselineA.frame.value?.value?.items?.length ?? null,
    snapshot: shapeA,
    firstFrameOrder: ['ev1 ready', 'ws1 baseline', 'sf1 snapshot'],
    closesWith: 'hard terminate while streams in flight',
  });
  m.connections.push({
    label: 'B',
    reconnectedAs: 'same streamIds (ev1/ws1/sf1) reused after reconnect',
    clientId: readyB.frame.value.clientId,
    baselineItems: baselineB.frame.value?.value?.items?.length ?? null,
    snapshot: snapshotShape(snapshotB),
    firstFrameOrder: ['ev1 ready', 'ws1 baseline', 'sf1 snapshot'],
    strayUnknownStreamFrameSent: true,
    strayUnknownStreamResponseCount: m.strayUnknownStreamResponses.length,
  });
  m.renameSeqWhileConnected = renameSeq;
  m.incrementArrivedWhileConnected = itemA ? { seq: itemA.frame.value.event.seq, type: itemA.frame.value.event.type } : null;
  m.clientIdsDistinct = readyA.frame.value.clientId !== readyB.frame.value.clientId;
  m.cursorAdvancedAfterRename =
    shapeA && snapshotShape(snapshotB) ? (snapshotShape(snapshotB).cursor ?? 0) - (shapeA.cursor ?? 0) : null;
  m.replayFromBeginning =
    snapshotShape(snapshotB) && shapeA
      ? snapshotShape(snapshotB).seqMin === 0 && snapshotShape(snapshotB).recordCount >= shapeA.recordCount
      : null;
  m.sameStreamIdReusedAfterReconnect = !(scenarioEvents[scenario] || []).some(
    (e) => e.conn === 'B' && e.note === 'socket-close',
  );
  m.opensToFirstSnapshotMs = (snapshotB.t_ms ?? 0) - tReopen;

  b.softClose();
  return m;
}

// ---------------------------------------------------------------------------
// scenario 2 — events produced while disconnected + gap coverage
// ---------------------------------------------------------------------------

async function scenario2(cookie, sessionId, producer) {
  const scenario = 'scenario2';
  const followArgs = { request: { address: { kind: 'session', sessionId }, assistantStream: true } };
  const m = { producer };

  // ---- connection A: baseline then hard drop -------------------------------
  const a = await connectMux(scenario, 'A', cookie);
  a.send(openFrame('evA', '$events', {}));
  a.send(openFrame('sfA', 'session/follow', followArgs));
  const readyA = await waitFor(scenario, (e) => e.frame?.streamId === 'evA' && e.frame?.value?.type === 'ready', FRAME_TIMEOUT_MS, 'A $events ready');
  const snapshotA = await waitFor(scenario, (e) => e.frame?.streamId === 'sfA' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'A follow snapshot');
  const shapeA = snapshotShape(snapshotA);
  m.cursorBeforeDisconnect = shapeA?.cursor ?? null;
  m.clientIdBefore = readyA.frame.value.clientId;

  // ---- positive control: does a session/create while CONNECTED emit on $events?
  const controlCreateAt = now();
  const controlCreate = await rpcJson('session/create', { request: {} }, cookie);
  const controlSessionId = controlCreate?.json?.result?.value?.sessionId ?? null;
  await sleep(600);
  const evAItems = (scenarioEvents[scenario] || []).filter(
    (e) => e.frame?.streamId === 'evA' && e.frame?.type === 'item' && e.t_ms > controlCreateAt,
  );
  m.eventsStreamWhileConnectedAfterControlCreate = evAItems.map((e) => e.frame.value?.type ?? null);
  m.controlSessionCreatedWhileConnected = controlSessionId;

  a.hardClose('hard close before producing events while disconnected');
  m.disconnectAtMs = now();

  // ---- events while disconnected ------------------------------------------
  const produced = [];
  const N = 5;
  for (let i = 0; i < N; i += 1) {
    if (producer === 'session/selectModel') {
      const res = await rpcJson('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' } }, cookie);
      produced.push({ i, kind: 'selectModel', httpStatus: res.httpStatus, ok: res?.json?.result?.ok === true });
    } else {
      const res = await rpcJson('session/rename', { request: { sessionId, title: `replay-probe ${RUN_ID} gap#${i}` } }, cookie);
      produced.push({ i, kind: 'rename', httpStatus: res.httpStatus, seq: res?.json?.result?.value?.seq ?? null, ok: res?.json?.result?.ok === true });
    }
    await sleep(120);
  }
  // a session create while disconnected should emit api-session/added on $events
  const createRes = await rpcJson('session/create', { request: {} }, cookie);
  const throwawaySessionId = createRes?.json?.result?.value?.sessionId ?? null;
  m.eventsWhileDisconnected = produced;
  m.throwawaySessionCreatedWhileDisconnected = throwawaySessionId;
  await sleep(200);

  // ---- connection B: reconnect (same streamIds again) ----------------------
  const b = await connectMux(scenario, 'B', cookie);
  a; // connection A is dead
  b.send(openFrame('evB', '$events', {}));
  b.send(openFrame('sfA', 'session/follow', followArgs));
  const readyB = await waitFor(scenario, (e) => e.frame?.streamId === 'evB' && e.frame?.value?.type === 'ready', FRAME_TIMEOUT_MS, 'B $events ready');
  const snapshotB = await waitFor(scenario, (e) => e.frame?.streamId === 'sfA' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'B follow snapshot');
  const shapeB = snapshotShape(snapshotB);

  // what did the fresh $events deliver within a short window? (replay check)
  await sleep(700);
  const eventsFrames = (scenarioEvents[scenario] || []).filter((e) => e.frame?.streamId === 'evB' && e.frame?.type === 'item');
  m.eventsStreamAfterReconnect = eventsFrames.map((e) => e.frame.value?.type ?? null);

  m.cursorAfterReconnect = shapeB?.cursor ?? null;
  m.clientIdAfter = readyB.frame.value.clientId;
  m.clientIdsDistinct = readyA.frame.value.clientId !== readyB.frame.value.clientId;
  m.snapshotB = shapeB;

  // gap coverage: does the snapshot records span the whole [0..cursor] range,
  // and do the produced seqs appear inside the snapshot?
  if (shapeA && shapeB) {
    const producedSeqs = produced.map((p) => p.seq).filter((s) => typeof s === 'number');
    const snapB = snapshotB.frame.value;
    const snapSeqs = new Set((snapB.records || []).map((r) => r.event?.seq));
    m.producedSeqs = producedSeqs;
    m.producedSeqsPresentInSnapshot = producedSeqs.map((s) => ({ seq: s, present: snapSeqs.has(s) }));
    const expectedGap = [];
    for (let s = (shapeA.cursor ?? 0) + 1; s <= (shapeB.cursor ?? 0); s += 1) expectedGap.push(s);
    m.gapSeqs = expectedGap;
    m.gapSeqsMissingFromSnapshot = expectedGap.filter((s) => !snapSeqs.has(s));
    m.snapshotCoversFullLogFromZero = shapeB.seqMin === 0;
    m.snapshotHasMore = shapeB.hasMore;
    m.projectionsAsOfSeqVsCursor = { asOfSeq: shapeB.projectionsAsOfSeq, cursor: shapeB.cursor };
  }

  // page complement: page bounded at the pre-disconnect cursor
  const pageBefore = await rpcJson(
    'session/page',
    { request: { address: { kind: 'session', sessionId }, throughSeq: shapeA?.cursor ?? 0 } },
    cookie,
  );
  m.pageThroughPreDisconnectCursor = pageShape(pageBefore);
  const pageGap = await rpcJson(
    'session/page',
    { request: { address: { kind: 'session', sessionId }, throughSeq: shapeB?.cursor ?? 0, beforeSeq: (shapeA?.cursor ?? 0) + 1 } },
    cookie,
  );
  m.pageGapOnly = pageShape(pageGap);

  b.softClose();
  return m;
}

// ---------------------------------------------------------------------------
// scenario 3 — session/page vs snapshot complementarity + windowed follow
// ---------------------------------------------------------------------------

async function scenario3(cookie, sessionId) {
  const scenario = 'scenario3';
  const m = {};

  // ---- fresh follow first: the page cases need the CURRENT cursor ----------
  const pre = await connectMux(scenario, 'pre', cookie);
  pre.send(openFrame('sfPre', 'session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true } }));
  const snapPre = await waitFor(scenario, (e) => e.frame?.streamId === 'sfPre' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'pre follow snapshot');
  const cursor = snapPre.frame.value.cursor;
  m.cursorUsed = cursor;
  m.preFollowSnapshot = snapshotShape(snapPre);
  m.preFollowClientId = null;
  pre.softClose();

  const address = { kind: 'session', sessionId };
  const mid = Math.max(1, Math.floor(cursor / 2));

  const pageCases = [
    { name: 'page-full-throughSeq-cursor', args: { request: { address, throughSeq: cursor } } },
    { name: 'page-tail-maxMessages-2', args: { request: { address, throughSeq: cursor, maxMessages: 2 } } },
    { name: 'page-tail-maxMessages-1', args: { request: { address, throughSeq: cursor, maxMessages: 1 } } },
    { name: 'page-beforeSeq-mid-maxMessages-3', args: { request: { address, throughSeq: cursor, beforeSeq: mid, maxMessages: 3 } } },
    { name: 'page-beforeSeq-cursor-maxMessages-3', args: { request: { address, throughSeq: cursor, beforeSeq: cursor, maxMessages: 3 } } },
    { name: 'page-throughSeq-0', args: { request: { address, throughSeq: 0 } } },
    { name: 'page-throughSeq-beyond-cursor', args: { request: { address, throughSeq: cursor + 99999 } } },
    { name: 'page-turnWindow-min2-minTurns1', args: { request: { address, throughSeq: cursor, turnWindow: { minMessages: 2, minTurns: 1 } } } },
    { name: 'page-turnWindow-min1-minTurns1', args: { request: { address, throughSeq: cursor, turnWindow: { minMessages: 1, minTurns: 1 } } } },
    { name: 'page-maxMessages-1000', args: { request: { address, throughSeq: cursor, maxMessages: 1000 } } },
  ];
  m.pageCases = [];
  for (const c of pageCases) {
    const res = await rpcJson('session/page', c.args, cookie);
    m.pageCases.push({ name: c.name, ...pageShape(res) });
  }

  // windowed follows on fresh connections
  const conn = await connectMux(scenario, 'window', cookie);
  conn.send(openFrame('sfW', 'session/follow', { request: { address, assistantStream: true, maxMessages: 3 } }));
  const snapW = await waitFor(scenario, (e) => e.frame?.streamId === 'sfW' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'windowed follow snapshot (maxMessages)');
  m.followMaxMessages3 = snapshotShape(snapW);

  conn.send(openFrame('sfW1', 'session/follow', { request: { address, assistantStream: true, maxMessages: 1 } }));
  const snapW1 = await waitFor(scenario, (e) => e.frame?.streamId === 'sfW1' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'windowed follow snapshot (maxMessages 1)');
  m.followMaxMessages1 = snapshotShape(snapW1);

  conn.send(
    openFrame('sfT', 'session/follow', {
      request: { address, assistantStream: true, turnWindow: { minMessages: 2, minTurns: 1 } },
    }),
  );
  const snapT = await waitFor(scenario, (e) => e.frame?.streamId === 'sfT' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'windowed follow snapshot (turnWindow)');
  m.followTurnWindow = snapshotShape(snapT);

  // does a windowed follow still stream live increments after the snapshot?
  const renameRes = await rpcJson('session/rename', { request: { sessionId, title: `replay-probe ${RUN_ID} s3` } }, cookie);
  const renameSeq = renameRes?.json?.result?.value?.seq ?? null;
  const liveItem = await waitFor(
    scenario,
    (e) => e.frame?.streamId === 'sfW' && e.frame?.type === 'item' && e.frame?.value?.type === 'event' && e.frame?.value?.event?.seq === renameSeq,
    2500,
    'windowed follow live increment',
  ).catch(() => null);
  m.windowedFollowLiveIncrement = liveItem ? { streamId: 'sfW', seq: renameSeq } : null;

  conn.softClose();
  return m;
}

// ---------------------------------------------------------------------------
// late-frame / protocol-violation probes
// ---------------------------------------------------------------------------

async function lateFrames(cookie, sessionId, producer) {
  const scenario = 'late-frames';
  const m = {};
  const followArgs = { request: { address: { kind: 'session', sessionId }, assistantStream: true } };

  const conn = await connectMux(scenario, 'lf-conn', cookie);
  conn.send(openFrame('lf1', 'session/follow', followArgs));
  const snap1 = await waitFor(scenario, (e) => e.frame?.streamId === 'lf1' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'lf1 snapshot');
  const snap1Idx = timeline.indexOf(snap1);

  // uplink end, then a stray item, then a rename (does the downlink survive?)
  conn.send({ type: 'end', streamId: 'lf1' });
  await sleep(400);
  m.framesAfterUplinkEnd_beforeStray = (scenarioEvents[scenario] || []).filter(
    (e) => e.dir === 's2c' && e.frame?.streamId === 'lf1' && timeline.indexOf(e) > snap1Idx,
  ).length;

  if (producer === 'session/selectModel') {
    await rpcJson('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' } }, cookie);
  } else {
    await rpcJson('session/rename', { request: { sessionId, title: `replay-probe ${RUN_ID} lf` } }, cookie);
  }
  await sleep(500);
  const afterRename = (scenarioEvents[scenario] || []).filter((e) => e.dir === 's2c' && e.frame?.streamId === 'lf1' && timeline.indexOf(e) > snap1Idx);
  m.framesAfterUplinkEnd_afterRename = afterRename.length;
  m.framesAfterUplinkEnd_kinds = afterRename.map((e) => `${e.frame.type}:${e.frame.value?.type ?? e.frame.value?.event?.type ?? ''}`);

  conn.send({ type: 'item', streamId: 'lf1', value: { probe: 'stray-after-end' } });
  const errFrame = await waitFor(
    scenario,
    (e) => e.dir === 's2c' && e.frame?.streamId === 'lf1' && e.frame?.type === 'error',
    2000,
    'error frame after stray post-end item',
  ).catch(() => null);
  m.strayAfterUplinkEnd = errFrame
    ? { response: 'error frame', code: errFrame.frame.error?.code, message: errFrame.frame.error?.message }
    : { response: 'silence' };

  // does the downlink keep streaming after the host failed the stream?
  if (producer === 'session/selectModel') {
    await rpcJson('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-v4-pro' } }, cookie);
  } else {
    await rpcJson('session/rename', { request: { sessionId, title: `replay-probe ${RUN_ID} lf2` } }, cookie);
  }
  await sleep(500);
  const afterStreamError = (scenarioEvents[scenario] || []).filter(
    (e) => e.dir === 's2c' && e.frame?.streamId === 'lf1' && timeline.indexOf(e) > timeline.indexOf(errFrame ?? snap1),
  );
  m.framesOnLf1AfterStreamError = afterStreamError.map((e) => `${e.frame.type}:${e.frame.value?.type ?? e.frame.value?.event?.type ?? e.frame.error?.code ?? ''}`);

  // cancel then stray
  conn.send(openFrame('lf2', 'session/follow', followArgs));
  const snap2 = await waitFor(scenario, (e) => e.frame?.streamId === 'lf2' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'lf2 snapshot');
  const snap2Idx = timeline.indexOf(snap2);
  conn.send({ type: 'cancel', streamId: 'lf2' });
  await sleep(300);
  conn.send({ type: 'item', streamId: 'lf2', value: { probe: 'stray-after-cancel' } });
  await sleep(400);
  m.framesAfterCancel = (scenarioEvents[scenario] || []).filter((e) => e.dir === 's2c' && e.frame?.streamId === 'lf2' && timeline.indexOf(e) > snap2Idx).length;
  m.strayAfterCancel = { response: m.framesAfterCancel === 0 ? 'silence' : `${m.framesAfterCancel} frames` };
  m.socketStillOpenAfterLateFrames = conn.ws.readyState === 1;
  conn.softClose();

  // duplicate open of the same streamId on one socket (dedicated connection)
  const dup = await connectMux(scenario, 'lf-dup', cookie);
  dup.send(openFrame('dup1', 'session/follow', followArgs));
  await waitFor(scenario, (e) => e.frame?.streamId === 'dup1' && e.frame?.value?.type === 'snapshot', FRAME_TIMEOUT_MS, 'dup1 snapshot');
  dup.send(openFrame('dup1', 'session/follow', followArgs));
  const closed = await waitFor(
    scenario,
    (e) => e.conn === 'lf-dup' && e.note === 'socket-close',
    3000,
    'socket close after duplicate open',
  ).catch(() => null);
  m.duplicateOpenSameStreamId = closed
    ? { socketClosed: true, code: closed.code, reason: closed.reason }
    : { socketClosed: false, note: 'no close within 3s' };

  // binary frame (docs §6.1 claims close 1003) — live measure
  const bin = await connectMux(scenario, 'lf-bin', cookie);
  bin.ws.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
  rec(scenario, { conn: 'lf-bin', dir: 'c2s', note: 'binary frame sent (0x00010203)' });
  const binClosed = await waitFor(scenario, (e) => e.conn === 'lf-bin' && e.note === 'socket-close', 3000, 'socket close after binary frame').catch(() => null);
  m.binaryFrame = binClosed ? { socketClosed: true, code: binClosed.code, reason: binClosed.reason } : { socketClosed: false };

  // invalid JSON frame (docs §6.1 claims close 1008) — live measure
  const bad = await connectMux(scenario, 'lf-bad', cookie);
  bad.ws.send('this is not json');
  rec(scenario, { conn: 'lf-bad', dir: 'c2s', note: 'invalid JSON text sent' });
  const badClosed = await waitFor(scenario, (e) => e.conn === 'lf-bad' && e.note === 'socket-close', 3000, 'socket close after invalid json').catch(() => null);
  m.invalidJsonFrame = badClosed ? { socketClosed: true, code: badClosed.code, reason: badClosed.reason } : { socketClosed: false };

  return m;
}

// ---------------------------------------------------------------------------
// evidence writers
// ---------------------------------------------------------------------------

function writeJsonl(file, scenario) {
  const lines = (scenarioEvents[scenario] || []).map((e) => JSON.stringify(e));
  fs.writeFileSync(path.join(EVIDENCE_DIR, file), lines.length ? `${lines.join('\n')}\n` : '');
}

function writeMeasurements() {
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'replay-boundary-measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'frame-timeline-all.jsonl'), `${timeline.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

function writeSummary() {
  const s1 = measurements.scenario1 || {};
  const s2 = measurements.scenario2 || {};
  const s3 = measurements.scenario3 || {};
  const lf = measurements.lateFrames || {};
  const lines = [];
  lines.push('# Replay boundary probe — raw measurements (Task 7)');
  lines.push('');
  lines.push(`- run: ${RUN_ID} · captured: ${CAPTURED_AT}`);
  lines.push(`- dsh version: ${measurements.versionGate?.actual} (gate ${measurements.versionGate?.pass ? 'PASS' : 'FAIL'})`);
  lines.push(`- probe session: ${measurements.session?.sessionId} (${measurements.session?.source})`);
  lines.push(`- event producer calibrated: ${measurements.calibration?.producer ?? 'n/a'} (event type: ${measurements.calibration?.eventType ?? 'n/a'})`);
  lines.push('- credential path: DEEPSEEK_API_KEY ABSENT — zero prompts sent, zero credentials touched');
  lines.push('');

  lines.push('## Scenario 1 — mid-stream kill + reconnect');
  lines.push('');
  lines.push('| measurement | value |');
  lines.push('|---|---|');
  lines.push(`| clientId conn A | \`${s1.connections?.[0]?.clientId}\` |`);
  lines.push(`| clientId conn B (after reconnect) | \`${s1.connections?.[1]?.clientId}\` |`);
  lines.push(`| clientIds distinct across reconnect | ${s1.clientIdsDistinct} |`);
  lines.push(`| snapshot A (cursor / records / seqMin..seqMax / hasMore) | ${JSON.stringify(s1.connections?.[0]?.snapshot && { cursor: s1.connections[0].snapshot.cursor, records: s1.connections[0].snapshot.recordCount, seqMin: s1.connections[0].snapshot.seqMin, seqMax: s1.connections[0].snapshot.seqMax, hasMore: s1.connections[0].snapshot.hasMore })} |`);
  lines.push(`| snapshot B (cursor / records / seqMin..seqMax / hasMore) | ${JSON.stringify(s1.connections?.[1]?.snapshot && { cursor: s1.connections[1].snapshot.cursor, records: s1.connections[1].snapshot.recordCount, seqMin: s1.connections[1].snapshot.seqMin, seqMax: s1.connections[1].snapshot.seqMax, hasMore: s1.connections[1].snapshot.hasMore })} |`);
  lines.push(`| re-follow replays from seq 0 with >= pre-kill record count | ${s1.replayFromBeginning} |`);
  lines.push(`| same streamIds reused on new connection accepted | ${s1.sameStreamIdReusedAfterReconnect} |`);
  lines.push(`| stray frame for unknown streamId answered | ${s1.strayUnknownStreamResponses ? s1.strayUnknownStreamResponses.length : 0} frames ${JSON.stringify(s1.strayUnknownStreamResponses || [])} |`);
  lines.push(`| increment frame observed while connected | ${JSON.stringify(s1.incrementArrivedWhileConnected)} |`);
  lines.push(`| opens→first snapshot latency (conn B) | ${s1.opensToFirstSnapshotMs} ms |`);
  lines.push('');

  lines.push('## Scenario 2 — events while disconnected + gap coverage');
  lines.push('');
  lines.push('| measurement | value |');
  lines.push('|---|---|');
  lines.push(`| cursor before disconnect | ${s2.cursorBeforeDisconnect} |`);
  lines.push(`| cursor after reconnect | ${s2.cursorAfterReconnect} |`);
  lines.push(`| produced seqs while disconnected | ${JSON.stringify(s2.producedSeqs)} |`);
  lines.push(`| produced seqs present in reconnect snapshot | ${JSON.stringify(s2.producedSeqsPresentInSnapshot)} |`);
  lines.push(`| gap seqs missing from snapshot | ${JSON.stringify(s2.gapSeqsMissingFromSnapshot)} |`);
  lines.push(`| snapshot covers full log from seq 0 | ${s2.snapshotCoversFullLogFromZero} |`);
  lines.push(`| snapshot hasMore | ${s2.snapshotHasMore} |`);
  lines.push(`| projections.asOfSeq vs cursor | ${JSON.stringify(s2.projectionsAsOfSeqVsCursor)} |`);
  lines.push(`| \$events frames after control create (while connected) | ${JSON.stringify(s2.eventsStreamWhileConnectedAfterControlCreate)} |`);
  lines.push(`| \$events frames delivered after reconnect | ${JSON.stringify(s2.eventsStreamAfterReconnect)} |`);
  lines.push(`| \$events clientIds distinct | ${s2.clientIdsDistinct} |`);
  lines.push(`| page {throughSeq: pre-disconnect cursor} | ${JSON.stringify(s2.pageThroughPreDisconnectCursor && { records: s2.pageThroughPreDisconnectCursor.recordCount, seqMin: s2.pageThroughPreDisconnectCursor.seqMin, seqMax: s2.pageThroughPreDisconnectCursor.seqMax, hasMore: s2.pageThroughPreDisconnectCursor.hasMore })} |`);
  lines.push(`| page {beforeSeq: cursor+1} (gap only) | ${JSON.stringify(s2.pageGapOnly && { records: s2.pageGapOnly.recordCount, seqMin: s2.pageGapOnly.seqMin, seqMax: s2.pageGapOnly.seqMax, hasMore: s2.pageGapOnly.hasMore })} |`);
  lines.push('');

  lines.push('## Scenario 3 — session/page vs snapshot');
  lines.push('');
  lines.push(`- page cases run against live cursor: ${s3.cursorUsed}`);
  lines.push('');
  lines.push('| case | records | seqMin | seqMax | hasMore | has cursor field | has projections field |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const c of s3.pageCases || []) {
    lines.push(`| ${c.name} | ${c.recordCount ?? '-'} | ${c.seqMin ?? '-'} | ${c.seqMax ?? '-'} | ${c.hasMore ?? '-'} | ${c.hasCursorField ?? '-'} | ${c.hasProjectionsField ?? '-'} |`);
  }
  lines.push('');
  lines.push('| windowed follow | records | seqMin | seqMax | cursor | hasMore |');
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| follow {maxMessages:3} | ${s3.followMaxMessages3?.recordCount} | ${s3.followMaxMessages3?.seqMin} | ${s3.followMaxMessages3?.seqMax} | ${s3.followMaxMessages3?.cursor} | ${s3.followMaxMessages3?.hasMore} |`);
  lines.push(`| follow {maxMessages:1} | ${s3.followMaxMessages1?.recordCount} | ${s3.followMaxMessages1?.seqMin} | ${s3.followMaxMessages1?.seqMax} | ${s3.followMaxMessages1?.cursor} | ${s3.followMaxMessages1?.hasMore} |`);
  lines.push(`| follow {turnWindow:{minMessages:2,minTurns:1}} | ${s3.followTurnWindow?.recordCount} | ${s3.followTurnWindow?.seqMin} | ${s3.followTurnWindow?.seqMax} | ${s3.followTurnWindow?.cursor} | ${s3.followTurnWindow?.hasMore} |`);
  lines.push(`| windowed follow live increment | ${JSON.stringify(s3.windowedFollowLiveIncrement)} |`);
  lines.push('');

  lines.push('## Late-frame / protocol violations');
  lines.push('');
  lines.push('| measurement | value |');
  lines.push('|---|---|');
  lines.push(`| frames on lf1 after uplink end (before stray) | ${lf.framesAfterUplinkEnd_beforeStray} |`);
  lines.push(`| frames on lf1 after uplink end + rename | ${lf.framesAfterUplinkEnd_afterRename} ${JSON.stringify(lf.framesAfterUplinkEnd_kinds || [])} |`);
  lines.push(`| stray item after uplink end | ${JSON.stringify(lf.strayAfterUplinkEnd)} |`);
  lines.push(`| frames on lf1 after host stream-error | ${JSON.stringify(lf.framesOnLf1AfterStreamError)} |`);
  lines.push(`| frames on lf2 after cancel + stray | ${lf.framesAfterCancel} ${JSON.stringify(lf.strayAfterCancel)} |`);
  lines.push(`| socket alive after late frames | ${lf.socketStillOpenAfterLateFrames} |`);
  lines.push(`| duplicate open same streamId | ${JSON.stringify(lf.duplicateOpenSameStreamId)} |`);
  lines.push(`| binary frame | ${JSON.stringify(lf.binaryFrame)} |`);
  lines.push(`| invalid JSON frame | ${JSON.stringify(lf.invalidJsonFrame)} |`);
  lines.push('');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'measurements-summary.md'), lines.join('\n'));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function writeCleanupReceipt(pid, terminated) {
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'cleanup-receipt.txt'),
    [
      '# spawned dsh web process cleanup (Task 7 probe)',
      '',
      `pid: ${pid}`,
      'signal: SIGTERM then SIGKILL if still alive',
      `terminated: ${terminated}`,
      `checkedAt: ${new Date().toISOString()}`,
      '',
    ].join('\n'),
  );
}

async function main() {
  ensureDir(EVIDENCE_DIR);
  log(`evidence dir: ${EVIDENCE_DIR}`);
  log('version gate...');
  if (!versionGate()) {
    console.error(`[probe] FATAL: dsh version ${measurements.versionGate.actual} != ${EXPECTED_VERSION}`);
    writeMeasurements();
    return 1;
  }
  log(`version gate PASS (${EXPECTED_VERSION})`);

  if (await portInUse(PORT)) {
    console.error(
      `[probe] FATAL: port ${PORT} is already in use. Refusing to kill a foreign process. ` +
        `Stop the process on ${HOST}:${PORT} and re-run.`,
    );
    writeMeasurements();
    return 1;
  }

  const child = spawn('dsh', ['web', '--no-open', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pid = child.pid;
  let serverLog = '';
  try {
    // ---- parse launch line --------------------------------------------------
    let buf = '';
    const launch = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup line timeout')), STARTUP_TIMEOUT_MS);
      const onData = (d) => {
        buf += d.toString();
        serverLog += d.toString();
        const m = buf.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve({ port: Number(m[1]), token: m[2] });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (d) => {
        serverLog += d.toString();
      });
      child.on('exit', (code) => reject(new Error(`dsh exited early (code ${code})`)));
    });
    if (launch.port !== PORT) throw new Error(`launch port ${launch.port} != requested ${PORT}`);
    measurements.launch = { port: launch.port, tokenLength: launch.token.length };
    log(`spawned dsh web pid=${pid} port=${launch.port}`);

    // ---- token -> cookie exchange -------------------------------------------
    const cookie = await exchangeCookie(launch);
    log(`cookie exchanged (${measurements.cookie.name}) status=${measurements.cookie.status}`);

    // ---- probe session ------------------------------------------------------
    const sessionId = await selectProbeSession(cookie);
    log(`probe session: ${sessionId} (${measurements.session.source})`);

    // ---- calibration ---------------------------------------------------------
    log('calibrating event producer...');
    measurements.calibration = await calibrateEventProducer(cookie, sessionId);
    log(`event producer: ${measurements.calibration.producer} (event ${measurements.calibration.eventType})`);
    if (!measurements.calibration.producer) {
      // Not fatal: scenarios can still measure reconnect mechanics, but event
      // coverage is degraded. Record and continue.
      measurements.errors.push('no event producer calibrated; event-coverage measurements degraded');
      console.error('[probe] WARNING: no event producer calibrated; continuing with degraded coverage');
    }

    // ---- scenarios -----------------------------------------------------------
    log('scenario 1: mid-stream kill + reconnect...');
    measurements.scenario1 = await withTimeout(scenario1(cookie, sessionId), 30000, 'scenario 1');

    log('scenario 2: events while disconnected + gap coverage...');
    measurements.scenario2 = await withTimeout(
      scenario2(cookie, sessionId, measurements.calibration.producer),
      30000,
      'scenario 2',
    );

    log('scenario 3: session/page vs snapshot...');
    measurements.scenario3 = await withTimeout(scenario3(cookie, sessionId), 30000, 'scenario 3');

    log('late-frame probes...');
    measurements.lateFrames = await withTimeout(
      lateFrames(cookie, sessionId, measurements.calibration.producer),
      30000,
      'late frames',
    );

    writeMeasurements();
    writeJsonl('scenario-1-reconnect.jsonl', 'scenario1');
    writeJsonl('scenario-2-gap-replay.jsonl', 'scenario2');
    writeJsonl('scenario-3-page-boundary.jsonl', 'scenario3');
    writeJsonl('late-frame-probes.jsonl', 'late-frames');
    writeJsonl('calibration.jsonl', 'calibration');
    writeSummary();
    log('evidence written');
    return measurements.errors.length > 0 ? 1 : 0;
  } catch (err) {
    measurements.errors.push(err.stack || String(err));
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'probe-error.txt'), `${err.stack || err.message}\n`);
    console.error(`[probe] ERROR: ${err.message}`);
    try {
      writeMeasurements();
      writeJsonl('scenario-1-reconnect.jsonl', 'scenario1');
      writeJsonl('scenario-2-gap-replay.jsonl', 'scenario2');
      writeJsonl('scenario-3-page-boundary.jsonl', 'scenario3');
      writeJsonl('late-frame-probes.jsonl', 'late-frames');
      writeJsonl('calibration.jsonl', 'calibration');
      writeSummary();
    } catch {
      /* best effort */
    }
    return 1;
  } finally {
    // ---- cleanup: always terminate the spawned process -----------------------
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
    measurements.cleanup = { pid, terminated };
    writeCleanupReceipt(pid, terminated);
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'dsh-web.stdout.log'), serverLog || '');
    log(`cleanup: pid ${pid} terminated=${terminated}`);
  }
}

const code = await main();
process.exit(code);
