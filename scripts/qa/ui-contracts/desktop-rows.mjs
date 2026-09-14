import assert from 'node:assert/strict';

export const desktopRowsScenario = {
  name: 'desktop-rows',
  viewport: { width: 900, height: 900 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'desktop');
    const dialog = page.getByRole('dialog', { name: 'Desktop' });
    await dialog.waitFor();
    assert.equal(await page.getByRole('button', { name: /Download/i }).count(), 1);
    const metrics = await page
      .locator('.desktop-update-card')
      .first()
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const versions = element.querySelector('.desktop-update-versions')?.getBoundingClientRect();
        const actions = element.querySelector('.desktop-update-actions')?.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          versionsTop: versions?.top ?? 0,
          actionsTop: actions?.top ?? 0,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, JSON.stringify(metrics));
    assert.ok(metrics.actionsTop >= metrics.versionsTop - 2, JSON.stringify(metrics));
    await screenshot(page, evidenceDir, 'desktop-rows.png');
    await saveResult(evidenceDir, { scenario: 'desktop-rows', metrics });
  },
};
