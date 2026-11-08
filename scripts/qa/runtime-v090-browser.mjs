import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, writeJson } from './runtime-v090-evidence.mjs';

export async function browserScenario(context, frame) {
  // Bind the actual owned listener to port zero; do not probe/release/rebind
  // wildcard ports before opening a loopback-only QA server.
  const http = createHttpServer();
  const server = await createServer({ configFile: false, root: context.root, server: { middlewareMode: true, hmr: { server: http } }, logLevel: 'error' });
  http.on('request', server.middlewares);
  let browser;
  const artifacts = [];
  const scenarios = [];
  const lifecycle = { serverPort: null, browserClosed: false, serverClosed: false };
  try {
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address();
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
        const screenshot = `${context.out}.${context.case}-${variant.expected}-${colorScheme}-${width}.png`;
        await page.screenshot({ path: screenshot, fullPage: true }); artifacts.push(artifact(screenshot, 'screenshot'));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
        await page.getByLabel('Protocol frame').focus();
        await page.keyboard.press('Tab');
        const style = await page.evaluate(() => {
          const button = document.querySelector('#validate'), input = document.querySelector('#frame');
          return { mode: document.documentElement.style.colorScheme, page: getComputedStyle(document.body).backgroundColor,
            input: getComputedStyle(input).backgroundColor, button: getComputedStyle(button).backgroundColor,
            targetHeight: button.getBoundingClientRect().height, keyboardFocus: document.activeElement === button && getComputedStyle(button).outlineStyle !== 'none' };
        });
        assert.equal(style.mode, colorScheme); assert(style.targetHeight >= 44); assert(style.keyboardFocus);
        scenarios.push({ name: `Vis ${variant.expected} ${colorScheme} ${width}`, assertions: [{ name: 'Vis theme and keyboard target', observed: [style.mode, style.targetHeight >= 44, style.keyboardFocus], expected: [colorScheme, true, true], passed: true }] });
      }
    }
    await page.evaluate(() => {
      localStorage.setItem('opencode.settings.themeTokens.v2', JSON.stringify({ version: 2, preset: null, overrides: { 'surface-page': '#112233', 'form-control-bg': '#223344', 'action-button-bg': '#334455' } }));
      dispatchEvent(new StorageEvent('storage', { key: 'opencode.settings.themeTokens.v2' }));
    });
    await page.mouse.move(0, 0);
    const probe = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('#frame')).backgroundColor, getComputedStyle(document.querySelector('#validate')).backgroundColor]);
    assert.deepEqual(probe, ['rgb(17, 34, 51)', 'rgb(34, 51, 68)', 'rgb(51, 68, 85)']);
    scenarios.push({ name: 'Vis resolved custom theme', assertions: [{ name: 'semantic overrides reach page form and action', observed: probe, expected: ['rgb(17, 34, 51)', 'rgb(34, 51, 68)', 'rgb(51, 68, 85)'], passed: true }] });
    const themedScreenshot = `${context.out}.${context.case}-custom-theme-390.png`;
    await page.screenshot({ path: themedScreenshot, fullPage: true }); artifacts.push(artifact(themedScreenshot, 'screenshot'));
    assert.deepEqual(errors, []);
    scenarios.push({ name: 'browser rendering health', assertions: [{ name: 'page errors', observed: errors, expected: [], passed: true }] });
    const trace = `${context.out}.${context.case}-browser-trace.zip`;
    await browserContext.tracing.stop({ path: trace }); artifacts.push(artifact(trace, 'trace'));
    return { scenarios, artifacts, versions: { chromium: browser.version() } };
  } finally {
    try { await browser?.close(); lifecycle.browserClosed = true; } finally {
      try { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
      finally { await server.close(); lifecycle.serverClosed = true; }
    }
    const file = `${context.out}.${context.case}-browser-cleanup.json`;
    writeJson(file, lifecycle); artifacts.push(artifact(file, 'resource-cleanup'));
  }
}
