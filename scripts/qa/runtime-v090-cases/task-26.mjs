// Task 26 registered QA case — System SSH authentication, trust and bounded transport.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// The case drives the REAL landed Node modules directly in the worker process:
//   bridge/runtime/transports/sshTransport.js, sshAuthentication.js, knownHosts.js
//   and processRelay.js (plus their .d.ts companions). The ONLY controlled
//   boundaries are:
//     * the OS process edge — `spawn`/`stopProcessTree` are fakes, so no real ssh
//       binary is ever executed;
//     * the transport "target hello" is a local loopback net server that speaks the
//       REAL relay framing (not an sshd);
//     * a small browser entry (app/dev/runtime-v090/task26.ts over case-owned
//       node:* shims) proves the redaction/framing projections a renderer receives.
//
// This module does NOT claim a live SSH or Slurm verification and does NOT author a
// PASS verdict — task 46 owns the real end-to-end system sshd check. No product file
// is edited by this module.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createServer as createNetServer, connect } from 'node:net';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture, alive, until, assertPortReleased, listen, closeServer } from './task-26-fixture.mjs';

import { parseKnownHosts } from '../../../bridge/runtime/transports/knownHosts.js';
import {
  AUTH_CHALLENGE_KINDS,
  REDACTED,
  createAuthenticationSession,
  createSecretBox,
  createSecretChannel,
  redactSecrets,
} from '../../../bridge/runtime/transports/sshAuthentication.js';
import {
  RELAY_MAX_FRAME_BYTES,
  createProcessRelay,
  decodeRelayFrames,
  encodeRelayFrame,
} from '../../../bridge/runtime/transports/processRelay.js';
import {
  TARGET_HELLO,
  TARGET_HELLO_OK,
  assertNoShellConcatenation,
  assertSecretFreeArgv,
  buildSshArgv,
  createSshTransport,
  parseAllocatedPort,
  resolveSshConfig,
  resolveSshTarget,
  sshProgram,
} from '../../../bridge/runtime/transports/sshTransport.js';
import { resolveProfileEnvironment } from '../../../shared/runtime/connectionProfile.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HOST = 'builder.example';
const KEY_A = Buffer.from('ssh-ed25519-AAAA-key-A-material-0123456789').toString('base64');
const KEY_B = Buffer.from('ssh-ed25519-BBBB-key-B-material-9876543210').toString('base64');
const SECRET = 'sup3r-s3cret-password-t26';
const PASSPHRASE = 'key-passphrase-hunter2-t26';
const SENTINEL = 'sk-task26-sentinel-4f8a2c9d-NEVER-LOG';
const BYTES = [0, 255, 1, 2, 254, 128, 0, 77];

const SSH_CONFIG = [
  '# user config',
  'Host builder',
  '  HostName ignored.example',
  '',
  'Host builder.example',
  '  HostName builder.internal',
  '  User deploy',
  '  Port 2222',
  '  IdentityFile ~/.ssh/id_ed25519',
  '  ProxyJump bastion',
  '',
  'Host *',
  '  User fallback',
  '  StrictHostKeyChecking ask',
  '',
].join('\n');

const EXPECTED_ARGV = [
  '-T', '-o', 'RequestTTY=no', '-o', 'ForwardAgent=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=ask', '-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts',
  '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-i', '~/.ssh/id_ed25519',
  '-J', 'bastion', '-p', '2222', '-l', 'deploy', '-L', '127.0.0.1:0:127.0.0.1:23004', '-N', '--', 'builder.internal',
];

const PROFILE = Object.freeze({
  profileId: '55555555-5555-4555-8555-555555555555',
  name: 'Build host',
  transport: { kind: 'ssh', endpoint: `${HOST}:22` },
  target: { kind: 'ssh', environmentId: '66666666-6666-4666-8666-666666666666' },
  role: 'execution',
  credentialRef: 'cred-ssh-password',
  enabled: true,
});

export const sourceFiles = [...new Set([
  'bridge/runtime/transports/sshTransport.js', 'bridge/runtime/transports/sshTransport.d.ts',
  'bridge/runtime/transports/sshAuthentication.js', 'bridge/runtime/transports/sshAuthentication.d.ts',
  'bridge/runtime/transports/knownHosts.js', 'bridge/runtime/transports/knownHosts.d.ts',
  'bridge/runtime/transports/processRelay.js', 'bridge/runtime/transports/processRelay.d.ts',
  'bridge/processTree.js', 'bridge/windowsProcessTree.js',
  'app/runtime/sshTransport.test.ts',
  'app/dev/runtime-v090/task26.ts',
  'scripts/qa/runtime-v090-cases/task-26.mjs',
  'scripts/qa/runtime-v090-cases/task-26-fixture.mjs',
  'scripts/qa/runtime-v090-cases/task-26-browser-shim.mjs',
  'shared/runtime/capabilities.js', 'shared/runtime/connectionProfile.js', 'shared/runtime/identity.js',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 26 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task26Errors=[];window.addEventListener('error',(e)=>window.__task26Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task26Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task26.ts"></script></body></html>`;

const hasPair = (argv, flag, value) => argv.some((token, index) => token === flag && argv[index + 1] === value);

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid; child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true, end: () => {} };
  child.kill = () => true;
  return child;
}

// A fake ssh child whose stderr emits the given lines the moment a data listener
// attaches, so the REAL defaultReadAllocatedPort reads a deterministic stream.
function scriptedStderrChild(pid, lines, { closeAfter = false } = {}) {
  const child = fakeChild(pid);
  const originalOn = child.stderr.on.bind(child.stderr);
  let scheduled = false;
  child.stderr.on = (event, handler) => {
    originalOn(event, handler);
    if (event === 'data' && !scheduled) {
      scheduled = true;
      setImmediate(() => {
        for (const line of lines) child.stderr.emit('data', Buffer.from(line));
        if (closeAfter) child.emit('close');
      });
    }
    return child.stderr;
  };
  return child;
}

// A local loopback "target hello" server that speaks the REAL relay framing.
// `echo` mode reflects each frame's raw bytes byte-for-byte (binary round-trip).
async function startTargetServer({ replyOk = true, echo = false } = {}) {
  const server = createNetServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try { decoded = decodeRelayFrames(buffer); } catch { return; }
      buffer = decoded.remaining;
      for (const payload of decoded.frames) {
        if (echo) { socket.write(encodeRelayFrame(payload)); continue; }
        let message;
        try { message = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (replyOk && message?.kind === TARGET_HELLO.kind) socket.write(encodeRelayFrame(JSON.stringify(TARGET_HELLO_OK)));
        else socket.write(encodeRelayFrame(JSON.stringify({ kind: 'target.nope', version: 1 })));
      }
    });
  });
  const port = await listen(server);
  return { server, port };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-26/qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const proof = { case: context.case, runDir, checks, observations };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const normalize = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const check = (name, observed, expected) => {
    const left = normalize(observed); const right = normalize(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface: 'real landed SSH transport modules in the Node worker, over a local loopback target-hello fixture and a real headless Chromium redaction/framing surface', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = normalize(value); persist(); };
  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  let browser; let page; let vite;
  try {
    // ── real landed code: per-scenario transport factory (OS edge is faked only) ──
    const makeTransport = (overrides = {}) => {
      const captured = [];
      let stopTreeCount = 0;
      const transport = createSshTransport({
        platform: overrides.platform ?? 'linux',
        spawn: (command, args, options) => { captured.push({ command, args: [...args], options: { shell: options?.shell, env: options?.env } }); return overrides.child ?? fakeChild(9000 + captured.length); },
        stopProcessTree: async () => { stopTreeCount += 1; },
        configText: SSH_CONFIG,
        knownHostsText: overrides.knownHostsText ?? '',
        hostKeyProvider: async () => overrides.hostKey ?? { keyType: 'ssh-ed25519', keyBlob: KEY_A },
        persistKnownHost: async () => {},
        method: overrides.method,
        responder: overrides.responder ?? responderAccept,
        secretDirectory: path.join(fixture.root, overrides.secretName ?? 'secrets'),
        askpassPath: '/usr/lib/vis/askpass',
        readAllocatedPort: overrides.readAllocatedPort,
        targetHello: overrides.targetHello,
        helloTimeoutMs: overrides.helloTimeoutMs,
      });
      return { transport, captured, stopTreeCount: () => stopTreeCount };
    };
    const responderAccept = async (challenge) => {
      if (challenge.kind === 'host-key') return { accept: true, persist: true };
      if (challenge.kind === 'password') return { secret: SECRET };
      if (challenge.kind === 'passphrase') return { secret: PASSPHRASE };
      return { accept: false };
    };

    // ── target-hello servers (loopback, register BEFORE creation) ──
    fixture.register({ kind: 'target-hello-server-planned', teardown: 'server.close then exclusive port rebind' });
    const hello = await startTargetServer({ replyOk: true });
    fixture.register({ kind: 'target-hello-server-created', port: hello.port });
    fixture.own('target-hello-server', async () => { await closeServer(hello.server); await assertPortReleased(hello.port); return { port: hello.port, exclusiveRebind: true }; });
    fixture.register({ kind: 'bad-target-server-planned', teardown: 'server.close then exclusive port rebind' });
    const badTarget = await startTargetServer({ replyOk: false });
    fixture.register({ kind: 'bad-target-server-created', port: badTarget.port });
    fixture.own('bad-target-server', async () => { await closeServer(badTarget.server); await assertPortReleased(badTarget.port); return { port: badTarget.port, exclusiveRebind: true }; });
    fixture.register({ kind: 'echo-server-planned', teardown: 'server.close then exclusive port rebind' });
    const echoServer = await startTargetServer({ echo: true });
    fixture.register({ kind: 'echo-server-created', port: echoServer.port });
    fixture.own('echo-server', async () => { await closeServer(echoServer.server); await assertPortReleased(echoServer.port); return { port: echoServer.port, exclusiveRebind: true }; });

    // ── Vite server for the browser-shaped surface (node:* aliased to the shim) ──
    const shimPath = path.join(context.root, 'scripts/qa/runtime-v090-cases/task-26-browser-shim.mjs');
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      resolve: { alias: [
        { find: /^node:crypto$/, replacement: shimPath },
        { find: /^node:child_process$/, replacement: shimPath },
        { find: /^node:fs\/promises$/, replacement: shimPath },
        { find: /^node:fs$/, replacement: shimPath },
        { find: /^node:os$/, replacement: shimPath },
        { find: /^node:path$/, replacement: shimPath },
        { find: /^node:net$/, replacement: shimPath },
      ] },
      optimizeDeps: { include: ['buffer'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa26', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa26/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task26 && window.task26.ready)), 'task26 browser entry', 60000);
    const evaluate = (fn, arg) => arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);

    // ── browser-shaped surface: redaction and binary framing in a real renderer ──
    const redaction = await evaluate((secret) => window.task26.redaction(secret), SENTINEL);
    const consoleAfterRedaction = await evaluate(() => window.task26.consoleEntries());
    record('browserRedaction', redaction);
    check('the browser surface renders a secret as [redacted] in every projection and leaks it into neither the DOM nor the console', {
      toString: redaction.toString, toJSON: redaction.toJSON, inspect: redaction.inspect,
      domOccurrences: redaction.domOccurrences,
      consoleOccurrences: consoleAfterRedaction.filter((entry) => entry.text.includes(SENTINEL)).length,
      redactedMarker: redaction.redactedMarker,
      redactedTextHasSecret: redaction.redactedText.includes(SENTINEL),
      consumeMatches: redaction.consumeMatches,
      secondConsume: redaction.secondConsume,
      challengeKindCount: redaction.challengeKinds.length,
    }, {
      toString: '[redacted]', toJSON: '"[redacted]"', inspect: '[redacted]', domOccurrences: 0, consoleOccurrences: 0,
      redactedMarker: '[redacted]', redactedTextHasSecret: false, consumeMatches: true,
      secondConsume: 'conflict/secret.consumed', challengeKindCount: AUTH_CHALLENGE_KINDS.length,
    });

    const browserChannel = await evaluate((input) => window.task26.secretChannel(input.secret, input.directory, input.askpass), { secret: SENTINEL, directory: '/browser-secrets', askpass: '/usr/lib/vis/askpass' });
    record('browserSecretChannel', browserChannel);
    check('the browser surface receives only the askpass FILE PATH for a secret and never the value', {
      askpass: browserChannel.askpass, askpassRequire: browserChannel.askpassRequire, filePathIsPath: browserChannel.filePathIsPath,
      secretInEnv: browserChannel.secretInEnv, envKeys: browserChannel.envKeys, fileCleanedUp: browserChannel.fileCleanedUp,
    }, {
      askpass: '/usr/lib/vis/askpass', askpassRequire: 'force', filePathIsPath: true, secretInEnv: false,
      envKeys: ['DISPLAY', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'VIS_SSH_ASKPASS_FILE'], fileCleanedUp: true,
    });

    const framing = await evaluate((bytes) => window.task26.framing(bytes), BYTES);
    record('browserFraming', framing);
    check('binary relay framing round-trips byte-for-byte through partial buffers and rejects an oversize frame', {
      frameCount: framing.frameCount, frames: framing.frames, remainingLength: framing.remainingLength,
      frameLength: framing.frameLength, payloadLength: framing.payloadLength, oversizeRejected: typeof framing.oversized === 'string',
    }, {
      frameCount: 1, frames: [BYTES], remainingLength: 0, frameLength: BYTES.length + 4, payloadLength: BYTES.length, oversizeRejected: true,
    });

    if (context.case === 'failure') {
      // F1 — unknown host key declined at first trust.
      const f1Challenges = [];
      const t1 = makeTransport({ secretName: 'secrets-f1', responder: async (challenge) => { f1Challenges.push(challenge.kind); return challenge.kind === 'host-key' ? { accept: false } : { secret: SECRET }; } });
      let f1 = {}; try { await t1.transport.open(PROFILE); } catch (error) { f1 = { code: error.code, field: error.field }; }
      record('unknownKey', { f1, state: t1.transport.state(PROFILE.profileId) });
      check('an unknown host key declined at first trust is rejected with an explicit type and no process is spawned', {
        code: f1.code, field: f1.field, state: t1.transport.state(PROFILE.profileId), challengeKinds: f1Challenges, spawnCalls: t1.captured.length,
      }, { code: 'unauthorized', field: 'host.key.untrusted', state: 'authenticating', challengeKinds: ['host-key'], spawnCalls: 0 });

      // F2 — a changed host key is rejected before any spawn and offers no accept path.
      const f2Challenges = [];
      const t2 = makeTransport({ secretName: 'secrets-f2', knownHostsText: `[builder.internal]:2222 ssh-ed25519 ${KEY_A}\n`, hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_B }, responder: async (challenge) => { f2Challenges.push({ kind: challenge.kind, options: challenge.options ? [...challenge.options] : null }); return { accept: true, persist: true }; } });
      let f2 = {}; try { await t2.transport.open(PROFILE); } catch (error) { f2 = { code: error.code, field: error.field }; }
      record('changedKey', { f2, challenges: f2Challenges });
      check('a changed host key is rejected with an explicit type, offers only reject, and spawns no process', {
        code: f2.code, field: f2.field, state: t2.transport.state(PROFILE.profileId),
        challengeKinds: f2Challenges.map((entry) => entry.kind), changedOptions: f2Challenges[0]?.options, spawnCalls: t2.captured.length,
      }, { code: 'unauthorized', field: 'host.key.changed', state: 'authenticating', challengeKinds: ['host-key-changed'], changedOptions: ['reject'], spawnCalls: 0 });

      // F3 — a bad (empty) credential is rejected with an explicit type.
      const t3 = makeTransport({ secretName: 'secrets-f3', responder: async (challenge) => challenge.kind === 'host-key' ? { accept: true, persist: true } : {} });
      let f3 = {}; try { await t3.transport.open(PROFILE); } catch (error) { f3 = { code: error.code, field: error.field }; }
      record('badCredential', f3);
      check('an empty credential is rejected with an explicit type and never reaches a process', {
        code: f3.code, field: f3.field, state: t3.transport.state(PROFILE.profileId), spawnCalls: t3.captured.length,
      }, { code: 'unauthorized', field: 'auth.secret', state: 'authenticating', spawnCalls: 0 });

      // F4 — an auth cancel rejects the pending request with an explicit type and retains nothing.
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const f4Kinds = [];
      const session = createAuthenticationSession({
        host: 'builder.internal', port: 2222, hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_A },
        knownHosts: parseKnownHosts(''), method: 'password',
        responder: async (challenge) => { f4Kinds.push(challenge.kind); return gate; },
      });
      const pendingAuth = session.authenticate();
      await until(() => session.pending !== undefined, 'auth challenge pending');
      const pendingKind = session.pending.kind;
      session.cancel();
      const pendingAfterCancel = session.pending === undefined;
      release({ accept: true });
      let f4 = null; try { await pendingAuth; } catch (error) { f4 = { code: error.code, field: error.field }; }
      record('authCancel', { f4, pendingKind, pendingAfterCancel, kinds: f4Kinds });
      check('a cancelled authentication request is rejected with an explicit type and keeps no pending challenge', {
        code: f4?.code, field: f4?.field, pendingKind, pendingAfterCancel, kinds: f4Kinds,
      }, { code: 'cancelled', field: 'auth', pendingKind: 'host-key', pendingAfterCancel: true, kinds: ['host-key'] });

      // F5 — a forward-setup port collision fails the open and tears down the owned process and secret.
      const bindLines = [
        'debug1: Remote connections from LOCALHOST:0 forwarded to local address 127.0.0.1:23004\n',
        'debug1: channel_setup_fwd_listener_tcpip: cannot listen to port: 127.0.0.1:0\n',
        'bind: Address already in use\n',
      ];
      const t5 = makeTransport({ child: scriptedStderrChild(5001, bindLines, { closeAfter: true }), secretName: 'secrets-f5' });
      let f5 = {}; try { await t5.transport.open(PROFILE); } catch (error) { f5 = { code: error.code, field: error.field }; }
      const f5Left = (await readdir(path.join(fixture.root, 'secrets-f5')).catch(() => [])).length;
      record('portCollision', { f5, stopTreeCalls: t5.stopTreeCount(), secretFilesLeft: f5Left });
      check('a forward-setup port collision fails the open with an explicit type and tears down the owned process and secret', {
        code: f5.code, field: f5.field, state: t5.transport.state(PROFILE.profileId), stopTreeCalls: t5.stopTreeCount(), secretFilesLeft: f5Left, spawnCalls: t5.captured.length,
      }, { code: 'source_unavailable', field: 'forward.port', state: 'failed', stopTreeCalls: 1, secretFilesLeft: 0, spawnCalls: 1 });

      // F6 — a target hello that never confirms readiness fails explicitly.
      const t6 = makeTransport({ secretName: 'secrets-f6', readAllocatedPort: async () => badTarget.port, helloTimeoutMs: 300 });
      let f6 = {}; try { await t6.transport.open(PROFILE); } catch (error) { f6 = { code: error.code, field: error.field }; }
      const f6Argv = t6.captured[0]?.args ?? [];
      record('failedTargetHello', { f6, argvHasExitOnForwardFailure: hasPair(f6Argv, '-o', 'ExitOnForwardFailure=yes') });
      check('a target hello that does not confirm readiness fails with an explicit type even though ExitOnForwardFailure was requested', {
        code: f6.code, field: f6.field, state: t6.transport.state(PROFILE.profileId),
        argvHasExitOnForwardFailure: hasPair(f6Argv, '-o', 'ExitOnForwardFailure=yes'), stopTreeCalls: t6.stopTreeCount(),
      }, { code: 'timeout', field: 'target.hello', state: 'failed', argvHasExitOnForwardFailure: true, stopTreeCalls: 1 });

      // F7 — ssh stderr with interleaved log lines still yields the port and retains no stream listener.
      const interleaved = [];
      for (let index = 0; index < 200; index += 1) interleaved.push(`debug1: interleaved log line ${index}\n`);
      interleaved.push(`debug1: Allocated port ${hello.port} for forward\n`);
      const child7 = scriptedStderrChild(7001, interleaved);
      const t7 = makeTransport({ child: child7, secretName: 'secrets-f7', targetHello: async () => ({ ok: true }) });
      const dialed7 = await t7.transport.open(PROFILE);
      const state7 = t7.transport.state(PROFILE.profileId);
      const stderrDataListeners = child7.stderr.listenerCount('data');
      const closeListeners = child7.listenerCount('close');
      await dialed7.close();
      record('interleavedStderr', { state7, parsedPort: parseAllocatedPort(interleaved.join('')), stderrDataListeners, closeListeners });
      check('interleaved ssh stderr still yields the allocated port and leaves no retained stderr/close listener', {
        ready: dialed7.ready, state: state7, parsedPort: parseAllocatedPort(interleaved.join('')),
        stderrDataListenersAfter: stderrDataListeners, closeListenersAfter: closeListeners, interleavedLines: interleaved.length - 1, spawnCalls: t7.captured.length,
      }, { ready: true, state: 'ready', parsedPort: hello.port, stderrDataListenersAfter: 0, closeListenersAfter: 0, interleavedLines: 200, spawnCalls: 1 });

      // F8 — hostile framing and known_hosts input stay bounded and a secret is single-use.
      const hostile = Buffer.concat([encodeRelayFrame('a'), encodeRelayFrame('b'), Buffer.from([0, 0, 1, 0])]);
      const hostileDecoded = decodeRelayFrames(hostile);
      let oversize = null; try { decodeRelayFrames(Buffer.from([0, 0, 1, 0]), { maxFrameBytes: 8 }); } catch (error) { oversize = error.message; }
      const longLineEntries = parseKnownHosts(`${'x'.repeat(70_000)} ssh-ed25519 ${KEY_A}`).length;
      const validEntries = parseKnownHosts(`${HOST} ssh-ed25519 ${KEY_A}\n`).length;
      const box = createSecretBox(SECRET);
      const firstConsume = box.consume();
      let secondConsume = null; try { box.consume(); } catch (error) { secondConsume = `${error.code}/${error.field}`; }
      record('boundedInputs', { oversize, longLineEntries, validEntries, secondConsume });
      check('hostile framing and an over-long known_hosts line are bounded, and a secret is single-use', {
        decodedFrames: hostileDecoded.frames.length, remainingBytes: hostileDecoded.remaining.length, oversizeRejected: typeof oversize === 'string',
        longLineEntries, validEntries, firstConsumeMatches: firstConsume === SECRET, secondConsume, maxFrameBytes: RELAY_MAX_FRAME_BYTES,
      }, { decodedFrames: 2, remainingBytes: 4, oversizeRejected: true, longLineEntries: 0, validEntries: 1, firstConsumeMatches: true, secondConsume: 'conflict/secret.consumed', maxFrameBytes: RELAY_MAX_FRAME_BYTES });

      // F9 — redaction removes every secret from a composite log line.
      const composite = `ssh: auth failed for ${SECRET} with passphrase ${PASSPHRASE} and token ${SECRET}`;
      const redacted = redactSecrets(composite, [SECRET, PASSPHRASE]);
      record('redactionComposite', { redacted });
      check('redaction removes every occurrence of a secret from a composite log line', {
        secretOccurrences: redacted.split(SECRET).length - 1, passphraseOccurrences: redacted.split(PASSPHRASE).length - 1,
        redactedMarkers: redacted.split(REDACTED).length - 1, originalLength: composite.length,
      }, { secretOccurrences: 0, passphraseOccurrences: 0, redactedMarkers: 3, originalLength: composite.length });
    } else {
      // H1 — ssh_config alias, wildcard, first-match-wins, ProxyJump and IdentityFile.
      const config = resolveSshConfig(SSH_CONFIG, 'builder.example');
      const target = resolveSshTarget({ host: HOST, port: 22, configText: SSH_CONFIG });
      const other = resolveSshConfig(SSH_CONFIG, 'builder');
      record('sshConfig', { config, target: { host: target.host, port: target.port, user: target.user, proxyJump: target.proxyJump, identityFiles: target.identityFiles }, other });
      check('ssh_config aliases, wildcards, first-match-wins, ProxyJump and IdentityFile resolve to the concrete target', {
        hostName: config.hostName, user: config.user, port: config.port, proxyJump: config.proxyJump,
        identityFileCount: config.identityFiles.length, strictHostKeyChecking: config.strictHostKeyChecking,
        targetHost: target.host, targetPort: target.port, targetUser: target.user, targetProxyJump: target.proxyJump,
        otherHostName: other.hostName, otherUser: other.user,
      }, {
        hostName: 'builder.internal', user: 'deploy', port: 2222, proxyJump: 'bastion', identityFileCount: 1, strictHostKeyChecking: 'ask',
        targetHost: 'builder.internal', targetPort: 2222, targetUser: 'deploy', targetProxyJump: 'bastion', otherHostName: 'ignored.example', otherUser: 'fallback',
      });

      // H2 — first-time key confirmation and password authentication are challenge-only.
      const challenges = [];
      const session = createAuthenticationSession({
        host: 'builder.internal', port: 2222, user: 'deploy', hostKey: { keyType: 'ssh-ed25519', keyBlob: KEY_A },
        knownHosts: parseKnownHosts(''), method: 'password',
        responder: async (challenge) => { challenges.push({ kind: challenge.kind, options: challenge.options ? [...challenge.options] : null, echo: challenge.echo, redacted: challenge.redacted }); return responderAccept(challenge); },
      });
      const auth = await session.authenticate();
      record('firstTrustAuth', { challenges, hostKeyStatus: auth.hostKeyStatus, methods: [...auth.methods], knownHostEntry: auth.knownHostEntry });
      check('first-time key confirmation and password authentication are challenge-only and never argv', {
        kinds: challenges.map((entry) => entry.kind), hostKeyOptions: challenges[0]?.options,
        allRedacted: challenges.every((entry) => entry.redacted === true && entry.echo === false),
        hostKeyStatus: auth.hostKeyStatus, methods: [...auth.methods], secretCount: auth.secrets.length, secretSize: auth.secrets[0].size,
        knownHostEntryKeyType: auth.knownHostEntry?.keyType, secretStringified: String(auth.secrets[0]), secretJsonHasRaw: JSON.stringify(auth.secrets).includes(SECRET),
      }, {
        kinds: ['host-key', 'password'], hostKeyOptions: ['accept', 'reject'], allRedacted: true, hostKeyStatus: 'unknown', methods: ['password'],
        secretCount: 1, secretSize: Buffer.byteLength(SECRET, 'utf8'), knownHostEntryKeyType: 'ssh-ed25519', secretStringified: '[redacted]', secretJsonHasRaw: false,
      });

      // H3 — the secret travels through a 0600 askpass file whose PATH (never the value) is in env.
      const channelDir = path.join(fixture.root, 'secrets-h3');
      const channel = await createSecretChannel([SECRET], { directory: channelDir, askpassPath: '/usr/lib/vis/askpass' });
      const mode = (await stat(channel.filePath)).mode & 0o777;
      const content = await readFile(channel.filePath, 'utf8');
      await channel.cleanup();
      let removed = false; try { await stat(channel.filePath); } catch { removed = true; }
      record('secretChannel', { mode, askpass: channel.env.SSH_ASKPASS, envKeys: Object.keys(channel.env).sort(), removed });
      check('the secret travels through a 0600 askpass FILE whose PATH (never the value) enters the environment', {
        mode, contentMatches: content === SECRET, askpass: channel.env.SSH_ASKPASS, askpassRequire: channel.env.SSH_ASKPASS_REQUIRE,
        envKeys: Object.keys(channel.env).sort(), secretInEnvJson: JSON.stringify(channel.env).split(SECRET).length - 1,
        filePathIsValue: channel.filePath === SECRET, removed,
      }, {
        mode: 0o600, contentMatches: true, askpass: '/usr/lib/vis/askpass', askpassRequire: 'force',
        envKeys: ['DISPLAY', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'VIS_SSH_ASKPASS_FILE'], secretInEnvJson: 0, filePathIsValue: false, removed: true,
      });

      // H4 — the structured argv is exact, shell-safe and secret-free on every platform.
      const target4 = resolveSshTarget({ host: HOST, port: 22, configText: SSH_CONFIG });
      const shaped = {};
      for (const platform of ['darwin', 'linux', 'win32']) {
        const argv = buildSshArgv({ target: target4, platform, forward: { localHost: '127.0.0.1', localPort: 0, remoteHost: '127.0.0.1', remotePort: 23004 }, knownHostsFile: '/home/u/.ssh/known_hosts' });
        const shellSafe = (() => { try { assertNoShellConcatenation([sshProgram(platform), ...argv]); assertSecretFreeArgv(argv, [SECRET]); return true; } catch { return false; } })();
        shaped[platform] = { program: sshProgram(platform), argv: [...argv], equalsExpected: JSON.stringify([...argv]) === JSON.stringify(EXPECTED_ARGV), shellSafe, spaceTokens: argv.filter((token) => token.includes(' ')).length, hasDashA: argv.includes('-A') };
      }
      record('structuredArgv', shaped);
      check('the structured ssh argv is exact, shell-safe, secret-free and identical across platforms', {
        platforms: Object.keys(shaped).sort(),
        allEqualExpected: Object.values(shaped).every((entry) => entry.equalsExpected),
        allShellSafe: Object.values(shaped).every((entry) => entry.shellSafe),
        allNoSpaces: Object.values(shaped).every((entry) => entry.spaceTokens === 0),
        allNoDashA: Object.values(shaped).every((entry) => entry.hasDashA === false),
        argvLength: shaped.linux.argv.length, forward: hasPair(shaped.linux.argv, '-L', '127.0.0.1:0:127.0.0.1:23004'),
        requestTTYNo: hasPair(shaped.linux.argv, '-o', 'RequestTTY=no'), forwardAgentNo: hasPair(shaped.linux.argv, '-o', 'ForwardAgent=no'),
      }, {
        platforms: ['darwin', 'linux', 'win32'], allEqualExpected: true, allShellSafe: true, allNoSpaces: true, allNoDashA: true,
        argvLength: EXPECTED_ARGV.length, forward: true, requestTTYNo: true, forwardAgentNo: true,
      });

      // H4b — a binary payload round-trips byte-for-byte over a real loopback relay socket.
      const roundTrip = await new Promise((resolve) => {
        const payload = Buffer.from([...BYTES, 0, 13, 10, 200, 7]);
        const socket = connect({ host: '127.0.0.1', port: echoServer.port });
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => { socket.destroy(); resolve({ timedOut: true }); }, 3000);
        socket.on('connect', () => socket.write(encodeRelayFrame(payload)));
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          const decoded = decodeRelayFrames(buffer);
          buffer = decoded.remaining;
          if (decoded.frames.length > 0) {
            clearTimeout(timer); socket.end();
            const got = decoded.frames[0];
            resolve({ sentDigest: sha256(payload), gotDigest: sha256(got), equal: payload.equals(got), byteLength: got.length, payloadLength: payload.length });
          }
        });
        socket.on('error', () => { clearTimeout(timer); resolve({ error: true }); });
      });
      record('binaryRelayRoundTrip', roundTrip);
      check('a binary relay payload round-trips byte-for-byte over a real loopback socket with the real framing', {
        equal: roundTrip.equal, byteLength: roundTrip.byteLength, payloadLength: roundTrip.payloadLength,
        digestMatches: roundTrip.sentDigest === roundTrip.gotDigest, timedOut: roundTrip.timedOut === true, error: roundTrip.error === true,
      }, { equal: true, byteLength: BYTES.length + 5, payloadLength: BYTES.length + 5, digestMatches: true, timedOut: false, error: false });

      // H5 — a real open reaches ready only after the target hello, over the real loopback framing.
      const t5 = makeTransport({ secretName: 'secrets-h5', readAllocatedPort: async () => hello.port, targetHello: async () => ({ ok: true }) });
      const dialed = await t5.transport.open(PROFILE);
      const readyState = t5.transport.state(PROFILE.profileId);
      await dialed.close();
      const closedState = t5.transport.state(PROFILE.profileId);
      record('readyAfterHello', { ready: dialed.ready, readyState, closedState, forward: dialed.forward, connectionId: dialed.connectionId });
      check('a real open reaches ready only after the target hello succeeds, then closes on its owned process', {
        ready: dialed.ready, readyState, closedState, connectionId: dialed.connectionId,
        forwardPortIsHelloPort: dialed.forward.port === hello.port, environmentId: dialed.environmentId,
        environmentMatchesProfile: dialed.environmentId === resolveProfileEnvironment(PROFILE), stopTreeCalls: t5.stopTreeCount(),
      }, {
        ready: true, readyState: 'ready', closedState: 'closed', connectionId: `ssh-${PROFILE.profileId}`,
        forwardPortIsHelloPort: true, environmentId: resolveProfileEnvironment(PROFILE), environmentMatchesProfile: true, stopTreeCalls: 1,
      });

      // H6 — ExitOnForwardFailure success is NOT readiness when the target hello never confirms.
      const t6 = makeTransport({ secretName: 'secrets-h6', readAllocatedPort: async () => hello.port, targetHello: async () => ({ ok: false, error: 'no target hello' }) });
      let h6 = {}; try { await t6.transport.open(PROFILE); } catch (error) { h6 = { code: error.code, field: error.field }; }
      const h6Argv = t6.captured[0]?.args ?? [];
      record('forwardnotready', { h6, state: t6.transport.state(PROFILE.profileId) });
      check('ExitOnForwardFailure success is not treated as ready until the target hello succeeds', {
        code: h6.code, field: h6.field, stateIsReady: t6.transport.state(PROFILE.profileId) === 'ready',
        state: t6.transport.state(PROFILE.profileId), argvHasExitOnForwardFailure: hasPair(h6Argv, '-o', 'ExitOnForwardFailure=yes'), stopTreeCalls: t6.stopTreeCount(),
      }, { code: 'timeout', field: 'target.hello', stateIsReady: false, state: 'failed', argvHasExitOnForwardFailure: true, stopTreeCalls: 1 });

      // H7 — a dropped connection reconnects on a fresh owned process; a foreign id is never signalled.
      let stopTreeCount7 = 0;
      const relay = createProcessRelay({ platform: 'linux', spawn: () => fakeChild(7000), stopProcessTree: async () => { stopTreeCount7 += 1; } });
      const transport7 = createSshTransport({
        platform: 'linux', relay, configText: SSH_CONFIG, knownHostsText: '', hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_A }),
        persistKnownHost: async () => {}, secretDirectory: path.join(fixture.root, 'secrets-h7'), askpassPath: '/usr/lib/vis/askpass',
        responder: responderAccept, readAllocatedPort: async () => hello.port, targetHello: async () => ({ ok: true }),
      });
      const firstOpen = await transport7.open(PROFILE);
      const ownedBeforeClose = relay.ownedIds().length;
      await firstOpen.close();
      const ownedAfterClose = relay.ownedIds().length;
      const stateAfterClose = transport7.state(PROFILE.profileId);
      const foreignTerminate = await relay.terminate('not-owned');
      const secondOpen = await transport7.open(PROFILE);
      const ownedAfterReopen = relay.ownedIds().length;
      record('reconnect', { ownedBeforeClose, ownedAfterClose, stateAfterClose, foreignTerminate, ownedAfterReopen, secondReady: secondOpen.ready, stopTreeCount7 });
      check('a dropped connection reconnects on a fresh owned process and a foreign id is never signalled', {
        ownedBeforeClose, ownedAfterClose, stateAfterClose, foreignTerminate, ownedAfterReopen, secondReady: secondOpen.ready, stopTreeCalls: stopTreeCount7,
      }, { ownedBeforeClose: 1, ownedAfterClose: 0, stateAfterClose: 'closed', foreignTerminate: false, ownedAfterReopen: 1, secondReady: true, stopTreeCalls: 1 });

      // H8 — the argv actually handed to spawn on every platform is structured and secret-free.
      const perPlatform = {};
      for (const platform of ['darwin', 'linux', 'win32']) {
        const captured = [];
        const argvTransport = createSshTransport({
          platform, spawn: (command, args, options) => { captured.push({ command, args: [...args], shell: options?.shell, env: options?.env }); return fakeChild(8000 + captured.length); },
          stopProcessTree: async () => {}, configText: SSH_CONFIG, knownHostsText: '',
          hostKeyProvider: async () => ({ keyType: 'ssh-ed25519', keyBlob: KEY_A }), persistKnownHost: async () => {},
          secretDirectory: path.join(fixture.root, `secrets-argv-${platform}`), askpassPath: '/usr/lib/vis/askpass',
          responder: responderAccept, readAllocatedPort: async () => hello.port, targetHello: async () => ({ ok: true }),
        });
        const opened = await argvTransport.open(PROFILE);
        const call = captured[0];
        const flattened = [call.command, ...call.args].join(' ');
        const envValues = Object.values(call.env ?? {}).map(String);
        perPlatform[platform] = {
          command: call.command, argvIsArray: Array.isArray(call.args), shell: call.shell,
          argvHasSecret: call.args.filter((token) => token.includes(SECRET)).length,
          flattenedHasSecret: flattened.includes(SECRET), flattenedHasPassphrase: flattened.includes(PASSPHRASE),
          envHasSecret: envValues.filter((value) => value.includes(SECRET)).length,
          envHasAskpassPath: typeof call.env?.VIS_SSH_ASKPASS_FILE === 'string' && !call.env.VIS_SSH_ASKPASS_FILE.includes(SECRET),
          hasDashA: call.args.includes('-A'), ready: opened.ready,
        };
        await opened.close();
      }
      record('actualArgvPerPlatform', perPlatform);
      check('the argv actually handed to spawn on every platform is a structured array with no secret and no agent-forwarding flag', {
        darwin: perPlatform.darwin, linux: perPlatform.linux, win32: perPlatform.win32,
      }, {
        darwin: { command: 'ssh', argvIsArray: true, shell: false, argvHasSecret: 0, flattenedHasSecret: false, flattenedHasPassphrase: false, envHasSecret: 0, envHasAskpassPath: true, hasDashA: false, ready: true },
        linux: { command: 'ssh', argvIsArray: true, shell: false, argvHasSecret: 0, flattenedHasSecret: false, flattenedHasPassphrase: false, envHasSecret: 0, envHasAskpassPath: true, hasDashA: false, ready: true },
        win32: { command: 'ssh.exe', argvIsArray: true, shell: false, argvHasSecret: 0, flattenedHasSecret: false, flattenedHasPassphrase: false, envHasSecret: 0, envHasAskpassPath: true, hasDashA: false, ready: true },
      });
    }

    const browserErrors = await evaluate(() => window.task26.errors());
    check('the browser surface logged no error across the whole case', { errors: browserErrors.length }, { errors: 0 });

    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa26-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
    }

    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task26Errors ?? [], task26: Boolean(window.task26) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
    throw error;
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
  }
  const classMatchers = {
    stale_state: /state|ready|closed|authenticating/,
    cancel_resume: /cancel|reconnect|dropped/,
    malformed_input: /unknown|changed|hostile|over-long|oversize/,
    hung_commands: /hello|forward|readiness/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /interleaved|rejects|bounded/,
    misleading_success_output: /never argv|PATH \(never the value\)|not treated as ready|no secret/,
    flaky_tests: /exact|identical across platforms|single-use/,
  };
  const classEvidence = Object.fromEntries(Object.entries(classMatchers).flatMap(([name, pattern]) => {
    const matched = checks.filter((entry) => pattern.test(entry.name));
    return matched.length ? [[name, matched.map((entry) => ({ scenario: entry.name, artifact: path.join(runDir, 'proof.json'), numericObservable: { observed: entry.observed, expected: entry.expected } }))]] : [];
  }));
  return {
    scenarios, artifacts, adversarialClasses: Object.keys(classEvidence), classEvidence,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'ssh-auth-trust-bounded-transport' },
    cleanup: proof.cleanup,
    evidenceBoundary: 'The real landed bridge/runtime/transports modules (sshTransport.js, sshAuthentication.js, knownHosts.js, processRelay.js) execute directly in the Node worker. The only controlled boundaries are: the OS process edge (spawn/stopProcessTree are fakes, so no real ssh binary runs), the target hello (a local loopback net server speaking the REAL relay framing, not an sshd), and a real headless Chromium redaction/framing surface over case-owned node:* shims (app/dev/runtime-v090/task26.ts + scripts/qa/runtime-v090-cases/task-26-browser-shim.mjs). This case exercises key auth, first-trust confirmation, an authentication challenge, ssh_config alias/ProxyJump, a binary round-trip and reconnect-after-drop on the happy path, and unknown/changed key, bad credential, auth cancel, port collision, failed target hello and interleaved ssh stderr on the failure path. It does NOT perform or claim a live system-sshd verification — task 46 owns that — and it authors no PASS verdict.',
  };
}
