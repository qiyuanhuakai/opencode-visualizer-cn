import assert from 'node:assert/strict';

async function verifyProviderLayout(
  { page, baseUrl, evidenceDir, openFixture, saveResult, screenshot },
  width,
) {
  await openFixture(page, baseUrl, 'provider');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Provider management' }).count(), 1);
  const metrics = await page
    .locator('.provider-list-row')
    .filter({ hasText: '国际化 Provider' })
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const main = element.querySelector('.provider-list-row-main')?.getBoundingClientRect();
      const actions = element.querySelector('.provider-list-row-actions')?.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        mainRight: main?.right ?? 0,
        mainBottom: main?.bottom ?? 0,
        actionsLeft: actions?.left ?? 0,
        actionsTop: actions?.top ?? 0,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        text: element.textContent?.trim() ?? '',
      };
    });
  if (width === 320) {
    assert.ok(metrics.mainBottom <= metrics.actionsTop + 2, JSON.stringify(metrics));
  } else {
    assert.ok(metrics.mainRight <= metrics.actionsLeft + 2, JSON.stringify(metrics));
    assert.ok(metrics.height <= 180, JSON.stringify(metrics));
  }
  assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, JSON.stringify(metrics));
  assert.match(metrics.text, /国际化 Provider/);
  await screenshot(page, evidenceDir, `provider-${width}.png`);
  await saveResult(evidenceDir, { scenario: `provider-${width}`, metrics });
}

export const providerScenarios = [320, 900].map((width) => ({
  name: `provider-${width}`,
  viewport: { width, height: width === 320 ? 800 : 900 },
  execute: (context) => verifyProviderLayout(context, width),
}));
