#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { productionSource, sourceSnapshot, validateSources, writeJson } from './runtime-v090-evidence.mjs';
import { buildApp, serveApp } from './runtime-v090-perf-app.mjs';
import { connectApp, measureEventVisibility, measureInteractions, measureTree, openBrowser } from './runtime-v090-perf-browser.mjs';
import { indexInventory, prepareFixture, repository, startBridge, startNative } from './runtime-v090-perf-harness.mjs';
import { summaryAt } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';
import { SLO } from './runtime-v090-benchmark.mjs';
import { shapeRuntimeNetwork } from './runtime-v090-perf-network.mjs';

const { values } = parseArgs({ options: { count: { type: 'string' }, out: { type: 'string' }, rtt: { type: 'string', default: '0' } } });
const count = Number(values.count);
const rttMs = Number(values.rtt);
if (!Number.isInteger(count) || count < 10 || count > 100000 || count % 5 !== 0 || !values.out || ![0, 100].includes(rttMs)) {
  throw new Error('Use --count 10..100000 (multiple of 5) --out <new evidence directory> [--rtt 0|100]');
}
const output = path.resolve(values.out);
await mkdir(output);
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
const productionRevision = git('rev-parse', 'HEAD').trim();
const sourceFiles = git('ls-files', '-z', '--', 'app', 'bridge', 'shared', 'scripts/qa', 'public', 'vis_bridge.js', 'index.html', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts').split('\0').filter(Boolean);
const sourceHashes = sourceSnapshot(repository, sourceFiles);
const report = {
  measurementScope: 'single-sample-production-app-and-bridge',
  productionRevision,
  productionSource: productionSource(repository, sourceHashes, productionRevision),
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
    const eventVisibleMs = await measureEventVisibility(browser.page, native.descriptor.opencode, historySample.nativeSessionId);
    report.eventVisible = { ms: eventVisibleMs, budgetMs: SLO.eventVisibleMs, passed: eventVisibleMs <= SLO.eventVisibleMs };
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
    validateSources(sourceHashes, repository);
    if (git('rev-parse', 'HEAD').trim() !== productionRevision) throw new Error('Benchmark revision changed');
  } catch (error) {
    failures.push({ reason: error });
  }
  if (failures.length) {
    report.status = 'failed';
    report.cleanupOrEvidenceErrors = failures.map(result => String(result.reason));
    process.exitCode = 1;
  }
  writeJson(path.join(output, 'report.json'), report);
  console.log(report.status, path.join(output, 'report.json'));
}
