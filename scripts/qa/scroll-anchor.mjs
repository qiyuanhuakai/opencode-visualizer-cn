import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, strictPort: false, open: false } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('QA server has no listening URL');
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { preserveScrollAnchor } = await import('/utils/scrollAnchor.ts');
    const host = document.createElement('div');
    host.id = 'transaction-qa';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:400px;height:600px;overflow:auto;background:white;z-index:999999';
    document.body.append(host);
    const row = (id, height) => {
      const el = document.createElement('div');
      el.style.height = `${height}px`;
      el.style.overflow = 'hidden';
      el.textContent = `阅读位置 ${id}`;
      return el;
    };
    for (let i = 0; i < 100; i++) host.append(row(i, 60));
    host.scrollTop = 5400;
    const anchor = host.children[20];
    const viewportTop = anchor.getBoundingClientRect().top;
    let clamped = 0;
    await preserveScrollAnchor(host, anchor, async () => {
      for (let i = 0; i < 20; i++) host.firstElementChild.remove();
      for (let i = 100; i < 120; i++) host.append(row(i, 20));
      clamped = host.scrollTop;
      return true;
    });
    const corrected = host.scrollTop;
    const anchorDrift = anchor.getBoundingClientRect().top - viewportTop;
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    host.firstElementChild.style.height = '300px';
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    return { clamped, corrected, anchorDrift, afterLateGrowth: host.scrollTop, nativeAnchor: getComputedStyle(host).overflowAnchor };
  });
  assert.equal(result.clamped, 4600);
  assert.equal(result.corrected, 4200);
  assert.equal(result.anchorDrift, 0);
  assert.equal(result.nativeAnchor, 'auto');
  assert.equal(result.afterLateGrowth, 4440);
  await page.locator('#transaction-qa').hover();
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(() => document.querySelector('#transaction-qa').scrollTop === 4240);
  console.log('PASS: range clamping, late layout growth and continued wheel input', result);
} finally {
  await browser?.close();
  await server.close();
}
