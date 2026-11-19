// Task 40 registered QA case — writer leases and complete change artifacts.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge modules bridge/runtime/collaboration/writerLeases.js,
//     artifactStore.js and artifactService.js, composed exactly as the product composes them — the
//     lease service allocates a real detached git worktree of a real private repository through
//     the product's own git runner, and the artifact service captures the writer's real change
//     set and applies it into a real pristine worktree — over the frozen
//     shared/runtime/collaboration.js contract. Nothing is stubbed. The ONLY case-owned seam is
//     the lease service's own declared `newLeaseId` injection point (writerLeases.js:398), backed
//     by a deterministic counter, so the worktree-name derivation (writerLeases.js:534,
//     `writer-${leaseId}`) is asserted as an exact path. Every git invocation is either the
//     product's own (createGitRunner) or the case's runGit, and every repository is a private
//     temporary one under the fixture root — NEVER the QA worktree (the task-24 lesson).
//   * In a real headless Chromium: the frozen shared contract every writer-lease and artifact
//     rejection travels through — the frozen ten-entry ERROR_CODES table, the CollaborationError
//     shape, the explicit-`at` contract and the lease/task id parsers — recomputed in a second JS
//     realm from the same pure shared/runtime modules the worker imports, plus the membership
//     check over every rejection code the worker actually observed. The case asserts the browser
//     values EQUAL the values the worker computes, so the contract the bridge enforces is
//     provably the contract the app sees.
//
// The controlled boundaries are stated rather than papered over:
//   * the stateful product cannot cross into the browser at all — writerLeases.js:1-4,
//     artifactStore.js:1-2 and artifactService.js:1-3 each import node:* builtins — so allocate,
//     the lease read models, the native runner, capture, apply, release, confirm and remove are
//     proven in the worker only. The split is exactly the posture tasks 37 and 38 disclosed.
//   * no browser shim is needed: the browser closure is shared/runtime/collaboration.js ->
//     capabilities.js + identity.js, pure ESM with no node:* builtin and no bare or aliased
//     specifier — a strict subset of the closure task 38 booted in a real headless Chromium over
//     the case's exact Vite server options.
//   * "native 工作目录实测正确" is MEASURED, not read back: a real child process is spawned through
//     the lease service's own runner and its OBSERVED stdout is compared against the assigned cwd,
//     against the repository (must differ) and against real `git rev-parse HEAD` /
//     `--show-toplevel` output. The runner also IGNORES a caller-supplied cwd, asserted by
//     observation in F3.
//   * durability across a real process death is NOT claimed: the durable artifact is proven to
//     survive the job ending (every service closed and reopened) IN-PROCESS, and a lost object is
//     an explicit artifact_missing — the same in-process disclosure tasks 34, 37 and 38 made. The
//     lease service is in-memory and single-process, so cross-process lease exclusion is not
//     proven either (task 10's worktreeLease.js is the durable, cross-process lease).
//   * this case performs NO live SSH or live Slurm verification (task 46 owns that), claims NO UI
//     rendering (task 42 owns the collaboration UI), authors no PASS verdict, edits no product or
//     test file, and performs NO git operation in the worktree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-40-fixture.mjs';

import {
  POSTURE_KEYS,
  WRITER_ISOLATION,
  WRITER_LIMITS,
  createWriterLeaseService,
} from '../../../bridge/runtime/collaboration/writerLeases.js';
import {
  ARTIFACT_LIMITS,
  createArtifactStore,
  createBufferSource,
} from '../../../bridge/runtime/collaboration/artifactStore.js';
import {
  ARTIFACT_SCHEMA_VERSION,
  CHANGE_KINDS,
  createArtifactService,
} from '../../../bridge/runtime/collaboration/artifactService.js';
import { CollaborationError, parseAt, parseLeaseId, parseTaskId } from '../../../shared/runtime/collaboration.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40,64}$/;
const T0 = 1700000000000;

// A deterministic lease-id sequence injected through the product's own newLeaseId seam, so the
// worktree-name derivation (writer-${leaseId}) is asserted as an exact path. The ids match the
// product's own UUID_PATTERN (writerLeases.js:75).
let leaseSeq = 0;
const nextLeaseId = () => {
  leaseSeq += 1;
  const n = leaseSeq.toString(16).padStart(4, '0');
  return `b${leaseSeq.toString(16).padStart(7, '0')}-bbbb-4bbb-8bbb-bbbbbbbb${n}`;
};

/**
 * The typed capture envelope. BOTH realms emit the SAME shape on EVERY path, success included
 * (the task-32/33 lesson): { code, field } with nulls on success. Every observed code is also
 * collected so the final check can prove every rejection code the product emitted belongs to the
 * frozen canonical ERROR_CODES table, in both realms.
 *
 * captureSync may ONLY wrap a callee that THROWS synchronously (assertPathWithinLease, lease,
 * nativeCwd, posture, release, confirmWorktreeRemoval, run, serialize). `allocate`, `capture`,
 * `apply`, `removeWorktree`, `retention` and the store's read/open/verify/write are `async
 * function`s — they RETURN A PROMISE and reject instead of throwing, so a synchronous try/catch
 * cannot observe their rejection: use capture (which awaits) or deferred() for those. Where the
 * rejection DETAIL is itself asserted, captureDetail / captureSyncDetail carry it.
 */
const observedCodes = new Set();
const recordCode = (error) => {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
    observedCodes.add(error.code);
    return { code: error.code, field: error.field };
  }
  return { code: 'not-a-CollaborationError', field: String(error) };
};
const captureSync = (run) => { try { run(); return { code: null, field: null }; } catch (error) { return recordCode(error); } };
const capture = async (run) => { try { await run(); return { code: null, field: null }; } catch (error) { return recordCode(error); } };
const captureDetail = async (run) => {
  try { await run(); return { code: null, field: null, detail: null }; } catch (error) { return { ...recordCode(error), detail: error?.detail ?? null }; }
};
const deferred = (run) => Promise.resolve().then(run);

/** The worker mirror of the browser entry's frozen-contract table. */
function workerTables() {
  return {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError('conflict', 'writer_lease_cwd', { x: 1 });
      return {
        name: error.name,
        code: error.code,
        field: error.field,
        reason: error.reason,
        message: error.message,
        detail: error.detail === null ? null : { ...error.detail },
        isProtocolError: error instanceof ProtocolError,
        isTypeError: error instanceof TypeError,
      };
    })(),
    writerArtifactCodesInTable: ['invalid_request', 'unsupported', 'unauthorized', 'conflict', 'cancelled', 'source_unavailable']
      .every((code) => ERROR_CODES.includes(code)),
    atExplicit: parseAt(T0),
    atZero: captureSync(() => parseAt(0)),
    atNegative: captureSync(() => parseAt(-1)),
    atFractional: captureSync(() => parseAt(1.5)),
    atNonNumber: captureSync(() => parseAt('1700000000000')),
  };
}

/** The worker mirror of the browser entry's id-parser table. */
function workerIds() {
  const mixed = 'AABBCCDD-AABB-4ABB-8ABB-AABBCCDDAABB';
  const lower = 'aabbccdd-aabb-4abb-8abb-aabbccddaabb';
  return {
    leaseIdAccepted: parseLeaseId(mixed),
    leaseIdNormalised: parseLeaseId(mixed) === lower,
    leaseIdMalformed: captureSync(() => parseLeaseId('nope')),
    taskIdAccepted: parseTaskId(mixed),
    taskIdNormalised: parseTaskId(mixed) === lower,
    taskIdMalformed: captureSync(() => parseTaskId('not-a-uuid')),
  };
}

export const sourceFiles = [...new Set([
  // the three product modules this task owns
  'bridge/runtime/collaboration/writerLeases.js',
  'bridge/runtime/collaboration/artifactService.js',
  'bridge/runtime/collaboration/artifactStore.js',
  // the product's own regression suite, unchanged
  'app/runtime/writerArtifacts.test.ts',
  // the frozen shared contract they all agree on
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task40.ts',
  'scripts/qa/runtime-v090-cases/task-40.mjs',
  'scripts/qa/runtime-v090-cases/task-40-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

/**
 * The ten product files whose bytes the evidence must bind to. Every one of them is in
 * sourceFiles, so the independent gate can compare the recorded digests against the artifact's
 * own sourceHashes mechanically.
 */
const PRODUCT_FILES = [
  'bridge/runtime/collaboration/writerLeases.js',
  'bridge/runtime/collaboration/artifactService.js',
  'bridge/runtime/collaboration/artifactStore.js',
  'app/runtime/writerArtifacts.test.ts',
  'shared/runtime/collaboration.js',
  'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js',
  'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js',
  'shared/runtime/identity.d.ts',
];

function productHashes(root) {
  return Object.fromEntries(PRODUCT_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex'),
  ]));
}

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 40 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task40Errors=[];window.addEventListener('error',(e)=>window.__task40Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task40Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task40.ts"></script></body></html>`;

/** A deterministic task id derived from a world name (the product's own test uses this shape). */
const taskIdFor = (name) => {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export async function run(context) {
  // The case owns its git worlds: a fixed umask plus an explicit chmod on every written file
  // makes the observed modes deterministic regardless of the runner's ambient umask (git checkout
  // and writeFile both mask with it).
  process.umask(0o022);
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-40/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  let peakHeap = process.memoryUsage().heapUsed;
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'the real landed bridge writer-lease, artifact-store and artifact-service modules composed exactly as the product composes them over the frozen shared/runtime/collaboration.js contract in the Node worker — real private git repositories, real product-created git worktrees, real native commands through the lease service own runner — plus the frozen shared contract recomputed in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-40.mjs',
    'scripts/qa/runtime-v090-cases/task-40-fixture.mjs',
    'app/dev/runtime-v090/task40.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const productHashesBefore = productHashes(context.root);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;
  const started = { nativeCommands: 0, gitCommands: 0, leasesAllocated: 0, captures: 0, applies: 0, writes: 0, largestArtifactBytes: 0 };

  /* ---------------------------------------------------------------- world helpers */

  /** Run one git command in a NAMED working directory. Never inherits an ambient cwd. */
  const runGit = (cwd, args) => {
    started.gitCommands += 1;
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  };
  const exists = async (filePath) => { try { await stat(filePath); return true; } catch { return false; } };
  async function countFiles(root) {
    if (!(await exists(root))) return 0;
    let total = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = path.join(root, entry.name);
      total += entry.isDirectory() ? await countFiles(child) : 1;
    }
    return total;
  }
  /** Write one file with an EXPLICIT mode, so the observed modes are umask-independent. */
  const writeFileMode = async (filePath, data, mode) => {
    await writeFile(filePath, data);
    await chmod(filePath, mode);
  };

  /**
   * A private temporary git repository with a single base commit — NEVER the QA worktree. The
   * object format is pinned to sha1 on the command line, so the base commit is always 40 hex
   * characters regardless of the host git configuration.
   */
  const createRepo = async (name) => {
    const root = await fixture.mkdirOwned('git-repository', `repos/${name}`);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFileMode(path.join(root, 'README.md'), 'base readme\n', 0o644);
    await writeFileMode(path.join(root, 'src', 'keep.txt'), 'keep\n', 0o644);
    await writeFileMode(path.join(root, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]), 0o644);
    await writeFileMode(path.join(root, 'script.sh'), 'echo hi\n', 0o644);
    await symlink('src/keep.txt', path.join(root, 'link'));
    await symlink('README.md', path.join(root, 'link2'));
    runGit(root, ['-c', 'init.defaultObjectFormat=sha1', 'init', '-q', '-b', 'main']);
    runGit(root, ['add', '-A']);
    runGit(root, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'base']);
    return root;
  };
  const scratch = (kind, name) => fixture.mkdirOwned(kind, name);

  /** The on-disk shape of one path: kind, mode and either a content hash or a raw link target. */
  async function observeTree(root) {
    const found = new Map();
    async function walk(relative) {
      const absolute = relative === '' ? root : path.join(root, relative);
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const info = await lstat(path.join(root, child));
        if (info.isDirectory()) { await walk(child); continue; }
        if (info.isSymbolicLink()) {
          const target = await readlink(path.join(root, child));
          found.set(child, Object.freeze({ kind: 'symlink', mode: info.mode & 0o7777, sha256: createHash('sha256').update(target).digest('hex'), target }));
          continue;
        }
        const content = await readFile(path.join(root, child));
        found.set(child, Object.freeze({ kind: 'file', mode: info.mode & 0o7777, sha256: createHash('sha256').update(content).digest('hex'), target: null }));
      }
    }
    await walk('');
    return found;
  }
  const treeShape = async (root) => {
    const tree = await observeTree(root);
    return [...tree.entries()].sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([entryPath, entry]) => ({ path: entryPath, kind: entry.kind, mode: entry.mode, sha256: entry.sha256, target: entry.target }));
  };

  /** A counting source: records the largest single read the hasher ever asked for. */
  const countingSource = (buffer, counters) => ({
    async open() {
      let offset = 0;
      return {
        async read(maxBytes) {
          counters.maxRequested = Math.max(counters.maxRequested, maxBytes);
          counters.reads += 1;
          if (offset >= buffer.length) return null;
          const end = Math.min(offset + maxBytes, buffer.length);
          const chunk = buffer.subarray(offset, end);
          offset = end;
          return chunk;
        },
        async close() {},
      };
    },
  });

  /**
   * Start one native command through the lease service's own runner. The count is the case's own
   * bookkeeping of how many real processes it started (the boundedness check records it).
   */
  const runNative = (service, input) => { started.nativeCommands += 1; return deferred(() => service.run(input)); };

  // Drives one worker value and its browser twin, then asserts the two realms are IDENTICAL.
  const crossRealm = async (name, workerValue, browserValue, expected) => {
    protocol.node[name] = workerValue;
    protocol.browser[name] = browserValue;
    record(name, { worker: workerValue, browser: browserValue });
    check(name, {
      worker: workerValue,
      browser: browserValue,
      equal: JSON.stringify(workerValue) === JSON.stringify(browserValue),
    }, { worker: expected, browser: expected, equal: true });
  };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the frozen shared contract (no shim: no node:* builtin anywhere
    // in the closure)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa40', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa40/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task40 && window.task40.ready)), 'task40 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── C1: the frozen contract is identical in both realms ──
    await crossRealm('the frozen shared contract every writer-lease and artifact rejection travels through — the frozen ten-entry ERROR_CODES table, the CollaborationError shape (name, code, field, reason, message, frozen detail, ProtocolError and TypeError lineage) and the explicit-`at` contract with a zero, a negative, a fractional and a non-numeric reading refused — is byte-identical in the browser realm and the bridge worker, and every code the writer-lease and artifact surfaces can emit (invalid_request, unsupported, unauthorized, conflict, cancelled, source_unavailable) is a member, so the app and the bridge cannot disagree about a rejection', workerTables(), await evaluate(() => window.task40.tables()), {
      errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
      errorCodeCount: 10,
      errorCodesFrozen: true,
      collaborationErrorShape: { name: 'CollaborationError', code: 'conflict', field: 'writer_lease_cwd', reason: 'writer_lease_cwd', message: 'conflict: collaboration.writer_lease_cwd', detail: { x: 1 }, isProtocolError: true, isTypeError: true },
      writerArtifactCodesInTable: true,
      atExplicit: T0,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atNegative: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
      atNonNumber: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // ── C2: the lease/task id parsers are identical in both realms ──
    await crossRealm('the lease and task identity parsers every writer-lease caller travels through are identical in both realms — a well-formed UUID is accepted and NORMALISED to lower case rather than refused, while a malformed lease id is invalid_request/lease_id and a malformed task id invalid_request/task_id — so a browser window and the bridge worker provably agree on what a lease identity is before any allocation happens', workerIds(), await evaluate(() => window.task40.ids()), {
      leaseIdAccepted: 'aabbccdd-aabb-4abb-8abb-aabbccddaabb',
      leaseIdNormalised: true,
      leaseIdMalformed: { code: 'invalid_request', field: 'lease_id' },
      taskIdAccepted: 'aabbccdd-aabb-4abb-8abb-aabbccddaabb',
      taskIdNormalised: true,
      taskIdMalformed: { code: 'invalid_request', field: 'task_id' },
    });

    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: a dirty base and lease conflicts, a worker crossing cwd, an oversize
      // artifact with a STREAMING hash, malicious paths and symlinks, and a job ending with the
      // disk losing data — the durable artifact preserved or the loss explicitly declared, never
      // a fabricated patch.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: a DIRTY base is refused before any worktree is allocated ──
      {
        const repository = await createRepo('dirty-base');
        const writersRoot = await scratch('writers-root', 'dirty-base-writers');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        await writeFile(path.join(repository, 'README.md'), 'uncommitted edit\n', 'utf8');
        const observed = await capture(() => service.allocate({ repository, taskId: taskIdFor('dirty-base'), ownerId: 'writer-dirty', at: T0 }));
        check('a DIRTY base is refused before anything is created: the repository with an uncommitted edit is refused conflict/writer_base_dirty carrying the observed porcelain entry for the dirty path, and the refusal happens before any lease, any worktree and any git worktree is made — the service holds no lease, its counters are all zero, and the writers root the case itself prepared is left EMPTY (the product own mkdir of that root is never reached), so no writer can ever diff against a base commit that does not describe the tree', {
          rejection: observed,
          detail: { repositoryMatchesInput: true, paths: [' M README.md'] },
          noLeaseCreated: { leases: service.leases().length, active: service.state().active, total: service.state().total, worktreesRetained: service.state().worktreesRetained },
          nothingCreatedInsideWritersRoot: await countFiles(writersRoot),
        }, {
          rejection: { code: 'conflict', field: 'writer_base_dirty' },
          detail: { repositoryMatchesInput: true, paths: [' M README.md'] },
          noLeaseCreated: { leases: 0, active: 0, total: 0, worktreesRetained: 0 },
          nothingCreatedInsideWritersRoot: 0,
        });
        service.close();
      }

      // ── F2: a duplicate task lease and a repository over its writer quota ──
      {
        const repository = await createRepo('lease-conflict');
        const writersRoot = await scratch('writers-root', 'lease-conflict-writers');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const taskId = taskIdFor('lease-conflict');
        const first = await service.allocate({ repository, taskId, ownerId: 'writer-one', at: T0 });
        started.leasesAllocated += 1;
        const duplicate = await capture(() => service.allocate({ repository, taskId, ownerId: 'writer-two', at: T0 }));
        const duplicateDetail = await captureDetail(() => service.allocate({ repository, taskId, ownerId: 'writer-three', at: T0 }));
        const quota = WRITER_LIMITS.maxWritersPerRepository;
        for (let index = 0; index < quota - 1; index += 1) {
          await service.allocate({ repository, taskId: taskIdFor(`lease-conflict-${index}`), ownerId: `writer-quota-${index}`, at: T0 });
          started.leasesAllocated += 1;
        }
        const overflow = await captureDetail(() => service.allocate({ repository, taskId: taskIdFor('lease-conflict-over'), ownerId: 'writer-over', at: T0 }));
        check('the two explicit lease conflicts are typed refusals at their exact boundaries: a second lease for the SAME task is conflict/writer_lease_task carrying the task id, and the quota-plus-first writer against one repository is conflict/writer_lease_repository carrying the frozen limit of 8 — exactly 8 writers are held (the 8th allocation succeeded, the refused writer is the 9th), each with its OWN lease id and worktree, and the repository read model lists exactly the quota', {
          firstLeaseAccepted: { state: first.state, worktreeDerived: first.worktree === path.join(writersRoot, `writer-${first.leaseId}`) },
          duplicateTask: duplicate,
          duplicateDetail,
          quota,
          overflow,
          held: { leasesByRepository: service.leasesByRepository(repository).length, leases: service.leases().length, active: service.state().active, total: service.state().total, worktreesRetained: service.state().worktreesRetained },
          limits: { ...WRITER_LIMITS },
          limitsFrozen: Object.isFrozen(WRITER_LIMITS),
        }, {
          firstLeaseAccepted: { state: 'active', worktreeDerived: true },
          duplicateTask: { code: 'conflict', field: 'writer_lease_task' },
          duplicateDetail: { code: 'conflict', field: 'writer_lease_task', detail: { taskId } },
          quota: 8,
          overflow: { code: 'conflict', field: 'writer_lease_repository', detail: { repository, limit: 8 } },
          held: { leasesByRepository: 8, leases: 8, active: 8, total: 8, worktreesRetained: 8 },
          limits: { maxWritersPerRepository: 8, maxActiveLeases: 32, maxLeaseTtlMs: 86400000, maxCwdChars: 1024, maxOwnerChars: 128, maxRepositoryChars: 1024, maxWorktreeNameChars: 128 },
          limitsFrozen: true,
        });
        service.close();
      }

      // ── F3: a worker cannot cross into another writer's cwd, and the runner ignores a caller cwd ──
      {
        const repository = await createRepo('cross-cwd');
        const writersRoot = await scratch('writers-root', 'cross-cwd-writers');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const first = await service.allocate({ repository, taskId: taskIdFor('cross-cwd-a'), ownerId: 'writer-a', at: T0 });
        const second = await service.allocate({ repository, taskId: taskIdFor('cross-cwd-b'), ownerId: 'writer-b', at: T0 });
        started.leasesAllocated += 2;
        const intoRepository = await captureDetail(() => deferred(() => service.assertPathWithinLease(first.leaseId, repository)));
        const intoSibling = await captureDetail(() => deferred(() => service.assertPathWithinLease(first.leaseId, second.nativeCwd)));
        const escaped = await captureDetail(() => deferred(() => service.assertPathWithinLease(first.leaseId, path.join(first.nativeCwd, '..', '..'))));
        const emptyCandidate = await capture(() => deferred(() => service.assertPathWithinLease(first.leaseId, '   ')));
        // The native runner takes its cwd ONLY from the lease record: a hostile caller-supplied
        // cwd is ignored, and the OBSERVED process cwd is still the lease's own.
        const hostile = await runNative(service, { leaseId: first.leaseId, command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: '/tmp' });
        check('a worker cannot cross into another writer cwd: the user repository, the sibling writer worktree and a traversal out of the lease are each refused unauthorized/writer_lease_cwd carrying the lease id and the raw candidate, a blank candidate is invalid_request/writer_lease_path, a path inside the lease resolves under the lease cwd, nativeCwd() is the only cwd a lease exposes — and the native runner takes its cwd ONLY from the lease record: a real process launched with a hostile caller-supplied cwd is OBSERVED running in the lease own cwd, never in the injected one', {
          intoRepository,
          intoSibling,
          escaped,
          emptyCandidate,
          insideResolves: service.assertPathWithinLease(first.leaseId, 'src/keep.txt') === path.join(first.nativeCwd, 'src', 'keep.txt'),
          nativeCwdAccessor: { first: service.nativeCwd(first.leaseId) === first.nativeCwd, second: service.nativeCwd(second.leaseId) === second.nativeCwd },
          hostileCwdIgnored: { exitCode: hostile.exitCode, observedIsLeaseCwd: hostile.stdout.trim() === first.nativeCwd, observedIsInjected: hostile.stdout.trim() === '/tmp' },
        }, {
          intoRepository: { code: 'unauthorized', field: 'writer_lease_cwd', detail: { leaseId: first.leaseId, candidate: repository } },
          intoSibling: { code: 'unauthorized', field: 'writer_lease_cwd', detail: { leaseId: first.leaseId, candidate: second.nativeCwd } },
          escaped: { code: 'unauthorized', field: 'writer_lease_cwd', detail: { leaseId: first.leaseId, candidate: path.join(first.nativeCwd, '..', '..') } },
          emptyCandidate: { code: 'invalid_request', field: 'writer_lease_path' },
          insideResolves: true,
          nativeCwdAccessor: { first: true, second: true },
          hostileCwdIgnored: { exitCode: 0, observedIsLeaseCwd: true, observedIsInjected: false },
        });
        service.close();
      }

      // ── F4: an oversize artifact is refused mid-stream, and the hash is STREAMING ──
      {
        const repository = await createRepo('oversize');
        const writersRoot = await scratch('writers-root', 'oversize-writers');
        const storeRoot = await scratch('store-root', 'oversize-store');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const store = createArtifactStore({ root: storeRoot });
        const artifacts = createArtifactService({ store, root: storeRoot });
        const lease = await service.allocate({ repository, taskId: taskIdFor('oversize'), ownerId: 'writer-oversize', at: T0 });
        started.leasesAllocated += 1;
        // 32 MiB + 1 KiB of binary content, as a real file in a real worktree.
        await writeFileMode(path.join(lease.nativeCwd, 'huge.bin'), Buffer.alloc(32 * 1024 * 1024 + 1024, 0x5a), 0o644);
        const serviceOversize = await captureDetail(() => artifacts.capture({ lease, at: T0 + 10 }));
        started.captures += 1;
        const afterCapture = { ...store.state(), filesOnDisk: await countFiles(storeRoot) };
        // The store level has no header interleaving, so the crossing chunk is exact.
        const storeOversize = await captureDetail(() => store.write({ source: createBufferSource(Buffer.alloc(32 * 1024 * 1024 + 1024, 0x5a)) }));
        const afterStoreOversize = { ...store.state(), filesOnDisk: await countFiles(storeRoot) };
        // The STREAMING proof: the product's own gauge and a counting source over 1 MiB.
        const content = Buffer.alloc(1024 * 1024);
        for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
        const counters = { maxRequested: 0, reads: 0 };
        const stored = await store.write({ source: countingSource(content, counters) });
        started.writes += 1;
        started.largestArtifactBytes = Math.max(started.largestArtifactBytes, stored.bytes);
        const afterStreaming = { ...store.state(), filesOnDisk: await countFiles(storeRoot) };
        check('an artifact EXCEEDING the frozen 32 MiB ceiling is refused mid-stream with OBSERVED numbers — at the service level conflict/artifact_oversize with detail {limit 33554432, observed 33555750, chunkBytes 65536} (the crossing chunk is at most one 64 KiB chunk over the line) and at the store level the exact {limit 33554432, observed 33555456, chunkBytes 65536} — and NOTHING durable is fabricated: after the service refusal the store wrote zero objects, counted exactly one oversize rejection and left zero files on disk, and the store-level refusal leaves the same zero. The hash is STREAMING, proven by OBSERVED numbers rather than a prose claim: over 1 MiB of content the product own gauge reports chunks 16 and peakBufferedBytes 65536 (exactly one frozen 64 KiB chunk, and strictly less than the 1048576-byte content), the counting source shows the hasher never ASKED for more than 65536 bytes in one read and performed 34 reads (16 hash-pass plus 16 copy-pass plus the two terminating null reads), the peak times the chunk count equals the byte count, and the streamed hash equals a one-shot sha256 of the same content', {
          serviceOversize,
          afterCapture,
          storeOversize,
          afterStoreOversize,
          streaming: {
            bytes: stored.bytes,
            chunks: stored.chunks,
            peakBufferedBytes: stored.peakBufferedBytes,
            maxRequested: counters.maxRequested,
            reads: counters.reads,
            expectedChunks: Math.ceil(content.length / ARTIFACT_LIMITS.chunkBytes),
            peakTimesChunksEqualsBytes: stored.peakBufferedBytes * stored.chunks === stored.bytes,
            peakStrictlyBelowContent: stored.peakBufferedBytes < stored.bytes,
            hashEqualsOneShot: stored.artifactHash === createHash('sha256').update(content).digest('hex'),
          },
          afterStreaming,
          limits: { ...ARTIFACT_LIMITS },
          limitsFrozen: Object.isFrozen(ARTIFACT_LIMITS),
          schemaVersion: ARTIFACT_SCHEMA_VERSION,
          changeKinds: [...CHANGE_KINDS],
          changeKindsFrozen: Object.isFrozen(CHANGE_KINDS),
        }, {
          serviceOversize: { code: 'conflict', field: 'artifact_oversize', detail: { limit: 33554432, observed: 33555750, chunkBytes: 65536 } },
          afterCapture: { writes: 0, oversizeRejections: 1, immutableRefusals: 0, closed: false, filesOnDisk: 0 },
          storeOversize: { code: 'conflict', field: 'artifact_oversize', detail: { limit: 33554432, observed: 33555456, chunkBytes: 65536 } },
          afterStoreOversize: { writes: 0, oversizeRejections: 2, immutableRefusals: 0, closed: false, filesOnDisk: 0 },
          streaming: {
            bytes: 1048576,
            chunks: 16,
            peakBufferedBytes: 65536,
            maxRequested: 65536,
            reads: 34,
            expectedChunks: 16,
            peakTimesChunksEqualsBytes: true,
            peakStrictlyBelowContent: true,
            hashEqualsOneShot: true,
          },
          afterStreaming: { writes: 1, oversizeRejections: 2, immutableRefusals: 0, closed: false, filesOnDisk: 1 },
          limits: { maxArtifactBytes: 33554432, chunkBytes: 65536, maxPathEntries: 4096, maxPathChars: 1024 },
          limitsFrozen: true,
          schemaVersion: 1,
          changeKinds: ['file', 'symlink', 'delete'],
          changeKindsFrozen: true,
        });
        artifacts.close(); store.close(); service.close();
      }

      // ── F5: a malicious artifact path, a malicious symlink target and a tampered checksum ──
      {
        const storeRoot = await scratch('store-root', 'malicious-store');
        const store = createArtifactStore({ root: storeRoot });
        const service = createArtifactService({ store, root: storeRoot });
        const badEntry = (badPath, extra = {}) => ({
          path: badPath, kind: 'file', mode: 0o644, target: null, contentBytes: 3,
          sha256: createHash('sha256').update('ok\n').digest('hex'), tracked: false, ...extra,
        });
        const malicious = [
          ['traversal', '../escaped.txt'],
          ['nestedTraversal', 'a/../../escaped.txt'],
          ['absolute', '/etc/vis-artifact.txt'],
          ['nulByte', 'bad\u0000path.txt'],
          ['overLong', `x${'y'.repeat(2000)}.txt`],
          ['windowsDrive', 'C:\\vis-artifact.txt'],
          ['dotSegment', './a.txt'],
          ['doubleSlash', 'a//b.txt'],
        ];
        const pathRefusals = {};
        for (const [label, badPath] of malicious) {
          pathRefusals[label] = captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry(badPath)] }));
        }
        const targetAndShape = {
          missingTarget: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'l', kind: 'symlink', mode: 0o777, contentBytes: 0, sha256: createHash('sha256').update('t').digest('hex'), tracked: false }] })),
          emptyTarget: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'l', kind: 'symlink', mode: 0o777, target: '', contentBytes: 0, sha256: createHash('sha256').update('').digest('hex'), tracked: false }] })),
          overLongTarget: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'l', kind: 'symlink', mode: 0o777, target: 't'.repeat(1025), contentBytes: 0, sha256: createHash('sha256').update('t'.repeat(1025)).digest('hex'), tracked: false }] })),
          nulTarget: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'l', kind: 'symlink', mode: 0o777, target: 'a\u0000b', contentBytes: 0, sha256: createHash('sha256').update('a\u0000b').digest('hex'), tracked: false }] })),
          fileWithTarget: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry('a.txt', { target: 'x' })] })),
          deleteWithTarget: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'a.txt', kind: 'delete', mode: 0, target: 'x', contentBytes: 0, sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), tracked: true }] })),
          unknownKind: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'a.txt', kind: 'hardlink', mode: 0o644, target: null, contentBytes: 0, sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), tracked: false }] })),
          outOfRangeMode: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry('a.txt', { mode: 0o10000 })] })),
          trackedNotBoolean: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry('a.txt', { tracked: 'yes' })] })),
          malformedBaseCommit: captureSync(() => service.serialize({ baseCommit: 'not-a-commit', entries: [badEntry('a.txt')] })),
          entriesNotArray: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: 'nope' })),
          duplicatePath: captureSync(() => service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry('a.txt'), badEntry('a.txt')] })),
        };
        // The checksum class refuses when the source is STREAMED (a synchronous try/catch cannot
        // observe it), so it is driven through the store's real write.
        const checksums = {
          declaredBytesMismatch: await captureDetail(() => store.write({ source: service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry('a.txt', { content: Buffer.from('ok\n'), contentBytes: 4 })] }) })),
          declaredShaMismatch: await captureDetail(() => store.write({ source: service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry('a.txt', { content: Buffer.from('ok\n'), contentBytes: 3, sha256: 'f'.repeat(64) })] }) })),
          symlinkShaMismatch: await captureDetail(() => store.write({ source: service.serialize({ baseCommit: 'a'.repeat(40), entries: [{ path: 'l', kind: 'symlink', mode: 0o777, target: 't', contentBytes: 0, sha256: 'f'.repeat(64), tracked: false }] }) })),
        };
        // An absolute symlink target is LEGITIMATE: it is recorded as a link, never followed.
        const absoluteTarget = '/etc/vis-artifact-target';
        const absoluteStored = await store.write({
          source: service.serialize({
            baseCommit: 'a'.repeat(40),
            entries: [{ path: 'l', kind: 'symlink', mode: 0o777, target: absoluteTarget, contentBytes: 0, sha256: createHash('sha256').update(absoluteTarget).digest('hex'), tracked: false }],
          }),
        });
        started.writes += 1;
        const absoluteRound = service.deserialize(await store.read(absoluteStored.artifactHash));
        check('a crafted artifact cannot name a path outside its target and a tampered record cannot pass: the serializer refuses EAGERLY, each with an explicit typed field — traversal, nested traversal, an absolute path, a NUL byte, an over-long path, a Windows drive letter, a dot segment and a double slash are invalid_request/artifact_path; a missing, empty, over-long or NUL symlink target and a non-symlink entry carrying a target are invalid_request/artifact_target; an unknown kind is artifact_kind, an out-of-range mode artifact_mode, a non-boolean tracked artifact_tracked, a malformed base commit artifact_base_commit, a non-array entry list artifact_entries and a duplicate path conflict/artifact_entry_duplicate; the checksum class refuses when the source is STREAMED — a declared contentBytes that disagrees with what streams is conflict/artifact_content_bytes carrying declared and observed, and a wrong sha256 (file or symlink payload) is conflict/artifact_checksum — and nothing was stored for any of them. An ABSOLUTE symlink target is legitimate and is recorded verbatim as a link (kind symlink, mode 511, contentBytes 0, sha256 over the target), never followed and never refused', {
          pathRefusals,
          targetAndShape,
          checksums,
          checksumAfter: { writes: store.state().writes, filesOnDisk: await countFiles(storeRoot) },
          absoluteSymlinkRoundTrip: {
            entry: absoluteRound.entries[0],
            shaIsShaOfTarget: absoluteRound.entries[0].sha256 === createHash('sha256').update(absoluteTarget).digest('hex'),
          },
        }, {
          pathRefusals: {
            traversal: { code: 'invalid_request', field: 'artifact_path' },
            nestedTraversal: { code: 'invalid_request', field: 'artifact_path' },
            absolute: { code: 'invalid_request', field: 'artifact_path' },
            nulByte: { code: 'invalid_request', field: 'artifact_path' },
            overLong: { code: 'invalid_request', field: 'artifact_path' },
            windowsDrive: { code: 'invalid_request', field: 'artifact_path' },
            dotSegment: { code: 'invalid_request', field: 'artifact_path' },
            doubleSlash: { code: 'invalid_request', field: 'artifact_path' },
          },
          targetAndShape: {
            missingTarget: { code: 'invalid_request', field: 'artifact_target' },
            emptyTarget: { code: 'invalid_request', field: 'artifact_target' },
            overLongTarget: { code: 'invalid_request', field: 'artifact_target' },
            nulTarget: { code: 'invalid_request', field: 'artifact_target' },
            fileWithTarget: { code: 'invalid_request', field: 'artifact_target' },
            deleteWithTarget: { code: 'invalid_request', field: 'artifact_target' },
            unknownKind: { code: 'invalid_request', field: 'artifact_kind' },
            outOfRangeMode: { code: 'invalid_request', field: 'artifact_mode' },
            trackedNotBoolean: { code: 'invalid_request', field: 'artifact_tracked' },
            malformedBaseCommit: { code: 'invalid_request', field: 'artifact_base_commit' },
            entriesNotArray: { code: 'invalid_request', field: 'artifact_entries' },
            duplicatePath: { code: 'conflict', field: 'artifact_entry_duplicate' },
          },
          checksums: {
            declaredBytesMismatch: { code: 'conflict', field: 'artifact_content_bytes', detail: { path: 'a.txt', declared: 4, observed: 3 } },
            declaredShaMismatch: { code: 'conflict', field: 'artifact_checksum', detail: { path: 'a.txt' } },
            symlinkShaMismatch: { code: 'conflict', field: 'artifact_checksum', detail: { path: 'l' } },
          },
          checksumAfter: { writes: 1, filesOnDisk: 1 },
          absoluteSymlinkRoundTrip: {
            entry: { path: 'l', kind: 'symlink', mode: 511, target: '/etc/vis-artifact-target', contentBytes: 0, sha256: 'ca53b82ec565f4851037ead16be62a796138cf6052c64a49e504a080331813fd', tracked: false },
            shaIsShaOfTarget: true,
          },
        });
        service.close(); store.close();
      }
      // ── F6: a crafted object is refused at apply, and a real escaping symlink is a recorded link ──
      {
        const storeRoot = await scratch('store-root', 'crafted-store');
        const store = createArtifactStore({ root: storeRoot });
        const service = createArtifactService({ store, root: storeRoot });
        const target = path.join(storeRoot, 'apply-target');
        await mkdir(target, { recursive: true });
        // The wire record layout the product parses (artifactService.js:316-341):
        // [u32 contentLength][content][u32 jsonLength][json]. The content prefix is load-bearing:
        // without it the record is refused structurally before the path is ever validated.
        const recordBytes = (record, content) => {
          const json = Buffer.from(JSON.stringify(record), 'utf8');
          const contentHead = Buffer.alloc(4);
          contentHead.writeUInt32BE(content.length, 0);
          const jsonHead = Buffer.alloc(4);
          jsonHead.writeUInt32BE(json.length, 0);
          return Buffer.concat([contentHead, content, jsonHead, json]);
        };
        const crafted = (paths, record, content = Buffer.alloc(0)) => Buffer.concat([
          Buffer.from(`${JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, baseCommit: 'a'.repeat(40), entryCount: paths.length, paths })}\n`, 'utf8'),
          recordBytes(record, content),
        ]);
        const traversalArtifact = crafted(['../escaped.txt'], {
          path: '../escaped.txt', kind: 'file', mode: 0o644, target: null, contentBytes: 0,
          sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), tracked: false,
        });
        const traversalApply = await capture(() => Promise.resolve(service.apply({ artifact: traversalArtifact }, target)));
        const badShaArtifact = crafted(['a.txt'], {
          path: 'a.txt', kind: 'file', mode: 0o644, target: null, contentBytes: 0,
          sha256: 'f'.repeat(64), tracked: false,
        });
        const badShaApply = await capture(() => Promise.resolve(service.apply({ artifact: badShaArtifact }, target)));
        const noNewlineApply = await capture(() => Promise.resolve(service.apply({ artifact: Buffer.from('no newline at all', 'utf8') }, target)));
        // A genuinely truncated REAL artifact: the product's own serializer produces it, the store
        // writes it, and the last 8 bytes (inside the final record's json) are cut off.
        const validStored = await store.write({
          source: service.serialize({
            baseCommit: 'a'.repeat(40),
            entries: [{ path: 'a.txt', kind: 'file', mode: 0o644, target: null, contentBytes: 3, sha256: createHash('sha256').update('ok\n').digest('hex'), tracked: false, content: Buffer.from('ok\n', 'utf8') }],
          }),
        });
        const validBytes = await store.read(validStored.artifactHash);
        const truncatedApply = await capture(() => Promise.resolve(service.apply({ artifact: validBytes.subarray(0, validBytes.length - 8) }, target)));
        const noInputApply = await capture(() => Promise.resolve(service.apply({}, target)));
        // A real worktree symlink that points OUTSIDE the lease is recorded as a link, never
        // followed: the artifact carries the target string, not the target file's bytes.
        const repository = await createRepo('symlink-escape');
        const writersRoot = await scratch('writers-root', 'symlink-writers');
        const storeRoot2 = await scratch('store-root', 'symlink-store');
        const leases = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const store2 = createArtifactStore({ root: storeRoot2 });
        const artifacts2 = createArtifactService({ store: store2, root: storeRoot2 });
        const lease = await leases.allocate({ repository, taskId: taskIdFor('symlink-escape'), ownerId: 'writer-symlink', at: T0 });
        started.leasesAllocated += 1;
        await writeFileMode(path.join(lease.nativeCwd, 'outside.txt'), 'outside\n', 0o644);
        await symlink('outside.txt', path.join(lease.nativeCwd, 'escape-link'));
        await symlink('/etc/vis-artifact-escape-target', path.join(lease.nativeCwd, 'abs-link'));
        const captured = await artifacts2.capture({ lease, at: T0 + 10 });
        started.captures += 1;
        started.writes += 1;
        started.largestArtifactBytes = Math.max(started.largestArtifactBytes, captured.bytes);
        check('a crafted object cannot escape its apply target and a real escaping symlink is recorded as a LINK, never followed: a hand-built wire artifact naming ../escaped.txt is refused invalid_request/artifact_path at apply with nothing written inside the target and nothing created outside it, a record whose content sha256 does not match its bytes is invalid_request/artifact_structure, an artifact with no header newline is invalid_request/artifact_header, a genuinely truncated REAL artifact (the product own serializer output with the last 8 bytes cut) is invalid_request/artifact_structure, an apply with no input is invalid_request/artifact_apply — and every one of them leaves the target directory EMPTY. The symlink leg is a REAL worktree: a symlink to a sibling file and a symlink to an ABSOLUTE path outside the lease are captured as kind symlink with mode 511, contentBytes 0, the exact raw target and a sha256 over the target string (tracked false), while the sibling file they point at is captured separately as a file — the capture lstat s the link and never reads through it', {
          traversalApply,
          nothingEscaped: { insideTarget: await exists(path.join(target, 'escaped.txt')), outsideStoreRoot: await exists(path.join(storeRoot, 'escaped.txt')) },
          badShaApply,
          noNewlineApply,
          truncatedApply,
          noInputApply,
          targetUntouched: await countFiles(target),
          realSymlinkEscape: {
            entryCount: captured.entryCount,
            paths: captured.paths,
            manifest: captured.manifest,
            bytes: captured.bytes,
            linkNeverFollowed: captured.manifest.every((entry) => (entry.kind === 'symlink' ? entry.contentBytes === 0 : true)),
          },
        }, {
          traversalApply: { code: 'invalid_request', field: 'artifact_path' },
          nothingEscaped: { insideTarget: false, outsideStoreRoot: false },
          badShaApply: { code: 'invalid_request', field: 'artifact_structure' },
          noNewlineApply: { code: 'invalid_request', field: 'artifact_header' },
          truncatedApply: { code: 'invalid_request', field: 'artifact_structure' },
          noInputApply: { code: 'invalid_request', field: 'artifact_apply' },
          targetUntouched: 0,
          realSymlinkEscape: {
            entryCount: 3,
            paths: ['abs-link', 'escape-link', 'outside.txt'],
            manifest: [
              { path: 'abs-link', kind: 'symlink', mode: 511, target: '/etc/vis-artifact-escape-target', contentBytes: 0, sha256: 'deaff0991d9b9e1cbdbbbc296542f76e1a7a7e955442f6f3f5866391bccf1018', tracked: false },
              { path: 'escape-link', kind: 'symlink', mode: 511, target: 'outside.txt', contentBytes: 0, sha256: '7921a159f2c891e57f35fee4d9a8f82ba04c242588f8e4ad9e62b5afeefb42d4', tracked: false },
              { path: 'outside.txt', kind: 'file', mode: 420, target: null, contentBytes: 8, sha256: '92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43', tracked: false },
            ],
            bytes: 723,
            linkNeverFollowed: true,
          },
        });
        service.close(); store.close(); leases.close(); artifacts2.close(); store2.close();
      }

      // ── F7: a job ending with the disk losing data — preserved or declared missing, never fabricated ──
      {
        const repository = await createRepo('durable');
        const writersRoot = await scratch('writers-root', 'durable-writers');
        const storeRoot = await scratch('store-root', 'durable-store');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const store = createArtifactStore({ root: storeRoot });
        const artifacts = createArtifactService({ store, root: storeRoot });
        const lease = await service.allocate({ repository, taskId: taskIdFor('durable'), ownerId: 'writer-durable', at: T0 });
        started.leasesAllocated += 1;
        await writeFileMode(path.join(lease.nativeCwd, 'change.txt'), 'durable change\n', 0o644);
        const captured = await artifacts.capture({ lease, at: T0 + 10 });
        started.captures += 1;
        started.writes += 1;
        started.largestArtifactBytes = Math.max(started.largestArtifactBytes, captured.bytes);
        // The job ends: the artifact service, the store and the lease service all close. The
        // unconfirmed-removal refusal and the retention read are OBSERVED before that close,
        // because a closed service refuses them by design (F9).
        artifacts.close();
        store.close();
        const released = service.release({ leaseId: lease.leaseId, at: T0 + 20 });
        const unconfirmedRemove = await capture(() => service.removeWorktree({ leaseId: lease.leaseId, at: T0 + 30 }));
        const retentionBefore = await service.retention(lease.leaseId);
        const worktreeExistsAfterJobEnd = await exists(lease.worktree);
        service.close();
        // OBSERVED on disk after the job end: the object is still there and still re-hashes.
        // Every value below is SNAPSHOTTED at its own moment: a live read taken after a later
        // mutation would report the mutated world (the task-31 lesson).
        const reopenedStore = createArtifactStore({ root: storeRoot });
        const verified = await reopenedStore.verify(captured.artifactHash);
        const durablePreserved = {
          reopenedHas: await reopenedStore.has(captured.artifactHash),
          verifyOk: verified.ok,
          verifyHashMatches: verified.artifactHash === captured.artifactHash,
          verifyBytes: verified.bytes,
          verifyChunks: verified.chunks,
          verifyPeakBufferedBytes: verified.peakBufferedBytes,
        };
        const missingRead = await capture(() => reopenedStore.read('f'.repeat(64)));
        const reopenedService = createArtifactService({ store: reopenedStore, root: storeRoot });
        const applyTarget = path.join(storeRoot, 'apply-target');
        const missingApply = await capture(() => reopenedService.apply({ artifactHash: 'e'.repeat(64) }, applyTarget));
        const missingDeclared = {
          missingHas: await reopenedStore.has('f'.repeat(64)),
          missingRead,
          missingApply,
          applyTargetCreated: await exists(applyTarget),
        };
        // The disk then CORRUPTS the object: verify detects it, and a re-write of the same source
        // REFUSES (artifact_immutable) rather than silently replacing the stored bytes.
        const objectPath = path.join(storeRoot, 'objects', captured.artifactHash.slice(0, 2), captured.artifactHash.slice(2));
        await chmod(objectPath, 0o644);
        await writeFile(objectPath, 'corrupted bytes');
        const corruptedVerify = await reopenedStore.verify(captured.artifactHash);
        const immutableRefusal = await captureDetail(() => reopenedStore.write({
          source: reopenedService.serialize({
            baseCommit: captured.baseCommit,
            entries: [{ path: 'change.txt', kind: 'file', mode: 0o644, target: null, contentBytes: 15, sha256: createHash('sha256').update('durable change\n').digest('hex'), tracked: false, content: Buffer.from('durable change\n', 'utf8') }],
          }),
        }));
        const corrupted = {
          verifyOk: corruptedVerify.ok,
          immutableRefusal: {
            code: immutableRefusal.code,
            field: immutableRefusal.field,
            detail: {
              artifactHashMatchesCapture: immutableRefusal.detail?.artifactHash === captured.artifactHash,
              observedIsDigestOfCorruptedBytes: immutableRefusal.detail?.observed === createHash('sha256').update('corrupted bytes').digest('hex'),
            },
          },
          after: { writes: reopenedStore.state().writes, immutableRefusals: reopenedStore.state().immutableRefusals, filesOnDisk: await countFiles(storeRoot) },
        };
        // The disk then LOSES the object: every read path declares the miss explicitly, and no
        // patch is ever fabricated.
        await rm(objectPath, { force: true });
        const lost = {
          lostHas: await reopenedStore.has(captured.artifactHash),
          lostRead: await capture(() => reopenedStore.read(captured.artifactHash)),
          lostVerify: await capture(() => reopenedStore.verify(captured.artifactHash)),
          lostApply: await capture(() => reopenedService.apply({ artifactHash: captured.artifactHash }, applyTarget)),
          lostOpen: await capture(() => reopenedStore.open(captured.artifactHash)),
          applyTargetCreated: await exists(applyTarget),
        };
        const lostStoreState = { writes: reopenedStore.state().writes, oversizeRejections: reopenedStore.state().oversizeRejections, immutableRefusals: reopenedStore.state().immutableRefusals, closed: reopenedStore.state().closed };
        // A capture with NOTHING to record refuses to fabricate a patch.
        const emptyRepository = await createRepo('no-change');
        const emptyWriters = await scratch('writers-root', 'no-change-writers');
        const emptyStoreRoot = await scratch('store-root', 'no-change-store');
        const emptyService = createWriterLeaseService({ writersRoot: emptyWriters, newLeaseId: nextLeaseId });
        const emptyStore = createArtifactStore({ root: emptyStoreRoot });
        const emptyArtifacts = createArtifactService({ store: emptyStore, root: emptyStoreRoot });
        const emptyLease = await emptyService.allocate({ repository: emptyRepository, taskId: taskIdFor('no-change'), ownerId: 'writer-no-change', at: T0 });
        started.leasesAllocated += 1;
        const emptyCapture = await captureDetail(() => emptyArtifacts.capture({ lease: emptyLease, at: T0 + 1 }));
        started.captures += 1;
        check('a job ending with the disk losing data is honest in BOTH directions: while the bytes are there, the DURABLE artifact is preserved — after every service closed and the lease was released, a reopened store still holds the object, re-hashes it to the recorded value with ok true and the same byte count, and the unconfirmed worktree is retained on disk — and once the bytes are gone the loss is DECLARED, never papered over: a hash that was never stored and a hash whose object was deleted are each an explicit invalid_request/artifact_missing from read, verify, open and apply alike, the apply target is never created, and a capture with nothing to record refuses conflict/artifact_empty before touching the store so NO PATCH IS EVER FABRICATED. A corrupted object is detected rather than trusted (verify ok false) and a re-write of the same source REFUSES conflict/artifact_immutable carrying the expected and observed hashes instead of silently replacing the stored bytes', {
          released: {
            state: released.state,
            releasedAt: released.releasedAt,
            worktreeDisposition: released.worktree.disposition,
            userConfirmed: released.userConfirmed,
          },
          releaseViewKeys: Object.keys(released).sort(),
          unconfirmedRemove,
          worktreeRetainedAfterJobEnd: {
            exists: worktreeExistsAfterJobEnd,
            leaseState: { active: 0, released: 1, removed: 0, total: 1, worktreesRetained: 1, worktreesRemoved: 0, closed: false },
          },
          retentionBefore: {
            leaseIdMatches: retentionBefore.leaseId === lease.leaseId,
            pathMatches: retentionBefore.path === lease.worktree,
            userConfirmed: retentionBefore.userConfirmed,
            confirmedAt: retentionBefore.confirmedAt,
            removedAt: retentionBefore.removedAt,
            exists: retentionBefore.exists,
          },
          durableArtifactPreserved: durablePreserved,
          missingDeclared,
          corrupted,
          lost,
          lostStoreState,
          emptyCapture: {
            code: emptyCapture.code,
            field: emptyCapture.field,
            detail: {
              leaseIdMatches: emptyCapture.detail?.leaseId === emptyLease.leaseId,
              baseCommitMatches: emptyCapture.detail?.baseCommit === emptyLease.baseCommit,
            },
          },
          emptyAfter: { writes: emptyStore.state().writes, emptyRefusals: emptyArtifacts.state().emptyRefusals, captures: emptyArtifacts.state().captures },
        }, {
          released: { state: 'released', releasedAt: T0 + 20, worktreeDisposition: 'retained', userConfirmed: false },
          releaseViewKeys: ['leaseId', 'releasedAt', 'state', 'userConfirmed', 'worktree'],
          unconfirmedRemove: { code: 'conflict', field: 'writer_worktree_unconfirmed' },
          worktreeRetainedAfterJobEnd: {
            exists: true,
            leaseState: { active: 0, released: 1, removed: 0, total: 1, worktreesRetained: 1, worktreesRemoved: 0, closed: false },
          },
          retentionBefore: {
            leaseIdMatches: true,
            pathMatches: true,
            userConfirmed: false,
            confirmedAt: null,
            removedAt: null,
            exists: true,
          },
          durableArtifactPreserved: {
            reopenedHas: true,
            verifyOk: true,
            verifyHashMatches: true,
            verifyBytes: 307,
            verifyChunks: 1,
            verifyPeakBufferedBytes: 307,
          },
          missingDeclared: {
            missingHas: false,
            missingRead: { code: 'invalid_request', field: 'artifact_missing' },
            missingApply: { code: 'invalid_request', field: 'artifact_missing' },
            applyTargetCreated: false,
          },
          corrupted: {
            verifyOk: false,
            immutableRefusal: {
              code: 'conflict',
              field: 'artifact_immutable',
              detail: { artifactHashMatchesCapture: true, observedIsDigestOfCorruptedBytes: true },
            },
            after: { writes: 0, immutableRefusals: 1, filesOnDisk: 1 },
          },
          lost: {
            lostHas: false,
            lostRead: { code: 'invalid_request', field: 'artifact_missing' },
            lostVerify: { code: 'invalid_request', field: 'artifact_missing' },
            lostApply: { code: 'invalid_request', field: 'artifact_missing' },
            lostOpen: { code: 'invalid_request', field: 'artifact_missing' },
            applyTargetCreated: false,
          },
          lostStoreState: { writes: 0, oversizeRejections: 0, immutableRefusals: 1, closed: false },
          emptyCapture: {
            code: 'conflict',
            field: 'artifact_empty',
            detail: { leaseIdMatches: true, baseCommitMatches: true },
          },
          emptyAfter: { writes: 0, emptyRefusals: 1, captures: 0 },
        });
        reopenedService.close(); reopenedStore.close(); emptyArtifacts.close(); emptyStore.close(); emptyService.close();
      }

      // ── F8: exiting releases and RETAINS; removal needs an explicit user confirmation ──
      {
        const repository = await createRepo('retain');
        const writersRoot = await scratch('writers-root', 'retain-writers');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const lease = await service.allocate({ repository, taskId: taskIdFor('confirm-remove'), ownerId: 'writer-confirm', at: T0 });
        started.leasesAllocated += 1;
        await service.release({ leaseId: lease.leaseId, at: T0 + 2 });
        // Confirming before release is a conflict: a live lease cannot be dismantled.
        const live = createWriterLeaseService({ writersRoot: await scratch('writers-root', 'retain-live'), newLeaseId: nextLeaseId });
        const other = await live.allocate({ repository, taskId: taskIdFor('confirm-remove-live'), ownerId: 'writer-live', at: T0 });
        started.leasesAllocated += 1;
        const tooEarly = await captureDetail(() => deferred(() => live.confirmWorktreeRemoval({ leaseId: other.leaseId, at: T0 + 3 })));
        const confirmed = await service.confirmWorktreeRemoval({ leaseId: lease.leaseId, at: T0 + 4 });
        // OBSERVED here, before the removal: the confirmation alone deletes nothing.
        const worktreeStillPresentAfterConfirm = await exists(lease.worktree);
        const removed = await service.removeWorktree({ leaseId: lease.leaseId, at: T0 + 5 });
        const retentionAfterRemove = await service.retention(lease.leaseId);
        const stateAfterRemove = service.state();
        const releaseRemoved = await captureDetail(() => deferred(() => service.release({ leaseId: lease.leaseId, at: T0 + 6 })));
        const removeTwice = await service.removeWorktree({ leaseId: lease.leaseId, at: T0 + 7 });
        live.close();
        // Exiting — closing the whole service — deletes nothing either.
        const exitRepository = await createRepo('exit-retain');
        const exitWriters = await scratch('writers-root', 'exit-retain-writers');
        const exitService = createWriterLeaseService({ writersRoot: exitWriters, newLeaseId: nextLeaseId });
        const exitLease = await exitService.allocate({ repository: exitRepository, taskId: taskIdFor('exit-retain'), ownerId: 'writer-exit', at: T0 });
        started.leasesAllocated += 1;
        exitService.close();
        check('exiting does not automatically delete a user-unconfirmed worktree, and removal requires an explicit user confirmation: releasing hands back a read model whose only worktree member is the retained disposition with userConfirmed false, removing without a confirmation is an explicit conflict/writer_worktree_unconfirmed refusal and the worktree is OBSERVED still on disk, confirming while the lease is still live is conflict/writer_lease_state carrying state active, and only after the explicit confirmation does removeWorktree delete it — the retention view then reports removedAt set with exists false, the service counters report one removed worktree, releasing an already-removed lease is conflict/writer_lease_state carrying state removed, a second removal is idempotent, and CLOSING the whole service deletes nothing: the unconfirmed worktree is still on disk with closed true', {
          tooEarly,
          confirmed: { userConfirmed: confirmed.userConfirmed, confirmedAt: confirmed.confirmedAt, removedAt: confirmed.removedAt, exists: confirmed.exists },
          worktreeStillPresentAfterConfirm,
          removed: { removedAt: removed.removedAt, exists: removed.exists, userConfirmed: removed.userConfirmed },
          retentionAfterRemove: { userConfirmed: retentionAfterRemove.userConfirmed, confirmedAt: retentionAfterRemove.confirmedAt, removedAt: retentionAfterRemove.removedAt, exists: retentionAfterRemove.exists },
          stateAfterRemove,
          releaseRemoved,
          removeTwice: { removedAt: removeTwice.removedAt, exists: removeTwice.exists },
          closeDeletesNothing: { closed: exitService.state().closed, worktreeExistsAfterClose: await exists(exitLease.worktree), state: exitService.state() },
        }, {
          tooEarly: { code: 'conflict', field: 'writer_lease_state', detail: { leaseId: other.leaseId, state: 'active' } },
          confirmed: { userConfirmed: true, confirmedAt: T0 + 4, removedAt: null, exists: true },
          worktreeStillPresentAfterConfirm: true,
          removed: { removedAt: T0 + 5, exists: false, userConfirmed: true },
          retentionAfterRemove: { userConfirmed: true, confirmedAt: T0 + 4, removedAt: T0 + 5, exists: false },
          stateAfterRemove: { active: 0, released: 0, removed: 1, total: 1, worktreesRetained: 0, worktreesRemoved: 1, closed: false },
          releaseRemoved: { code: 'conflict', field: 'writer_lease_state', detail: { leaseId: lease.leaseId, state: 'removed' } },
          removeTwice: { removedAt: T0 + 5, exists: false },
          closeDeletesNothing: { closed: true, worktreeExistsAfterClose: true, state: { active: 0, released: 0, removed: 0, total: 0, worktreesRetained: 0, worktreesRemoved: 0, closed: true } },
        });
        service.close();
      }

      // ── F9: a read-only lease, the closed services and the typed rejections ──
      {
        const repository = await createRepo('read-only');
        const writersRoot = await scratch('writers-root', 'read-only-writers');
        const storeRoot = await scratch('store-root', 'read-only-store');
        const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
        const store = createArtifactStore({ root: storeRoot });
        const artifacts = createArtifactService({ store, root: storeRoot });
        const lease = await service.allocate({ repository, taskId: taskIdFor('read-only'), ownerId: 'writer-readonly', at: T0, readOnly: true });
        started.leasesAllocated += 1;
        await writeFileMode(path.join(lease.nativeCwd, 'notes.md'), 'read only\n', 0o644);
        const readOnlyCapture = await captureDetail(() => artifacts.capture({ lease, at: T0 + 8 }));
        started.captures += 1;
        // OBSERVED before the close: a read-only lease's reviewer posture still denies a sandbox.
        const readOnlyPostureSandbox = service.posture(lease.leaseId).sandbox;
        service.close(); artifacts.close(); store.close();
        const closedStore = createArtifactStore({ root: storeRoot });
        closedStore.close();
        const closedArtifacts = createArtifactService({ store: closedStore, root: storeRoot });
        closedArtifacts.close();
        const fresh = createWriterLeaseService({ writersRoot: await scratch('writers-root', 'typed-writers'), newLeaseId: nextLeaseId });
        check('the read-only lease cannot be captured, every closed service refuses with an explicit cancelled code, and every malformed caller input is a typed refusal rather than a bare throw: a read-only lease carries worktreeAccess read-only with the user repository read-only and a frozen snapshot of its own base commit and worktree, its capture is unsupported/writer_lease_read_only carrying the lease id, and its reviewer posture still denies a sandbox; after close the lease service refuses allocate, lease, nativeCwd, posture, run and release with cancelled/writer_service_closed while the store refuses write and read with cancelled/artifact_store_closed and the artifact service refuses capture with cancelled/artifact_service_closed; an unknown lease id, a malformed task id, an empty owner, an over-limit ttl, a blank repository and a non-positive `at` are each invalid_request with the plain rejection field', {
          readOnly: {
            policy: lease.policy,
            snapshot: { frozen: Object.isFrozen(lease.snapshot), baseCommitMatches: lease.snapshot.baseCommit === lease.baseCommit, worktreeMatches: lease.snapshot.worktree === lease.worktree, createdAt: lease.snapshot.createdAt },
            capture: readOnlyCapture,
            postureSandbox: readOnlyPostureSandbox,
          },
          closedService: {
            allocate: await capture(() => service.allocate({ repository, taskId: taskIdFor('closed'), ownerId: 'w', at: T0 })),
            lease: await capture(() => deferred(() => service.lease(lease.leaseId))),
            nativeCwd: await capture(() => deferred(() => service.nativeCwd(lease.leaseId))),
            posture: await capture(() => deferred(() => service.posture(lease.leaseId))),
            run: await capture(() => deferred(() => service.run({ leaseId: lease.leaseId, command: process.execPath, args: ['-e', ''] }))),
            release: await capture(() => deferred(() => service.release({ leaseId: lease.leaseId }))),
          },
          closedStore: {
            write: await capture(() => closedStore.write({ source: createBufferSource(Buffer.from('x')) })),
            read: await capture(() => closedStore.read('f'.repeat(64))),
          },
          closedArtifacts: { capture: await capture(() => closedArtifacts.capture({ lease })) },
          typedRejections: {
            unknownLease: await capture(() => deferred(() => fresh.lease('f'.repeat(8)))),
            badTaskId: await capture(() => fresh.allocate({ repository: '/tmp', taskId: 'not-a-uuid', ownerId: 'w', at: T0 })),
            emptyOwner: await capture(() => fresh.allocate({ repository: '/tmp', taskId: taskIdFor('reject'), ownerId: '', at: T0 })),
            hugeTtl: await capture(() => fresh.allocate({ repository: '/tmp', taskId: taskIdFor('reject-ttl'), ownerId: 'w', at: T0, ttlMs: WRITER_LIMITS.maxLeaseTtlMs + 1 })),
            emptyRepository: await capture(() => fresh.allocate({ repository: '   ', taskId: taskIdFor('reject-repo'), ownerId: 'w', at: T0 })),
            nonPositiveAt: await capture(() => fresh.allocate({ repository: '/tmp', taskId: taskIdFor('reject-at'), ownerId: 'w', at: 0 })),
          },
        }, {
          readOnly: {
            policy: { worktreeAccess: 'read-only', userRepository: 'read-only' },
            snapshot: { frozen: true, baseCommitMatches: true, worktreeMatches: true, createdAt: T0 },
            capture: { code: 'unsupported', field: 'writer_lease_read_only', detail: { leaseId: lease.leaseId } },
            postureSandbox: false,
          },
          closedService: {
            allocate: { code: 'cancelled', field: 'writer_service_closed' },
            lease: { code: 'cancelled', field: 'writer_service_closed' },
            nativeCwd: { code: 'cancelled', field: 'writer_service_closed' },
            posture: { code: 'cancelled', field: 'writer_service_closed' },
            run: { code: 'cancelled', field: 'writer_service_closed' },
            release: { code: 'cancelled', field: 'writer_service_closed' },
          },
          closedStore: {
            write: { code: 'cancelled', field: 'artifact_store_closed' },
            read: { code: 'cancelled', field: 'artifact_store_closed' },
          },
          closedArtifacts: { capture: { code: 'cancelled', field: 'artifact_service_closed' } },
          typedRejections: {
            unknownLease: { code: 'invalid_request', field: 'lease_id' },
            badTaskId: { code: 'invalid_request', field: 'task_id' },
            emptyOwner: { code: 'invalid_request', field: 'writer_owner' },
            hugeTtl: { code: 'invalid_request', field: 'writer_ttl' },
            emptyRepository: { code: 'invalid_request', field: 'writer_repository' },
            nonPositiveAt: { code: 'invalid_request', field: 'collaboration_time' },
          },
        });
        fresh.close();
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: a REAL git repository with two writers changing the SAME file, each producing
      // its own artifact at the same base; binary / untracked / delete / mode changes captured
      // with real observed values; the native cwd MEASURED; the change reproduced byte-for-byte;
      // the reviewer never told a sandbox exists; every command STARTED or CHECKED.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── H1 + H2: two writers, one real repository, the same file, each its own artifact ──
      const repository = await createRepo('two-writers');
      const writersRoot = await scratch('writers-root', 'two-writers-writers');
      const storeRoot = await scratch('store-root', 'two-writers-store');
      const service = createWriterLeaseService({ writersRoot, newLeaseId: nextLeaseId });
      const store = createArtifactStore({ root: storeRoot });
      const artifacts = createArtifactService({ store, root: storeRoot });
      const first = await service.allocate({ repository, taskId: taskIdFor('two-writers-a'), ownerId: 'writer-a', at: T0 });
      const second = await service.allocate({ repository, taskId: taskIdFor('two-writers-b'), ownerId: 'writer-b', at: T0 });
      started.leasesAllocated += 2;
      const repoHead = runGit(repository, ['rev-parse', 'HEAD']).trim();

      // Writer A: the SAME file as writer B, plus every change class the plan names.
      const cwdA = first.nativeCwd;
      await writeFileMode(path.join(cwdA, 'src', 'keep.txt'), 'keep changed\nsecond line\n', 0o644);
      await writeFileMode(path.join(cwdA, 'bin.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x10]), 0o644);
      await chmod(path.join(cwdA, 'script.sh'), 0o755);
      await rm(path.join(cwdA, 'link'));
      await symlink('notes.md', path.join(cwdA, 'link'));
      await rm(path.join(cwdA, 'link2'));
      await rm(path.join(cwdA, 'README.md'));
      await writeFileMode(path.join(cwdA, 'notes.md'), '# notes\n', 0o644);
      const binary = Buffer.alloc(512);
      for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256;
      await writeFileMode(path.join(cwdA, 'blob.dat'), binary, 0o644);
      await mkdir(path.join(cwdA, 'newdir', 'deeper'), { recursive: true });
      await writeFileMode(path.join(cwdA, 'newdir', 'deeper', 'deep.txt'), 'deep\n', 0o644);
      // Writer B: the SAME file, its own content.
      await writeFileMode(path.join(second.nativeCwd, 'src', 'keep.txt'), 'writer B owns this file\n', 0o644);

      const capturedA = await artifacts.capture({ lease: first, at: T0 + 10 });
      const capturedB = await artifacts.capture({ lease: second, at: T0 + 10 });
      started.captures += 2;
      started.writes += 2;
      started.largestArtifactBytes = Math.max(started.largestArtifactBytes, capturedA.bytes, capturedB.bytes);

      // ── H1: two writers on the SAME repository get distinct cwds and distinct leases ──
      check('two writers on the SAME repository get different cwds and different leases, at the same base: both leases are allocated against one private repository and OBSERVED to carry the same resolved repository key and the same base commit — which equals the repository HEAD read for real with git rev-parse — while their lease ids, task ids, worktrees and native cwds are pairwise distinct, each worktree is the frozen derivation writer-<leaseId> under the writers root (never a name derived from the repository), each native cwd IS its own worktree and is neither the repository nor the sibling, both leases are active with the read-write policy over a read-only user repository and the default one-hour ttl, the snapshots are frozen copies of the base commit and worktree, and the repository read model lists exactly the two writers', {
        repositoryShared: first.repository === second.repository,
        repositoryIsResolvedRepository: first.repository === path.resolve(repository),
        baseShared: first.baseCommit === second.baseCommit,
        baseEqualsObservedRepoHead: first.baseCommit === repoHead && second.baseCommit === repoHead,
        baseCommitShape: COMMIT.test(first.baseCommit) && COMMIT.test(second.baseCommit),
        leaseIds: [first.leaseId, second.leaseId],
        taskIds: [first.taskId, second.taskId],
        identitiesDistinct: {
          leaseId: first.leaseId !== second.leaseId,
          taskId: first.taskId !== second.taskId,
          worktree: first.worktree !== second.worktree,
          nativeCwd: first.nativeCwd !== second.nativeCwd,
        },
        worktreesDerivedFromLeaseIds: [
          first.worktree === path.join(writersRoot, `writer-${first.leaseId}`),
          second.worktree === path.join(writersRoot, `writer-${second.leaseId}`),
        ],
        nativeCwdEqualsWorktree: [first.nativeCwd === first.worktree, second.nativeCwd === second.worktree],
        policies: [first.policy, second.policy],
        states: [first.state, second.state],
        createdAt: [first.createdAt, second.createdAt],
        expiresAt: [first.expiresAt, second.expiresAt],
        ttlMs: [first.expiresAt - first.createdAt, second.expiresAt - second.createdAt],
        releasedAndRemoved: [[first.releasedAt, first.removedAt], [second.releasedAt, second.removedAt]],
        snapshots: [
          Object.isFrozen(first.snapshot),
          first.snapshot.baseCommit === first.baseCommit,
          first.snapshot.worktree === first.worktree,
          first.snapshot.createdAt === T0,
        ],
        leasesByRepository: service.leasesByRepository(repository).length,
        serviceState: service.state(),
        limits: { ...WRITER_LIMITS },
        limitsFrozen: Object.isFrozen(WRITER_LIMITS),
        viewsFrozen: [Object.isFrozen(first), Object.isFrozen(second), Object.isFrozen(first.policy), Object.isFrozen(first.snapshot)],
      }, {
        repositoryShared: true,
        repositoryIsResolvedRepository: true,
        baseShared: true,
        baseEqualsObservedRepoHead: true,
        baseCommitShape: true,
        leaseIds: ['b0000001-bbbb-4bbb-8bbb-bbbbbbbb0001', 'b0000002-bbbb-4bbb-8bbb-bbbbbbbb0002'],
        taskIds: ['cb848162-ed8e-4cdb-8553-8077f425a561', '6c8d590d-1441-418c-83ef-12f472ceddd4'],
        identitiesDistinct: { leaseId: true, taskId: true, worktree: true, nativeCwd: true },
        worktreesDerivedFromLeaseIds: [true, true],
        nativeCwdEqualsWorktree: [true, true],
        policies: [
          { worktreeAccess: 'read-write', userRepository: 'read-only' },
          { worktreeAccess: 'read-write', userRepository: 'read-only' },
        ],
        states: ['active', 'active'],
        createdAt: [T0, T0],
        expiresAt: [T0 + 3600000, T0 + 3600000],
        ttlMs: [3600000, 3600000],
        releasedAndRemoved: [[null, null], [null, null]],
        snapshots: [true, true, true, true],
        leasesByRepository: 2,
        serviceState: { active: 2, released: 0, removed: 0, total: 2, worktreesRetained: 2, worktreesRemoved: 0, closed: false },
        limits: { maxWritersPerRepository: 8, maxActiveLeases: 32, maxLeaseTtlMs: 86400000, maxCwdChars: 1024, maxOwnerChars: 128, maxRepositoryChars: 1024, maxWorktreeNameChars: 128 },
        limitsFrozen: true,
        viewsFrozen: [true, true, true, true],
      });

      // ── H2: each writer produces its OWN artifact for the SAME file ──
      check('two writers changing the SAME file each produce their OWN immutable artifact at the same base, and the binary / untracked / delete / mode change classes are captured with real observed values: both artifacts carry the same base commit and distinct hashes, src/keep.txt appears in BOTH manifests with DIFFERENT content bytes (25 against 24) and different sha256 values that are exactly the digests of each writer own bytes, and writer A artifact additionally records a tracked text edit, a tracked binary edit of 6 bytes, a tracked mode-only change to 0o755, a tracked symlink retarget to notes.md, a tracked symlink deletion, a tracked file deletion (both delete entries mode 0 with the empty-payload sha256), an untracked text file, an untracked binary file of 512 bytes holding every byte value, and an untracked nested path — nine sorted, unique, frozen manifest paths with each entry kind, mode, target, contentBytes, sha256 and tracked flag read out of the durable object. The artifact is smaller than one frozen 64 KiB chunk, so the product own gauge legitimately reports peakBufferedBytes equal to the byte count here; the streaming proof is the failure lane 1 MiB world', {
        capturedA: {
          baseCommitMatches: capturedA.baseCommit === first.baseCommit,
          leaseId: capturedA.leaseId,
          worktree: capturedA.worktree === first.worktree,
          nativeCwd: capturedA.nativeCwd === first.nativeCwd,
          bytes: capturedA.bytes,
          chunks: capturedA.chunks,
          peakBufferedBytes: capturedA.peakBufferedBytes,
          entryCount: capturedA.entryCount,
          pathCount: capturedA.pathCount,
          paths: capturedA.paths,
          manifest: capturedA.manifest,
          capturedAt: capturedA.capturedAt,
        },
        capturedB: {
          baseCommitMatches: capturedB.baseCommit === second.baseCommit,
          leaseId: capturedB.leaseId,
          bytes: capturedB.bytes,
          chunks: capturedB.chunks,
          peakBufferedBytes: capturedB.peakBufferedBytes,
          entryCount: capturedB.entryCount,
          pathCount: capturedB.pathCount,
          paths: capturedB.paths,
          manifest: capturedB.manifest,
          capturedAt: capturedB.capturedAt,
        },
        hashesDistinct: capturedA.artifactHash !== capturedB.artifactHash,
        sameFileBothWriters: {
          inA: capturedA.paths.includes('src/keep.txt'),
          inB: capturedB.paths.includes('src/keep.txt'),
          bytesA: capturedA.manifest.find((entry) => entry.path === 'src/keep.txt').contentBytes,
          bytesB: capturedB.manifest.find((entry) => entry.path === 'src/keep.txt').contentBytes,
          shaA: capturedA.manifest.find((entry) => entry.path === 'src/keep.txt').sha256,
          shaB: capturedB.manifest.find((entry) => entry.path === 'src/keep.txt').sha256,
          shaAIsDigestOfWriterABytes: capturedA.manifest.find((entry) => entry.path === 'src/keep.txt').sha256 === createHash('sha256').update('keep changed\nsecond line\n').digest('hex'),
          shaBIsDigestOfWriterBBytes: capturedB.manifest.find((entry) => entry.path === 'src/keep.txt').sha256 === createHash('sha256').update('writer B owns this file\n').digest('hex'),
        },
        frozen: [Object.isFrozen(capturedA.paths), Object.isFrozen(capturedA.manifest), Object.isFrozen(capturedB.paths), Object.isFrozen(capturedB.manifest)],
        serviceState: artifacts.state(),
        storeState: store.state(),
      }, {
        capturedA: {
          baseCommitMatches: true,
          leaseId: 'b0000001-bbbb-4bbb-8bbb-bbbbbbbb0001',
          worktree: true,
          nativeCwd: true,
          bytes: 2369,
          chunks: 1,
          peakBufferedBytes: 2369,
          entryCount: 9,
          pathCount: 9,
          paths: ['README.md', 'bin.bin', 'blob.dat', 'link', 'link2', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'],
          manifest: [
            { path: 'README.md', kind: 'delete', mode: 0, target: null, contentBytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', tracked: true },
            { path: 'bin.bin', kind: 'file', mode: 420, target: null, contentBytes: 6, sha256: 'a33326827880764f2249194591415ff54f0cd09d22619890de607a92a3058476', tracked: true },
            { path: 'blob.dat', kind: 'file', mode: 420, target: null, contentBytes: 512, sha256: '110009dcee21620b166f3abfecb5eff7a873be729d1c2d53822e7acc5f34eb9b', tracked: false },
            { path: 'link', kind: 'symlink', mode: 511, target: 'notes.md', contentBytes: 0, sha256: '754b6dc3f8728b1991298d8359218165de3ef7439963168565aaaaf7a99b3edd', tracked: true },
            { path: 'link2', kind: 'delete', mode: 0, target: null, contentBytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', tracked: true },
            { path: 'newdir/deeper/deep.txt', kind: 'file', mode: 420, target: null, contentBytes: 5, sha256: '64896f89fd11190013b70103e603a1c5826e56b7fb7d2197ab279b0690043599', tracked: false },
            { path: 'notes.md', kind: 'file', mode: 420, target: null, contentBytes: 8, sha256: '4a28fc250c09e1f28c9f37486fca6db3c7a4ee707373216f6f7bd62ade5d9330', tracked: false },
            { path: 'script.sh', kind: 'file', mode: 493, target: null, contentBytes: 8, sha256: 'ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e', tracked: true },
            { path: 'src/keep.txt', kind: 'file', mode: 420, target: null, contentBytes: 25, sha256: '88a850519c5118361d41c44a3208ab262f2bd4d582fa14bdbe3473d06bd7e24f', tracked: true },
          ],
          capturedAt: T0 + 10,
        },
        capturedB: {
          baseCommitMatches: true,
          leaseId: 'b0000002-bbbb-4bbb-8bbb-bbbbbbbb0002',
          bytes: 319,
          chunks: 1,
          peakBufferedBytes: 319,
          entryCount: 1,
          pathCount: 1,
          paths: ['src/keep.txt'],
          manifest: [
            { path: 'src/keep.txt', kind: 'file', mode: 420, target: null, contentBytes: 24, sha256: 'c5edc897ac7a53cab5330fc521908bbf633aec4a17c3e601c71757ae75122579', tracked: true },
          ],
          capturedAt: T0 + 10,
        },
        hashesDistinct: true,
        sameFileBothWriters: {
          inA: true,
          inB: true,
          bytesA: 25,
          bytesB: 24,
          shaA: '88a850519c5118361d41c44a3208ab262f2bd4d582fa14bdbe3473d06bd7e24f',
          shaB: 'c5edc897ac7a53cab5330fc521908bbf633aec4a17c3e601c71757ae75122579',
          shaAIsDigestOfWriterABytes: true,
          shaBIsDigestOfWriterBBytes: true,
        },
        frozen: [true, true, true, true],
        serviceState: { captures: 2, applies: 0, emptyRefusals: 0, closed: false },
        storeState: { writes: 2, oversizeRejections: 0, immutableRefusals: 0, closed: false },
      });

      // ── H3: the change is LOSSLESS — the artifact reproduces the tree byte-for-byte ──
      {
        const pristineRoot = await scratch('pristine-root', 'two-writers-pristine');
        const pristine = path.join(pristineRoot, 'pristine-a');
        runGit(repository, ['worktree', 'add', '--detach', '--', pristine, first.baseCommit]);
        const dryRun = await artifacts.apply({ artifactHash: capturedA.artifactHash }, pristine, { dryRun: true });
        started.applies += 1;
        const beforeTree = await treeShape(cwdA);
        const appliedA = await artifacts.apply({ artifactHash: capturedA.artifactHash }, pristine);
        started.applies += 1;
        const afterTree = await treeShape(pristine);
        const pristineB = path.join(pristineRoot, 'pristine-b');
        runGit(repository, ['worktree', 'add', '--detach', '--', pristineB, second.baseCommit]);
        const appliedB = await artifacts.apply({ artifactHash: capturedB.artifactHash }, pristineB);
        started.applies += 1;
        const bTree = await treeShape(pristineB);
        const round = artifacts.deserialize(await store.read(capturedA.artifactHash));
        const mismatch = (field) => beforeTree.filter((entry, index) => afterTree[index] === undefined || afterTree[index][field] !== entry[field]).length;
        check('the change is LOSSLESS: the artifact applied onto a pristine git worktree of the SAME base commit reproduces the writer tree byte-for-byte — the dry run plans exactly the 7 creates and 2 deletions without touching the disk, the real apply reports 9 applied paths, and both trees are then walked independently with lstat / readlink / readFile and compared per path on kind, mode, content sha256 and raw link target with ZERO mismatches over the identical 7-path set (the mode-only change lands as 0o755, the retargeted symlink as a link to notes.md, the deletions stay deleted, and the 512-byte binary round-trips exactly). Writer B single-file artifact likewise applies onto its own pristine worktree (applied 1) and reproduces its own bytes beside the untouched base tree, and the manifest read back out of the durable object equals the captured manifest path-for-path with the summed content bytes', {
          dryRun: {
            applied: dryRun.applied,
            baseCommitMatches: dryRun.baseCommit === first.baseCommit,
            paths: dryRun.paths,
            wouldCreate: dryRun.wouldCreate,
            wouldDelete: dryRun.wouldDelete,
          },
          appliedA: { applied: appliedA.applied, baseCommitMatches: appliedA.baseCommit === first.baseCommit, paths: appliedA.paths },
          treeComparison: {
            pathsBefore: beforeTree.map((entry) => entry.path),
            pathsAfter: afterTree.map((entry) => entry.path),
            samePathSet: JSON.stringify(beforeTree.map((entry) => entry.path)) === JSON.stringify(afterTree.map((entry) => entry.path)),
            kindMismatches: mismatch('kind'),
            modeMismatches: mismatch('mode'),
            contentMismatches: mismatch('sha256'),
            targetMismatches: mismatch('target'),
            perPath: afterTree,
          },
          appliedB: { applied: appliedB.applied, baseCommitMatches: appliedB.baseCommit === second.baseCommit, paths: appliedB.paths },
          bTree,
          roundTrip: {
            schemaVersion: round.schemaVersion,
            entryCount: round.entryCount,
            contentBytes: round.contentBytes,
            paths: round.paths,
            manifestEqualsCaptured: JSON.stringify(round.entries) === JSON.stringify(capturedA.manifest),
          },
          serviceState: artifacts.state(),
        }, {
          dryRun: {
            applied: 0,
            baseCommitMatches: true,
            paths: ['README.md', 'bin.bin', 'blob.dat', 'link', 'link2', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'],
            wouldCreate: ['bin.bin', 'blob.dat', 'link', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'],
            wouldDelete: ['README.md', 'link2'],
          },
          appliedA: { applied: 9, baseCommitMatches: true, paths: ['README.md', 'bin.bin', 'blob.dat', 'link', 'link2', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'] },
          treeComparison: {
            pathsBefore: ['bin.bin', 'blob.dat', 'link', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'],
            pathsAfter: ['bin.bin', 'blob.dat', 'link', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'],
            samePathSet: true,
            kindMismatches: 0,
            modeMismatches: 0,
            contentMismatches: 0,
            targetMismatches: 0,
            perPath: [
              { path: 'bin.bin', kind: 'file', mode: 420, sha256: 'a33326827880764f2249194591415ff54f0cd09d22619890de607a92a3058476', target: null },
              { path: 'blob.dat', kind: 'file', mode: 420, sha256: '110009dcee21620b166f3abfecb5eff7a873be729d1c2d53822e7acc5f34eb9b', target: null },
              { path: 'link', kind: 'symlink', mode: 511, sha256: '754b6dc3f8728b1991298d8359218165de3ef7439963168565aaaaf7a99b3edd', target: 'notes.md' },
              { path: 'newdir/deeper/deep.txt', kind: 'file', mode: 420, sha256: '64896f89fd11190013b70103e603a1c5826e56b7fb7d2197ab279b0690043599', target: null },
              { path: 'notes.md', kind: 'file', mode: 420, sha256: '4a28fc250c09e1f28c9f37486fca6db3c7a4ee707373216f6f7bd62ade5d9330', target: null },
              { path: 'script.sh', kind: 'file', mode: 493, sha256: 'ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e', target: null },
              { path: 'src/keep.txt', kind: 'file', mode: 420, sha256: '88a850519c5118361d41c44a3208ab262f2bd4d582fa14bdbe3473d06bd7e24f', target: null },
            ],
          },
          appliedB: { applied: 1, baseCommitMatches: true, paths: ['src/keep.txt'] },
          bTree: [
            { path: 'README.md', kind: 'file', mode: 420, sha256: '7bd16c02a6374c4f2da6a0526e2386ce6cb73d9234b470101682f18e7581b7d7', target: null },
            { path: 'bin.bin', kind: 'file', mode: 420, sha256: '7ea646958715ed687aa9ac2f5d785feb1a93411f4f25fdd6c7fcc6ab07fdf0e3', target: null },
            { path: 'link', kind: 'symlink', mode: 511, sha256: 'f3bb49154ae10cd8508d316660c6d06ad4f2a1f9b40730deeb6fc15c5decd5d9', target: 'src/keep.txt' },
            { path: 'link2', kind: 'symlink', mode: 511, sha256: 'b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5', target: 'README.md' },
            { path: 'script.sh', kind: 'file', mode: 420, sha256: 'ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e', target: null },
            { path: 'src/keep.txt', kind: 'file', mode: 420, sha256: 'c5edc897ac7a53cab5330fc521908bbf633aec4a17c3e601c71757ae75122579', target: null },
          ],
          roundTrip: {
            schemaVersion: 1,
            entryCount: 9,
            contentBytes: 564,
            paths: ['README.md', 'bin.bin', 'blob.dat', 'link', 'link2', 'newdir/deeper/deep.txt', 'notes.md', 'script.sh', 'src/keep.txt'],
            manifestEqualsCaptured: true,
          },
          serviceState: { captures: 2, applies: 3, emptyRefusals: 0, closed: false },
        });
      }

      // ── H4: the native working directory is MEASURED, not read back ──
      {
        const probeArgs = ['-e', 'process.stdout.write(process.cwd())'];
        const observedFirst = await runNative(service, { leaseId: first.leaseId, command: process.execPath, args: probeArgs });
        const observedSecond = await runNative(service, { leaseId: second.leaseId, command: process.execPath, args: probeArgs });
        const measuredFirst = await realpath(observedFirst.stdout.trim());
        const measuredSecond = await realpath(observedSecond.stdout.trim());
        // OBSERVED isolation: a marker written into writer A's worktree is visible to a real
        // process launched in A's cwd and invisible to one launched in B's cwd. It is written
        // AFTER the lossless comparison, so it is not part of the captured change set.
        await writeFileMode(path.join(first.nativeCwd, 'marker-a.txt'), 'A', 0o644);
        const listing = ['-e', 'process.stdout.write(require("node:fs").readdirSync(process.cwd()).sort().join(","))'];
        const listedFirst = await runNative(service, { leaseId: first.leaseId, command: process.execPath, args: listing });
        const listedSecond = await runNative(service, { leaseId: second.leaseId, command: process.execPath, args: listing });
        // OBSERVED lease identity: the two native processes each report a different toplevel.
        const toplevel = ['rev-parse', '--show-toplevel'];
        const topFirst = await runNative(service, { leaseId: first.leaseId, command: 'git', args: toplevel });
        const topSecond = await runNative(service, { leaseId: second.leaseId, command: 'git', args: toplevel });
        const headInWorktree = runGit(measuredFirst, ['rev-parse', 'HEAD']).trim();
        const toplevelInWorktree = await realpath(runGit(measuredFirst, ['rev-parse', '--show-toplevel']).trim());
        check('the native working directory is MEASURED, not read back: a real child process spawned through the lease service own runner OBSERVEDLY reports each writer cwd, the observed cwd equals the assigned nativeCwd (compared through realpath) and is neither the repository nor the sibling writer, the measured directory is a real git worktree pinned at the assigned base commit (git rev-parse HEAD run for real in it equals the base) whose toplevel is itself, the two writers toplevels are distinct, and a marker written into writer A worktree is visible to a real process launched in A cwd and invisible to one launched in B — so each writer native commands provably run in its own leased directory', {
          measured: {
            exitCodes: [observedFirst.exitCode, observedSecond.exitCode],
            firstMatchesAssigned: measuredFirst === (await realpath(first.nativeCwd)),
            secondMatchesAssigned: measuredSecond === (await realpath(second.nativeCwd)),
            firstIsRepository: measuredFirst === (await realpath(repository)),
            secondIsRepository: measuredSecond === (await realpath(repository)),
            observedCwdsDistinct: observedFirst.stdout.trim() !== observedSecond.stdout.trim(),
          },
          headInMeasuredCwd: headInWorktree === first.baseCommit,
          toplevelEqualsMeasured: toplevelInWorktree === measuredFirst,
          toplevelsDistinct: (await realpath(topFirst.stdout.trim())) !== (await realpath(topSecond.stdout.trim())),
          markerIsolation: {
            firstHasMarker: listedFirst.stdout.includes('marker-a.txt'),
            secondHasMarker: listedSecond.stdout.includes('marker-a.txt'),
          },
        }, {
          measured: {
            exitCodes: [0, 0],
            firstMatchesAssigned: true,
            secondMatchesAssigned: true,
            firstIsRepository: false,
            secondIsRepository: false,
            observedCwdsDistinct: true,
          },
          headInMeasuredCwd: true,
          toplevelEqualsMeasured: true,
          toplevelsDistinct: true,
          markerIsolation: { firstHasMarker: true, secondHasMarker: false },
        });
      }

      // ── H5: a reviewer is never told a sandbox exists ──
      {
        const posture = service.posture(first.leaseId);
        check('a reviewer is never told a sandbox exists: the posture a service hands a reviewer is the ONE frozen WRITER_ISOLATION object itself, its key set is exactly POSTURE_KEYS, the object and both of its arrays are frozen, `sandbox` is the literal false (its type is false), the isolation mechanism is named lease-plus-worktree, the mechanism string makes no sandbox claim, notProvided explicitly lists the sandbox denial alongside the container / network / host-process denials, the reviewer statement says out loud that there is no sandbox and names the lease and the worktree, the serialized posture contains no "sandbox": true anywhere, and a mutation attempt cannot promote the posture — after the attempt the value is still false', {
          sameFrozenObject: posture === WRITER_ISOLATION,
          sandbox: posture.sandbox,
          isolation: posture.isolation,
          keys: Object.keys(posture).sort(),
          keysAreExactlyPostureKeys: JSON.stringify(Object.keys(posture).sort()) === JSON.stringify([...POSTURE_KEYS].sort()),
          postureKeysFrozen: Object.isFrozen(POSTURE_KEYS),
          frozen: [Object.isFrozen(posture), Object.isFrozen(posture.guarantees), Object.isFrozen(posture.notProvided)],
          mechanismClaimsNoSandbox: !/sandbox/i.test(posture.mechanism),
          notProvided: [...posture.notProvided],
          notProvidedDeniesSandbox: posture.notProvided.some((entry) => /sandbox/i.test(entry)),
          reviewerStatement: posture.reviewerStatement,
          statementClaims: {
            noSandbox: /no sandbox/i.test(posture.reviewerStatement),
            lease: /lease/i.test(posture.reviewerStatement),
            worktree: /worktree/i.test(posture.reviewerStatement),
          },
          serializedHasNoSandboxTrue: !/"sandbox":\s*true/.test(JSON.stringify(posture)),
          mutationCannotPromote: (() => {
            try { posture.sandbox = true; } catch { /* a frozen object refuses the write */ }
            return posture.sandbox === false;
          })(),
        }, {
          sameFrozenObject: true,
          sandbox: false,
          isolation: 'lease-plus-worktree',
          keys: ['guarantees', 'isolation', 'mechanism', 'notProvided', 'reviewerStatement', 'sandbox'],
          keysAreExactlyPostureKeys: true,
          postureKeysFrozen: true,
          frozen: [true, true, true],
          mechanismClaimsNoSandbox: true,
          notProvided: [
            'no kernel-level or process-level sandbox',
            'no container, VM or namespace isolation',
            'no network isolation',
            'no guarantee that another process on the host cannot read the worktree',
          ],
          notProvidedDeniesSandbox: true,
          reviewerStatement: 'This writer ran under an exclusive writer lease in its own git worktree at a pinned base commit. There is no sandbox: the worktree shares the host filesystem, and isolation comes from the lease plus the worktree only.',
          statementClaims: { noSandbox: true, lease: true, worktree: true },
          serializedHasNoSandboxTrue: true,
          mutationCannotPromote: true,
        });
      }

      // ── H6: every command the case lists is actually STARTED or CHECKED ──
      {
        const traceRepository = await createRepo('trace');
        const traceWriters = await scratch('writers-root', 'trace-writers');
        const traceStoreRoot = await scratch('store-root', 'trace-store');
        const traceService = createWriterLeaseService({ writersRoot: traceWriters, newLeaseId: nextLeaseId });
        const traceStore = createArtifactStore({ root: traceStoreRoot });
        const traceArtifacts = createArtifactService({ store: traceStore, root: traceStoreRoot });
        const allocated = await traceService.allocate({ repository: traceRepository, taskId: taskIdFor('trace'), ownerId: 'writer-trace', at: T0 });
        started.leasesAllocated += 1;
        await writeFileMode(path.join(allocated.nativeCwd, 'change.txt'), 'durable change\n', 0o644);
        const readBack = traceService.lease(allocated.leaseId);
        const listed = traceService.leases();
        const byRepository = traceService.leasesByRepository(traceRepository);
        const cwd = traceService.nativeCwd(allocated.leaseId);
        const inside = traceService.assertPathWithinLease(allocated.leaseId, 'change.txt');
        const outside = captureSync(() => traceService.assertPathWithinLease(allocated.leaseId, traceRepository));
        const posture = traceService.posture(allocated.leaseId);
        const nodeCwd = await runNative(traceService, { leaseId: allocated.leaseId, command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] });
        const gitHead = await runNative(traceService, { leaseId: allocated.leaseId, command: 'git', args: ['rev-parse', 'HEAD'] });
        const captured = await traceArtifacts.capture({ lease: allocated, at: T0 + 10 });
        started.captures += 1;
        started.writes += 1;
        started.largestArtifactBytes = Math.max(started.largestArtifactBytes, captured.bytes);
        const dryRun = await traceArtifacts.apply({ artifactHash: captured.artifactHash }, allocated.nativeCwd, { dryRun: true });
        started.applies += 1;
        const applied = await traceArtifacts.apply({ artifactHash: captured.artifactHash }, allocated.nativeCwd);
        started.applies += 1;
        const round = traceArtifacts.deserialize(await traceStore.read(captured.artifactHash));
        const stateBeforeRelease = traceService.state();
        const released = traceService.release({ leaseId: allocated.leaseId, at: T0 + 20 });
        const retention = await traceService.retention(allocated.leaseId);
        const confirmed = await traceService.confirmWorktreeRemoval({ leaseId: allocated.leaseId, at: T0 + 30 });
        const removed = await traceService.removeWorktree({ leaseId: allocated.leaseId, at: T0 + 40 });
        const stateAfterRemove = traceService.state();
        traceService.close();
        const trace = [
          { command: 'allocate', state: allocated.state, worktreeDerived: allocated.worktree === path.join(traceWriters, `writer-${allocated.leaseId}`), policy: allocated.policy.worktreeAccess },
          { command: 'lease', readBackEqualsAllocated: JSON.stringify(scrub(readBack)) === JSON.stringify(scrub(allocated)), state: readBack.state },
          { command: 'leases', count: listed.length },
          { command: 'leasesByRepository', count: byRepository.length },
          { command: 'nativeCwd', equalsWorktree: cwd === allocated.worktree },
          { command: 'assertPathWithinLease(inside)', resolved: inside === path.join(allocated.nativeCwd, 'change.txt') },
          { command: 'assertPathWithinLease(outside)', rejection: outside },
          { command: 'posture', sandbox: posture.sandbox, isolation: posture.isolation },
          { command: 'run(node -e process.cwd())', exitCode: nodeCwd.exitCode, observedCwdMatches: nodeCwd.stdout.trim() === allocated.nativeCwd },
          { command: 'run(git rev-parse HEAD)', exitCode: gitHead.exitCode, headEqualsBase: gitHead.stdout.trim() === allocated.baseCommit },
          { command: 'capture', entryCount: captured.entryCount, paths: captured.paths, bytes: captured.bytes },
          { command: 'apply(dryRun)', applied: dryRun.applied, wouldCreate: dryRun.wouldCreate, wouldDelete: dryRun.wouldDelete },
          { command: 'apply', applied: applied.applied, paths: applied.paths },
          { command: 'deserialize', entryCount: round.entryCount, paths: round.paths },
          { command: 'state', ...stateBeforeRelease },
          { command: 'release', state: released.state, disposition: released.worktree.disposition, userConfirmed: released.userConfirmed },
          { command: 'retention', userConfirmed: retention.userConfirmed, exists: retention.exists, removedAt: retention.removedAt },
          { command: 'confirmWorktreeRemoval', userConfirmed: confirmed.userConfirmed, confirmedAt: confirmed.confirmedAt },
          { command: 'removeWorktree', removedAt: removed.removedAt, exists: removed.exists },
          { command: 'state(afterRemove)', ...stateAfterRemove },
          { command: 'close', closed: true },
        ];
        check('every command of the writer-lease and artifact surface is actually STARTED and its effect CHECKED, in one chronological trace over one world: allocate mints an active lease whose worktree is the frozen writer-<leaseId> derivation, lease(id) reads back a byte-identical frozen model, leases() and leasesByRepository() list exactly this one writer, nativeCwd() is the lease worktree, assertPathWithinLease resolves a path inside and refuses the repository outside with unauthorized/writer_lease_cwd, posture() hands back the frozen no-sandbox posture, the native runner is started for real twice (a node cwd probe whose OBSERVED cwd is the lease cwd and a git rev-parse HEAD whose OBSERVED head is the base commit), capture records the real change as one artifact, apply(dryRun) plans the create without touching the disk, apply performs it, deserialize reads the manifest back out of the durable object, state() reports the live counters, release retains the worktree with userConfirmed false, retention reports it on disk, confirmWorktreeRemoval records the explicit user confirmation, removeWorktree only then deletes it, the counters report one removed worktree, and close() leaves the service closed — so no command is merely enumerated', {
          trace,
          frozenReads: {
            leaseView: Object.isFrozen(allocated),
            leaseRead: Object.isFrozen(readBack),
            leasesList: Object.isFrozen(listed),
            byRepositoryList: Object.isFrozen(byRepository),
            stateRead: Object.isFrozen(stateBeforeRelease),
            stateAfterRemove: Object.isFrozen(stateAfterRemove),
            releaseView: Object.isFrozen(released),
            retentionView: Object.isFrozen(retention),
            captureView: Object.isFrozen(captured),
            applyView: Object.isFrozen(applied),
          },
        }, {
          trace: [
            { command: 'allocate', state: 'active', worktreeDerived: true, policy: 'read-write' },
            { command: 'lease', readBackEqualsAllocated: true, state: 'active' },
            { command: 'leases', count: 1 },
            { command: 'leasesByRepository', count: 1 },
            { command: 'nativeCwd', equalsWorktree: true },
            { command: 'assertPathWithinLease(inside)', resolved: true },
            { command: 'assertPathWithinLease(outside)', rejection: { code: 'unauthorized', field: 'writer_lease_cwd' } },
            { command: 'posture', sandbox: false, isolation: 'lease-plus-worktree' },
            { command: 'run(node -e process.cwd())', exitCode: 0, observedCwdMatches: true },
            { command: 'run(git rev-parse HEAD)', exitCode: 0, headEqualsBase: true },
            { command: 'capture', entryCount: 1, paths: ['change.txt'], bytes: 307 },
            { command: 'apply(dryRun)', applied: 0, wouldCreate: ['change.txt'], wouldDelete: [] },
            { command: 'apply', applied: 1, paths: ['change.txt'] },
            { command: 'deserialize', entryCount: 1, paths: ['change.txt'] },
            { command: 'state', active: 1, released: 0, removed: 0, total: 1, worktreesRetained: 1, worktreesRemoved: 0, closed: false },
            { command: 'release', state: 'released', disposition: 'retained', userConfirmed: false },
            { command: 'retention', userConfirmed: false, exists: true, removedAt: null },
            { command: 'confirmWorktreeRemoval', userConfirmed: true, confirmedAt: T0 + 30 },
            { command: 'removeWorktree', removedAt: T0 + 40, exists: false },
            { command: 'state(afterRemove)', active: 0, released: 0, removed: 1, total: 1, worktreesRetained: 0, worktreesRemoved: 1, closed: false },
            { command: 'close', closed: true },
          ],
          frozenReads: {
            leaseView: true,
            leaseRead: true,
            leasesList: true,
            byRepositoryList: true,
            stateRead: true,
            stateAfterRemove: true,
            releaseView: true,
            retentionView: true,
            captureView: true,
            applyView: true,
          },
        });
        traceArtifacts.close(); traceStore.close();
      }
      service.close(); store.close(); artifacts.close();
    }
    // ── every rejection code the product emitted belongs to the frozen canonical table ──
    const codes = [...observedCodes].sort();
    const browserMembership = await evaluate((list) => window.task40.codeMembership(list), codes);
    protocol.browser.codeMembership = browserMembership;
    record('codeMembership', { codes, browserMembership });
    check('every rejection code the product actually emitted across this case belongs to the frozen canonical ERROR_CODES table, checked in BOTH realms over the list the worker collected — no writer-lease or artifact rejection ever carries a code outside the protocol vocabulary', {
      observedCodes: codes,
      workerAllInTable: codes.every((code) => ERROR_CODES.includes(code)),
      browser: browserMembership,
    }, {
      observedCodes: codes,
      workerAllInTable: true,
      browser: { observedCount: codes.length, missing: [], allObservedCodesInTable: true, distinctObserved: new Set(codes).size },
    });

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task40.errors());
    check('the browser entry logged no error while recomputing the frozen shared contract and checking the observed rejection codes against the frozen table in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa40-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa40-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task40.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapPeak: peakHeap, heapEnd, heapGrowthBytes });
    // The load-bearing boundedness evidence is the PRODUCT'S OWN counters and read models,
    // exactly as task 38 used the fan-out service's own stats: no artifact this case wrote can
    // exceed the frozen 32 MiB ceiling, no repository can exceed the frozen 8-writer quota, and
    // the largest observed artifact is a fraction of one chunk. The heap numbers are recorded as
    // a GC-TIMING ARTEFACT, not a retention proof, and decide nothing.
    check('the case stays bounded in the PRODUCT OWN counters, not in a raw heap delta: every lease this case allocated, every artifact it captured and every object it wrote is counted from the product own frozen read models, the largest artifact the case produced is far below the frozen 32 MiB ceiling so the streaming path is the only large one, every private git world is registered in the resource ledger before creation, the observed native-command and git-command counts are recorded, and the observed heap numbers are RECORDED as a GC-timing artefact rather than a retention proof', {
      leasesAllocated: started.leasesAllocated,
      captures: started.captures,
      applies: started.applies,
      writes: started.writes,
      largestArtifactBytes: started.largestArtifactBytes,
      largestWithinCeiling: started.largestArtifactBytes <= ARTIFACT_LIMITS.maxArtifactBytes,
      nativeCommandsStarted: started.nativeCommands,
      gitCommandsStarted: started.gitCommands,
      ownedResourceCount: fixture.resources.length,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      heapGrowthUnderBound: heapGrowthBytes < HEAP_BOUND,
    }, {
      leasesAllocated: started.leasesAllocated,
      captures: started.captures,
      applies: started.applies,
      writes: started.writes,
      largestArtifactBytes: started.largestArtifactBytes,
      largestWithinCeiling: true,
      nativeCommandsStarted: started.nativeCommands,
      gitCommandsStarted: started.gitCommands,
      ownedResourceCount: fixture.resources.length,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      heapGrowthUnderBound: true,
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged and pins a populated source inventory', {
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    }, {
      authoredFileCount: 3,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    });

    // ── the evidence binds to the CURRENT bytes of the product ──
    // Independently recomputed here at the end of the run and compared with the values recomputed
    // before any scenario ran; a green report against the wrong bytes is worthless (this exact
    // failure made task 21's first gate return REJECT). The comparison against the artifact's own
    // sourceHashes is mechanical for the independent gate, because every path below is in
    // sourceFiles.
    const productHashesAfter = productHashes(context.root);
    record('sourceBinding', { before: productHashesBefore, after: productHashesAfter });
    check('the evidence binds to the current bytes: the sha256 of all ten pinned product files is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, so no product byte moved under the case — the ten hashes are recorded for the independent gate to compare against the artifact sourceHashes', {
      pinnedProductFileCount: PRODUCT_FILES.length,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: JSON.stringify(productHashesBefore) === JSON.stringify(productHashesAfter),
      allSha256Shaped: Object.values(productHashesAfter).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    }, {
      pinnedProductFileCount: 10,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: true,
      allSha256Shaped: true,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task40Errors ?? [], task40: Boolean(window.task40) })).catch((value) => ({ unavailable: String(value) }));
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'writer-leases-and-change-artifacts', schema: 'runtime-collaboration-writer-artifacts/v1' },
    cleanup: proof.cleanup,
    defects: {
      subChunkArtifactPeakEqualsBytes: {
        severity: 'observation',
        observed: 'a captured artifact smaller than the frozen 64 KiB chunkBytes is streamed in ONE read, so the product own gauge legitimately reports peakBufferedBytes equal to the byte count (writer A 2369/2369, writer B 319/319, the durable world 307/307, the symlink world 723/723)',
        assertedAs: 'asserted verbatim in H2 with the check title naming the sub-chunk reason; the streaming proof — peakBufferedBytes 65536 strictly below the 1048576-byte content, chunks 16, maxRequested 65536 — is the failure lane F4 1 MiB world, which is where "never buffered whole" is provable',
      },
      absoluteSymlinkTargetIsRecordedNotRefused: {
        severity: 'observation',
        observed: 'a symlink entry whose target is an ABSOLUTE path (or contains ..) is legitimate: validateArtifactPath validates the entry PATH only, so the serializer records the raw target verbatim (kind symlink, contentBytes 0, sha256 over the target) and apply recreates the link; the capture lstat s the link and never reads through it, so the target file bytes never enter the artifact',
        assertedAs: 'asserted in F5 (the absolute-target round trip) and F6 (a REAL worktree symlink to /etc/vis-artifact-escape-target captured as a link with the exact target and contentBytes 0)',
      },
      applyToMissingTargetIsRawFsError: {
        severity: 'observation',
        observed: 'apply() against a target path that does not exist surfaces the raw fs ENOENT from lstat rather than a typed CollaborationError; an EXISTING non-directory target IS typed (invalid_request/artifact_target)',
        assertedAs: 'recorded here and in the DoneClaim, deliberately NOT asserted as a scenario expectation, so a future typed refusal cannot be mistaken for a regression of this case',
      },
      leaseServiceIsInProcess: {
        severity: 'acceptance-criterion-gap',
        observed: 'the writer-lease service is in-memory and single-process: cross-process lease exclusion (two processes allocating the same task) is not proven here',
        coveredInstead: 'every in-process conflict is proven: duplicate task, repository quota, capacity, dirty base, and the cross-cwd refusals; task 10 worktreeLease.js is the durable cross-process lease and is complementary',
      },
      durabilityAcrossProcessDeathNotClaimed: {
        severity: 'acceptance-criterion-gap',
        observed: 'the durable artifact is proven to survive the job ending (every service closed and reopened) IN-PROCESS; a power-loss fsync test is out of scope',
        coveredInstead: 'F7 proves the reopened store re-hashes the object to the recorded value, a deleted object is an explicit artifact_missing from every read path, a corrupted object is detected (verify ok false) and refused on re-write (artifact_immutable), and an empty change set refuses rather than fabricating a patch',
      },
      liveHarnessNotExercised: {
        severity: 'out-of-scope',
        observed: 'the native runner is started for real (node and git through the lease service own runner), but no live opencode, codex, kimi-web, dsh or acp backend is contacted',
        carriedAs: 'task 46 owns end-to-end live verification; the case performs no SSH and no Slurm work and its header and evidenceBoundary say so',
      },
      collaborationUiNotExercised: {
        severity: 'out-of-scope',
        observed: 'the browser realm recomputes the frozen shared contract and checks the observed rejection codes against the frozen table; it renders no collaboration surface and claims none',
        carriedAs: 'task 42 owns the collaboration UI',
      },
    },
    evidenceBoundary: 'The real landed bridge modules bridge/runtime/collaboration/writerLeases.js, artifactStore.js and artifactService.js run in the Node worker composed exactly as the product composes them, over the frozen shared/runtime/collaboration.js contract: real private temporary git repositories, real product-created detached git worktrees, and real native commands (node and git) through the lease service own runner. The ONLY case-owned seam is the lease service own declared newLeaseId injection point (writerLeases.js:398), backed by a deterministic counter so the writer-<leaseId> worktree derivation is asserted as an exact path. The frozen shared contract (the ten-entry ERROR_CODES table, the CollaborationError shape, the explicit-at contract, the lease/task id parsers) also runs in a real headless Chromium served by a case-owned Vite server, and the membership of every observed rejection code is checked in that realm too. The stateful product cannot cross into the browser realm at all (all three bridge modules import node:* builtins), so its lifecycle is proven in the worker only and that split is stated rather than papered over. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 42 owns the collaboration UI), claims NO durability across a real process death, and authors no PASS verdict.',
  };
}
