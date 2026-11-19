import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv[2] ?? '.omo/evidence/vis-v090/task-24/implementation/screenshots';
const THEMES = ['default', 'aurora-tide', 'sakura'];
const SURFACES = ['connection', 'migration-idle', 'migration-backup', 'migration-retry'];
const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const server = await createServer({
  configFile: false,
  appType: 'custom',
  root: process.cwd(),
  plugins: [vue()],
  server: { host: '127.0.0.1', port: Number(process.env.TASK24_PORT ?? 5242), strictPort: true },
  logLevel: 'error',
});
server.middlewares.use('/qa24', (_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 24 evidence</title><link rel="stylesheet" href="/app/dev/task24-evidence.css"></head><body><div id="app"></div><script type="module" src="/app/dev/task24-evidence.ts"></script></body></html>',
  );
});
await server.listen();
const port = server.httpServer.address().port;
const pageUrl = `http://127.0.0.1:${port}/qa24/`;
console.log('serving', pageUrl);

const manifest = [];
let capture = 0;
let browser = await chromium.launch();
const started = Date.now();
try {
  for (const [themeIndex, theme] of THEMES.entries()) {
    for (const surfaceName of SURFACES) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
      });
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.evaluate((value) => window['__task24__'].setTheme(value), theme);
      await page.evaluate((value) => window['__task24__'].setSurface(value), surfaceName);
      await page.waitForFunction(() => Boolean(window['__task24__'] && window['__task24__'].ready), undefined, {
        timeout: 20000,
      });
      for (const viewport of WIDTHS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(150);
        const state = await page.evaluate(() => window['__task24__'].state());
        const name = `${theme}-${surfaceName}-${viewport.name}.png`;
        await page.screenshot({ path: path.join(OUT, name), fullPage: true });
        manifest.push({ theme, surface: surfaceName, viewport: viewport.name, file: name, state, pageErrors });
        capture += 1;
      }
      await page.close();
    }
    if (themeIndex < THEMES.length - 1) {
      await browser.close();
      browser = await chromium.launch();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
await mkdir(OUT, { recursive: true });
await writeFile(
  path.join(OUT, 'manifest.json'),
  `${JSON.stringify({ url: pageUrl, themes: THEMES, surfaces: SURFACES, widths: WIDTHS.map((w) => w.name), captures: capture, elapsedMs: Date.now() - started, entries: manifest }, null, 2)}\n`,
);
console.log(`captured ${capture} screenshots`);
