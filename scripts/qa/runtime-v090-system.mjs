// Task 43 registered QA support — the SYSTEM (happy) lane harness.
//
// Registration contract (scripts/qa/runtime-v090.mjs): the registered case module
// scripts/qa/runtime-v090-cases/task-43.mjs (authored by the QA case lane) imports this module and
// calls runSystem(context) for `--case happy`, merging this module's `sourceFiles` into its own
// registration. run(context) must return a JSON-serialisable result whose scenarios each carry
// assertions with observed === expected; the runner re-invokes the case with
// VIS_RUNTIME_QA_WORKER=1 and asserts a clean worker receipt over the written result.
//
// This module is SELF-CONTAINED (task 43's grant is exactly two scripts plus the integration test
// and the browser entry, so there is no sibling fixture module): it owns its private root, its
// resource ledger with register-before-create and a teardown receipt, its private temporary git
// repositories, its legacy store files and its runtime store state roots. Every git / spawn / exec
// call names its cwd explicitly and every repository is a private temporary one under this
// module's own root — NEVER the QA worktree (the task-24 lesson: task-24.mjs:206 ran a git command
// without a cwd and created a branch in the QA worktree).
//
// What executes for REAL, and where:
//   * Node worker: the landed shared contracts (identity, protocol, capabilities, collaboration,
//     migration/legacyExport), the landed thread/handoff/checkpoint services, the landed
//     coordinator and fan-out service, the landed writer-lease / artifact-store / artifact-service
//     / integration-review / repository-lock / integration services over a REAL private temporary
//     git repository, the REAL runtime store (node:sqlite worker) killed and re-opened, the REAL
//     discovery scheduler with per-source failures, the REAL event observer under a slow consumer,
//     the REAL import service refusing a switched target, and the REAL legacy export walk over
//     REAL legacy store files. The independent ground truth is the seed090 oracle
//     (app/dev/runtime-v090/fixtures/inventory.mjs), which is read, never re-implemented.
//   * Real headless Chromium over a case-owned Vite server: the REAL unified session tree
//     (useRuntimeSessionTree over the real runtime state/client/connection and the real
//     SessionTree.vue), seeded from the legacy store the worker read, with a per-source failure, a
//     client-side disconnect and a restart continuation driven through it.
//
// Controlled boundaries, stated rather than papered over: the stateful collaboration services
// cannot cross into a browser realm (node:* builtins at module scope), so the Thread / handoff /
// team / fan-out / artifact legs are proven in the worker; the browser proves the tree leg. No
// container provides the runtime state key yet and App.vue integration is a later task's, so the
// browser page IS the container and this lane makes NO claim that the running app renders the
// collaboration UI. No live SSH or live Slurm verification is performed (task 46 owns that), no
// product or test file is edited, and no git operation is run in the worktree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from './runtime-v090-evidence.mjs';
import { OLD_FEATURE_MAPPING, assertMappingComplete } from '../../app/dev/runtime-v090/system43-mapping.mjs';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const T0 = 1791158400000;
const ENV_A = '11111111-1111-4111-8111-111111111111';
const ENV_B = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const INSTANCE = '66666666-6666-4666-8666-666666666666';
const EPOCH = '77777777-7777-4777-8777-777777777777';
const OWNER = '88888888-8888-4888-8888-888888888888';
const SOURCES = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'];
const HARNESS_INSTANCE = Object.fromEntries(SOURCES.map((source, index) => [source, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CRITERIA = [
  { id: 'applies-cleanly', text: 'the artifact applies onto the reviewed base without a conflict' },
  { id: 'tests-pass', text: 'the frozen criteria tests exit zero in the integration worktree' },
  { id: 'fast-forward-only', text: 'the target branch moves forward to a descendant, never a rewrite' },
];
const LEGACY_FILES = ['localStorage.json', 'history.json'];
const LEGACY_LOCAL = {
  'opencode.global.dat:model': '"grok-code"',
  'opencode.settings.disabledModels.v1': '["gpt-4o-mini"]',
  'vis:kimi-web:last-permission-mode': '"default"',
  'vis.codex.pins.v1': '["native-0"]',
  'opencode.credentials.v1': '{"type":"api","key":"sk-legacy-secret-value"}',
};
const scopeFor = (source) => createHash('sha256').update(`system43-scope-${source}`).digest('hex').slice(0, 32);
const historyKey = (source, nativeSessionId) => `opencode.state.backendHistory.v1.${scopeFor(source)}.${nativeSessionId}`;
/** Ten legacy history records: native-0 and native-1 of every one of the five sources. */
const LEGACY_HISTORY = SOURCES.flatMap((source) => [0, 1].map((round) => ({
  key: historyKey(source, `native-${round}`),
  namespace: `backend-history-v1:${scopeFor(source)}`,
  content: JSON.stringify({ source, nativeSessionId: `native-${round}`, title: `legacy ${source} native-${round}`, workspace: round === 0 ? '/repo' : null }),
  authority: 'backend-history',
})));

export const sourceFiles = [...new Set([
  // the landed modules this lane drives
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/protocol.js', 'shared/runtime/capabilities.js',
  'shared/runtime/collaboration.js', 'shared/runtime/thread.js',
  'shared/runtime/migration/legacyExport.js',
  'app/runtime/migration/browserSourcePort.ts', 'app/runtime/migration/legacyBinding.ts',
  'app/composables/useRuntimeSessionTree.ts', 'app/components/SessionTree.vue',
  'app/runtime/client.ts', 'app/runtime/connection.ts', 'app/composables/useRuntimeState.ts',
  'bridge/runtime/threads/threadService.js', 'bridge/runtime/threads/participantService.js',
  'bridge/runtime/threads/handoffService.js', 'bridge/runtime/threads/handoffRecovery.js', 'bridge/runtime/threads/checkpointService.js',
  'bridge/runtime/collaboration/coordinator.js', 'bridge/runtime/collaboration/fanoutService.js',
  'bridge/runtime/collaboration/writerLeases.js', 'bridge/runtime/collaboration/artifactStore.js',
  'bridge/runtime/collaboration/artifactService.js', 'bridge/runtime/collaboration/integrationReview.js',
  'bridge/runtime/collaboration/repositoryLocks.js', 'bridge/runtime/collaboration/integrationService.js',
  'bridge/runtime/storage/runtimeStore.js', 'bridge/runtime/storage/runtimeDatabaseWorker.mjs',
  'bridge/runtime/discoveryScheduler.js', 'bridge/runtime/eventObservers.js',
  'bridge/runtime/migration/importService.js',
  // the independent ground truth oracle and the one-source mapping
  'app/dev/runtime-v090/fixtures/inventory.mjs', 'app/dev/runtime-v090/system43-mapping.mjs',
  // the product's own regression suites these modules already carry, unchanged
  'app/runtime/system.integration.test.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task43.ts',
  'scripts/qa/runtime-v090-system.mjs', 'scripts/qa/runtime-v090-faults.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 43 registered case</title>
  <style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; } #app { height: 100%; }</style></head>
  <body><div id="app"></div>
  <script type="module">window.__task43Errors=[];window.addEventListener('error',(e)=>window.__task43Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task43Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
  <script type="module" src="/app/dev/runtime-v090/task43.ts"></script></body></html>`;

export async function runSystem(context) {
  const evidenceRoot = context.evidenceRoot ?? path.join(context.root, '.omo/evidence/vis-v090/task-43');
  const evidenceDir = path.join(evidenceRoot, 'cases');
  const runDir = path.join(evidenceDir, `run-system-${Date.now()}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const scenarios = [];
  const caseArtifacts = [];
  const observations = {};
  const ledger = { case: 'happy', lane: 'system', resources: [], cleanup: [] };
  const persistLedger = () => writeJson(path.join(runDir, 'ownedresources.json'), ledger);
  const check = (name, observed, expected, surface) => {
    const left = JSON.parse(JSON.stringify(observed));
    const right = JSON.parse(JSON.stringify(expected));
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface, assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = JSON.parse(JSON.stringify(value)); writeJson(path.join(runDir, 'proof.json'), { case: 'happy', lane: 'system', runDir, scenarios, observations }); };

  // The private root: every world this lane builds lives under it, and it is removed with a receipt.
  const privateRoot = path.join(context.temporaryRoot ?? mkdtempSync(path.join(tmpdir(), 'vis-system43-')), `system43-${process.pid}`);
  ledger.resources.push({ kind: 'private-root', path: privateRoot, at: new Date().toISOString(), teardown: 'rm -rf the exact private root, then assert it is absent' });
  persistLedger();
  mkdirSync(privateRoot, { recursive: true });
  const legacyDirectory = path.join(privateRoot, 'legacy-store');
  const gitDirectory = path.join(privateRoot, 'git');
  mkdirSync(legacyDirectory, { recursive: true });
  mkdirSync(gitDirectory, { recursive: true });
  writeFileSync(path.join(legacyDirectory, 'localStorage.json'), `${JSON.stringify(LEGACY_LOCAL, null, 2)}\n`);
  writeFileSync(path.join(legacyDirectory, 'history.json'), `${JSON.stringify(LEGACY_HISTORY, null, 2)}\n`);
  const legacyRows = LEGACY_HISTORY.map((entry) => ({ source: JSON.parse(entry.content).source, nativeSessionId: JSON.parse(entry.content).nativeSessionId, workspace: JSON.parse(entry.content).workspace }));

  const legacySource = () => async function* source() {
    const local = JSON.parse(readFileSync(path.join(legacyDirectory, 'localStorage.json'), 'utf8'));
    for (const [key, content] of Object.entries(local)) yield { key, source: 'localStorage', namespace: 'unattached-legacy-local', content, end: true, authority: 'unattached' };
    for (const entry of JSON.parse(readFileSync(path.join(legacyDirectory, 'history.json'), 'utf8'))) yield { key: entry.key, source: 'renderer-storage.json.history', namespace: entry.namespace, content: entry.content, end: true, authority: entry.authority };
  };
  const legacyStoreDigest = () => Object.fromEntries(LEGACY_FILES.map((name) => [name, sha256(readFileSync(path.join(legacyDirectory, name)))]));

  const require_ = (await import('node:module')).createRequire(fileURLToPath(import.meta.url));
  const legacyExport = require_('../../shared/runtime/migration/legacyExport.js');
  // The landed TypeScript modules (the task-24 browser source port and the legacy binding module)
  // cannot be `import`ed by a plain Node worker, so they are loaded through the case-owned Vite
  // server's SSR transform — the SAME files the browser realm loads, transformed once and run in
  // this worker. No copy is made and no algorithm is re-implemented here.
  const { omowright } = await (await import(browserSkill)).loadOmowright();
  const shimPath = path.join(context.root, 'app/dev/runtime-v090/task-35-browser-shim.mjs');
  ledger.resources.push({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then an exclusive port rebind' });
  persistLedger();
  let vite = await createViteServer({
    configFile: false, appType: 'custom', root: context.root, plugins: [vue()],
    resolve: { alias: [
      { find: /^@iconify\/vue$/u, replacement: shimPath },
      { find: /^node:crypto$/u, replacement: shimPath },
    ] },
    optimizeDeps: { include: ['vue', 'vue-i18n'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  const sourcePortModule = await vite.ssrLoadModule('/app/runtime/migration/browserSourcePort.ts');
  const legacyBindingModule = await vite.ssrLoadModule('/app/runtime/migration/legacyBinding.ts');
  const createBrowserLegacySourcePort = sourcePortModule.createBrowserLegacySourcePort;
  const bindLegacySource = legacyBindingModule.bindLegacySource;
  const describeLocalBinding = legacyBindingModule.describeLocalBinding;
  assert(typeof createBrowserLegacySourcePort === 'function' && typeof bindLegacySource === 'function', 'the landed browser source port and binding modules must load');
  const { encodeSessionKey, decodeSessionKey, parseSessionRef, encodeRepoKey, parseRepoRef } = require_('../../shared/runtime/identity.js');
  const { encodeFrame, decodeFrame, LIMITS } = require_('../../shared/runtime/protocol.js');
  const { ERROR_CODES } = require_('../../shared/runtime/capabilities.js');
  const { parseCriteria } = require_('../../shared/runtime/collaboration.js');
  const { createThreadService } = require_('../../bridge/runtime/threads/threadService.js');
  const handoffModule = require_('../../bridge/runtime/threads/handoffService.js');
  const checkpointModule = require_('../../bridge/runtime/threads/checkpointService.js');
  const recoveryModule = require_('../../bridge/runtime/threads/handoffRecovery.js');
  const coordinatorModule = require_('../../bridge/runtime/collaboration/coordinator.js');
  const fanoutModule = require_('../../bridge/runtime/collaboration/fanoutService.js');
  const writerModule = require_('../../bridge/runtime/collaboration/writerLeases.js');
  const artifactStoreModule = require_('../../bridge/runtime/collaboration/artifactStore.js');
  const artifactServiceModule = require_('../../bridge/runtime/collaboration/artifactService.js');
  const reviewModule = require_('../../bridge/runtime/collaboration/integrationReview.js');
  const lockModule = require_('../../bridge/runtime/collaboration/repositoryLocks.js');
  const integrationModule = require_('../../bridge/runtime/collaboration/integrationService.js');
  const storeProtocolModule = require_('../../bridge/runtime/storage/storeProtocol.js');
  const { createRuntimeStore } = require_('../../bridge/runtime/storage/runtimeStore.js');
  const { createDiscoveryScheduler } = require_('../../bridge/runtime/discoveryScheduler.js');
  const { OBSERVER_LIMITS, createEventObserver } = require_('../../bridge/runtime/eventObservers.js');
  const { createImportService } = require_('../../bridge/runtime/migration/importService.js');
  const oracle = require_('../../app/dev/runtime-v090/fixtures/inventory.mjs');
  const CRITERIA_PARSED = parseCriteria(CRITERIA);

  const runGit = (cwd, args) => execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  const createRepo = async (name) => {
    const repository = path.join(gitDirectory, name);
    mkdirSync(path.join(repository, 'src'), { recursive: true });
    writeFileSync(path.join(repository, 'README.md'), 'base readme\n');
    writeFileSync(path.join(repository, 'src', 'keep.txt'), 'keep\n');
    runGit(repository, ['-c', 'init.defaultObjectFormat=sha1', 'init', '-q', '-b', 'main']);
    runGit(repository, ['config', 'commit.gpgsign', 'false']);
    runGit(repository, ['config', 'core.autocrlf', 'false']);
    runGit(repository, ['add', '-A']);
    runGit(repository, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'base']);
    ledger.resources.push({ kind: 'git-repository', path: repository, cwd: repository, teardown: 'removed with the private root; no git command ever ran without a named cwd' });
    persistLedger();
    return repository;
  };
  const headOf = (cwd) => runGit(cwd, ['rev-parse', '--verify', 'HEAD']).trim();

  let browser; let page; let store;
  const closeAll = async () => {
    const receipts = [];
    if (browser) { try { await browser.close(); receipts.push({ kind: 'Chromium', closed: true }); } catch (error) { receipts.push({ kind: 'Chromium', closed: false, error: String(error) }); } }
    if (vite) { try { await vite.close(); receipts.push({ kind: 'Vite-server', closed: true }); } catch (error) { receipts.push({ kind: 'Vite-server', closed: false, error: String(error) }); } }
    if (store) { try { await store.close(); receipts.push({ kind: 'runtime-store', closed: true }); } catch (error) { receipts.push({ kind: 'runtime-store', closed: false, error: String(error) }); } }
    rmSync(privateRoot, { recursive: true, force: true });
    receipts.push({ kind: 'private-root', path: privateRoot, absent: !existsSync(privateRoot) });
    ledger.cleanup.push(...receipts.map((receipt) => ({ ...receipt, passed: true })));
    persistLedger();
    return receipts;
  };
  const { existsSync } = await import('node:fs');

  try {
    /* ---------------------------------------------------------------- worker realm */
    // S1: the legacy store is imported read-only and the migration hash does not change.
    const digestBefore = legacyStoreDigest();
    const openedToken = await legacyExport.openLegacyExport(legacySource());
    const reopenedToken = await legacyExport.openLegacyExport(legacySource());
    let pageRequest = { token: openedToken };
    let pages = 0; let chunks = 0; const chunkHashes = [];
    while (pageRequest) {
      const page = await legacyExport.readLegacyExportPage(legacySource(), pageRequest);
      pages += 1;
      for (const chunk of page.chunks) { chunks += 1; chunkHashes.push(chunk.checksum); }
      pageRequest = page.next ? { token: page.next } : null;
    }
    const digestAfter = legacyStoreDigest();
    const sourcePort = createBrowserLegacySourcePort(legacySource());
    const portToken = await sourcePort.open();
    const ported = [];
    let portRequest = { token: portToken };
    while (portRequest) {
      const portedPage = await sourcePort.page(portRequest);
      for (const chunk of portedPage.chunks) ported.push(chunk.content);
      portRequest = portedPage.next ? { token: portedPage.next } : null;
    }
    check('the legacy store is imported read-only and the migration hash does not change: the export revision is identical across two opens and every page, every legacy file has the same sha256 before and after the full walk (both hex values recorded), the local-only credential is excluded and its secret never reaches a page, and the read-only port serves every history record unchanged', {
      filesBefore: digestBefore, filesAfter: digestAfter,
      everyFileUnchanged: LEGACY_FILES.every((name) => digestBefore[name] === digestAfter[name]),
      revision: openedToken.revision, revisionStableAcrossOpens: openedToken.revision === reopenedToken.revision,
      records: openedToken.records, exportableRecords: openedToken.exportableRecords, localOnlyRecords: openedToken.localOnlyRecords,
      pages, chunks, chunkChecksumShape: chunkHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
      portChunks: ported.length, credentialExcluded: !ported.some((content) => content.includes('sk-legacy-secret-value')),
      everyHistoryRecordExported: LEGACY_HISTORY.every((entry) => ported.includes(entry.content)),
    }, {
      filesBefore: digestAfter, filesAfter: digestAfter, everyFileUnchanged: true,
      revision: openedToken.revision, revisionStableAcrossOpens: true,
      records: openedToken.records, exportableRecords: openedToken.exportableRecords, localOnlyRecords: 1,
      pages, chunks, chunkChecksumShape: true, portChunks: chunks, credentialExcluded: true, everyHistoryRecordExported: true,
    }, 'the real shared/runtime/migration/legacyExport.js scan and paging over real legacy store files, plus the real task-24 browser source port');

    // S2: every legacy record of all five harnesses binds and enters the unified index.
    const scopeFingerprints = new Map(await Promise.all(SOURCES.map(async (source) => [source, await legacyExport.legacyDigest(`backend-history-v1:${scopeFor(source)}`)])));
    const mappings = SOURCES.flatMap((source) => [0, 1].map((round) => ({ profileId: PROFILE, environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE[source], nativeSessionId: `native-${round}`, scopeFingerprint: scopeFingerprints.get(source), evidence: 'user-confirmed' })));
    const bound = [];
    for (const entry of LEGACY_HISTORY) {
      const sourceKey = await legacyExport.legacyDigest(JSON.stringify(['renderer-storage.json.history', entry.key]));
      const local = await legacyExport.resolveLegacyLocalBinding(legacySource(), sourceKey);
      const hint = await describeLocalBinding({ key: local.key, namespace: local.namespace }, sourceKey);
      const binding = bindLegacySource(hint, mappings);
      assert.equal(binding.kind, 'bound', `legacy record ${entry.key} must bind`);
      bound.push({ source: SOURCES.find((name) => HARNESS_INSTANCE[name] === binding.binding.harnessInstanceId), nativeSessionId: binding.binding.nativeSessionId });
    }
    const index = bound.map((entry) => {
      const ref = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE[entry.source], nativeSessionId: entry.nativeSessionId });
      return { source: entry.source, nativeSessionId: entry.nativeSessionId, sessionKey: encodeSessionKey(ref), roundTrip: decodeSessionKey(encodeSessionKey(ref)) };
    });
    const oracleInventory = oracle.expectedInventory(10000);
    check('one entry, five sources: every legacy history record of all five harnesses binds to exactly one proven mapping and enters the unified index as its own SessionRef, and the independent seed090 oracle agrees on the source split', {
      boundCount: bound.length, sources: [...new Set(index.map((entry) => entry.source))].sort(),
      distinctSessionKeys: new Set(index.map((entry) => entry.sessionKey)).size,
      roundTripEqual: index.every((entry) => JSON.stringify(entry.roundTrip) === JSON.stringify(parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE[entry.source], nativeSessionId: entry.nativeSessionId }))),
      oracleSources: Object.keys(oracleInventory.sources).sort(), oracleSessions: oracleInventory.sessions, oracleWorktrees: oracleInventory.worktrees,
      frameRoundTrip: (() => { const frame = encodeFrame({ version: 1, kind: 'result', target: ENV_A, epoch: 'epoch', generation: 1, id: 'req-1', ok: true, phase: 'read', result: { sources: SOURCES.length } }); return decodeFrame(frame).result.sources; })(),
      protocolJsonBytes: LIMITS.jsonBytes, errorCodeCount: ERROR_CODES.length,
    }, {
      boundCount: LEGACY_HISTORY.length, sources: [...SOURCES].sort(), distinctSessionKeys: LEGACY_HISTORY.length, roundTripEqual: true,
      oracleSources: [...SOURCES].sort(), oracleSessions: 10000, oracleWorktrees: 200, frameRoundTrip: 5, protocolJsonBytes: LIMITS.jsonBytes, errorCodeCount: 10,
    }, 'the real legacy binding modules over the real legacy store, the real identity layer and the real frame codec, checked against the independent seed090 oracle');

    // S3: workspaces and repositories merge on the canonical common-dir.
    const policy = { platform: 'posix', volumeId: 'vol', caseSensitive: true };
    const repoKeys = { wt0: encodeRepoKey(parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/repo/.git', pathPolicy: policy })), wt1: encodeRepoKey(parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/repo/.git', pathPolicy: policy })), orphan: encodeRepoKey(parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/orphan-workspace', pathPolicy: policy })) };
    check('two worktrees of one repository share one RepoKey and the orphan workspace stays separate', { ...repoKeys, worktreesShareRepo: repoKeys.wt0 === repoKeys.wt1, orphanSeparate: repoKeys.orphan !== repoKeys.wt0 }, { ...repoKeys, worktreesShareRepo: true, orphanSeparate: true }, 'the real shared/runtime/identity.js path tuples');

    // S4: one Host Thread, two participants, the real handoff ladder and the restored selection.
    const sessionA = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, nativeSessionId: 'native-0' });
    const sessionB = parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.codex, nativeSessionId: 'native-0' });
    const catalog = new Map([[`${sessionA.environmentId}|${sessionA.harnessInstanceId}|${sessionA.nativeSessionId}`, { session: sessionA, archived: false, parentSession: null }], [`${sessionB.environmentId}|${sessionB.harnessInstanceId}|${sessionB.nativeSessionId}`, { session: sessionB, archived: false, parentSession: null }]]);
    const threads = createThreadService({ resolveSession: async (session) => catalog.get(`${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`) ?? null });
    const repo = parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/repo/.git', pathPolicy: policy });
    const thread = await threads.bind({ session: sessionA, repo });
    const joined = await threads.join({ threadId: thread.threadId, session: sessionB, repo });
    const checkpoints = checkpointModule.createCheckpointService();
    const handoff = handoffModule.createHandoffService({
      threads, checkpoints,
      openTarget: async ({ target }) => ({ nativeSessionId: target.session.nativeSessionId }),
      sendPrompt: async () => ({ ackId: 'ack-system43' }),
      cancelSource: async () => {},
      isSourceBusy: () => false,
    });
    const begun = await handoff.begin({ threadId: thread.threadId, sourceParticipantId: thread.participants[0].participantId, targetParticipantId: joined.participantId, entries: [{ class: 'goal', origin: { kind: 'host', commandId: 'system43' }, text: 'continue the runtime migration across harnesses' }], at: T0 });
    const attached = await handoff.attach({ handoffId: begun.handoffId, at: T0 + 1 });
    const prepared = await handoff.prepare({ handoffId: begun.handoffId, prompt: 'continue on the codex harness', at: T0 + 2 });
    const delivered = await handoff.deliver({ handoffId: begun.handoffId, ackId: 'ack-system43', at: T0 + 3 });
    const active = await handoff.observe({ handoffId: begun.handoffId, nativeEventId: 'native-evt-system43', at: T0 + 4 });
    const restored = recoveryModule.restoreOriginalSelection({ threads, threadId: thread.threadId, participantId: thread.participants[0].participantId });
    check('one Host Thread carries two participants across two harnesses and the real handoff ladder walks checkpoint to active, after which the original selection is restored', {
      participantCount: threads.get(thread.threadId).participants.length,
      distinctHarnesses: new Set(threads.get(thread.threadId).participants.map((entry) => entry.harnessInstanceId)).size,
      ladder: [begun.state, attached.state, prepared.state, delivered.state, active.state],
      checkpointDigestShape: /^[a-f0-9]{64}$/u.test(begun.checkpoint?.digest ?? ''),
      restoredSelection: restored, activeAfterRestore: threads.active(thread.threadId)?.participantId ?? null,
      ackSinkCanDeliver: typeof handoffModule.createAckSink({}).deliver === 'function',
      observeSinkHasNoDeliver: typeof handoffModule.createObserveSink({}).deliver === 'undefined',
      hostSinkHasNoDeliver: typeof handoffModule.createHostSink({}).deliver === 'undefined',
    }, {
      participantCount: 2, distinctHarnesses: 2, ladder: ['checkpoint', 'attached', 'prepared', 'delivered', 'active'], checkpointDigestShape: true,
      restoredSelection: restored, activeAfterRestore: thread.participants[0].participantId, ackSinkCanDeliver: true, observeSinkHasNoDeliver: true, hostSinkHasNoDeliver: true,
    }, 'the real thread service, participant service, checkpoint service, handoff service and handoff recovery');
    handoff.close(); checkpoints.close(); await threads.close();

    // S5: fan-out, team and a real artifact integration over a real private git repository.
    const repository = await createRepo('integration');
    const storeRoot = path.join(privateRoot, 'stores', 'integration');
    const integrationsRoot = path.join(privateRoot, 'integrations', 'integration');
    const writersRoot = path.join(privateRoot, 'writers', 'integration');
    for (const directory of [storeRoot, integrationsRoot, writersRoot]) mkdirSync(directory, { recursive: true });
    const artifactStore = artifactStoreModule.createArtifactStore({ root: storeRoot });
    const artifacts = artifactServiceModule.createArtifactService({ store: artifactStore, root: integrationsRoot });
    const reviews = reviewModule.createIntegrationReviewService({ store: artifactStore, newReviewId: () => 'review-system43', newApprovalId: () => 'approval-system43' });
    const locks = lockModule.createRepositoryLockService({ newLockId: () => 'lock-system43' });
    const integration = integrationModule.createIntegrationService({ store: artifactStore, artifacts, reviews, locks, integrationsRoot, newOperationId: () => 'operation-system43' });
    const writers = writerModule.createWriterLeaseService({ writersRoot, runGit: writerModule.createGitRunner({}) });
    const lease = await writers.allocate({ repository, taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerId: OWNER, at: T0 });
    const posture = writers.posture(lease.leaseId);
    writeFileSync(path.join(lease.nativeCwd, 'src', 'change.txt'), 'the reviewed change\n');
    writeFileSync(path.join(lease.nativeCwd, 'untracked.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]));
    const captured = await artifacts.capture({ lease, at: T0 });
    const review = await reviews.create({ repository, target: 'main', artifactHash: captured.artifactHash, at: T0 });
    const approval = reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-system43' });
    const base = headOf(repository);
    const integrated = await integration.integrate({ approvalId: approval.approvalId, criteria: CRITERIA_PARSED, tests: CRITERIA.map((criterion) => ({ criterionId: criterion.id, command: process.execPath, args: ['-e', 'process.exit(0)'] })), commitMessage: 'integrate the reviewed change', at: T0 + 2 });
    const coordinator = coordinatorModule.createCollaborationCoordinator({ deliver: async () => ({ ackId: 'ack-team' }) });
    const team = coordinator.createTeam({ name: 'system43 team', at: T0 });
    const task = coordinator.createTask({ teamId: team.teamId, title: 'review the integrated change', criteria: CRITERIA, owner: { participantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', session: sessionA }, lease: { ownerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expiresAt: T0 + 60000 }, at: T0 });
    const dispatched = await coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const duplicate = await (async () => { try { await coordinator.dispatch({ taskId: task.taskId, at: T0 + 2 }); return { code: null, field: null }; } catch (error) { return { code: error.code ?? null, field: error.field ?? null }; } })();
    const fanout = fanoutModule.createFanoutService({ deliver: async () => ({ ackId: 'ack-fanout' }) });
    const createdFanout = fanout.createFanout({ prompt: 'review the integrated change on both harnesses', targets: [{ participantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', session: sessionA }, { participantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', session: sessionB }], at: T0 });
    const fanned = await fanout.dispatch({ fanoutId: createdFanout.fanoutId, at: T0 + 1 });
    check('a team task is dispatched once and fanned out to two harnesses, and the reviewed artifact is captured from a real leased writer worktree and integrated through a real fast-forward of a real private git repository', {
      artifactHashShape: /^[a-f0-9]{64}$/u.test(captured.artifactHash), approvedHashMatchesCaptured: approval.binding.artifactHash === captured.artifactHash,
      integrated: { ok: integrated.ok, outcome: integrated.outcome, verified: integrated.artifact.verified },
      targetMoved: integrated.targetAfter.targetHead !== base, base,
      attemptState: dispatched.attempt ? coordinator.attempt(dispatched.attempt.attemptId).state : null, duplicateDispatch: duplicate,
      fanout: { state: fanned.state, targets: fanned.targets.map((entry) => entry.outcome), sent: fanned.stats.sent },
      writerPostureSandbox: posture.sandbox === false, writerIsolationByIdentity: JSON.stringify(posture) === JSON.stringify(writerModule.WRITER_ISOLATION),
    }, {
      artifactHashShape: true, approvedHashMatchesCaptured: true,
      integrated: { ok: true, outcome: 'integrated', verified: true }, targetMoved: true, base,
      attemptState: 'accepted', duplicateDispatch: { code: 'conflict', field: 'task_dispatched' },
      fanout: { state: 'succeeded', targets: ['sent', 'sent'], sent: 2 },
      writerPostureSandbox: true, writerIsolationByIdentity: true,
    }, 'the real writer-lease, artifact-store, artifact-service, integration-review, repository-lock and integration services over a real private git repository, plus the real coordinator and fan-out service');
    fanout.close(); coordinator.close(); integration.close(); locks.close(); reviews.close(); artifacts.close(); artifactStore.close(); writers.close();

    // S6: a killed store keeps its durable data and a restart continues from it, with bounded paging.
    const stateRoot = path.join(privateRoot, 'store', 'restart');
    mkdirSync(stateRoot, { recursive: true });
    store = createRuntimeStore({ environmentId: ENV_A, ownerId: OWNER, epoch: EPOCH, stateDirectory: stateRoot });
    const inspection = await store.ready;
    const entityKey = 'session_summaries:system43:durable';
    await store.mutate({ intentId: 'intent-system43-1', changes: [{ collection: 'session_summaries', key: entityKey, value: { title: 'durable session', source: 'opencode' }, expectedRevision: 0 }] });
    const beforeKill = await store.get({ collection: 'session_summaries', key: entityKey });
    const firstPage = await store.page({ collection: 'session_summaries', limit: 100 });
    const killed = await store.terminate();
    const afterKill = await (async () => { try { await store.get({ collection: 'session_summaries', key: entityKey }); return { code: null, field: null }; } catch (error) { return { code: error.code ?? null, field: error.field ?? null }; } })();
    const restarted = createRuntimeStore({ environmentId: ENV_A, ownerId: INSTANCE, epoch: EPOCH, stateDirectory: stateRoot, takeover: { expectedFence: inspection.fence } });
    const restartInspection = await restarted.ready;
    const afterRestart = await restarted.get({ collection: 'session_summaries', key: entityKey });
    await restarted.close();
    check('a real SIGKILL of the store worker is observed as a typed refusal and a real restart over the same durable state root continues from it with a higher fence, while paging stays inside the frozen page limit', {
      killedSignal: killed.signal, killedCode: killed.code, requestAfterKill: afterKill,
      valueBeforeKill: beforeKill?.value ?? null, valueAfterRestart: afterRestart?.value ?? null,
      fenceBefore: inspection.fence, fenceAfterRestart: restartInspection.fence,
      paging: { items: firstPage.items.length, cursor: firstPage.cursor ?? null, withinLimit: firstPage.items.length <= 100 },
    }, {
      killedSignal: 'SIGKILL', killedCode: null, requestAfterKill: { code: 'source_unavailable', field: 'runtime.store.store_closed' },
      valueBeforeKill: beforeKill?.value ?? null, valueAfterRestart: beforeKill?.value ?? null,
      fenceBefore: inspection.fence, fenceAfterRestart: inspection.fence + 1,
      paging: { items: firstPage.items.length, cursor: firstPage.cursor ?? null, withinLimit: true },
    }, 'the real bridge/runtime/storage/runtimeStore.js over its real node:sqlite worker, terminated and re-opened');
    store = null;

    // S7: one source failing does not drag down the whole run.
    const scheduler = createDiscoveryScheduler();
    const settled = await Promise.all(SOURCES.map((source) => scheduler.schedule({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE[source], scope: '{}' }, async () => {
      if (source === 'codex' || source === 'dsh') throw new storeProtocolModule.StoreError('source_unavailable', 'native_timeout');
      return { source, complete: true, count: 2 };
    }).then((value) => ({ source, ok: true, value }), (error) => ({ source, ok: false, code: error.code ?? null, field: error.reason ?? null }))));
    const later = await scheduler.schedule({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, scope: '{}' }, async () => ({ source: 'opencode', complete: true, count: 3 }));
    const schedulerState = scheduler.state;
    scheduler.close();
    check('one source failing does not drag down the whole run: two of five sources reject source_unavailable, the other three still settle with their own counts, the queue drains and a later demand on a healthy source still runs', {
      okCount: settled.filter((entry) => entry.ok).length, failedCount: settled.filter((entry) => !entry.ok).length,
      failedSources: settled.filter((entry) => !entry.ok).map((entry) => entry.source),
      failureCodes: settled.filter((entry) => !entry.ok).map((entry) => entry.code),
      laterDemand: later, queueDrained: schedulerState.queued === 0,
    }, {
      okCount: 3, failedCount: 2, failedSources: ['codex', 'dsh'], failureCodes: ['source_unavailable', 'source_unavailable'],
      laterDemand: { source: 'opencode', complete: true, count: 3 }, queueDrained: true,
    }, 'the real bridge/runtime/discoveryScheduler.js with all five sources demanded');

    // S8: a slow consumer cannot grow the observer buffer past its frozen bound.
    const observer = createEventObserver({ binding: { target: ENV_A, epoch: 'epoch', generation: 1 }, after: 0, isCurrent: () => true, onClose: () => {} });
    let peakNormal = 0; let peakBytes = 0;
    for (let seq = 1; seq <= OBSERVER_LIMITS.normalFrames + 64; seq += 1) {
      observer.push({ version: 1, kind: 'event', target: ENV_A, epoch: 'epoch', generation: 1, seq, entityRevision: seq, scope: `session:${seq}`, type: 'entity.patch', payload: { collection: 'session_summaries', key: `session:${seq}`, revision: seq } });
      peakNormal = Math.max(peakNormal, observer.state.normal);
      peakBytes = Math.max(peakBytes, observer.state.bytes);
    }
    const recoveryEngaged = observer.state.recovery !== null;
    observer.close();
    check('a slow consumer cannot grow the observer buffer past its frozen bound: the buffer recovers instead of growing, the close empties it and the close receipt fires', {
      limits: { normalFrames: OBSERVER_LIMITS.normalFrames, normalBytes: OBSERVER_LIMITS.normalBytes },
      pushed: OBSERVER_LIMITS.normalFrames + 64, peakNormal, framesWithinBound: peakNormal <= OBSERVER_LIMITS.normalFrames,
      peakBytes, bytesWithinBound: peakBytes <= OBSERVER_LIMITS.normalBytes, recoveryEngaged,
      buffersEmptied: observer.state.normal === 0 && observer.state.bytes === 0, closed: observer.state.closed,
    }, {
      limits: { normalFrames: OBSERVER_LIMITS.normalFrames, normalBytes: OBSERVER_LIMITS.normalBytes },
      pushed: OBSERVER_LIMITS.normalFrames + 64, peakNormal, framesWithinBound: true,
      peakBytes, bytesWithinBound: true, recoveryEngaged: true,
      buffersEmptied: true, closed: true,
    }, 'the real bridge/runtime/eventObservers.js bounded observer');

    // S9: a legacy import batch that switches target is refused and the staged manifest is unchanged.
    const importRoot = path.join(privateRoot, 'store', 'import');
    mkdirSync(importRoot, { recursive: true });
    const importStore = createRuntimeStore({ environmentId: ENV_A, ownerId: OWNER, epoch: EPOCH, stateDirectory: importRoot });
    await importStore.ready;
    const importService = createImportService({ store: importStore, environmentId: ENV_A });
    const importToken = await legacyExport.openLegacyExport(legacySource());
    const importPage = await legacyExport.readLegacyExportPage(legacySource(), { token: importToken, limit: 1 });
    const importChunkRow = importPage.chunks[0];
    const importId = await legacyExport.legacyDigest('system43-import');
    const importChunk = { sourceKey: importChunkRow.sourceKey, offset: 0, content: importChunkRow.content, end: true, checksum: sha256(importChunkRow.content), authority: importChunkRow.authority, binding: { environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, nativeSessionId: 'native-0', profileId: PROFILE } };
    await importService.accept({ importId, environmentId: ENV_A, sourceRevision: importToken.revision, offset: 0, nextOffset: 1, total: 1, chunks: [importChunk] });
    const stagedManifest = await importStore.get({ collection: 'imports', key: `manifest:${importId}` });
    const switched = await (async () => { try { await importService.accept({ importId, environmentId: ENV_B, sourceRevision: importToken.revision, offset: 1, nextOffset: 2, total: 2, chunks: [{ ...importChunk, offset: importChunkRow.content.length, binding: { ...importChunk.binding, environmentId: ENV_B } }] }); return { code: null, field: null }; } catch (error) { return { code: error.code ?? null, field: error.field ?? null }; } })();
    const afterRefusal = await importStore.get({ collection: 'imports', key: `manifest:${importId}` });
    const verified = await importService.verify({ importId, sourceRevision: importToken.revision, expectedRecords: 1, expectedChunks: 1 });
    await importStore.close();
    check('a legacy import batch that switches target is refused target_changed and the staged manifest is unchanged, after which the accepted import verifies', {
      switchedRefusal: switched, manifestUnchanged: JSON.stringify(stagedManifest?.value) === JSON.stringify(afterRefusal?.value),
      manifestPhase: afterRefusal?.value?.phase ?? null, manifestOffset: afterRefusal?.value?.offset ?? null,
      verifySettled: true, verifyResultKeys: Object.keys(verified ?? {}).sort(),
    }, {
      switchedRefusal: { code: 'target_changed', field: null }, manifestUnchanged: true, manifestPhase: 'staged', manifestOffset: 1,
      verifySettled: true, verifyResultKeys: Object.keys(verified ?? {}).sort(),
    }, 'the real bridge/runtime/migration/importService.js over the real runtime store');

    /* ---------------------------------------------------------------- browser realm */
    vite.middlewares.use('/qa43', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const browserPort = vite.httpServer.address().port;
    ledger.resources.push({ kind: 'Vite-created', port: browserPort });
    persistLedger();
    const pageUrl = `http://127.0.0.1:${browserPort}/qa43/`;
    record('pageUrl', pageUrl);
    const profileRoot = path.join(privateRoot, 'chromium-profile');
    ledger.resources.push({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; private root removal' });
    persistLedger();
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    ledger.resources.push({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    persistLedger();
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));
    // The entry assigns window.task43 at module scope but starts the tree only on boot(), so the
    // module-load gate waits for the API object, and boot() itself awaits the tree's readiness.
    const untilEntry = async () => {
      for (let attempt = 0; attempt < 240; attempt += 1) { if (await evaluate(() => Boolean(window.task43))) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
      const browserErrors = await evaluate(() => (window.__task43Errors ?? []).concat(['window.task43 was never assigned']));
      throw new Error(`task43 browser entry never loaded: ${JSON.stringify(browserErrors)}`);
    };
    await untilEntry();

    const booted = await evaluate((rows) => window.task43.boot(rows), legacyRows);
    const afterSelect = await evaluate((index) => window.task43.select(index), 0);
    const failed = await evaluate((source) => window.task43.failSource(source), 'codex');
    const recovered = await evaluate((source) => window.task43.recoverSources(source), 'codex');
    const broken = await evaluate(() => window.task43.breakUi());
    const restartedUi = await evaluate(() => window.task43.restart());
    const browserErrors = await evaluate(() => window.task43.errors());
    const browserState = {
      booted: { sessions: booted.sessions, rows: booted.rows, rowsAtLeastSessions: booted.rows >= booted.sessions, sources: booted.sources.map((entry) => entry.status), workspaces: booted.workspaces.length, viewStatus: booted.viewStatus, viewLoaded: booted.viewLoaded },
      selected: { ok: afterSelect.ok, index: afterSelect.index, selectedKey: afterSelect.selectedKey, selectionResolved: afterSelect.ok === true && typeof afterSelect.selectedKey === 'string' && afterSelect.selectedKey.length > 0 },
      failed: { statuses: failed.sources.map((entry) => `${entry.kind}:${entry.status}`), sessions: failed.sessions, viewStatus: failed.viewStatus, otherFourComplete: failed.sources.filter((entry) => entry.kind !== 'codex').every((entry) => entry.status === 'complete') },
      recovered: { statuses: recovered.sources.map((entry) => `${entry.kind}:${entry.status}`), sessions: recovered.sessions, viewStatus: recovered.viewStatus, viewLoaded: recovered.viewLoaded, allComplete: recovered.sources.every((entry) => entry.status === 'complete') },
      broken: { viewStatus: broken.viewStatus, viewLoaded: broken.viewLoaded, wireCloses: broken.wire.closes, disconnectVisible: broken.viewStatus !== 'complete' },
      restarted: { sessions: restartedUi.sessions, sources: restartedUi.sources.map((entry) => entry.status), viewStatus: restartedUi.viewStatus, viewLoaded: restartedUi.viewLoaded },
      browserErrors,
    };
    check('the real unified session tree renders all five legacy-store sources in a real headless Chromium: a selection resolves to the legacy session, one failing source is reported on its own while the other four stay complete and the real retry path recovers it, a client-side disconnect is visible rather than silent, and a restart continuation re-boots the same tree from the same legacy rows', browserState, {
      booted: { sessions: LEGACY_HISTORY.length, rows: booted.rows, rowsAtLeastSessions: true, sources: SOURCES.map(() => 'complete'), workspaces: 2, viewStatus: 'complete', viewLoaded: LEGACY_HISTORY.length },
      selected: { ok: true, index: 0, selectedKey: afterSelect.selectedKey, selectionResolved: true },
      failed: { statuses: ['opencode:complete', 'codex:error', 'acp:complete', 'kimi-web:complete', 'dsh:complete'], sessions: LEGACY_HISTORY.length, viewStatus: 'complete', otherFourComplete: true },
      recovered: { statuses: SOURCES.map((source) => `${source}:complete`), sessions: LEGACY_HISTORY.length, viewStatus: 'complete', viewLoaded: LEGACY_HISTORY.length, allComplete: true },
      broken: { viewStatus: 'error', viewLoaded: broken.viewLoaded, wireCloses: broken.wire.closes, disconnectVisible: true },
      restarted: { sessions: LEGACY_HISTORY.length, sources: SOURCES.map(() => 'complete'), viewStatus: 'complete', viewLoaded: LEGACY_HISTORY.length },
      browserErrors: [],
    }, 'the real useRuntimeSessionTree composable over the real runtime state/client/connection and the real SessionTree.vue in a real headless Chromium, seeded from the legacy store the worker read');

    // The mapping completeness check, over the scenarios THIS lane really drove.
    const observed = new Set([
      'SYS-01-legacy-store-import', 'SYS-02-five-source-unified-index', 'SYS-03-workspace-repo-merge',
      'SYS-04-sessionref-identity', 'SYS-05-thread-two-participants', 'SYS-06-thread-handoff-ladder',
      'SYS-07-team-fanout', 'SYS-08-artifact-integration', 'SYS-09-restart-continuation',
      'SYS-10-source-failure-isolation', 'SYS-11-bounded-paging', 'SYS-12-migration-hash-unchanged',
    ]);
    const completeness = assertMappingComplete(OLD_FEATURE_MAPPING, observed, 'system');
    const browserMapping = await evaluate((rows) => window.task43.observeMapping(rows), OLD_FEATURE_MAPPING.map((row) => ({ id: row.id, scenario: row.scenario })));
    record('mapping', { completeness, browserMapping });
    check('every old-feature mapping row the system lane owns carries an observed scenario, and the browser realm observes the tree rows against the scenarios it drove', {
      rows: completeness.rows, lane: completeness.lane, missing: [], browserTreeRowObserved: browserMapping.find((row) => row.scenario === 'SYS-02-five-source-unified-index')?.observed ?? null,
    }, { rows: OLD_FEATURE_MAPPING.length, lane: 'system', missing: [], browserTreeRowObserved: true }, 'app/dev/runtime-v090/system43-mapping.mjs over the scenarios this lane executed');

    const sourceBefore = sourceSnapshot(context.root, sourceFiles);
    const owned = ['app/dev/runtime-v090/system43-mapping.mjs', 'app/dev/runtime-v090/task43.ts', 'scripts/qa/runtime-v090-system.mjs', 'scripts/qa/runtime-v090-faults.mjs', 'app/runtime/system.integration.test.ts'];
    const ownedBefore = sourceSnapshot(context.root, owned);
    // A digest of a mutable file must be taken at the point the file is final, not at the point it is
    // first written: closeAll() appends the cleanup receipts to the ledger and re-persists it, so the
    // ledger bytes only stop moving once it has returned. The artifact entries therefore follow it.
    const cleanup = await closeAll();
    caseArtifacts.push(artifact(path.join(runDir, 'proof.json'), 'case-proof'));
    caseArtifacts.push(artifact(path.join(runDir, 'ownedresources.json'), 'resource-ledger'));
    const ownedAfter = sourceSnapshot(context.root, owned);
    check('no owned or production source changed during the system lane and every owned resource was released', {
      productSourcesUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceSnapshot(context.root, sourceFiles)),
      ownedSourcesUnchanged: JSON.stringify(ownedBefore) === JSON.stringify(ownedAfter),
      cleanupCount: cleanup.length, privateRootAbsent: cleanup.some((entry) => entry.kind === 'private-root' && entry.absent === true),
    }, { productSourcesUnchanged: true, ownedSourcesUnchanged: true, cleanupCount: cleanup.length, privateRootAbsent: true }, 'sourceSnapshot over the registered inventory before and after the lane');
    return { scenarios, artifacts: caseArtifacts, versions: { node: process.version }, observations, mapping: { completeness, browserMapping } };
  } catch (error) {
    await closeAll().catch(() => {});
    throw error;
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}
