import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
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
  let spawnFailure;
  const exited = new Promise(resolve => {
    processHandle.once('exit', (code, signal) => resolve({ code, signal }));
    processHandle.once('error', error => { spawnFailure = error; resolve({ error }); });
  });
  const discovered = await until(async () => {
    if (spawnFailure) throw spawnFailure;
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error('Chrome exited before opening DevTools');
    const activePort = path.join(userDataDirectory, 'DevToolsActivePort');
    let registration;
    try { registration = await readFile(activePort, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const [portText, browserPath] = registration.trim().split(/\r?\n/u);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath?.startsWith('/devtools/browser/')) return null;
    // Chrome may bind IPv6 loopback only when its chosen port is busy on IPv4.
    // Require the exact registration path so a different listener can't be used.
    for (const host of ['127.0.0.1', '[::1]']) {
      const version = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(500), redirect: 'error' })
        .then(response => response.ok ? response.json() : null).catch(() => null);
      if (version?.webSocketDebuggerUrl === `ws://${host}:${port}${browserPath}`) return { port, endpoint: version.webSocketDebuggerUrl };
    }
    return null;
  }, 'Chrome CDP endpoint', 15000).then(async ({ port, endpoint }) => ({
    port, browser: await chromium.connectOverCDP(endpoint, { timeout: 5000 }),
  })).catch(async error => {
    processHandle.kill('SIGTERM');
    await exited;
    stream.end();
    throw error;
  });
  const { port, browser } = discovered;
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
  const wire = { frames: 0, bytes: 0, methods: {}, historySessions: [], errors: [], timeline: [], startup: {}, titleEvent: null, last: null };
  const requests = new Map();
  cdp.on('Network.requestWillBeSent', ({ request, timestamp }) => {
    const url = new URL(request.url);
    const title = url.pathname === '/qa/event' ? url.searchParams.get('title') : null;
    if (title?.startsWith('Vis measured native title update ')) wire.titleEvent = { title, requestAt: timestamp, observerFrames: [] };
  });
  cdp.on('Network.webSocketFrameSent', ({ requestId, response, timestamp }) => {
    try { const parsed = JSON.parse(response.payloadData); if (parsed.method) { wire.methods[parsed.method] = (wire.methods[parsed.method] ?? 0) + 1; requests.set(`${requestId}:${parsed.id}`, parsed.method);
      if (parsed.method === 'runtime.history.open' && parsed.params?.session && wire.historySessions.length < 64) {
        wire.historySessions.push(parsed.params.session);
      }
      const trace = wire.titleEvent;
      if (trace && trace.canonicalMs === undefined && trace.observerFrames.length < 32 && parsed.method === 'runtime.observer.read') {
        trace.observerFrames.push({ direction: 'sent', id: parsed.id, ms: (timestamp - trace.requestAt) * 1000 });
      }
      const startup = wire.startup[requestId];
      if (startup?.length < 20 && ['runtime.inspect', 'runtime.snapshot'].includes(parsed.method)) {
        startup.push({ at: Date.now(), sent: parsed.method, collection: parsed.params?.collection });
      } } } catch {}
  });
  cdp.on('Network.webSocketFrameReceived', ({ requestId, response, timestamp }) => {
    wire.frames++;
    wire.bytes += Buffer.byteLength(response.payloadData);
    const parsed = (() => { try { return JSON.parse(response.payloadData); } catch { return null; } })();
    const key = parsed?.id ? `${requestId}:${parsed.id}` : undefined;
    const method = key ? requests.get(key) : undefined;
    if (key) requests.delete(key);
    if (parsed?.kind === 'hello') wire.startup[requestId] = [{ at: Date.now(), received: 'hello' }];
    if (wire.startup[requestId]?.length < 20 && ['runtime.inspect', 'runtime.snapshot'].includes(method)) {
      wire.startup[requestId].push({
        at: Date.now(), received: method, bytes: Buffer.byteLength(response.payloadData), collection: parsed.result?.items?.[0]?.collection,
      });
    }
    if (wire.timeline.length < 100 && ['runtime.inspect', 'runtime.snapshot'].includes(method)) wire.timeline.push({ at: Date.now(), method, collection: parsed.result?.items?.[0]?.collection, count: parsed.result?.items?.length, watermark: parsed.result?.watermark });
    const canonical = method === 'runtime.entity.resolve' ? parsed.result
      : method === 'runtime.observer.read' ? parsed.result?.canonical : undefined;
    const trace = wire.titleEvent;
    if (trace && trace.canonicalMs === undefined && trace.observerFrames.length < 32 && method === 'runtime.observer.read') {
      trace.observerFrames.push({ direction: 'received', id: parsed.id, ms: (timestamp - trace.requestAt) * 1000,
        kind: parsed.result?.kind, collection: parsed.result?.frame?.payload?.collection });
    }
    if (trace && trace.canonicalMs === undefined && canonical?.collection === 'session_summaries'
      && canonical.value?.title === trace.title) {
      trace.method = method;
      trace.canonicalMs = (timestamp - trace.requestAt) * 1000;
    }
    if (!wire.firstCanonicalSessionAt && canonical?.collection === 'session_summaries' && canonical.value) wire.firstCanonicalSessionAt = Date.now();
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
    const start = performance.now();
    const times = { topology: null, selectable: null, firstExpansion: null };
    const canHit = element => {
      if (!(element instanceof HTMLElement) || element.closest('[inert], [aria-disabled="true"]')) return false;
      const row = element.getBoundingClientRect();
      const tree = element.closest('[role="tree"]')?.getBoundingClientRect();
      if (!tree) return false;
      const left = Math.max(row.left, tree.left, 0), top = Math.max(row.top, tree.top, 0);
      const right = Math.min(row.right, tree.right, innerWidth), bottom = Math.min(row.bottom, tree.bottom, innerHeight);
      if (right <= left || bottom <= top) return false;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return hit !== null && element.contains(hit);
    };
    const anyHit = selector => Array.from(document.querySelectorAll(selector)).some(canHit);
    function measureFrame(time) {
      if (times.topology === null && anyHit('[data-tree-row]')) times.topology = time;
      if (times.selectable === null && anyHit('[data-tree-row][data-row-kind="session"]')) times.selectable = time;
      if ((times.topology === null || times.selectable === null) && time - start < 180000) requestAnimationFrame(measureFrame);
    }
    window.__visMeasuredTree = { times, canHit };
    requestAnimationFrame(measureFrame);
    document.querySelector('[data-testid="bridge-login"] button[type="submit"]').click();
    return start;
  });
  await page.locator('[data-testid="unified-session-tree"]').waitFor({ timeout: 180000 });
  return page.evaluate(start => ({ start, startEpoch: performance.timeOrigin + start, shellMs: performance.now() - start }), start);
}

export async function measureTree(page, connected) {
  await page.waitForFunction(() => window.__visMeasuredTree.times.topology !== null, undefined, { timeout: 30000 });
  const expanded = new Set();
  await until(async () => {
    const ready = await page.evaluate(() => window.__visMeasuredTree.times.selectable !== null);
    if (ready) return true;
    const entered = await page.locator('[data-tree-row][aria-expanded="false"]').evaluateAll((elements, attempted) => {
      const candidate = elements.find(element => window.__visMeasuredTree.canHit(element) && !attempted.includes(element.getAttribute('data-row-key')));
      return candidate?.getAttribute('data-row-key') ?? null;
    }, [...expanded]);
    if (entered !== null) {
      expanded.add(entered);
      const group = page.locator(`[data-row-key=${JSON.stringify(entered)}]`);
      await group.evaluate(element => element.addEventListener('click', () => {
        window.__visMeasuredTree.times.firstExpansion ??= performance.now();
      }, { once: true, capture: true }));
      await group.click();
    }
    return false;
  }, 'actual tree first selectable session', 30000);
  const times = await page.evaluate(() => window.__visMeasuredTree.times);
  const topologyMs = times.topology - connected.start;
  const firstSelectableMs = times.selectable - connected.start;
  const appearance = times.firstExpansion === null || times.selectable < times.firstExpansion ? 'automatic' : 'after-expansion';
  const renderedRows = await page.locator('[data-tree-row]').count();
  return { topologyMs, firstSelectableMs, appearance, expansionActions: expanded.size, renderedRows };
}

export async function measureInteractions({ page, wire }, target) {
  const search = page.getByTestId('unified-search-input');
  await search.fill(target.title);
  const searchStarted = await page.evaluate(() => performance.now());
  await search.press('Enter');
  const title = page.getByText(target.title, { exact: true });
  const result = page.getByTestId('search-result').filter({ has: title });
  const searchError = page.getByTestId('search-error');
  async function waitForSearch(locator) {
    await locator.or(searchError).first().waitFor({ timeout: 120000 });
    if (await searchError.isVisible()) {
      throw new Error(`Runtime session search failed for ${JSON.stringify(target.title)}: ${await searchError.innerText()}`);
    }
  }
  await waitForSearch(result);
  const searchMs = await page.evaluate(time => performance.now() - time, searchStarted);
  // Selecting can switch the visible sidebar pane. Capture the completion
  // marker while the search results surface is still on screen.
  await waitForSearch(page.getByTestId('search-summary'));
  const searchCompleteMs = await page.evaluate(time => performance.now() - time, searchStarted);
  const row = { title: target.title, nativeSessionId: target.nativeSessionId, harness: target.source };
  const expectedHistory = row.harness === 'opencode' || row.harness === 'acp'
    ? `Seed090 native history for ${target.nativeSessionId}.` : null;
  const openedBeforeSelection = wire.historySessions.length;
  const selectedAt = await result.evaluate((element, expected) => {
    const startedAt = performance.now();
    if (expected) {
      window.__visHistoryVisible = new Promise(resolve => {
        // The runner polls its locators from outside Chromium. Timestamp the
        // first visible history frame on the same clock as the selection.
        let scheduledFrame = null;
        const scroll = new AbortController();
        function finish(time) {
          clearTimeout(timeout);
          if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
          observer.disconnect();
          scroll.abort();
          resolve(time);
        }
        function visibleMarker() {
          const messages = document.querySelectorAll('.output-panel-messages :is(.message-content, p)');
          return Array.from(messages).some(node => {
            if (node.textContent.trim() !== expected || !node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
            const rect = node.getBoundingClientRect();
            const panel = node.closest('.output-panel-scroll')?.getBoundingClientRect();
            return panel && Math.max(0, rect.left, panel.left) < Math.min(innerWidth, rect.right, panel.right)
              && Math.max(0, rect.top, panel.top) < Math.min(innerHeight, rect.bottom, panel.bottom);
          });
        }
        function measure(time) {
          scheduledFrame = null;
          if (visibleMarker()) finish(time - startedAt);
        }
        function schedule() {
          if (scheduledFrame === null) scheduledFrame = requestAnimationFrame(measure);
        }
        if (visibleMarker()) throw new Error('Expected history was already visible before selection');
        const observer = new MutationObserver(schedule);
        const timeout = setTimeout(() => finish(null), 30000);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        document.addEventListener('scroll', schedule, { capture: true, passive: true, signal: scroll.signal });
      });
    }
    element.click();
    return startedAt;
  }, expectedHistory);
  await page.locator('textarea[role="combobox"]').waitFor({ timeout: 30000 });
  const selectionVisibleMs = await page.evaluate((time) => performance.now() - time, selectedAt);
  let historyMs = null;
  let historyLocatorMs = null;
  let observedHistorySession = null;
  if (expectedHistory) {
    await page.getByText(expectedHistory, { exact: true }).first().waitFor({ timeout: 30000 });
    historyLocatorMs = await page.evaluate((time) => performance.now() - time, selectedAt);
    historyMs = await page.evaluate(async () => {
      const time = await window.__visHistoryVisible;
      delete window.__visHistoryVisible;
      return time;
    });
    if (historyMs === null) throw new Error('Expected history never reached a visible renderer frame');
    observedHistorySession = wire.historySessions.slice(openedBeforeSelection)
      .find(session => session.nativeSessionId === target.nativeSessionId);
    if (!observedHistorySession) throw new Error('Renderer did not open history for the selected session');
  }
  const scroll = page.getByTestId('unified-scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  const group = scroll.locator('[data-row-kind="repo"][aria-expanded], [data-row-kind="section"][aria-expanded]').first();
  await group.waitFor({ state: 'visible', timeout: 5000 });
  const expand = await group.evaluate(async (element) => {
    const key = element.getAttribute('data-row-key');
    const selector = `[data-row-key="${CSS.escape(key)}"]`;
    const samples = [];
    for (let index = 0; index < 10; index++) {
      const row = document.querySelector(selector);
      const expanded = row?.getAttribute('aria-expanded');
      if (expanded == null) throw new Error('Measured tree group disappeared');
      const start = performance.now();
      row.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.querySelector(selector)?.getAttribute('aria-expanded') !== String(expanded === 'false')) {
        throw new Error('Measured tree group did not toggle');
      }
      samples.push(performance.now() - start);
    }
    return samples;
  });
  return { row, searchMs, searchCompleteMs, selectionVisibleMs, historyMs, historyLocatorMs, observedHistorySession, expand };
}

export async function measureEventVisibility(page, nativeOrigin, nativeSessionId) {
  const title = `Vis measured native title update ${randomUUID()}`;
  const endpoint = new URL('/qa/event', nativeOrigin);
  endpoint.searchParams.set('title', title);
  return page.evaluate(async ({ url, title, nativeSessionId }) => {
    let timeout;
    let observer;
    const visible = new Promise(resolve => {
      observer = new MutationObserver(() => {
        if (document.querySelector('.top-panel .selected-title')?.textContent?.trim() === title) {
          resolve(performance.now());
        }
      });
      timeout = setTimeout(() => resolve(null), 10000);
      observer.observe(document.body, { subtree: true, characterData: true, childList: true });
    });
    try {
      const startedAt = performance.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Native title update failed (HTTP ${response.status})`);
      const updated = await response.json();
      if (updated.sessionId !== nativeSessionId || updated.title !== title) {
        throw new Error('Native fixture updated a different session');
      }
      const visibleAt = await visible;
      if (visibleAt === null) throw new Error('Native title update did not reach the selected session');
      const requestToVisibleMs = visibleAt - startedAt;
      const { preparationMs } = updated;
      if (!Number.isFinite(preparationMs) || preparationMs < 0 || preparationMs > requestToVisibleMs) {
        throw new Error('Native fixture preparation timing is invalid');
      }
      // Subtract only the fixture's synchronous work before emission. The
      // remaining duration still includes the request and event transport.
      return { ms: requestToVisibleMs - preparationMs, requestToVisibleMs, preparationMs };
    } finally {
      clearTimeout(timeout);
      observer.disconnect();
    }
  }, { url: endpoint.href, title, nativeSessionId });
}
