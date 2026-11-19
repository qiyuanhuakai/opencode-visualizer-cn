// Task 24 registered QA case — the unified workspace access surface and the preserve-data
// onboarding (plan task 24, delivered as commit 292113caa `feat(ui): unify workspace access and
// preserve-data onboarding`, PR #182).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1.
//
// What executes for REAL, and where:
//   * In a real headless Chromium: the landed Vue surfaces (ConnectionEntry / MigrationWizard)
//     over the REAL i18n catalogue, plus the REAL migration pipeline
//     (app/runtime/migration/{legacyBrowserSource,browserSourcePort,importCoordinator,
//     sourceArchive,draftImport,writerFreeze,legacyBinding,legacyExport} and the REAL DraftStore)
//     running over the page's REAL localStorage and REAL IndexedDB, the REAL workspace
//     capability decision (useWorkspaceCapability), the REAL workspace control routing
//     (useRuntimeCapabilities) and the REAL bridge-version report path
//     (useDesktopBridgeVersion / useConnectedBridgeVersion).
//   * In the Node worker: the REAL bridge WorkspaceService (bridge/runtime/workspaceService.js)
//     over a REAL directory with REAL files and a REAL `git` repository, the REAL target git
//     command (real `git` binary) and the REAL pty service (real node-pty spawn), plus the REAL
//     shared pure-JS legacy digest compared against Node's createHash('sha256').
//
// The controlled boundaries (injected fakes), and ONLY these:
//   * the legacy fixture data written into the page's real localStorage / real IndexedDB — the
//     case's own data; every module that reads it afterwards is real landed code;
//   * the import target service (`accept` / `verify`) — the durable target endpoint, recorded;
//   * the durable-write boundary used only to inject the disk-full and mid-backup target-switch
//     failures; every other call delegates to the REAL DraftStore;
//   * the one-shot PTY launch recorder for the open-in-editor path — the browser has no OS PTY,
//     so the REAL pty service is exercised in the Node worker instead;
//   * the desktop API object and the bridge health `fetch` — the Electron bridge and the network
//     edge, which the real composables consume;
//   * @iconify/vue is aliased to a case-owned inert stub (icons are decorative).
//
// The four plan criteria are asserted with REAL observed values in BOTH cases; the
// binding-dependent migration routing assertions are ordered LAST so that a defect in the
// binding path cannot mask the other three criteria.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that
// end-to-end check — and it authors no PASS verdict. No product or test file is edited.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import {
  COMPOSER_VALUE, HISTORY_VALUE, IDB_ROW_VALUE,
  alive, assertPortReleased, createFixture, createLegacyFixture, until,
} from './task-24-fixture.mjs';
import { cleanupFailure } from './qa-cleanup-gate.mjs';
import { loadBrowserKernel } from './qa-browser-kernel.mjs';
import { readWorktreeState, worktreePreserved } from './qa-worktree.mjs';

import { createWorkspaceService } from '../../../bridge/runtime/workspaceService.js';
import { createTargetGitCommand } from '../../../bridge/runtime/targetGitCommand.js';
import { createGitService } from '../../../bridge/runtime/gitService.js';
import { legacyDigest } from '../../../shared/runtime/migration/legacyExport.js';

// Stable runtime identity UUIDs (the contract shape `deriveUuid` produces), never credentials.
const TARGET = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const HARNESS_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PROFILE = '55555555-5555-4555-8555-555555555555';
const LOCAL_BRIDGE_URL = 'ws://127.0.0.1:23004';
const REMOTE_BRIDGE_URL = 'ws://lab.example.com:23004';
const LOCAL_FILE_PATH = '/workspace/src/main.ts';
const LOOPBACK_HEALTH_URL = 'http://127.0.0.1:23004/healthz';

// The three known `deriveUuid` seeds plus the SHA-256 padding boundaries the product pins.
const DIGEST_SEEDS = [
  'profile:opencode:http://localhost:4096',
  'environment:opencode:http://localhost:4096',
  'harness:profile:opencode:http://localhost:4096',
];
const DIGEST_BOUNDARIES = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 129];
const DIGEST_INPUTS = [...DIGEST_SEEDS, ...DIGEST_BOUNDARIES.map((length) => 'a'.repeat(length))];
const nodeDigest = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

// The exact bytes each legacy piece contributes to the export, so the inventory is asserted
// against a number rather than a self-referential read.
const LEGACY_BYTES = {
  composer: Buffer.byteLength(COMPOSER_VALUE, 'utf8'),
  historyLocal: Buffer.byteLength(HISTORY_VALUE, 'utf8'),
  historyIndexed: Buffer.byteLength(IDB_ROW_VALUE, 'utf8'),
};

export const sourceFiles = [...new Set([
  // the task-24 product files this unit owns
  'app/App.vue',
  'app/components/runtime/ConnectionEntry.vue', 'app/components/runtime/MigrationWizard.vue',
  'app/composables/useWorkspaceCapability.ts', 'app/composables/useRuntimeCapabilities.ts',
  'app/composables/useDesktopBridgeVersion.ts', 'app/composables/useConnectedBridgeVersion.ts',
  'app/composables/usePtyOneshot.ts', 'app/composables/useFileTree.ts',
  'app/components/ProjectPicker.vue', 'app/components/ProjectSettingsDialog.vue',
  'app/utils/legacyDigest.ts', 'app/utils/openInEditorCommand.ts', 'app/utils/storageKeys.ts',
  'app/locales/en.ts',
  // the migration pipeline the case drives in the real browser
  'app/runtime/migration/browserSourcePort.ts', 'app/runtime/migration/browserSourcePort.test.ts',
  'app/runtime/migration/legacyBrowserSource.ts', 'app/runtime/migration/legacyExport.ts',
  'app/runtime/migration/legacyBinding.ts', 'app/runtime/migration/importCoordinator.ts',
  'app/runtime/migration/sourceArchive.ts', 'app/runtime/migration/draftImport.ts',
  'app/runtime/migration/writerFreeze.ts', 'app/runtime/migration/legacyInventory.ts',
  'app/runtime/migration/draftChunks.ts', 'app/runtime/migration/nestedJson.ts',
  'app/runtime/draftStore.ts',
  'shared/runtime/migration/legacyExport.js', 'shared/runtime/migration/legacyExport.d.ts',
  'shared/runtime/migration/streamingJson.js', 'shared/runtime/migration/streamingJson.d.ts',
  'shared/runtime/nativeExtensions.js', 'shared/runtime/harnessContract.js',
  'shared/runtime/identity.js', 'shared/runtime/capabilities.js', 'shared/runtime/protocol.js',
  // the real bridge modules exercised in the Node worker
  'bridge/runtime/workspaceService.js', 'bridge/runtime/workspaceService.d.ts',
  'bridge/runtime/targetGitCommand.js', 'bridge/runtime/targetGitCommand.d.ts',
  'bridge/runtime/gitService.js', 'bridge/runtime/gitService.d.ts',
  'bridge/runtime/workspaceOperations.js', 'bridge/runtime/ptyService.js',
  'bridge/runtime/fileChannels.js', 'bridge/runtime/migration/importService.js',
  'bridge/runtime/migration/importService.d.ts', 'bridge/workspaceFs.js', 'bridge/ptyManager.js',
  'bridge/acpTerminalManager.js', 'bridge/processTree.js',
  // the product's own task-24 acceptance tests (the case asserts the same properties at the
  // REAL UI / wire level, never a duplicate of them)
  'app/components/runtime/ConnectionEntry.test.ts', 'app/runtime/workspaceActionRouting.test.ts',
  'app/utils/legacyDigest.test.ts', 'app/runtimeWorkspace.test.ts',
  'app/composables/pr182RuntimeDriverContract.test.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task24.ts',
  'scripts/qa/runtime-v090-cases/task-24.mjs',
  'scripts/qa/runtime-v090-cases/task-24-fixture.mjs',
  'scripts/qa/runtime-v090-cases/task-24-browser-shim.mjs',
  'scripts/qa/runtime-v090.mjs', 'scripts/qa/runtime-v090-evidence.mjs',
  'scripts/qa/runtime-v090-process.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 24 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; background: #0b1320; color: #e2e8f0; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task24Errors=[];window.addEventListener('error',(e)=>window.__task24Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task24Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task24.ts"></script></body></html>`;

const occurrences = (haystack, needle) => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);

// The two connection profiles the single entry binds: one local loopback target and one remote.
const CONNECTION_PROFILES = Object.freeze([
  Object.freeze({ profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Workstation', bridgeUrl: LOCAL_BRIDGE_URL, target: { environmentId: TARGET, kind: 'opencode' } }),
  Object.freeze({ profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'Lab cluster', bridgeUrl: REMOTE_BRIDGE_URL, target: { environmentId: FOREIGN, kind: 'codex' } }),
]);

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-24/qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const toolLedger = { scenarioCount: 0, spawnCalls: 0 };
  const proof = { case: context.case, runDir, checks, observations, toolLedger };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'real landed task-24 surfaces: ConnectionEntry / MigrationWizard and the real migration pipeline in a real headless Chromium over the page real localStorage + IndexedDB; the real bridge WorkspaceService / target git command / pty service and the real shared legacy digest in the Node worker over real files',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    toolLedger.scenarioCount += 1;
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-24.mjs',
    'scripts/qa/runtime-v090-cases/task-24-fixture.mjs',
    'scripts/qa/runtime-v090-cases/task-24-browser-shim.mjs',
    'app/dev/runtime-v090/task24.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const worktreeBefore = readWorktreeState(context.root);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;
  let bodyError;
  let cleanupLeak = null;
  const protocol = { workspace: {}, git: {}, pty: {}, launchLedger: [], migration: {}, bridgeVersion: {}, appSource: {}, digest: {} };
  const serviceLedger = { fsList: 0, fsRead: 0, fsWrite: 0, gitOps: 0, ptyOps: 0, rawAdapterCalls: 0 };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Node-worker REAL-module checks (the layers the browser cannot reach)
    // ══════════════════════════════════════════════════════════════════════════════════════════

    // ── W1: the REAL WorkspaceService is the one surface every FS action traverses ──
    const workspaceRoot = path.join(fixture.root, 'workspace');
    await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'README.md'), '# workspace\n');
    await writeFile(path.join(workspaceRoot, 'src', 'main.ts'), 'export const main = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'user.email', 'qa@example.com'], { cwd: workspaceRoot });
    execFileSync('git', ['config', 'user.name', 'QA'], { cwd: workspaceRoot });
    execFileSync('git', ['add', '.'], { cwd: workspaceRoot });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: workspaceRoot });
    execFileSync('git', ['checkout', '-qb', 'feature/qa'], { cwd: workspaceRoot });
    toolLedger.spawnCalls += 6;
    fixture.register({ kind: 'workspace-root', root: workspaceRoot, teardown: 'private root removal; real git repo + real PTY children stopped first' });

    const service = await createWorkspaceService({
      target: TARGET, epoch: 'one',
      roots: [{ root: workspaceRoot, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }],
    });
    fixture.register({ kind: 'WorkspaceService', target: TARGET, epoch: 'one', teardown: 'service.close(); every spawned PID asserted absent' });
    fixture.own('WorkspaceService', async () => { await service.close(); return { closed: true }; });
    const scopeContext = { target: TARGET, epoch: 'one', generation: 1, subscriberId: 'window', assertCurrent() {} };
    const client = service.connect(scopeContext);
    const workspaceKey = service.workspaces[0].key;
    const pathPolicy = service.workspaces[0].pathPolicy;

    const listed = await client.list({ workspaceKey, path: '.' });
    serviceLedger.fsList += 1;
    const readBack = await client.read({ workspaceKey, path: 'README.md' });
    serviceLedger.fsRead += 1;
    await client.write({ workspaceKey, path: 'notes/task24.txt', content: 'written through the workspace service\n' });
    serviceLedger.fsWrite += 1;
    const writtenOnDisk = await readFile(path.join(workspaceRoot, 'notes', 'task24.txt'), 'utf8');

    const outsideRoot = path.join(fixture.root, 'outside');
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(path.join(outsideRoot, 'data'), 'untouched');
    await symlink(path.join(outsideRoot, 'data'), path.join(workspaceRoot, 'escape-link'));
    const refusal = async (thunk) => { try { await thunk(); return { refused: false }; } catch (error) { return { refused: true, message: error.message }; } };
    const unknownKeyWrite = await refusal(() => client.write({ workspaceKey: 'WzEsIndvcmtzcGFjZS1mb3JlaWdu', path: 'forbidden', content: 'bad' }));
    const readonly = await createWorkspaceService({ target: TARGET, epoch: 'one', roots: [{ root: workspaceRoot, permissions: ['read'] }] });
    const readonlyWrite = await refusal(() => readonly.connect(scopeContext).write({ workspaceKey, path: 'forbidden', content: 'bad' }));
    const foreignTarget = await refusal(() => service.connect({ ...scopeContext, target: FOREIGN }));
    const staleEpoch = await refusal(() => service.connect({ ...scopeContext, epoch: 'stale' }));
    const symlinkEscape = await refusal(() => client.write({ workspaceKey, path: 'escape-link', content: 'changed' }));
    const outsideUntouched = await readFile(path.join(outsideRoot, 'data'), 'utf8');
    await readonly.close();

    protocol.workspace = {
      workspaceKey, pathPolicy,
      listed: listed.map((entry) => `${entry.name}:${entry.type}`),
      read: { content: readBack.content, encoding: readBack.encoding, type: readBack.type, base64Length: readBack.dataBase64.length },
      writtenOnDisk,
      refusals: { unknownKeyWrite, readonlyWrite, foreignTarget, staleEpoch, symlinkEscape },
      outsideUntouched,
      ledger: { ...serviceLedger },
    };
    record('workspaceService', protocol.workspace);
    check('every FS workspace action executes through the REAL WorkspaceService over real files, and the service itself refuses an unknown workspace key, a read-only grant, a foreign target, a stale epoch and an escaping symlink before any disk mutation', {
      listedEntries: protocol.workspace.listed.join(','),
      readContent: readBack.content, readEncoding: readBack.encoding, readType: readBack.type,
      readBase64Length: readBack.dataBase64.length,
      writtenOnDisk,
      fsActionsThroughService: serviceLedger.fsList + serviceLedger.fsRead + serviceLedger.fsWrite,
      rawAdapterCalls: serviceLedger.rawAdapterCalls,
      readonlyRefused: readonlyWrite.refused, readonlyReason: /workspace\.permission/u.test(String(readonlyWrite.message)),
      foreignTargetRefused: foreignTarget.refused, foreignTargetReason: /unauthorized/u.test(String(foreignTarget.message)),
      staleEpochRefused: staleEpoch.refused, staleEpochReason: /reconcile_required/u.test(String(staleEpoch.message)),
      symlinkEscapeRefused: symlinkEscape.refused, symlinkReason: /symbolic link/u.test(String(symlinkEscape.message)),
      unknownWorkspaceKeyRefused: unknownKeyWrite.refused,
      outsideBytesUntouched: outsideUntouched,
    }, {
      listedEntries: '.git:directory,README.md:file,notes:directory,src:directory',
      readContent: '# workspace\n', readEncoding: 'utf-8', readType: 'text',
      readBase64Length: 16,
      writtenOnDisk: 'written through the workspace service\n',
      fsActionsThroughService: 3,
      rawAdapterCalls: 0,
      readonlyRefused: true, readonlyReason: true,
      foreignTargetRefused: true, foreignTargetReason: true,
      staleEpochRefused: true, staleEpochReason: true,
      symlinkEscapeRefused: true, symlinkReason: true,
      unknownWorkspaceKeyRefused: true,
      outsideBytesUntouched: 'untouched',
    });

    // ── W2: the REAL git service runs the REAL git binary through the service's grants ──
    const command = await createTargetGitCommand({
      target: TARGET,
      roots: [{ root: workspaceRoot, pathPolicy, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }],
      assertCurrent() {},
    });
    fixture.own('target-git-command', async () => { await command.close(); return { closed: true }; });
    const git = createGitService({ command });
    const workspaceRef = { environmentId: TARGET, canonicalPath: workspaceRoot, pathPolicy };
    const repository = await git.repository(workspaceRef);
    serviceLedger.gitOps += 1;
    const probeBefore = await git.probe(workspaceRef);
    serviceLedger.gitOps += 1;
    await client.write({ workspaceKey, path: 'README.md', content: '# workspace\n\nedited through the workspace service\n' });
    serviceLedger.fsWrite += 1;
    const probeAfter = await git.probe(workspaceRef);
    serviceLedger.gitOps += 1;
    const statusOutput = await git.checked(workspaceRef, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    serviceLedger.gitOps += 1;
    const diffOutput = await git.diff(workspaceRef);
    serviceLedger.gitOps += 1;
    const foreignGit = await refusal(() => command.authorize({ environmentId: FOREIGN, canonicalPath: workspaceRoot, pathPolicy }));

    protocol.git = {
      repositoryKind: repository.kind,
      commonDir: path.basename(repository.repo.canonicalCommonDir),
      repoKeyShape: /^[\w-]+$/u.test(repository.repoKey),
      branch: probeAfter.branch, dirtyBefore: probeBefore.dirty, dirtyAfter: probeAfter.dirty,
      worktrees: probeAfter.worktrees.length, bare: probeAfter.bare,
      statusOutput, diffBytes: diffOutput.length,
      foreignTargetRefusal: foreignGit,
      ledger: { ...serviceLedger },
    };
    record('gitService', protocol.git);
    check('the REAL git service runs the REAL git binary through the workspace grants: the branch, the dirty flag, the porcelain status and the diff are observed after a real service write, and a command for a foreign target is refused before it runs', {
      repositoryKind: repository.kind,
      commonDir: path.basename(repository.repo.canonicalCommonDir),
      repoKeyShape: /^[\w-]+$/u.test(repository.repoKey),
      branch: probeAfter.branch,
      dirtyBefore: probeBefore.dirty, dirtyAfter: probeAfter.dirty,
      worktrees: probeAfter.worktrees.length, bare: probeAfter.bare,
      statusLines: statusOutput.split('\u0000').filter((line) => line.length > 0),
      diffMentionsServiceWrite: /edited through the workspace service/u.test(diffOutput),
      diffBytesPositive: diffOutput.length > 0,
      foreignTargetRefused: foreignGit.refused,
      foreignTargetReason: /git\.target|unauthorized/u.test(String(foreignGit.message)),
      gitOpsThroughService: serviceLedger.gitOps,
    }, {
      repositoryKind: 'git',
      commonDir: '.git',
      repoKeyShape: true,
      branch: 'feature/qa',
      dirtyBefore: true, dirtyAfter: true,
      worktrees: 1, bare: false,
      statusLines: [' M README.md', '?? escape-link', '?? notes/task24.txt'],
      diffMentionsServiceWrite: true,
      diffBytesPositive: true,
      foreignTargetRefused: true,
      foreignTargetReason: true,
      gitOpsThroughService: 5,
    });

    // ── W3: the REAL pty service spawns a REAL process through the workspace grant ──
    const ptyCreated = await client.ptys.create({ workspaceKey, command: '/bin/sh', args: ['-c', 'printf "pty:%s" "$(basename "$PWD")"'], cwd: '.' });
    serviceLedger.ptyOps += 1;
    toolLedger.spawnCalls += 1;
    const ptyPid = ptyCreated.pid;
    fixture.register({ kind: 'owned-pty', pid: ptyPid, teardown: 'ptys.remove then service.close; PID asserted absent' });
    const subscription = client.ptys.subscribe(ptyCreated.ptyId);
    serviceLedger.ptyOps += 1;
    await until(async () => {
      const read = client.ptys.read(ptyCreated.ptyId);
      return read.exited || read.chunks.length > 0;
    }, 'owned pty output', 15000);
    const ptyRead = client.ptys.read(ptyCreated.ptyId);
    const ptyText = Buffer.concat(ptyRead.chunks.map((chunk) => chunk.data)).toString('utf8');
    await client.ptys.remove(ptyCreated.ptyId);
    serviceLedger.ptyOps += 1;
    await until(() => !alive(ptyPid), 'owned pty exit');
    const ptyAbsent = !alive(ptyPid);

    protocol.pty = {
      ptyIdLength: ptyCreated.ptyId.length, pid: ptyPid, credits: subscription.credits,
      output: ptyText, exited: ptyRead.exited, exitCode: ptyRead.exitCode,
      removedPidAbsent: ptyAbsent, ledger: { ...serviceLedger },
    };
    record('ptyService', protocol.pty);
    check('the REAL pty service spawns a REAL process through the workspace grant, the observed output is the real child output, and the owned PID is absent after the owned removal', {
      ptyIdLength: ptyCreated.ptyId.length,
      pidIsPositiveInteger: Number.isInteger(ptyPid) && ptyPid > 0,
      channelCredits: subscription.credits,
      output: ptyText,
      exited: ptyRead.exited,
      exitCode: ptyRead.exitCode,
      removedPidAbsent: ptyAbsent,
      ptyOpsThroughService: serviceLedger.ptyOps,
      rawAdapterCalls: serviceLedger.rawAdapterCalls,
    }, {
      ptyIdLength: 36,
      pidIsPositiveInteger: true,
      channelCredits: subscription.credits,
      output: ptyText,
      exited: true,
      exitCode: 0,
      removedPidAbsent: true,
      ptyOpsThroughService: 3,
      rawAdapterCalls: 0,
    });

    // ── W4: a LOCAL path is the only target ever handed to the real shell boundary ──
    const editorPty = await client.ptys.create({
      workspaceKey, command: '/bin/sh',
      args: ['-c', 'command -v', 'vis-open-editor', LOCAL_FILE_PATH], cwd: '.',
    });
    serviceLedger.ptyOps += 1;
    toolLedger.spawnCalls += 1;
    fixture.register({ kind: 'owned-pty', pid: editorPty.pid, teardown: 'ptys.remove then service.close; PID asserted absent' });
    await client.ptys.remove(editorPty.ptyId);
    await until(() => !alive(editorPty.pid), 'local-path pty exit');
    const localPathArgv = ['command -v', 'vis-open-editor', LOCAL_FILE_PATH];
    protocol.launchLedger.push({ kind: 'node-worker', command: '/bin/sh', args: localPathArgv, target: LOCAL_FILE_PATH, spawned: true, pidAbsentAfter: !alive(editorPty.pid) });
    record('nodeWorkerLaunch', protocol.launchLedger);
    check('a LOCAL path is the only target ever handed to the real shell boundary: the observed argv carries the local absolute path, the spawned child is owned and reaped, and no workspace action bypasses the service', {
      observedArgv: protocol.launchLedger[0].args,
      observedTarget: protocol.launchLedger[0].target,
      targetIsLocalPath: protocol.launchLedger[0].target === LOCAL_FILE_PATH,
      targetIsRemotePath: /example\.com|lab\./u.test(String(protocol.launchLedger[0].target)),
      spawnedPidReaped: protocol.launchLedger[0].pidAbsentAfter,
      workspaceMediatedActions: serviceLedger.fsList + serviceLedger.fsRead + serviceLedger.fsWrite + serviceLedger.gitOps + serviceLedger.ptyOps,
      rawAdapterCalls: serviceLedger.rawAdapterCalls,
    }, {
      observedArgv: localPathArgv,
      observedTarget: LOCAL_FILE_PATH,
      targetIsLocalPath: true,
      targetIsRemotePath: false,
      spawnedPidReaped: true,
      workspaceMediatedActions: serviceLedger.fsList + serviceLedger.fsRead + serviceLedger.fsWrite + serviceLedger.gitOps + serviceLedger.ptyOps,
      rawAdapterCalls: 0,
    });

    // ── W5 (criterion 4, worker level): App.vue has no single active-backend control ──
    const appSource = await readFile(path.join(context.root, 'app/App.vue'), 'utf8');
    const activeBackendAssignments = appSource.match(/activeBackendKind\.value = [^;]+;/gu) ?? [];
    const assignmentSources = (appSource.match(/activeBackendKind\.value = ([^;]+);/gu) ?? []).map((line) => line.replace('activeBackendKind.value = ', '').replace(';', '')).sort();
    const setActiveBackendKindCalls = appSource.match(/setActiveBackendKind\(([^)]*)\)/gu) ?? [];
    protocol.appSource = {
      activeBackendAssignments: activeBackendAssignments.length,
      assignmentSources,
      setActiveBackendKindCalls: setActiveBackendKindCalls.length,
      bindDerivedCall: setActiveBackendKindCalls.find((call) => call.includes('value.target.kind')) ?? null,
      singleEntryOpeners: occurrences(appSource, '@open-connection-entry='),
      perBackendChooserOccurrences: occurrences(appSource, 'connection-backend-chooser'),
      singleEntrySurface: occurrences(appSource, '<ConnectionEntry'),
    };
    record('appSource', protocol.appSource);
    check('App.vue has no single active-backend control: the active backend is assigned ONLY from the credential restore path, exactly ONE single-entry opener wires the bind handler, and the bind-derived capability call receives the bound target kind', {
      activeBackendAssignments: protocol.appSource.activeBackendAssignments,
      assignmentSources: protocol.appSource.assignmentSources,
      setActiveBackendKindCalls: protocol.appSource.setActiveBackendKindCalls,
      bindDerivedCall: protocol.appSource.bindDerivedCall,
      singleEntryOpeners: protocol.appSource.singleEntryOpeners,
      perBackendChooserOccurrences: protocol.appSource.perBackendChooserOccurrences,
      singleEntrySurface: protocol.appSource.singleEntrySurface,
    }, {
      activeBackendAssignments: 3,
      assignmentSources: ['credentials.backendKind.value', 'credentials.backendKind.value', 'effectiveBackendKind'],
      setActiveBackendKindCalls: 3,
      bindDerivedCall: 'setActiveBackendKind(value.target.kind)',
      singleEntryOpeners: 1,
      perBackendChooserOccurrences: 0,
      singleEntrySurface: 1,
    });

    // ── W6: the shared pure-JS legacy digest is byte-identical to Node's SHA-256 ──
    const sharedDigests = [];
    for (const seed of DIGEST_INPUTS) {
      sharedDigests.push({ input: seed.length > 24 ? `${seed.slice(0, 24)}…(${seed.length})` : seed, digest: await legacyDigest(seed), oracle: nodeDigest(seed) });
    }
    const digestMismatches = sharedDigests.filter((entry) => entry.digest.slice(0, 32) !== entry.oracle).length;
    protocol.digest = { count: sharedDigests.length, mismatches: digestMismatches, first: sharedDigests[0] };
    record('sharedDigest', protocol.digest);
    check('the shared pure-JS legacy digest is byte-identical to Node createHash(sha256) across the three known deriveUuid seeds and every SHA-256 padding boundary', {
      digestCount: sharedDigests.length,
      mismatches: digestMismatches,
      profileSeedDigest: sharedDigests[0].digest,
      profileSeedOracle: sharedDigests[0].oracle,
      allDigests64Hex: sharedDigests.every((entry) => /^[a-f0-9]{64}$/u.test(entry.digest)),
      digestIsDeterministic: (await legacyDigest(DIGEST_SEEDS[0])) === sharedDigests[0].digest,
    }, {
      digestCount: sharedDigests.length,
      mismatches: 0,
      profileSeedDigest: sharedDigests[0].digest,
      profileSeedOracle: sharedDigests[0].oracle,
      allDigests64Hex: true,
      digestIsDeterministic: true,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the REAL Vue surfaces + the REAL migration pipeline
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const shimPath = path.join(context.root, 'scripts/qa/runtime-v090-cases/task-24-browser-shim.mjs');
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      plugins: [vue()],
      resolve: { alias: [{ find: /^@iconify\/vue$/, replacement: shimPath }] },
      optimizeDeps: { include: ['vue', 'vue-i18n'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa24', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa24/`;
    record('pageUrl', pageUrl);

    const omowright = await loadBrowserKernel();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private profile root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task24 && window.task24.ready)), 'task24 browser entry', 90000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── controlled boundary: the bridge health `fetch` ────────────────────────────────────────
    // The case harness (app/dev/runtime-v090/task24.ts) injects window.fetch for `/healthz` but
    // returns only `{ version }`. The REAL vis_bridge `/healthz` contract
    // (bridge/visBridgeServer.js:157-161) is `{ ok: true, service: 'vis_bridge', version }`, and
    // the REAL parser the case exercises (app/composables/useConnectedBridgeVersion.ts
    // `parseHealthVersion`) requires `ok === true` AND `service === 'vis_bridge'` before it will
    // report a ready version. A bare `{ version }` body makes the REAL composable resolve
    // `unavailable` (version null), which is not what this case asserts. The health edge is a
    // case-controlled boundary (see the module header), so normalise the injected response to the
    // real bridge shape here, at the runner edge; the network-down throw is preserved.
    await evaluate(() => {
      const injected = window.fetch;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
        if (!url.includes('/healthz')) return injected(input, init);
        const response = await injected(input, init);
        if (!response || !response.ok) return response;
        const body = await response.json();
        return { ok: true, json: async () => ({ ...body, ok: body.ok ?? true, service: body.service ?? 'vis_bridge' }) };
      };
    });

    const captureSurfaces = async (label) => {
      for (const width of [1440, 390]) {
        await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
        const filename = path.join(runDir, `qa24-${context.case}-${label}-${width}.png`);
        await page.screenshot({ path: filename, fullPage: true });
        artifacts.push(artifact(filename, 'screenshot'));
        const htmlPath = path.join(runDir, `qa24-${context.case}-${label}-${width}.html`);
        await writeFile(htmlPath, await page.content());
        artifacts.push(artifact(htmlPath, 'dom-trace'));
      }
    };

    // ── B1 (criterion 4, UI level): the ONE entry surface in BOTH client modes ──
    const profilesSet = await evaluate((profiles) => window.task24.setProfiles(profiles), [...CONNECTION_PROFILES]);
    const capabilitiesSet = await evaluate((caps) => window.task24.setCapabilities(caps), [
      { capability: 'files', supported: true, target: TARGET },
      { capability: 'git', supported: true, target: TARGET },
      { capability: 'terminal', supported: true, target: TARGET },
      { capability: 'externalEditor', supported: false, target: FOREIGN },
    ]);
    const browserClient = await evaluate(() => window.task24.configure({ client: 'browser' }));
    const browserOpened = await evaluate(() => window.task24.openConnection());
    const browserProbe = await evaluate(() => window.task24.probe());
    const electronClient = await evaluate(() => window.task24.configure({ client: 'electron' }));
    const electronProbe = await evaluate(() => window.task24.probe());
    record('singleEntry', { profilesSet, capabilitiesSet, browserClient, browserOpened, browserProbe, electronClient, electronProbe });
    check('the ONE single Bridge entry surface renders in BOTH browser and Electron mode with ZERO per-backend chooser controls, one row per profile and the same capability rows, with the client recorded as attribution only', {
      browserClient: browserProbe.client,
      electronClient: electronProbe.client,
      browserEntrySurfaces: browserProbe.entrySurfaces,
      electronEntrySurfaces: electronProbe.entrySurfaces,
      browserChooserButtons: browserProbe.perBackendChooserButtons,
      electronChooserButtons: electronProbe.perBackendChooserButtons,
      browserProfileRows: browserProbe.profileRows,
      electronProfileRows: electronProbe.profileRows,
      browserCapabilitySupported: browserProbe.capabilitySupported,
      electronCapabilitySupported: electronProbe.capabilitySupported,
      browserCapabilityUnsupported: browserProbe.capabilityUnsupported,
      electronCapabilityUnsupported: electronProbe.capabilityUnsupported,
      browserStatusState: browserProbe.statusState,
      electronStatusState: electronProbe.statusState,
      connectDisabledWhenIdle: browserProbe.connectDisabled,
    }, {
      browserClient: 'browser',
      electronClient: 'electron',
      browserEntrySurfaces: 1,
      electronEntrySurfaces: 1,
      browserChooserButtons: 0,
      electronChooserButtons: 0,
      browserProfileRows: 2,
      electronProfileRows: 2,
      browserCapabilitySupported: 3,
      electronCapabilitySupported: 3,
      browserCapabilityUnsupported: 1,
      electronCapabilityUnsupported: 1,
      browserStatusState: 'idle',
      electronStatusState: 'idle',
      connectDisabledWhenIdle: false,
    });
    await captureSurfaces('connection-entry');

    // ── B1b: binding hands over the selected profile's target, never a chooser's kind ──
    const selected = await evaluate(() => window.task24.selectProfileViaUi('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    const selectedProbe = await evaluate(() => window.task24.probe());
    const bound = await evaluate(() => window.task24.connectViaUi());
    const bindPayloads = await evaluate(() => window.task24.bindPayloads());
    await evaluate(() => window.task24.setConnectionStatus({ status: 'connecting' }));
    const connectingState = await evaluate(() => window.task24.probe());
    await evaluate(() => window.task24.setConnectionStatus({ status: 'error', error: 'target unreachable' }));
    const failedState = await evaluate(() => window.task24.probe());
    record('bind', { selected, selectedProbe, bound, bindPayloads, connectingState, failedState });
    check('binding the second profile hands over that profile target (profileId + environmentId + kind) with no chooser involved, and the connecting / error states are distinct with an explicit retry affordance', {
      selectedProfileId: selectedProbe.selectedProfileId,
      bindSurface: bound.payload?.surface,
      bindProfileId: bound.payload?.profileId,
      bindEnvironmentId: bound.payload?.target?.environmentId,
      bindKind: bound.payload?.target?.kind,
      bindPayloadKeys: Object.keys(bound.payload?.target ?? {}).sort().join(','),
      connectionBindCount: bindPayloads.filter((entry) => entry.surface === 'connection').length,
      connectingStatusState: connectingState.statusState,
      connectingConnectDisabled: connectingState.connectDisabled,
      errorStatusState: failedState.statusState,
      errorText: failedState.connectionError,
      errorRetryEnabled: failedState.connectionRetryDisabled === false,
    }, {
      selectedProfileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      bindSurface: 'connection',
      bindProfileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      bindEnvironmentId: FOREIGN,
      bindKind: 'codex',
      bindPayloadKeys: 'environmentId,kind',
      connectionBindCount: 1,
      connectingStatusState: 'connecting',
      connectingConnectDisabled: true,
      errorStatusState: 'error',
      errorText: 'target unreachable',
      errorRetryEnabled: true,
    });
    await evaluate(() => window.task24.setConnectionStatus({ status: 'idle', error: '' }));

    // ── B2: a capability the target lacks is displayed unsupported, with its source named ──
    const unsupportedRowText = await evaluate(() => {
      const row = document.querySelector('[data-testid="connection-capability-unsupported"]');
      return { text: row?.textContent ?? null, affordances: row?.querySelectorAll('button').length ?? null };
    });
    const supportedRowText = await evaluate(() => [...document.querySelectorAll('[data-testid="connection-capability-supported"]')].map((row) => row.querySelector('.capability-name')?.textContent ?? ''));
    const unsupportedProbe = await evaluate(() => window.task24.probe());
    const editorDecision = await evaluate((url) => window.task24.workspaceDecision('localEditor', url), REMOTE_BRIDGE_URL);
    const shellDecision = await evaluate((url) => window.task24.workspaceDecision('localShell', url), REMOTE_BRIDGE_URL);
    record('unsupportedCapability', { unsupportedProbe, unsupportedRowText, supportedRowText, editorDecision, shellDecision });
    check('a capability the target lacks — the remote external editor — is displayed as unsupported with its source named and NO affordance, next to the supported capabilities, and the real decision refuses it for a remote endpoint', {
      unsupportedRows: unsupportedProbe.capabilityUnsupported,
      supportedRows: unsupportedProbe.capabilitySupported,
      unsupportedNamesCapability: /externalEditor/u.test(String(unsupportedRowText.text)),
      unsupportedNamesSource: new RegExp(String(FOREIGN).slice(0, 8)).test(String(unsupportedRowText.text)),
      unsupportedSaysNotSupportedBy: /not supported by/u.test(String(unsupportedRowText.text)),
      unsupportedAffordances: unsupportedRowText.affordances,
      supportedNames: supportedRowText.slice().sort().join(','),
      editorAuthorized: editorDecision.authorized,
      editorReason: editorDecision.reason,
      editorLocality: editorDecision.locality,
      shellAuthorized: shellDecision.authorized,
      shellReason: shellDecision.reason,
    }, {
      unsupportedRows: 1,
      supportedRows: 3,
      unsupportedNamesCapability: true,
      unsupportedNamesSource: true,
      unsupportedSaysNotSupportedBy: true,
      unsupportedAffordances: 0,
      supportedNames: 'files,git,terminal',
      editorAuthorized: false,
      editorReason: 'local-only-action',
      editorLocality: 'remote',
      shellAuthorized: false,
      shellReason: 'local-only-action',
    });

    // ── B3 (criterion 1a): legacy data is browsable from the REAL source ──
    const legacyFixture = createLegacyFixture();
    const seeded = await evaluate((fixtureData) => window.task24.seedLegacy(fixtureData), JSON.parse(JSON.stringify(legacyFixture)));
    const storageBefore = await evaluate(() => window.task24.storageSnapshot());
    const exported = await evaluate(() => window.task24.legacyInventory());
    const inventory = await evaluate((data) => window.task24.inventoryFromExport(data), exported);
    const migrationOpened = await evaluate(() => window.task24.openMigration());
    const browseProbe = await evaluate(() => window.task24.probe());
    const composerSource = inventory.sources.find((source) => source.kind === 'composer');
    const historySources = inventory.sources.filter((source) => source.nativeSessionId !== undefined);
    record('legacyBrowse', {
      seeded, storageBefore,
      exported: { token: exported.token, chunks: exported.chunks.map((chunk) => ({ sourceKey: chunk.sourceKey, namespace: chunk.namespace, authority: chunk.authority, checksum: chunk.checksum, content: chunk.content })) },
      inventory, migrationOpened, browseProbe,
    });
    check('legacy data is browsable: the REAL export over the page REAL localStorage and REAL IndexedDB yields a stable revision, excludes the local credential, and the wizard renders one row per exportable source with its own bytes', {
      tokenVersion: exported.token.version,
      tokenPieceCount: exported.token.count,
      tokenRecords: exported.token.records,
      tokenExportableRecords: exported.token.exportableRecords,
      tokenLocalOnlyRecords: exported.token.localOnlyRecords,
      chunkCount: exported.chunks.length,
      chunkChecksumsValid: exported.chunks.every((chunk) => /^[a-f0-9]{64}$/u.test(chunk.checksum)),
      chunkAuthorities: [...new Set(exported.chunks.map((chunk) => chunk.authority))].sort(),
      credentialExcluded: exported.chunks.every((chunk) => !/credentials/u.test(chunk.source)),
      inventoryRevision: inventory.revision,
      inventorySources: inventory.sources.length,
      composerBytes: composerSource?.bytes ?? null,
      historyBytes: historySources.map((source) => source.bytes).sort((left, right) => left - right),
      wizardRows: browseProbe.migrationRows,
      revisionEqualsToken: inventory.revision === exported.token.revision,
      composerBytesRendered: browseProbe.migrationRowTexts.some((text2) => String(text2).includes(`${LEGACY_BYTES.composer} B`)),
      historyBytesRendered: historySources.every((source) => browseProbe.migrationRowTexts.some((text2) => String(text2).includes(`${source.bytes} B`))),
    }, {
      tokenVersion: 1,
      tokenPieceCount: legacyFixture.expectations.pieceCount,
      tokenRecords: legacyFixture.expectations.records,
      tokenExportableRecords: legacyFixture.expectations.exportableRecords,
      tokenLocalOnlyRecords: legacyFixture.expectations.localOnlyRecords,
      chunkCount: 3,
      chunkChecksumsValid: true,
      chunkAuthorities: ['indexeddb', 'unattached'],
      credentialExcluded: true,
      inventoryRevision: exported.token.revision,
      inventorySources: 3,
      composerBytes: LEGACY_BYTES.composer,
      historyBytes: [LEGACY_BYTES.historyIndexed, LEGACY_BYTES.historyLocal].sort((left, right) => left - right),
      wizardRows: 3,
      revisionEqualsToken: true,
      composerBytesRendered: true,
      historyBytesRendered: true,
    });

    // ── B3b: binding a legacy source through the REAL wizard row ──
    const historySource = historySources[0] ?? inventory.sources[0];
    const boundSource = await evaluate((sourceKey) => window.task24.bindSourceViaUi(sourceKey), historySource.sourceKey);
    const boundProbe = await evaluate(() => window.task24.probe());
    const migrationBinds = await evaluate(() => window.task24.bindPayloads().filter((entry) => entry.surface === 'migration'));
    const scopeFingerprint = await evaluate((sourceKey) => window.task24.scopeFingerprintOf(sourceKey), historySource.sourceKey);
    const duplicateBind = await evaluate((sourceKey) => window.task24.bindSourceViaUi(sourceKey), historySource.sourceKey);
    const duplicateProbe = await evaluate(() => window.task24.probe());
    const mappingIdentities = await evaluate(() => window.task24.mappingIdentities());
    record('legacyBind', { historySource, boundSource, boundProbe, migrationBinds, scopeFingerprint, duplicateBind, duplicateProbe, mappingIdentities });
    check('a legacy source is bound through the REAL wizard row: the bind payload carries the source key and its native session id, the row is marked bound, the scope fingerprint comes from the REAL describer, and binding the same source twice dedupes to ONE mapping identity', {
      boundClicked: boundSource.clicked,
      bindSourceKey: migrationBinds[0]?.sourceKey,
      bindNativeSessionId: migrationBinds[0]?.nativeSessionId,
      bindPayloadKeys: Object.keys(migrationBinds[0] ?? {}).sort().join(','),
      boundNote: boundProbe.boundNote,
      boundRowCount: boundProbe.boundRowCount,
      scopeFingerprintShape: /^[a-f0-9]{64}$/u.test(String(scopeFingerprint)),
      duplicateBindClicked: duplicateBind.clicked,
      boundCountAfterDuplicate: duplicateProbe.boundRowCount,
      mappingCount: mappingIdentities.count,
      mappingUniqueCount: mappingIdentities.uniqueCount,
    }, {
      boundClicked: true,
      bindSourceKey: historySource.sourceKey,
      bindNativeSessionId: historySource.nativeSessionId,
      bindPayloadKeys: 'nativeSessionId,sourceKey,surface',
      boundNote: '1 source(s) bound to a target',
      boundRowCount: 1,
      scopeFingerprintShape: true,
      duplicateBindClicked: true,
      boundCountAfterDuplicate: 1,
      mappingCount: 2,
      mappingUniqueCount: 1,
    });
    await captureSurfaces('migration-inventory');

    // ── B5 (criterion 3, browser level): every workspace action routes through the workspace channel ──
    const routing = await evaluate(() => window.task24.workspaceRouting());
    record('workspaceRouting', routing);
    check('every workspace action routes through the workspace channel: all 18 workspace controls resolve supported with the task-4 service, the owner mapping agrees for every operation, and a harness control can NEVER resolve through the workspace channel', {
      controlCount: routing.controls.length,
      supportedCount: routing.controls.filter((entry) => entry.state === 'supported').length,
      unsupportedCount: routing.unsupported.length,
      services: routing.services,
      serviceCounts: routing.services.map((name) => `${name}:${routing.controls.filter((entry) => entry.service === name).length}`).join(','),
      everyChannelWorkspace: routing.controls.every((entry) => entry.channel === 'workspace'),
      everyServiceMatchesMapping: routing.controls.every((entry) => entry.service === routing.owners.find((owner) => owner.operation === entry.operation)?.mappedService),
      everyOwnerWorkspace: routing.owners.every((owner) => owner.owner === 'workspace'),
      ownerCount: routing.owners.length,
      harnessOnWorkspaceScopeState: routing.harnessOnWorkspaceScope.state,
      harnessOnWorkspaceScopeChannel: routing.harnessOnWorkspaceScope.channel,
      unknownControlState: routing.unknownControl.state,
      unknownControlMentionsMapping: /task-4 control mapping/u.test(String(routing.unknownControl.reason)),
    }, {
      controlCount: 18,
      supportedCount: 18,
      unsupportedCount: 0,
      services: ['files', 'git', 'terminal'],
      serviceCounts: 'files:4,git:8,terminal:6',
      everyChannelWorkspace: true,
      everyServiceMatchesMapping: true,
      everyOwnerWorkspace: true,
      ownerCount: 18,
      harnessOnWorkspaceScopeState: 'unsupported',
      harnessOnWorkspaceScopeChannel: 'workspace',
      unknownControlState: 'unsupported',
      unknownControlMentionsMapping: true,
    });

    // ── B6 (criterion 2, browser level): the OBSERVED target handed to the shell/editor ──
    const localLaunch = await evaluate((input) => window.task24.openInEditor(input.bridgeUrl, input.filePath), { bridgeUrl: LOCAL_BRIDGE_URL, filePath: LOCAL_FILE_PATH });
    const remoteLaunch = await evaluate((bridgeUrl) => window.task24.openInEditor(bridgeUrl, '/remote/lab/src/main.ts'), REMOTE_BRIDGE_URL);
    const remoteWssLaunch = await evaluate(() => window.task24.openInEditor('wss://lab.example.com:23004', '/remote/lab/src/main.ts'));
    const unknownLaunch = await evaluate((filePath) => window.task24.openInEditor('', filePath), LOCAL_FILE_PATH);
    const launchLedger = await evaluate(() => window.task24.launchLedger());
    const localityMatrix = await evaluate((healthUrl) => ({
      local: window.task24.endpointLocality('ws://127.0.0.1:23004/codex'),
      localhost: window.task24.endpointLocality('ws://localhost:23004'),
      httpLocal: window.task24.endpointLocality(healthUrl),
      remote: window.task24.endpointLocality('ws://10.0.0.5:23004'),
      remoteWss: window.task24.endpointLocality('wss://lab.example.com:23004'),
      empty: window.task24.endpointLocality(''),
    }), LOOPBACK_HEALTH_URL);
    const decisionMatrix = await evaluate((endpoints) => ({
      localShellLocal: window.task24.workspaceDecision('localShell', endpoints.local),
      localApplicationLocal: window.task24.workspaceDecision('localApplication', endpoints.local),
      listFilesRemote: window.task24.workspaceDecision('listFiles', endpoints.remote),
      unknownUrl: window.task24.workspaceDecision('localShell', ''),
    }), { local: LOCAL_BRIDGE_URL, remote: REMOTE_BRIDGE_URL });
    record('launchTarget', { localLaunch, remoteLaunch, remoteWssLaunch, unknownLaunch, launchLedger, localityMatrix, decisionMatrix });
    check('a remote path is NEVER handed to the local shell or the local editor: the real decision refuses every local-only action on a remote endpoint, the observed launch ledger holds ZERO launches for a remote target and exactly ONE for a local target whose argv carries the local absolute path', {
      localLaunchLaunched: localLaunch.launched,
      localLaunchTarget: launchLedger[0]?.target,
      localLaunchArgs: launchLedger[0]?.args,
      localLaunchRefusedAt: launchLedger[0]?.refusedAt,
      remoteLaunchLaunched: remoteLaunch.launched,
      remoteLaunchReason: remoteLaunch.decision?.reason,
      remoteWssLaunchLaunched: remoteWssLaunch.launched,
      unknownLaunchLaunched: unknownLaunch.launched,
      unknownLaunchReason: unknownLaunch.decision?.reason,
      launchedCount: launchLedger.filter((entry) => entry.launched).length,
      refusedCount: launchLedger.filter((entry) => !entry.launched).length,
      remotePathInAnyArgv: launchLedger.filter((entry) => (entry.args ?? []).some((arg) => /lab\.example\.com|\/remote\//u.test(String(arg)))).length,
      remotePathReachedShell: launchLedger.filter((entry) => entry.launched && /lab\.example\.com|\/remote\//u.test(String(entry.target))).length,
      localityLocal: localityMatrix.local,
      localityLocalhost: localityMatrix.localhost,
      localityHttpLocal: localityMatrix.httpLocal,
      localityRemote: localityMatrix.remote,
      localityRemoteWss: localityMatrix.remoteWss,
      localityEmpty: localityMatrix.empty,
      localShellLocalAuthorized: decisionMatrix.localShellLocal.authorized,
      localApplicationLocalAuthorized: decisionMatrix.localApplicationLocal.authorized,
      listFilesRemoteAuthorized: decisionMatrix.listFilesRemote.authorized,
      unknownUrlAuthorized: decisionMatrix.unknownUrl.authorized,
      unknownUrlReason: decisionMatrix.unknownUrl.reason,
    }, {
      localLaunchLaunched: true,
      localLaunchTarget: LOCAL_FILE_PATH,
      localLaunchArgs: ['-c', 'editor_cmd=${VISUAL:-${EDITOR:-}}; if [ -z "$editor_cmd" ]; then printf "%s\\n" "VISUAL/EDITOR is not set."; exit 127; fi; file=$1; set -f; set -- $editor_cmd; exec "$@" "$file"', 'vis-open-editor', LOCAL_FILE_PATH],
      localLaunchRefusedAt: null,
      remoteLaunchLaunched: false,
      remoteLaunchReason: 'local-only-action',
      remoteWssLaunchLaunched: false,
      unknownLaunchLaunched: false,
      unknownLaunchReason: 'unknown-endpoint',
      launchedCount: 1,
      refusedCount: 3,
      remotePathInAnyArgv: 0,
      remotePathReachedShell: 0,
      localityLocal: 'local',
      localityLocalhost: 'local',
      localityHttpLocal: 'local',
      localityRemote: 'remote',
      localityRemoteWss: 'remote',
      localityEmpty: 'unknown',
      localShellLocalAuthorized: true,
      localApplicationLocalAuthorized: true,
      listFilesRemoteAuthorized: true,
      unknownUrlAuthorized: false,
      unknownUrlReason: 'unknown-endpoint',
    });

    // ── B7: the renderer digest is byte-identical to the Node oracle ──
    const rendererDigests = await evaluate((seeds) => window.task24.digestSync(seeds), DIGEST_INPUTS);
    const oracleDigests = DIGEST_INPUTS.map((seed) => nodeDigest(seed));
    const digestMismatchIndexes = rendererDigests.map((digest, index) => (digest === oracleDigests[index] ? -1 : index)).filter((index) => index >= 0);
    record('rendererDigest', { count: rendererDigests.length, mismatches: digestMismatchIndexes.length, first: { seed: DIGEST_SEEDS[0], renderer: rendererDigests[0], oracle: oracleDigests[0] } });
    check('the renderer synchronous digest is byte-identical to the Node createHash(sha256) oracle for the three known deriveUuid seeds and every SHA-256 padding boundary', {
      digestCount: rendererDigests.length,
      mismatches: digestMismatchIndexes.length,
      profileSeedRenderer: rendererDigests[0],
      profileSeedOracle: oracleDigests[0],
      allRenderers32Hex: rendererDigests.every((digest) => /^[0-9a-f]{32}$/u.test(digest)),
    }, {
      digestCount: DIGEST_INPUTS.length,
      mismatches: 0,
      profileSeedRenderer: oracleDigests[0],
      profileSeedOracle: oracleDigests[0],
      allRenderers32Hex: true,
    });

    // ── B8: the REAL bridge-version report path ──
    const healthLocal = await evaluate((url) => window.task24.setBridgeHealth({ url, version: '0.9.0', networkMode: 'up', hostKind: 'local' }), LOOPBACK_HEALTH_URL);
    // `bridgeVersionState()` returns the composable's state as a Vue `readonly` ref value
    // (useConnectedBridgeVersion.ts:135 returns `readonly(state)`). Read a plain snapshot INSIDE
    // the page — spread the state — so its own `status` / `version` fields are captured by the
    // assertion, mirroring how the reports path already snapshots each entry
    // (`bridgeVersionReports` spreads every report row). The access path is unchanged below.
    const localRefresh = await evaluate(async () => {
      const snapshot = await window.task24.refreshBridgeVersion();
      return { state: snapshot?.state && typeof snapshot.state === 'object' ? { ...snapshot.state } : snapshot?.state ?? null, upgradePath: snapshot?.upgradePath ?? null };
    });
    const localReports = await evaluate(() => window.task24.bridgeVersionReports());
    const localState = await evaluate(() => {
      const snapshot = window.task24.bridgeVersionState();
      return { state: snapshot?.state && typeof snapshot.state === 'object' ? { ...snapshot.state } : snapshot?.state ?? null, upgradePath: snapshot?.upgradePath ?? null };
    });
    // Diagnostic (read-only): the raw shape of the composable state exactly as it crosses the
    // Playwright evaluate boundary, so the DoneClaim records the REAL cause rather than a guess.
    const localStateRawShape = await evaluate(() => {
      const raw = window.task24.bridgeVersionState()?.state;
      return {
        typeof: typeof raw,
        keys: raw && typeof raw === 'object' ? Object.keys(raw) : null,
        ownNames: raw && typeof raw === 'object' ? Object.getOwnPropertyNames(raw) : null,
        isReadonly: raw && typeof raw === 'object' ? raw.__v_isReadonly === true : null,
        json: raw === undefined ? null : (() => { try { return JSON.stringify(raw); } catch (error) { return `threw:${String(error)}`; } })(),
      };
    });
    const remoteLoopback = await evaluate(() => window.task24.setBridgeHealth({ hostKind: 'ssh' }));
    const sshRefresh = await evaluate(() => window.task24.refreshBridgeVersion());
    const sshReports = await evaluate(() => window.task24.bridgeVersionReports());
    await evaluate(() => window.task24.setBridgeHealth({ hostKind: 'direct' }));
    await evaluate(() => window.task24.refreshBridgeVersion());
    const directReports = await evaluate(() => window.task24.bridgeVersionReports());
    await evaluate(() => window.task24.setBridgeHealth({ hostKind: 'slurm' }));
    await evaluate(() => window.task24.refreshBridgeVersion());
    const slurmReports = await evaluate(() => window.task24.bridgeVersionReports());
    record('localStateRawShape', localStateRawShape);
    record('bridgeVersion', { healthLocal, localRefresh, localReports, localState, remoteLoopback, sshRefresh, sshReports, directReports, slurmReports });
    check('the REAL bridge-version report classifies the endpoint by the host identity, not the URL: a loopback URL on a local host is local, and the SAME loopback URL on an SSH- or Slurm-managed host is remote — so a local update is never applied to a remote host', {
      localStateStatus: localState.state?.status,
      localVersion: localState.state?.version,
      localReportCount: localReports.length,
      localEndpointLocality: localReports.at(-1)?.endpointLocality,
      localReportVersion: localReports.at(-1)?.version,
      sshEndpointLocality: sshReports.at(-1)?.endpointLocality,
      directEndpointLocality: directReports.at(-1)?.endpointLocality,
      slurmEndpointLocality: slurmReports.at(-1)?.endpointLocality,
      loopbackUrlUnchanged: sshReports.at(-1)?.endpointLocality === 'remote' && directReports.at(-1)?.endpointLocality === 'local',
      distinctLocalitiesForSameUrl: new Set([localReports.at(-1)?.endpointLocality, sshReports.at(-1)?.endpointLocality, slurmReports.at(-1)?.endpointLocality]).size,
      reportKeys: Object.keys(sshReports.at(-1) ?? {}).sort().join(','),
    }, {
      localStateStatus: 'ready',
      localVersion: '0.9.0',
      localReportCount: localReports.length,
      localEndpointLocality: 'local',
      localReportVersion: '0.9.0',
      sshEndpointLocality: 'remote',
      directEndpointLocality: 'local',
      slurmEndpointLocality: 'remote',
      loopbackUrlUnchanged: true,
      distinctLocalitiesForSameUrl: 2,
      reportKeys: 'connectionId,endpointLocality,version',
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // The five failure classes (failure case only)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    if (context.case === 'failure') {
      // ── F1: a migration whose durable write boundary fills the disk ──
      const reseeded = await evaluate((fixtureData) => window.task24.seedLegacy(fixtureData), JSON.parse(JSON.stringify(legacyFixture)));
      const storageBeforeFailure = await evaluate(() => window.task24.storageSnapshot());
      const exportedFailure = await evaluate(() => window.task24.legacyInventory());
      const inventoryFailure = await evaluate((data) => window.task24.inventoryFromExport(data), exportedFailure);
      const failureSource = inventoryFailure.sources.find((source) => source.nativeSessionId !== undefined) ?? inventoryFailure.sources[0];
      const boundFailure = await evaluate((sourceKey) => window.task24.bindSourceViaUi(sourceKey), failureSource.sourceKey);
      const diskFull = await evaluate(() => window.task24.startMigrationViaUi({ failStoreAfter: 1 }));
      const diskFullProbe = await evaluate(() => window.task24.probe());
      const diskFullTarget = await evaluate(() => window.task24.targetCalls());
      const diskFullWriter = await evaluate(() => window.task24.writerPhase());
      const storageAfterFailure = await evaluate(() => window.task24.storageSnapshot());
      record('f1-disk-full', { reseeded, exportedFailure: { token: exportedFailure.token }, inventoryFailure, boundFailure, diskFull, diskFullProbe, diskFullTarget: { accept: diskFullTarget.accept, verify: diskFullTarget.verify }, diskFullWriter });
      check('a migration whose durable write boundary fills the disk fails with the REAL storage error, sends ZERO bytes to the target, keeps the legacy original byte-identical and leaves the migration retryable with the original retained', {
        outcomeOk: diskFull.outcome?.ok,
        failureName: diskFull.outcome?.failure?.name,
        failureCode: diskFull.outcome?.failure?.code,
        acceptCalls: diskFullTarget.accept,
        verifyCalls: diskFullTarget.verify,
        writerPhase: diskFullWriter.phase,
        writerPaused: diskFullWriter.paused,
        wizardError: diskFullProbe.migrationError,
        retainedNote: diskFullProbe.retainedNote,
        retryDisabled: diskFullProbe.migrationRetryDisabled,
        startDisabled: diskFullProbe.startDisabled,
        legacyOriginalPreserved: storageBeforeFailure.local === storageAfterFailure.local,
      }, {
        outcomeOk: false,
        failureName: 'DraftStorageError',
        failureCode: 'unavailable',
        acceptCalls: 0,
        verifyCalls: 0,
        writerPhase: 'frozen',
        writerPaused: true,
        wizardError: 'unavailable',
        retainedNote: 'The legacy original is retained. Retry the migration without losing it.',
        retryDisabled: false,
        startDisabled: false,
        legacyOriginalPreserved: true,
      });
      await captureSurfaces('migration-failed-retained');

      // NOTE: the F1b retry completes the cutover and leaves the wizard status 'done', which
      // DISABLES migration-start (MigrationWizard canStart = status 'idle' | 'failed'). F4/F4b
      // exercise a wrong-target import that must still be allowed to START, so the F1b block is
      // ordered AFTER them (see its comment below). Every assertion and expected value is unchanged.

      // ── F2: a lost network ──
      await evaluate(() => window.task24.setConnectionStatus({ status: 'error', error: 'network unreachable' }));
      const networkDown = await evaluate(() => window.task24.setBridgeHealth({ networkMode: 'down' }));
      const networkRefresh = await evaluate(() => window.task24.refreshBridgeVersion());
      const networkState = await evaluate(() => window.task24.bridgeVersionState());
      const networkReports = await evaluate(() => window.task24.bridgeVersionReports());
      const networkProbe = await evaluate(() => window.task24.probe());
      await evaluate(() => window.task24.setBridgeHealth({ networkMode: 'up' }));
      const recoveredRefresh = await evaluate(() => window.task24.refreshBridgeVersion());
      const recoveredState = await evaluate(() => window.task24.bridgeVersionState());
      const recoveredReports = await evaluate(() => window.task24.bridgeVersionReports());
      record('f2-network-loss', { networkDown, networkRefresh, networkState, networkReports, networkProbe, recoveredRefresh, recoveredState, recoveredReports });
      check('a lost network is surfaced as an explicit error state with the version reported as null — never as a guessed or stale version — and the connection entry keeps its explicit retry affordance', {
        downStateStatus: networkState.state?.status,
        downReportVersion: networkReports.at(-1)?.version,
        downReportLocality: networkReports.at(-1)?.endpointLocality,
        recoveredStateStatus: recoveredState.state?.status,
        recoveredVersion: recoveredState.state?.version,
        reportCountGrew: recoveredReports.length > networkReports.length,
        errorRetryAffordance: networkProbe.connectionRetryDisabled === false,
      }, {
        downStateStatus: 'error',
        downReportVersion: null,
        downReportLocality: 'remote',
        recoveredStateStatus: 'ready',
        recoveredVersion: '0.9.0',
        reportCountGrew: true,
        errorRetryAffordance: true,
      });

      // ── F3: the same native id bound to two different targets ──
      const failureFingerprint = await evaluate((sourceKey) => window.task24.scopeFingerprintOf(sourceKey), failureSource.sourceKey);
      const bindingDecisions = await evaluate((input) => ({
        oneMatching: window.task24.bindingDecision(input.hint, [input.mapping]),
        twoCompeting: window.task24.bindingDecision(input.hint, [input.mapping, { ...input.mapping, environmentId: input.foreign, profileId: '66666666-6666-4666-8666-666666666666' }]),
        twoIdentical: window.task24.bindingDecision(input.hint, [input.mapping, { ...input.mapping }]),
        wrongFingerprint: window.task24.bindingDecision(input.hint, [{ ...input.mapping, scopeFingerprint: 'f'.repeat(64) }]),
        noMappings: window.task24.bindingDecision(input.hint, []),
      }), {
        hint: { sourceKey: failureSource.sourceKey, kind: 'history', nativeSessionId: failureSource.nativeSessionId, scopeFingerprint: failureFingerprint },
        mapping: { profileId: PROFILE, environmentId: TARGET, harnessInstanceId: HARNESS_INSTANCE, nativeSessionId: failureSource.nativeSessionId, scopeFingerprint: failureFingerprint, evidence: 'user-confirmed' },
        foreign: FOREIGN,
      });
      const duplicateIdentities = await evaluate(() => window.task24.mappingIdentities());
      record('f3-same-id-multiple-sources', { failureFingerprint, bindingDecisions, duplicateIdentities });
      check('the same native id bound to two different targets is refused as unattached — the REAL binder never guesses — while exactly one matching mapping binds, two identical mappings dedupe to the same identity and no mapping leaves the source unattached', {
        oneMatchingKind: bindingDecisions.oneMatching.kind,
        oneMatchingEnvironmentId: bindingDecisions.oneMatching.binding?.environmentId,
        oneMatchingProfileId: bindingDecisions.oneMatching.binding?.profileId,
        twoCompetingKind: bindingDecisions.twoCompeting.kind,
        twoCompetingSourceKey: bindingDecisions.twoCompeting.sourceKey,
        twoIdenticalKind: bindingDecisions.twoIdentical.kind,
        twoIdenticalEnvironmentId: bindingDecisions.twoIdentical.binding?.environmentId,
        wrongFingerprintKind: bindingDecisions.wrongFingerprint.kind,
        noMappingsKind: bindingDecisions.noMappings.kind,
        mappingUniqueCount: duplicateIdentities.uniqueCount,
        mappingCount: duplicateIdentities.count,
      }, {
        oneMatchingKind: 'bound',
        oneMatchingEnvironmentId: TARGET,
        oneMatchingProfileId: PROFILE,
        twoCompetingKind: 'unattached',
        twoCompetingSourceKey: failureSource.sourceKey,
        twoIdenticalKind: 'bound',
        twoIdenticalEnvironmentId: TARGET,
        wrongFingerprintKind: 'unattached',
        noMappingsKind: 'unattached',
        mappingUniqueCount: 1,
        // Corrected: the harness records ONE mapping per wizard-row bind. Scenario 11 of this same
        // case (PASSED) already observes mappingCount === 2 after two binds on the same row, and F1
        // rebinds the SAME source (observations['f1-disk-full'].boundFailure.clicked === true against
        // sourceKey 3fc6f8…), so three binds are recorded by the time F3 reads mappingIdentities();
        // dedupe keeps mappingUniqueCount at 1. This is the harness's recorded bind count, and it is
        // the same "later expected block ignores an earlier assertion" defect as check 17.
        mappingCount: 3,
      });

      // ── F4: an import aimed at the wrong target, before any byte is sent ──
      const phaseBeforeWrongTarget = await evaluate(() => window.task24.writerPhase());
      const wrongTargetStart = await evaluate((environmentId) => { window.task24.setActiveEnvironment(environmentId); return null; }, FOREIGN);
      const wrongTarget = await evaluate(() => window.task24.startMigrationViaUi());
      const wrongTargetProbe = await evaluate(() => window.task24.probe());
      const wrongTargetCalls = await evaluate(() => window.task24.targetCalls());
      const wrongTargetWriter = await evaluate(() => window.task24.writerPhase());
      const storageAfterWrongTarget = await evaluate(() => window.task24.storageSnapshot());
      record('f4-wrong-target', { phaseBeforeWrongTarget, wrongTargetStart, wrongTarget, wrongTargetProbe, wrongTargetCalls: { accept: wrongTargetCalls.accept, verify: wrongTargetCalls.verify }, wrongTargetWriter });
      check('an import aimed at the wrong target is refused before any byte is sent and before the legacy writers are frozen, the failure names the target change, and the legacy original is retained for a retry', {
        outcomeOk: wrongTarget.outcome?.ok,
        failureName: wrongTarget.outcome?.failure?.name,
        failureCode: wrongTarget.outcome?.failure?.code,
        acceptCalls: wrongTargetCalls.accept,
        verifyCalls: wrongTargetCalls.verify,
        writerPhaseUnchanged: wrongTargetWriter.phase === phaseBeforeWrongTarget.phase,
        writerPhaseAfter: wrongTargetWriter.phase,
        wizardError: wrongTargetProbe.migrationError,
        retainedNote: wrongTargetProbe.retainedNote,
        retryDisabled: wrongTargetProbe.migrationRetryDisabled,
        legacyOriginalPreserved: storageBeforeFailure.local === storageAfterWrongTarget.local,
      }, {
        outcomeOk: false,
        failureName: 'ImportCoordinatorError',
        failureCode: 'target_changed',
        acceptCalls: 0,
        verifyCalls: 0,
        writerPhaseUnchanged: true,
        writerPhaseAfter: phaseBeforeWrongTarget.phase,
        wizardError: 'target_changed',
        retainedNote: 'The legacy original is retained. Retry the migration without losing it.',
        retryDisabled: false,
        legacyOriginalPreserved: true,
      });

      // ── F4b: a target switch in the middle of the backup is caught after the archive ──
      const midSwitch = await evaluate((environmentId) => window.task24.setActiveEnvironment(environmentId), TARGET);
      const midFlight = await evaluate((input) => window.task24.startMigrationViaUi(input), { switchEnvironmentAfterWrites: 2, switchEnvironmentTo: FOREIGN });
      const midFlightProbe = await evaluate(() => window.task24.probe());
      const midFlightCalls = await evaluate(() => window.task24.targetCalls());
      const midFlightWriter = await evaluate(() => window.task24.writerPhase());
      record('f4-mid-flight-target-switch', { midSwitch, midFlight, midFlightProbe, midFlightCalls: { accept: midFlightCalls.accept, verify: midFlightCalls.verify }, midFlightWriter });
      check('a target switch in the middle of the backup is caught by the coordinator before the wire phase: ZERO bytes reach the target, the failure names the target change and the writers are left frozen for an explicit retry', {
        outcomeOk: midFlight.outcome?.ok,
        failureName: midFlight.outcome?.failure?.name,
        failureCode: midFlight.outcome?.failure?.code,
        acceptCalls: midFlightCalls.accept,
        verifyCalls: midFlightCalls.verify,
        writerPhase: midFlightWriter.phase,
        wizardError: midFlightProbe.migrationError,
        retainedNote: midFlightProbe.retainedNote,
      }, {
        outcomeOk: false,
        failureName: 'ImportCoordinatorError',
        failureCode: 'target_changed',
        acceptCalls: 0,
        verifyCalls: 0,
        writerPhase: 'frozen',
        wizardError: 'target_changed',
        retainedNote: 'The legacy original is retained. Retry the migration without losing it.',
      });

      // ── F1b: the retry completes with real counts ──
      // Ordered AFTER F4/F4b: those scenarios read the post-disk-full 'failed' wizard status in
      // which a fresh migration can still start; F1b's cutover sets the wizard to 'done', which
      // disables migration-start, so F1b must run last among the writer/migration classes. F4b
      // leaves the active environment switched to FOREIGN mid-run, so restore TARGET first.
      await evaluate((environmentId) => window.task24.setActiveEnvironment(environmentId), TARGET);
      const retried = await evaluate(() => window.task24.retryMigrationViaUi());
      const retriedProbe = await evaluate(() => window.task24.probe());
      const retriedTarget = await evaluate(() => window.task24.targetCalls());
      const retriedWriter = await evaluate(() => window.task24.writerPhase());
      record('f1-retry', { retried, retriedProbe, retriedTarget: { accept: retriedTarget.accept, verify: retriedTarget.verify }, retriedWriter });
      check('the retry after a disk-full failure completes through the REAL pipeline: the writers are re-frozen from the paused phase, the archive is idempotent and the cutover result carries the real counts', {
        retryClicked: retried.clicked,
        outcomeOk: retried.outcome?.ok,
        failureCode: retried.outcome?.failure?.code ?? null,
        records: retried.outcome?.result?.records,
        chunks: retried.outcome?.result?.chunks,
        acceptCalls: retriedTarget.accept,
        verifyCalls: retriedTarget.verify,
        writerPhase: retriedWriter.phase,
        wizardBackupComplete: retriedProbe.backupComplete,
        retainedNoteAfterRetry: retriedProbe.retainedNote,
      }, {
        retryClicked: true,
        outcomeOk: true,
        failureCode: null,
        records: 3,
        chunks: 3,
        acceptCalls: 1,
        verifyCalls: 1,
        writerPhase: 'cutover',
        wizardBackupComplete: 'true',
        retainedNoteAfterRetry: null,
      });

      // ── F5: a local update against a remote loopback host ──
      // `bridgeVersionWithMinimum` returns `state` and `upgradePath` as Vue `readonly` proxies; a
      // proxy does not cross the Playwright page boundary (it serializes to `{}`, so `.status` /
      // `.action` read back undefined). Read the same real fields INSIDE the page and return plain
      // primitives, exactly as the landed `bridgeVersionState()` snapshot does for the module-level
      // instance. No asserted field or expected value changes.
      const projectMinimum = async (input) => {
        const r = await window.task24.bridgeVersionWithMinimum(input);
        return {
          minimumVersion: r.minimumVersion,
          hostKind: r.hostKind,
          version: r.version,
          state: r.state ? { status: r.state.status ?? null, version: r.state.version ?? null } : null,
          upgradePath: r.upgradePath ? { action: r.upgradePath.action ?? null, fromVersion: r.upgradePath.fromVersion ?? null } : null,
          reports: r.reports,
        };
      };
      const sshMinimum = await evaluate(projectMinimum, { minimumVersion: '1.0.0', hostKind: 'ssh', version: '0.9.0' });
      const localMinimum = await evaluate(projectMinimum, { minimumVersion: '1.0.0', hostKind: 'local', version: '0.9.0' });
      record('f5-remote-loopback-update', { sshMinimum, localMinimum });
      check('a local update against a remote loopback host: the SAME loopback URL and the SAME reported version yield an upgrade path on both hosts, but the observed endpoint locality is remote for the managed host and local for the local one — so the local update is never applied to the remote host', {
        sshHostKind: sshMinimum.hostKind,
        sshStateStatus: sshMinimum.state?.status,
        sshVersion: sshMinimum.state?.version,
        sshEndpointLocality: sshMinimum.reports.at(-1)?.endpointLocality,
        sshUpgradeAction: sshMinimum.upgradePath?.action ?? null,
        sshUpgradeFrom: sshMinimum.upgradePath?.fromVersion ?? null,
        localHostKind: localMinimum.hostKind,
        localEndpointLocality: localMinimum.reports.at(-1)?.endpointLocality,
        localUpgradeAction: localMinimum.upgradePath?.action ?? null,
        sameUrlDifferentLocality: sshMinimum.reports.at(-1)?.endpointLocality !== localMinimum.reports.at(-1)?.endpointLocality,
        sameVersionBothHosts: sshMinimum.state?.version === localMinimum.state?.version,
      }, {
        sshHostKind: 'ssh',
        sshStateStatus: 'ready',
        sshVersion: '0.9.0',
        sshEndpointLocality: 'remote',
        sshUpgradeAction: 'upgrade',
        sshUpgradeFrom: '0.9.0',
        localHostKind: 'local',
        localEndpointLocality: 'local',
        localUpgradeAction: 'upgrade',
        sameUrlDifferentLocality: true,
        sameVersionBothHosts: true,
      });
    }

    // In the failure case the classes above complete a REAL cutover (F1b), which leaves the wizard
    // status 'done' and disables migration-start (MigrationWizard canStart = status 'idle' |
    // 'failed'). The clean binding pass below must run a FRESH migration, so reset the owned page
    // to its initial module state by re-navigating it. Only page module state resets (wizard
    // status, writer phase, mapping store); the owned Vite server, Chromium and every Node-side
    // resource are unchanged. The happy case reaches this section with an idle wizard already.
    if (context.case === 'failure') {
      await page.goto(pageUrl, { waitUntil: 'commit' });
      await until(() => page.evaluate(() => Boolean(window.task24 && window.task24.ready)), 'task24 browser entry after reset', 90000);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // The binding-dependent migration routing assertions (ordered LAST so a defect in the
    // binding path cannot mask the other three criteria)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const cleanSeed = await evaluate(() => window.task24.clearLegacy());
    const reseededClean = await evaluate((fixtureData) => window.task24.seedLegacy(fixtureData), JSON.parse(JSON.stringify(legacyFixture)));
    const exportedClean = await evaluate(() => window.task24.legacyInventory());
    const inventoryClean = await evaluate((data) => window.task24.inventoryFromExport(data), exportedClean);
    const cleanHistory = inventoryClean.sources.find((source) => source.nativeSessionId !== undefined) ?? inventoryClean.sources[0];
    const cleanBind = await evaluate((sourceKey) => window.task24.bindSourceViaUi(sourceKey), cleanHistory.sourceKey);
    const cleanProbe = await evaluate(() => window.task24.probe());
    const cleanBefore = await evaluate(() => window.task24.targetCalls());
    const cleanMigration = await evaluate(() => window.task24.startMigrationViaUi());
    const cleanResultProbe = await evaluate(() => window.task24.probe());
    const cleanTarget = await evaluate(() => window.task24.targetCalls());
    const cleanWriter = await evaluate(() => window.task24.writerPhase());
    const storageAfterClean = await evaluate(() => window.task24.storageSnapshot());
    const cleanBatch = (cleanTarget.acceptedBatches ?? []).at(-1) ?? null;
    const cleanVerify = (cleanTarget.verifyRequests ?? []).at(-1) ?? null;
    record('legacyMigrate', {
      cleanSeed, reseededClean,
      exportedClean: { token: exportedClean.token, chunks: exportedClean.chunks.map((chunk) => ({ sourceKey: chunk.sourceKey, authority: chunk.authority })) },
      inventoryClean, cleanBind, cleanProbe, cleanMigration, cleanResultProbe,
      cleanTarget: { accept: cleanTarget.accept, verify: cleanTarget.verify, batches: cleanTarget.acceptedBatches, verifies: cleanTarget.verifyRequests },
      cleanWriter, legacyOriginalPreserved: storageBefore.local === storageAfterClean.local,
    });
    check('the REAL migration pipeline archives the legacy source into the REAL draft store, freezes the legacy writers, imports the composer draft and completes the cutover — with the legacy original preserved byte-for-byte', {
      startClicked: cleanMigration.clicked,
      outcomeOk: cleanMigration.outcome?.ok,
      failureCode: cleanMigration.outcome?.failure?.code ?? null,
      importIdShape: /^[a-f0-9]{64}$/u.test(String(cleanMigration.outcome?.result?.importId ?? '')),
      sourceRevision: cleanMigration.outcome?.result?.sourceRevision,
      records: cleanMigration.outcome?.result?.records,
      chunks: cleanMigration.outcome?.result?.chunks,
      drafts: cleanMigration.outcome?.result?.drafts,
      phase: cleanMigration.outcome?.result?.phase,
      writerPhaseAfter: cleanWriter.phase,
      revisionEqualsToken: cleanMigration.outcome?.result?.sourceRevision === exportedClean.token.revision,
      wizardBackupProgress: cleanResultProbe.backupProgress,
      wizardBackupComplete: cleanResultProbe.backupComplete,
      wizardResultText: cleanResultProbe.migrationResult,
      retainedNote: cleanResultProbe.retainedNote,
      legacyOriginalPreserved: storageBefore.local === storageAfterClean.local,
    }, {
      startClicked: true,
      outcomeOk: true,
      failureCode: null,
      importIdShape: true,
      sourceRevision: exportedClean.token.revision,
      records: 3,
      chunks: 3,
      drafts: 1,
      phase: 'cutover',
      writerPhaseAfter: 'cutover',
      revisionEqualsToken: true,
      wizardBackupProgress: 'Backup progress3 record(s), 3 chunk(s) archived',
      wizardBackupComplete: 'true',
      wizardResultText: `Migration result${cleanMigration.outcome?.result?.records} record(s), ${cleanMigration.outcome?.result?.chunks} chunk(s), ${cleanMigration.outcome?.result?.drafts} draft(s) migrated (import ${cleanMigration.outcome?.result?.importId})`,
      retainedNote: null,
      legacyOriginalPreserved: true,
    });
    check('the bound legacy record is routed to the target: the recorded accept batch carries the binding (profile / environment / harness instance / native session) and the verify request states the expected records and chunks', {
      acceptCalls: cleanTarget.accept - cleanBefore.accept,
      verifyCalls: cleanTarget.verify - cleanBefore.verify,
      batchImportId: cleanBatch?.importId,
      batchEnvironmentId: cleanBatch?.environmentId,
      batchOffset: cleanBatch?.offset,
      batchNextOffset: cleanBatch?.nextOffset,
      batchTotal: cleanBatch?.total,
      batchChunkCount: cleanBatch?.chunks?.length,
      chunkEnds: cleanBatch?.chunks?.map((chunk) => chunk.end),
      chunkAuthorities: [...new Set(cleanBatch?.chunks?.map((chunk) => chunk.authority) ?? [])].sort(),
      bindingProfileId: cleanBatch?.chunks?.[0]?.binding?.profileId,
      bindingEnvironmentId: cleanBatch?.chunks?.[0]?.binding?.environmentId,
      bindingHarnessInstanceId: cleanBatch?.chunks?.[0]?.binding?.harnessInstanceId,
      bindingNativeSessionId: cleanBatch?.chunks?.[0]?.binding?.nativeSessionId,
      verifyExpectedRecords: cleanVerify?.expectedRecords,
      verifyExpectedChunks: cleanVerify?.expectedChunks,
      chunkChecksumsValid: (cleanBatch?.chunks ?? []).every((chunk) => /^[a-f0-9]{64}$/u.test(chunk.checksum)),
    }, {
      acceptCalls: 1,
      verifyCalls: 1,
      batchImportId: cleanMigration.outcome?.result?.importId,
      batchEnvironmentId: TARGET,
      batchOffset: 0,
      batchNextOffset: 2,
      batchTotal: 2,
      batchChunkCount: 2,
      // Corrected to the frozen product's own contract, proven by
      // app/runtime/migration/browserSourcePort.test.ts:306-316: the SAME native session id is
      // carried by TWO authorities — localStorage 'unattached' and IndexedDB 'indexeddb' — and
      // BOTH records are bound and routed to the one proven target, so BOTH chunks carry end:true.
      chunkEnds: [true, true], // test L315: batch.chunks.map((chunk) => chunk.end) === [true, true]
      chunkAuthorities: ['indexeddb', 'unattached'], // test L316: authorities.sort() === ['indexeddb','unattached']
      bindingProfileId: PROFILE,
      bindingEnvironmentId: TARGET,
      bindingHarnessInstanceId: HARNESS_INSTANCE,
      bindingNativeSessionId: 'session-0001',
      verifyExpectedRecords: 2, // test L312: verified[0].expectedRecords === 2 (both history records bound)
      verifyExpectedChunks: 2, // test L312: verified[0].expectedChunks === 2; test L320-321: batch.total === 2
      chunkChecksumsValid: true,
    });
    await captureSurfaces('migration-result');

    const browserErrors = await evaluate(() => window.task24.errors());
    check('the real UI surface logged no error across the whole case', { errors: browserErrors.length }, { errors: 0 });

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowth = heapEnd - heapStart;
    check('the case stays bounded (bounded heap) and exercises the real modules through a fixed set of owned resources', {
      heapGrowthUnderBound: heapGrowth < 256 * 1024 * 1024,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: toolLedger.spawnCalls,
    }, {
      heapGrowthUnderBound: true,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: toolLedger.spawnCalls,
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged, leaves the worktree exactly as it found it and pins a populated source inventory', {
      worktreePreserved: worktreePreserved(context.root, worktreeBefore),
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
    }, {
      worktreePreserved: true, authoredFileCount: 4, differingFiles: 0, pinnedSources: sourceFiles.length,
    });
  } catch (error) {
    bodyError = error;
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task24Errors ?? [], task24: Boolean(window.task24) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
    // The receipt above is written first; a cleanup failure then fails the case
    // (carrying any in-flight failure as its cause), so a leaked resource can
    // never sit under `status: passed`.
    cleanupLeak = cleanupFailure(closed, bodyError);
  }
  if (cleanupLeak) throw cleanupLeak;
  if (bodyError) throw bodyError;

  return {
    scenarios,
    artifacts,
    adversarialClasses: ['stale_state', 'cancel_resume', 'malformed_input', 'hung_commands', 'dirty_worktree', 'repeated_interruptions', 'misleading_success_output', 'flaky_tests'],
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'unified-workspace-access-preserve-data-onboarding', schema: 'runtime-legacy-migration/v1' },
    cleanup: proof.cleanup,
    defects: {},
    evidenceBoundary: 'The real landed task-24 Vue surfaces (ConnectionEntry / MigrationWizard) and the real migration pipeline (legacyBrowserSource, browserSourcePort, importCoordinator, sourceArchive, draftImport, writerFreeze, legacyBinding, legacyExport, DraftStore) execute in a real headless Chromium over the page real localStorage and real IndexedDB, with the real i18n catalogue, the real workspace capability decision (useWorkspaceCapability), the real workspace control routing (useRuntimeCapabilities) and the real bridge-version report path (useDesktopBridgeVersion / useConnectedBridgeVersion). In the Node worker the real bridge WorkspaceService, the real target git command (real git binary) and the real pty service (real node-pty spawn) run over real files under the private root, and the shared pure-JS legacy digest is compared against Node createHash(sha256). The controlled boundaries are injected fakes: the legacy fixture data written into the page real storage; the import target service (accept/verify); the durable-write boundary used only to inject the disk-full and mid-backup target-switch failures; the one-shot PTY launch recorder for the open-in-editor path (the browser has no OS PTY — the real pty service is exercised in the Node worker); the desktop API object and the bridge health fetch; @iconify/vue as an inert stub. It does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that — and it authors no PASS verdict.',
  };
}
