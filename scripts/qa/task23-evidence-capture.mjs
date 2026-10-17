import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv[2] ?? '.omo/evidence/vis-v090/task-23/implementation/screenshots';
const URL = process.argv[3] ?? 'http://127.0.0.1:5199/task23-evidence.html';

const THEMES = ['default', 'aurora-tide', 'sakura'];
const KINDS = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'];
const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

let browser = await chromium.launch();
const manifest = [];
let capture = 0;
const started = Date.now();

try {
  for (const [themeIndex, theme] of THEMES.entries()) {
    for (const kind of KINDS) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      await page.goto(URL, { waitUntil: 'load' });
      await page.evaluate((value) => window.__TASK23__?.setTheme(value), theme);
      await page.evaluate((value) => window.__TASK23__?.setKind(value), kind);
      await page.waitForFunction(() => (window.__TASK23__?.state().rows ?? 0) > 0);
      for (const viewport of WIDTHS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForTimeout(120);
        const state = await page.evaluate(() => window.__TASK23__?.state());
        const name = `${theme}-${kind}-${viewport.name}.png`;
        await page.screenshot({ path: path.join(OUT, name), fullPage: true });
        manifest.push({ theme, kind, viewport: viewport.name, file: name, state, pageErrors });
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
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify({ url: URL, themes: THEMES, kinds: KINDS, widths: WIDTHS.map((w) => w.name), captures: capture, elapsedMs: Date.now() - started, entries: manifest }, null, 2)}\n`);
console.log(`captured ${capture} screenshots`);
