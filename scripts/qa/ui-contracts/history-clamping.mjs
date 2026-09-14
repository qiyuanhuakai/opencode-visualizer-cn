import assert from 'node:assert/strict';

export const historyClampingScenario = {
  name: 'history-clamping',
  viewport: { width: 768, height: 760 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'history');
    const host = page.locator('#history-scroll-host');
    const keys = async () =>
      host
        .locator('.history-item')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-history-key')),
        );
    let visible = await keys();
    assert.equal(visible.length, 100);
    assert.equal(visible.at(0), 'history-40');
    await host.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await page.evaluate(async () => window.__uiContracts?.appendHistory?.(1));
    visible = await keys();
    assert.match(visible.at(-1) ?? '', /^appended-140-/);
    await host.evaluate((element) => {
      element.scrollTop = Math.max(140, element.scrollHeight / 2);
      element.dispatchEvent(new Event('scroll'));
    });
    const pausedBefore = await keys();
    await page.evaluate(async () => window.__uiContracts?.appendHistory?.(1));
    const pausedAfter = await keys();
    assert.deepEqual(pausedAfter, pausedBefore);
    await host.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await page.evaluate(async () => window.__uiContracts?.shrinkHistory?.(36));
    const shrink = await host.evaluate((element) => ({
      scrollTop: element.scrollTop,
      maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
      first: element.querySelector('.history-item')?.getAttribute('data-history-key'),
      count: element.querySelectorAll('.history-item').length,
    }));
    assert.equal(shrink.first, 'shrunk-0');
    assert.equal(shrink.count, 36);
    assert.ok(shrink.scrollTop <= shrink.maxScrollTop + 2, JSON.stringify(shrink));
    await screenshot(page, evidenceDir, 'history-clamping.png');
    await saveResult(evidenceDir, { scenario: 'history-clamping', initialCount: 100, shrink });
  },
};
