// Grade ten independent production title-update observations from one profile.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { digest, writeJson } from './runtime-v090-evidence.mjs';
import { SLO, nearestRankP95 } from './runtime-v090-benchmark.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, revision: { type: 'string' } },
});
assert(values.out, '--out is required');
assert.match(values.revision ?? '', /^[a-f0-9]{40}$/, '--revision must identify the candidate');
assert.equal(positionals.length, 10, 'ten independent production reports are required');

const samples = positionals.map(file => {
  const bytes = readFileSync(file);
  const report = JSON.parse(bytes);
  assert.equal(report.measurementScope, 'single-sample-production-app-and-bridge', 'production measurement required');
  assert.equal(report.status, 'passed', 'the production run must complete');
  assert([10000, 100000].includes(report.count), 'unexpected session count');
  assert([0, 100].includes(report.rttMs), 'unexpected RTT');
  assert.equal(report.network?.rttMs, report.rttMs, 'the reported transport must match the profile');
  assert.equal(report.eventVisible?.budgetMs, SLO.eventVisibleMs, 'unexpected event-visible budget');
  const ms = report.eventVisible.ms;
  assert(Number.isFinite(ms) && ms >= 0, 'a measured visibility deadline is required');
  assert.equal(report.eventVisible.passed, ms <= SLO.eventVisibleMs, 'the per-sample verdict disagrees with its measurement');
  assert.match(report.productionRevision, /^[a-f0-9]{40}$/, 'production revision required');
  assert.equal(report.productionSource?.baseRevision, report.productionRevision, 'source identity must match the revision');
  assert.match(report.productionSource?.contentSha256, /^[a-f0-9]{64}$/, 'source digest required');
  assert.equal(report.productionRevision, values.revision, 'production report belongs to another candidate');
  assert.match(report.runId ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, 'production run ID required');
  const receiptFile = path.join(path.dirname(file), 'run-receipt.json');
  const receiptBytes = readFileSync(receiptFile);
  const receipt = JSON.parse(receiptBytes);
  const sha256 = digest(bytes);
  assert.deepEqual(
    [receipt.runId, receipt.productionRevision, receipt.count, receipt.rttMs, receipt.startedAt, receipt.exitCode, receipt.reportSha256],
    [report.runId, report.productionRevision, report.count, report.rttMs, report.startedAt, 0, sha256],
    'production report does not match its run receipt',
  );
  assert(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt), 'invalid production execution times');
  return {
    file,
    sha256,
    runId: report.runId,
    receiptFile,
    receiptSha256: digest(receiptBytes),
    revision: report.productionRevision,
    sourceSha256: report.productionSource.contentSha256,
    count: report.count,
    rttMs: report.rttMs,
    ms,
  };
});
const first = samples[0];
assert.equal(new Set(samples.map(sample => sample.runId)).size, samples.length, 'a production run was repeated');
for (const sample of samples) {
  assert.deepEqual([sample.revision, sample.sourceSha256, sample.count, sample.rttMs],
    [first.revision, first.sourceSha256, first.count, first.rttMs], 'mixed candidates or benchmark profiles');
}
const p95Ms = nearestRankP95(samples.map(sample => sample.ms));
const passed = p95Ms <= SLO.eventVisibleMs;
writeJson(values.out, { p95Ms, budgetMs: SLO.eventVisibleMs, passed, samples });
if (!passed) process.exitCode = 1;
