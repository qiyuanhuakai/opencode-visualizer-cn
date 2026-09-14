import assert from 'node:assert/strict';

export const treeSidebarCjkScenario = {
  name: 'tree-sidebar-cjk',
  viewport: { width: 320, height: 760 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'tree');
    const resultsBySize = [];
    for (const size of [10, 12, 20]) {
      await page.evaluate(async (value) => window.__uiContracts?.setSidebarFontSize?.(value), size);
      const metrics = await page.locator('#sidebar-contract').evaluate((element) => {
        const name = element.querySelector('.tree-name');
        const row = element.querySelector('.tree-row');
        const icon = element.querySelector('.tree-icon');
        const branch = element.querySelector('.tree-branch-name');
        const search = element.querySelector('.tree-file-search');
        if (
          !(name instanceof HTMLElement) ||
          !(row instanceof HTMLElement) ||
          !(icon instanceof HTMLElement) ||
          !(branch instanceof HTMLElement) ||
          !(search instanceof HTMLElement)
        ) {
          throw new Error('real tree layout elements missing');
        }
        return {
          fontSize: Number.parseFloat(getComputedStyle(name).fontSize),
          rowHeight: row.getBoundingClientRect().height,
          iconWidth: icon.getBoundingClientRect().width,
          branchClientWidth: branch.clientWidth,
          branchScrollWidth: branch.scrollWidth,
          searchWidth: search.getBoundingClientRect().width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      assert.ok(Math.abs(metrics.fontSize - size) <= 0.1, JSON.stringify(metrics));
      assert.ok(Math.abs(metrics.rowHeight - 24) <= 2, JSON.stringify(metrics));
      assert.ok(
        Math.abs(metrics.iconWidth - Math.min(20, Math.max(18, size + 6))) <= 2,
        JSON.stringify(metrics),
      );
      assert.ok(metrics.searchWidth >= 94, JSON.stringify(metrics));
      assert.ok(metrics.branchScrollWidth > metrics.branchClientWidth, JSON.stringify(metrics));
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, JSON.stringify(metrics));
      resultsBySize.push({ size, ...metrics });
    }
    const snippet = await page.locator('#snippet-contract').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      descriptionTitle:
        element.querySelector('.snippet-completion-description')?.getAttribute('title') ?? '',
      descriptionHeight:
        element.querySelector('.snippet-completion-description')?.getBoundingClientRect().height ??
        0,
    }));
    assert.ok(snippet.scrollWidth <= snippet.clientWidth + 2, JSON.stringify(snippet));
    assert.ok(snippet.descriptionTitle.length > 240, JSON.stringify(snippet));
    assert.ok(
      snippet.descriptionHeight > 0 && snippet.descriptionHeight < 40,
      JSON.stringify(snippet),
    );
    await screenshot(page, evidenceDir, 'tree-sidebar-cjk.png');
    await saveResult(evidenceDir, { scenario: 'tree-sidebar-cjk', resultsBySize, snippet });
  },
};
