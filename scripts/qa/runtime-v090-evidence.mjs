import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function sourceSnapshot(root, files) {
  assert(Array.isArray(files) && files.length > 0, 'source inventory required');
  return Object.fromEntries(files.map((file) => {
    const absolute = realpathSync(path.resolve(root, file));
    assert(absolute.startsWith(`${realpathSync(root)}${path.sep}`), 'source outside worktree');
    return [file, digest(readFileSync(absolute))];
  }));
}
export function validateSources(hashes, root) {
  assert(hashes && typeof hashes === 'object' && Object.keys(hashes).length > 0, 'source hashes required');
  for (const hash of Object.values(hashes)) assert(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'invalid source hash');
  assert.deepEqual(sourceSnapshot(root, Object.keys(hashes)), hashes, 'source changed since execution');
}
export function artifact(file, kind) {
  assert(statSync(file).size > 0, 'empty artifact');
  return { path: path.resolve(file), kind, sha256: digest(readFileSync(file)) };
}
export function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}
export function productionSource(root, hashes, revision) {
  assert(typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision), 'production revision required');
  assert.equal(execFileSync('git', ['cat-file', '-t', revision], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), 'commit', 'production base must be a real commit');
  return { kind: 'worktree-snapshot', baseRevision: revision, contentSha256: digest(JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))) };
}
const legacyTests = ['runtimeIdentity.test.ts', 'runtimeProtocol.test.ts', 'runtimeLifecycle.test.ts', 'runtimeHarnessContract.test.ts', 'runtimeFixture.test.ts'];
const legacySources = [
  ['shared/runtime/identity.js', 'shared/runtime/identity.d.ts'],
  ['shared/runtime/protocol.js', 'shared/runtime/protocolState.js', 'shared/runtime/capabilities.js', 'shared/runtime/identity.js'],
  ['bridge/runtime/runtimeHost.js', 'bridge/runtime/connectionScope.js', 'bridge/runtime/resourceOwnership.js'],
  ['shared/runtime/harnessContract.js', 'shared/runtime/nativeExtensions.js'],
  ['scripts/qa/runtime-v090-fixtures.mjs', 'scripts/qa/runtime-v090-benchmark.mjs', 'app/dev/runtime-v090/fixtures/inventory.mjs', 'app/dev/runtime-v090/fixtures/seed090.json'],
];
export function legacyContract(task) {
  assert(Number.isInteger(task) && task >= 1 && task <= 5, 'unknown legacy task');
  const test = legacyTests[task - 1];
  return { test, sources: ['package.json', `app/${test}`, ...legacySources[task - 1]] };
}
export function validateLegacyBinding(report, receipt, context) {
  const contract = legacyContract(context.task);
  assert(['happy', 'failure'].includes(context.case), 'unknown legacy case');
  assert(Array.isArray(report.testResults) && report.testResults.length === 1, 'expected one selected legacy suite');
  const cwd = receipt?.cwd ?? context.root;
  const suite = report.testResults[0].name;
  assert(typeof suite === 'string' && path.basename(suite) === contract.test && path.basename(path.dirname(suite)) === 'app', 'legacy suite belongs to another task');
  if (receipt?.cwd) assert.equal(path.resolve(cwd, suite), path.resolve(cwd, 'app', contract.test), 'legacy suite path differs from executed workspace');
  const discovered = report.testResults[0].assertionResults;
  assert(Array.isArray(discovered), 'legacy assertions required');
  const selected = discovered.filter((entry) => !['pending', 'skipped'].includes(entry.status));
  if (context.case === 'happy') assert.equal(selected.length, discovered.length, 'happy report contains a filtered selection');
  else assert(selected.every((entry) => typeof entry.fullName === 'string' && /\bfailure\b/.test(entry.fullName)), 'failure report contains another case');
  if (!receipt) return;
  if (receipt.selector) assert.deepEqual(receipt.selector, { task: context.task, case: context.case }, 'legacy selector mismatch');
  if (receipt.scenario) assert.equal(receipt.scenario, context.case, 'legacy case mismatch');
  if (!Array.isArray(receipt.invocation)) return;
  const argv = receipt.invocation;
  const runIndex = argv.indexOf('run');
  assert((runIndex === 3 && path.basename(argv[0]).startsWith('pnpm') && argv[1] === 'exec' && argv[2] === 'vitest') || (runIndex === 2 && path.basename(argv[1]) === 'vitest.mjs'), 'expected captured Vitest invocation');
  const selectedTest = argv[runIndex + 1];
  assert(selectedTest === contract.test || path.resolve(cwd, selectedTest) === path.resolve(cwd, 'app', contract.test), 'legacy invocation belongs to another task');
  const options = argv.slice(runIndex + 2);
  let pattern;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === '--testNamePattern') { assert.equal(pattern, undefined, 'duplicate test selector'); pattern = options[++index]; }
    else assert(option === '--reporter=json' || option.startsWith('--outputFile='), 'unexpected Vitest selection option');
  }
  assert.equal(pattern, context.case === 'failure' ? 'failure' : undefined, 'legacy case differs from executed selection');
}
export function normalizeVitest(report, receipt, context) {
  assert(receipt && receipt.exitCode === 0 && receipt.signal === null, 'unsuccessful independent process receipt');
  assert(Array.isArray(receipt.invocation) && receipt.invocation.length > 0, 'invocation required');
  validateLegacyBinding(report, receipt, context);
  const contract = legacyContract(context.task);
  assert(contract.sources.every((file) => Object.hasOwn(receipt.sourceHashes ?? {}, file)), 'missing selected task production sources');
  const provenance = productionSource(context.root, receipt.sourceHashes, receipt.productionRevision);
  if (receipt.productionSource) assert.deepEqual(receipt.productionSource, provenance, 'legacy source snapshot mismatch');
  validateSources(receipt.sourceHashes, context.root);
  assert.equal(digest(context.raw), receipt.reportSha256, 'stale or altered report');
  assert(report.success === true && report.numFailedTests === 0, 'failed test report');
  assert(Array.isArray(report.testResults) && report.testResults.length > 0, 'suite required');
  const discovered = report.testResults.flatMap((suite) => {
    assert(Array.isArray(suite.assertionResults), 'assertion results required');
    return suite.assertionResults;
  });
  const selected = discovered.filter((scenario) => scenario.status !== 'pending' && scenario.status !== 'skipped');
  assert(selected.length > 0, 'zero assertions');
  assert.equal(report.numPassedTests, selected.length, 'scenario count mismatch');
  if (context.case === 'happy') assert.equal(selected.length, discovered.length, 'happy scenarios skipped');
  const scenarios = selected.map((scenario) => {
    assert.equal(scenario.status, 'passed', 'scenario failed');
    assert(typeof scenario.fullName === 'string' && scenario.fullName.length > 0, 'scenario name required');
    if (context.case === 'failure') assert(/\bfailure\b/.test(scenario.fullName), 'wrong failure selection');
    return { name: scenario.fullName, assertions: [{ name: 'Vitest assertion result', passed: true, observed: scenario.status, expected: 'passed' }] };
  });
  return { scenarios, scenarioCount: selected.length, assertionUnit: 'vitest-scenario', suiteCount: report.testResults.length };
}
export function validateEvidence(value, root) {
  assert(value && value.schemaVersion === 1 && value.status === 'passed', 'successful schema required');
  assert(value.exitCode === 0 && value.process.exitCode === 0 && value.process.signal === null, 'process exit mismatch');
  assert.deepEqual(value.productionSource, productionSource(root, value.sourceHashes, value.productionRevision), 'production source snapshot mismatch');
  assert(typeof value.versions.node === 'string', 'versions required');
  assert(Array.isArray(value.invocation) && value.invocation.length > 0, 'invocation required');
  validateSources(value.sourceHashes, root);
  assert(Array.isArray(value.scenarios) && value.scenarios.length > 0, 'zero scenarios');
  let count = 0;
  for (const scenario of value.scenarios) {
    assert(typeof scenario.name === 'string' && scenario.name.length > 0, 'scenario name required');
    assert(Array.isArray(scenario.assertions) && scenario.assertions.length > 0, 'zero assertions');
    for (const assertion of scenario.assertions) {
      assert(assertion.passed === true && typeof assertion.name === 'string', 'assertion failed');
      assert(Object.hasOwn(assertion, 'observed') && Object.hasOwn(assertion, 'expected'), 'assertion values required');
      assert.deepEqual(assertion.observed, assertion.expected, 'assertion mismatch'); count++;
    }
  }
  assert.equal(value.assertions, count, 'assertion count mismatch');
  assert.equal(value.scenarioCount, value.scenarios.length, 'scenario count mismatch');
  assert(Array.isArray(value.artifacts) && value.artifacts.length > 0, 'artifacts required');
  for (const entry of value.artifacts) assert.deepEqual(artifact(entry.path, entry.kind), entry, 'artifact changed');
  const rawEntries = value.artifacts.filter((entry) => entry.kind === 'scenario-result');
  const receiptEntries = value.artifacts.filter((entry) => entry.kind === 'execution-receipt');
  assert(rawEntries.length === 1 && receiptEntries.length === 1, 'one raw scenario result and independent execution receipt required');
  const raw = readFileSync(rawEntries[0].path, 'utf8');
  const result = JSON.parse(raw);
  const receipt = JSON.parse(readFileSync(receiptEntries[0].path, 'utf8'));
  assert.deepEqual(result.scenarios, value.scenarios, 'raw scenarios differ from manifest');
  assert.equal(receipt.reportSha256, digest(raw), 'receipt is for another raw result');
  for (const key of ['selector', 'invocation', 'sourceHashes', 'productionRevision', 'productionSource', 'scenarioCount']) assert.deepEqual(receipt[key], value[key], `receipt ${key} differs from manifest`);
  assert.equal(receipt.assertionCount, value.assertions, 'receipt assertion count mismatch');
  for (const key of ['exitCode', 'signal', 'invocation', 'interrupted', 'startedAt', 'finishedAt', 'log']) assert.deepEqual(receipt[key], value.process[key], `process ${key} differs from receipt`);
  assert.equal(receipt.interrupted, false, 'interrupted execution cannot pass');
  const options = value.invocation.slice(2);
  assert(Boolean(value.selector.verify) !== Boolean(value.selector.task), 'exclusive manifest selector required');
  if (value.selector.verify) assert(['F1', 'F2', 'F3', 'F4'].includes(value.selector.verify) && value.selector.case === undefined, 'unknown manifest verifier');
  else assert(Number.isInteger(value.selector.task) && value.selector.task >= 1 && value.selector.task <= 48 && ['happy', 'failure'].includes(value.selector.case), 'unknown manifest task or case');
  const parsed = {};
  assert(options.length % 2 === 0, 'invalid runner invocation');
  for (let index = 0; index < options.length; index += 2) {
    assert(['--task', '--case', '--verify', '--out', '--evidence-root'].includes(options[index]) && !Object.hasOwn(parsed, options[index]), 'invalid runner selector');
    parsed[options[index]] = options[index + 1];
  }
  const expectedOptions = { ...(value.selector.verify ? { '--verify': value.selector.verify } : { '--task': String(value.selector.task), '--case': value.selector.case }), '--out': value.selector.out, ...(value.selector.evidenceRoot ? { '--evidence-root': value.selector.evidenceRoot } : {}) };
  if (parsed['--out']) parsed['--out'] = path.resolve(receipt.invocationCwd ?? root, parsed['--out']);
  if (parsed['--evidence-root']) parsed['--evidence-root'] = path.resolve(receipt.invocationCwd ?? root, parsed['--evidence-root']);
  assert.deepEqual(parsed, expectedOptions, 'executed selector differs from manifest');
  assert.equal(path.resolve(value.invocation[1]), path.join(root, 'scripts/qa/runtime-v090.mjs'), 'unexpected runner executable');
  const supplied = value.artifacts.filter((entry) => !['scenario-result', 'execution-receipt'].includes(entry.kind));
  assert.deepEqual(supplied, result.artifacts ?? [], 'raw artifact inventory differs from manifest');
  return value;
}
