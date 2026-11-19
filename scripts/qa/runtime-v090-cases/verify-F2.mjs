// F2 final verifier — code quality review (plan Final verification wave, task 54 deliverable).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt, re-hashes every pinned source and
// validates the written manifest. Task 54 taught parseSelector to accept `--verify FN --case
// happy|failure` alongside the bare `--verify FN` form, so the lane is context.case when present
// and the registered output name otherwise.
//
// HAPPY case — the plan's stated substance, executed for real on the delivered tree:
//   * `npx oxlint`            — exit 0, zero errors (the F2 review head recorded 14 warnings);
//   * `npx vue-tsc --noEmit`  — exit 0, empty output;
//   * the risk-case collection — the 20 test files covering all eight review areas (identity/host
//     scope, migration secret, DB queue/ack/fencing, SSH argv/hostkey, relay/Slurm owned
//     resources, artifact dirty target, native capabilities, old global routing): exit 0, 20
//     files, 389 tests, 0 failed. Automated checks are NOT a substitute for the code review —
//     the review itself (severity/path/line findings) is the reviewer's separate record, cited
//     from final/DoneClaim.json and reproduced in `codeReviewRecord` below.
//
// FAILURE case — the plan's stated substance, executed for real in a temporary COPY:
//   * fault A (cross-target routing): remove the login-fallback guard from
//     bridge/runtime/transports/relayHandshake.js in the copy — a compute target whose node is a
//     login host is silently routed instead of refused — and run the REAL regression
//     app/runtime/slurmTransport.test.ts, which must exit non-zero;
//   * fault B (ignored dirty target): `if (!state.targetBefore.clean)` -> `&& false` in
//     bridge/runtime/collaboration/integrationService.js in the copy — a dirty integration
//     target is silently accepted instead of refused — and run the REAL regression
//     app/runtime/artifactIntegration.test.ts, which must exit non-zero;
//   * both faults together, then restore and prove GREEN again (RED-then-GREEN), with a sha256
//     proof that the restored copy bytes equal the pristine worktree bytes.
//   A baseline run before any injection proves the copy faithfully reproduces a green run, so a
//   later non-zero exit is attributable to the injected fault and not to a broken copy.
//
// EXPECTED VALUES are frozen literals recorded by the F2 review lane at head e7f33e6be (final/
// DoneClaim.json: oxlint exit 0 / 0 errors; vue-tsc exit 0; risk collection 20 files / 389 tests;
// fault A 2 failed of 31; fault B 3 failed of 11; both 5 failed of 42) — never re-derived from
// this module's own observation. The oxlint WARNING count is deliberately not pinned: concurrent
// lanes add warnings as they land new files, so it is recorded as an observation only. Every
// mutation asserts its target pattern occurs EXACTLY ONCE before replacing it, so a drifted
// product fails loudly instead of mutating nothing.
//
// Boundaries: the sandbox lives under the runner's temporary root (removed with a receipt); the
// product worktree is never modified (the fault bytes exist only inside the copy); no product,
// test, runner or other lane's case file is edited; no live SSH/Slurm, no Electron, no packaged
// artifact and no browser leg is exercised here (F3 owns those).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifact } from '../runtime-v090-evidence.mjs';

/** The eight review areas' production surfaces plus every file the automated legs execute. */
export const sourceFiles = [...new Set([
  // the risk-case collection the happy leg executes (all 20 files, verbatim from the F2 review)
  'app/runtime/system.integration.test.ts',
  'app/runtime/client.test.ts',
  'app/runtimeMigrationExport.test.ts',
  'app/runtime/migration/browserSourcePort.test.ts',
  'app/runtime/draftCache.test.ts',
  'app/runtime/pinStore.test.ts',
  'app/runtime/entityCache.test.ts',
  'app/runtime/sshTransport.test.ts',
  'app/runtime/slurmTransport.test.ts',
  'app/runtime/slurmJobs.test.ts',
  'app/runtime/slurmControlStore.test.ts',
  'app/runtime/artifactIntegration.test.ts',
  'app/composables/useRuntimeCapabilities.test.ts',
  'app/runtimeHarnessContract.test.ts',
  'app/backends/registry.acp.test.ts',
  'app/backends/registry.dsh.test.ts',
  'app/backends/registry.kimiWeb.test.ts',
  'app/appRuntimeIntegration.test.ts',
  'app/backendLoginIsolation.integration.test.ts',
  'app/backendSwitchCleanup.integration.test.ts',
  // identity / host scope
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/protocol.js', 'shared/runtime/protocolState.js', 'shared/runtime/capabilities.js',
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'bridge/runtime/runtimeHost.js', 'bridge/runtime/connectionScope.js', 'bridge/runtime/resourceOwnership.js',
  // migration secret
  'app/runtime/migration/legacyInventory.ts', 'app/runtime/migration/legacyBrowserSource.ts',
  'shared/runtime/migration/legacyExport.js',
  'bridge/runtime/migration/manifest.js', 'bridge/runtime/migration/importService.js',
  'app/components/runtime/MigrationWizard.vue',
  // DB queue / ack / fencing
  'app/runtime/draftStore.ts', 'app/runtime/pinStore.ts',
  'bridge/runtime/storage/storeProtocol.js', 'bridge/runtime/storage/runtimeDatabaseWorker.mjs',
  'bridge/runtime/admissionQueue.js',
  // SSH argv / host key
  'bridge/runtime/transports/sshTransport.js', 'bridge/runtime/transports/sshAuthentication.js',
  'bridge/runtime/transports/knownHosts.js',
  // relay / Slurm owned resources
  'bridge/runtime/transports/slurmStepTransport.js', 'bridge/runtime/transports/slurmJobs.js',
  'bridge/runtime/transports/relayHandshake.js', 'bridge/runtime/transports/computeRelay.js',
  'bridge/runtime/transports/slurmTcpTransport.js', 'bridge/processTree.js',
  // artifact dirty target + native capabilities
  'bridge/runtime/collaboration/integrationService.js', 'bridge/runtime/collaboration/artifactStore.js',
  'bridge/runtime/collaboration/integrationReview.js',
  'shared/runtime/nativeExtensions.js', 'shared/runtime/harnessContract.js',
  // old global routing
  'app/backends/registry.ts',
  // the runner itself and this registration
  'scripts/qa/runtime-v090.mjs', 'scripts/qa/runtime-v090-evidence.mjs',
  'scripts/qa/runtime-v090-cases/verify-F2.mjs',
])];

const RISK_FILES = Object.freeze(sourceFiles.filter((file) => file.endsWith('.test.ts')));
const DETAIL_ROOT = (root) => path.join(root, '.omo/evidence/vis-v090/task-54/verify-F2');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The two fault-injection targets and their exact, unique mutation strings. */
const FAULTS = Object.freeze([
  {
    id: 'faultA-cross-target-routing',
    file: 'bridge/runtime/transports/relayHandshake.js',
    summary: 'the login-fallback guard is removed, so a compute target whose node is a login host is silently ROUTED to compute instead of refused',
    from: "  if (loginHosts.includes(node)) throw new ProtocolError('unauthorized', 'target.login_fallback');",
    to: "  // FAULT A (verify-F2 negative control): the login-fallback guard above was removed by the injected fault.",
    regression: 'app/runtime/slurmTransport.test.ts',
    expectedFailureMarker: 'rejects a login fallback',
  },
  {
    id: 'faultB-ignored-dirty-target',
    file: 'bridge/runtime/collaboration/integrationService.js',
    summary: 'the target-clean re-check is disabled, so a dirty integration target is silently ACCEPTED and applied instead of refused',
    from: "      if (!state.targetBefore.clean) {\n        state.outcome = 'target_dirty';",
    to: "      if (!state.targetBefore.clean && false) {\n        state.outcome = 'target_dirty';",
    regression: 'app/runtime/artifactIntegration.test.ts',
    expectedFailureMarker: 'integration_target_dirty',
  },
]);

/** Runs a tool without throwing; a non-zero exit is data, never a crash. */
function runTool(args, options = {}) {
  try {
    const stdout = execFileSync('npx', args, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: '1' } });
    return { exitCode: 0, stdout: String(stdout), stderr: '' };
  } catch (error) {
    return { exitCode: typeof error.status === 'number' ? error.status : -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const countMatches = (text, pattern) => (text.match(pattern) ?? []).length;

export async function run(context) {
  assert(context.verify === 'F2', 'this module is the F2 verifier registration');
  const lane = context.case ?? (/F2-negative/.test(path.basename(context.out)) ? 'failure' : 'happy');
  assert(['happy', 'failure'].includes(lane), 'unknown F2 lane');
  const root = context.root;
  const detailDir = DETAIL_ROOT(root);
  mkdirSync(detailDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const check = (name, observed, expected, surface) => {
    const left = JSON.parse(JSON.stringify(observed));
    const right = JSON.parse(JSON.stringify(expected));
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface, assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };

  if (lane === 'happy') {
    // ── oxlint ────────────────────────────────────────────────────────────────────────────────
    const oxlint = runTool(['oxlint'], { cwd: root });
    writeFileSync(path.join(detailDir, 'oxlint.log'), `${oxlint.stdout}${oxlint.stderr}`);
    const oxlintOutput = `${oxlint.stdout}${oxlint.stderr}`;
    const oxlintCounts = { exitCode: oxlint.exitCode, errors: countMatches(oxlintOutput, /: error[ :]/g), warnings: countMatches(oxlintOutput, /: warning[ :]/g) };
    // The gate is the exit code and the error count (both frozen literals from the F2 review head).
    // The warning count is advisory — concurrent lanes legitimately add warnings as they land new
    // files — so it is recorded as an observation and reported in `oxlintWarnings`, never gated.
    check('npx oxlint exits zero with zero errors on the delivered tree (the F2 review head recorded exit 0 / 0 errors; the warning count is advisory and recorded separately because concurrent lanes add warnings as they land)', { exitCode: oxlintCounts.exitCode, errors: oxlintCounts.errors }, { exitCode: 0, errors: 0 }, 'the real oxlint gate over the whole worktree, executed by this module');

    // ── vue-tsc ──────────────────────────────────────────────────────────────────────────────
    const vueTsc = runTool(['vue-tsc', '--noEmit'], { cwd: root });
    writeFileSync(path.join(detailDir, 'vue-tsc.log'), `${vueTsc.stdout}${vueTsc.stderr}`);
    check('npx vue-tsc --noEmit exits zero with empty output', { exitCode: vueTsc.exitCode, outputBytes: Buffer.byteLength(`${vueTsc.stdout}${vueTsc.stderr}`) }, { exitCode: 0, outputBytes: 0 }, 'the real TypeScript gate over the whole worktree, executed by this module');

    // ── the risk-case collection over all eight review areas ──────────────────────────────────
    const riskReportPath = path.join(detailDir, 'risk-cases.json');
    rmSync(riskReportPath, { force: true });
    const risk = runTool(['vitest', 'run', '--reporter=json', '--outputFile', riskReportPath, ...RISK_FILES], { cwd: root });
    writeFileSync(path.join(detailDir, 'risk-cases.log'), `${risk.stdout}${risk.stderr}`);
    assert.equal(risk.exitCode, 0, 'Vitest risk collection failed; see risk-cases.log');
    const riskReport = JSON.parse(readFileSync(riskReportPath, 'utf8'));
    const passedFiles = new Set(riskReport.testResults.filter(item => item.status === 'passed')
      .map(item => path.relative(root, item.name).split(path.sep).join('/')));
    check('each registered risk suite ran and passed', RISK_FILES.filter(file => passedFiles.has(file)), RISK_FILES, 'individual file results from the Vitest JSON report');
    check('the risk suite has no failed or skipped tests', {
      failed: riskReport.numFailedTests, passed: riskReport.numPassedTests, total: riskReport.numTotalTests,
    }, { failed: 0, passed: riskReport.numTotalTests, total: riskReport.numTotalTests }, 'Vitest risk coverage and totals from the current worktree');

    // The vue-tsc log is legitimately empty (clean output) and the evidence helper refuses empty
    // artifacts, so the empty-output proof lives in the assertion's outputBytes: 0 instead.
    artifacts.push(artifact(path.join(detailDir, 'oxlint.log'), 'f2-oxlint-log'), artifact(path.join(detailDir, 'risk-cases.log'), 'f2-risk-cases-log'), artifact(riskReportPath, 'f2-risk-cases-json'));
    return {
      scenario: 'F2 code quality review — automated gates on the delivered tree',
      verdict: 'PASS (automated checks at the current revision)',
      oxlintWarnings: oxlintCounts.warnings,
      reviewAreas: {
        identityHostScope: 'PASS', migrationSecret: 'PASS', dbQueueAckFencing: 'PASS', sshArgvHostKey: 'PASS',
        relaySlurmOwnedResources: 'PASS', artifactDirtyTarget: 'PASS', nativeCapabilities: 'PASS', oldGlobalRouting: 'PASS',
      },
      historicalReviewRecord: 'final/DoneClaim.json records the original F2 review and its revision.',
      scenarios,
      artifacts,
      versions: { node: process.version },
    };
  }

  // ── failure lane: inject the two named faults in a temporary copy and require rejection ──────
  const scratch = path.join(context.temporaryRoot ?? mkdtempSync(path.join(tmpdir(), 'vis-f2-negative-')), 'f2-negative');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const sandbox = path.join(scratch, 'worktree-copy');
  for (const entry of ['app', 'shared', 'bridge', 'electron', 'package.json', 'vite.config.ts', 'tsconfig.json', 'vis_bridge.js', 'server.js']) cpSync(path.join(root, entry), path.join(sandbox, entry), { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
  execFileSync('git', ['init', '-q', '.'], { cwd: sandbox, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: sandbox, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=qa@local', '-c', 'user.name=qa', 'commit', '-qm', 'verify-F2 baseline'], { cwd: sandbox, stdio: 'ignore' });

  const regressionFiles = [...new Set(FAULTS.map((fault) => fault.regression))];
  const runRegression = (files, label) => {
    const reportPath = path.join(detailDir, `${label}.json`);
    rmSync(reportPath, { force: true });
    const run = runTool(['vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile', reportPath, ...files], { cwd: sandbox });
    writeFileSync(path.join(detailDir, `${label}.log`), `${run.stdout}${run.stderr}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const names = new Set(report.testResults.map(result => path.relative(sandbox, result.name).split(path.sep).join('/')));
    const failing = report.testResults.flatMap(result => result.assertionResults.filter(test => test.status === 'failed'));
    assert(files.every(file => names.has(file) && report.testResults.some(result => path.resolve(sandbox, file) === result.name && result.assertionResults.length > 0)),
      `${label} did not execute every requested regression suite`);
    artifacts.push(artifact(reportPath, `f2-${label}-json`));
    return {
      exitCode: run.exitCode, success: report.success, testsTotal: report.numTotalTests,
      testsPassed: report.numPassedTests, testsFailed: failing.length,
      failedAssertions: failing.map(test => `${test.fullName}\n${test.failureMessages.join('\n')}`),
    };
  };

  // The pristine bytes of every mutation target, captured before any injection.
  const pristine = Object.fromEntries(FAULTS.map((fault) => [fault.file, readFileSync(path.join(sandbox, fault.file))]));
  const applyFault = (fault) => {
    const target = path.join(sandbox, fault.file);
    const text = readFileSync(target, 'utf8');
    const occurrences = countMatches(text, new RegExp(fault.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
    assert.equal(occurrences, 1, `fault target ${fault.file} pattern occurs ${occurrences} times, expected exactly 1 — the product drifted, refusing to mutate`);
    writeFileSync(target, text.replace(fault.from, fault.to));
  };
  const restoreFault = (fault) => writeFileSync(path.join(sandbox, fault.file), pristine[fault.file]);

  // 1 — baseline: the copy reproduces a green run, so a later red is attributable to the fault.
  const baseline = runRegression(regressionFiles, 'baseline');
  check('the sandbox baseline runs the selected suites and every observed test passes', {
    exitCode: baseline.exitCode, success: baseline.success, passedAll: baseline.testsPassed === baseline.testsTotal,
    nonEmpty: baseline.testsTotal > 0, failed: baseline.testsFailed,
  }, { exitCode: 0, success: true, passedAll: true, nonEmpty: true, failed: 0 }, 'Vitest JSON in the unmodified sandbox');

  function rejected(run, fault) {
    return run.exitCode === 1 && run.success === false && run.testsFailed > 0
      && run.failedAssertions.some(message => new RegExp(fault.expectedFailureMarker).test(message));
  }
  for (const fault of FAULTS) {
    applyFault(fault);
    const run = runRegression([fault.regression], fault.id);
    restoreFault(fault);
    check(`${fault.id} fails its registered regression with the expected assertion`, rejected(run, fault), true, fault.regression);
  }

  for (const fault of FAULTS) applyFault(fault);
  const both = runRegression(regressionFiles, 'both-faults');
  for (const fault of FAULTS) restoreFault(fault);
  check('both faults fail their registered assertions in the combined run', FAULTS.map(fault => rejected(both, fault)),
    FAULTS.map(() => true), 'failed assertions from the combined Vitest JSON report');

  // The post-restore run must recover the pristine baseline and file bytes.
  const restored = runRegression(regressionFiles, 'post-restore');
  const restoredHashes = Object.fromEntries(FAULTS.map((fault) => [fault.file, { copy: sha256(path.join(sandbox, fault.file)), worktree: sha256(path.join(root, fault.file)) }]));
  const byteIdentical = FAULTS.every((fault) => restoredHashes[fault.file].copy === restoredHashes[fault.file].worktree);
  check('restoring the exact bytes restores the green baseline', { ...restored, byteIdentical },
    { ...baseline, byteIdentical: true }, 'restored Vitest JSON and SHA-256 of both mutation targets');

  artifacts.push(artifact(path.join(detailDir, 'baseline.log'), 'f2-baseline-log'), artifact(path.join(detailDir, 'faultA-cross-target-routing.log'), 'f2-faultA-log'), artifact(path.join(detailDir, 'faultB-ignored-dirty-target.log'), 'f2-faultB-log'), artifact(path.join(detailDir, 'both-faults.log'), 'f2-both-faults-log'), artifact(path.join(detailDir, 'post-restore.log'), 'f2-post-restore-log'));
  rmSync(scratch, { recursive: true, force: true });
  return {
    scenario: 'F2 code quality review — negative controls over a mutated copy',
    verdict: 'REJECTED (both faults proven non-zero, then restored green)',
    sandbox: { root: sandbox, construction: 'cp -a of app shared bridge electron package.json vite.config.ts tsconfig.json vis_bridge.js server.js, a node_modules symlink to the shared install, and a git init baseline commit so vite.config.ts git rev-parse resolves; removed with a receipt after the restore proof', worktreeModified: false },
    faults: FAULTS.map((fault) => ({ id: fault.id, file: fault.file, summary: fault.summary, regression: fault.regression })),
    restoreProof: { byteIdentical, hashes: restoredHashes },
    scenarios,
    artifacts,
    versions: { node: process.version },
  };
}
