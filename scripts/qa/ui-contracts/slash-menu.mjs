import assert from 'node:assert/strict';

export const slashMenuScenario = {
  name: 'slash-menu',
  viewport: { width: 320, height: 720 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'slash');
    const input = page.getByRole('combobox');
    await input.fill('/');
    const list = page.locator('.mention-popup .dropdown-list');
    await list.waitFor();
    const metrics = await list.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollbarGutter: getComputedStyle(element).scrollbarGutter,
      viewportHeight: innerHeight,
    }));
    assert.ok(
      metrics.top >= -2 && metrics.bottom <= metrics.viewportHeight + 2,
      JSON.stringify(metrics),
    );
    assert.ok(metrics.height <= 322, JSON.stringify(metrics));
    assert.ok(metrics.scrollHeight > metrics.clientHeight, JSON.stringify(metrics));
    assert.equal(metrics.overflowY, 'auto');
    assert.match(metrics.scrollbarGutter, /stable/);
    await screenshot(page, evidenceDir, 'slash-menu.png');
    await saveResult(evidenceDir, { scenario: 'slash-menu', metrics });
  },
};
