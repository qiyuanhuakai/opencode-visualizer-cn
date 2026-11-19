import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { readProcessTreeRss } from './runtime-v090-benchmark.mjs';
import { until, json } from './runtime-v090-perf-harness.mjs';

export async function openBrowser(output, userDataDirectory = `${output}-profile`) {
  await mkdir(userDataDirectory, { recursive: true });
  await rm(path.join(userDataDirectory, 'DevToolsActivePort'), { force: true });
  const stream = createWriteStream(`${output}-chrome.log`);
  const processHandle = spawn(process.env.VIS_PERF_CHROME ?? '/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--enable-precise-memory-info', '--js-flags=--expose-gc', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--lang=en-US', `--user-data-dir=${userDataDirectory}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle.stdout.pipe(stream); processHandle.stderr.pipe(stream);
  const exited = new Promise((resolve) => processHandle.once('exit', (code, signal) => resolve({ code, signal })));
  const port = await until(async () => {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited ${processHandle.exitCode}`);
    try { return Number((await readFile(path.join(userDataDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, 'Chrome CDP port');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await context.addInitScript(() => {
    window.__productionPerf = { longTasks: [], errors: [], frames: [], start: performance.now() };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__productionPerf.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
    window.addEventListener('error', (event) => window.__productionPerf.errors.push(event.message));
    window.addEventListener('unhandledrejection', (event) => window.__productionPerf.errors.push(String(event.reason)));
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const wire = { frames: 0, bytes: 0, methods: {}, errors: [], timeline: [], last: null };
  const requests = new Map();
  cdp.on('Network.webSocketFrameSent', ({ response }) => {
    try { const parsed = JSON.parse(response.payloadData); if (parsed.method) { wire.methods[parsed.method] = (wire.methods[parsed.method] ?? 0) + 1; requests.set(parsed.id, parsed.method); } } catch {}
  });
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    wire.frames++;
    wire.bytes += Buffer.byteLength(response.payloadData);
    const parsed = (() => { try { return JSON.parse(response.payloadData); } catch { return null; } })();
    const method = parsed?.id ? requests.get(parsed.id) : undefined;
    if (parsed?.id) requests.delete(parsed.id);
    if (wire.timeline.length < 100 && ['runtime.inspect', 'runtime.snapshot'].includes(method)) wire.timeline.push({ at: Date.now(), method, collection: parsed.result?.items?.[0]?.collection, count: parsed.result?.items?.length, watermark: parsed.result?.watermark });
    if (!wire.firstCanonicalSessionAt && method === 'runtime.entity.resolve' && parsed.result?.collection === 'session_summaries' && parsed.result.value) wire.firstCanonicalSessionAt = Date.now();
    if (parsed?.ok === false && wire.errors.length < 100) wire.errors.push({ id: parsed.id, ...parsed.typedError });
    if (parsed) wire.last = parsed;
  });
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return { ...await cdp.send('Runtime.getHeapUsage'), browserRss: readProcessTreeRss(processHandle.pid) };
  };
  return { browser, context, page, cdp, heap, wire, pid: processHandle.pid, cdpPort: port,
    async close() { await writeFile(`${output}-wire.json`, json(wire)); await browser.close(); processHandle.kill('SIGTERM'); const exit = await exited; stream.end(); return exit; },
  };
}

export async function connectApp(page, origin, port) {
  await page.goto(origin, { waitUntil: 'load' });
  await page.locator('#bridge-url').waitFor();
  await page.locator('#bridge-url').fill(`ws://127.0.0.1:${port}/runtime`);
  const start = await page.evaluate(() => {
    const now = performance.now();
    document.querySelector('[data-testid="bridge-login"] button[type="submit"]').click();
    return now;
  });
  await page.locator('[data-testid="unified-session-tree"]').waitFor({ timeout: 180000 });
  return { start, startEpoch: Date.now() - await page.evaluate((time) => performance.now() - time, start), shellMs: await page.evaluate((time) => performance.now() - time, start) };
}

export async function measureTree(page, connected) {
  await page.locator('[data-tree-row]').first().waitFor({ timeout: 30000 });
  const topologyMs = await page.evaluate((time) => performance.now() - time, connected.start);
  const expanded = new Set();
  const selected = await until(async () => {
    const visible = page.locator('[data-row-kind="session"]');
    if (await visible.count()) return visible.first();
    const rows = await page.locator('[data-tree-row]').evaluateAll((elements) => elements.map((element) => ({
      key: element.getAttribute('data-row-key'), kind: element.getAttribute('data-row-kind'), expandable: Boolean(element.querySelector('[data-testid="row-toggle"]:not(.is-leaf)')),
    })));
    const candidate = rows.find((row) => row.expandable && !expanded.has(row.key));
    if (candidate) {
      expanded.add(candidate.key);
      await page.locator(`[data-row-key=${JSON.stringify(candidate.key)}]`).click();
    }
    return false;
  }, 'actual tree first selectable session');
  const firstSelectableMs = await page.evaluate((time) => performance.now() - time, connected.start);
  const renderedRows = await page.locator('[data-tree-row]').count();
  return { topologyMs, firstSelectableMs, renderedRows, selected };
}

export async function measureInteractions(page, selected) {
  const attempted = new Set();
  selected = await until(async () => {
    const candidates = page.locator('[data-row-kind="session"][data-harness="opencode"][data-directory]:not([data-directory=""])');
    if (await candidates.count()) return candidates.first();
    const groups = await page.locator('[data-tree-row]').evaluateAll(elements => elements.map(element => ({ key: element.getAttribute('data-row-key'), expanded: element.getAttribute('aria-expanded'), expandable: Boolean(element.querySelector('[data-testid="row-toggle"]:not(.is-leaf)')) })));
    const candidate = groups.find(group => group.expandable && group.expanded !== 'true' && !attempted.has(group.key));
    if (candidate) { attempted.add(candidate.key); await page.locator(`[data-row-key=${JSON.stringify(candidate.key)}]`).click(); }
    return false;
  }, 'authorized native history session');
  const row = await selected.evaluate((element) => ({ key: element.getAttribute('data-row-key'), title: element.querySelector('.unified-row-label')?.textContent, harness: element.getAttribute('data-harness') }));
  const selectedAt = await page.evaluate((key) => {
    const now = performance.now();
    document.querySelector(`[data-row-key=${JSON.stringify(key)}]`).click();
    return now;
  }, row.key);
  await page.locator('textarea[role="combobox"]').waitFor({ timeout: 30000 });
  const selectionVisibleMs = await page.evaluate((time) => performance.now() - time, selectedAt);
  let historyMs = null;
  if (row.harness === 'opencode' || row.harness === 'acp') {
    await page.getByText('Seed090 selected native history.', { exact: true }).first().waitFor({ timeout: 30000 });
    historyMs = await page.evaluate((time) => performance.now() - time, selectedAt);
  }
  const expand = await page.evaluate(async () => {
    const group = document.querySelector('[data-row-kind="section"],[data-row-kind="repo"]');
    if (!group) return null;
    const samples = [];
    for (let index = 0; index < 10; index++) {
      const start = performance.now(); group.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      samples.push(performance.now() - start);
    }
    return samples;
  });
  return { row, selectionVisibleMs, historyMs, expand };
}
