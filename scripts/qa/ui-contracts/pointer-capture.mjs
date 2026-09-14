import assert from 'node:assert/strict';

export const pointerCaptureScenario = {
  name: 'pointer-capture',
  viewport: { width: 768, height: 700 },
  async execute({ page, baseUrl, evidenceDir, openFixture, saveResult, screenshot }) {
    await openFixture(page, baseUrl, 'pointer');
    const floating = page.locator('.floating-window');
    const titlebar = page.locator('.floating-window-titlebar');
    const start = await floating.boundingBox();
    assert.ok(start);
    const resizer = page.locator('.floating-window-resizer');
    const resizeBox = await resizer.boundingBox();
    assert.ok(resizeBox);
    const beforeResize = await floating.boundingBox();
    assert.ok(beforeResize);
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    const resizeCapture = await floating.evaluate((element) => {
      const pointerId = window.__uiContracts?.pointerId ?? -1;
      return {
        pointerId,
        captured: element.hasPointerCapture(pointerId),
        activeElement: document.activeElement?.className,
        entryWidth: window.__uiContracts?.floatingEntry?.width,
      };
    });
    assert.equal(resizeCapture.captured, true, JSON.stringify({ resizeBox, resizeCapture }));
    await page.mouse.move(resizeBox.x + 80, resizeBox.y + 60, { steps: 3 });
    await page.mouse.up();
    const resized = await floating.boundingBox();
    assert.ok(
      resized &&
        resized.width >= beforeResize.width + 50 &&
        resized.height >= beforeResize.height + 30,
      JSON.stringify({ beforeResize, resized }),
    );
    await screenshot(page, evidenceDir, 'pointer-resized.png');
    const title = await titlebar.boundingBox();
    assert.ok(title);
    await page.mouse.move(title.x + 40, title.y + 10);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => window.__uiContracts?.pointerCapture?.drag), true);
    await page.mouse.move(650, 500, { steps: 4 });
    await page.mouse.up();
    const dragged = await floating.boundingBox();
    assert.ok(
      dragged && Math.abs(dragged.x - resized.x) > 20,
      JSON.stringify({ resized, dragged }),
    );
    const titleAfterDrag = await titlebar.boundingBox();
    assert.ok(titleAfterDrag);
    await page.mouse.move(titleAfterDrag.x + 24, titleAfterDrag.y + 10);
    await page.mouse.down();
    await titlebar.dispatchEvent('pointercancel', {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });
    const cancelled = await floating.boundingBox();
    await page.mouse.move(20, 20, { steps: 2 });
    const afterCancelMove = await floating.boundingBox();
    await page.mouse.up();
    assert.ok(cancelled && afterCancelMove);
    assert.ok(
      Math.abs(cancelled.x - afterCancelMove.x) <= 2 &&
        Math.abs(cancelled.y - afterCancelMove.y) <= 2,
      JSON.stringify({ cancelled, afterCancelMove }),
    );
    await screenshot(page, evidenceDir, 'pointer-capture.png');
    await saveResult(evidenceDir, {
      scenario: 'pointer-capture',
      start,
      dragged,
      beforeResize,
      resized,
      cancelled,
      afterCancelMove,
    });
  },
};
