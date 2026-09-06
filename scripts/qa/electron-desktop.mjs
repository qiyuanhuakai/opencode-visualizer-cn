import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { closeApp } from './electron-smoke-utils.mjs';

const executablePath = process.env.VIS_ELECTRON_EXECUTABLE;
if (!executablePath) throw new Error('VIS_ELECTRON_EXECUTABLE is required');
const output = path.resolve(process.env.VIS_DESKTOP_QA_OUT ?? '/tmp/opencode/desktop-qa');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'vis-desktop-qa-'));
const observations = [];
let application;
let processErrors = '';
try {
  application = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], chromiumSandbox: true, timeout: 90000 });
  application.process().stderr.on('data', (chunk) => { processErrors += chunk.toString(); });
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.electronAPI?.desktop));
  const initial = await page.evaluate(() => window.electronAPI.desktop.getState());
  assert.equal(initial.preferences.closeToTray, false);
  observations.push({ initial });

  const configured = await page.evaluate(() => window.electronAPI.desktop.configure({ locale: 'zh-CN', closeToTray: true, minimizeToTray: true, notificationSound: false }));
  assert.equal(configured.preferences.locale, 'zh-CN');
  const menu = await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => ({ label: item.label, roles: item.submenu?.items.map((child) => child.role) })));
  assert.ok(menu.every((item) => !['File', 'Edit', 'View', 'Window'].includes(item.label)));
  observations.push({ menu });

  const malformed = await page.evaluate(async () => {
    try { await window.electronAPI.desktop.configure({ closeToTray: 'yes' }); return 'accepted'; }
    catch (error) { return String(error); }
  });
  assert.match(malformed, /Invalid desktop preference/);
  const unsafeTarget = await page.evaluate(async () => {
    try { await window.electronAPI.desktop.install('../../payload'); return 'accepted'; }
    catch (error) { return String(error); }
  });
  assert.match(unsafeTarget, /Invalid update component/);
  observations.push({ malformed, unsafeTarget });

  if (process.env.VIS_DESKTOP_QA_SERVER) {
    await page.getByRole('textbox').last().fill(process.env.VIS_DESKTOP_QA_SERVER);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.settings-button').click({ timeout: 60000 });
    await page.getByRole('button', { name: 'Desktop', exact: true }).click();
    await page.getByTestId('desktop-update-bridge').waitFor();
    await page.locator('dialog[open] .modal-close-button svg path').first().waitFor({ state: 'visible' });
    await page.locator('dialog[open] .modal-back-button svg path').first().waitFor({ state: 'visible' });
    const sound = page.getByTestId('desktop-toggle-notificationSound').locator('.toggle-switch');
    await sound.click();
    assert.equal((await page.evaluate(() => window.electronAPI.desktop.getState())).preferences.notificationSound, true);
    const alignment = await page.getByTestId('desktop-toggle-notificationSound').evaluate((row) => {
      const info = row.querySelector('.setting-info').getBoundingClientRect();
      const toggle = row.querySelector('.toggle-track').getBoundingClientRect();
      return { rightAligned: toggle.x >= info.right, verticallyAligned: toggle.y >= info.y && toggle.bottom <= info.bottom + 10 };
    });
    assert.ok(alignment.rightAligned && alignment.verticallyAligned);
    await page.locator('dialog[open] .modal-body').evaluate((body) => { body.scrollTop = 0; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, 'settings-en.png') });
    const checked = await page.evaluate(() => window.electronAPI.desktop.check('bridge'));
    observations.push({ liveBridgeCheck: checked.updates.bridge });
    if (process.env.VIS_DESKTOP_QA_DOWNLOAD === '1') {
      assert.equal(checked.updates.bridge.phase, 'available');
      const downloaded = await page.evaluate(() => window.electronAPI.desktop.download('bridge'));
      assert.equal(downloaded.updates.bridge.phase, 'downloaded');
      observations.push({ verifiedBridgeDownload: downloaded.updates.bridge });
    }
    await page.screenshot({ path: path.join(output, 'settings-updates.png') });
    await page.locator('.modal-back-button').click();
    await page.locator('.language-select').selectOption('zh-CN');
    await page.getByRole('button', { name: '桌面', exact: true }).click();
    for (const width of [1280, 900]) {
      await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 800), width);
      await page.locator('dialog[open] .modal-body').evaluate((body) => { body.scrollTop = 0; });
      await page.screenshot({ path: path.join(output, `settings-zh-${width}-top.png`) });
      await page.getByTestId('desktop-toggle-notificationSound').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `settings-zh-${width}-bottom.png`) });
    }
  }

  if (configured.trayAvailable) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await page.waitForFunction(() => document.visibilityState === 'hidden');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await application.evaluate(({ app }) => app.emit('activate'));
    await page.waitForFunction(() => document.visibilityState === 'visible');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await application.evaluate(({ app }) => app.emit('second-instance'));
    await page.waitForFunction(() => document.visibilityState === 'visible');
    observations.push({ tray: 'minimize/hide, activate/restore, close/hide, second-instance/restore passed' });
  } else {
    observations.push({ tray: 'unavailable on this desktop; hiding intentionally disabled' });
  }

  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await closeApp(application);
  application = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], chromiumSandbox: true, timeout: 90000 });
  const restoredPage = await application.firstWindow();
  const restored = await restoredPage.evaluate(() => window.electronAPI.desktop.getState());
  assert.equal(restored.preferences.closeToTray, true);
  observations.push({ persistence: 'closeToTray survived real process restart' });
  writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ pass: true, observations }, null, 2));
  console.log(JSON.stringify({ pass: true, observations }, null, 2));
} catch (error) {
  console.error(processErrors);
  if (application) console.error(await application.evaluate(({ app, BrowserWindow }) => ({
    ready: app.isReady(), windows: BrowserWindow.getAllWindows().length, appPath: app.getAppPath(),
  })).catch(() => ({ mainProcess: 'unavailable' })));
  throw error;
} finally {
  await closeApp(application);
  rmSync(profile, { recursive: true, force: true });
}
