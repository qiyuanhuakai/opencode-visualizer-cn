#!/usr/bin/env node
// Packaged-artifact QA driver for task 45 (完成SEA、安装器与Electron真实产物验证).
//
// allow: SIZE_OK — self-contained cross-platform packaging harness: real SEA
// build, real installer packaging, real install/update/uninstall legs against
// the packaged bytes, the Electron preview package closure check and the
// node-pty dual-runtime driver, with no shared-module seams. Repo precedent:
// scripts/qa/node-pty-dual-runtime.mjs (646 lines) and
// scripts/qa/runtime-v090-cases/task-42.mjs (122KB) are larger.
//
// Proves, with observed values, the task's acceptance criteria:
//   1. install-dir source moved away + PATH without node still starts the store
//      worker (through the staged Node 24 sidecar) and the PTY, writes the DB,
//      restarts and imports (read-back/replay);
//   2. install + update into a path containing spaces;
//   3. uninstall PRESERVES the data (before/after bytes + record counts);
//   4. every Electron main-process local module closure member is present in
//      the built package (the desktopUpdateMetadata receiver guard, artifact
//      side);
//   5. the node-pty dual runtime survives packaging (pnpm qa:pty, plus a
//      targeted run against the installed artifact);
//   6. the standalone Electron Bridge is NOT silently embedded (no SEA binary,
//      no Node sidecar, no node-pty prebuild inside the Electron package).
//
// Usage:
//   node scripts/qa/runtime-v090-packaged.mjs --case happy   --out-dir <dir>
//   node scripts/qa/runtime-v090-packaged.mjs --case failure --out-dir <dir>
//
// Every leg records its real exit code and observed values; a leg that merely
// lists a command is not evidence. The happy case exits 0 only when every leg
// passes; the failure case exits 0 only when every injection fails non-zero at
// its real surface (process exit, or HTTP status for the lazily-created
// runtime host) with a correctly-located diagnosis and no repository-source
// fallback.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const IS_WINDOWS = process.platform === 'win32';
const NO_NODE_PATH = '/usr/bin:/bin';
const SIDECAR_RELATIVE = ['usr', 'lib', 'vis_bridge', 'bridge', 'runtime', 'runtime'];
const SIDECAR_NAME = IS_WINDOWS ? 'vis_bridge_node.exe' : 'vis_bridge_node';
const WORKER_NAME = 'runtimeDatabaseWorker.mjs';
const BRIDGE_CONFIG = JSON.stringify({
  version: 1,
  nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false },
  acpAgents: [],
});
const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const SENTINEL_MARKER = 'VIS_PTY_OK_42';
const STTY_EXPECTED = '40 100';
// Worktrees share node_modules through a symlink into the main checkout, which
// pnpm's verify-deps-before-run guard refuses; the flag skips only that guard.
const PNPM = ['--config.verify-deps-before-run=false'];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--skip-build' || key === '--skip-electron') {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!['--case', '--out-dir'].includes(key)) throw new Error(`unknown argument ${key}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
    values[key] = value;
    index += 1;
  }
  if (!['happy', 'failure'].includes(values['--case'])) throw new Error('unknown case');
  if (!values['--out-dir']) throw new Error('--out-dir required');
  return {
    scenario: values['--case'],
    outDir: path.resolve(values['--out-dir']),
    skipBuild: values['--skip-build'] === true,
    skipElectron: values['--skip-electron'] === true,
  };
}

// Runs a command with argv (never a shell), collecting stdout/stderr and the
// real exit status. A spawn-level failure (ENOENT/ENOEXEC) resolves with
// status null and the error text so callers can assert on it.
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ status: null, signal: 'SIGKILL', stdout, stderr: stderr + '\n[timeout]' });
      }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), spawnError: error });
    });
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

async function runOrThrow(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`);
  }
  return result;
}

async function readDaemonLog(staging) {
  try {
    return await readFile(path.join(staging.stateDir, 'daemon.log'), 'utf8');
  } catch {
    return '';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function psRows() {
  if (IS_WINDOWS) return [];
  return execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function descendants(rows, rootPid) {
  const pids = [rootPid];
  const byParent = new Map();
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const parent = Number(parts[1]);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(Number(parts[0]));
  }
  for (let index = 0; index < pids.length; index += 1) {
    for (const child of byParent.get(pids[index]) ?? []) if (!pids.includes(child)) pids.push(child);
  }
  return pids;
}

function killProcessTree(rootPid) {
  if (!rootPid || IS_WINDOWS) return;
  for (const pid of descendants(psRows(), rootPid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// Finds a process whose executable is exactly `executablePath` (realpath) and
// whose parent is `parentPid` — the store worker forked through the sidecar.
async function findSidecarWorker(parentPid, executablePath) {
  let expected;
  try {
    expected = await realpath(executablePath);
  } catch {
    return null;
  }
  for (const entry of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const exe = await realpath(`/proc/${entry}/exe`);
      if (exe !== expected) continue;
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(stat.split(') ')[1].split(' ')[1]);
      if (parentPid !== undefined && parent !== parentPid) continue;
      return { pid, exe, parent };
    } catch {}
  }
  return null;
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

// SQLite readers can race a live worker's write transaction (the daemon keeps
// its store open); retry the read instead of failing the leg.
async function withBusyRetry(operation, label, attempts = 20) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!/locked|SQLITE_BUSY|busy/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await sleep(250);
    }
  }
  throw new Error(`${label} kept reporting a locked database: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function databaseStats(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const rows = {};
    for (const table of tables) rows[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    const meta = db.prepare('SELECT environment, owner, epoch, fence, revision, seq, floor FROM runtime_meta').all();
    return { bytes: 0, tables: rows, meta };
  } finally {
    db.close();
  }
}

function readEntity(dbPath, collection, key) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT environment, key, revision, value FROM ${collection} WHERE key = ?`).get(key) ?? null;
  } finally {
    db.close();
  }
}

async function databaseStatsSafe(dbPath) {
  return withBusyRetry(() => databaseStats(dbPath), `databaseStats(${dbPath})`);
}

async function readEntitySafe(dbPath, collection, key) {
  return withBusyRetry(() => readEntity(dbPath, collection, key), `readEntity(${collection}/${key})`);
}

// A stopped daemon's store worker can outlive the daemon.json removal by a
// moment; the in-process store leg must not race it for the fence.
async function waitNoSidecarWorker(sidecarPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await findSidecarWorker(undefined, sidecarPath)) === null) return true;
    await sleep(200);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evidence recorder
// ---------------------------------------------------------------------------
class Recorder {
  constructor(scenario, outDir) {
    this.scenario = scenario;
    this.outDir = outDir;
    this.scenarios = [];
    this.artifacts = [];
    this.current = null;
  }
  start(name) {
    this.current = { name, assertions: [] };
    this.scenarios.push(this.current);
    console.log(`[qa] ${name}`);
  }
  check(name, expected, observed) {
    const ok = JSON.stringify(expected) === JSON.stringify(observed);
    this.current.assertions.push({ name, expected, observed, ok });
    if (!ok) {
      throw new Error(`${this.current.name} / ${name}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
    }
  }
  observe(name, value) {
    this.current.assertions.push({ name, observed: value });
  }
  async artifact(filePath, label) {
    const bytes = await stat(filePath).then((entry) => entry.size).catch(() => null);
    const digest = bytes === null ? null : await sha256File(filePath);
    this.artifacts.push({ label, path: filePath, bytes, sha256: digest });
    return { bytes, sha256: digest };
  }
  manifest(extra = {}) {
    return {
      schemaVersion: 1,
      scenario: this.scenario,
      status: 'recorded',
      generatedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version, release: os.release() },
      scenarios: this.scenarios,
      assertionCount: this.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0),
      artifacts: this.artifacts,
      ...extra,
    };
  }
}

// ---------------------------------------------------------------------------
// Staging: an install root that contains ONLY packaged bytes (never repository
// source) and whose path contains spaces (the spaces leg).
// ---------------------------------------------------------------------------
async function createStaging(label) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vis packaged qa '));
  const staging = {
    base,
    root: path.join(base, `install dir ${label}`),
    stateDir: path.join(base, 'state'),
    homeDir: path.join(base, 'home'),
    sourceDir: path.join(base, 'source'),
  };
  await mkdir(staging.root, { recursive: true });
  await mkdir(staging.stateDir, { recursive: true });
  await mkdir(staging.homeDir, { recursive: true });
  await writeFile(path.join(staging.stateDir, 'bridge.json'), BRIDGE_CONFIG, 'utf8');
  return staging;
}

function stagingInstallPaths(staging) {
  return {
    binary: path.join(staging.root, 'usr', 'bin', IS_WINDOWS ? 'vis_bridge.exe' : 'vis_bridge'),
    installRoot: path.join(staging.root, 'usr', 'lib', 'vis_bridge', 'bridge', 'runtime'),
    sidecar: path.join(staging.root, ...SIDECAR_RELATIVE, SIDECAR_NAME),
    worker: path.join(staging.root, ...SIDECAR_RELATIVE, WORKER_NAME),
    nodePty: path.join(staging.root, 'usr', 'lib', 'vis_bridge', 'node_modules', 'node-pty'),
    stateDatabase: path.join(staging.stateDir, 'runtime', 'runtime.db'),
  };
}

// The no-node environment: PATH deliberately excludes every directory that
// holds a Node interpreter (node lives in the nvm prefix on this host), so the
// installed artifact can only run through its staged sidecar.
function noNodeEnvironment(staging) {
  return {
    PATH: NO_NODE_PATH,
    HOME: staging.homeDir,
    VIS_BRIDGE_STATE_DIR: staging.stateDir,
    ...(IS_WINDOWS ? {} : { SHELL: '/usr/bin/bash' }),
  };
}

async function assertNoNodeOnPath(recorder, name) {
  let probe;
  try {
    probe = await run('node', ['--version'], { env: { PATH: NO_NODE_PATH }, timeoutMs: 15000 });
  } catch {
    probe = { status: null };
  }
  const systemNode = ['/usr/bin/node', '/bin/node'].filter((candidate) => existsSync(candidate));
  recorder.check(`${name}: node is NOT resolvable on PATH ${NO_NODE_PATH}`, true, probe.status !== 0);
  recorder.check(`${name}: no system node in /usr/bin or /bin`, [], systemNode);
  recorder.observe(`${name}: node probe status on the restricted PATH`, probe.status);
}

// A stale daemon state file from a previous (failed) leg would otherwise be
// read by the next start; the injection must be isolated from it.
async function resetDaemonState(staging) {
  await rm(path.join(staging.stateDir, 'daemon.json'), { force: true });
  await rm(path.join(staging.stateDir, 'control.lock'), { force: true });
}

// Makes the whole install tree unwritable. Directory bits alone are not
// enough: dpkg-deb replaces already-extracted FILES, which only needs the
// files themselves to be writable, so every entry loses its write bits.
async function makeReadOnlyTree(directory) {
  const walk = async (current) => {
    await chmod(current, 0o555);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else await chmod(child, 0o444);
    }
  };
  await walk(directory);
}

async function restoreWritableTree(directory) {
  const walk = async (current) => {
    await chmod(current, 0o755);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else await chmod(child, 0o644);
    }
  };
  await walk(directory);
}

// ---------------------------------------------------------------------------
// Packaged artifact production (the plan's happy commands, actually launched)
// ---------------------------------------------------------------------------
async function produceSeaBuild(recorder) {
  recorder.start('H1 pnpm bridge:build produces the SEA binary + staged sidecar');
  const result = await run('pnpm', [...PNPM, 'bridge:build'], { timeoutMs: 300000 });
  recorder.check('H1: pnpm bridge:build exit code', 0, result.status);
  const binary = path.join(ROOT, 'dist-bridge', IS_WINDOWS ? 'vis_bridge.exe' : 'vis_bridge');
  const sidecar = path.join(ROOT, 'dist-bridge', 'bridge', 'runtime', 'runtime', SIDECAR_NAME);
  const worker = path.join(ROOT, 'dist-bridge', 'bridge', 'runtime', 'runtime', WORKER_NAME);
  recorder.check('H1: SEA binary exists', true, existsSync(binary));
  recorder.check('H1: staged store worker exists', true, existsSync(worker));
  recorder.check('H1: staged Node 24 sidecar exists', true, existsSync(sidecar));
  recorder.check('H1: staged node-pty exists', true, existsSync(path.join(ROOT, 'dist-bridge', 'node_modules', 'node-pty', 'lib', 'index.js')));
  const sidecarVersion = await run(sidecar, ['--version'], { timeoutMs: 30000 });
  recorder.check('H1: sidecar is a working interpreter (exit 0)', 0, sidecarVersion.status);
  recorder.check('H1: sidecar reports a Node 24 runtime', true, sidecarVersion.stdout.trim().startsWith('v24.'));
  recorder.observe('H1: sidecar version', sidecarVersion.stdout.trim());
  const binaryBytes = await recorder.artifact(binary, 'sea-binary');
  const sidecarBytes = await recorder.artifact(sidecar, 'sea-sidecar');
  recorder.observe('H1: sea binary bytes', binaryBytes.bytes);
  recorder.observe('H1: sidecar bytes', sidecarBytes.bytes);
  const blob = await readFile(path.join(ROOT, 'dist-bridge', 'vis_bridge.blob'));
  recorder.check('H1: SEA blob injected (minified bridge bundle, >100KB)', true, blob.length > 100000);
  recorder.observe('H1: sea blob bytes', blob.length);
  return { binary, sidecar };
}

async function produceDeb(version) {
  const { packageVisBridgeInstaller } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'package-vis-bridge-installer.mjs')).href
  );
  return packageVisBridgeInstaller(ROOT, { version, platform: 'linux', arch: 'x64', format: 'deb' });
}

async function produceInstaller(recorder) {
  recorder.start('H2 pnpm bridge:package-installer produces the deb with the sidecar');
  const result = await run('pnpm', [...PNPM, 'bridge:package-installer'], { timeoutMs: 600000 });
  recorder.check('H2: pnpm bridge:package-installer exit code', 0, result.status);
  const packageVersion = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  const installerPath = path.join(ROOT, 'dist-bridge', 'installers', `VisBridge-${packageVersion}-x64-Linux.deb`);
  recorder.check('H2: deb artifact exists', true, existsSync(installerPath));
  const listing = await runOrThrow('dpkg-deb', ['-c', installerPath], { timeoutMs: 120000 });
  const entries = listing.stdout.split('\n').map((line) => line.trim().split(/\s+/).pop()).filter(Boolean);
  for (const required of [
    './usr/bin/vis_bridge',
    './usr/lib/vis_bridge/node_modules/node-pty/lib/index.js',
    `./usr/lib/vis_bridge/bridge/runtime/runtime/${WORKER_NAME}`,
    `./usr/lib/vis_bridge/bridge/runtime/runtime/${SIDECAR_NAME}`,
    './usr/lib/vis_bridge/shared/runtime/protocol.js',
  ]) {
    recorder.check(`H2: deb contains ${required}`, true, entries.includes(required));
  }
  recorder.check('H2: deb contains no .d.ts staging noise', 0, entries.filter((entry) => entry.endsWith('.d.ts')).length);
  await recorder.artifact(installerPath, 'bridge-deb');
  return { installerPath, version: packageVersion };
}

async function extractDeb(debPath, targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  await runOrThrow('dpkg-deb', ['-x', debPath, targetDirectory], { timeoutMs: 300000 });
}

// ---------------------------------------------------------------------------
// Installed daemon control (no node on PATH, staged state dir)
// ---------------------------------------------------------------------------
async function startInstalledDaemon(staging, paths, port, options = {}) {
  const config = path.join(staging.stateDir, 'bridge.json');
  const child = spawn(paths.binary, ['start', '--port', String(port), '--config', config], {
    env: options.env ?? noNodeEnvironment(staging),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      stderr += `\n${error.message}`;
      resolve({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // The `start` CLI exits 0 as soon as the daemon is ready, so a CLI exit is
  // NOT the end of the wait: the daemon state must be read (and the daemon
  // registered for teardown) even when the CLI wins the race. Only a non-zero
  // / failed CLI exit ends the wait early.
  const deadline = Date.now() + (options.timeoutMs ?? 90000);
  let state = null;
  let cliExit = null;
  while (Date.now() < deadline) {
    const settled = await Promise.race([exited.then((value) => ({ exited: value })), sleep(200).then(() => null)]);
    if (settled) cliExit = settled.exited;
    try {
      state = JSON.parse(await readFile(path.join(staging.stateDir, 'daemon.json'), 'utf8'));
      if (state.state === 'running' || state.state === 'error') break;
    } catch {}
    if (cliExit && (cliExit.code ?? 1) !== 0) break;
  }
  if (state === null && cliExit === null) state = await waitDaemonRunning(staging, 1000);
  // Track every daemon that reached 'running' so the encompassing teardown can
  // kill it by PID even when a later leg throws before its own stop: the
  // failure legs deliberately delete daemon.json between starts, so a graceful
  // `stop` in the teardown would otherwise find no state and leak the process.
  if (state?.state === 'running' && typeof state.pid === 'number') {
    (options.registry ?? []).push(state.pid);
  }
  return { child, exited, stdout, stderr, state };
}

function killOwnedDaemons(registry) {
  for (const pid of registry) {
    if (IS_WINDOWS) continue;
    const alive = psRows().some((row) => row.trim().startsWith(String(pid) + ' '));
    if (alive) killProcessTree(pid);
  }
  registry.length = 0;
}

async function waitDaemonRunning(staging, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path.join(staging.stateDir, 'daemon.json'), 'utf8'));
      if (state.state === 'running' || state.state === 'error') return state;
    } catch {}
    await sleep(200);
  }
  return null;
}

async function stopInstalledDaemon(staging, paths) {
  const result = await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 60000 });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!existsSync(path.join(staging.stateDir, 'daemon.json'))) break;
    await sleep(200);
  }
  return result;
}

async function bridgeRequest(port, method, requestPath, body) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.text() };
}

async function waitForHello(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await bridgeRequest(port, 'GET', '/runtime/hello').catch((error) => ({ status: 0, body: String(error) }));
    if (last.status === 200) return JSON.parse(last.body);
    await sleep(250);
  }
  throw new Error(`runtime/hello never answered 200 (last ${last?.status}: ${last?.body?.slice(0, 300)})`);
}

// PTY lifecycle over the installed artifact: computed-token sentinel round-trip
// (terminal echo cannot satisfy it), resize via stty, kill.
async function exerciseInstalledPty(recorder, name, port) {
  const created = await bridgeRequest(port, 'POST', '/pty', { command: '/usr/bin/bash', cols: 80, rows: 24 });
  recorder.check(`${name}: POST /pty status`, 200, created.status);
  const ptyId = JSON.parse(created.body).id;
  recorder.observe(`${name}: pty id`, ptyId);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty/${encodeURIComponent(ptyId)}/connect`);
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('pty websocket connect failed'));
  });
  const output = { text: '' };
  ws.onmessage = (event) => { if (typeof event.data === 'string') output.text += event.data; };
  await sleep(400);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sentinel timed out; last output: ${JSON.stringify(output.text.slice(-200))}`)), 20000);
    const poll = setInterval(() => {
      if (output.text.includes(SENTINEL_MARKER)) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
    ws.send('echo VIS_PTY_OK_$((7*6))\n');
  });
  recorder.check(`${name}: PTY sentinel round-trip (computed token)`, true, output.text.includes(SENTINEL_MARKER));
  const resize = await bridgeRequest(port, 'PUT', `/pty/${encodeURIComponent(ptyId)}`, { size: { rows: 40, cols: 100 } });
  recorder.check(`${name}: PUT /pty resize status`, 200, resize.status);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('resize timed out')), 20000);
    const poll = setInterval(() => {
      if (output.text.includes(STTY_EXPECTED)) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
    ws.send('stty size\n');
  });
  recorder.check(`${name}: resize observed via stty size (40 100)`, true, output.text.includes(STTY_EXPECTED));
  const killed = await bridgeRequest(port, 'DELETE', `/pty/${encodeURIComponent(ptyId)}`);
  recorder.check(`${name}: DELETE /pty status`, 200, killed.status);
  await sleep(1000);
  try { ws.close(); } catch {}
  return ptyId;
}

// ---------------------------------------------------------------------------
// In-process store leg over the INSTALLED sidecar (import / read-back / replay)
// ---------------------------------------------------------------------------
// Opens a store, retrying the whole create+initialize cycle when a lingering
// worker from a previous leg still holds the database fence.
async function openStoreReady(create, label) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const store = create();
    try {
      return { store, inspection: await store.ready };
    } catch (error) {
      await store.terminate().catch(() => undefined);
      if (!/locked|SQLITE_BUSY|busy/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await sleep(250);
    }
  }
  throw new Error(`${label} kept reporting a locked database`);
}

async function driveInstalledStore(recorder, name, installRoot, stateDirectory) {
  const { createRuntimeStore } = await import(
    pathToFileURL(path.join(ROOT, 'bridge', 'runtime', 'storage', 'runtimeStore.js')).href
  );
  const environmentId = randomUUID();
  const marker = { marker: name, at: new Date().toISOString(), payload: 'installed-sidecar-import' };
  const create = () => createRuntimeStore({ stateDirectory, environmentId, ownerId: randomUUID(), epoch: randomUUID(), installRoot });
  const first = await openStoreReady(create, `${name}: first store initialize`);
  const inspection = first.inspection;
  const worker = await findSidecarWorker(process.pid, path.join(installRoot, 'runtime', SIDECAR_NAME));
  recorder.check(`${name}: store worker forked through the INSTALLED sidecar`, true, worker !== null);
  recorder.observe(`${name}: worker pid / exe`, worker ? { pid: worker.pid, exe: worker.exe } : null);
  recorder.observe(`${name}: first-store inspection`, { pid: inspection.pid, fence: inspection.fence, locality: inspection.locality });
  const ack = await first.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'imports', key: `import-${name}`, value: marker }] });
  recorder.check(`${name}: DB write accepted (durable-accepted)`, 'durable-accepted', ack.phase);
  recorder.check(`${name}: DB write revision`, 1, ack.revision);
  const dbPath = path.join(stateDirectory, 'runtime', 'runtime.db');
  const bytesAfterWrite = (await stat(dbPath)).size;
  recorder.observe(`${name}: db bytes after write`, bytesAfterWrite);
  const writingEpoch = inspection.epoch;
  const replay = await first.store.replay({ epoch: writingEpoch, after: 0, limit: 50 });
  recorder.check(`${name}: replay (import) returns the written event`, true, replay.events.length >= 1);
  recorder.observe(`${name}: replay events`, replay.events.length);
  await first.store.close();
  const second = await openStoreReady(create, `${name}: second store initialize`);
  const readBack = await second.store.get({ collection: 'imports', key: `import-${name}` });
  recorder.check(`${name}: restart read-back is byte-identical`, marker, readBack?.value);
  await second.store.close();
  return { dbPath, bytesAfterWrite };
}

// ---------------------------------------------------------------------------
// asar header parsing (no external dependency). The 8-byte size prefix layout
// differs between asar writers (the built header here starts its JSON at
// offset 16), so the header is located by its `{"files"` marker and its exact
// extent is found by a string-aware brace scan instead of a fixed offset.
// ---------------------------------------------------------------------------
function asarHeaderJson(buffer) {
  const marker = buffer.indexOf('{"files"');
  if (marker < 0) throw new Error('asar header marker not found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = marker; index < buffer.length; index += 1) {
    const code = buffer[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) inString = true;
    else if (code === 0x7b) depth += 1;
    else if (code === 0x7d) {
      depth -= 1;
      if (depth === 0) return JSON.parse(buffer.subarray(marker, index + 1).toString('utf8'));
    }
  }
  throw new Error('unterminated asar header JSON');
}

async function readAsarEntries(asarPath) {
  const handle = await readFile(asarPath);
  const header = asarHeaderJson(handle);
  const paths = [];
  const sizes = {};
  const walk = (files, prefix) => {
    for (const [name, value] of Object.entries(files ?? {})) {
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (value.files) walk(value.files, entryPath);
      else {
        paths.push(entryPath);
        sizes[entryPath] = value.size ?? 0;
      }
    }
  };
  walk(header.files, '');
  return { paths, sizes };
}

// The same closure walk app/desktopUpdateMetadata.test.ts performs over
// electron/main.js, evaluated here on the artifact side.
function electronMainClosure() {
  const closure = new Set();
  const pending = ['electron/main.js'];
  const specifiersOf = (modulePath) => {
    const source = readFileSync(path.join(ROOT, modulePath), 'utf8');
    const file = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found = [];
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined
        && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text.startsWith('.')
      ) {
        found.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  };
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (closure.has(modulePath)) continue;
    closure.add(modulePath);
    for (const specifier of specifiersOf(modulePath)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), specifier));
      pending.push(path.posix.extname(resolved) === '' ? `${resolved}.js` : resolved);
    }
  }
  return [...closure].sort();
}

// ---------------------------------------------------------------------------
// HAPPY case
// ---------------------------------------------------------------------------
async function runHappy(outDir, options) {
  const recorder = new Recorder('happy', outDir);
  const staging = await createStaging('happy');
  const paths = stagingInstallPaths(staging);
  const ownedPorts = [];
  const ownedDaemons = [];
  const legs = {};
  try {
    // ---- H1/H2: real packaged artifacts ----------------------------------
    if (!options.skipBuild) {
      legs.build = await produceSeaBuild(recorder);
      legs.installer = await produceInstaller(recorder);
    } else {
      recorder.start('H1/H2 skipped by --skip-build (existing dist-bridge artifacts reused)');
      recorder.observe('H1/H2: dist-bridge binary exists', existsSync(path.join(ROOT, 'dist-bridge', 'vis_bridge')));
      legs.installer = {
        installerPath: path.join(
          ROOT,
          'dist-bridge',
          'installers',
          `VisBridge-${JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version}-x64-Linux.deb`,
        ),
        version: JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version,
      };
    }

    // ---- H3: install into a path WITH SPACES ------------------------------
    recorder.start('H3 install (extract) the deb into a path containing spaces');
    await extractDeb(legs.installer.installerPath, staging.root);
    recorder.check('H3: installed binary exists at the spaces path', true, existsSync(paths.binary));
    recorder.check('H3: installed sidecar exists at the spaces path', true, existsSync(paths.sidecar));
    recorder.check('H3: install path contains spaces', true, staging.root.includes(' '));
    recorder.observe('H3: install root', staging.root);
    recorder.observe('H3: installed binary', paths.binary);

    // ---- H4: start with NO node on PATH -----------------------------------
    recorder.start('H4 installed SEA daemon starts with node absent from PATH');
    await assertNoNodeOnPath(recorder, 'H4');
    await resetDaemonState(staging);
    const port = await freePort();
    ownedPorts.push(port);
    const started = await startInstalledDaemon(staging, paths, port, { registry: ownedDaemons });
    const running = started.state?.state === 'running' ? started.state : await waitDaemonRunning(staging);
    recorder.check('H4: daemon state is running', 'running', running?.state ?? started.state?.state ?? 'timeout');
    recorder.observe('H4: daemon pid / port', { pid: running?.pid, port: running?.port });
    recorder.check('H4: daemon startup failures', [], running?.failures ?? null);
    recorder.observe('H4: daemon stdout tail', started.stdout.trim().split('\n').slice(-2));

    // ---- H5: store worker + DB write --------------------------------------
    recorder.start('H5 store worker starts through the staged sidecar and writes the DB');
    const hello = await waitForHello(port);
    recorder.observe('H5: runtime hello target / epoch', { target: hello.hello.target, epoch: hello.hello.epoch });
    const worker = await findSidecarWorker(running.pid, paths.sidecar);
    recorder.check('H5: store worker is a child of the daemon and runs the staged sidecar', true, worker !== null);
    recorder.observe('H5: store worker', worker ? { pid: worker.pid, exe: worker.exe, parent: worker.parent } : null);
    await sleep(500);
    const dbBytes = (await stat(paths.stateDatabase)).size;
    recorder.check('H5: runtime DB exists with bytes', true, dbBytes > 0);
    recorder.observe('H5: runtime db bytes', dbBytes);
    const dbStats = await databaseStatsSafe(paths.stateDatabase);
    dbStats.bytes = dbBytes;
    recorder.observe('H5: runtime db row counts', dbStats.tables);
    recorder.observe('H5: runtime meta', dbStats.meta);
    const fenceBeforeRestart = dbStats.meta[0]?.fence ?? null;

    // ---- H6: PTY lifecycle over the installed artifact ---------------------
    recorder.start('H6 PTY lifecycle over the installed artifact (node-pty dual runtime)');
    legs.ptyId = await exerciseInstalledPty(recorder, 'H6', port);

    // ---- H7: restart --------------------------------------------------------
    recorder.start('H7 installed daemon restarts and preserves the DB');
    const restart = await run(paths.binary, ['restart', '--port', String(port), '--config', path.join(staging.stateDir, 'bridge.json')], {
      env: noNodeEnvironment(staging),
      timeoutMs: 120000,
    });
    recorder.check('H7: vis_bridge restart exit code', 0, restart.status);
    const restarted = await waitDaemonRunning(staging);
    recorder.check('H7: daemon running again', 'running', restarted?.state);
    recorder.observe('H7: daemon pid before / after', { before: running.pid, after: restarted.pid });
    recorder.check('H7: restart produced a new daemon pid', true, restarted.pid !== running.pid);
    const helloAfter = await waitForHello(port);
    recorder.observe('H7: epoch before / after restart', { before: hello.hello.epoch, after: helloAfter.hello.epoch });
    const dbBytesAfterRestart = (await stat(paths.stateDatabase)).size;
    recorder.check('H7: DB preserved across restart (bytes not lost)', true, dbBytesAfterRestart >= dbBytes);
    recorder.observe('H7: db bytes before / after restart', { before: dbBytes, after: dbBytesAfterRestart });
    const fenceAfterRestart = (await databaseStatsSafe(paths.stateDatabase)).meta[0]?.fence ?? null;
    recorder.check('H7: store fence advanced across restart', true, fenceAfterRestart > fenceBeforeRestart);
    recorder.observe('H7: fence before / after restart', { before: fenceBeforeRestart, after: fenceAfterRestart });

    // ---- H8: import / read-back / replay over the installed sidecar ---------
    recorder.start('H8 import + read-back + replay through the installed Node 24 sidecar');
    const importState = path.join(staging.base, 'import-state');
    legs.importState = await driveInstalledStore(recorder, 'H8', paths.installRoot, importState);

    // ---- H9: update into the spaces path -------------------------------------
    // Offline staging: the update is a SECOND real packaged artifact (a freshly
    // built deb with a bumped version) applied over the live install. The SEA
    // binary bytes are identical between the two debs (no source change), so
    // the leg asserts the artifact identity, the layout completeness after the
    // update, the restart and the data preservation — not a binary hash flip.
    recorder.start('H9 update (v2 packaged artifact) into the spaces install path');
    const updatedVersion = `${legs.installer.version.split('-')[0]}-alpha.99`;
    const v2 = await produceDeb(updatedVersion);
    recorder.check('H9: v2 deb path differs from v1', true, v2 !== legs.installer.installerPath);
    const v2Metadata = await runOrThrow('dpkg-deb', ['-f', v2, 'Version'], { timeoutMs: 60000 });
    recorder.check('H9: v2 deb carries the bumped version', updatedVersion, v2Metadata.stdout.trim());
    const v1Sha = await sha256File(legs.installer.installerPath);
    const v2Sha = await sha256File(v2);
    recorder.check('H9: v2 deb is a distinct artifact', true, v1Sha !== v2Sha);
    await recorder.artifact(v2, 'bridge-deb-v2');
    await extractDeb(v2, staging.root);
    recorder.check('H9: install layout complete after the update (binary)', true, existsSync(paths.binary));
    recorder.check('H9: install layout complete after the update (sidecar)', true, existsSync(paths.sidecar));
    recorder.check('H9: install layout complete after the update (worker)', true, existsSync(paths.worker));
    recorder.check('H9: install layout complete after the update (node-pty)', true, existsSync(path.join(paths.nodePty, 'lib', 'index.js')));
    const installedBinarySha = await sha256File(paths.binary);
    recorder.observe('H9: installed binary sha256 after the update', installedBinarySha);
    const updateRestart = await run(paths.binary, ['restart', '--port', String(port), '--config', path.join(staging.stateDir, 'bridge.json')], {
      env: noNodeEnvironment(staging),
      timeoutMs: 120000,
    });
    recorder.check('H9: daemon restarts after the update', 0, updateRestart.status);
    const afterUpdate = await waitDaemonRunning(staging);
    recorder.check('H9: daemon running after the update', 'running', afterUpdate?.state);
    await waitForHello(port);
    const dbBytesAfterUpdate = (await stat(paths.stateDatabase)).size;
    recorder.check('H9: DB preserved across the update', true, dbBytesAfterUpdate >= dbBytes);
    recorder.observe('H9: db bytes after update', dbBytesAfterUpdate);

    // ---- H10: uninstall preserves data ----------------------------------------
    recorder.start('H10 uninstall preserves the data (before/after bytes + record counts)');
    await stopInstalledDaemon(staging, paths);
    await waitNoSidecarWorker(paths.sidecar);
    await driveInstalledStore(recorder, 'H10', paths.installRoot, staging.stateDir);
    const beforeUninstall = await databaseStatsSafe(paths.stateDatabase);
    beforeUninstall.bytes = (await stat(paths.stateDatabase)).size;
    const markerRow = await readEntitySafe(paths.stateDatabase, 'imports', 'import-H10');
    recorder.observe('H10: data before uninstall', { bytes: beforeUninstall.bytes, rows: beforeUninstall.tables, marker: markerRow?.value });
    await rm(staging.root, { recursive: true, force: true });
    recorder.check('H10: install directory removed (uninstalled)', false, existsSync(paths.binary));
    const afterUninstall = await databaseStatsSafe(paths.stateDatabase);
    afterUninstall.bytes = (await stat(paths.stateDatabase)).size;
    recorder.check('H10: DB bytes identical after uninstall', beforeUninstall.bytes, afterUninstall.bytes);
    recorder.check('H10: DB row counts identical after uninstall', beforeUninstall.tables, afterUninstall.tables);
    const markerRowAfter = await readEntitySafe(paths.stateDatabase, 'imports', 'import-H10');
    recorder.check('H10: imported entity survives the uninstall byte-identically', markerRow?.value, markerRowAfter?.value);
    recorder.observe('H10: data after uninstall', { bytes: afterUninstall.bytes, rows: afterUninstall.tables });
    await extractDeb(legs.installer.installerPath, staging.root);
    await resetDaemonState(staging);
    const reinstall = await startInstalledDaemon(staging, paths, port, { registry: ownedDaemons });
    const reinstalled = reinstall.state?.state === 'running' ? reinstall.state : await waitDaemonRunning(staging);
    recorder.check('H10: reinstall starts over the preserved state', 'running', reinstalled?.state);
    await waitForHello(port);
    const fenceAfterReinstall = (await databaseStatsSafe(paths.stateDatabase)).meta[0]?.fence ?? null;
    recorder.check('H10: preserved fence continues after reinstall', true, fenceAfterReinstall > beforeUninstall.meta[0].fence);
    recorder.observe('H10: fence before uninstall / after reinstall', { before: beforeUninstall.meta[0].fence, after: fenceAfterReinstall });

    // ---- H11/H12/H13: Electron preview + storage + pty ------------------------
    if (!options.skipElectron) {
      recorder.start('H11 pnpm electron:preview packages the closure without embedding the bridge');
      const preview = await run('pnpm', [...PNPM, 'electron:preview'], { timeoutMs: 900000 });
      recorder.check('H11: pnpm electron:preview exit code', 0, preview.status);
      const unpacked = path.join(ROOT, 'dist-electron', 'linux-unpacked');
      const executable = path.join(unpacked, 'vis');
      recorder.check('H11: unpacked Electron executable exists', true, existsSync(executable));
      const asarPath = path.join(unpacked, 'resources', 'app.asar');
      recorder.check('H11: app.asar exists', true, existsSync(asarPath));
      const asar = await readAsarEntries(asarPath);
      const closure = electronMainClosure();
      const missing = closure.filter((modulePath) => !asar.paths.includes(modulePath));
      recorder.check('H11: every electron/main.js closure module is in the package', [], missing);
      recorder.observe('H11: closure size / packaged entries', { closure: closure.length, packaged: asar.paths.length });
      const asarBytes = (await stat(asarPath)).size;
      // The standalone Bridge (SEA binary, Node 24 sidecar, staged store
      // worker) must NOT be silently embedded in the Electron package. The
      // node-pty npm dependency IS packaged wholesale (pre-existing behavior:
      // node_modules is not excluded and the Electron main process does not
      // import node-pty itself) — that is a dependency, not the standalone
      // Bridge, and is recorded as an observation, not asserted away.
      const bridgeArtifacts = asar.paths.filter((entry) => (
        entry === 'vis_bridge'
        || entry.endsWith('/vis_bridge')
        || entry.includes('dist-bridge')
        || entry.includes('vis_bridge_node')
        || entry.includes('vis_bridge.blob')
        || entry.includes('runtimeDatabaseWorker')
      ));
      recorder.check('H11: no standalone Bridge artifact embedded (SEA/sidecar/worker)', [], bridgeArtifacts);
      const asarBuffer = await readFile(asarPath);
      recorder.check('H11: SEA sentinel fuse absent from the package', false, asarBuffer.includes(SEA_SENTINEL_FUSE));
      const biggest = Math.max(...Object.values(asar.sizes));
      recorder.check('H11: no oversized embedded runtime (largest entry < 40MB)', true, biggest < 40 * 1024 * 1024);
      recorder.observe('H11: asar bytes / largest entry', { asarBytes, biggest });
      recorder.observe('H11: node-pty npm dependency entries carried by the package',
        asar.paths.filter((entry) => entry.includes('node-pty')).length);
      legs.electronExecutable = executable;

      recorder.start('H12 pnpm qa:electron-storage against the preview build');
      const storage = await run('xvfb-run', ['-a', 'node', 'scripts/qa/electron-persistent-storage-sync.mjs'], {
        env: { ...process.env, VIS_ELECTRON_EXECUTABLE: executable },
        timeoutMs: 300000,
      });
      recorder.check('H12: qa:electron-storage exit code', 0, storage.status);
      recorder.observe('H12: qa:electron-storage output', storage.stdout.trim().split('\n').slice(-3));

      recorder.start('H13 pnpm qa:pty (node + sea + electron runtimes)');
      const pty = await run('pnpm', [...PNPM, 'qa:pty'], { timeoutMs: 600000 });
      recorder.check('H13: pnpm qa:pty exit code', 0, pty.status);
      recorder.observe('H13: qa:pty output', pty.stdout.trim().split('\n').filter((line) => line.startsWith('VIS_PTY')).slice(-5));
      const matrix = path.join(ROOT, '.omo', 'evidence', 'electron-major-upgrade', 'task-11', 'local-matrix.json');
      recorder.check('H13: qa:pty matrix written', true, existsSync(matrix));
      if (existsSync(matrix)) {
        const parsed = JSON.parse(await readFile(matrix, 'utf8'));
        recorder.observe('H13: qa:pty runtimes', Object.fromEntries(Object.entries(parsed.runtimes).map(([key, value]) => [key, value.ok])));
      }

      recorder.start('H13b node-pty dual runtime against the installed spaces-path artifact');
      const ptyState = path.join(staging.base, 'pty-state');
      const ptyOut = path.join(outDir, 'pty-installed');
      await mkdir(ptyOut, { recursive: true });
      const installedPort = await freePort();
      ownedPorts.push(installedPort);
      const targeted = await run('node', [
        'scripts/qa/node-pty-dual-runtime.mjs',
        '--runtimes', 'sea',
        '--bridge-binary', paths.binary,
        '--state-dir', ptyState,
        '--port', String(installedPort),
        '--out-dir', ptyOut,
      ], {
        env: { ...process.env, HOME: staging.homeDir },
        timeoutMs: 300000,
      });
      recorder.check('H13b: installed-artifact SEA PTY run exit code', 0, targeted.status);
      recorder.observe('H13b: installed-artifact SEA PTY output', targeted.stdout.trim().split('\n').slice(-3));
      const seaReceipt = path.join(ptyOut, 'sea.json');
      recorder.check('H13b: installed-artifact SEA PTY receipt written', true, existsSync(seaReceipt));
      if (existsSync(seaReceipt)) {
        const receipt = JSON.parse(await readFile(seaReceipt, 'utf8'));
        recorder.check('H13b: installed-artifact SEA PTY receipt ok', true, receipt.ok);
        recorder.observe('H13b: installed SEA PTY binary bytes', receipt.binary?.sizeBytes);
        recorder.observe('H13b: embedded node strings in installed binary', receipt.binary?.embeddedNodeStrings);
      }
    }
  } finally {
    try { await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 30000 }); } catch {}
    killOwnedDaemons(ownedDaemons);
    await writeFile(path.join(outDir, 'cleanup.json'), `${JSON.stringify({ staging, removed: true, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    await rm(staging.base, { recursive: true, force: true }).catch(() => undefined);
  }
  return recorder.manifest({ legs: Object.keys(legs) });
}

// ---------------------------------------------------------------------------
// FAILURE case: every leg must exit NON-ZERO with a located diagnosis and
// never fall back to repository source.
// ---------------------------------------------------------------------------
async function runFailure(outDir) {
  const recorder = new Recorder('failure', outDir);
  const staging = await createStaging('failure');
  const paths = stagingInstallPaths(staging);
  const ownedDaemons = [];
  const packageVersion = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  const installerPath = path.join(ROOT, 'dist-bridge', 'installers', `VisBridge-${packageVersion}-x64-Linux.deb`);
  if (!existsSync(installerPath)) throw new Error(`failure case needs the packaged deb at ${installerPath}; run --case happy first`);
  await extractDeb(installerPath, staging.root);
  try {
    // ---- F1: deleted worker / Node sidecar ----------------------------------
    // The runtime host is created lazily (first /runtime/hello), so a deleted
    // sidecar surfaces at the runtime surface: a 503 plus the located
    // diagnosis in the daemon log (visBridgeServer logs it since this task).
    recorder.start('F1 deleted store worker / Node sidecar fails loudly');
    await resetDaemonState(staging);
    await rm(paths.sidecar, { force: true });
    const f1 = await startInstalledDaemon(staging, paths, await freePort(), { timeoutMs: 60000, registry: ownedDaemons });
    const f1Running = f1.state?.state === 'running' ? f1.state : await waitDaemonRunning(staging, 60000);
    recorder.check('F1: daemon listens (lazy runtime host)', 'running', f1Running?.state);
    const f1Hello = await bridgeRequest(f1Running.port, 'GET', '/runtime/hello').catch(() => ({ status: 0, body: 'request failed' }));
    recorder.check('F1: runtime surface fails non-zero (503)', true, f1Hello.status >= 400);
    const f1Log = await readDaemonLog(staging);
    const f1Diagnosis = `${f1Log}`;
    recorder.check('F1: diagnosis names the missing sidecar', true, f1Diagnosis.includes(SIDECAR_NAME) && f1Diagnosis.includes('sidecar is missing'));
    recorder.check('F1: diagnosis does NOT fall back to repository source', false, f1Diagnosis.includes(ROOT));
    recorder.observe('F1: diagnosis', f1Diagnosis.trim().split('\n').filter(Boolean).slice(-3));
    await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 30000 });
    await extractDeb(installerPath, staging.root);
    await resetDaemonState(staging);
    await rm(paths.worker, { force: true });
    const f1b = await startInstalledDaemon(staging, paths, await freePort(), { timeoutMs: 60000, registry: ownedDaemons });
    const f1bRunning = f1b.state?.state === 'running' ? f1b.state : await waitDaemonRunning(staging, 60000);
    const f1bHello = await bridgeRequest(f1bRunning.port, 'GET', '/runtime/hello').catch(() => ({ status: 0, body: 'request failed' }));
    recorder.check('F1b: runtime surface fails non-zero (503)', true, f1bHello.status >= 400);
    const f1bLog = await readDaemonLog(staging);
    recorder.check('F1b: diagnosis names the missing worker or sidecar', true,
      f1bLog.includes(WORKER_NAME) || f1bLog.includes('sidecar is missing'));
    recorder.observe('F1b: diagnosis', f1bLog.trim().split('\n').filter(Boolean).slice(-3));
    await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 30000 });

    // ---- F2: wrong architecture ------------------------------------------------
    recorder.start('F2 wrong architecture fails loudly');
    let archError = null;
    try {
      await produceDeb('0.0.0-arch-probe');
      const { packageVisBridgeInstaller } = await import(
        pathToFileURL(path.join(ROOT, 'scripts', 'package-vis-bridge-installer.mjs')).href
      );
      await packageVisBridgeInstaller(ROOT, { version: '0.0.0-arch-probe', platform: 'linux', arch: 'ia32', format: 'deb' });
    } catch (error) {
      archError = error;
    }
    recorder.check('F2a: unsupported architecture rejected', true, archError !== null);
    recorder.check('F2a: diagnosis names the rejected architecture', true, String(archError?.message ?? '').includes('ia32'));
    recorder.observe('F2a: diagnosis', archError?.message ?? null);
    await extractDeb(installerPath, staging.root);
    await resetDaemonState(staging);
    const foreignPrebuild = path.join(ROOT, 'node_modules', 'node-pty', 'prebuilds', 'linux-arm64', 'pty.node');
    const stagedPrebuild = path.join(paths.nodePty, 'prebuilds', 'linux-x64', 'pty.node');
    if (existsSync(foreignPrebuild) && existsSync(stagedPrebuild)) {
      await cp(foreignPrebuild, stagedPrebuild);
      const f2 = await startInstalledDaemon(staging, paths, await freePort(), { timeoutMs: 60000, registry: ownedDaemons });
      const f2Running = f2.state?.state === 'running' ? f2.state : await waitDaemonRunning(staging, 60000);
      recorder.check('F2b: daemon still starts (bridge stays usable)', 'running', f2Running?.state);
      const ptyAttempt = await bridgeRequest(f2Running.port, 'POST', '/pty', { command: '/usr/bin/bash', cols: 80, rows: 24 });
      recorder.check('F2b: PTY create with a foreign-arch prebuild fails', true, ptyAttempt.status >= 400);
      recorder.check('F2b: PTY diagnosis mentions the native binding', true, /node-pty|\.node|NODE_MODULE_VERSION|ERR_DLOPEN/i.test(ptyAttempt.body));
      recorder.observe('F2b: PTY failure', { status: ptyAttempt.status, body: ptyAttempt.body.slice(0, 300) });
      await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 30000 });
    } else {
      recorder.observe('F2b: skipped', 'foreign or staged prebuild unavailable on this host');
    }

    // ---- F3: read-only install path + update -------------------------------------
    recorder.start('F3 read-only install path blocks the update loudly');
    await extractDeb(installerPath, staging.root);
    await resetDaemonState(staging);
    await makeReadOnlyTree(staging.root);
    const v2 = await produceDeb('0.0.0-update-blocked');
    const f3 = await run('dpkg-deb', ['-x', v2, staging.root], { timeoutMs: 120000 });
    recorder.check('F3: update into the read-only install path exits non-zero', true, f3.status !== 0);
    recorder.check('F3: diagnosis is located (names install entries it cannot write)', true,
      /Cannot open/i.test(f3.stderr) && f3.stderr.includes('./usr/bin/vis_bridge'));
    recorder.observe('F3: diagnosis', f3.stderr.trim().split('\n').slice(-3));
    await restoreWritableTree(staging.root);

    // ---- F4: interrupted update -----------------------------------------------------
    recorder.start('F4 interrupted update fails loudly and preserves the data');
    await extractDeb(installerPath, staging.root);
    await resetDaemonState(staging);
    const f4Port = await freePort();
    const f4Start = await startInstalledDaemon(staging, paths, f4Port, { timeoutMs: 60000, registry: ownedDaemons });
    const f4Running = f4Start.state?.state === 'running' ? f4Start.state : await waitDaemonRunning(staging, 60000);
    recorder.check('F4: daemon running before the interrupted update', 'running', f4Running?.state);
    await waitForHello(f4Port);
    await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 60000 });
    await waitNoSidecarWorker(paths.sidecar);
    // Snapshot AFTER the shutdown writes settle: the leg measures what the
    // interrupted UPDATE does to the data, not what a clean stop does.
    const dataBefore = await databaseStatsSafe(paths.stateDatabase);
    dataBefore.bytes = (await stat(paths.stateDatabase)).size;
    const v3 = await produceDeb('0.0.0-interrupted');
    // Detached so the kill reaches dpkg-deb AND its tar child: a surviving tar
    // would keep the binary open for writing (ETXTBSY) and the truncated-install
    // leg would race the writer instead of observing the broken artifact.
    const extractor = spawn('dpkg-deb', ['-x', v3, staging.root], { stdio: 'ignore', windowsHide: true, detached: !IS_WINDOWS });
    const fullBinaryBytes = (await stat(paths.binary)).size;
    const killDeadline = Date.now() + 120000;
    let interrupted = false;
    while (Date.now() < killDeadline) {
      const partial = await stat(paths.binary).then((entry) => entry.size).catch(() => 0);
      if (partial > 1024 && partial < fullBinaryBytes) {
        if (IS_WINDOWS) extractor.kill('SIGKILL');
        else try { process.kill(-extractor.pid, 'SIGKILL'); } catch { extractor.kill('SIGKILL'); }
        interrupted = true;
        break;
      }
      if (extractor.exitCode !== null) break;
      await sleep(20);
    }
    recorder.check('F4: update was actually interrupted mid-copy', true, interrupted);
    await sleep(1000);
    const truncatedBytes = (await stat(paths.binary)).size;
    recorder.check('F4: installed binary is now truncated', true, truncatedBytes < fullBinaryBytes);
    recorder.observe('F4: installed binary bytes full / truncated', { full: fullBinaryBytes, truncated: truncatedBytes });
    await resetDaemonState(staging);
    const f4 = await startInstalledDaemon(staging, paths, await freePort(), { timeoutMs: 60000, registry: ownedDaemons });
    const f4Exit = await Promise.race([f4.exited, sleep(90000).then(() => ({ code: null }))]);
    recorder.check('F4: start with the truncated binary exits non-zero', true, (f4Exit?.code ?? 1) !== 0);
    const f4Diagnosis = `${f4.stdout}\n${f4.stderr}\n${f4.state?.error ?? ''}`;
    recorder.check('F4: diagnosis is located (names the binary or exec failure)', true,
      f4Diagnosis.includes(paths.binary) || /ENOEXEC|cannot execute|Exec format/i.test(f4Diagnosis));
    recorder.observe('F4: diagnosis', f4Diagnosis.trim().split('\n').filter(Boolean).slice(-3));
    killProcessTree(f4.child.pid);
    const dataAfterInterruption = await databaseStatsSafe(paths.stateDatabase);
    dataAfterInterruption.bytes = (await stat(paths.stateDatabase)).size;
    recorder.check('F4: state DB bytes unchanged by the interrupted update', dataBefore.bytes, dataAfterInterruption.bytes);
    recorder.check('F4: state DB row counts unchanged by the interrupted update', dataBefore.tables, dataAfterInterruption.tables);

    // ---- F5: source cwd missing ------------------------------------------------------
    recorder.start('F5 missing source entry fails loudly with no repository fallback');
    await cp(path.join(ROOT, 'vis_bridge.js'), path.join(staging.sourceDir, 'vis_bridge.js'));
    await cp(path.join(ROOT, 'bridge'), path.join(staging.sourceDir, 'bridge'), { recursive: true });
    await cp(path.join(ROOT, 'shared'), path.join(staging.sourceDir, 'shared'), { recursive: true });
    await cp(path.join(ROOT, 'electron'), path.join(staging.sourceDir, 'electron'), { recursive: true });
    await cp(path.join(ROOT, 'package.json'), path.join(staging.sourceDir, 'package.json'));
    const sourceEntry = path.join(staging.sourceDir, 'vis_bridge.js');
    const worktreeEntrySha = await sha256File(path.join(ROOT, 'vis_bridge.js'));
    const devVersion = await run(process.execPath, [sourceEntry, '--version'], { timeoutMs: 60000 });
    recorder.check('F5: scratch source tree is functional (dev mode --version)', 0, devVersion.status);
    recorder.observe('F5: scratch source version', devVersion.stdout.trim());
    const devPort = await freePort();
    const devState = path.join(staging.base, 'dev-state');
    await mkdir(devState, { recursive: true });
    await writeFile(path.join(devState, 'bridge.json'), BRIDGE_CONFIG, 'utf8');
    const devStart = await run(process.execPath, [sourceEntry, 'start', '--port', String(devPort), '--config', path.join(devState, 'bridge.json')], {
      env: { ...process.env, VIS_BRIDGE_STATE_DIR: devState },
      timeoutMs: 120000,
    });
    recorder.check('F5: dev-mode source start still works (regression guard)', 0, devStart.status);
    try {
      const devDaemon = JSON.parse(await readFile(path.join(devState, 'daemon.json'), 'utf8'));
      if (devDaemon.state === 'running') ownedDaemons.push(devDaemon.pid);
    } catch {}
    await run(process.execPath, [sourceEntry, 'stop'], { env: { ...process.env, VIS_BRIDGE_STATE_DIR: devState }, timeoutMs: 60000 });
    await rm(staging.sourceDir, { recursive: true, force: true });
    const f5 = await run(process.execPath, [sourceEntry, 'start', '--port', String(devPort), '--config', path.join(devState, 'bridge.json')], {
      env: { ...process.env, VIS_BRIDGE_STATE_DIR: devState },
      timeoutMs: 120000,
    });
    recorder.check('F5: missing source entry exits non-zero', true, f5.status !== 0);
    const f5Diagnosis = `${f5.stdout}\n${f5.stderr}`;
    recorder.check('F5: diagnosis names the missing source entry', true, f5Diagnosis.includes(sourceEntry));
    recorder.check('F5: diagnosis does NOT resolve to the repository copy', false, f5Diagnosis.includes(path.join(ROOT, 'vis_bridge.js')));
    const worktreeEntryShaAfter = await sha256File(path.join(ROOT, 'vis_bridge.js'));
    recorder.check('F5: repository entry untouched', worktreeEntrySha, worktreeEntryShaAfter);
    recorder.observe('F5: diagnosis', f5Diagnosis.trim().split('\n').filter(Boolean).slice(-3));
  } finally {
    try { await run(paths.binary, ['stop'], { env: noNodeEnvironment(staging), timeoutMs: 30000 }); } catch {}
    killOwnedDaemons(ownedDaemons);
    await writeFile(path.join(outDir, 'cleanup.json'), `${JSON.stringify({ staging, removed: true, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    await rm(staging.base, { recursive: true, force: true }).catch(() => undefined);
  }
  return recorder.manifest({});
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });
  const recorderless = options.scenario === 'happy'
    ? await runHappy(options.outDir, options)
    : await runFailure(options.outDir);
  const outPath = path.join(options.outDir, `${options.scenario}.json`);
  await writeFile(outPath, `${JSON.stringify(recorderless, null, 2)}\n`, 'utf8');
  const failed = recorderless.scenarios.flatMap((scenario) => scenario.assertions.filter((assertion) => assertion.ok === false));
  console.log(`VIS_PACKAGED_${options.scenario.toUpperCase()} scenarios=${recorderless.scenarios.length} assertions=${recorderless.assertionCount} failed=${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

try {
  await main();
} catch (error) {
  console.error(`VIS_PACKAGED_ERROR ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
}
