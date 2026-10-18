// Task 43 registered QA case — 完成全链路与故障注入回归场景 (plan task 43).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt, re-hashes every pinned source and
// parses the written result. This module also ASSERTS the task >5 registration shape itself: a task
// above 5 without a case module is refused by the runner, so loading this module is part of the
// contract.
//
// This case is the registered wrapper around task 43's two LANDED harnesses plus its own
// re-derivation of the four acceptance-adjacent requirements:
//   * scripts/qa/runtime-v090-system.mjs  runSystem(context)  — the happy lane (--case happy):
//     5 sources from the legacy store -> the unified tree -> two participants -> fan-out/team ->
//     artifact review -> restart continuation, driven over the REAL landed modules in the Node
//     worker and the REAL unified session tree in a real headless Chromium over a case-owned Vite
//     server seeded from the legacy store the worker read.
//   * scripts/qa/runtime-v090-faults.mjs  runFaults(context)  — the failure lane (--case failure):
//     kill store / native / manager, break UI / SSH / relay, slow consumer, source partial,
//     sameIDacrosshosts, legacyimporttargetswitch, each checked for no data loss and no false
//     success.
// Both are self-contained by design (task 43's grant is exactly two scripts plus the integration
// test and the browser entry), so each owns its own private root, its own resource ledger with
// register-before-create and a teardown receipt, its own private temporary git repositories and
// its own browser/Vite world. This module does NOT reach into either of them.
//
// THE FOUR ACCEPTANCE-ADJACENT REQUIREMENTS, each re-derived here with a NAMED check and OBSERVED
// values by driving the REAL modules (never copied from the landed integration test, which drives
// the same product through Vitest):
//   1. 旧功能 mapping 每 row 有 observed scenario — C1 drives the real system43-mapping.mjs: the
//      integrity assertion over the real 8 rows and 22-scenario catalog, the per-lane row sets, the
//      refusal of a synthetic row with an EMPTY scenario (/missing scenario/), the refusal of a row
//      naming a scenario OUTSIDE the catalog (/outside the catalog/), the same refusal for a
//      negative scenario outside the catalog, and that with an EMPTY observed set ALL 7 system/both
//      rows are reported missing (and the 5 faults/both rows for that lane).
//   2. migration hash 不变 — C2 writes the REAL legacy store (the history content derived from the
//      INDEPENDENT seed090 oracle, the same one source the landed integration test reads; the
//      localStorage literal is this case's own input and is bound by its sha256), walks it through
//      the REAL shared/runtime/migration/legacyExport.js scan + paging, and observes the sha256 of
//      every legacy file BEFORE and AFTER the full walk, the export revision across two opens and
//      every page, and that the local-only credential is excluded with its secret in no page.
//   3. source failure 不拖整体 — C3 drives the REAL bridge/runtime/discoveryScheduler.js with all
//      five sources demanded: codex and dsh reject source_unavailable/native_timeout, opencode, acp
//      and kimi-web still settle with their own counts, the queue drains, and a LATER demand on a
//      healthy source still runs.
//   4. 所有 IS 用户链路及 negative case 结果有 assertion/evidence — C5 composes the IS_USER_PATHS
//      rows and the FAULT_SCENARIOS negative cases against the scenario catalog AND against the
//      scenario set the lane that owns them really observed, so no row is satisfied by a checkbox.
//
// C4 is the mechanical proof of the load-bearing risk the implementation lane disclosed ("the case
// module must merge BOTH harnesses' sourceFiles arrays into its own registration, otherwise the
// runner's source-hash binding will not cover the harness files"): it walks the static import /
// require closure of this module, the browser entry and both harnesses, and asserts that every
// file the run executes is either registered in sourceFiles or auto-inventoried by the runner.
//
// The controlled boundaries are stated rather than papered over:
//   * this module's own checks are WORKER-ONLY. The browser leg (the real useRuntimeSessionTree
//     over the real runtime state/client/connection and the real SessionTree.vue in a real headless
//     Chromium over a case-owned Vite server) is driven by the system and faults harnesses; this
//     module starts no Vite server, no Chromium and no process of its own, so its fixture owns no
//     port and its teardown has no port-rebind step.
//   * the stateful collaboration services import node:crypto / node:fs / node:path /
//     node:child_process at module scope and cannot execute in a browser realm, so those legs are
//     driven in the worker by the harnesses — the split tasks 37-41 disclosed. The TypeScript
//     migration modules (browserSourcePort.ts, legacyBinding.ts) are loaded by the system harness
//     through the case-owned Vite server's ssrLoadModule, i.e. the same files, transformed once,
//     never copied.
//   * no container provides RUNTIME_COLLABORATION_STATE_KEY yet and App.vue integration is a later
//     task's, so the QA page IS the container and NO running-app rendering is claimed.
//   * no live SSH and no live Slurm verification is performed (task 46 owns that lane); the faults
//     lane's host-key and relay-binding refusals are the product's own TYPED refusals at the
//     transport boundary, not a live network break.
//   * no Electron or packaged-artifact run (task 45 owns it).
//   * this case performs NO live SSH / Slurm check, runs NO product test suite, edits NO product,
//     test, runner, harness or other task's case file, and authors NO PASS verdict.
//
// RED IS A VALID, REPORTABLE OUTCOME: every expected value below was derived by driving the real
// modules in throwaway probes BEFORE it was written, and a RED run is reported as-is — the QA lanes
// are forbidden from editing this case or the product to force a pass.
//
// Process discipline: this module starts NO child process and runs NO git command, so there is no
// cwd to get wrong here (the task-24 lesson); every git / spawn / exec call in the run belongs to a
// harness that names its cwd explicitly, and every repository in the run is a private temporary one
// under that harness's own root — NEVER the QA worktree. Every owned resource of this module is
// registered in the fixture ledger BEFORE it is created and released in teardown with a receipt.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture } from './task-43-fixture.mjs';
import { sourceFiles as FAULTS_SOURCE_FILES, runFaults } from '../runtime-v090-faults.mjs';
import { sourceFiles as SYSTEM_SOURCE_FILES, runSystem } from '../runtime-v090-system.mjs';
import {
  FAULT_SCENARIOS,
  IS_USER_PATHS,
  OLD_FEATURE_MAPPING,
  SCENARIO_CATALOG,
  SYSTEM_SCENARIOS,
  assertMappingComplete,
  assertMappingIntegrity,
  mappingRowsWithoutScenario,
} from '../../../app/dev/runtime-v090/system43-mapping.mjs';

const require_ = createRequire(import.meta.url);
const legacyExport = require_('../../../shared/runtime/migration/legacyExport.js');
const { createDiscoveryScheduler } = require_('../../../bridge/runtime/discoveryScheduler.js');
const { StoreError } = require_('../../../bridge/runtime/storage/storeProtocol.js');
const oracle = require_('../../../app/dev/runtime-v090/fixtures/inventory.mjs');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/u;
const TASK = 43;

/** The five sources in the seed090 oracle's own order — the ONE SOURCE, not a second hard-coded copy. */
const SOURCES = oracle.input.sources;
const HARNESS_INSTANCE = Object.fromEntries(SOURCES.map((source, index) => [source, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const ENV_A = '11111111-1111-4111-8111-111111111111';

/* ------------------------------------------------------------------ the legacy store seed */

/**
 * One history scope PER SOURCE, exactly as the landed integration test derives it: the same
 * `system43-scope-<source>` derivation, so the same native id on two sources is two different
 * legacy keys. The record CONTENT is the oracle's own wire shape for the same ordinal — the
 * independent ground truth, read and never re-implemented.
 */
const scopeFor = (source) => createHash('sha256').update(`system43-scope-${source}`).digest('hex').slice(0, 32);
const namespaceFor = (source) => `backend-history-v1:${scopeFor(source)}`;
const historyKeyFor = (source, nativeSessionId) => `opencode.state.backendHistory.v1.${scopeFor(source)}.${nativeSessionId}`;
/** One legacy history record per source for native-0 and native-1: ten records, five sources. */
const LEGACY_HISTORY = Object.freeze(SOURCES.flatMap((source, sourceIndex) => [0, 1].map((round) => {
  const ordinal = sourceIndex + round * SOURCES.length;
  const summary = oracle.summaryAt(ordinal);
  return Object.freeze({
    key: historyKeyFor(source, summary.nativeSessionId),
    namespace: namespaceFor(source),
    content: JSON.stringify(oracle.wireAt(summary)),
    authority: 'backend-history',
  });
})));
/**
 * This case's OWN localStorage input: five real legacy keys, the fifth a local-only credential the
 * export must EXCLUDE and never page. The literal is pinned by its sha256 (LEGACY_STORE_HASHES), so
 * this case's copy and the landed integration test's copy cannot drift apart silently.
 */
const LEGACY_LOCAL = Object.freeze({
  'opencode.global.dat:model': '"grok-code"',
  'opencode.settings.disabledModels.v1': '["gpt-4o-mini"]',
  'vis:kimi-web:last-permission-mode': '"default"',
  'vis.codex.pins.v1': '["native-0"]',
  'opencode.credentials.v1': '{"type":"api","key":"sk-legacy-secret-value"}',
});
const LEGACY_FILES = Object.freeze(['localStorage.json', 'history.json']);
const LEGACY_SECRET = 'sk-legacy-secret-value';
/**
 * The sha256 of the two real legacy store files this case writes, DERIVED by driving the real walk
 * (see C2). These pin the seed bytes: a change to the oracle's wire shape or to the localStorage
 * literal above moves them, and C2 goes RED rather than silently re-basing.
 */
const LEGACY_STORE_HASHES = Object.freeze({
  'localStorage.json': 'cbd845c0223e0cd1909fdeef641e81126e12f2e2453aef82d38ac814ba3236fa',
  'history.json': '9b451f40628291ffae84fe694dea778de1e871e8782af3a78fad0e8ac8351f55',
});

const writeLegacyStore = (directory) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'localStorage.json'), `${JSON.stringify(LEGACY_LOCAL, null, 2)}\n`);
  writeFileSync(path.join(directory, 'history.json'), `${JSON.stringify(LEGACY_HISTORY, null, 2)}\n`);
};
const legacyStoreDigest = (directory) => Object.fromEntries(LEGACY_FILES.map((name) => [name, sha256(readFileSync(path.join(directory, name)))]));
/** The read-only legacy source: it READS the two real files and never writes to them. */
const legacySourceOf = (directory) => async function* source() {
  const local = JSON.parse(readFileSync(path.join(directory, 'localStorage.json'), 'utf8'));
  for (const [key, content] of Object.entries(local)) yield { key, source: 'localStorage', namespace: 'unattached-legacy-local', content, end: true, authority: 'unattached' };
  for (const entry of JSON.parse(readFileSync(path.join(directory, 'history.json'), 'utf8'))) yield { key: entry.key, source: 'renderer-storage.json.history', namespace: entry.namespace, content: entry.content, end: true, authority: entry.authority };
};

/* ------------------------------------------------------------------ the merged registration */

/**
 * THE MERGE the implementation lane named as the load-bearing risk: BOTH harnesses' sourceFiles
 * arrays, plus the files the run executes that NEITHER harness registers, plus this case's own
 * authored files. The runner unions this with its own inventory (every file under shared/runtime,
 * every runtime-v090 file under scripts/qa and app/dev/runtime-v090, package.json and the
 * app/runtime*.test.ts files), so the sha256 binding covers every executed byte. C4 asserts that
 * mechanically instead of merely claiming it.
 *
 * The additions beyond the two harnesses' arrays, each derived by walking the real import graph:
 *   * the worker realm's own require closure the harnesses perform but do not register — the store
 *     protocol / worker trio, the coordinator's acceptance+attempt+taskGraph trio, the writer
 *     lease's process tree, the integration runner's bounded output and the import service's
 *     manifest;
 *   * the browser realm's own import closure of app/dev/runtime-v090/task43.ts — the runtime state
 *     and its connection/URL/cache/selection modules, the tree's Dropdown / DiscoveryStatus /
 *     HarnessBadge components and its pin / session-tree types;
 *   * the closure of the two TypeScript modules the system harness loads through the case-owned
 *     Vite server's ssrLoadModule (browserSourcePort.ts, legacyBinding.ts);
 *   * the case-owned Vite alias target both harnesses configure (task-35-browser-shim.mjs).
 */
export const sourceFiles = [...new Set([
  ...SYSTEM_SOURCE_FILES,
  ...FAULTS_SOURCE_FILES,
  // the worker realm's transitive require closure the harnesses drive without registering
  'bridge/runtime/storage/storeProtocol.js',
  'bridge/runtime/storage/localFilesystem.js',
  'bridge/runtime/storage/schema.js',
  'bridge/runtime/storage/storeQueries.js',
  'bridge/runtime/collaboration/acceptanceService.js',
  'bridge/runtime/collaboration/attemptService.js',
  'bridge/runtime/collaboration/taskGraph.js',
  'bridge/processTree.js',
  'bridge/windowsProcessTree.js',
  'bridge/boundedOutput.js',
  'bridge/runtime/migration/manifest.js',
  // the browser realm's import closure of the case-owned entry app/dev/runtime-v090/task43.ts
  'app/runtime/state.ts',
  'app/runtime/connectionProfile.ts',
  'app/runtime/connectionUrl.ts',
  'app/runtime/entityCache.ts',
  'app/runtime/selectionScope.ts',
  'app/components/Dropdown.vue',
  'app/components/runtime/DiscoveryStatus.vue',
  'app/components/runtime/HarnessBadge.vue',
  'app/types/pin.ts',
  'app/types/session-tree.ts',
  // the closure of the two TypeScript modules the system harness ssrLoadModules
  'app/runtime/draftStore.ts',
  'app/runtime/migration/draftChunks.ts',
  'app/runtime/migration/legacyBrowserSource.ts',
  'app/runtime/migration/legacyExport.ts',
  'app/runtime/migration/legacyInventory.ts',
  'app/runtime/migration/sourceArchive.ts',
  'app/runtime/migration/writerFreeze.ts',
  'app/utils/storageKeys.ts',
  // the case-owned Vite alias target both harnesses configure
  'app/dev/runtime-v090/task-35-browser-shim.mjs',
  // this case's own authored files (the browser entry is already registered by both harnesses)
  'scripts/qa/runtime-v090-cases/task-43.mjs',
  'scripts/qa/runtime-v090-cases/task-43-fixture.mjs',
])];

/** The files this case drives itself and whose bytes the evidence must bind to. */
const OWNED_FILES = Object.freeze([
  'scripts/qa/runtime-v090-cases/task-43.mjs',
  'scripts/qa/runtime-v090-cases/task-43-fixture.mjs',
  'app/dev/runtime-v090/task43.ts',
]);

/* ------------------------------------------------------------------ the static import walk */

const WALK_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue', '.json', '.d.ts'];
const WALK_SEEDS = Object.freeze([
  'scripts/qa/runtime-v090-cases/task-43.mjs',
  'scripts/qa/runtime-v090-cases/task-43-fixture.mjs',
  'scripts/qa/runtime-v090-system.mjs',
  'scripts/qa/runtime-v090-faults.mjs',
  'app/dev/runtime-v090/task43.ts',
  'app/runtime/migration/browserSourcePort.ts',
  'app/runtime/migration/legacyBinding.ts',
]);
/**
 * What the runner's own inventory() already covers, so a file there needs no registration here:
 * every file under shared/runtime, every path containing 'runtime-v090' (which is every file under
 * scripts/qa and app/dev/runtime-v090, because the directory name carries it), package.json and
 * the app/runtime*.test.ts files.
 */
const autoInventoried = (file) => file.startsWith('shared/runtime/') || file.includes('runtime-v090') || /^app\/runtime.*\.test\.ts$/.test(file) || file === 'package.json';
/**
 * The static import / require closure of the seeds. TEXT-based by construction: a specifier built
 * at runtime is invisible to it, which is why the one dynamically-imported file the run loads from
 * OUTSIDE the worktree (the omowright browser skill both harnesses import) is declared explicitly
 * in C4 rather than discovered here.
 */
function walkExecutedFiles(root) {
  const seen = new Set();
  const queue = [...WALK_SEEDS];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    const specifiers = [
      ...[...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]),
      ...[...text.matchAll(/import\s+'([^']+)'/g)].map((match) => match[1]),
      ...[...text.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]),
      ...[...text.matchAll(/require_?\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const base = path.resolve(path.dirname(path.join(root, file)), specifier);
      for (const extension of WALK_EXTENSIONS) {
        const candidate = `${base}${extension}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          const relative = path.relative(root, candidate);
          if (!seen.has(relative)) queue.push(relative);
          break;
        }
      }
    }
  }
  return seen;
}

/* ------------------------------------------------------------------ the case */

export async function run(context) {
  // A fixed umask makes every written byte deterministic regardless of the runner's ambient umask.
  process.umask(0o022);
  const evidenceRoot = context.evidenceRoot ?? path.join(context.root, '.omo/evidence/vis-v090/task-43');
  const evidenceDir = path.join(evidenceRoot, 'cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const proof = { task: TASK, case: context.case, runDir, checks, observations };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => JSON.parse(JSON.stringify(value));
  const check = (name, observed, expected, surface) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface, assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const registeredBefore = sourceSnapshot(context.root, sourceFiles);
  const ownedBefore = sourceSnapshot(context.root, OWNED_FILES);
  // Which lane this invocation drives: 'system' for --case happy, 'faults' for --case failure.
  const laneId = context.case === 'happy' ? 'system' : 'faults';
  const capture = (run) => { try { run(); return { threw: false, message: null }; } catch (error) { return { threw: true, message: String(error?.message ?? error) }; } };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // C4: the source-hash binding covers every file the run executes (the disclosed load-bearing
    // risk, asserted mechanically rather than claimed).
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const executed = walkExecutedFiles(context.root);
    const registered = new Set(sourceFiles);
    const uncovered = [...executed].filter((file) => !registered.has(file) && !autoInventoried(file)).sort();
    const autoInventoriedExecuted = [...executed].filter((file) => !registered.has(file) && autoInventoried(file)).sort();
    check('the merged registration covers every file the run executes: the static import and require closure of this case module, its fixture, the browser entry, both harnesses and the two ssrLoadModule-ed migration modules is walked, and every executed file is either registered in sourceFiles or auto-inventoried by the runner, so the sha256 binding cannot miss an executed byte', {
      executedFileCount: executed.size,
      registeredCount: registered.size,
      executedButNotRegistered: uncovered,
      executedAndAutoInventoriedCount: autoInventoriedExecuted.length,
      harnessSystemRegisteredCount: SYSTEM_SOURCE_FILES.length,
      harnessFaultsRegisteredCount: FAULTS_SOURCE_FILES.length,
      browserEntryRegistered: registered.has('app/dev/runtime-v090/task43.ts'),
      bothHarnessesRegistered: registered.has('scripts/qa/runtime-v090-system.mjs') && registered.has('scripts/qa/runtime-v090-faults.mjs'),
      thisCaseRegistered: registered.has('scripts/qa/runtime-v090-cases/task-43.mjs') && registered.has('scripts/qa/runtime-v090-cases/task-43-fixture.mjs'),
      externalExecutedFiles: ['the omowright browser skill both harnesses import dynamically from outside the worktree (/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs), which the runner cannot pin and which this walk cannot see because its specifier is a variable'],
    }, {
      executedFileCount: executed.size,
      registeredCount: registered.size,
      executedButNotRegistered: [],
      executedAndAutoInventoriedCount: autoInventoriedExecuted.length,
      harnessSystemRegisteredCount: SYSTEM_SOURCE_FILES.length,
      harnessFaultsRegisteredCount: FAULTS_SOURCE_FILES.length,
      browserEntryRegistered: true,
      bothHarnessesRegistered: true,
      thisCaseRegistered: true,
      externalExecutedFiles: ['the omowright browser skill both harnesses import dynamically from outside the worktree (/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs), which the runner cannot pin and which this walk cannot see because its specifier is a variable'],
    }, 'the static import/require walk over the case module, its fixture, the browser entry, both landed harnesses and the two migration modules the system harness loads through the case-owned Vite server, compared against the merged sourceFiles array and the runner own inventory rule');

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // C1: requirement 1 — every old-feature mapping row carries an observed scenario, and the
    // three refusals (empty scenario, scenario outside the catalog, negative scenario outside the
    // catalog), plus the non-vacuity proof that an empty observed set reports every row missing.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const catalogIds = new Set(SCENARIO_CATALOG.map((scenario) => scenario.id));
    const catalogById = new Map(SCENARIO_CATALOG.map((scenario) => [scenario.id, scenario]));
    const syntheticRow = (oldFeature, scenario, negativeScenario) => ({
      id: 'GAP-9', gap: 'GAP-9', is: 'IS-9', lane: 'system', oldFeature, newSurface: 'refused by the integrity assertion', scenario,
      ...(negativeScenario === undefined ? {} : { negativeScenario }),
    });
    const refusals = {
      unmodified: capture(() => assertMappingIntegrity()),
      emptyScenario: capture(() => assertMappingIntegrity([...OLD_FEATURE_MAPPING, syntheticRow('a synthetic row that names no scenario at all', '')])),
      outsideCatalog: capture(() => assertMappingIntegrity([...OLD_FEATURE_MAPPING, syntheticRow('a synthetic row naming a scenario outside the catalog', 'SYS-99-not-a-scenario')])),
      negativeOutsideCatalog: capture(() => assertMappingIntegrity([...OLD_FEATURE_MAPPING, syntheticRow('a synthetic row naming a negative scenario outside the catalog', 'SYS-01-legacy-store-import', 'FLT-99-not-a-scenario')])),
    };
    const emptySystemRows = mappingRowsWithoutScenario(OLD_FEATURE_MAPPING, new Set(), 'system');
    const emptyFaultsRows = mappingRowsWithoutScenario(OLD_FEATURE_MAPPING, new Set(), 'faults');
    const fullCatalog = new Set(catalogIds);
    record('mappingIntegrity', { integrity: assertMappingIntegrity(), refusals });
    check('every old-feature mapping row carries an observed scenario: the real mapping integrity assertion passes over the real 8 rows and 22-scenario catalog, every row scenario (and every declared negative scenario) is a catalog member, a synthetic row with an EMPTY scenario is refused /missing scenario/, a row naming a scenario OUTSIDE the catalog is refused /outside the catalog/ (and so is a negative scenario), and with an EMPTY observed set every system/both row (7) and every faults/both row (5) is reported missing — so the completeness check cannot be satisfied by a checkbox', {
      rows: OLD_FEATURE_MAPPING.length,
      catalogScenarios: SCENARIO_CATALOG.length,
      systemScenarios: SYSTEM_SCENARIOS.length,
      faultScenarios: FAULT_SCENARIOS.length,
      isUserPaths: IS_USER_PATHS.length,
      integrity: assertMappingIntegrity(),
      everyRowScenarioInCatalog: OLD_FEATURE_MAPPING.every((row) => catalogIds.has(row.scenario)),
      everyRowNegativeScenarioInCatalog: OLD_FEATURE_MAPPING.every((row) => row.negativeScenario === undefined || catalogIds.has(row.negativeScenario)),
      systemAndBothRowIds: OLD_FEATURE_MAPPING.filter((row) => row.lane === 'system' || row.lane === 'both').map((row) => row.id),
      faultsAndBothRowIds: OLD_FEATURE_MAPPING.filter((row) => row.lane === 'faults' || row.lane === 'both').map((row) => row.id),
      emptyObservedSystemMissingIds: emptySystemRows.map((row) => row.id),
      emptyObservedSystemMissingCount: emptySystemRows.length,
      emptyObservedSystemRequired: emptySystemRows.map((row) => row.required),
      emptyObservedFaultsMissingIds: emptyFaultsRows.map((row) => row.id),
      emptyObservedFaultsMissingCount: emptyFaultsRows.length,
      everyEmptyMissingRowNamesItsGap: emptySystemRows.every((row) => row.missing.length > 0 && row.required.length > 0),
      refusals: {
        unmodifiedThrew: refusals.unmodified.threw,
        emptyScenarioThrew: refusals.emptyScenario.threw,
        emptyScenarioMessage: refusals.emptyScenario.message,
        emptyScenarioMatches: /missing scenario/.test(refusals.emptyScenario.message ?? ''),
        outsideCatalogThrew: refusals.outsideCatalog.threw,
        outsideCatalogMessage: refusals.outsideCatalog.message,
        outsideCatalogMatches: /outside the catalog/.test(refusals.outsideCatalog.message ?? ''),
        negativeOutsideCatalogThrew: refusals.negativeOutsideCatalog.threw,
        negativeOutsideCatalogMessage: refusals.negativeOutsideCatalog.message,
        negativeOutsideCatalogMatches: /outside the catalog/.test(refusals.negativeOutsideCatalog.message ?? ''),
      },
      completeOverFullCatalogSystem: assertMappingComplete(OLD_FEATURE_MAPPING, fullCatalog, 'system'),
      completeOverFullCatalogFaults: assertMappingComplete(OLD_FEATURE_MAPPING, fullCatalog, 'faults'),
    }, {
      rows: 8,
      catalogScenarios: 22,
      systemScenarios: 12,
      faultScenarios: 10,
      isUserPaths: 8,
      integrity: { rows: 8, catalog: 22 },
      everyRowScenarioInCatalog: true,
      everyRowNegativeScenarioInCatalog: true,
      systemAndBothRowIds: ['GAP-1', 'GAP-2', 'GAP-3', 'GAP-4', 'GAP-6', 'GAP-7', 'GAP-8'],
      faultsAndBothRowIds: ['GAP-2', 'GAP-3', 'GAP-4', 'GAP-5', 'GAP-8'],
      emptyObservedSystemMissingIds: ['GAP-1', 'GAP-2', 'GAP-3', 'GAP-4', 'GAP-6', 'GAP-7', 'GAP-8'],
      emptyObservedSystemMissingCount: 7,
      emptyObservedSystemRequired: [['SYS-02-five-source-unified-index'], ['SYS-10-source-failure-isolation'], ['SYS-04-sessionref-identity'], ['SYS-01-legacy-store-import'], ['SYS-05-thread-two-participants'], ['SYS-08-artifact-integration'], ['SYS-11-bounded-paging']],
      emptyObservedFaultsMissingIds: ['GAP-2', 'GAP-3', 'GAP-4', 'GAP-5', 'GAP-8'],
      emptyObservedFaultsMissingCount: 5,
      everyEmptyMissingRowNamesItsGap: true,
      refusals: {
        unmodifiedThrew: false,
        emptyScenarioThrew: true,
        emptyScenarioMessage: refusals.emptyScenario.message,
        emptyScenarioMatches: true,
        outsideCatalogThrew: true,
        outsideCatalogMessage: refusals.outsideCatalog.message,
        outsideCatalogMatches: true,
        negativeOutsideCatalogThrew: true,
        negativeOutsideCatalogMessage: refusals.negativeOutsideCatalog.message,
        negativeOutsideCatalogMatches: true,
      },
      completeOverFullCatalogSystem: { rows: 8, catalog: 22, lane: 'system', observed: [...fullCatalog].sort() },
      completeOverFullCatalogFaults: { rows: 8, catalog: 22, lane: 'faults', observed: [...fullCatalog].sort() },
    }, 'the real app/dev/runtime-v090/system43-mapping.mjs assertMappingIntegrity / mappingRowsWithoutScenario / assertMappingComplete driven over the real 8-row mapping and 22-scenario catalog, including three synthetic refusals');

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // C2: requirement 2 — the legacy import leaves the migration hash unchanged. The store is
    // written once, then the REAL export scan + paging walks it; the sha256 of every legacy file is
    // read BEFORE and AFTER the walk, the revision is compared across two opens and every page,
    // and the local-only credential is excluded with its secret in no page.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const legacyDirectory = await fixture.mkdirOwned('legacy-store', 'legacy-store', 'rm -rf the exact legacy store directory, then assert it is absent');
    writeLegacyStore(legacyDirectory);
    const digestBefore = legacyStoreDigest(legacyDirectory);
    const openedToken = await legacyExport.openLegacyExport(legacySourceOf(legacyDirectory));
    const reopenedToken = await legacyExport.openLegacyExport(legacySourceOf(legacyDirectory));
    let pageRequest = { token: openedToken };
    let pages = 0; let chunks = 0;
    const pageContents = [];
    const chunkChecksums = [];
    while (pageRequest) {
      const page = await legacyExport.readLegacyExportPage(legacySourceOf(legacyDirectory), pageRequest);
      pages += 1;
      for (const chunk of page.chunks) { chunks += 1; pageContents.push(chunk.content); chunkChecksums.push(chunk.checksum); }
      pageRequest = page.next ? { token: page.next } : null;
    }
    const digestAfter = legacyStoreDigest(legacyDirectory);
    record('legacyStore', { digestBefore, digestAfter, revision: openedToken.revision, records: openedToken.records, exportableRecords: openedToken.exportableRecords, localOnlyRecords: openedToken.localOnlyRecords, pages, chunks });
    check('the legacy import leaves the migration hash unchanged: the real legacy export scan and paging walk the real legacy store files read-only, the sha256 of every legacy file BEFORE the walk equals the sha256 AFTER it (both hex values pinned, the localStorage digest and the history digest recorded), the export revision is identical across two opens and every page, the local-only credential is excluded with its secret in no exported page, and every history record is served unchanged', {
      filesBefore: digestBefore,
      filesAfter: digestAfter,
      everyFileUnchanged: LEGACY_FILES.every((name) => digestBefore[name] === digestAfter[name]),
      localStorageSha256: digestBefore['localStorage.json'],
      historySha256: digestBefore['history.json'],
      revision: openedToken.revision,
      revisionStableAcrossOpens: openedToken.revision === reopenedToken.revision,
      revisionShape: HASH.test(openedToken.revision),
      records: openedToken.records,
      exportableRecords: openedToken.exportableRecords,
      localOnlyRecords: openedToken.localOnlyRecords,
      pages,
      chunks,
      chunkChecksumShape: chunkChecksums.every((hash) => HASH.test(hash)),
      credentialKeyPresent: Object.hasOwn(LEGACY_LOCAL, 'opencode.credentials.v1'),
      credentialExcluded: !pageContents.some((content) => content.includes(LEGACY_SECRET)),
      everyHistoryRecordExported: LEGACY_HISTORY.every((entry) => pageContents.includes(entry.content)),
      historyRecords: LEGACY_HISTORY.length,
    }, {
      filesBefore: LEGACY_STORE_HASHES,
      filesAfter: LEGACY_STORE_HASHES,
      everyFileUnchanged: true,
      localStorageSha256: LEGACY_STORE_HASHES['localStorage.json'],
      historySha256: LEGACY_STORE_HASHES['history.json'],
      revision: openedToken.revision,
      revisionStableAcrossOpens: true,
      revisionShape: true,
      records: 15,
      exportableRecords: 14,
      localOnlyRecords: 1,
      pages,
      chunks,
      chunkChecksumShape: true,
      credentialKeyPresent: true,
      credentialExcluded: true,
      everyHistoryRecordExported: true,
      historyRecords: 10,
    }, 'the real shared/runtime/migration/legacyExport.js openLegacyExport + readLegacyExportPage over real legacy store files written from the seed090 oracle wire shapes, with node:crypto sha256 read before and after the full walk');

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // C3: requirement 3 — one source failing does not drag down the whole run. The REAL discovery
    // scheduler with all five sources demanded; two reject, three still settle, the queue drains,
    // and a LATER demand on a healthy source still runs.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const scheduler = createDiscoveryScheduler();
    const settled = await Promise.all(SOURCES.map((source) => scheduler.schedule(
      { environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE[source], scope: '{}' },
      async () => {
        if (source === 'codex' || source === 'dsh') throw new StoreError('source_unavailable', 'native_timeout');
        return { source, complete: true, count: 2 };
      },
    ).then((value) => ({ source, ok: true, value }), (error) => ({ source, ok: false, code: error.code ?? null, field: error.reason ?? null }))));
    const laterDemand = await scheduler.schedule({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, scope: '{}' }, async () => ({ source: 'opencode', complete: true, count: 3 }));
    const schedulerState = scheduler.state;
    scheduler.close();
    record('scheduler', { settled, laterDemand, state: schedulerState });
    check('one source failing does not drag down the whole run: the real discovery scheduler is demanded for all five sources at once, codex and dsh reject source_unavailable/native_timeout, opencode, acp and kimi-web still settle with their own count of 2, the queue drains to zero, and a LATER demand on the healthy opencode source still runs with count 3 — the failure never poisons the scheduler', {
      demandedSources: SOURCES.length,
      okCount: settled.filter((entry) => entry.ok).length,
      failedCount: settled.filter((entry) => !entry.ok).length,
      failedSources: settled.filter((entry) => !entry.ok).map((entry) => entry.source),
      failureCodes: settled.filter((entry) => !entry.ok).map((entry) => entry.code),
      failureFields: settled.filter((entry) => !entry.ok).map((entry) => entry.field),
      settledCounts: settled.filter((entry) => entry.ok).map((entry) => ({ source: entry.value.source, count: entry.value.count })),
      laterDemand,
      queueDrained: schedulerState.queued === 0,
    }, {
      demandedSources: 5,
      okCount: 3,
      failedCount: 2,
      failedSources: ['codex', 'dsh'],
      failureCodes: ['source_unavailable', 'source_unavailable'],
      failureFields: ['native_timeout', 'native_timeout'],
      settledCounts: [{ source: 'opencode', count: 2 }, { source: 'acp', count: 2 }, { source: 'kimi-web', count: 2 }],
      laterDemand: { source: 'opencode', complete: true, count: 3 },
      queueDrained: true,
    }, 'the real bridge/runtime/discoveryScheduler.js with all five sources demanded, two rejecting through the real bridge/runtime/storage/storeProtocol.js StoreError');

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // The lane itself: the landed harness drives the real full chain (happy) or the real fault
    // injection (failure). Its scenarios, artifacts, observations and mapping completeness are
    // merged into this case's result, so the registered invocation reports ONE result.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const lane = context.case === 'happy' ? await runSystem(context) : await runFaults(context);
    scenarios.push(...lane.scenarios);
    artifacts.push(...lane.artifacts);
    record('lane', { case: context.case, lane: laneId, scenarios: lane.scenarios.length, assertions: lane.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0), artifacts: lane.artifacts.length, mapping: lane.mapping });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // C5: requirement 4 — every IS user path and every negative case carries an assertion or
    // evidence. Each row is checked against the catalog (a real command, a real owning lane) AND
    // against the scenario set the owning lane really observed; the rows the OTHER lane owns are
    // recorded with their lane rather than pretended.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const completeness = lane.mapping?.completeness ?? null;
    assert(completeness !== null && Array.isArray(completeness.observed), 'the lane must report its mapping completeness over the scenarios it observed');
    const laneObserved = new Set(completeness.observed);
    const isRows = IS_USER_PATHS.map((row) => {
      const scenario = catalogById.get(row.scenario) ?? null;
      return {
        is: row.is,
        scenario: row.scenario,
        inCatalog: scenario !== null,
        commandNonEmpty: typeof scenario?.command === 'string' && scenario.command.length > 0,
        owningLane: scenario?.lane ?? null,
        drivenByThisLane: scenario?.lane === laneId,
        observedByThisLane: laneObserved.has(row.scenario),
      };
    });
    const negativeCases = FAULT_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      realm: scenario.realm,
      commandNonEmpty: typeof scenario.command === 'string' && scenario.command.length > 0,
      ownedByThisLane: scenario.lane === laneId,
      observedByThisLane: laneObserved.has(scenario.id),
    }));
    record('isUserPaths', { rows: isRows, pathTexts: IS_USER_PATHS.map((row) => ({ is: row.is, path: row.path })) });
    check(`every IS user path and every negative case carries an assertion or evidence: all 8 IS rows name a catalog scenario with a real command, the ${isRows.filter((row) => row.drivenByThisLane).length} rows this ${laneId} lane owns were really observed by it, the rows the other lane owns are recorded with their lane instead of pretended, all 10 negative cases name a real command, and the ${negativeCases.filter((entry) => entry.ownedByThisLane).length} negative cases this lane owns were really observed — with the lane's own scenario count, assertion count and per-assertion self-consistency recorded as the evidence`, {
      lane: laneId,
      isRows,
      isCount: isRows.length,
      everyIsRowInCatalog: isRows.every((row) => row.inCatalog),
      everyIsRowHasRealCommand: isRows.every((row) => row.commandNonEmpty),
      isRowsDrivenByThisLane: isRows.filter((row) => row.drivenByThisLane).map((row) => row.is),
      everyIsRowDrivenByThisLaneObserved: isRows.filter((row) => row.drivenByThisLane).every((row) => row.observedByThisLane),
      isRowsOwnedByTheOtherLane: isRows.filter((row) => !row.drivenByThisLane).map((row) => ({ is: row.is, scenario: row.scenario, owningLane: row.owningLane })),
      negativeCases,
      negativeCount: negativeCases.length,
      everyNegativeCaseHasRealCommand: negativeCases.every((entry) => entry.commandNonEmpty),
      negativeCasesObservedByThisLane: negativeCases.filter((entry) => entry.ownedByThisLane && entry.observedByThisLane).map((entry) => entry.id),
      negativeCasesOwnedByThisLaneCount: negativeCases.filter((entry) => entry.ownedByThisLane).length,
      everyNegativeCaseOwnedByThisLaneObserved: negativeCases.filter((entry) => entry.ownedByThisLane).every((entry) => entry.observedByThisLane),
      laneScenarioCount: lane.scenarios.length,
      laneAssertionCount: lane.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0),
      everyLaneScenarioHasAssertions: lane.scenarios.every((scenario) => scenario.assertions.length > 0),
      everyLaneAssertionPassedAndSelfConsistent: lane.scenarios.every((scenario) => scenario.assertions.every((assertion) => assertion.passed === true && JSON.stringify(assertion.observed) === JSON.stringify(assertion.expected))),
      laneMappingCompleteness: completeness,
      laneMappingMissing: completeness.missing ?? [],
    }, {
      lane: laneId,
      isRows,
      isCount: 8,
      everyIsRowInCatalog: true,
      everyIsRowHasRealCommand: true,
      isRowsDrivenByThisLane: laneId === 'system' ? ['IS-1', 'IS-2', 'IS-3', 'IS-4', 'IS-6', 'IS-7', 'IS-8'] : ['IS-5'],
      everyIsRowDrivenByThisLaneObserved: true,
      isRowsOwnedByTheOtherLane: laneId === 'system' ? [{ is: 'IS-5', scenario: 'FLT-05-transport-break', owningLane: 'faults' }] : [{ is: 'IS-1', scenario: 'SYS-02-five-source-unified-index', owningLane: 'system' }, { is: 'IS-2', scenario: 'SYS-10-source-failure-isolation', owningLane: 'system' }, { is: 'IS-3', scenario: 'SYS-04-sessionref-identity', owningLane: 'system' }, { is: 'IS-4', scenario: 'SYS-01-legacy-store-import', owningLane: 'system' }, { is: 'IS-6', scenario: 'SYS-10-source-failure-isolation', owningLane: 'system' }, { is: 'IS-7', scenario: 'SYS-06-thread-handoff-ladder', owningLane: 'system' }, { is: 'IS-8', scenario: 'SYS-08-artifact-integration', owningLane: 'system' }],
      negativeCases,
      negativeCount: 10,
      everyNegativeCaseHasRealCommand: true,
      negativeCasesObservedByThisLane: laneId === 'system' ? [] : FAULT_SCENARIOS.map((scenario) => scenario.id),
      negativeCasesOwnedByThisLaneCount: laneId === 'system' ? 0 : 10,
      everyNegativeCaseOwnedByThisLaneObserved: true,
      laneScenarioCount: lane.scenarios.length,
      laneAssertionCount: lane.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0),
      everyLaneScenarioHasAssertions: true,
      everyLaneAssertionPassedAndSelfConsistent: true,
      laneMappingCompleteness: completeness,
      laneMappingMissing: [],
    }, 'the real app/dev/runtime-v090/system43-mapping.mjs IS_USER_PATHS and FAULT_SCENARIOS rows composed against the real scenario catalog and the observed scenario set the landed lane harness returned');

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // C6: the evidence binds to the CURRENT bytes — nothing moved under the case, and the case's
    // own authored files are unchanged.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const registeredAfter = sourceSnapshot(context.root, sourceFiles);
    const ownedAfter = sourceSnapshot(context.root, OWNED_FILES);
    check('the evidence binds to the current bytes: the sha256 of every registered source is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, and the case own authored files are byte-identical, so no product, harness, entry or fixture byte moved under the case', {
      registeredSourceCount: sourceFiles.length,
      registeredSourcesUnchanged: JSON.stringify(registeredBefore) === JSON.stringify(registeredAfter),
      ownedFileCount: OWNED_FILES.length,
      ownedFilesUnchanged: JSON.stringify(ownedBefore) === JSON.stringify(ownedAfter),
      laneScenarioCount: lane.scenarios.length,
      totalScenarioCount: scenarios.length,
      totalCheckCount: checks.length,
    }, {
      registeredSourceCount: sourceFiles.length,
      registeredSourcesUnchanged: true,
      ownedFileCount: OWNED_FILES.length,
      ownedFilesUnchanged: true,
      laneScenarioCount: lane.scenarios.length,
      totalScenarioCount: scenarios.length,
      totalCheckCount: checks.length,
    }, 'sourceSnapshot over the merged registration and the case own authored files, recomputed before the first scenario and after the last');
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
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
    versions: { node: process.version },
    cleanup: proof.cleanup,
    mapping: { case: context.case, lane: laneId, checks: checks.map((entry) => entry.name) },
    evidenceBoundary: 'This case module drives, in the Node worker, the real shared/runtime/migration/legacyExport.js over a real legacy store seeded from the independent seed090 oracle, the real bridge/runtime/discoveryScheduler.js with all five sources demanded, the real bridge/runtime/storage/storeProtocol.js StoreError, and the real app/dev/runtime-v090/system43-mapping.mjs integrity / completeness / refusal functions; it starts no child process and runs no git command. The full chain (5 sources from the legacy store -> the unified tree -> two participants -> fan-out/team -> artifact review -> restart continuation) and every fault-injection category (kill store / native / manager, break UI / SSH / relay, slow consumer, source partial, sameIDacrosshosts, legacyimporttargetswitch) are driven by the two landed harnesses this case delegates to, over the real landed bridge modules in the worker and the real unified session tree in a real headless Chromium over a case-owned Vite server seeded from the legacy store. The stateful collaboration services cannot cross into a browser realm (node:* builtins at module scope), so those legs stay in the worker, and the TypeScript migration modules are loaded through the case-owned Vite server ssrLoadModule. No container provides RUNTIME_COLLABORATION_STATE_KEY yet and App.vue integration is a later task, so the QA page IS the container and no running-app rendering is claimed. No live SSH and no live Slurm verification is performed (task 46 owns that), no Electron or packaged-artifact run is performed (task 45 owns it), no product test suite is run, and no PASS verdict is authored here — root dispatches the two registered invocations and an independent gate.',
  };
}
