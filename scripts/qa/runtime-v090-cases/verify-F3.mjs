// F3 runs the current system and fault fixtures and audits the candidate's
// captured desktop, browser, packaging and live transport evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { artifact, validateEvidence } from '../runtime-v090-evidence.mjs';
import { sourceFiles as FAULTS_SOURCE_FILES, runFaults } from '../runtime-v090-faults.mjs';
import { sourceFiles as SYSTEM_SOURCE_FILES, runSystem } from '../runtime-v090-system.mjs';
import { FAULT_SCENARIOS } from '../../../app/dev/runtime-v090/system43-mapping.mjs';

/** Both harnesses' registrations merged — the task-43 load-bearing lesson, applied to this lane. */
export const sourceFiles = [...new Set([
  ...SYSTEM_SOURCE_FILES,
  ...FAULTS_SOURCE_FILES,
  'scripts/qa/runtime-v090.mjs',
  'scripts/qa/runtime-v090-evidence.mjs',
  'scripts/qa/runtime-v090-cases/verify-F3.mjs',
])];

const DETAIL_ROOT = (root) => path.join(root, '.omo/evidence/vis-v090/task-54/verify-F3');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The nine screenshots the F3 lane captured, with their independently decoded IHDR shapes. */
const SCREENSHOTS = Object.freeze([
  { file: 'F3-anime-dream-desktop-1440.png', width: 1440, height: 900, viewport: 'desktop-1440', theme: 'anime-dream' },
  { file: 'F3-anime-dream-mobile-390.png', width: 390, height: 844, viewport: 'mobile-390', theme: 'anime-dream' },
  { file: 'F3-anime-night-desktop-1440.png', width: 1440, height: 900, viewport: 'desktop-1440', theme: 'anime-night' },
  { file: 'F3-anime-night-mobile-390.png', width: 390, height: 844, viewport: 'mobile-390', theme: 'anime-night' },
  { file: 'F3-soft-white-desktop-1440.png', width: 1440, height: 900, viewport: 'desktop-1440', theme: 'soft-white' },
  { file: 'F3-soft-white-mobile-390.png', width: 390, height: 844, viewport: 'mobile-390', theme: 'soft-white' },
  { file: 'F3-electron-desktop.png', width: 1400, height: 870, viewport: 'desktop-electron-cdp', theme: 'packaged-app' },
  { file: 'F3-five-source-tree-1440.png', width: 1440, height: 900, viewport: 'desktop-1440', theme: 'five-source-tree' },
  { file: 'F3-thread-handoff-1440.png', width: 1440, height: 900, viewport: 'desktop-1440', theme: 'thread-handoff' },
]);

/** The live SSH / Slurm legs and the task-43 runner-bound manifests, with frozen scenario counts. */
const LIVE_REPORTS = Object.freeze([
  { file: 'F3-ssh-live.json', lane: 'live-ssh-happy', scenarios: 14, exitCode: null },
  { file: 'F3-ssh-failure.json', lane: 'live-ssh-failure', scenarios: 21, exitCode: null },
  { file: 'F3-slurm-live.json', lane: 'live-slurm-happy', scenarios: 39, exitCode: null },
  { file: 'F3-slurm-failure.json', lane: 'live-slurm-failure', scenarios: 48, exitCode: null },
  { file: 'F3-task43-happy.json', lane: 'task-43-happy-runner-bound', scenarios: 18, exitCode: 0 },
  { file: 'F3-task43-failure.json', lane: 'task-43-failure-runner-bound', scenarios: 17, exitCode: 0 },
  { file: 'task-41/failure.json', lane: 'artifact-dirty-target-refusal', scenarios: 16, exitCode: 0, atEvidenceRoot: true },
]);

/** A report path: final/ for this lane's own directory, the evidence root for a task lane's. */
const reportPath = (evidenceRoot, finalDir, entry) => path.join(entry.atEvidenceRoot ? evidenceRoot : finalDir, entry.file);

const pngShape = (file) => {
  const bytes = readFileSync(file);
  assert.equal(bytes.readUInt32BE(0), 0x89504e47, 'not a PNG (signature)');
  assert.equal(bytes.toString('latin1', 12, 16), 'IHDR', 'missing IHDR chunk');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, sha256: sha256(file) };
};
const reportShape = (file) => {
  const manifest = readJson(file);
  return { status: manifest.status ?? null, scenarios: manifest.scenarioCount ?? (Array.isArray(manifest.scenarios) ? manifest.scenarios.length : null), assertions: manifest.assertions ?? manifest.assertionCount ?? null, exitCode: manifest.exitCode ?? null };
};

export async function run(context) {
  assert(context.verify === 'F3', 'this module is the F3 verifier registration');
  const lane = context.case ?? (/F3-negative/.test(path.basename(context.out)) ? 'failure' : 'happy');
  assert(['happy', 'failure'].includes(lane), 'unknown F3 lane');
  const root = context.root;
  const evidenceRoot = context.evidenceRoot ?? path.join(root, '.omo/evidence/vis-v090');
  const finalDir = path.join(evidenceRoot, 'final');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const revision = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'F3 requires the tracked candidate checkout');
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

  // The F3 lane's preserved evidence document (final/F3.json is this lane's own output path).
  const manualDoc = path.join(evidenceRoot, 'task-54/F3-manual.json');
  assert(existsSync(manualDoc), `the F3 lane's preserved evidence document is missing: ${manualDoc}`);
  const manual = readJson(manualDoc);
  check('manual observations bind the candidate commit and tree', { revision: manual.productionRevision ?? null, tree: manual.productionTree ?? null }, { revision, tree }, manualDoc);
  artifacts.push(artifact(manualDoc, 'f3-manual-observations'));
  const checkCaptured = (file) => {
    const rel = path.relative(evidenceRoot, file);
    const actual = artifact(file, 'f3-captured-input');
    assert.equal(actual.sha256, manual.captures?.[rel], `manual capture hash mismatch: ${rel}`);
    artifacts.push(actual);
  };
  for (const shot of SCREENSHOTS) checkCaptured(path.join(finalDir, shot.file));
  for (const entry of LIVE_REPORTS) checkCaptured(reportPath(evidenceRoot, finalDir, entry));
  checkCaptured(path.join(finalDir, 'F3-slurm-lab-descriptor.json'));
  const runnerReport = (file, task, reportLane) => {
    const report = readJson(file);
    validateEvidence(report, root);
    assert.equal(report.productionRevision, revision, `candidate revision mismatch: ${file}`);
    assert.equal(report.selector.task, task, `task mismatch: ${file}`);
    assert.equal(report.selector.case, reportLane, `case mismatch: ${file}`);
    artifacts.push(artifact(file, 'f3-runner-manifest'));
    return report;
  };
  runnerReport(path.join(finalDir, 'F3-task43-happy.json'), 43, 'happy');
  runnerReport(path.join(finalDir, 'F3-task43-failure.json'), 43, 'failure');
  runnerReport(path.join(evidenceRoot, 'task-41/failure.json'), 41, 'failure');
  const packaged = runnerReport(path.join(evidenceRoot, 'task-48/task-45-happy.json'), 45, 'happy');
  for (const liveLane of ['happy', 'failure']) {
    const live = runnerReport(path.join(evidenceRoot, `task-48/task-46-${liveLane}.json`), 46, liveLane);
    const suffix = liveLane === 'happy' ? 'live' : 'failure';
    for (const transport of ['ssh', 'slurm']) {
      const entries = live.artifacts.filter((entry) => entry.kind === `live-${transport}-report`);
      assert.equal(entries.length, 1, `expected one ${transport} report for ${liveLane}`);
      assert.equal(entries[0].sha256, sha256(path.join(finalDir, `F3-${transport}-${suffix}.json`)), `captured ${transport} report differs from the candidate receipt`);
    }
  }


  // ── the landed screenshots: proven real by an independent PNG decode ────────────────────────
  const decoded = SCREENSHOTS.map((shot) => ({ ...shot, ...pngShape(path.join(finalDir, shot.file)) }));
  const distinctHashes = new Set(decoded.map((shot) => shot.sha256)).size;
  check('the nine F3 screenshot files have PNG headers whose IHDR dimensions match the captured viewport exactly (3 themes x desktop 1440 / mobile 390, the packaged Electron CDP window, the five-source tree and the thread handoff)', decoded.map((shot) => ({ file: shot.file, viewport: shot.viewport, theme: shot.theme, width: shot.width, height: shot.height })), SCREENSHOTS.map((shot) => ({ file: shot.file, viewport: shot.viewport, theme: shot.theme, width: shot.width, height: shot.height })), 'independent PNG IHDR decode of the nine landed screenshots against the frozen dimensions the F3 lane recorded');
  check('every screenshot is a distinct, non-trivial capture', { distinctHashes, everyShotAtLeast20KiB: decoded.every((shot) => shot.bytes >= 20 * 1024) }, { distinctHashes: 9, everyShotAtLeast20KiB: true }, 'sha256 distinctness and a 20KiB size floor over the nine decoded screenshots');

  // ── the live SSH / Slurm legs, the lab and the runner-bound task-43 manifests ───────────────
  const reports = LIVE_REPORTS.map((entry) => ({ ...entry, ...reportShape(reportPath(evidenceRoot, finalDir, entry)) }));
  check('every live and runner-bound F3 report is green at its frozen scenario count: real SSH happy 14/14 and failure 21/21 (the changed host key included), real Slurm happy 39/39 and failure 48/48, the runner-bound task-43 happy 18/18 and failure 17/17 at this head, and the task-41 artifact dirty-target refusal 16/16', reports.map((row) => ({ file: row.file, lane: row.lane, status: row.status, scenarios: row.scenarios, assertions: row.assertions, exitCode: row.exitCode })), LIVE_REPORTS.map((entry) => ({ file: entry.file, lane: entry.lane, status: 'passed', scenarios: entry.scenarios, assertions: entry.scenarios, exitCode: entry.exitCode })), 'scenario-level read of every landed F3 report against the F3 lane\'s recorded counts');
  const lab = readJson(path.join(finalDir, 'F3-slurm-lab-descriptor.json'));
  const labNodes = Object.values(lab.namespaces);
  check('the real Slurm lab descriptor is the real four-namespace cluster: one controller, one login and two compute nodes, each compute node with its full 4 CPU / 512 MiB / gpu:2 budget', { runtime: lab.runtime, roles: labNodes.map((node) => node.role).sort(), computeNodes: labNodes.filter((node) => node.role === 'compute').map((node) => ({ host: node.host, cpus: node.cpus, memoryMiB: node.memoryMiB, gres: node.gres })) }, { runtime: 'docker', roles: ['compute', 'compute', 'controller', 'login'], computeNodes: [{ host: 'vislab-cn1', cpus: 4, memoryMiB: 512, gres: 2 }, { host: 'vislab-cn2', cpus: 4, memoryMiB: 512, gres: 2 }] }, 'the real lab descriptor the F3 lane produced from the privileged ubuntu:24.04 container');

  // ── the packaged Electron binary's REGISTERED CDP address and the packaged bridge ───────────
  const electron = manual.electron;
  assert(path.isAbsolute(electron.binaryPath), 'record the absolute path of the captured Electron executable');
  const electronBinary = artifact(electron.binaryPath, 'f3-electron-executable');
  check('the captured Electron executable matches its recorded hash and CDP registration', {
    sha256: electronBinary.sha256,
    bytes: statSync(electron.binaryPath).size,
    address: /^127\.0\.0\.1:\d+$/.test(electron.registered.address),
    browserPath: /^\/devtools\/browser\/[0-9a-f-]{36}$/.test(electron.registered.browserPath),
    pid: Number.isInteger(electron.registered.electronPid) && electron.registered.electronPid > 0,
  }, { sha256: electron.binarySha256, bytes: electron.binaryBytes, address: true, browserPath: true, pid: true }, manualDoc);
  artifacts.push(electronBinary);
  const packageReports = packaged.artifacts.filter((entry) => entry.kind === 'packaged-driver-manifest');
  assert.equal(packageReports.length, 1, 'expected one packaged-driver manifest');
  assert.equal(manual.packagedBridge.reportSha256, packageReports[0].sha256, 'manual packaged observations must bind the candidate packaging run');
  check('the packaged vis_bridge ran from the real 0.9.0-alpha deb on a PATH with no node: --help exited 0, the daemon listened and its /health body names the service, and a PTY was accepted', { helpExit: manual.packagedBridge.observed.helpExit, nodeOnRestrictedPath: manual.packagedBridge.observed.nodeOnRestrictedPath, healthNamesService: /"service":"vis_bridge"/.test(manual.packagedBridge.observed.health), ptyAccepted: /POST \/pty accepted/.test(manual.packagedBridge.observed.pty) }, { helpExit: 0, nodeOnRestrictedPath: 'NO NODE ON RESTRICTED PATH', healthNamesService: true, ptyAccepted: true }, 'the F3 lane\'s preserved evidence document: packagedBridge.observed');

  const task23 = runnerReport(path.join(evidenceRoot, `task-23/${lane}.json`), 23, lane);
  check('Task 23 native controls pass on the current candidate', task23.status, 'passed', `task-23/${lane}.json`);

  if (lane === 'happy') {
    // ── the task-43 fixture is started for real over the real landed harness ──────────────────
    const harness = await runSystem({ ...context, evidenceRoot: DETAIL_ROOT(root) });
    scenarios.push(...harness.scenarios);
    artifacts.push(...harness.artifacts);
    const controlledServer = { url: harness.observations.pageUrl ?? null, pattern: 'the harness-owned Vite server on 127.0.0.1 with an ephemeral port, serving the real QA page', cdp: 'the harness drives a real headless Chromium over a pipe (omowright.connectPipe); the packaged Electron CDP address is audited above from the F3 lane\'s registered DevToolsActivePort read' };
    check('the task-43 fixture really started and drove the full happy chain at this head: the landed system harness reports its frozen 12 scenarios / 12 assertions over the real five-source tree, the real thread handoff and the real team/artifact review in a real headless Chromium, and it published the controlled UI URL', { url: controlledServer.url, urlShape: /^http:\/\/127\.0\.0\.1:\d+\/qa43\/$/.test(controlledServer.url ?? ''), scenarios: harness.scenarios.length, assertions: harness.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0), mappingMissing: harness.mapping?.completeness?.missing ?? [] }, { url: controlledServer.url, urlShape: true, scenarios: 12, assertions: 12, mappingMissing: [] }, 'the real scripts/qa/runtime-v090-system.mjs runSystem harness executed by this module, cross-checked against the runner-bound F3-task43-happy.json manifest (whose 18 scenarios are this harness\'s 12 plus task-43.mjs\'s own 6)');

    const report = { lane: 'happy', controlledServer, screenshots: decoded.map((shot) => ({ file: shot.file, width: shot.width, height: shot.height, bytes: shot.bytes, sha256: shot.sha256 })), reports, lab: { runtime: lab.runtime, computeNodes: labNodes.filter((node) => node.role === 'compute').length }, electron: { registeredAddress: manual.electron.registered.address }, task23: { revision: task23.productionRevision, scenarios: task23.scenarioCount }, harnessScenarios: harness.scenarios.length, harnessAssertions: harness.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0) };
    writeFileSync(path.join(detailDir, 'happy-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
    artifacts.push(artifact(path.join(detailDir, 'happy-audit.json'), 'f3-happy-audit'));
    return {
      scenario: 'F3 real manual QA — the task-43 fixture started for real plus the landed browser/Electron/packaged/SSH/Slurm evidence audited',
      verdict: 'PASS (the fixture leg re-executed at this head; the other legs audited from the F3 lane\'s independent observed evidence)',
      controlledServer,
      whatWasReExecuted: ['the real task-43 system harness over the real five-source unified tree, thread handoff and team/artifact review in a real headless Chromium'],
      whatWasAudited: ['nine screenshot files checked by PNG header and hash', 'real SSH happy/failure and real Slurm happy/failure at their frozen scenario counts', 'the real four-namespace Slurm lab descriptor', 'the packaged Electron binary\'s registered CDP address', 'the packaged vis_bridge on a node-free PATH', 'current Task 23 native controls'],
      scenarios,
      artifacts,
      versions: { node: process.version },
    };
  }

  // ── failure lane: the real fault interactions, repeated by the landed faults harness ─────────
  const harness = await runFaults({ ...context, evidenceRoot: DETAIL_ROOT(root) });
  scenarios.push(...harness.scenarios);
  artifacts.push(...harness.artifacts);
  check('the real fault interactions were repeated at this head: the landed faults harness reports its frozen 11 scenarios / 11 assertions — kill store / kill native producer / kill manager group, SSH and relay broken at the typed boundaries (changed host key, mismatched relay binding), slow consumer, partial source, same native id across hosts, legacy import target switch and mid-import source change, and the UI disconnect in a real headless Chromium', { scenarios: harness.scenarios.length, assertions: harness.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0), faultCatalogSize: FAULT_SCENARIOS.length, mappingMissing: harness.mapping?.completeness?.missing ?? [] }, { scenarios: 11, assertions: 11, faultCatalogSize: 10, mappingMissing: [] }, 'the real scripts/qa/runtime-v090-faults.mjs runFaults harness executed by this module, cross-checked against the runner-bound F3-task43-failure.json manifest (whose 17 scenarios are this harness\'s 11 plus task-43.mjs\'s own 6)');
  const failureReports = [{ file: 'F3-ssh-failure.json' }, { file: 'F3-slurm-failure.json' }, { file: 'task-41/failure.json', atEvidenceRoot: true }].map((entry) => ({ file: entry.file, ...reportShape(reportPath(evidenceRoot, finalDir, entry)) }));
  check('the landed failure evidence covers the changed-key and dirty-target interactions at their frozen counts: the live SSH failure set (21, the changed host key included), the live Slurm failure set (48) and the task-41 artifact dirty-target refusal (16)', failureReports, [{ file: 'F3-ssh-failure.json', status: 'passed', scenarios: 21, assertions: 21, exitCode: null }, { file: 'F3-slurm-failure.json', status: 'passed', scenarios: 48, assertions: 48, exitCode: null }, { file: 'task-41/failure.json', status: 'passed', scenarios: 16, assertions: 16, exitCode: 0 }], 'scenario-level read of the landed failure reports');

  const report = { lane: 'failure', harnessScenarios: harness.scenarios.length, harnessAssertions: harness.scenarios.reduce((sum, scenario) => sum + scenario.assertions.length, 0), faultCatalog: FAULT_SCENARIOS.map((scenario) => scenario.id), failureReports, task23: { revision: task23.productionRevision, scenarios: task23.scenarioCount } };
  writeFileSync(path.join(detailDir, 'failure-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  artifacts.push(artifact(path.join(detailDir, 'failure-audit.json'), 'f3-failure-audit'));
  return {
    scenario: 'F3 real manual QA — the real error/disconnect/changed-key/dirty-target/partial-source interactions repeated by the landed faults harness',
    verdict: 'PASS (the fault leg re-executed at this head; the changed-key and dirty-target legs audited from the F3 lane\'s independent observed evidence)',
    scenarios,
    artifacts,
    versions: { node: process.version },
  };
}
