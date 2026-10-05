import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, writeJson } from './runtime-v090-evidence.mjs';

export async function browserScenario(context, frame) {
  const server = await createServer({ configFile: false, root: context.root, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  let browser;
  const artifacts = [];
  const scenarios = [];
  const lifecycle = { serverPort: null, browserClosed: false, serverClosed: false };
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert(address && typeof address === 'object', 'server must bind a private port');
    lifecycle.serverPort = address.port;
    browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    await browserContext.tracing.start({ screenshots: true, snapshots: true });
    const page = await browserContext.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/app/dev/runtime-v090/index.html`);
    for (const variant of [{ name: 'valid fixture', input: frame, expected: 'accepted' }, { name: 'invalid version', input: { ...frame, version: 999 }, expected: 'rejected' }]) {
      await page.getByLabel('Protocol frame').fill(JSON.stringify(variant.input));
      await page.getByRole('button', { name: 'Validate frame' }).click();
      const result = JSON.parse(await page.getByRole('status').innerText());
      assert.equal(result.status, variant.expected);
      if (variant.expected === 'accepted') assert.deepEqual(result.frame, frame);
      else assert.equal(result.code, 'version_mismatch');
      scenarios.push({ name: `browser ${variant.name}`, assertions: [{ name: 'rendered protocol result', observed: result.status, expected: variant.expected, passed: true }, { name: 'shared validator output', observed: result.frame ?? result.code, expected: variant.expected === 'accepted' ? frame : 'version_mismatch', passed: true }] });
      for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
        await page.emulateMedia({ colorScheme }); await page.setViewportSize({ width, height: 900 });
        const screenshot = path.join(context.outDir, `${context.case}-${variant.expected}-${colorScheme}-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: true }); artifacts.push(artifact(screenshot, 'screenshot'));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
      }
    }
    assert.deepEqual(errors, []);
    scenarios.push({ name: 'browser rendering health', assertions: [{ name: 'page errors', observed: errors, expected: [], passed: true }] });
    const trace = path.join(context.outDir, `${context.case}-browser-trace.zip`);
    await browserContext.tracing.stop({ path: trace }); artifacts.push(artifact(trace, 'trace'));
    return { scenarios, artifacts, versions: { chromium: browser.version() } };
  } finally {
    try { await browser?.close(); lifecycle.browserClosed = true; } finally { await server.close(); lifecycle.serverClosed = true; }
    const file = path.join(context.outDir, `${context.case}-browser-cleanup.json`);
    writeJson(file, lifecycle); artifacts.push(artifact(file, 'resource-cleanup'));
  }
}
