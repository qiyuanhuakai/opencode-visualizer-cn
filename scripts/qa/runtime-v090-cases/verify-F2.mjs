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
const parseVitest = (output) => {
  const filesGreen = /Test Files\s+(\d+) passed \((\d+)\)/.exec(output);
  const filesRed = /Test Files\s+(\d+) failed \((\d+)\)/.exec(output);
  const filesMixed = /Test Files\s+(\d+) failed \| (\d+) passed \((\d+)\)/.exec(output);
  const testsGreen = /Tests\s+(\d+) passed \((\d+)\)/.exec(output);
  const testsRed = /Tests\s+(\d+) failed \| (\d+) passed \((\d+)\)/.exec(output);
  return {
    testFilesPassed: filesGreen ? Number(filesGreen[1]) : filesRed ? 0 : filesMixed ? Number(filesMixed[2]) : null,
    testFilesFailed: filesRed ? Number(filesRed[1]) : filesMixed ? Number(filesMixed[1]) : 0,
    testFilesTotal: filesGreen ? Number(filesGreen[2]) : filesRed ? Number(filesRed[2]) : filesMixed ? Number(filesMixed[3]) : null,
    testsPassed: testsGreen ? Number(testsGreen[1]) : testsRed ? Number(testsRed[2]) : null,
    testsFailed: testsRed ? Number(testsRed[1]) : 0,
    testsTotal: testsGreen ? Number(testsGreen[2]) : testsRed ? Number(testsRed[3]) : null,
  };
};

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
    const risk = runTool(['vitest', 'run', ...RISK_FILES], { cwd: root });
    writeFileSync(path.join(detailDir, 'risk-cases.log'), `${risk.stdout}${risk.stderr}`);
    const riskParsed = parseVitest(`${risk.stdout}${risk.stderr}`);
    check('the risk-case collection passes in full: the 20 test files covering all eight review areas (identity/host scope, migration secret, DB queue/ack/fencing, SSH argv/hostkey, relay/Slurm owned resources, artifact dirty target, native capabilities, old global routing) run green with zero failures', { exitCode: risk.exitCode, files: RISK_FILES.length, ...riskParsed, failed: riskParsed.testsFailed }, { exitCode: 0, files: 20, testFilesPassed: 20, testFilesFailed: 0, testFilesTotal: 20, testsPassed: 389, testsFailed: 0, testsTotal: 389, failed: 0 }, 'the real Vitest risk collection executed by this module; automated checks do not replace the code review recorded in final/DoneClaim.json');

    // The vue-tsc log is legitimately empty (clean output) and the evidence helper refuses empty
    // artifacts, so the empty-output proof lives in the assertion's outputBytes: 0 instead.
    artifacts.push(artifact(path.join(detailDir, 'oxlint.log'), 'f2-oxlint-log'), artifact(path.join(detailDir, 'risk-cases.log'), 'f2-risk-cases-log'));
    return {
      scenario: 'F2 code quality review — automated gates on the delivered tree',
      verdict: 'APPROVE (automated legs; the code review itself is final/DoneClaim.json)',
      oxlintWarnings: oxlintCounts.warnings,
      reviewAreas: {
        identityHostScope: 'PASS', migrationSecret: 'PASS', dbQueueAckFencing: 'PASS', sshArgvHostKey: 'PASS',
        relaySlurmOwnedResources: 'PASS', artifactDirtyTarget: 'PASS', nativeCapabilities: 'PASS', oldGlobalRouting: 'PASS',
      },
      codeReviewRecord: 'final/DoneClaim.json (F2 lane): APPROVE WITH ONE BLOCKER OUTSIDE THE CODE — the missing verify-F*.mjs registrations and the parseSelector rejection that this task (54) closes; 12 LOW findings, none blocking; automated checks are not a substitute for the code review.',
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
    const run = runTool(['vitest', 'run', ...files], { cwd: sandbox });
    const output = `${run.stdout}${run.stderr}`;
    writeFileSync(path.join(detailDir, `${label}.log`), output);
    return { exitCode: run.exitCode, ...parseVitest(output) };
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
  check('the temporary copy faithfully reproduces the green baseline before any fault is injected, so a later non-zero exit is attributable to the injected fault and not to a broken copy', baseline, { exitCode: 0, testFilesPassed: 2, testFilesFailed: 0, testFilesTotal: 2, testsPassed: 42, testsFailed: 0, testsTotal: 42 }, 'npx vitest run over the two real regression files inside the sandbox copy');

  // 2 — each fault alone, then both together: each must make the real regression non-zero.
  const injections = [];
  for (const fault of FAULTS) {
    applyFault(fault);
    const run = runRegression([fault.regression], fault.id);
    restoreFault(fault);
    assert(run.exitCode !== 0, `fault ${fault.id} did NOT make the real regression fail — the injection is vacuous`);
    assert(run.testsFailed > 0, `fault ${fault.id} exited non-zero without a failed test`);
    assert(new RegExp(fault.expectedFailureMarker).test(readFileSync(path.join(detailDir, `${fault.id}.log`), 'utf8')), `fault ${fault.id} log does not contain the expected failure marker ${fault.expectedFailureMarker}`);
    injections.push({ id: fault.id, file: fault.file, exitCode: run.exitCode, testsFailed: run.testsFailed, testsPassed: run.testsPassed, testsTotal: run.testsTotal });
  }
  check('fault A (cross-target routing) makes the real regression non-zero: with the login-fallback guard removed from relayHandshake.js the regression that proves every FS/Git/PTY/driver operation targets the compute node and rejects a login fallback fails', injections[0], { id: 'faultA-cross-target-routing', file: 'bridge/runtime/transports/relayHandshake.js', exitCode: 1, testsFailed: 2, testsPassed: 29, testsTotal: 31 }, 'the injected fault plus the real app/runtime/slurmTransport.test.ts inside the copy');
  check('fault B (ignored dirty target) makes the real regression non-zero: with the target-clean re-check disabled in integrationService.js the regression that proves a dirty target fails the integration and preserves the artifact fails', injections[1], { id: 'faultB-ignored-dirty-target', file: 'bridge/runtime/collaboration/integrationService.js', exitCode: 1, testsFailed: 3, testsPassed: 8, testsTotal: 11 }, 'the injected fault plus the real app/runtime/artifactIntegration.test.ts inside the copy');

  for (const fault of FAULTS) applyFault(fault);
  const both = runRegression(regressionFiles, 'both-faults');
  for (const fault of FAULTS) restoreFault(fault);
  assert(both.exitCode !== 0 && both.testsFailed === 5, 'both faults together did not reproduce the recorded red');
  check('both faults together keep the combined regression non-zero', both, { exitCode: 1, testFilesPassed: 0, testFilesFailed: 2, testFilesTotal: 2, testsPassed: 37, testsFailed: 5, testsTotal: 42 }, 'both injected faults plus both real regression files inside the copy');

  // 3 — restore and prove GREEN again, with a sha256 proof of byte-identical restoration.
  const restored = runRegression(regressionFiles, 'post-restore');
  const restoredHashes = Object.fromEntries(FAULTS.map((fault) => [fault.file, { copy: sha256(path.join(sandbox, fault.file)), worktree: sha256(path.join(root, fault.file)) }]));
  const byteIdentical = FAULTS.every((fault) => restoredHashes[fault.file].copy === restoredHashes[fault.file].worktree);
  check('after restoring the pristine bytes the regression is GREEN again and every mutated file is byte-identical to the worktree (RED proven, then GREEN restored — the failure case genuinely fails when the fault is present)', { ...restored, byteIdentical, restoredHashes }, { exitCode: 0, testFilesPassed: 2, testFilesFailed: 0, testFilesTotal: 2, testsPassed: 42, testsFailed: 0, testsTotal: 42, byteIdentical: true, restoredHashes }, 'the restored copy plus the real regression files, and a sha256 comparison of the two mutation targets against the pristine worktree bytes');

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
