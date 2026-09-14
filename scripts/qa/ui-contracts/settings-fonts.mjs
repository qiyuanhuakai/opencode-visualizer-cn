import assert from 'node:assert/strict';

async function verifySettingsFonts(
  { page, baseUrl, evidenceDir, openFixture, saveResult, screenshot },
  width,
) {
  await openFixture(page, baseUrl, 'settings-fonts');
  const dialog = page.getByRole('dialog', { name: 'Font settings' });
  await dialog.waitFor();
  assert.equal(await page.getByLabel('Terminal font size').count(), 1);
  assert.equal(await page.getByLabel('Sidebar font size').count(), 1);
  assert.equal(await page.getByLabel('Custom font stack').count(), 2);
  assert.equal(await page.getByRole('group', { name: 'Presets' }).count(), 2);
  const metrics = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const sidebar = element.querySelector('#settings-sidebar-font-size');
    const terminal = element.querySelector('#settings-terminal-font-input');
    if (!(sidebar instanceof HTMLInputElement) || !(terminal instanceof HTMLTextAreaElement)) {
      throw new Error('font controls missing from accessible settings dialog');
    }
    return {
      width: rect.width,
      left: rect.left,
      right: rect.right,
      viewport: innerWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      sidebarLabel: sidebar.labels?.item(0)?.textContent?.trim() ?? '',
      terminalDescription: terminal.getAttribute('aria-describedby'),
      presetGroups: element.querySelectorAll('[role="group"][aria-labelledby]').length,
    };
  });
  assert.ok(metrics.left >= -2 && metrics.right <= metrics.viewport + 2, JSON.stringify(metrics));
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, JSON.stringify(metrics));
  assert.equal(metrics.sidebarLabel, 'Sidebar font size');
  assert.ok(metrics.terminalDescription);
  assert.equal(metrics.presetGroups, 2);
  await screenshot(page, evidenceDir, `settings-fonts-${width}.png`);
  await saveResult(evidenceDir, { scenario: 'settings-fonts', width, metrics });
}

export const settingsFontScenarios = [320, 768, 1440].map((width) => ({
  name: `settings-fonts-${width}`,
  viewport: { width, height: 900 },
  execute: (context) => verifySettingsFonts(context, width),
}));
