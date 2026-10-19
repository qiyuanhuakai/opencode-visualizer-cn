// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
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
    for (const [verify, testCase] of [['F1', 'happy'], ['F2', 'failure'], ['F3', 'happy'], ['F4', 'failure']]) expect(parseSelector(['--verify', verify, '--case', testCase, '--out', 'result.json'])).toMatchObject({ verify, case: testCase });
  });
  it('failure rejects unknown, mixed, duplicate, malformed and missing selectors', () => {
    for (const args of [[], ['--task', '49'], ['--task', '1x'], ['--verify', 'F5'], ['--task', '6', '--case', 'skip', '--out', 'x'], ['--verify', 'F1', '--case', 'skip', '--out', 'x'], ['--task', '6', '--verify', 'F1', '--out', 'x'], ['--verify', 'F1', '--verify', 'F2', '--out', 'x'], ['--verify', 'F1', '--out', 'x', '--shell', 'echo pass']]) expect(() => parseSelector(args)).toThrow();
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

// The F1 plan-compliance audit resolves every input from the runner context
// (the checkout being verified) plus explicit evidence/plan/revision inputs.
// These tests put a checkout at an ARBITRARY temporary path with a DECOY old
// tree beside it: the audit must read the context's tree and the configured
// inputs, never a hardcoded machine path, and a missing input must be a located
// prerequisite report.
import { run as runF1 } from '../scripts/qa/runtime-v090-cases/verify-F1.mjs';

const F1_PLAN = `- [x] 1. first temporary row
- [x] 42. 实现Team任务与改动审查界面
- [ ] F1. final wave row
- [ ] F2. final wave row
- [ ] F3. final wave row
- [ ] F4. final wave row
`;
const FROZEN_HEAD = 'a'.repeat(40);

function f1Checkout() {
  const base = mkdtempSync(path.join(tmpdir(), 'f1-isolation-'));
  const checkout = path.join(base, 'checkout');
  const decoy = path.join(base, 'decoy-old-tree');
  const evidence = path.join(checkout, '.omo/evidence/vis-v090');
  const plan = path.join(checkout, '.omo/plans/vis-v090-unified-runtime.md');
  mkdirSync(path.join(checkout, '.omo/plans'), { recursive: true });
  mkdirSync(path.join(evidence, 'final'), { recursive: true });
  mkdirSync(path.join(evidence, 'task-48'), { recursive: true });
  mkdirSync(path.join(evidence, 'task-44'), { recursive: true });
  writeFileSync(plan, F1_PLAN);
  writeFileSync(path.join(evidence, 'final/revision-manifest.json'), JSON.stringify({ finalSourceDigest: { digest: 'b'.repeat(64), fileCount: 3, head: FROZEN_HEAD } }));
  writeFileSync(path.join(evidence, 'task-48/task-43-system.json'), JSON.stringify({ status: 'passed', productionRevision: FROZEN_HEAD, sourceHashes: { 'package.json': 'c'.repeat(64) }, scenarioCount: 18 }));
  writeFileSync(path.join(evidence, 'task-44/happy.json'), JSON.stringify({ status: 'passed', exitCode: 0, assertions: 9 }));
  writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '0.9.0-alpha' }));
  // The decoy: a DIFFERENT plan (nine rows) and different evidence beside the checkout.
  mkdirSync(path.join(decoy, '.omo/plans'), { recursive: true });
  mkdirSync(path.join(decoy, '.omo/evidence/vis-v090/final'), { recursive: true });
  writeFileSync(path.join(decoy, '.omo/plans/vis-v090-unified-runtime.md'), Array.from({ length: 9 }, (_, index) => `- [x] ${index + 1}. decoy row`).join('\n'));
  writeFileSync(path.join(decoy, '.omo/evidence/vis-v090/final/revision-manifest.json'), JSON.stringify({ finalSourceDigest: { digest: 'd'.repeat(64), fileCount: 9, head: 'e'.repeat(40) } }));
  return { base, checkout, decoy, evidence, plan };
}

describe('F1 verifier input resolution', () => {
  it('audits the checkout the runner names, never the decoy tree beside it', async () => {
    const { checkout, decoy, evidence, plan } = f1Checkout();
    try {
      const report = await runF1({ verify: 'F1', case: 'happy', root: checkout, evidenceRoot: evidence, planPath: plan, out: path.join(checkout, 'f1.json') });
      expect(report.checks.planPath).toBe(plan);
      expect(report.checks.root).toBe(checkout);
      expect(report.checks.evidenceRoot).toBe(evidence);
      const rowCount = report.findings.find((finding) => finding.id === 'PLAN-TASK-ROW-COUNT');
      expect(rowCount?.detail).toContain('observed 2');
      for (const finding of report.findings) expect(finding.detail).not.toContain(decoy);
      expect(JSON.stringify(report.findings)).not.toContain('decoy row');
    } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
  });

  it('reports a located prerequisite gap for the pre-runner ledger when no worktree root is configured', async () => {
    const { checkout, evidence, plan } = f1Checkout();
    try {
      const report = await runF1({ verify: 'F1', case: 'happy', root: checkout, evidenceRoot: evidence, planPath: plan, out: path.join(checkout, 'f1.json') });
      const missing = report.findings.find((finding) => finding.id === 'LEDGER-MISSING-DIR' && /task 1 /.test(finding.detail));
      expect(missing).toBeDefined();
      expect(missing?.detail).toContain(path.join(evidence, 'task-1'));
      expect(missing?.detail).toContain('VIS_F1_LEDGER_WORKTREES');
    } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
  });

  it('reads the explicitly configured ledger worktrees', async () => {
    const { checkout, evidence, plan, base } = f1Checkout();
    try {
      const farm = path.join(base, 'farm');
      mkdirSync(path.join(farm, 'vis-v090-task-1/.omo/evidence/vis-v090/task-1'), { recursive: true });
      writeFileSync(path.join(farm, 'vis-v090-task-1/.omo/evidence/vis-v090/task-1/happy.json'), JSON.stringify({ status: 'passed', exitCode: 0, assertions: 4, productionRevision: FROZEN_HEAD }));
      const report = await runF1({ verify: 'F1', case: 'happy', root: checkout, evidenceRoot: evidence, planPath: plan, ledgerWorktrees: farm, out: path.join(checkout, 'f1.json') });
      expect(report.findings.find((finding) => finding.id === 'LEDGER-MISSING-DIR' && /task 1 /.test(finding.detail))).toBeUndefined();
      expect(report.findings.find((finding) => finding.id === 'LEDGER-HAPPY' && /task 1 /.test(finding.detail))).toBeUndefined();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('the failure lane rejects every mutation from context-resolved inputs', async () => {
    const { checkout, evidence, plan } = f1Checkout();
    try {
      const report = await runF1({ verify: 'F1', case: 'failure', root: checkout, evidenceRoot: evidence, planPath: plan, out: path.join(checkout, 'f1-negative.json'), temporaryRoot: path.join(checkout, '.tmp') });
      expect(report.mutations.map((mutation) => mutation.id)).toEqual(['LEDGER-HAPPY', 'DOWNSTREAM-REVISION', 'DIGEST-STALE', 'DIGEST-MANIFEST-MISSING', 'PLAN-UNCHECKED-TODO']);
      for (const mutation of report.mutations) expect(mutation.detected).toBe(true);
    } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
  });

  it('a missing plan or evidence tree is a located prerequisite error, not a bare ENOENT', async () => {
    const { checkout, evidence, plan } = f1Checkout();
    try {
      await expect(runF1({ verify: 'F1', case: 'happy', root: checkout, evidenceRoot: evidence, planPath: path.join(checkout, 'absent-plan.md'), out: path.join(checkout, 'f1.json') }))
        .rejects.toThrow(/F1 prerequisite missing: the plan file .*absent-plan\.md does not exist/);
      await expect(runF1({ verify: 'F1', case: 'happy', root: checkout, evidenceRoot: path.join(checkout, 'absent-evidence'), planPath: plan, out: path.join(checkout, 'f1.json') }))
        .rejects.toThrow(/F1 prerequisite missing: the evidence tree .*absent-evidence does not exist/);
    } finally { rmSync(path.dirname(checkout), { recursive: true, force: true }); }
  });

  it('the F1 module carries no personal absolute path', () => {
    expect(readFileSync(path.join(repository, 'scripts/qa/runtime-v090-cases/verify-F1.mjs'), 'utf8')).not.toContain('/home/qiyuaner');
  });
});
