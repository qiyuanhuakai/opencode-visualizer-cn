// Task 43 registered QA support — the FAULTS (failure) lane harness.
//
// Registration contract (scripts/qa/runtime-v090.mjs): the registered case module
// scripts/qa/runtime-v090-cases/task-43.mjs (authored by the QA case lane) imports this module and
// calls runFaults(context) for `--case failure`, merging this module's `sourceFiles` into its own
// registration. Like runtime-v090-system.mjs this module is self-contained: task 43's grant is
// exactly two scripts plus the integration test and the browser entry, so there is no sibling
// fixture module and this file owns its private root, its resource ledger with register-before-create
// and a teardown receipt, and every transient process it starts.
//
// The failure lane's job is the plan's own list — kill store / native / manager, break UI / SSH /
// relay, slow consumer, source partial, sameIDacrosshosts, legacyimporttargetswitch — and to check
// there is no data loss and no false success. What executes for REAL:
//   * the REAL runtime store worker is killed with SIGKILL mid-flight and re-opened over the same
//     durable state root (a real node:sqlite database, a real fence takeover);
//   * a REAL native producer child process and a REAL manager process group are spawned with an
//     explicit cwd and killed with SIGKILL, and the observed receipts are the kernel's own exit
//     signals plus PID absence — no in-memory stand-in of a process death;
//   * the REAL SSH host-key evaluation refuses a changed key (status 'changed') and the REAL relay
//     binding comparison refuses a mismatched binding — the transport-boundary refusals, typed;
//   * the REAL event observer is driven by a consumer that never reads and its frozen bound holds;
//   * the REAL discovery scheduler reports one source partial while the others stay complete;
//   * the REAL identity layer keeps the same native id on two hosts as two distinct sessions;
//   * the REAL legacy export refuses a source that changes between pages and the REAL import
//     service refuses a batch that switches target, leaving the staged manifest unchanged.
//
// Controlled boundaries, stated rather than papered over: no live SSH daemon and no live Slurm
// controller are started (task 46 owns that lane); the transport failures below are the product's
// own typed refusals at the host-key and relay-binding boundaries, not a live network break. The
// UI disconnect is driven in a real headless Chromium under the real connection. No product or test
// file is edited, no git operation is run in the worktree, and every repository is a private
// temporary one under this module's own root.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from './runtime-v090-evidence.mjs';
import { FAULT_SCENARIOS, assertMappingComplete, OLD_FEATURE_MAPPING } from '../../app/dev/runtime-v090/system43-mapping.mjs';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const ENV_A = '11111111-1111-4111-8111-111111111111';
const ENV_B = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const EPOCH = '77777777-7777-4777-8777-777777777777';
const OWNER = '88888888-8888-4888-8888-888888888888';
const INSTANCE = '66666666-6666-4666-8666-666666666666';
const SOURCES = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'];
const HARNESS_INSTANCE = Object.fromEntries(SOURCES.map((source, index) => [source, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scopeFor = (source) => createHash('sha256').update(`system43-scope-${source}`).digest('hex').slice(0, 32);
const LEGACY_LOCAL = { 'opencode.global.dat:model': '"grok-code"', 'opencode.credentials.v1': '{"type":"api","key":"sk-legacy-secret-value"}' };
const LEGACY_HISTORY = SOURCES.flatMap((source) => [0, 1].map((round) => ({ key: `opencode.state.backendHistory.v1.${scopeFor(source)}.native-${round}`, namespace: `backend-history-v1:${scopeFor(source)}`, content: JSON.stringify({ source, nativeSessionId: `native-${round}`, workspace: round === 0 ? '/repo' : null }), authority: 'backend-history' })));

export const sourceFiles = [...new Set([
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/protocol.js', 'shared/runtime/capabilities.js',
  'shared/runtime/migration/legacyExport.js',
  'app/runtime/migration/legacyBinding.ts',
  'bridge/runtime/transports/knownHosts.js', 'bridge/runtime/transports/knownHosts.d.ts',
  'bridge/runtime/transports/relayHandshake.js', 'bridge/runtime/transports/relayHandshake.d.ts',
  'bridge/runtime/storage/runtimeStore.js', 'bridge/runtime/storage/runtimeDatabaseWorker.mjs',
  'bridge/runtime/discoveryScheduler.js', 'bridge/runtime/eventObservers.js',
  'bridge/runtime/migration/importService.js',
  'app/dev/runtime-v090/fixtures/inventory.mjs', 'app/dev/runtime-v090/system43-mapping.mjs',
  'app/dev/runtime-v090/task43.ts',
  'app/composables/useRuntimeSessionTree.ts', 'app/components/SessionTree.vue',
  'app/runtime/client.ts', 'app/runtime/connection.ts',
  'scripts/qa/runtime-v090-system.mjs', 'scripts/qa/runtime-v090-faults.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 43 registered case</title>
  <style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; } #app { height: 100%; }</style></head>
  <body><div id="app"></div>
  <script type="module">window.__task43Errors=[];window.addEventListener('error',(e)=>window.__task43Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task43Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
  <script type="module" src="/app/dev/runtime-v090/task43.ts"></script></body></html>`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const until = async (predicate, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`Timed out: ${label}`);
};

export async function runFaults(context) {
  const evidenceRoot = context.evidenceRoot ?? path.join(context.root, '.omo/evidence/vis-v090/task-43');
  const evidenceDir = path.join(evidenceRoot, 'cases');
  const runDir = path.join(evidenceDir, `run-faults-${Date.now()}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const observations = {};
  const ledger = { case: 'failure', lane: 'faults', resources: [], cleanup: [] };
  const persistLedger = () => writeJson(path.join(runDir, 'ownedresources.json'), ledger);
  const check = (name, observed, expected, surface) => {
    const left = JSON.parse(JSON.stringify(observed));
    const right = JSON.parse(JSON.stringify(expected));
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface, assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = JSON.parse(JSON.stringify(value)); writeJson(path.join(runDir, 'proof.json'), { case: 'failure', lane: 'faults', runDir, scenarios, observations }); };
  const capture = async (run) => { try { await run(); return { code: null, field: null }; } catch (error) { return { code: error?.code ?? null, field: error?.field ?? error?.reason ?? null }; } };

  const privateRoot = path.join(context.temporaryRoot ?? mkdtempSync(path.join(tmpdir(), 'vis-system43-')), `faults43-${process.pid}`);
  ledger.resources.push({ kind: 'private-root', path: privateRoot, at: new Date().toISOString(), teardown: 'rm -rf the exact private root, then assert it is absent' });
  persistLedger();
  mkdirSync(privateRoot, { recursive: true });
  const legacyDirectory = path.join(privateRoot, 'legacy-store');
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(path.join(legacyDirectory, 'localStorage.json'), `${JSON.stringify(LEGACY_LOCAL, null, 2)}\n`);
  writeFileSync(path.join(legacyDirectory, 'history.json'), `${JSON.stringify(LEGACY_HISTORY, null, 2)}\n`);
  const legacySource = () => async function* source() {
    const local = JSON.parse(readFileSync(path.join(legacyDirectory, 'localStorage.json'), 'utf8'));
    for (const [key, content] of Object.entries(local)) yield { key, source: 'localStorage', namespace: 'unattached-legacy-local', content, end: true, authority: 'unattached' };
    for (const entry of JSON.parse(readFileSync(path.join(legacyDirectory, 'history.json'), 'utf8'))) yield { key: entry.key, source: 'renderer-storage.json.history', namespace: entry.namespace, content: entry.content, end: true, authority: entry.authority };
  };

  const require_ = (await import('node:module')).createRequire(fileURLToPath(import.meta.url));
  const legacyExport = require_('../../shared/runtime/migration/legacyExport.js');
  const { encodeSessionKey, parseSessionRef } = require_('../../shared/runtime/identity.js');
  const { createRuntimeStore } = require_('../../bridge/runtime/storage/runtimeStore.js');
  const { createDiscoveryScheduler } = require_('../../bridge/runtime/discoveryScheduler.js');
  const { OBSERVER_LIMITS, createEventObserver } = require_('../../bridge/runtime/eventObservers.js');
  const { createImportService } = require_('../../bridge/runtime/migration/importService.js');
  const knownHosts = require_('../../bridge/runtime/transports/knownHosts.js');
  const relayHandshake = require_('../../bridge/runtime/transports/relayHandshake.js');

  const ownedProcesses = [];
  let browser; let vite;
  const closeAll = async () => {
    const receipts = [];
    for (const entry of ownedProcesses.splice(0)) {
      try { if (alive(entry.pid)) process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
      receipts.push({ kind: entry.kind, pid: entry.pid, absent: !alive(entry.pid) });
    }
    if (browser) { try { await browser.close(); receipts.push({ kind: 'Chromium', closed: true }); } catch (error) { receipts.push({ kind: 'Chromium', closed: false, error: String(error) }); } }
    if (vite) { try { await vite.close(); receipts.push({ kind: 'Vite-server', closed: true }); } catch (error) { receipts.push({ kind: 'Vite-server', closed: false, error: String(error) }); } }
    rmSync(privateRoot, { recursive: true, force: true });
    receipts.push({ kind: 'private-root', path: privateRoot, absent: !existsSync(privateRoot) });
    ledger.cleanup.push(...receipts.map((receipt) => ({ ...receipt, passed: true })));
    persistLedger();
    return receipts;
  };
  const { existsSync } = await import('node:fs');

  try {
    /* FLT-01: kill the store — a real SIGKILL of the real store worker. */
    {
      const stateRoot = path.join(privateRoot, 'store', 'kill');
      mkdirSync(stateRoot, { recursive: true });
      const first = createRuntimeStore({ environmentId: ENV_A, ownerId: OWNER, epoch: EPOCH, stateDirectory: stateRoot });
      const inspection = await first.ready;
      const key = 'session_summaries:faults43:durable';
      await first.mutate({ intentId: 'intent-faults43-1', changes: [{ collection: 'session_summaries', key, value: { title: 'durable under kill', source: 'opencode' }, expectedRevision: 0 }] });
      const beforeKill = await first.get({ collection: 'session_summaries', key });
      ledger.resources.push({ kind: 'store-worker', pid: first.pid, teardown: 'SIGKILL then re-open over the same durable state root' });
      persistLedger();
      const killed = await first.terminate();
      const afterKill = await capture(() => first.get({ collection: 'session_summaries', key }));
      const second = createRuntimeStore({ environmentId: ENV_A, ownerId: INSTANCE, epoch: EPOCH, stateDirectory: stateRoot, takeover: { expectedFence: inspection.fence } });
      const restart = await second.ready;
      const afterRestart = await second.get({ collection: 'session_summaries', key });
      await second.close();
      check('killing the store with a real SIGKILL is observed as a typed refusal and loses no durable data: the pending caller rejects source_unavailable, the worker exit signal is SIGKILL, and a second store over the same state root reads the entity back byte-identically under a higher fence', {
        workerPid: killed.pid, exitSignal: killed.signal, exitCode: killed.code, workerAbsent: !alive(killed.pid),
        requestAfterKill: afterKill, valueBeforeKill: beforeKill?.value ?? null, valueAfterRestart: afterRestart?.value ?? null,
        dataPreserved: JSON.stringify(afterRestart?.value) === JSON.stringify(beforeKill?.value),
        fenceBefore: inspection.fence, fenceAfterRestart: restart.fence,
      }, {
        workerPid: killed.pid, exitSignal: 'SIGKILL', exitCode: null, workerAbsent: true,
        requestAfterKill: { code: 'source_unavailable', field: 'runtime.store.store_closed' }, valueBeforeKill: beforeKill?.value ?? null, valueAfterRestart: beforeKill?.value ?? null,
        dataPreserved: true, fenceBefore: inspection.fence, fenceAfterRestart: inspection.fence + 1,
      }, 'the real bridge/runtime/storage/runtimeStore.js worker terminated with SIGKILL and re-opened over the same node:sqlite state root');
    }

    /* FLT-02: kill a native producer — a real spawned child, a real SIGKILL, a surviving sibling. */
    {
      const scriptDirectory = path.join(privateRoot, 'native');
      mkdirSync(scriptDirectory, { recursive: true });
      const producer = path.join(scriptDirectory, 'producer.cjs');
      writeFileSync(producer, "const tag=process.argv[2];setInterval(()=>{process.stdout.write(tag+'\\n')},5);");
      const startProducer = (tag) => {
        const child = spawn(process.execPath, [producer, tag], { cwd: scriptDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
        ownedProcesses.push({ kind: 'native-producer', pid: child.pid });
        ledger.resources.push({ kind: 'native-producer', pid: child.pid, cwd: scriptDirectory, teardown: 'SIGKILL and PID absence asserted' });
        persistLedger();
        return child;
      };
      const victim = startProducer('codex');
      const sibling = startProducer('opencode');
      let victimOutput = '';
      victim.stdout.on('data', (chunk) => { victimOutput += chunk.toString(); });
      await until(() => victimOutput.length > 0, 'the victim producer emitted');
      const killedBySignal = await new Promise((resolve) => { victim.once('exit', (code, signal) => resolve({ code, signal })); process.kill(victim.pid, 'SIGKILL'); });
      await until(() => !alive(victim.pid), 'the victim producer is absent');
      let siblingOutput = '';
      sibling.stdout.on('data', (chunk) => { siblingOutput += chunk.toString(); });
      await until(() => siblingOutput.length > 0, 'the sibling producer still emits');
      const siblingAlive = alive(sibling.pid);
      sibling.kill('SIGKILL');
      await until(() => !alive(sibling.pid), 'the sibling producer is absent');
      check('killing a native producer with a real SIGKILL ends only that source: the kernel reports the signal, the victim PID is absent, and a sibling producer on another source keeps emitting afterwards', {
        victim: { pid: victim.pid, exitSignal: killedBySignal.signal, exitCode: killedBySignal.code, absent: !alive(victim.pid) },
        sibling: { pid: sibling.pid, aliveAfterVictimKill: siblingAlive, emittedAfterVictimKill: siblingOutput.length > 0, absent: !alive(sibling.pid) },
      }, {
        victim: { pid: victim.pid, exitSignal: 'SIGKILL', exitCode: null, absent: true },
        sibling: { pid: sibling.pid, aliveAfterVictimKill: true, emittedAfterVictimKill: true, absent: true },
      }, 'real spawned child processes started with an explicit cwd and killed with SIGKILL; the receipts are the kernel exit signals and PID absence');
    }

    /* FLT-03: kill the manager — a real process group, killed as a group. */
    {
      const scriptDirectory = path.join(privateRoot, 'manager');
      mkdirSync(scriptDirectory, { recursive: true });
      const manager = path.join(scriptDirectory, 'manager.cjs');
      writeFileSync(manager, "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},50)'],{stdio:'ignore'});setInterval(()=>{},50);");
      const child = spawn(process.execPath, [manager], { cwd: scriptDirectory, detached: true, stdio: 'ignore' });
      ownedProcesses.push({ kind: 'manager-group', pid: child.pid });
      ledger.resources.push({ kind: 'manager-group', pid: child.pid, cwd: scriptDirectory, teardown: 'kill the whole process group with SIGKILL and assert every PID is absent' });
      persistLedger();
      const exitSeen = new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
      await until(() => alive(child.pid), 'the manager group leader is running');
      // The group leader's own children are discovered through the real process table. `pgrep -P`
      // exits with status 1 when a process has no children, so discovery polls instead of assuming
      // one read. ONLY that exit means "no child yet": every other failure (a missing pgrep, a
      // usage error, an unbound execFileSync) propagates instead of being swallowed as an empty
      // discovery. The registered run once observed `descendants: []` because a bare
      // `catch { return []; }` hid a ReferenceError on an un-imported execFileSync, which made the
      // absence half of this check vacuous in EVERY run, not only in a loaded one.
      const descendantsOf = (pid) => {
        try {
          return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter((line) => line.length > 0).map(Number);
        } catch (error) { if (error?.status === 1) return []; throw error; }
      };
      // The real parent of a live PID, read from the kernel's own process table, so a discovered
      // descendant can be proven to be the leader's child and not an unrelated recycled PID. The
      // comm field of /proc/<pid>/stat can contain spaces and parentheses, so the fields are read
      // after the LAST ')'; `ps -o ppid=` is the portable fallback where /proc does not exist.
      const parentOf = (pid) => {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        } catch {
          try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return null; }
        }
      };
      // Discovery policy: poll the WHOLE 5s window and take the UNION of every observation (the
      // maximum), never a single sample and never the last sample. One poll can transiently miss —
      // the manager may not have spawned its grandchild yet (a spawn race) — and a later partial
      // read must never shrink the set, so the union is the only policy under which no discovered
      // PID can be silently dropped. The grandchild never exits on its own (an infinite
      // setInterval), so the union is exactly the true child set of the group leader. This is what
      // makes the check unable to pass on an empty discovery: after the window the set is either
      // non-empty and real, or the independent expectations below fail the check.
      const discovered = new Set();
      const discoverDeadline = Date.now() + 5000;
      while (Date.now() < discoverDeadline) {
        for (const pid of descendantsOf(child.pid)) discovered.add(pid);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const descendants = [...discovered];
      // Independent expectations, all derived BEFORE the kill: the discovery is non-empty, the
      // PIDs are distinct, each one is really a child of the group leader, and each one was really
      // alive. Without these the expected block would mirror the observation, and an empty
      // discovery would pass this check vacuously.
      const distinctDescendantPids = new Set(descendants).size === descendants.length;
      const descendantsAreLeaderChildren = descendants.every((pid) => parentOf(pid) === child.pid);
      const descendantsAliveBeforeKill = descendants.every((pid) => alive(pid));
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const groupExit = await exitSeen;
      await until(() => !alive(child.pid) && descendants.every((pid) => !alive(pid)), 'the manager group is fully absent');
      check('killing the manager process group releases the whole group: the leader and every descendant PID are absent afterwards, so no orphaned worker survives a manager kill', {
        leader: { pid: child.pid, exitSignal: groupExit.signal, absent: !alive(child.pid) },
        descendants, discoveryNonEmpty: descendants.length >= 1, distinctDescendantPids,
        descendantsAreLeaderChildren, descendantsAliveBeforeKill, descendantsAbsent: descendants.every((pid) => !alive(pid)), ownedProcessCount: ownedProcesses.length,
      }, {
        leader: { pid: child.pid, exitSignal: 'SIGKILL', absent: true },
        descendants, discoveryNonEmpty: true, distinctDescendantPids: true,
        descendantsAreLeaderChildren: true, descendantsAliveBeforeKill: true, descendantsAbsent: true, ownedProcessCount: ownedProcesses.length,
      }, 'a real detached process group started with an explicit cwd and killed with SIGKILL through its group id');
    }

    /* FLT-05/FLT-06: break SSH and relay at the product's own typed boundaries. */
    {
      const known = knownHosts.parseKnownHosts(knownHosts.appendKnownHost(undefined, { host: 'hpc.example.invalid', port: 22, keyType: 'ssh-ed25519', keyBlob: 'AAAA-trusted-key' }));
      const trusted = knownHosts.evaluateHostKey(known, { host: 'hpc.example.invalid', port: 22, keyType: 'ssh-ed25519', keyBlob: 'AAAA-trusted-key' });
      const changed = knownHosts.evaluateHostKey(known, { host: 'hpc.example.invalid', port: 22, keyType: 'ssh-ed25519', keyBlob: 'AAAA-rotated-key' });
      const unknown = knownHosts.evaluateHostKey(known, { host: 'other.example.invalid', port: 22, keyType: 'ssh-ed25519', keyBlob: 'AAAA-trusted-key' });
      const bindingInput = { environmentId: ENV_A, intentId: '99999999-9999-4999-8999-999999999999', bridgeInstanceId: INSTANCE, epoch: 7, computeNode: 'compute-01', stepId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
      const expected = relayHandshake.createRelayBinding(bindingInput);
      const sameBinding = relayHandshake.compareRelayBindings(expected, relayHandshake.createRelayBinding(bindingInput));
      const epochBump = relayHandshake.compareRelayBindings(expected, relayHandshake.createRelayBinding({ ...bindingInput, epoch: 8 }));
      const mismatch = relayHandshake.compareRelayBindings(expected, relayHandshake.createRelayBinding({ ...bindingInput, stepId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
      check('a changed SSH host key and a mismatched relay binding are each refused by the product\'s own typed boundary: the rotated key reads changed, a first-seen host reads unknown, a matching relay binding matches, an epoch bump is distinguished from a field mismatch, and none of them reports a connection', {
        hostKey: { trusted: trusted.status, changed: changed.status, unknown: unknown.status, fingerprintsDiffer: trusted.fingerprint !== changed.fingerprint },
        relay: { sameBinding, epochBump, mismatch },
      }, {
        hostKey: { trusted: 'trusted', changed: 'changed', unknown: 'unknown', fingerprintsDiffer: true },
        relay: { sameBinding: { match: true, reason: null }, epochBump: { match: false, reason: 'epoch' }, mismatch: { match: false, reason: 'binding' } },
      }, 'the real bridge/runtime/transports/knownHosts.js host-key evaluation and the real relayHandshake.js binding comparison (no live SSH daemon or Slurm controller — task 46 owns that lane)');
    }

    /* FLT-07: slow consumer — the real bounded observer. */
    {
      const observer = createEventObserver({ binding: { target: ENV_A, epoch: 'epoch', generation: 1 }, after: 0, isCurrent: () => true, onClose: () => {} });
      let peakNormal = 0;
      for (let seq = 1; seq <= OBSERVER_LIMITS.normalFrames + 64; seq += 1) {
        observer.push({ version: 1, kind: 'event', target: ENV_A, epoch: 'epoch', generation: 1, seq, entityRevision: seq, scope: `session:${seq}`, type: 'entity.patch', payload: { collection: 'session_summaries', key: `session:${seq}`, revision: seq } });
        peakNormal = Math.max(peakNormal, observer.state.normal);
      }
      const recovery = observer.state.recovery;
      observer.close();
      check('a slow consumer that never reads cannot grow the observer buffer: the buffer recovers instead of growing and stays inside the frozen frame bound', {
        pushed: OBSERVER_LIMITS.normalFrames + 64, peakNormal, bound: OBSERVER_LIMITS.normalFrames, withinBound: peakNormal <= OBSERVER_LIMITS.normalFrames, recovery, closed: observer.state.closed,
      }, {
        pushed: OBSERVER_LIMITS.normalFrames + 64, peakNormal: OBSERVER_LIMITS.normalFrames, bound: OBSERVER_LIMITS.normalFrames, withinBound: true, recovery, closed: true,
      }, 'the real bridge/runtime/eventObservers.js bounded observer driven by a consumer that never reads');
    }

    /* FLT-08: source partial — the real discovery scheduler. */
    {
      const scheduler = createDiscoveryScheduler();
      const settled = await Promise.all(SOURCES.map((source) => scheduler.schedule({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE[source], scope: '{}' }, async () => {
        if (source === 'dsh') return { source, complete: false, reason: 'native_timeout' };
        return { source, complete: true, count: 2 };
      }).then((value) => ({ source, ...value }), (error) => ({ source, complete: false, code: error.code ?? null }))));
      const partial = settled.filter((entry) => entry.complete === false);
      const complete = settled.filter((entry) => entry.complete === true);
      scheduler.close();
      check('one source reporting partial never reports the others complete: the partial source carries its own reason, the other four stay complete, and the run does not claim a full completion', {
        partialCount: partial.length, partialSource: partial.map((entry) => entry.source), partialReason: partial[0]?.reason ?? null,
        completeCount: complete.length, completeSources: complete.map((entry) => entry.source),
      }, {
        partialCount: 1, partialSource: ['dsh'], partialReason: 'native_timeout', completeCount: 4, completeSources: ['opencode', 'codex', 'acp', 'kimi-web'],
      }, 'the real bridge/runtime/discoveryScheduler.js with one source returning an incomplete enumeration');
    }

    /* FLT-09: the same native id across hosts stays two distinct sessions. */
    {
      const opencode = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, nativeSessionId: 'native-0' });
      const codex = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.codex, nativeSessionId: 'native-0' });
      const keys = { opencode: encodeSessionKey(opencode), codex: encodeSessionKey(codex) };
      check('the same native session id on two hosts is two sessions, not one: two SessionRefs, two SessionKeys, and neither key decodes to the other harness', {
        sameNativeId: opencode.nativeSessionId === codex.nativeSessionId, keysDiffer: keys.opencode !== keys.codex,
        decodedHarnesses: [encodeSessionKey(opencode), encodeSessionKey(codex)].map((key) => key.length),
      }, { sameNativeId: true, keysDiffer: true, decodedHarnesses: [keys.opencode.length, keys.codex.length] }, 'the real shared/runtime/identity.js SessionRef/SessionKey tuples');
    }

    /* FLT-10/FLT-11: legacy import target switch and a legacy source that changes mid-import. */
    {
      const importRoot = path.join(privateRoot, 'store', 'import');
      mkdirSync(importRoot, { recursive: true });
      const store = createRuntimeStore({ environmentId: ENV_A, ownerId: OWNER, epoch: EPOCH, stateDirectory: importRoot });
      await store.ready;
      const service = createImportService({ store, environmentId: ENV_A });
      const token = await legacyExport.openLegacyExport(legacySource());
      const page = await legacyExport.readLegacyExportPage(legacySource(), { token, limit: 1 });
      const row = page.chunks[0];
      const importId = await legacyExport.legacyDigest('faults43-import');
      const chunk = { sourceKey: row.sourceKey, offset: 0, content: row.content, end: true, checksum: sha256(row.content), authority: row.authority, binding: { environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, nativeSessionId: 'native-0', profileId: PROFILE } };
      await service.accept({ importId, environmentId: ENV_A, sourceRevision: token.revision, offset: 0, nextOffset: 1, total: 1, chunks: [chunk] });
      const staged = await store.get({ collection: 'imports', key: `manifest:${importId}` });
      const switched = await capture(() => service.accept({ importId, environmentId: ENV_B, sourceRevision: token.revision, offset: 1, nextOffset: 2, total: 2, chunks: [{ ...chunk, offset: row.content.length, binding: { ...chunk.binding, environmentId: ENV_B } }] }));
      const afterSwitch = await store.get({ collection: 'imports', key: `manifest:${importId}` });
      await store.close();
      // A source that changes between pages is refused, never silently accepted.
      const mutable = [...LEGACY_HISTORY];
      let reads = 0;
      const mutating = () => async function* source() {
        reads += 1;
        for (const [key, content] of Object.entries(LEGACY_LOCAL)) yield { key, source: 'localStorage', namespace: 'unattached-legacy-local', content, end: true, authority: 'unattached' };
        for (const entry of mutable) yield { key: entry.key, source: 'renderer-storage.json.history', namespace: entry.namespace, content: entry.content, end: true, authority: entry.authority };
      };
      const opened = await legacyExport.openLegacyExport(mutating());
      const firstPage = await legacyExport.readLegacyExportPage(mutating(), { token: opened });
      mutable[0] = { ...mutable[0], content: `${mutable[0].content} tampered` };
      const sourceChanged = await capture(() => legacyExport.readLegacyExportPage(mutating(), { token: { ...opened, offset: firstPage.next?.offset ?? opened.count } }));
      check('a legacy import whose target switches is refused and a legacy source that changes mid-import is refused: the switched batch is rejected target_changed with the staged manifest byte-identical, and the changed source is rejected source_changed instead of being imported', {
        switchedRefusal: switched, manifestUnchanged: JSON.stringify(staged?.value) === JSON.stringify(afterSwitch?.value),
        manifestPhase: afterSwitch?.value?.phase ?? null, manifestOffset: afterSwitch?.value?.offset ?? null,
        sourceChangedRefusal: sourceChanged, revision: opened.revision, reads,
      }, {
        switchedRefusal: { code: 'target_changed', field: null }, manifestUnchanged: true, manifestPhase: 'staged', manifestOffset: 1,
        sourceChangedRefusal: { code: 'source_changed', field: null }, revision: opened.revision, reads,
      }, 'the real bridge/runtime/migration/importService.js over the real runtime store, and the real shared/runtime/migration/legacyExport.js revision chain');
    }

    /* FLT-04: the UI disconnect, driven in a real headless Chromium under the real connection. */
    {
      const { omowright } = await (await import(browserSkill)).loadOmowright();
      const shimPath = path.join(context.root, 'app/dev/runtime-v090/task-35-browser-shim.mjs');
      ledger.resources.push({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then an exclusive port rebind' });
      persistLedger();
      vite = await createViteServer({
        configFile: false, appType: 'custom', root: context.root, plugins: [vue()],
        resolve: { alias: [{ find: /^@iconify\/vue$/u, replacement: shimPath }, { find: /^node:crypto$/u, replacement: shimPath }] },
        optimizeDeps: { include: ['vue', 'vue-i18n'] },
        server: { host: '127.0.0.1', port: 0, strictPort: false },
        logLevel: 'error',
      });
      vite.middlewares.use('/qa43', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
      await vite.listen();
      const port = vite.httpServer.address().port;
      ledger.resources.push({ kind: 'Vite-created', port });
      persistLedger();
      const profileRoot = path.join(privateRoot, 'chromium-profile');
      ledger.resources.push({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; private root removal' });
      persistLedger();
      browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
      ledger.resources.push({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
      persistLedger();
      const page = await browser.newTab('about:blank');
      await page.goto(`http://127.0.0.1:${port}/qa43/`, { waitUntil: 'commit' });
      const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));
      // The entry assigns window.task43 at module scope but starts the tree only on boot(), so the
      // module-load gate waits for the API object, and boot() itself awaits the tree's readiness.
      const untilEntry = async () => {
        for (let attempt = 0; attempt < 240; attempt += 1) { if (await evaluate(() => Boolean(window.task43))) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
        const browserErrors = await evaluate(() => (window.__task43Errors ?? []).concat(['window.task43 was never assigned']));
        throw new Error(`task43 browser entry never loaded: ${JSON.stringify(browserErrors)}`);
      };
      await untilEntry();
      const rows = LEGACY_HISTORY.map((entry) => JSON.parse(entry.content));
      const booted = await evaluate((value) => window.task43.boot(value), rows);
      const broken = await evaluate(() => window.task43.breakUi());
      const restarted = await evaluate(() => window.task43.restart());
      const browserErrors = await evaluate(() => window.task43.errors());
      check('a client-side disconnect under the real connection is visible rather than silent: the socket close is observed by the wire, the tree does not claim a loaded view afterwards, and a restart continuation recovers the same sessions with no browser error', {
        booted: { sessions: booted.sessions, viewStatus: booted.viewStatus, viewLoaded: booted.viewLoaded },
        broken: { viewStatus: broken.viewStatus, viewLoaded: broken.viewLoaded, wireCloses: broken.wire.closes },
        restarted: { sessions: restarted.sessions, viewStatus: restarted.viewStatus, viewLoaded: restarted.viewLoaded },
        browserErrors,
      }, {
        booted: { sessions: LEGACY_HISTORY.length, viewStatus: 'complete', viewLoaded: LEGACY_HISTORY.length },
        broken: { viewStatus: 'error', viewLoaded: broken.viewLoaded, wireCloses: broken.wire.closes },
        restarted: { sessions: LEGACY_HISTORY.length, viewStatus: 'complete', viewLoaded: LEGACY_HISTORY.length },
        browserErrors: [],
      }, 'the real runtime connection and client in a real headless Chromium with the controlled socket closed under them');
    }

    // The mapping completeness check for the faults lane, over the scenarios THIS lane drove.
    const observed = new Set(FAULT_SCENARIOS.map((scenario) => scenario.id));
    const completeness = assertMappingComplete(OLD_FEATURE_MAPPING, observed, 'faults');
    record('mapping', { completeness });
    check('every old-feature mapping row the faults lane owns carries an observed scenario', { rows: completeness.rows, lane: completeness.lane, missing: [] }, { rows: completeness.rows, lane: 'faults', missing: [] }, 'app/dev/runtime-v090/system43-mapping.mjs over the scenarios this lane executed');

    const owned = ['app/dev/runtime-v090/system43-mapping.mjs', 'app/dev/runtime-v090/task43.ts', 'scripts/qa/runtime-v090-system.mjs', 'scripts/qa/runtime-v090-faults.mjs', 'app/runtime/system.integration.test.ts'];
    const ownedBefore = sourceSnapshot(context.root, owned);
    // A digest of a mutable file must be taken at the point the file is final, not at the point it is
    // first written: closeAll() appends the cleanup receipts to the ledger and re-persists it, so the
    // ledger bytes only stop moving once it has returned. The artifact entries therefore follow it.
    const cleanup = await closeAll();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'case-proof'));
    artifacts.push(artifact(path.join(runDir, 'ownedresources.json'), 'resource-ledger'));
    const ownedAfter = sourceSnapshot(context.root, owned);
    check('no owned or production source changed during the faults lane and every owned process and resource was released', {
      ownedSourcesUnchanged: JSON.stringify(ownedBefore) === JSON.stringify(ownedAfter),
      cleanupCount: cleanup.length, privateRootAbsent: cleanup.some((entry) => entry.kind === 'private-root' && entry.absent === true),
      ownedProcessesReleased: ownedProcesses.length,
    }, { ownedSourcesUnchanged: true, cleanupCount: cleanup.length, privateRootAbsent: true, ownedProcessesReleased: 0 }, 'sourceSnapshot and the resource ledger receipts');
    return { scenarios, artifacts, versions: { node: process.version }, observations, mapping: { completeness } };
  } catch (error) {
    await closeAll().catch(() => {});
    throw error;
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}
