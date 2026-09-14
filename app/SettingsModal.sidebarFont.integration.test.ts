import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { mountHistoryApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
  document.documentElement.style.removeProperty('--sidebar-font-size');
});

describe('SettingsModal sidebar font integration', () => {
  it('publishes min, default, and max control values through the mounted App', async () => {
    const fixture = await mountHistoryApp([]);
    mountedApps.push(fixture);
    const appRoot = fixture.host.querySelector<HTMLElement>('.app');
    expect(appRoot).not.toBeNull();

    fixture.host.querySelector<HTMLButtonElement>('.settings-button')?.click();
    await nextTick();
    const fonts = Array.from(fixture.host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.getAttribute('aria-label') === 'Font settings',
    );
    expect(fonts).toBeDefined();
    fonts!.click();
    await nextTick();

    const input = fixture.host.querySelector<HTMLInputElement>('#settings-sidebar-font-size');
    expect(input?.labels?.item(0)?.textContent?.trim()).toBe('Sidebar font size');
    for (const size of [10, 12, 20]) {
      input!.value = String(size);
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();

      expect(appRoot!.style.getPropertyValue('--sidebar-font-size')).toBe(`${size}px`);
      expect(document.documentElement.style.getPropertyValue('--sidebar-font-size')).toBe(
        `${size}px`,
      );
    }
  });
});
