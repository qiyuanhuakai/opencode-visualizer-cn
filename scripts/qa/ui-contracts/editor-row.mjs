import assert from 'node:assert/strict';

export const editorRowScenario = {
  name: 'editor-row',
  viewport: { width: 900, height: 900 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'editor');
    const dialog = page.getByRole('dialog', { name: 'Editor settings' });
    await dialog.waitFor();
    const row = page.locator('.setting-row').filter({ hasText: 'Local application' });
    assert.equal(await row.count(), 1);
    await row.scrollIntoViewIfNeeded();
    const pathInput = row.getByRole('textbox');
    assert.equal(await pathInput.getAttribute('readonly'), '');
    assert.equal(await pathInput.inputValue(), '/opt/编辑器/bin/code-with-a-long-name');
    assert.equal(await row.getByRole('button', { name: 'Browse' }).count(), 1);
    assert.equal(await row.getByRole('button', { name: 'Clear' }).count(), 1);
    const metrics = await row.evaluate((element) => {
      const info = element.querySelector('.setting-info')?.getBoundingClientRect();
      const controls = element
        .querySelector('.local-application-controls')
        ?.getBoundingClientRect();
      const input = element.querySelector('input')?.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return {
        infoBottom: info?.bottom ?? 0,
        controlsTop: controls?.top ?? 0,
        inputWidth: input?.width ?? 0,
        left: rect.left,
        right: rect.right,
        viewport: innerWidth,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    assert.ok(metrics.controlsTop >= metrics.infoBottom - 2, JSON.stringify(metrics));
    assert.ok(metrics.inputWidth >= 100, JSON.stringify(metrics));
    assert.ok(metrics.left >= -2 && metrics.right <= metrics.viewport + 2, JSON.stringify(metrics));
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, JSON.stringify(metrics));
    await screenshot(page, evidenceDir, 'editor-row.png');
    await saveResult(evidenceDir, { scenario: 'editor-row', metrics });
  },
};
