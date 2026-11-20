#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { digest, writeJson } from './runtime-v090-evidence.mjs';
import { buildApp, serveApp } from './runtime-v090-perf-app.mjs';
import { connectApp, measureEventVisibility, measureInteractions, measureTree, openBrowser } from './runtime-v090-perf-browser.mjs';
import { indexInventory, prepareFixture, repository, startBridge, startNative } from './runtime-v090-perf-harness.mjs';
import { summaryAt } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';
import { SLO } from './runtime-v090-benchmark.mjs';
import { shapeRuntimeNetwork } from './runtime-v090-perf-network.mjs';
import { assertPerfCheckout, committedPerfSource } from './runtime-v090-perf-source.mjs';

const { values } = parseArgs({ options: { count: { type: 'string' }, out: { type: 'string' }, rtt: { type: 'string', default: '0' } } });
const count = Number(values.count);
const rttMs = Number(values.rtt);
if (!Number.isInteger(count) || count < 10 || count > 100000 || count % 5 !== 0 || !values.out || ![0, 100].includes(rttMs)) {
  throw new Error('Use --count 10..100000 (multiple of 5) --out <new evidence directory> [--rtt 0|100]');
}
const requestedOutput = path.resolve(values.out);
const output = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
const checkout = await realpath(repository);
const relativeOutput = path.relative(checkout, output);
if (relativeOutput && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput)) {
  try {
    git('check-ignore', '-q', '--', relativeOutput);
  } catch (error) {
    if (error.status !== 1) throw error;
    throw new Error('--out must be outside the candidate checkout or under a Git-ignored directory such as .omo/');
  }
}
const productionRevision = git('rev-parse', 'HEAD').trim();
const { sourceHashes, identity: sourceIdentity } = committedPerfSource(repository, productionRevision);
assertPerfCheckout(repository, productionRevision, sourceHashes);
await mkdir(output);
const report = {
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  measurementScope: 'single-sample-production-app-and-bridge',
  productionRevision,
  productionSource: sourceIdentity,
  sourceHashes,
  count,
  rttMs,
  status: 'failed',
};
const cleanup = [];
let fixture, state;
try {
  const app = await buildApp(path.join(output, 'app'), path.join(output, 'build.log'));
  const web = await serveApp(app.output);
  cleanup.push(() => web.close());
  fixture = await prepareFixture(count, output);
  const native = await startNative(fixture, count, output);
  cleanup.push(() => native.close());
  const emptyBridge = await startBridge(fixture, path.join(fixture, 'empty-bridge-state'), path.join(output, 'empty-bridge'), true);
  try {
    const emptyBrowser = await openBrowser(path.join(output, 'empty-renderer'));
    try {
      await connectApp(emptyBrowser.page, web.origin, emptyBridge.descriptor.port);
      report.baseline = {
        bridgeRssBytes: emptyBridge.rss().rssBytes,
        renderer: await emptyBrowser.heap(),
      };
    } finally {
      await emptyBrowser.close();
    }
  } finally {
    await emptyBridge.close();
  }

  state = path.join(fixture, 'bridge-state');
  const bridge = await startBridge(fixture, state, path.join(output, 'bridge'));
  cleanup.push(() => bridge.close());
  const network = await shapeRuntimeNetwork(bridge.descriptor.port, rttMs);
  cleanup.push(() => network.close());
  const browser = await openBrowser(path.join(output, 'renderer'));
  cleanup.push(() => browser.close());

  let rssPeak = bridge.rss().rssBytes;
  const monitor = setInterval(() => { rssPeak = Math.max(rssPeak, bridge.rss().rssBytes); }, 250);
  try {
    const connected = await connectApp(browser.page, web.origin, network.port);
    report.connection = connected;
    report.tree = await measureTree(browser.page, connected);
    report.index = await bridge.indexed();
    const historySample = { ...summaryAt(5), title: 'Vis measured native history session' };
    report.interactions = await measureInteractions(browser, historySample);
    // Keep the browser profile and populated Bridge. Reconnect through the
    // normal entry form so the warm measurement still traverses the real wire.
    const warm = await connectApp(browser.page, web.origin, network.port);
    report.warmConnection = warm;
    report.warmTree = await measureTree(browser.page, warm);
    report.warmInteractions = await measureInteractions(browser, historySample);
    const eventTiming = await measureEventVisibility(browser.page, native.descriptor.opencode, historySample.nativeSessionId);
    report.eventVisible = { ...eventTiming, budgetMs: SLO.eventVisibleMs, passed: eventTiming.ms <= SLO.eventVisibleMs };
    report.renderer = await browser.heap();
    report.bridgeObservedRssPeakBytes = Math.max(rssPeak, bridge.rss().rssBytes);
    const label = count > 10000 ? '100k' : '10k';
    const mib = 1024 * 1024;
    const bridgeAdditionalRssMiB = Math.max(0, report.bridgeObservedRssPeakBytes - report.baseline.bridgeRssBytes) / mib;
    const rendererAdditionalHeapMiB = Math.max(0, report.renderer.usedSize - report.baseline.renderer.usedSize) / mib;
    report.memory = {
      bridgeAdditionalRssMiB,
      bridgeBudgetMiB: SLO.bridgeRssMiB[label],
      rendererAdditionalHeapMiB,
      rendererBudgetMiB: SLO.rendererHeapMiB[label],
      passed: bridgeAdditionalRssMiB <= SLO.bridgeRssMiB[label] && rendererAdditionalHeapMiB <= SLO.rendererHeapMiB[label],
    };
    report.network = { ...network.stats };
    if (!report.memory.passed) throw new Error('Production memory sample exceeded the profile budget');
    report.status = 'passed';
  } catch (error) {
    try {
      const screenshot = path.join(output, 'failure.png');
      await browser.page.screenshot({ path: screenshot, timeout: 5000 });
      report.failureScreenshot = screenshot;
    } catch (captureError) {
      report.failureScreenshotError = String(captureError);
    }
    throw error;
  } finally {
    clearInterval(monitor);
  }
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  const failures = [];
  for (const close of cleanup.reverse()) {
    try { await close(); }
    catch (error) { failures.push({ reason: error }); }
  }
  try {
    if (report.index) {
      report.inventory = indexInventory(state, count);
      if (report.index.failures.length || !report.inventory.coverage || report.inventory.workspaces !== 200) {
        throw new Error('Production index did not enumerate the complete fixture');
      }
    }
  } catch (error) {
    failures.push({ reason: error });
  } finally {
    if (fixture) {
      try { await rm(fixture, { recursive: true, force: true }); }
      catch (error) { failures.push({ reason: error }); }
    }
  }
  try {
    assertPerfCheckout(repository, productionRevision, sourceHashes);
  } catch (error) {
    failures.push({ reason: error });
  }
  if (failures.length) {
    report.status = 'failed';
    report.cleanupOrEvidenceErrors = failures.map(result => String(result.reason));
    process.exitCode = 1;
  }
  const finishedAt = new Date().toISOString();
  const reportPath = path.join(output, 'report.json');
  writeJson(reportPath, report);
  writeJson(path.join(output, 'run-receipt.json'), {
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt,
    productionRevision,
    count,
    rttMs,
    exitCode: process.exitCode ?? 0,
    reportSha256: digest(await readFile(reportPath)),
  });
  console.log(report.status, path.join(output, 'report.json'));
}
