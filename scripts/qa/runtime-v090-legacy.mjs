import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifact, digest, legacyContract, normalizeVitest, productionSource, sourceSnapshot, validateLegacyBinding, validateSources, writeJson } from './runtime-v090-evidence.mjs';
import { captureProcess } from './runtime-v090-process.mjs';

export async function runLegacy(context) {
  const { test, sources: sourceFiles } = legacyContract(context.task);
  assert(existsSync(path.join(context.root, 'app', test)), `unavailable prerequisite ${test}`);
  const sourceHashes = sourceSnapshot(context.root, sourceFiles);
  let origin = { mode: 'controlled-rerun', reason: 'independent receipt not supplied' };
  const references = [];
  if (context.evidenceRoot) {
    const reportFile = path.join(context.evidenceRoot, context.case === 'happy' ? 'result.json' : 'failure.json');
    const raw = readFileSync(reportFile, 'utf8');
    const direct = path.join(context.evidenceRoot, `${context.case}.receipt.json`);
    let receipt;
    if (existsSync(direct)) receipt = JSON.parse(readFileSync(direct, 'utf8'));
    else if (existsSync(path.join(context.evidenceRoot, 'receipts.json'))) {
      const collection = JSON.parse(readFileSync(path.join(context.evidenceRoot, 'receipts.json'), 'utf8'));
      const check = collection.checks.find((entry) => entry.scenario === context.case);
      assert(check, 'missing independent execution');
      receipt = { ...check, cwd: collection.cwd, signal: null, sourceHashes: collection.sourceSha256, productionRevision: collection.head };
    } else if (existsSync(path.join(context.evidenceRoot, 'execution-receipts.json'))) {
      const collection = JSON.parse(readFileSync(path.join(context.evidenceRoot, 'execution-receipts.json'), 'utf8'));
      const check = collection.find((entry) => entry.scenario === context.case);
      assert(check, 'missing independent execution');
      receipt = { ...check, exitCode: check.processExitCode };
    }
    validateLegacyBinding(JSON.parse(raw), receipt, context);
    if (receipt) {
      assert.equal(receipt.exitCode, 0, 'prior execution failed');
      if (receipt.sourceHashes) validateSources(receipt.sourceHashes, context.root);
      if (receipt.reportSha256) {
        const normalized = normalizeVitest(JSON.parse(raw), receipt, { ...context, raw });
        return { ...normalized, origin: { mode: 'verified-receipt', reportFile }, artifacts: [artifact(reportFile, 'vitest-report'), artifact(direct, 'vitest-execution-receipt')] };
      }
    }
    references.push(artifact(reportFile, 'historical-report-reference'));
    origin = { mode: 'controlled-rerun', reason: 'historical receipt lacks report binding or source hashes', reportFile };
  }
  const reportFile = path.join(context.outDir, `${context.case}.vitest.json`);
  const invocation = [process.execPath, path.join(context.root, 'node_modules/vitest/vitest.mjs'), 'run', test, ...(context.case === 'failure' ? ['--testNamePattern', 'failure'] : []), '--reporter=json', `--outputFile=${reportFile}`];
  const execution = await captureProcess(invocation, { root: context.root, log: `${reportFile}.log` });
  const raw = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '';
  const receipt = { ...execution, cwd: context.root, selector: { task: context.task, case: context.case }, productionRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: context.root, encoding: 'utf8' }).trim(), sourceHashes, reportSha256: digest(raw) };
  receipt.productionSource = productionSource(context.root, sourceHashes, receipt.productionRevision);
  writeJson(`${reportFile}.receipt.json`, receipt);
  const normalized = normalizeVitest(JSON.parse(raw), receipt, { ...context, raw });
  return { ...normalized, origin, artifacts: [...references, artifact(reportFile, 'vitest-report'), artifact(`${reportFile}.receipt.json`, 'vitest-execution-receipt')] };
}
