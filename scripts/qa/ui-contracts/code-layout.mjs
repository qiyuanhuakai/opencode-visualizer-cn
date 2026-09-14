import assert from 'node:assert/strict';

export const codeLayoutScenario = {
  name: 'code-layout',
  viewport: { width: 768, height: 1000 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'code');
    await page.locator('.cm-editor').waitFor();
    const layout = await page.evaluate(() => {
      const measure = (id) => {
        const host = document.querySelector(id);
        const content = host?.querySelector('.code-content');
        if (!(host instanceof HTMLElement) || !(content instanceof HTMLElement)) {
          throw new Error(`missing ${id}`);
        }
        return {
          hostWidth: host.clientWidth,
          clientWidth: content.clientWidth,
          scrollWidth: content.scrollWidth,
          height: content.getBoundingClientRect().height,
        };
      };
      const renderer = document.querySelector('#renderer-contract .viewer-body');
      if (!(renderer instanceof HTMLElement)) throw new Error('missing renderer viewport');
      return {
        wrapped: measure('#wrap-contract'),
        unwrapped: measure('#nowrap-contract'),
        renderer: {
          clientWidth: renderer.clientWidth,
          scrollWidth: renderer.scrollWidth,
          renderedRows: renderer.querySelectorAll('.virtual-row').length,
        },
        inheritedFont: Number.parseFloat(
          getComputedStyle(document.querySelector('#editor-contract .cm-content')).fontSize,
        ),
      };
    });
    assert.ok(layout.wrapped.scrollWidth <= layout.wrapped.clientWidth + 2, JSON.stringify(layout));
    assert.ok(layout.wrapped.height > layout.unwrapped.height + 20, JSON.stringify(layout));
    assert.ok(
      layout.unwrapped.scrollWidth > layout.unwrapped.clientWidth + 100,
      JSON.stringify(layout),
    );
    assert.ok(
      layout.renderer.scrollWidth > layout.renderer.clientWidth + 100,
      JSON.stringify(layout),
    );
    assert.ok(
      layout.renderer.renderedRows > 0 && layout.renderer.renderedRows < 600,
      JSON.stringify(layout),
    );
    assert.ok(Math.abs(layout.inheritedFont - 19) <= 0.1, JSON.stringify(layout));
    await page.evaluate(async () => window.__uiContracts?.setEditorFontSize?.(16));
    const explicitFont = await page
      .locator('#editor-contract .cm-content')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    assert.ok(Math.abs(explicitFont - 16) <= 0.1, String(explicitFont));
    await screenshot(page, evidenceDir, 'code-layout.png');
    await saveResult(evidenceDir, { scenario: 'code-layout', layout, explicitFont });
  },
};
