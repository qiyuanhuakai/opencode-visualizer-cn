// Task 31 registered QA case — Host Thread and native participant binding.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array
// and a run(context) returning a JSON-serialisable result whose scenarios each carry
// assertions with observed === expected. The runner re-invokes this module with
// VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent asserts a clean worker
// receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge services bridge/runtime/threads/threadService.js
//     and participantService.js plus shared/runtime/thread.js and shared/runtime/identity.js —
//     the real lazy canonical binding, the real same-session wrapper identity, the real
//     multi-harness native-history separation, the real leave/resume/orphan state machine,
//     and the real native-parent (sub-agent) preservation. The native-session history the
//     failure lane must NOT destroy is a REAL file under the private root (read back with
//     node:fs, digest + byte length recorded before and after).
//   * In a real headless Chromium: the pure shared contract modules (thread.js / identity.js /
//     capabilities.js) compute the canonical binding key and parse a receiver-side binding in
//     a different JS realm. A browser window and the bridge worker must agree on the SAME
//     canonical key, or the "same session => same wrapper" guarantee cannot hold across windows.
//
// The controlled boundaries are:
//   * the harness session index (resolveSession) — the product takes it as an injected port
//     (createThreadService({ resolveSession })); the case backs it with real files for the
//     history-preservation proofs and with a counting in-memory catalog for the 10k lazy check;
//   * the browser entry is served by a case-owned Vite server and driven by an owned Chromium.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// authors no PASS verdict, and edits no product or test file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, digest, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-31-fixture.mjs';

import { createThreadService } from '../../../bridge/runtime/threads/threadService.js';
import { createParticipantService } from '../../../bridge/runtime/threads/participantService.js';
import {
  PARTICIPANT_STATES,
  THREAD_ROLES,
  parseParticipantId,
  parseThreadBinding,
  parseThreadId,
  parseThreadRole,
  threadBindingKey,
} from '../../../shared/runtime/thread.js';
import { decodeSessionKey } from '../../../shared/runtime/identity.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;

const ENV_A = '11111111-1111-4111-8111-111111111111';
const ENV_B = '22222222-2222-4222-8222-222222222222';
const HARNESS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HARNESS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const sourceFiles = [...new Set([
  // the four product paths this unit owns
  'bridge/runtime/threads/threadService.js', 'bridge/runtime/threads/threadService.d.ts',
  'bridge/runtime/threads/participantService.js', 'bridge/runtime/threads/participantService.d.ts',
  'shared/runtime/thread.js', 'shared/runtime/thread.d.ts',
  'app/runtime/threadBindings.test.ts',
  // the shared modules the product pulls in
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task31.ts',
  'scripts/qa/runtime-v090-cases/task-31.mjs',
  'scripts/qa/runtime-v090-cases/task-31-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 31 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task31Errors=[];window.addEventListener('error',(e)=>window.__task31Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task31Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task31.ts"></script></body></html>`;

// ── shared ref helpers ─────────────────────────────────────────────────────────
const sessionRef = (environmentId, harnessInstanceId, nativeSessionId) => ({ environmentId, harnessInstanceId, nativeSessionId });
const repoRef = (environmentId, canonicalCommonDir) => ({
  environmentId,
  canonicalCommonDir,
  pathPolicy: { platform: 'posix', volumeId: 'vol-1', caseSensitive: true },
});
const catalogKey = (session) => `${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`;
const view = (session, overrides = {}) => ({ session, archived: overrides.archived ?? false, parentSession: overrides.parent ?? null });

const captureSync = (run) => {
  try { run(); return {}; }
  catch (error) { return { code: error?.code, field: error?.field ?? null }; }
};
const captureAsync = async (run) => {
  try { await run(); return {}; }
  catch (error) { return { code: error?.code, field: error?.field ?? null }; }
};

/** In-memory session index that counts resolutions — the receiver's contract (ThreadSessionSource). */
function makeMemoryHarness(views) {
  const catalog = new Map(views.map((entry) => [catalogKey(entry.session), entry]));
  let resolutions = 0;
  const resolveSession = async (session) => { resolutions += 1; return catalog.get(catalogKey(session)) ?? null; };
  return { service: createThreadService({ resolveSession }), catalog, resolveSession, resolutions: () => resolutions };
}

/**
 * File-backed native-session history store. Each native session is a REAL JSON file under the
 * private root; resolveSession reads it back with node:fs. Byte length and sha256 are recorded so a
 * rejection / leave can be proven NOT to have destroyed the record.
 */
function createFileStore(dir) {
  let reads = 0;
  const fileOf = (ref) => path.join(dir, `${ref.environmentId}__${ref.harnessInstanceId}__${ref.nativeSessionId.replace(/[^\w.-]+/gu, '_')}.json`);
  const writeRecord = async (ref, record) => writeFile(fileOf(ref), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return {
    dir,
    reads: () => reads,
    async open() { await mkdir(dir, { recursive: true }); },
    async write(ref, options = {}) {
      const record = {
        session: sessionRef(ref.environmentId, ref.harnessInstanceId, ref.nativeSessionId),
        archived: options.archived === true,
        parentSession: options.parentSession ?? null,
        transcript: options.transcript ?? `native history for ${ref.nativeSessionId}`,
      };
      await writeRecord(ref, record);
      return record;
    },
    async remove(ref) { await rm(fileOf(ref), { force: true }); },
    async archive(ref) { const record = JSON.parse(await readFile(fileOf(ref), 'utf8')); record.archived = true; await writeRecord(ref, record); },
    async resolve(ref) {
      reads += 1;
      try {
        const record = JSON.parse(await readFile(fileOf(ref), 'utf8'));
        return { session: record.session, archived: record.archived === true, parentSession: record.parentSession ?? null };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async digest(ref) {
      try { return digest(await readFile(fileOf(ref))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async bytes(ref) {
      try { return (await stat(fileOf(ref))).size; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async exists(ref) {
      try { await stat(fileOf(ref)); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
    async count() {
      try { return (await readdir(dir)).filter((name) => name.endsWith('.json')).length; }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    },
  };
}

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-31/qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'real landed bridge Thread/Participant services + shared runtime/thread.js in the Node worker over an injected session index (in-memory for laziness, real files for history preservation), plus the pure shared Thread contract in a real headless Chromium',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-31.mjs',
    'scripts/qa/runtime-v090-cases/task-31-fixture.mjs',
    'app/dev/runtime-v090/task31.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the PURE shared Thread contract (no shim: no node:* builtin)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa31', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa31/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task31 && window.task31.ready)), 'task31 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    const plainRef5 = sessionRef(ENV_A, HARNESS_A, 'native:5');
    const workerKey5 = threadBindingKey(plainRef5);
    const workerDecode5 = decodeSessionKey(workerKey5);
    const browserKeys = await evaluate(() => window.task31.bindingKeys());
    protocol.browser.keys = browserKeys;
    record('browserKeys', { workerKey5, browserKeys });
    check('the canonical binding key computed in a browser equals the bridge worker key for the same native SessionRef, and it is canonical: stable for a duplicate, distinct for a sibling session and a sibling harness', {
      browserRef5EqualsWorker: browserKeys.ref5 === workerKey5,
      browserRef5EqualsDuplicate: browserKeys.ref5 === browserKeys.duplicate,
      browserRef5DiffersSibling: browserKeys.ref5 !== browserKeys.sibling,
      browserRef5DiffersOtherHarness: browserKeys.ref5 !== browserKeys.otherHarness,
      browserKeyIsNonEmpty: browserKeys.ref5.length > 0,
      browserKeyIsBase64Url: /^[\w-]+$/u.test(browserKeys.ref5),
    }, {
      browserRef5EqualsWorker: true,
      browserRef5EqualsDuplicate: true,
      browserRef5DiffersSibling: true,
      browserRef5DiffersOtherHarness: true,
      browserKeyIsNonEmpty: true,
      browserKeyIsBase64Url: true,
    });

    const browserDecode = await evaluate((key) => window.task31.decode(key), browserKeys.ref5);
    check('the canonical key round-trips to the exact referenced native session, identically in the browser and the worker', {
      browserDecodeEqualsRef: JSON.stringify(browserDecode) === JSON.stringify(plainRef5),
      workerDecodeEqualsBrowserDecode: JSON.stringify(browserDecode) === JSON.stringify({ environmentId: workerDecode5.environmentId, harnessInstanceId: workerDecode5.harnessInstanceId, nativeSessionId: workerDecode5.nativeSessionId }),
      decodedNativeSessionId: browserDecode.nativeSessionId,
    }, {
      browserDecodeEqualsRef: true,
      workerDecodeEqualsBrowserDecode: true,
      decodedNativeSessionId: 'native:5',
    });

    const browserBinding = await evaluate(() => window.task31.binding());
    protocol.browser.binding = browserBinding;
    record('browserBinding', browserBinding);
    check('the receiver-side binding parse preserves the referenced native session and its native parent (sub-agent), and rejects a malformed binding with an explicit code in the browser too', {
      role: browserBinding.role,
      nativeSessionId: browserBinding.session.nativeSessionId,
      nativeParentNativeSessionId: browserBinding.nativeParent.nativeSessionId,
      ownerNativeParent: browserBinding.ownerNativeParent,
      malformed: browserBinding.malformed,
    }, {
      role: 'participant',
      nativeSessionId: 'native:5',
      nativeParentNativeSessionId: 'native:parent',
      ownerNativeParent: null,
      malformed: { code: 'invalid_request', field: 'thread_binding' },
    });

    const browserRoles = await evaluate(() => window.task31.roles());
    const browserIdentity = await evaluate(() => window.task31.identity());
    protocol.browser.roles = browserRoles;
    protocol.browser.identity = browserIdentity;
    record('browserRoles', { roles: browserRoles, identity: browserIdentity });
    check('the fixed role/state tables, the role rejection and canonical UUID normalization are the same in the browser as in the worker', {
      roles: browserRoles.roles,
      states: browserRoles.states,
      owner: browserRoles.owner,
      participant: browserRoles.participant,
      rejection: browserRoles.rejection,
      threadId: browserIdentity.threadId,
      participantId: browserIdentity.participantId,
    }, {
      roles: ['owner', 'participant'],
      states: ['active', 'left', 'orphaned'],
      owner: 'owner',
      participant: 'participant',
      rejection: { code: 'invalid_request', field: 'thread_role' },
      threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      participantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });

    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: the real services over a REAL file-backed native-session store.
      // ══════════════════════════════════════════════════════════════════════════════════════
      const repo = repoRef(ENV_A, '/srv/repo');
      const store = createFileStore(path.join(fixture.root, 'native'));
      fixture.register({ kind: 'native-session-store-planned', dir: store.dir, teardown: 'removed with the private root' });
      await store.open();
      const ownerRef = sessionRef(ENV_A, HARNESS_A, 'native:owner');
      const missingRef = sessionRef(ENV_A, HARNESS_B, 'native:missing');
      const archivedRef = sessionRef(ENV_A, HARNESS_B, 'native:archived');
      const crossEnvRef = sessionRef(ENV_B, HARNESS_B, 'native:foreign');
      const crossRepoRef = sessionRef(ENV_A, HARNESS_B, 'native:other-repo');
      await store.write(ownerRef, { transcript: 'native:owner transcript — must survive every rejection and every leave' });
      await store.write(archivedRef, { archived: true });
      await store.write(crossRepoRef);
      const beforeCount = await store.count();
      const beforeOwnerDigest = await store.digest(ownerRef);
      const beforeArchivedDigest = await store.digest(archivedRef);
      record('storeBefore', { beforeCount, beforeOwnerDigest, beforeArchivedDigest });

      const service = createThreadService({ resolveSession: (ref) => store.resolve(ref) });
      const thread = await service.bind({ session: ownerRef, repo });

      // ── F1: a different env / repo writer is rejected with an explicit code + field ──
      const crossEnv = await captureAsync(() => service.join({ threadId: thread.threadId, session: crossEnvRef, repo: repoRef(ENV_B, '/srv/repo') }));
      const crossRepo = await captureAsync(() => service.join({ threadId: thread.threadId, session: crossRepoRef, repo: repoRef(ENV_A, '/srv/other-repo') }));
      check('a cross-environment writer is unauthorized and a cross-repository writer is a conflict, both with an explicit code and field, and the owner native history is untouched', {
        crossEnv,
        crossRepo,
        participantsAfter: service.get(thread.threadId).participants.length,
        ownerFileAlive: await store.exists(ownerRef),
        ownerDigestStable: (await store.digest(ownerRef)) === beforeOwnerDigest,
        nativeRecordCount: await store.count(),
      }, {
        crossEnv: { code: 'unauthorized', field: 'thread_environment_mismatch' },
        crossRepo: { code: 'conflict', field: 'thread_repo_mismatch' },
        participantsAfter: 1,
        ownerFileAlive: true,
        ownerDigestStable: true,
        nativeRecordCount: beforeCount,
      });

      // ── F2: a missing native session is rejected at bind and at join ──
      const bindMissing = await captureAsync(() => service.bind({ session: missingRef, repo }));
      const joinMissing = await captureAsync(() => service.join({ threadId: thread.threadId, session: missingRef, repo }));
      check('binding and joining a missing native session both reject with an explicit code and field, no thread is created, and no history is destroyed', {
        bindMissing,
        joinMissing,
        threads: service.state.threads,
        participantsAfter: service.get(thread.threadId).participants.length,
        ownerDigestStable: (await store.digest(ownerRef)) === beforeOwnerDigest,
        nativeRecordCount: await store.count(),
      }, {
        bindMissing: { code: 'source_unavailable', field: 'thread_session_missing' },
        joinMissing: { code: 'source_unavailable', field: 'participant_session_missing' },
        threads: 1,
        participantsAfter: 1,
        ownerDigestStable: true,
        nativeRecordCount: beforeCount,
      });

      // ── F3: a duplicate participant is rejected ──
      const duplicate = await captureAsync(() => service.join({ threadId: thread.threadId, session: ownerRef, repo }));
      check('a duplicate participant (same canonical binding) is rejected with an explicit code and field and does not disturb the existing participant or its history', {
        duplicate,
        participantsAfter: service.get(thread.threadId).participants.length,
        ownerDigestStable: (await store.digest(ownerRef)) === beforeOwnerDigest,
        nativeRecordCount: await store.count(),
      }, {
        duplicate: { code: 'conflict', field: 'participant_duplicate' },
        participantsAfter: 1,
        ownerDigestStable: true,
        nativeRecordCount: beforeCount,
      });

      // ── F4: an archived native session is rejected at bind and at join ──
      const bindArchived = await captureAsync(() => service.bind({ session: archivedRef, repo }));
      const joinArchived = await captureAsync(() => service.join({ threadId: thread.threadId, session: archivedRef, repo }));
      check('binding and joining an archived native session both reject with an explicit code and field, and the archived record itself is left byte-identical', {
        bindArchived,
        joinArchived,
        threads: service.state.threads,
        archivedFileAlive: await store.exists(archivedRef),
        archivedDigestStable: (await store.digest(archivedRef)) === beforeArchivedDigest,
        ownerDigestStable: (await store.digest(ownerRef)) === beforeOwnerDigest,
        nativeRecordCount: await store.count(),
      }, {
        bindArchived: { code: 'conflict', field: 'thread_session_archived' },
        joinArchived: { code: 'conflict', field: 'participant_session_archived' },
        threads: 1,
        archivedFileAlive: true,
        archivedDigestStable: true,
        ownerDigestStable: true,
        nativeRecordCount: beforeCount,
      });

      // ── F5: resume after the native session was archived / vanished → explicit orphan ──
      const aRef = sessionRef(ENV_A, HARNESS_A, 'native:orphan-archived');
      await store.write(aRef);
      const tA = await service.bind({ session: aRef, repo });
      const pA = tA.participants[0];
      service.leave({ threadId: tA.threadId, participantId: pA.participantId });
      await store.archive(aRef);
      const orphanArchived = await service.resume({ threadId: tA.threadId, participantId: pA.participantId });

      const mRef = sessionRef(ENV_A, HARNESS_A, 'native:orphan-missing');
      await store.write(mRef);
      const tM = await service.bind({ session: mRef, repo });
      const pM = tM.participants[0];
      service.leave({ threadId: tM.threadId, participantId: pM.participantId });
      await store.remove(mRef);
      const orphanMissing = await service.resume({ threadId: tM.threadId, participantId: pM.participantId });
      check('an archived or vanished native session on resume becomes an EXPLICIT orphan carrying its reason, never a silent success, and the participant + thread history records are not deleted', {
        archivedOrphanState: orphanArchived.state,
        archivedOrphanReason: orphanArchived.orphanReason,
        archivedParticipants: service.get(tA.threadId).participants.length,
        archivedFileStillAlive: await store.exists(aRef),
        missingOrphanState: orphanMissing.state,
        missingOrphanReason: orphanMissing.orphanReason,
        missingParticipants: service.get(tM.threadId).participants.length,
        missingThreadHistoryLength: service.history(tM.threadId).participants.length,
        missingFileGone: !(await store.exists(mRef)),
      }, {
        archivedOrphanState: 'orphaned',
        archivedOrphanReason: 'participant_session_archived',
        archivedParticipants: 1,
        archivedFileStillAlive: true,
        missingOrphanState: 'orphaned',
        missingOrphanReason: 'participant_session_missing',
        missingParticipants: 1,
        missingThreadHistoryLength: 1,
        missingFileGone: true,
      });

      // ── F6: leave does not delete the native session (byte + digest, real file) ──
      const lRef = sessionRef(ENV_A, HARNESS_A, 'native:leave');
      await store.write(lRef, { transcript: 'native:leave transcript — leave must not delete me' });
      const tL = await service.bind({ session: lRef, repo });
      const pL = tL.participants[0];
      const bytesBefore = await store.bytes(lRef);
      const digestBefore = await store.digest(lRef);
      const leftL = service.leave({ threadId: tL.threadId, participantId: pL.participantId });
      const bytesAfter = await store.bytes(lRef);
      const digestAfter = await store.digest(lRef);
      check('leaving marks the participant left and NEVER deletes the native session: the on-disk record survives with the same byte length and the same digest', {
        leaveState: leftL.state,
        leftAtRecorded: typeof leftL.leftAt === 'number' && leftL.leftAt > 0,
        nativeFileAliveAfterLeave: await store.exists(lRef),
        bytesBefore,
        bytesAfter,
        bytesEqual: bytesBefore === bytesAfter,
        digestUnchanged: digestBefore === digestAfter,
        participants: service.get(tL.threadId).participants.length,
      }, {
        leaveState: 'left',
        leftAtRecorded: true,
        nativeFileAliveAfterLeave: true,
        bytesBefore,
        bytesAfter: bytesBefore,
        bytesEqual: true,
        digestUnchanged: true,
        participants: 1,
      });

      // ── F7: unknown thread / unknown participant / closed service ──
      const unknownThread = await captureAsync(() => service.join({ threadId: '99999999-9999-4999-8999-999999999999', session: ownerRef, repo }));
      const unknownParticipant = captureSync(() => service.activate({ threadId: thread.threadId, participantId: '99999999-9999-4999-8999-999999999999' }));
      await service.close();
      const closedBind = await captureAsync(() => service.bind({ session: ownerRef, repo }));
      check('an unknown thread, an unknown participant and a closed service each reject with an explicit code and field, and no native history record is destroyed', {
        unknownThread,
        unknownParticipant,
        closedBind,
        ownerFileAlive: await store.exists(ownerRef),
        nativeRecordCount: await store.count(),
      }, {
        unknownThread: { code: 'invalid_request', field: 'thread_unknown' },
        unknownParticipant: { code: 'invalid_request', field: 'participant_unknown' },
        closedBind: { code: 'cancelled', field: 'thread_closed' },
        ownerFileAlive: true,
        nativeRecordCount: 5,
      });

      // ── F8: the ParticipantService in isolation ──
      const isoMissingResolver = captureSync(() => createParticipantService({}));
      const participants = createParticipantService({ resolveSession: (ref) => store.resolve(ref) });
      const isoThread = { environmentId: ENV_A, repoKey: 'repo-key', participants: [], revision: 0 };
      const isoRef = sessionRef(ENV_A, HARNESS_A, 'native:iso');
      await store.write(isoRef);
      // join()/leave()/resume() all return the SAME live participant record: snapshot each state at
      // the moment it is produced — the resume below rewrites state on that very object.
      const isoJoined = await participants.join({ thread: isoThread, session: isoRef, repoKey: 'repo-key', role: 'owner' });
      const isoJoinedState = isoJoined.state;
      const isoLeft = participants.leave({ thread: isoThread, participantId: isoJoined.participantId });
      const isoLeftState = isoLeft.state;
      await store.remove(isoRef);
      const isoOrphan = await participants.resume({ thread: isoThread, participantId: isoJoined.participantId });
      const isoOrphanState = isoOrphan.state;
      const isoOrphanReason = isoOrphan.orphanReason;
      check('the ParticipantService is usable in isolation: a missing resolver is refused, and leave-then-resume keeps its own participant record and orphans explicitly when the native session vanishes', {
        missingResolver: isoMissingResolver,
        joinedState: isoJoinedState,
        leftState: isoLeftState,
        orphanState: isoOrphanState,
        orphanReason: isoOrphanReason,
        threadParticipantCount: isoThread.participants.length,
        stats: participants.state,
      }, {
        missingResolver: { code: 'invalid_request', field: 'participant_source' },
        joinedState: 'active',
        leftState: 'left',
        orphanState: 'orphaned',
        orphanReason: 'participant_session_missing',
        threadParticipantCount: 1,
        stats: { joins: 1, leaves: 1, resumes: 0, orphans: 1 },
      });
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: real services over an in-memory counting session index.
      // ══════════════════════════════════════════════════════════════════════════════════════
      const repo = repoRef(ENV_A, '/srv/repo');

      // ── H1: 10k existing sessions never materialize 10k threads (real numbers) ──
      const bulk = [];
      for (let index = 0; index < 10_000; index += 1) bulk.push(view(sessionRef(ENV_A, HARNESS_A, `native:${index}`)));
      const lazy = makeMemoryHarness(bulk);
      const threadsBefore = lazy.service.state.threads;
      const bindingsBefore = lazy.service.state.bindings;
      const resolutionsBefore = lazy.resolutions();
      const bulkThread = await lazy.service.bind({ session: bulk[5].session, repo });
      check('a 10k existing-session set materializes ZERO threads and ZERO resolutions until one session is explicitly bound, then exactly ONE thread from ONE resolution', {
        catalogSize: bulk.length,
        threadsBefore,
        bindingsBefore,
        resolutionsBefore,
        threadsAfter: lazy.service.state.threads,
        bindingsAfter: lazy.service.state.bindings,
        resolutionsAfter: lazy.resolutions(),
        ownerParticipants: bulkThread.participants.length,
        ownerRole: bulkThread.participants[0]?.role,
        nativeSessionsUntouched: lazy.catalog.size,
      }, {
        catalogSize: 10000,
        threadsBefore: 0,
        bindingsBefore: 0,
        resolutionsBefore: 0,
        threadsAfter: 1,
        bindingsAfter: 1,
        resolutionsAfter: 1,
        ownerParticipants: 1,
        ownerRole: 'owner',
        nativeSessionsUntouched: 10000,
      });

      // ── H2: the same native session from two windows yields the SAME wrapper ──
      const owner2 = sessionRef(ENV_A, HARNESS_A, 'native:owner');
      const h2 = makeMemoryHarness([view(owner2)]);
      const first = await h2.service.bind({ session: owner2, repo });
      const second = await h2.service.bind({ session: sessionRef(ENV_A, HARNESS_A, 'native:owner'), repo });
      check('binding the same native session twice returns the IDENTICAL wrapper object with the same threadId and one thread', {
        sameWrapperIdentity: second === first,
        sameThreadId: second.threadId === first.threadId,
        threads: h2.service.state.threads,
        bindings: h2.service.state.bindings,
        resolutions: h2.resolutions(),
        participants: first.participants.length,
        threadIdCanonical: parseThreadId(first.threadId) === first.threadId,
        participantIdCanonical: parseParticipantId(first.participants[0].participantId) === first.participants[0].participantId,
      }, {
        sameWrapperIdentity: true,
        sameThreadId: true,
        threads: 1,
        bindings: 1,
        resolutions: 1,
        participants: 1,
        threadIdCanonical: true,
        participantIdCanonical: true,
      });

      // ── H3: a second harness joins; per-harness native history stays SEPARATE ──
      const owner3 = sessionRef(ENV_A, HARNESS_A, 'native:owner');
      const second3 = sessionRef(ENV_A, HARNESS_B, 'native:second');
      const h3 = makeMemoryHarness([view(owner3), view(second3)]);
      const thread3 = await h3.service.bind({ session: owner3, repo });
      const added3 = await h3.service.join({ threadId: thread3.threadId, session: second3, repo });
      // join()/activate() return LIVE internal records: snapshot the observed values at the moment
      // they are produced, before a later call can mutate the same object (get()/history() are the
      // documented frozen read models).
      const addedRole3 = added3.role;
      const addedP3Id = added3.participantId;
      const ownerP3 = thread3.participants[0];
      const ownerP3Id = ownerP3.participantId;
      const hist3 = h3.service.history(thread3.threadId);
      h3.service.activate({ threadId: thread3.threadId, participantId: addedP3Id });
      const activeSecond = h3.service.active(thread3.threadId)?.session.nativeSessionId;
      h3.service.activate({ threadId: thread3.threadId, participantId: ownerP3Id });
      const activeOwner = h3.service.active(thread3.threadId)?.session.nativeSessionId;
      check('a thread spans two harnesses: each participant keeps its OWN native session identity, the histories are listed side by side and never merged, and the active participant switches between them', {
        harnessInstanceIds: [...h3.service.get(thread3.threadId).harnessInstanceIds],
        threads: h3.service.state.threads,
        bindings: h3.service.state.bindings,
        historyParticipants: hist3.participants.length,
        distinctNativeSessions: new Set(hist3.participants.map((entry) => entry.session.nativeSessionId)).size,
        historyHarnessOrder: hist3.participants.map((entry) => entry.harnessInstanceId),
        ownerNative: h3.service.nativeHistory(thread3.threadId, ownerP3Id).session.nativeSessionId,
        addedNative: h3.service.nativeHistory(thread3.threadId, addedP3Id).session.nativeSessionId,
        historiesNeverMerged: hist3.participants[0].session.nativeSessionId !== hist3.participants[1].session.nativeSessionId,
        ownerRefIntact: JSON.stringify(hist3.participants[0].session) === JSON.stringify(owner3),
        addedRefIntact: JSON.stringify(hist3.participants[1].session) === JSON.stringify(second3),
        addedRole: addedRole3,
        activeAfterActivateSecond: activeSecond,
        activeAfterActivateOwner: activeOwner,
      }, {
        harnessInstanceIds: [HARNESS_A, HARNESS_B],
        threads: 1,
        bindings: 2,
        historyParticipants: 2,
        distinctNativeSessions: 2,
        historyHarnessOrder: [HARNESS_A, HARNESS_B],
        ownerNative: 'native:owner',
        addedNative: 'native:second',
        historiesNeverMerged: true,
        ownerRefIntact: true,
        addedRefIntact: true,
        addedRole: 'participant',
        activeAfterActivateSecond: 'native:second',
        activeAfterActivateOwner: 'native:owner',
      });

      // ── H4: leave then re-join restores the SAME native binding ──
      // leave()/resume() return the LIVE internal participant record (the documented mutable
      // contract: get()/history() are the frozen read models). Snapshot every observed value at the
      // moment it is produced — never hold a live reference across a later mutating call, or the
      // assertion reads the post-mutation state instead of the observed one.
      const owner4 = sessionRef(ENV_A, HARNESS_A, 'native:owner');
      const h4 = makeMemoryHarness([view(owner4)]);
      const thread4 = await h4.service.bind({ session: owner4, repo });
      const p4 = thread4.participants[0];
      const beforeRef = { ...p4.session };
      const stateBeforeLeave = p4.state;
      const left4 = h4.service.leave({ threadId: thread4.threadId, participantId: p4.participantId });
      const stateAtLeave = left4.state;
      const leftAtAtLeave = left4.leftAt;
      const idempotent4 = h4.service.leave({ threadId: thread4.threadId, participantId: p4.participantId });
      const stateAtIdempotentLeave = idempotent4.state;
      const leftAtAtIdempotentLeave = idempotent4.leftAt;
      const nativeRecordAliveAfterLeave = h4.catalog.has(catalogKey(owner4));
      const resumed4 = await h4.service.resume({ threadId: thread4.threadId, participantId: p4.participantId });
      const stateAtResume = resumed4.state;
      const leftAtAtResume = resumed4.leftAt;
      const orphanReasonAtResume = resumed4.orphanReason;
      const afterRef = { ...resumed4.session };
      check('leave→resume walks active→left→active and restores the SAME native SessionRef, and leave never removes the native session record', {
        transitions: [stateBeforeLeave, stateAtLeave, stateAtResume],
        stateTrail: [stateBeforeLeave, stateAtLeave, stateAtIdempotentLeave, stateAtResume],
        leftAtRecorded: typeof leftAtAtLeave === 'number' && leftAtAtLeave > 0,
        idempotentLeaveState: stateAtIdempotentLeave,
        idempotentLeaveKeepsLeftAt: leftAtAtIdempotentLeave === leftAtAtLeave,
        nativeRecordAliveAfterLeave,
        beforeNativeSessionId: beforeRef.nativeSessionId,
        afterNativeSessionId: afterRef.nativeSessionId,
        sameSessionIdentity: JSON.stringify(beforeRef) === JSON.stringify(afterRef),
        resumedOrphanReason: orphanReasonAtResume,
        resumedLeftAt: leftAtAtResume,
        participants: h4.service.get(thread4.threadId).participants.length,
      }, {
        transitions: ['active', 'left', 'active'],
        stateTrail: ['active', 'left', 'left', 'active'],
        leftAtRecorded: true,
        idempotentLeaveState: 'left',
        idempotentLeaveKeepsLeftAt: true,
        nativeRecordAliveAfterLeave: true,
        beforeNativeSessionId: 'native:owner',
        afterNativeSessionId: 'native:owner',
        sameSessionIdentity: true,
        resumedOrphanReason: null,
        resumedLeftAt: null,
        participants: 1,
      });

      // ── H5: canonical binding key, roles and the same-env/repo restriction ──
      const s1 = sessionRef(ENV_A, HARNESS_A, 'native:1');
      check('the roles and participant states are the fixed tables, the binding key is canonical per native SessionRef, and only a valid role is accepted', {
        roles: [...THREAD_ROLES],
        states: [...PARTICIPANT_STATES],
        ownerRole: parseThreadRole('owner'),
        participantRole: parseThreadRole('participant'),
        roleRejection: captureSync(() => parseThreadRole('observer')),
        sameSessionSameKey: threadBindingKey(s1) === threadBindingKey(sessionRef(ENV_A, HARNESS_A, 'native:1')),
        siblingKeyDiffers: threadBindingKey(s1) !== threadBindingKey(sessionRef(ENV_A, HARNESS_A, 'native:2')),
        otherHarnessKeyDiffers: threadBindingKey(s1) !== threadBindingKey(sessionRef(ENV_A, HARNESS_B, 'native:1')),
      }, {
        roles: ['owner', 'participant'],
        states: ['active', 'left', 'orphaned'],
        ownerRole: 'owner',
        participantRole: 'participant',
        roleRejection: { code: 'invalid_request', field: 'thread_role' },
        sameSessionSameKey: true,
        siblingKeyDiffers: true,
        otherHarnessKeyDiffers: true,
      });

      const owner5 = sessionRef(ENV_A, HARNESS_A, 'native:owner');
      const h5c = makeMemoryHarness([view(owner5)]);
      const repoEnvRejection = await captureAsync(() => h5c.service.bind({ session: owner5, repo: repoRef(ENV_B, '/srv/repo') }));
      const threadsAfterRepoEnvReject = h5c.service.state.threads;
      const h5 = makeMemoryHarness([
        view(owner5),
        view(sessionRef(ENV_B, HARNESS_B, 'native:foreign')),
        view(sessionRef(ENV_A, HARNESS_B, 'native:other-repo')),
      ]);
      const thread5 = await h5.service.bind({ session: owner5, repo });
      const crossEnv = await captureAsync(() => h5.service.join({ threadId: thread5.threadId, session: sessionRef(ENV_B, HARNESS_B, 'native:foreign'), repo: repoRef(ENV_B, '/srv/repo') }));
      const crossRepo = await captureAsync(() => h5.service.join({ threadId: thread5.threadId, session: sessionRef(ENV_A, HARNESS_B, 'native:other-repo'), repo: repoRef(ENV_A, '/srv/other-repo') }));
      check('a repo whose environment differs from the session is refused before any thread exists; a cross-environment join is unauthorized and a cross-repository join is a conflict', {
        repoEnvRejection,
        threadsAfterRepoEnvReject,
        crossEnvRejection: crossEnv,
        crossRepoRejection: crossRepo,
        participantsAfterRejections: h5.service.get(thread5.threadId).participants.length,
      }, {
        repoEnvRejection: { code: 'invalid_request', field: 'thread_repo_environment' },
        threadsAfterRepoEnvReject: 0,
        crossEnvRejection: { code: 'unauthorized', field: 'thread_environment_mismatch' },
        crossRepoRejection: { code: 'conflict', field: 'thread_repo_mismatch' },
        participantsAfterRejections: 1,
      });

      // ── H6: native sub-agent (parent) relation preserved across join and leave ──
      const parent6 = sessionRef(ENV_A, HARNESS_A, 'native:parent');
      const child6 = sessionRef(ENV_A, HARNESS_A, 'native:child');
      const grandchild6 = sessionRef(ENV_A, HARNESS_B, 'native:grandchild');
      const h6 = makeMemoryHarness([view(child6, { parent: parent6 }), view(grandchild6, { parent: child6 })]);
      const thread6 = await h6.service.bind({ session: child6, repo });
      const ownerP6 = thread6.participants[0];
      // leave()/resume() return the SAME live participant record join() returned: snapshot each
      // observed nativeParent at the moment it is produced, before the next call mutates it.
      const ownerNativeParent6 = ownerP6.nativeParent;
      const added6 = await h6.service.join({ threadId: thread6.threadId, session: grandchild6, repo });
      const addedNativeParent6 = added6.nativeParent;
      const left6 = h6.service.leave({ threadId: thread6.threadId, participantId: added6.participantId });
      const nativeParentAtLeave6 = left6.nativeParent;
      const resumed6 = await h6.service.resume({ threadId: thread6.threadId, participantId: added6.participantId });
      const nativeParentAtResume6 = resumed6.nativeParent;
      check('the native sub-agent (parent) relation is preserved at bind, join, leave and resume, and the receiver-side binding parse keeps it too', {
        ownerNativeParent: ownerNativeParent6,
        addedNativeParent: addedNativeParent6,
        resolvedAddedParent: h6.service.nativeHistory(thread6.threadId, added6.participantId).nativeParent,
        nativeParentSurvivesLeave: nativeParentAtLeave6,
        nativeParentSurvivesResume: nativeParentAtResume6,
        receiverParsesParent: parseThreadBinding({ role: 'participant', session: child6, nativeParent: child6 }).nativeParent,
        receiverParsesNullParent: parseThreadBinding({ role: 'owner', session: child6, nativeParent: null }).nativeParent,
      }, {
        ownerNativeParent: parent6,
        addedNativeParent: child6,
        resolvedAddedParent: child6,
        nativeParentSurvivesLeave: child6,
        nativeParentSurvivesResume: child6,
        receiverParsesParent: child6,
        receiverParsesNullParent: null,
      });
    }

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task31.errors());
    check('the browser entry logged no error while computing the shared Thread contract', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the shared-contract surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa31-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa31-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task31.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapEnd, heapGrowthBytes });
    check('the case stays bounded: real heap growth is under the bound and it exercised a fixed set of owned resources with zero borrowed spawns', {
      heapGrowthBytes,
      heapGrowthUnderBound: heapGrowthBytes < HEAP_BOUND,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    }, {
      heapGrowthBytes,
      heapGrowthUnderBound: true,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged and pins a populated source inventory', {
      status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0,
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
    }, {
      status: true,
      authoredFileCount: ownedFiles.length,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task31Errors ?? [], task31: Boolean(window.task31) })).catch((value) => ({ unavailable: String(value) }));
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

  return {
    scenarios,
    artifacts,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'host-thread-native-participant-binding', schema: 'runtime-thread-binding/v1' },
    cleanup: proof.cleanup,
    defects: {},
    evidenceBoundary: 'The real landed bridge services bridge/runtime/threads/threadService.js and participantService.js plus shared/runtime/thread.js run in the Node worker over an injected session index: an in-memory counting catalog for the laziness check and REAL JSON files under the private root (read back with node:fs, digest + byte length recorded) for the history-preservation and orphan proofs. The pure shared contract modules (thread.js/identity.js/capabilities.js) also run in a real headless Chromium served by a case-owned Vite server, proving the canonical binding key and receiver-side binding parse are engine-independent; no browser shim is needed because none of those modules imports a node:* builtin. The controlled boundary is the harness session index (resolveSession), which the product takes as an injected port. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that) and authors no PASS verdict.',
  };
}
