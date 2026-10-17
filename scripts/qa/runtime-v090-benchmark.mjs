#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { cpus, totalmem } from 'node:os';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export function validateSample(sample) {
  if (!['ready', 'disconnected', 'slow', 'error', 'partial'].includes(sample.sourceState)) throw new Error('invalid sourceState');
  if (sample.sourceState !== 'ready' && sample.completeMs !== null) throw new Error('incomplete source cannot have complete timing');
  if (sample.completeMs !== null && (!Number.isFinite(sample.completeMs) || sample.completeMs <= 0)) throw new Error('invalid complete timing');
  return sample;
}

async function browserRss(parentPid) {
  const processes = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, 'utf8');
      processes.push({ pid: Number(name), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  const owned = new Set([parentPid]);
  for (let pass = 0; pass < processes.length; pass++) for (const process of processes) if (owned.has(process.parent)) owned.add(process.pid);
  return processes.filter((process) => owned.has(process.pid)).reduce((sum, process) => sum + process.rss, 0);
}

export async function benchmark(out, repetitions = 10) {
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new RangeError('repetitions must be positive');
  await mkdir(out, { recursive: true });
  const lifecycle = { todo: ['close browser connection', 'close browser server', 'close Vite', 'close native fixture server'], completed: [] };
  const saveLifecycle = () => writeFile(path.join(out, 'lifecycle.json'), json(lifecycle));
  await saveLifecycle();
  const [{ createServer }, { chromium }] = await Promise.all([import('vite'), import('playwright')]);
  let vite; let browserServer; let browser; let native;
  const samples = []; const requests = [];
  try {
    vite = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: true } });
    await vite.listen();
    const url = vite.resolvedUrls.local[0];
    native = createHttpServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      requests.push({ url: request.url, at: Date.now() });
      if (request.url.startsWith('/slow/')) return;
      response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'seed090 source unavailable' }));
    });
    await new Promise((resolve) => native.listen(0, '127.0.0.1', resolve));
    browserServer = await chromium.launchServer({ headless: true });
    lifecycle.browserPid = browserServer.process().pid;
    lifecycle.vitePort = new URL(url).port; lifecycle.nativePort = native.address().port;
    await saveLifecycle();
    browser = await chromium.connect(browserServer.wsEndpoint());
    for (const network of ['local', 'remote']) {
      for (let iteration = 0; iteration < repetitions; iteration++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
        try {
          await context.addInitScript(() => {
            globalThis.__runtimeLongTasks = [];
            new PerformanceObserver((list) => globalThis.__runtimeLongTasks.push(...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
          });
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          if (network === 'remote') await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 20_000_000 / 8, uploadThroughput: 20_000_000 / 8 });
          for (const cache of ['cold', 'warm']) {
            await cdp.send('Network.setCacheDisabled', { cacheDisabled: cache === 'cold' });
            if (cache === 'cold') await cdp.send('Network.clearBrowserCache');
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            const name = `${network}-${cache}-${iteration}`;
            await page.goto(url, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0);
            await cdp.send('HeapProfiler.collectGarbage');
            const heap = await cdp.send('Runtime.getHeapUsage');
            const observed = await page.evaluate(() => ({
              paints: performance.getEntriesByType('paint').map((entry) => ({ name: entry.name, startTime: entry.startTime })),
              marks: performance.getEntriesByType('mark').map((entry) => ({ name: entry.name, startTime: entry.startTime })),
              bytes: [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')].reduce((sum, entry) => sum + entry.transferSize, 0),
              longTasks: globalThis.__runtimeLongTasks,
              visibleText: document.body.innerText,
            }));
            const sample = validateSample({ scenario: name, sourceState: 'disconnected', network, cache, iteration, ...observed,
              firstScreenMs: observed.paints.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
              selectableMs: null, completeMs: null, rendererHeapBytes: heap.usedSize, browserTreeRssBytes: await browserRss(browserServer.process().pid),
              bridgeRssBytes: null, harnessRssBytes: null, hostRunnerRssBytes: process.memoryUsage().rss,
              limitation: 'Old global-backend UI has no mixed-five-source runtime; no authorized native source connected. Session-selectable and complete timing are unmeasurable. Browser RSS includes browser and renderer children; no Bridge was started.' });
            if (!sample.visibleText.trim() || sample.firstScreenMs === null) throw new Error('real UI first paint was not observed');
            samples.push(sample);
            await writeFile(path.join(out, 'raw-samples.json'), json(samples));
            await page.screenshot({ path: path.join(out, `${name}.png`) });
            await context.tracing.stop({ path: path.join(out, `${name}.trace.zip`) });
          }
        } finally { await context.close(); }
      }
    }
    for (const sourceState of ['slow', 'error']) {
      const context = await browser.newContext();
      try {
        await context.addInitScript(({ endpoint }) => {
          localStorage.setItem('opencode.auth.credentials.v1', JSON.stringify({ url: endpoint, username: '', password: '' }));
          localStorage.setItem('opencode.auth.serverUrl.v1', endpoint);
          localStorage.setItem('opencode.auth.backendKind.v1', 'opencode');
        }, { endpoint: `http://127.0.0.1:${native.address().port}/${sourceState}` });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => performance.getEntriesByName('vis:opencode-connect-start').length > 0);
        if (sourceState === 'error') await page.waitForFunction(() => /503|failed|error|失败/i.test(document.body.innerText));
        const observed = await page.evaluate(() => ({ visibleText: document.body.innerText, marks: performance.getEntriesByType('mark').map((entry) => ({ name: entry.name, startTime: entry.startTime })) }));
        const sample = validateSample({ sourceState, completeMs: null, ...observed });
        if (sample.marks.some((entry) => entry.name === 'vis:opencode-full-tree')) throw new Error('incomplete source emitted full-tree completion');
        if (!requests.some((request) => request.url.startsWith(`/${sourceState}/`))) throw new Error('native fixture request was not observed');
        samples.push(sample);
        await writeFile(path.join(out, 'raw-samples.json'), json(samples));
        await page.screenshot({ path: path.join(out, `${sourceState}.png`) });
        await context.tracing.stop({ path: path.join(out, `${sourceState}.trace.zip`) });
      } finally { await context.close(); }
    }
    const files = ['app/App.vue', 'app/composables/useBackendActivation.ts', 'app/workers/sse-shared-worker.ts', 'scripts/qa/runtime-v090-fixtures.mjs', 'scripts/qa/runtime-v090-benchmark.mjs', 'app/dev/runtime-v090/fixtures/seed090.json', 'app/dev/runtime-v090/fixtures/inventory.mjs'];
    const sourceHashes = {};
    for (const file of files) sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    const p95 = {};
    for (const network of ['local', 'remote']) for (const cache of ['cold', 'warm']) {
      const values = samples.filter((sample) => sample.network === network && sample.cache === cache).map((sample) => sample.firstScreenMs).sort((a, b) => a - b);
      p95[`${network}-${cache}`] = values[Math.ceil(values.length * 0.95) - 1];
    }
    await writeFile(path.join(out, 'baseline.json'), json({ scenario: 'old-ui-baseline', revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceHashes,
      invocation: process.argv, node: process.version, platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), referenceHardware: '4CPU/16GiB/SSD; host measurements are descriptive, not SLO acceptance',
      browserVersion: browser.version(), repetitions, p95FirstScreenMs: p95, samples, requests, assertions: samples.length * 2, exitCode: 0,
      scope: 'Actual unchanged development UI, empty-renderer baseline and unavailable/slow/error source states. Dataset capacity verification is separate; this does not claim a connected 10k or 100k performance result.' }));
  } finally {
    if (browser) { await browser.close(); lifecycle.completed.push('close browser connection'); }
    if (browserServer) { await browserServer.close(); lifecycle.completed.push('close browser server'); }
    if (vite) { await vite.close(); lifecycle.completed.push('close Vite'); }
    if (native) { native.closeAllConnections(); await new Promise((resolve, reject) => native.close((error) => error ? reject(error) : resolve())); lifecycle.completed.push('close native fixture server'); }
    await saveLifecycle();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--check-sample')) validateSample(JSON.parse(await readFile(args[args.indexOf('--check-sample') + 1], 'utf8')));
    else {
      if (!args.includes('--out')) throw new Error('--out is required');
      await benchmark(path.resolve(args[args.indexOf('--out') + 1]), args.includes('--repetitions') ? Number(args[args.indexOf('--repetitions') + 1]) : 10);
    }
  } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
