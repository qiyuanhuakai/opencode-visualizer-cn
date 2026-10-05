// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSelector } from '../scripts/qa/runtime-v090.mjs';
import { artifact, digest, normalizeVitest, validateEvidence, sourceSnapshot } from '../scripts/qa/runtime-v090-evidence.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'runtime-qa-test-'));
const source = path.join(root, 'source.js');
writeFileSync(source, 'export const answer = 42;');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repository = path.resolve(__dirname, '..');
const productionRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
const sourceHashes = sourceSnapshot(repository, ['package.json', 'app/runtimeIdentity.test.ts', 'shared/runtime/identity.js', 'shared/runtime/identity.d.ts', 'app/runtimeQaRunner.test.ts']);
const report = { success: true, numPassedTests: 1, numFailedTests: 0, testResults: [{ name: path.join(repository, 'app/runtimeIdentity.test.ts'), assertionResults: [{ fullName: 'failure rejects invalid input', status: 'passed' }] }] };

describe('runtime QA runner', () => {
  it('accepts every reserved task and independent final verifier selectors', () => {
    for (let task = 1; task <= 48; task++) expect(parseSelector(['--task', String(task), '--case', 'happy', '--out', 'result.json']).task).toBe(task);
    for (const verify of ['F1', 'F2', 'F3', 'F4']) expect(parseSelector(['--verify', verify, '--out', 'result.json']).verify).toBe(verify);
  });
  it('failure rejects unknown, mixed, duplicate, malformed and missing selectors', () => {
    for (const args of [[], ['--task', '49'], ['--task', '1x'], ['--verify', 'F5'], ['--task', '6', '--case', 'skip', '--out', 'x'], ['--task', '6', '--verify', 'F1', '--out', 'x'], ['--verify', 'F1', '--case', 'happy', '--out', 'x'], ['--verify', 'F1', '--verify', 'F2', '--out', 'x'], ['--verify', 'F1', '--out', 'x', '--shell', 'echo pass']]) expect(() => parseSelector(args)).toThrow();
  });
  it('failure exits nonzero for unknown task and verifier', () => {
    for (const args of [['--task', '49', '--case', 'happy'], ['--verify', 'F5']]) {
      const result = spawnSync(process.execPath, ['scripts/qa/runtime-v090.mjs', ...args, '--out', path.join(root, 'unavailable.json')], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/unknown task|unknown verifier/);
    }
  });
  it('failure cleans parent resources when interrupted during setup', async () => {
    const before = new Set(readdirSync(tmpdir()));
    const child = spawn(process.execPath, ['scripts/qa/runtime-v090.mjs', '--task', '6', '--case', 'happy', '--out', path.join(root, 'interrupt.json')], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
    let owned: string | undefined;
    try {
      const deadline = Date.now() + 10000;
      while (!owned && Date.now() < deadline) {
        owned = readdirSync(tmpdir()).find((name) => name.startsWith(`vis-runtime-qa-owned-${child.pid}-`) && !before.has(name));
        if (!owned) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(owned).toBeDefined();
      child.kill('SIGTERM');
      expect(await exited).toBe(1);
      expect(owned && existsSync(path.join(tmpdir(), owned))).toBe(false);
    } finally { child.kill('SIGKILL'); if (owned) rmSync(path.join(tmpdir(), owned), { recursive: true, force: true }); }
  }, 15000);
  it('normalizes actual test scenarios with an independent matching execution receipt', () => {
    const receipt = legacyReceipt('failure');
    expect(normalizeVitest(report, receipt, { root: repository, task: 1, case: 'failure', raw: JSON.stringify(report) }).scenarios).toHaveLength(1);
  });
  it('failure rejects zero assertions, misleading success, mismatched process exit and stale source', () => {
    const receipt = legacyReceipt('happy');
    expect(() => normalizeVitest(report, { ...receipt, exitCode: 7 }, { root: repository, task: 1, case: 'failure', raw: JSON.stringify(report) })).toThrow();
    const empty = { ...report, numPassedTests: 0, testResults: [{ ...report.testResults[0], assertionResults: [] }] };
    const emptyRaw = JSON.stringify(empty);
    expect(() => normalizeVitest(empty, { ...receipt, reportSha256: digest(emptyRaw) }, { root: repository, task: 1, case: 'happy', raw: emptyRaw })).toThrow('zero assertions');
    expect(() => normalizeVitest({ ...report, success: false }, receipt, { root: repository, task: 1, case: 'happy', raw: JSON.stringify(report) })).toThrow();
    expect(() => normalizeVitest(report, { ...receipt, sourceHashes: { 'source.js': '0'.repeat(64) } }, { root: repository, task: 1, case: 'happy', raw: JSON.stringify(report) })).toThrow();
    expect(() => validateEvidence({ status: 'passed', assertions: 0 }, root)).toThrow();
  });
});

function legacyReceipt(testCase: string) {
  return { exitCode: 0, signal: null, cwd: repository, selector: { task: 1, case: testCase }, invocation: ['pnpm', 'exec', 'vitest', 'run', 'runtimeIdentity.test.ts', ...(testCase === 'failure' ? ['--testNamePattern', 'failure'] : [])], productionRevision, sourceHashes, reportSha256: digest(JSON.stringify(report)) };
}
function evidenceFixture() {
  const selector = { task: 6, case: 'happy', out: path.join(root, 'manifest.json') };
  const invocation = [process.execPath, path.join(repository, 'scripts/qa/runtime-v090.mjs'), '--task', '6', '--case', 'happy', '--out', selector.out];
  const scenarios = [{ name: 'fixture assertion', assertions: [{ name: 'values equal', passed: true, observed: 1, expected: 1 }] }];
  const rawFile = path.join(root, 'scenarios.json');
  const receiptFile = path.join(root, 'receipt.json');
  const raw = JSON.stringify({ scenarios, artifacts: [] });
  writeFileSync(rawFile, raw);
  const productionSource = { kind: 'worktree-snapshot', baseRevision: productionRevision, contentSha256: digest(JSON.stringify(Object.entries(sourceHashes).sort(([a], [b]) => a.localeCompare(b)))) };
  const execution = { exitCode: 0, signal: null, invocation, interrupted: false };
  const receipt = { ...execution, selector, productionRevision, productionSource, sourceHashes, scenarioCount: 1, assertionCount: 1, reportSha256: digest(raw) };
  writeFileSync(receiptFile, JSON.stringify(receipt));
  return { schemaVersion: 1, status: 'passed', selector, invocation, productionRevision, productionSource, sourceHashes, versions: { node: 'test' }, exitCode: 0, process: execution, scenarios, assertions: 1, scenarioCount: 1, artifacts: [artifact(rawFile, 'scenario-result'), artifact(receiptFile, 'execution-receipt')] };
}
describe('runtime QA evidence binding', () => {
  it('failure rejects authentic report inputs for another task or case', () => {
    const receipt = legacyReceipt('failure');
    expect(() => normalizeVitest(report, receipt, { root: repository, task: 2, case: 'failure', raw: JSON.stringify(report) })).toThrow();
    expect(() => normalizeVitest(report, receipt, { root: repository, task: 1, case: 'happy', raw: JSON.stringify(report) })).toThrow();
    expect(() => normalizeVitest(report, { ...receipt, sourceHashes: sourceSnapshot(repository, ['package.json']) }, { root: repository, task: 1, case: 'failure', raw: JSON.stringify(report) })).toThrow();
  });
  it('accepts the exact dirty source snapshot with its real dependency-base commit', () => {
    const value = evidenceFixture();
    expect(value.sourceHashes['app/runtimeQaRunner.test.ts']).toBe(digest(readFileSync(path.join(repository, 'app/runtimeQaRunner.test.ts'))));
    expect(validateEvidence(value, repository)).toBe(value);
  });
  it('failure requires raw result and independent receipt artifacts', () => {
    const value = evidenceFixture();
    expect(validateEvidence(value, repository)).toBe(value);
    for (const kind of ['scenario-result', 'execution-receipt']) expect(() => validateEvidence({ ...value, artifacts: value.artifacts.filter((entry) => entry.kind !== kind) }, repository)).toThrow();
  });
  it('failure binds actual revision, selector, process and assertions to captured artifacts', () => {
    const value = evidenceFixture();
    for (const changed of [
      { productionRevision: '0'.repeat(40) },
      { selector: { ...value.selector, task: 2 } },
      { invocation: ['node', 'unrelated-script'] },
      { scenarios: [{ name: 'invented', assertions: [{ name: 'invented', passed: true, observed: 2, expected: 2 }] }] },
      { process: { ...value.process, invocation: ['node', 'unrelated-script'] } },
    ]) expect(() => validateEvidence({ ...value, ...changed }, repository)).toThrow();
  });
});
