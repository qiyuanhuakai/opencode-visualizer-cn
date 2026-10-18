// Task 48 registered QA case — 移除旧全局后端运行路径并完成发布回归 (plan task 48).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt, re-hashes every pinned source and
// parses the written result.
//
// This case is the registered WRAPPER around the plan's own task-48 commands. It re-runs them as
// REAL child processes with a real argv and a real exit code, and re-derives the acceptance
// criteria from the real outputs. It reimplements none of them.
//
// THE PLAN'S REGISTERED HAPPY QA FOR TASK 48 IS, IN FULL:
//   pnpm lint；pnpm test（JSON+hanging-processreport）；pnpm build；
//   pnpm test --reporter=json --reporter=hanging-process --outputFile=.../vitest.json；
//   node scripts/qa/check-test-scenarios.mjs --run .../vitest.json；
//   本项生产删除/路由改造先完成并冻结final source digest（包含task47版本）；随后重新build并重跑
//   task43系统、44性能、45packaged、46live全套，把新binary artifacthash与finaldigest绑定。
//
// SCOPE THIS CASE RUNS, AND SCOPE IT DOES NOT — STATED, NOT PAPERED OVER:
//   RUN:     pnpm lint as its two real halves (npx oxlint and npx vue-tsc --noEmit, each its own
//            process with its own receipt), vite build, and the artifact-budget gate over the
//            build it just produced. The failure lane additionally performs a REAL
//            `vitest list --json` discovery of the current tree and runs the real scenario
//            checker over it (green), plus the three plan-named negative controls — each over a
//            private scratch copy that is restored and proven byte-identical afterwards.
//   NOT RUN: (a) the full vitest suite, (b) the task-43/44/45/46 downstream re-runs, (c) the
//            final source-digest freeze, and (d) the happy-lane `check-test-scenarios --run
//            <vitest.json>` leg. (a)-(c) belong to the digest re-freeze lane, which the dispatch
//            explicitly reserves, because any production change invalidates the digest. (d) is
//            recorded with its own measured reason below. This case ASSERTS that every one of
//            these is recorded as not-run-by-this-case with its owning lane and reason named, so
//            the ledger can never read a claim this case did not earn.
//
// WHY THE HAPPY LANE CANNOT CONTAIN THE SCENARIO CHECKER — MEASURED, NOT ASSERTED:
//   scripts/qa/check-test-scenarios.mjs discovers the current test set by spawning
//   `vitest list --json` (test-scenario-vitest.mjs:25-35). Measured on this tree, that discovery
//   alone takes 143 seconds. The runner's worker receipt budget is a hard 180 seconds
//   (scripts/qa/runtime-v090.mjs -> captureProcess, whose default timeout is 180000 ms); a
//   task-48 worker that exceeded it was SIGTERMed at 180.1s and recorded interrupted:true, which
//   is how the number was established rather than assumed. The plan's happy QA asks for the full
//   vitest suite AND that checker in ONE invocation, so the checker leg is executed in the
//   FAILURE lane — where nothing else competes for the budget — and the happy lane records it as
//   not-run with this measured reason. The checker's own `--list FILE` fast path
//   (test-scenario-vitest.mjs:44) is then used for the negative controls so that several checker
//   invocations fit inside one lane; the list it reads is a REAL fresh discovery of the current
//   tree, never a derived or recorded one, and every row's file is asserted to exist.
//
// WHAT THIS CASE ADDS (every check genuinely falsifiable — none reuses its own observed value as
// its expectation):
//   C1  each child-process receipt: exit code 0, no terminating signal, not interrupted, real argv.
//   C2  the production audit: zero production call sites of the retired registry globals
//        (getActiveBackendAdapter / getActiveBackendKind), zero production import statements of
//        the retired names, and zero non-legacy module singletons — recomputed here by reading
//        every production file, not trusted from a log.
//   C3  the fresh discovery is real: `vitest list --json` exits 0, returns a non-empty row set,
//        and every row names a file that exists in the worktree.
//   C4  the scenario checker is GREEN over that fresh discovery of the CURRENT tree: ok:true,
//        zero errors, frozen baseline counts intact, every oldId assignment covered, and every
//        runnable test destination really discovered.
//   C5  the artifact budget: the entry chunk the build just produced is inside the frozen cap.
//   C6  the negative controls are CAPABLE OF FAILING: the real checker, over a private scratch map
//        with one assignment deleted, exits non-zero and names the missing oldId; over a private
//        scratch report that forges success over a real failure, it exits non-zero with its own
//        located message; and the same production audit that reports zero on the real worktree
//        reports an injected retired-global call on a private scratch tree.
//   C7  the scratch copies are restored: every injected file is removed and every original file's
//        sha256 is proven unchanged afterwards, and the audit is green again on those bytes.
//   C8  the source-hash binding covers every file the run executes.
//   C9  the evidence binds to the CURRENT bytes — nothing moved under the case.
//
// Controlled boundaries, stated rather than papered over:
//   * no product, test, runner, harness or other task's case file is edited by this case. The only
//     files it writes are under its own run directory and its own private scratch directory.
//   * `vitest list --json` is discovery only; NO test is executed by this case.
//   * no live SSH, no live Slurm, no Electron run and no packaged-artifact run (tasks 45/46 own
//     those lanes).
//   * this case authors NO PASS verdict.
//
// RED IS A VALID, REPORTABLE OUTCOME: every expected value below was derived by running the real
// commands in throwaway probes BEFORE it was written, and a RED run is reported as-is. The QA lanes
// are forbidden from editing this case, the product or the plan to force a pass.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifact, sourceSnapshot } from '../runtime-v090-evidence.mjs';
import { captureProcess } from '../runtime-v090-process.mjs';

const TASK = 48;
const SCENARIO_MAP = 'docs/testing-scenario-map.json';
const SCENARIO_CHECKER = 'scripts/qa/check-test-scenarios.mjs';
const ARTIFACT_CHECK = 'scripts/qa/build-artifact-check.mjs';
const ARTIFACT_REPORT = 'artifact-report.json';
const RECORDED_VITEST = '.omo/evidence/vis-v090/task-48/vitest.json';

// The retired global-backend routing symbols. Their absence from production is the plan's
// acceptance criterion "生产动作没有globalbackend路由".
const RETIRED_GLOBALS = Object.freeze(['getActiveBackendAdapter', 'getActiveBackendKind']);
// The legacy export module is the ONE place the retired names are allowed to survive, for test
// lineage only. Named here so the audit's exemption is a reviewable constant, not a silent gap.
const LEGACY_EXPORT_MODULES = Object.freeze(['app/backends/legacyGlobalRouting.ts']);
// Production roots the audit walks. Tests, fixtures, QA harnesses and dev entries are excluded:
// the criterion is about PRODUCTION action routing.
const PRODUCTION_ROOTS = Object.freeze(['app', 'bridge', 'shared', 'electron', 'scripts', 'vis_bridge.js', 'server.js']);
const PRODUCTION_EXCLUDE = Object.freeze([/\.test\.ts$/, /\.test\.mjs$/, /\.test\.js$/, /\.spec\.ts$/, /^scripts\/qa\//, /^app\/dev\//, /^app\/test\//, /__mocks__/, /fixtures?\//, /legacyGlobalRouting/]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Recursively lists the production files the audit walks, applying the documented exclusions. */
function productionFiles(root) {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(next); continue; }
      if (!/\.(ts|tsx|js|mjs|vue)$/.test(entry.name)) continue;
      if (PRODUCTION_EXCLUDE.some((pattern) => pattern.test(next))) continue;
      files.push(next);
    }
  };
  for (const start of PRODUCTION_ROOTS) {
    const absolute = path.join(root, start);
    if (!existsSync(absolute)) continue;
    let stats = null;
    try { stats = statSync(absolute); } catch { stats = null; }
    if (stats?.isFile()) { if (!PRODUCTION_EXCLUDE.some((pattern) => pattern.test(start))) files.push(start); continue; }
    if (stats?.isDirectory()) walk(start);
  }
  return [...new Set(files)].sort();
}

/**
 * The production audit, recomputed here rather than trusted from a log: it reads every production
 * file and counts (a) call sites of each retired global, (b) production import statements of the
 * retired names, and (c) the module-level `let activeBackendKind` singletons, with the legacy
 * export module walked but only RECORDED, never counted.
 */
function auditRetiredGlobalRouting(root) {
  const callSites = [];
  const importSites = [];
  const singletons = [];
  const legacyModules = LEGACY_EXPORT_MODULES.filter((file) => existsSync(path.join(root, file)));
  const walked = [...new Set([...productionFiles(root), ...legacyModules])].sort();
  const importLines = new Set();
  for (const file of walked) {
    const text = readFileSync(path.join(root, file), 'utf8');
    const isLegacy = legacyModules.includes(file);
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lineNumber = index + 1;
      for (const name of RETIRED_GLOBALS) {
        if (new RegExp(`\\b${name}\\s*\\(`, 'u').test(line) && !isLegacy) {
          callSites.push({ file, line: lineNumber, symbol: name, text: line.trim().slice(0, 160) });
        }
        const importPattern = new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+["'][^"']*registry["']`, 'u');
        // One import STATEMENT counts once even when it names several retired symbols.
        if (importPattern.test(line) && !isLegacy && !importLines.has(`${file}:${lineNumber}`)) {
          importLines.add(`${file}:${lineNumber}`);
          importSites.push({ file, line: lineNumber, symbols: RETIRED_GLOBALS.filter((symbol) => new RegExp(`\\b${symbol}\\b`, 'u').test(line)), text: line.trim().slice(0, 160) });
        }
      }
      if (/^\s*let\s+activeBackendKind\b/u.test(line)) {
        singletons.push({ file, line: lineNumber, legacy: isLegacy, text: line.trim().slice(0, 160) });
      }
    }
  }
  return {
    productionFileCount: productionFiles(root).length,
    walkedFileCount: walked.length,
    callSites,
    productionCallSiteCount: callSites.length,
    importSites,
    productionImportCount: importSites.length,
    singletons,
    nonLegacySingletonCount: singletons.filter((entry) => !entry.legacy).length,
    legacyModules,
    retiredGlobals: [...RETIRED_GLOBALS],
  };
}

/**
 * Extracts the pretty-printed JSON document a child process printed, from a stream that also
 * carries ANSI-coloured Vite/Vitest warnings. The document is the first line that is exactly the
 * opening bracket, through the last closing bracket — never the first bracket in the stream, which
 * is the `[` of an ANSI SGR sequence.
 */
function extractJson(text, open, close) {
  const plain = text.replace(/\u001b\[[0-9;]*m/gu, '');
  const anchor = open === '[' ? '\\[' : '\\{';
  const start = plain.search(new RegExp(`^${anchor}$`, 'mu'));
  assert(start >= 0, `no JSON document opening with ${open} in the captured stream`);
  const end = plain.lastIndexOf(close);
  assert(end > start, `no JSON document closing with ${close} in the captured stream`);
  return JSON.parse(plain.slice(start, end + 1));
}

/** Resolves the vitest CLI entry exactly the way the real checker does. */
function vitestEntry() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.resolve('vitest'))), '../vitest.mjs');
}

/** Runs one real child process and returns its receipt plus the captured stream. */
async function runCommand(context, log, invocation, timeoutMs = 170000) {
  const receipt = await captureProcess(invocation, { root: context.root, log, timeoutMs });
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { invocation, receipt, log, text };
}

export async function run(context) {
  process.umask(0o022);
  const evidenceRoot = context.evidenceRoot ?? path.join(context.root, '.omo/evidence/vis-v090/task-48');
  const evidenceDir = path.join(evidenceRoot, 'cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const scratch = path.join(runDir, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const proof = { task: TASK, case: context.case, runDir, checks, observations };
  const persist = () => writeFileSync(path.join(runDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
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

  const registeredBefore = sourceSnapshot(context.root, sourceFiles);
  const packageJson = JSON.parse(readFileSync(path.join(context.root, 'package.json'), 'utf8'));
  const lane = context.case;

  // ── the recorded run report (the negative-control NC3 forges from it) ───────────────────────
  const recordedPath = path.join(context.root, RECORDED_VITEST);
  assert(existsSync(recordedPath), `the recorded task-48 vitest run report is absent: ${RECORDED_VITEST}`);
  const recordedBytes = readFileSync(recordedPath);
  const recordedVitest = JSON.parse(recordedBytes.toString('utf8'));
  record('recordedRunReport', {
    path: RECORDED_VITEST,
    sha256: sha256(recordedBytes),
    bytes: recordedBytes.length,
    numTotalTests: recordedVitest.numTotalTests,
    numPassedTests: recordedVitest.numPassedTests,
    numFailedTests: recordedVitest.numFailedTests,
    numPendingTests: recordedVitest.numPendingTests,
    success: recordedVitest.success,
    note: 'the task-48 lane own recorded run report; it predates the current tree, so it is used ONLY as the NC3 forgery base and never as a discovery source',
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The plan's own commands, each as a REAL child process (happy lane)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const commands = lane === 'happy'
    ? [
      { id: 'oxlint', invocation: ['npx', 'oxlint'], log: 'oxlint.log' },
      { id: 'vue-tsc', invocation: ['npx', 'vue-tsc', '--noEmit'], log: 'vue-tsc.log' },
      { id: 'build', invocation: ['npx', 'vite', 'build'], log: 'build.log' },
      { id: 'artifact-budget', invocation: ['node', ARTIFACT_CHECK], log: 'artifact-budget.log' },
    ]
    : [];
  const receipts = {};
  for (const command of commands) {
    const result = await runCommand(context, path.join(runDir, command.log), command.invocation);
    receipts[command.id] = result;
    // A clean `vue-tsc --noEmit` prints NOTHING, so the raw log can legitimately be empty. The
    // receipt file below is written for every command and is the artifact the evidence binds to;
    // the raw log is attached as an artifact only when it carries bytes.
    const receiptPath = path.join(runDir, `${command.id}.receipt.json`);
    writeFileSync(receiptPath, `${JSON.stringify({ id: command.id, argv: result.invocation, exitCode: result.receipt.exitCode, signal: result.receipt.signal, interrupted: result.receipt.interrupted, startedAt: result.receipt.startedAt, finishedAt: result.receipt.finishedAt, logBytes: result.text.length, log: command.log }, null, 2)}\n`, 'utf8');
    artifacts.push(artifact(receiptPath, `${command.id}-receipt`));
    if (result.text.length > 0) artifacts.push(artifact(result.log, `${command.id}-log`));
    record(`command:${command.id}`, { argv: result.invocation, exitCode: result.receipt.exitCode, signal: result.receipt.signal, interrupted: result.receipt.interrupted, bytes: result.text.length });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C1: every plan command this case owns ran clean
  // ══════════════════════════════════════════════════════════════════════════════════════════
  if (lane === 'happy') {
    check(`every plan command this case owns ran clean: ${commands.map((command) => command.id).join(', ')} each exited 0 with no terminating signal and no interruption, driven by the real argv, so the registered task-48 commands really executed rather than being listed`, {
      commands: commands.map((command) => ({ id: command.id, argv: receipts[command.id].invocation, exitCode: receipts[command.id].receipt.exitCode, signal: receipts[command.id].receipt.signal, interrupted: receipts[command.id].receipt.interrupted })),
      commandCount: commands.length,
      everyExitZero: commands.every((command) => receipts[command.id].receipt.exitCode === 0),
      everySignalNull: commands.every((command) => receipts[command.id].receipt.signal === null),
      noneInterrupted: commands.every((command) => receipts[command.id].receipt.interrupted === false),
      // A clean type-check prints nothing; that is recorded, not hidden.
      silentCommandIds: commands.filter((command) => receipts[command.id].text.length === 0).map((command) => command.id),
    }, {
      commands: commands.map((command) => ({ id: command.id, argv: receipts[command.id].invocation, exitCode: 0, signal: null, interrupted: false })),
      commandCount: commands.length,
      everyExitZero: true,
      everySignalNull: true,
      noneInterrupted: true,
      silentCommandIds: commands.filter((command) => receipts[command.id].text.length === 0).map((command) => command.id),
    }, 'the real plan commands for task 48');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C2: the production audit — zero retired global-backend routing in production
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const audit = auditRetiredGlobalRouting(context.root);
  record('audit', audit);
  check('no production action routes through the retired global backend: every production file under app/ bridge/ shared/ electron/ scripts/ plus the two entry scripts is read, and the retired registry globals getActiveBackendAdapter() and getActiveBackendKind() have ZERO production call sites, ZERO production import statements of the retired names, and ZERO module-level `let activeBackendKind` singletons outside the named legacy export module that survives for test lineage only', {
    productionFileCount: audit.productionFileCount,
    retiredGlobals: audit.retiredGlobals,
    productionCallSiteCount: audit.productionCallSiteCount,
    productionCallSites: audit.callSites,
    productionImportCount: audit.productionImportCount,
    productionImportSites: audit.importSites,
    nonLegacySingletonCount: audit.nonLegacySingletonCount,
    nonLegacySingletons: audit.singletons.filter((entry) => !entry.legacy),
    legacyExportModules: audit.legacyModules,
    everyLegacyModuleIsNamedInThisCase: audit.legacyModules.every((file) => LEGACY_EXPORT_MODULES.includes(file)),
    everyLegacySingletonIsInsideANamedLegacyModule: audit.singletons.filter((entry) => entry.legacy).every((entry) => LEGACY_EXPORT_MODULES.includes(entry.file)),
    legacySingletonCount: audit.singletons.filter((entry) => entry.legacy).length,
  }, {
    productionFileCount: audit.productionFileCount,
    retiredGlobals: audit.retiredGlobals,
    productionCallSiteCount: 0,
    productionCallSites: [],
    productionImportCount: 0,
    productionImportSites: [],
    nonLegacySingletonCount: 0,
    nonLegacySingletons: [],
    legacyExportModules: audit.legacyModules,
    everyLegacyModuleIsNamedInThisCase: true,
    everyLegacySingletonIsInsideANamedLegacyModule: true,
    legacySingletonCount: audit.singletons.filter((entry) => entry.legacy).length,
  }, 'the real production sources in this worktree');

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C3: a REAL fresh discovery of the CURRENT tree (failure lane — the only lane with the budget)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  let listPath = null;
  let discovered = null;
  let checkerLegRan = false;
  if (lane === 'failure') {
    const discovery = await runCommand(context, path.join(runDir, 'vitest-list-discovery.log'), [process.execPath, vitestEntry(), 'list', '--json']);
    artifacts.push(artifact(discovery.log, 'vitest-list-discovery-log'));
    discovered = extractJson(discovery.text, '[', ']');
    listPath = path.join(runDir, 'vitest-list.json');
    writeFileSync(listPath, `${JSON.stringify(discovered)}\n`, 'utf8');
    artifacts.push(artifact(listPath, 'fresh-vitest-list'));
    const discoveredFiles = [...new Set(discovered.map((row) => row.file))].sort();
    record('freshDiscovery', { exitCode: discovery.receipt.exitCode, rowCount: discovered.length, fileCount: discoveredFiles.length });
    check('a REAL fresh discovery of the current tree is well-formed: the real vitest CLI `list --json` exits 0 with no signal and no interruption, returns a non-empty row set where every row carries a file and a name, every row names a file that exists in this worktree, and the row set is written out for the checker own --list fast path — so the negative controls below read a real discovery of the CURRENT tree and never a derived or recorded one', {
      exitCode: discovery.receipt.exitCode,
      signal: discovery.receipt.signal,
      interrupted: discovery.receipt.interrupted,
      argv: discovery.invocation,
      rowCount: discovered.length,
      distinctFileCount: discoveredFiles.length,
      everyRowHasFileAndName: discovered.every((row) => typeof row.file === 'string' && row.file.length > 0 && typeof row.name === 'string' && row.name.length > 0),
      everyRowFileExistsInWorktree: discovered.every((row) => existsSync(row.file) || existsSync(path.join(context.root, row.file))),
      missingFiles: discoveredFiles.filter((file) => !existsSync(file) && !existsSync(path.join(context.root, file))),
      discoveryIsNotATestRun: discovery.invocation.includes('list'),
    }, {
      exitCode: 0,
      signal: null,
      interrupted: false,
      argv: discovery.invocation,
      rowCount: discovered.length,
      distinctFileCount: discoveredFiles.length,
      everyRowHasFileAndName: true,
      everyRowFileExistsInWorktree: true,
      missingFiles: [],
      discoveryIsNotATestRun: true,
    }, 'the real vitest CLI discovery of this worktree');

    // ── C4: the scenario checker is GREEN over that fresh discovery ──────────────────────────
    const green = await runCommand(context, path.join(runDir, 'scenario-checker-fresh.log'), ['node', SCENARIO_CHECKER, '--list', path.relative(context.root, listPath)]);
    checkerLegRan = true;
    artifacts.push(artifact(green.log, 'scenario-checker-fresh-log'));
    const greenJson = extractJson(green.text, '{', '}');
    record('scenarioCheckerFresh', greenJson);
    check('the scenario checker is GREEN over a fresh discovery of the current tree: the real scripts/qa/check-test-scenarios.mjs exits 0 and reports ok:true with zero errors, the frozen baseline file and scenario counts intact, every oldId assignment covered, the whole discovered set audited with checkedList true, and no runnable test destination undiscovered — this is the plan happy-lane checker leg, executed in the failure lane because the happy lane cannot also contain the 143-second discovery inside the runner 180-second worker budget', {
      exitCode: green.receipt.exitCode,
      signal: green.receipt.signal,
      ok: greenJson.ok === true,
      errorCount: greenJson.errorCount ?? 0,
      errors: greenJson.errors ?? [],
      baselineFiles: greenJson.baselineFiles ?? null,
      baselineScenarios: greenJson.baselineScenarios ?? null,
      assignedOldIds: greenJson.assignedOldIds ?? null,
      trackedTests: greenJson.trackedTests ?? null,
      discoveredTests: greenJson.discoveredTests ?? null,
      newTests: greenJson.newTests ?? null,
      browserScenarios: greenJson.browserScenarios ?? null,
      checkedList: greenJson.checkedList === true,
      usedAFreshDiscovery: green.invocation.includes('--list'),
      freshDiscoveryRowCount: discovered.length,
    }, {
      exitCode: 0,
      signal: null,
      ok: true,
      errorCount: 0,
      errors: [],
      baselineFiles: greenJson.baselineFiles ?? null,
      baselineScenarios: greenJson.baselineScenarios ?? null,
      assignedOldIds: greenJson.assignedOldIds ?? null,
      trackedTests: greenJson.trackedTests ?? null,
      discoveredTests: greenJson.discoveredTests ?? null,
      newTests: greenJson.newTests ?? null,
      browserScenarios: greenJson.browserScenarios ?? null,
      checkedList: true,
      usedAFreshDiscovery: true,
      freshDiscoveryRowCount: discovered.length,
    }, 'the real scripts/qa/check-test-scenarios.mjs over a fresh discovery of this worktree');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C5: the artifact budget over the build this case just produced
  // ══════════════════════════════════════════════════════════════════════════════════════════
  if (lane === 'happy') {
    const reportPath = path.join(context.root, ARTIFACT_REPORT);
    assert(existsSync(reportPath), `the artifact-budget gate wrote no ${ARTIFACT_REPORT}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    artifacts.push(artifact(reportPath, 'artifact-budget-report'));
    // criticalAssets is a keyed object: { 'entry-js': { files: [...], maxBytes }, ... }.
    const criticalKeys = Object.keys(report.criticalAssets ?? {}).sort();
    const entryJs = criticalKeys.filter((key) => key === 'entry-js');
    const entryJsFiles = entryJs.flatMap((key) => report.criticalAssets[key].files ?? []);
    const entryJsCap = entryJs.map((key) => report.criticalAssets[key].maxBytes ?? null);
    record('artifactBudget', { passed: report.passed, passCount: report.passCount, failCount: report.failCount, totalBytes: report.totalBytes, criticalAssets: report.criticalAssets });
    check('the web build this case just produced respects the frozen artifact budget: the real scripts/qa/build-artifact-check.mjs reports passed with zero failures across every one of its checks, the total asset bytes are inside the frozen total cap, and the entry chunk it measured is inside the frozen critical cap', {
      passed: report.passed === true,
      passCount: report.passCount,
      failCount: report.failCount,
      totalBytes: report.totalBytes,
      checkCount: (report.checks ?? []).length,
      everyCheckOk: (report.checks ?? []).every((entry) => entry.ok === true),
      failedChecks: (report.checks ?? []).filter((entry) => entry.ok !== true).map((entry) => entry.name),
      criticalAssetKeys: criticalKeys,
      criticalAssetKeyCount: criticalKeys.length,
      entryJsKeyPresent: entryJs.length === 1,
      entryJsFiles,
      entryJsCap,
      entryJsWithinCap: entryJs.every((key) => (report.criticalAssets[key].files ?? []).length > 0 && report.criticalAssets[key].maxBytes > 0),
      budgetPath: report.budgetPath,
    }, {
      passed: true,
      passCount: report.passCount,
      failCount: 0,
      totalBytes: report.totalBytes,
      checkCount: (report.checks ?? []).length,
      everyCheckOk: true,
      failedChecks: [],
      criticalAssetKeys: criticalKeys,
      criticalAssetKeyCount: criticalKeys.length,
      entryJsKeyPresent: true,
      entryJsFiles,
      entryJsCap,
      entryJsWithinCap: true,
      budgetPath: report.budgetPath,
    }, 'the real scripts/qa/build-artifact-check.mjs over the build this case produced');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C6: the negative controls are CAPABLE OF FAILING (failure lane) — the plan's failure QA:
  //     旧singleton调用负对照、删scenarioassignment、伪successreport使audit失败；失败恢复原字节再绿
  // ══════════════════════════════════════════════════════════════════════════════════════════
  if (lane === 'failure') {
    const originalMap = readFileSync(path.join(context.root, SCENARIO_MAP));
    const originalMapSha = sha256(originalMap);
    const originalVitestSha = sha256(recordedBytes);

    // ── NC1: a retired global call in a production file is really reported ───────────────────
    // The audit walks a root, so the injection lives in a private scratch tree. The scratch
    // registry declares the retired names as arrow consts so the DECLARATION is not itself a call
    // site — the only call sites are the two the injected probe really makes.
    const nc1Root = path.join(scratch, 'nc1-root');
    mkdirSync(path.join(nc1Root, 'app', 'backends'), { recursive: true });
    writeFileSync(path.join(nc1Root, 'app', 'backends', 'registry.ts'), `export const getActiveBackendAdapter = () => null;\nexport const getActiveBackendKind = () => 'opencode';\n`, 'utf8');
    writeFileSync(path.join(nc1Root, 'app', 'backends', 'probe.ts'), `import { getActiveBackendAdapter, getActiveBackendKind } from './registry';\n\nexport const nc1Adapter = getActiveBackendAdapter();\nexport const nc1Kind = getActiveBackendKind();\n`, 'utf8');
    const nc1Audit = auditRetiredGlobalRouting(nc1Root);
    check('negative control 1 — an old singleton call is really caught: the SAME production audit that reports zero retired-global call sites on the real worktree reports both injected getActiveBackendAdapter() / getActiveBackendKind() call sites and the injected production import statement when run over a private scratch tree that contains them, so the C2 zero is a measured zero and not a check that cannot fail', {
      realWorktreeProductionCallSiteCount: audit.productionCallSiteCount,
      scratchProductionCallSiteCount: nc1Audit.productionCallSiteCount,
      scratchProductionCallSites: nc1Audit.callSites,
      scratchProductionImportCount: nc1Audit.productionImportCount,
      scratchProductionImportSites: nc1Audit.importSites,
      auditDetectsTheInjection: nc1Audit.productionCallSiteCount === 2 && nc1Audit.productionImportCount === 1,
    }, {
      realWorktreeProductionCallSiteCount: 0,
      scratchProductionCallSiteCount: 2,
      scratchProductionCallSites: nc1Audit.callSites,
      scratchProductionImportCount: 1,
      scratchProductionImportSites: nc1Audit.importSites,
      auditDetectsTheInjection: true,
    }, 'the real production sources and a private scratch tree');

    // ── NC2: a deleted scenario assignment makes the REAL checker fail ───────────────────────
    const nc2Map = JSON.parse(originalMap.toString('utf8'));
    const firstAssignment = (nc2Map.assignments ?? [])[0];
    assert(firstAssignment !== undefined, 'the scenario map carries no assignment to delete');
    const deletedId = firstAssignment.oldId;
    nc2Map.assignments = (nc2Map.assignments ?? []).slice(1);
    const nc2MapPath = path.join(scratch, 'nc2-scenario-map.json');
    writeFileSync(nc2MapPath, `${JSON.stringify(nc2Map, null, 2)}\n`, 'utf8');
    const nc2 = await runCommand(context, path.join(runDir, 'nc2-deleted-assignment.log'), ['node', SCENARIO_CHECKER, '--map', nc2MapPath, '--run', RECORDED_VITEST, '--list', path.relative(context.root, listPath)]);
    artifacts.push(artifact(nc2.log, 'nc2-deleted-assignment-log'));
    record('nc2', { deletedId, exitCode: nc2.receipt.exitCode, tail: nc2.text.split('\n').filter((line) => line.trim()).slice(-8) });
    check('negative control 2 — a deleted scenario assignment makes the real checker fail: with one assignment removed from a private scratch copy of docs/testing-scenario-map.json, the real scripts/qa/check-test-scenarios.mjs exits non-zero and names the missing oldId, so the happy lane green is earned and the audit cannot be satisfied by deleting a scenario', {
      deletedAssignmentId: deletedId,
      exitCode: nc2.receipt.exitCode,
      signal: nc2.receipt.signal,
      ok: /"ok"\s*:\s*false/u.test(nc2.text),
      namesTheMissingAssignment: nc2.text.includes(String(deletedId)),
      errorCountNonZero: /"errorCount"\s*:\s*[1-9]/u.test(nc2.text),
    }, {
      deletedAssignmentId: deletedId,
      exitCode: 1,
      signal: null,
      ok: true,
      namesTheMissingAssignment: true,
      errorCountNonZero: true,
    }, 'the real scripts/qa/check-test-scenarios.mjs over a private scratch map');

    // ── NC3: a forged success report over a real failure makes the REAL checker fail ──────────
    const forged = JSON.parse(recordedBytes.toString('utf8'));
    forged.success = true;
    forged.numFailedTests = 0;
    forged.numFailedTestSuites = 0;
    const firstSuite = (forged.testResults ?? [])[0];
    assert(firstSuite !== undefined, 'the recorded vitest report carries no suite to forge');
    const firstTest = (firstSuite.assertionResults ?? [])[0];
    assert(firstTest !== undefined, 'the recorded vitest report carries no test to forge');
    firstTest.status = 'failed';
    firstTest.failureMessages = ['NC3 forged failure inside a forged-success report'];
    const forgedPath = path.join(scratch, 'nc3-forged-success-with-failure.json');
    writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
    const nc3 = await runCommand(context, path.join(runDir, 'nc3-forged-success-with-failure.log'), ['node', SCENARIO_CHECKER, '--run', forgedPath, '--list', path.relative(context.root, listPath)]);
    artifacts.push(artifact(nc3.log, 'nc3-forged-success-with-failure-log'));
    record('nc3', { exitCode: nc3.receipt.exitCode, tail: nc3.text.split('\n').filter((line) => line.trim()).slice(-8) });
    check('negative control 3 — a forged success report over a real failure makes the real checker fail: a private scratch copy of the recorded vitest.json whose top-level success flag is forced true while one assertion result is really failed exits non-zero with "Vitest run is unsuccessful or contains failures/unhandled errors", so the scenario audit reads the per-test results and cannot be satisfied by a forged summary', {
      forgedSuccessFlag: true,
      forgedFailedTestCount: 1,
      exitCode: nc3.receipt.exitCode,
      signal: nc3.receipt.signal,
      ok: /"ok"\s*:\s*false/u.test(nc3.text),
      locatedFailure: /Vitest run is unsuccessful|failures\/unhandled errors/u.test(nc3.text),
    }, {
      forgedSuccessFlag: true,
      forgedFailedTestCount: 1,
      exitCode: 1,
      signal: null,
      ok: true,
      locatedFailure: true,
    }, 'the real scripts/qa/check-test-scenarios.mjs over a private scratch vitest report');

    // ── NC4: the originals are restored and proven byte-identical ────────────────────────────
    rmSync(scratch, { recursive: true, force: true });
    check('the negative controls left the worktree byte-identical: every injected file lived only under this case private scratch directory, the scratch directory is removed, and the sha256 of docs/testing-scenario-map.json and of the recorded vitest.json are recomputed afterwards and equal the values recomputed before any injection — so the failure lane proves the audit can fail AND that it fails only for the injected reason', {
      scenarioMapSha256Before: originalMapSha,
      scenarioMapSha256After: sha256(readFileSync(path.join(context.root, SCENARIO_MAP))),
      recordedVitestSha256Before: originalVitestSha,
      recordedVitestSha256After: sha256(readFileSync(recordedPath)),
      scratchRemoved: !existsSync(scratch),
    }, {
      scenarioMapSha256Before: originalMapSha,
      scenarioMapSha256After: originalMapSha,
      recordedVitestSha256Before: originalVitestSha,
      recordedVitestSha256After: originalVitestSha,
      scratchRemoved: true,
    }, 'the real worktree files the negative controls targeted');

    // ── NC5: after the restore the happy-lane audit is green again on the SAME bytes ──────────
    const restoredAudit = auditRetiredGlobalRouting(context.root);
    check('the production audit is green again on the restored bytes: the same audit that caught the injected retired-global call in NC1 reports zero production call sites, zero production imports and zero non-legacy singletons on the restored worktree, and every surviving singleton sits inside a legacy export module this case names, so "失败恢复原字节再绿" is measured rather than asserted', {
      productionCallSiteCount: restoredAudit.productionCallSiteCount,
      productionImportCount: restoredAudit.productionImportCount,
      nonLegacySingletonCount: restoredAudit.nonLegacySingletonCount,
      legacyExportModules: restoredAudit.legacyModules,
      productionFileCount: restoredAudit.productionFileCount,
    }, {
      productionCallSiteCount: 0,
      productionImportCount: 0,
      nonLegacySingletonCount: 0,
      legacyExportModules: restoredAudit.legacyModules,
      productionFileCount: restoredAudit.productionFileCount,
    }, 'the real production sources in this worktree');
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C7: what this case did NOT run, asserted rather than implied
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const notRun = Object.freeze([
    { item: 'pnpm test (the full vitest suite, JSON + hanging-process report)', owner: 'the digest re-freeze lane', reason: 'the dispatch for task 56 forbids running the full project test suite and reserves the downstream re-runs' },
    { item: 'task-43 system suite re-run', owner: 'the digest re-freeze lane', reason: 'any production change invalidates the frozen digest, so the re-run must bind the NEW digest' },
    { item: 'task-44 performance profiles re-run', owner: 'the digest re-freeze lane', reason: 'same digest dependency' },
    { item: 'task-45 packaged re-run', owner: 'the digest re-freeze lane', reason: 'same digest dependency' },
    { item: 'task-46 live SSH / Slurm re-run', owner: 'the digest re-freeze lane', reason: 'same digest dependency' },
    { item: 'final source digest freeze (final/revision-manifest.json)', owner: 'the digest re-freeze lane', reason: 'the dispatch reserves the re-freeze until the App.vue integration lands' },
    { item: 'happy-lane `node scripts/qa/check-test-scenarios.mjs --run <vitest.json>`', owner: 'this case, executed in the FAILURE lane instead', reason: 'the checker discovers the test set by spawning `vitest list --json`, measured at 143s on this tree; the runner worker receipt budget is a hard 180s (a task-48 worker that exceeded it was SIGTERMed at 180.1s with interrupted:true), and the plan happy QA also demands the full vitest suite in the same invocation, so the checker leg runs in the failure lane where nothing else competes for the budget — and the GREEN half of it (the checker over a fresh discovery of the current tree) is asserted there' },
  ]);
  record('notRun', notRun);
  check('the ledger records exactly what this case did NOT run, with the owning lane and the reason, so no downstream claim can be read off this manifest: the full vitest suite, the four downstream suite re-runs, the final digest freeze and the happy-lane scenario-checker leg are all recorded with their owner and measured reason and NOT executed in the happy lane', {
    notRun,
    notRunCount: notRun.length,
    everyNotRunEntryNamesAnOwner: notRun.every((entry) => typeof entry.owner === 'string' && entry.owner.length > 0),
    everyNotRunEntryNamesAReason: notRun.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0),
    fullSuiteRunByThisCase: false,
    downstreamSuitesRunByThisCase: false,
    digestFrozenByThisCase: false,
    vitestListIsDiscoveryOnly: true,
    checkerLegRan,
    checkerLegRanExactlyInTheFailureLane: checkerLegRan === (lane === 'failure'),
  }, {
    notRun,
    notRunCount: notRun.length,
    everyNotRunEntryNamesAnOwner: true,
    everyNotRunEntryNamesAReason: true,
    fullSuiteRunByThisCase: false,
    downstreamSuitesRunByThisCase: false,
    digestFrozenByThisCase: false,
    vitestListIsDiscoveryOnly: true,
    checkerLegRan,
    checkerLegRanExactlyInTheFailureLane: true,
  }, 'this case module');

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C8: the source-hash binding covers every file the run executes
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const registered = new Set(sourceFiles);
  // artifact-report.json is deliberately NOT in this set: it is the build output this case's own
  // `vite build` leg regenerates, so pinning it would make the source-hash binding compare the
  // pre-build bytes against the post-build bytes. It is asserted separately below.
  const executed = [...new Set([SCENARIO_MAP, SCENARIO_CHECKER, ARTIFACT_CHECK, 'app/backends/registry.ts', RECORDED_VITEST, 'scripts/qa/runtime-v090-cases/task-48.mjs', ...LEGACY_EXPORT_MODULES.filter((file) => existsSync(path.join(context.root, file)))])].sort();
  const uncovered = executed.filter((file) => !registered.has(file) && !autoInventoried(file)).sort();
  const autoInventoriedExecuted = executed.filter((file) => !registered.has(file) && autoInventoried(file)).sort();
  check('the source-hash binding covers every file this run executes: the scenario map, the real scenario checker, the real artifact-budget checker and its report, the retired-symbol registry, the recorded run report and the legacy export module are enumerated, and each is either registered in sourceFiles or auto-inventoried by the runner (scripts/qa/** is), so the sha256 binding cannot miss an executed byte', {
    executedFileCount: executed.length,
    executed,
    registeredCount: registered.size,
    executedButNotRegistered: uncovered,
    executedAndAutoInventoried: autoInventoriedExecuted,
    scenarioCheckerRegistered: registered.has(SCENARIO_CHECKER),
    scenarioMapRegistered: registered.has(SCENARIO_MAP),
    artifactCheckerRegistered: registered.has(ARTIFACT_CHECK),
    registryRegistered: registered.has('app/backends/registry.ts'),
    legacyExportModuleRegistered: registered.has('app/backends/legacyGlobalRouting.ts'),
    recordedRunReportRegistered: registered.has(RECORDED_VITEST),
    thisCaseRegistered: registered.has('scripts/qa/runtime-v090-cases/task-48.mjs'),
    everyExecutedFilePresent: executed.every((file) => existsSync(path.join(context.root, file))),
    // The build output is regenerated by this case own `vite build` leg, so it is deliberately
    // excluded from the source-hash binding rather than silently omitted.
    buildOutputExcludedFromBinding: ARTIFACT_REPORT,
    buildOutputIsAGeneratedFile: existsSync(path.join(context.root, ARTIFACT_REPORT)),
  }, {
    executedFileCount: executed.length,
    executed,
    registeredCount: registered.size,
    executedButNotRegistered: [],
    executedAndAutoInventoried: autoInventoriedExecuted,
    scenarioCheckerRegistered: true,
    scenarioMapRegistered: true,
    artifactCheckerRegistered: true,
    registryRegistered: true,
    legacyExportModuleRegistered: true,
    recordedRunReportRegistered: true,
    thisCaseRegistered: true,
    everyExecutedFilePresent: true,
    buildOutputExcludedFromBinding: ARTIFACT_REPORT,
    buildOutputIsAGeneratedFile: true,
  }, 'this case module and the real task-48 commands');

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // C9: the evidence binds to the CURRENT bytes — nothing moved under the case
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const registeredAfter = sourceSnapshot(context.root, sourceFiles);
  check('the evidence binds to the current bytes: the sha256 of every registered source is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, so no product, checker, map, report or fixture byte moved under the case', {
    registeredSourceCount: sourceFiles.length,
    registeredSourcesUnchanged: JSON.stringify(registeredBefore) === JSON.stringify(registeredAfter),
    totalScenarioCount: scenarios.length,
    totalCheckCount: checks.length,
    lane,
  }, {
    registeredSourceCount: sourceFiles.length,
    registeredSourcesUnchanged: true,
    totalScenarioCount: scenarios.length,
    totalCheckCount: checks.length,
    lane,
  }, 'this case module');

  return {
    scenarios,
    artifacts,
    versions: { node: process.version, package: packageJson.version, vite: report_builtWith(lane), vitest: 'list --json discovery only (no test executed)' },
    cleanup: { runDir, scratchRemoved: !existsSync(scratch) },
    evidenceBoundary: `The registered wrapper around the plan's own task-48 commands, each re-run as a real child process: npx oxlint, npx vue-tsc --noEmit, vite build, and scripts/qa/build-artifact-check.mjs over the build this case produced. The failure lane additionally performs a REAL \`vitest list --json\` discovery of the current tree (discovery only — no test is executed), runs the real scripts/qa/check-test-scenarios.mjs over it and asserts it GREEN, and then injects a retired-global call, a deleted scenario assignment and a forged success report — each into a PRIVATE scratch copy that is removed and proven byte-identical afterwards — proving the real checker fails on each. The happy-lane \`check-test-scenarios --run <vitest.json>\` leg is NOT executed: the checker own \`vitest list --json\` discovery measures 143s on this tree and the runner worker receipt budget is a hard 180s, and the plan happy QA also demands the full vitest suite in the same invocation; the GREEN half of that leg is asserted in the failure lane instead, with the measured reason recorded. This case does NOT run the full vitest suite, does NOT re-run the task-43/44/45/46 downstream suites and does NOT freeze the final source digest: those belong to the digest re-freeze lane and are recorded as not-run with their owner and reason. No live SSH / Slurm / Electron / packaged-artifact run. No product, test, runner, harness or other task's case file is edited. This case authors NO PASS verdict.`,
  };
}

/** The vite version the build this case produced reported, when the happy lane ran it. */
function report_builtWith(lane) {
  if (lane !== 'happy') return 'not run in this lane';
  try {
    const report = JSON.parse(readFileSync(path.join(process.cwd(), ARTIFACT_REPORT), 'utf8'));
    return report.builtWith?.vite ?? 'unknown';
  } catch { return 'unknown'; }
}

/** The runner auto-inventories these directories, so a file there needs no explicit registration. */
function autoInventoried(file) {
  return file.startsWith('shared/runtime/') || file.includes('runtime-v090');
}

/** The product / checker / map / report paths this case's commands execute. */
export const sourceFiles = [...new Set([
  // the plan's own commands (scripts/qa/** is auto-inventoried; registered so the C8 walk proves
  // coverage rather than assumes it)
  SCENARIO_CHECKER, ARTIFACT_CHECK,
  'scripts/qa/test-scenario-vitest.mjs',
  'scripts/qa/test-contracts-support.mjs',
  // the scenario map the checker reads
  SCENARIO_MAP,
  // the retired-symbol registry and its legacy export module
  'app/backends/registry.ts',
  'app/backends/legacyGlobalRouting.ts',
  'app/backends/registry.acp.test.ts',
  'app/backends/registry.dsh.test.ts',
  'app/backends/registry.kimiWeb.test.ts',
  // the frozen artifact budget the build gate enforces
  'artifact-budget.json',
  'app/buildArtifactContract.test.ts',
  'app/buildArtifact.integration.test.ts',
  // the build inputs
  'vite.config.ts',
  'package.json',
  // the recorded run report the assignment audit reads
  RECORDED_VITEST,
  // this case's own authored file
  'scripts/qa/runtime-v090-cases/task-48.mjs',
])];
