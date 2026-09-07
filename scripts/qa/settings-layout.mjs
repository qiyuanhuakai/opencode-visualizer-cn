import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const output = path.resolve(process.env.VIS_SETTINGS_LAYOUT_QA_OUT ?? '/tmp/opencode/settings-layout-qa');
mkdirSync(output, { recursive: true });
const baseUrl = process.env.VIS_SETTINGS_LAYOUT_QA_URL ?? 'http://127.0.0.1:5173';
const longWindowsPath = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe --goto D:\\workspace\\project\\src\\index.ts';
const fixture = (page, { locale, localPath, phase } = {}) => {
  const params = new URLSearchParams({ page });
  if (locale) params.set('locale', locale);
  if (localPath) params.set('path', localPath);
  if (phase) params.set('phase', phase);
  return `${baseUrl}/dev/settings-layout-fixture.html?${params}`;
};
const editorRowLabel = { en: 'Local application', 'zh-CN': '本地应用' };

const observations = [];
let server;
let browser;
try {
  server = spawn('pnpm', ['dev'], { cwd: path.resolve(import.meta.dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/dev/settings-layout-fixture.html`);
      if (response.ok) break;
    } catch { /* server not up yet */ }
    if (Date.now() > deadline) throw new Error(`vite dev server did not start\n${serverLog}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  browser = await chromium.launch({ chromiumSandbox: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const shot = async (name, url, width, scrollSelector) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url);
    await page.waitForSelector('body[data-fixture-ready="true"]', { state: 'attached' });
    await page.waitForSelector('dialog[open]', { state: 'attached' });
    await page.waitForSelector('dialog[open] .modal-close-button svg path', { state: 'attached', timeout: 15000 });
    if (scrollSelector) {
      await page.locator(scrollSelector).first().evaluate((element) => element.scrollIntoView({ block: 'center' }));
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = path.join(output, `${name}-${width}.png`);
    await page.screenshot({ path: screenshot });
    return screenshot;
  };

  const editorGeometry = async (label) => {
    return page.evaluate((rowLabel) => {
      const row = Array.from(document.querySelectorAll('dialog[open] .setting-row')).find(
        (candidate) => candidate.querySelector('.setting-label')?.textContent === rowLabel,
      );
      if (!row) return { found: false };
      const info = row.querySelector('.setting-info').getBoundingClientRect();
      const controls = row.querySelector('.local-application-controls');
      const controlsRect = controls.getBoundingClientRect();
      const children = Array.from(controls.children).map((child) => {
        const rect = child.getBoundingClientRect();
        return { tag: child.tagName.toLowerCase(), top: rect.top, left: rect.left, width: rect.width };
      });
      return {
        found: true,
        direction: getComputedStyle(row).flexDirection,
        controlsBelowInfo: controlsRect.top >= info.bottom - 1,
        infoWidth: info.width,
        controlsWidth: controlsRect.width,
        rowWidth: row.getBoundingClientRect().width,
        children,
        input: row.querySelector('.local-application-controls input').getBoundingClientRect().toJSON(),
      };
    }, label);
  };

  const desktopGeometry = async () => {
    return page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('dialog[open] .desktop-update-card'));
      return cards.map((card) => {
        const header = card.querySelector('.desktop-update-header').getBoundingClientRect();
        const versions = card.querySelector('.desktop-update-versions').getBoundingClientRect();
        const actions = card.querySelector('.desktop-update-actions')?.getBoundingClientRect() ?? null;
        const summary = card.querySelector('.desktop-update-summary');
        const extra = card.querySelector('.desktop-update-extra-actions');
        return {
          component: card.getAttribute('data-testid'),
          headerAboveVersions: header.bottom <= versions.top + 1,
          versions: versions.toJSON(),
          actions: actions ? actions.toJSON() : null,
          sameRow: actions ? actions.top < versions.bottom && versions.top < actions.bottom : null,
          actionsRightOfVersions: actions ? actions.left >= versions.left : null,
          summaryButtonCount: summary ? summary.querySelectorAll('button').length : null,
          extraActions: extra
            ? {
                buttonCount: extra.querySelectorAll('button').length,
                belowSummary: extra.getBoundingClientRect().top >= summary.getBoundingClientRect().bottom - 1,
              }
            : null,
          horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
        };
      });
    });
  };

  const editor1280 = await shot('editor', fixture('editor'), 1280);
  let geometry = await editorGeometry(editorRowLabel.en);
  assert.ok(geometry.found, 'local application row must render on the editor page');
  assert.equal(geometry.direction, 'column', 'local application row must stack vertically');
  assert.ok(geometry.controlsBelowInfo, 'controls row must sit below label/description');
  const editorWideTops = new Set(geometry.children.map((child) => Math.round(child.top)));
  assert.equal(editorWideTops.size, 1, 'input, choose app, and remove must share one row at 1280px');
  assert.ok(geometry.input.width > geometry.rowWidth * 0.4, 'path input must get the row width, not be squeezed beside the label');
  observations.push({ screenshot: editor1280, geometry });

  const editor375 = await shot('editor', fixture('editor'), 375, '.local-application-controls');
  geometry = await editorGeometry(editorRowLabel.en);
  assert.ok(geometry.found && geometry.controlsBelowInfo, 'narrow editor row must keep controls below the label');
  assert.ok(geometry.children.every((child) => child.width <= geometry.controlsWidth + 1), 'no control may overflow its row at 375px');
  observations.push({ screenshot: editor375, geometry });

  const desktop1280 = await shot('desktop', fixture('desktop'), 1280);
  let cards = await desktopGeometry();
  assert.equal(cards.length, 2, 'desktop page must render app and bridge cards');
  for (const card of cards) {
    assert.ok(card.headerAboveVersions, `${card.component}: header must stay the top row`);
    assert.ok(card.sameRow, `${card.component}: check updates must share the version row`);
    assert.ok(card.actionsRightOfVersions, `${card.component}: actions must sit right of the version text`);
    assert.equal(card.summaryButtonCount, 1, `${card.component}: idle summary row must hold only the check button`);
    assert.equal(card.extraActions, null, `${card.component}: idle phase must not render the extra actions row`);
    assert.ok(!card.horizontalOverflow, `${card.component}: no horizontal overflow`);
  }
  observations.push({ screenshot: desktop1280, cards });

  const desktop768 = await shot('desktop', fixture('desktop'), 768);
  cards = await desktopGeometry();
  for (const card of cards) {
    assert.ok(card.sameRow, `${card.component}: check updates must still share the version row at 768px`);
    assert.ok(!card.horizontalOverflow, `${card.component}: no horizontal overflow at 768px`);
  }
  observations.push({ screenshot: desktop768, cards });

  const desktop375 = await shot('desktop', fixture('desktop'), 375);
  cards = await desktopGeometry();
  for (const card of cards) {
    assert.ok(card.sameRow, `${card.component}: check updates must still share the version row at 375px`);
    assert.ok(!card.horizontalOverflow, `${card.component}: no horizontal overflow at 375px`);
  }
  observations.push({ screenshot: desktop375, cards });

  for (const phase of ['available', 'downloaded', 'error']) {
    for (const width of [1280, 768, 375]) {
      const phaseShot = await shot(`desktop-${phase}`, fixture('desktop', { phase }), width);
      cards = await desktopGeometry();
      for (const card of cards) {
        assert.ok(card.sameRow, `${card.component} (${phase}): check must share the version row at ${width}px`);
        assert.equal(card.summaryButtonCount, 1, `${card.component} (${phase}): summary row must hold only the check button at ${width}px`);
        assert.ok(card.extraActions, `${card.component} (${phase}): extra actions row must exist`);
        assert.ok(card.extraActions.belowSummary, `${card.component} (${phase}): extra actions must sit below the summary at ${width}px`);
        assert.ok(!card.horizontalOverflow, `${card.component} (${phase}): no horizontal overflow at ${width}px`);
      }
      observations.push({ screenshot: phaseShot, phase, width, cards });
    }
  }

  const editorZh1280 = await shot('editor-zh', fixture('editor', { locale: 'zh-CN', localPath: longWindowsPath }), 1280, '.local-application-controls');
  geometry = await editorGeometry(editorRowLabel['zh-CN']);
  assert.ok(geometry.found && geometry.controlsBelowInfo, 'zh-CN editor row must keep controls below the label');
  assert.ok(geometry.children.every((child) => child.width <= geometry.controlsWidth + 1), 'no control may overflow its row at zh-CN 1280px');
  observations.push({ screenshot: editorZh1280, geometry });

  const editorZh375 = await shot('editor-zh', fixture('editor', { locale: 'zh-CN', localPath: longWindowsPath }), 375, '.local-application-controls');
  geometry = await editorGeometry(editorRowLabel['zh-CN']);
  assert.ok(geometry.found && geometry.controlsBelowInfo, 'zh-CN narrow editor row must keep controls below the label');
  assert.ok(geometry.children.every((child) => child.width <= geometry.controlsWidth + 1), 'no control may overflow its row at zh-CN 375px');
  observations.push({ screenshot: editorZh375, geometry });

  const desktopZh1280 = await shot('desktop-zh', fixture('desktop', { locale: 'zh-CN' }), 1280);
  cards = await desktopGeometry();
  for (const card of cards) {
    assert.ok(card.sameRow, `${card.component}: zh-CN check updates must share the version row at 1280px`);
    assert.ok(!card.horizontalOverflow, `${card.component}: no horizontal overflow at zh-CN 1280px`);
  }
  observations.push({ screenshot: desktopZh1280, cards });

  const desktopZh375 = await shot('desktop-zh', fixture('desktop', { locale: 'zh-CN' }), 375);
  cards = await desktopGeometry();
  for (const card of cards) {
    assert.ok(card.sameRow, `${card.component}: zh-CN check updates must still share the version row at 375px`);
    assert.ok(!card.horizontalOverflow, `${card.component}: no horizontal overflow at zh-CN 375px`);
  }
  observations.push({ screenshot: desktopZh375, cards });

  assert.deepEqual(pageErrors, [], 'the fixture page must run without page errors');
  writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ pass: true, observations }, null, 2));
  console.log(JSON.stringify({ pass: true, screenshots: observations.map((entry) => entry.screenshot) }, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
}
